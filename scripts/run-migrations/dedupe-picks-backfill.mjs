import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const e = l.indexOf('=');
      return [l.slice(0, e).trim(), l.slice(e + 1).trim()];
    }),
);

const APPLY = process.argv.includes('--apply');

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log(`=== dedupe-picks-backfill (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);

// Pull every (game_id, market, pick_side, pick_date) group with > 1 row, plus per-row metadata.
//
// Child-row FK behavior (load-bearing for cleanup ordering):
//   pick_outcomes.pick_id    - FK, NO CASCADE  -> must DELETE victim outcome rows first
//   bankroll_entries.pick_id - FK, NO CASCADE  -> must RE-POINT to keeper (user data)
//   pick_clv.pick_id         - FK, ON DELETE CASCADE -> no manual handling needed
//
// We aggregate bankroll user_ids per row so dry-run can pre-detect user conflicts
// (same user has bankroll entries on both keeper and a victim) before we mutate anything.
const groupsQ = await client.query(`
  WITH dup_keys AS (
    SELECT game_id, market, pick_side, pick_date
    FROM picks
    GROUP BY game_id, market, pick_side, pick_date
    HAVING COUNT(*) > 1
  )
  SELECT
    p.id,
    p.game_id,
    p.market,
    p.pick_side,
    p.pick_date,
    p.visibility,
    p.generated_at,
    (po.id IS NOT NULL) AS has_outcome,
    COALESCE(be.cnt, 0)::int AS bankroll_entry_count,
    COALESCE(be.user_ids, ARRAY[]::uuid[]) AS bankroll_user_ids,
    (p.user_note IS NOT NULL OR COALESCE(array_length(p.user_tags, 1), 0) > 0) AS has_user_note_or_tags
  FROM picks p
  JOIN dup_keys d USING (game_id, market, pick_side, pick_date)
  LEFT JOIN pick_outcomes po ON po.pick_id = p.id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS cnt, array_agg(user_id) AS user_ids
    FROM bankroll_entries WHERE pick_id = p.id
  ) be ON TRUE
  ORDER BY p.game_id, p.market, p.pick_side, p.pick_date, p.generated_at DESC NULLS LAST, p.id;
`);

const groups = new Map();
for (const r of groupsQ.rows) {
  r.has_bankroll_entry = (r.bankroll_entry_count ?? 0) > 0;
  const key = `${r.game_id}${r.market}${r.pick_side}${r.pick_date}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

function pickKeeper(rows) {
  // Priority: graded (pick_outcomes FK) > bankroll-entry FK > user note/tags > live > latest.
  // Within each band, latest generated_at wins.
  const cmp = (a, b) => {
    const aT = a.generated_at ? new Date(a.generated_at).getTime() : 0;
    const bT = b.generated_at ? new Date(b.generated_at).getTime() : 0;
    return bT - aT;
  };

  const graded = rows.filter((r) => r.has_outcome).sort(cmp);
  if (graded.length > 0) return { keeper: graded[0], reason: 'graded_fk' };

  const bankrolled = rows.filter((r) => r.has_bankroll_entry).sort(cmp);
  if (bankrolled.length > 0) return { keeper: bankrolled[0], reason: 'bankroll_entry_fk' };

  const noted = rows.filter((r) => r.has_user_note_or_tags).sort(cmp);
  if (noted.length > 0) return { keeper: noted[0], reason: 'user_note_or_tags' };

  const live = rows.filter((r) => r.visibility === 'live').sort(cmp);
  if (live.length > 0) return { keeper: live[0], reason: 'live_visibility' };

  const sorted = [...rows].sort(cmp);
  return { keeper: sorted[0], reason: 'latest_generated_at' };
}

const plan = [];
let forcedByFk = 0;
for (const [key, rows] of groups) {
  const { keeper, reason } = pickKeeper(rows);
  const victims = rows.filter((r) => r.id !== keeper.id);
  if (reason === 'graded_fk' || reason === 'bankroll_entry_fk') forcedByFk += 1;

  const victimOutcomeRows = victims.reduce((s, v) => s + (v.has_outcome ? 1 : 0), 0);
  const victimBankrollRows = victims.reduce((s, v) => s + (v.bankroll_entry_count ?? 0), 0);

  const keeperUsers = new Set((keeper.bankroll_user_ids ?? []).map(String));
  const userConflictUsers = [];
  for (const v of victims) {
    for (const u of (v.bankroll_user_ids ?? []).map(String)) {
      if (keeperUsers.has(u) && !userConflictUsers.includes(u)) {
        userConflictUsers.push(u);
      }
    }
  }
  const hasUserConflict = userConflictUsers.length > 0;

  plan.push({
    key,
    rows,
    keeper,
    reason,
    victims,
    victimOutcomeRows,
    victimBankrollRows,
    hasUserConflict,
    userConflictUsers,
  });
}

const totalDelete = plan.reduce((s, g) => s + g.victims.length, 0);
const totalKeep = plan.length;
const totalVictimOutcomeRows = plan.reduce((s, g) => s + g.victimOutcomeRows, 0);
const totalVictimBankrollRows = plan.reduce((s, g) => s + g.victimBankrollRows, 0);
const conflictGroups = plan.filter((g) => g.hasUserConflict);

console.log('\n--- Summary ---');
console.log(`dup_groups                            : ${plan.length}`);
console.log(`rows_planned_to_delete                : ${totalDelete}`);
console.log(`rows_kept                             : ${totalKeep}`);
console.log(`groups_keeper_forced_by_fk            : ${forcedByFk}`);
console.log(`victim_pick_outcomes_to_delete        : ${totalVictimOutcomeRows}`);
console.log(`victim_bankroll_entries_to_repoint    : ${totalVictimBankrollRows}`);
console.log(`groups_with_keeper_vs_victim_conflict : ${conflictGroups.length}`);

if (conflictGroups.length > 0) {
  console.log('\n--- User-conflict groups (will be SKIPPED on apply) ---');
  for (const g of conflictGroups.slice(0, 10)) {
    console.log({
      group_key: g.key,
      keeper_id: g.keeper.id,
      victim_ids: g.victims.map((v) => v.id),
      conflicting_user_ids: g.userConflictUsers,
    });
  }
}

console.log('\n--- Sample (first 5 groups) ---');
for (const g of plan.slice(0, 5)) {
  console.log({
    game_id: g.keeper.game_id,
    market: g.keeper.market,
    pick_side: g.keeper.pick_side,
    pick_date: g.keeper.pick_date,
    n_rows: g.rows.length,
    keeper_id: g.keeper.id,
    keeper_reason: g.reason,
    keeper_visibility: g.keeper.visibility,
    victim_ids: g.victims.map((v) => v.id),
    victim_outcome_rows: g.victimOutcomeRows,
    victim_bankroll_rows: g.victimBankrollRows,
    has_user_conflict: g.hasUserConflict,
  });
}

if (!APPLY) {
  console.log('\nDRY-RUN - no writes. Re-run with --apply to execute the plan.');
  await client.end();
  process.exit(0);
}

console.log('\n--- APPLY: cleaning child rows + deleting victims (per-group transaction) ---');
let groupsApplied = 0;
let groupsSkippedFk = 0;
let groupsSkippedUserConflict = 0;
let rowsDeleted = 0;
let outcomeRowsDeleted = 0;
let bankrollEntriesRepointed = 0;

for (const g of plan) {
  if (g.victims.length === 0) continue;

  if (g.hasUserConflict) {
    groupsSkippedUserConflict += 1;
    console.warn(
      `  skipped group ${g.key} (user-conflict): keeper=${g.keeper.id} ` +
        `users=${g.userConflictUsers.join(',')}`,
    );
    continue;
  }

  const victimIds = g.victims.map((v) => v.id);
  try {
    await client.query('BEGIN');

    const delOutcomes = await client.query(
      'DELETE FROM pick_outcomes WHERE pick_id = ANY($1::uuid[])',
      [victimIds],
    );

    let repoint = { rowCount: 0 };
    let repointConflict = false;
    if (g.victimBankrollRows > 0) {
      await client.query('SAVEPOINT bankroll_repoint');
      try {
        repoint = await client.query(
          'UPDATE bankroll_entries SET pick_id = $1 WHERE pick_id = ANY($2::uuid[])',
          [g.keeper.id, victimIds],
        );
        await client.query('RELEASE SAVEPOINT bankroll_repoint');
      } catch (innerErr) {
        await client.query('ROLLBACK TO SAVEPOINT bankroll_repoint');
        repointConflict = true;
        const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
        console.warn(`  bankroll re-point conflict on group ${g.key}: ${msg}`);
      }
    }

    if (repointConflict) {
      await client.query('ROLLBACK');
      groupsSkippedUserConflict += 1;
      continue;
    }

    const del = await client.query('DELETE FROM picks WHERE id = ANY($1::uuid[])', [victimIds]);

    await client.query('COMMIT');
    groupsApplied += 1;
    rowsDeleted += del.rowCount ?? 0;
    outcomeRowsDeleted += delOutcomes.rowCount ?? 0;
    bankrollEntriesRepointed += repoint.rowCount ?? 0;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackErr) {
      // intentional swallow - rollback can fail if connection broken
    }
    groupsSkippedFk += 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  skipped group ${g.key} (FK or other): ${msg}`);
  }
}

console.log('\n--- Final tally ---');
console.log(`groups_planned                : ${plan.length}`);
console.log(`groups_applied                : ${groupsApplied}`);
console.log(`groups_skipped_fk             : ${groupsSkippedFk}`);
console.log(`groups_skipped_user_conflict  : ${groupsSkippedUserConflict}`);
console.log(`rows_deleted                  : ${rowsDeleted}`);
console.log(`outcome_rows_deleted          : ${outcomeRowsDeleted}`);
console.log(`bankroll_entries_repointed    : ${bankrollEntriesRepointed}`);

const remaining = await client.query(`
  SELECT COUNT(*)::int AS n FROM (
    SELECT 1 FROM picks
    GROUP BY game_id, market, pick_side, pick_date
    HAVING COUNT(*) > 1
  ) s;
`);
console.log(`remaining_dup_groups          : ${remaining.rows[0].n} (0 expected; non-zero == FK or user-conflict-blocked)`);

await client.end();
