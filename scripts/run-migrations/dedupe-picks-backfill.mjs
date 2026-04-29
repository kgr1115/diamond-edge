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

// Pull every (game_id, market, pick_side, pick_date) group with > 1 row, plus per-row metadata
// needed to score the keeper. LEFT JOIN to pick_outcomes (FK without CASCADE → blocks delete)
// and bankroll_entries (FK without CASCADE → blocks delete; this is the actual user-journal
// surface — there is no `pick_journal` table; user notes live in picks.user_note / user_tags).
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
    (po.pick_id IS NOT NULL) AS has_outcome,
    (be.pick_id IS NOT NULL) AS has_bankroll_entry,
    (p.user_note IS NOT NULL OR COALESCE(array_length(p.user_tags, 1), 0) > 0) AS has_user_note_or_tags
  FROM picks p
  JOIN dup_keys d USING (game_id, market, pick_side, pick_date)
  LEFT JOIN LATERAL (
    SELECT 1 AS pick_id FROM pick_outcomes WHERE pick_id = p.id LIMIT 1
  ) po ON TRUE
  LEFT JOIN LATERAL (
    SELECT 1 AS pick_id FROM bankroll_entries WHERE pick_id = p.id LIMIT 1
  ) be ON TRUE
  ORDER BY p.game_id, p.market, p.pick_side, p.pick_date, p.generated_at DESC NULLS LAST, p.id;
`);

const groups = new Map();
for (const r of groupsQ.rows) {
  const key = `${r.game_id}${r.market}${r.pick_side}${r.pick_date}`;
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
  plan.push({ key, rows, keeper, reason, victims });
}

const totalDelete = plan.reduce((s, g) => s + g.victims.length, 0);
const totalKeep = plan.length;

console.log('\n--- Summary ---');
console.log(`dup_groups            : ${plan.length}`);
console.log(`rows_planned_to_delete: ${totalDelete}`);
console.log(`rows_kept             : ${totalKeep}`);
console.log(`groups_keeper_forced_by_fk (graded|bankroll_entry): ${forcedByFk}`);

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
  });
}

if (!APPLY) {
  console.log('\nDRY-RUN — no writes. Re-run with --apply to delete.');
  await client.end();
  process.exit(0);
}

console.log('\n--- APPLY: deleting victim rows (per-group transaction) ---');
let groupsApplied = 0;
let groupsSkippedFk = 0;
let rowsDeleted = 0;

for (const g of plan) {
  if (g.victims.length === 0) continue;
  const victimIds = g.victims.map((v) => v.id);
  try {
    await client.query('BEGIN');
    const del = await client.query('DELETE FROM picks WHERE id = ANY($1::uuid[])', [victimIds]);
    await client.query('COMMIT');
    groupsApplied += 1;
    rowsDeleted += del.rowCount ?? 0;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackErr) {
      // intentional swallow — rollback can fail if connection broken; proceed to next group
    }
    groupsSkippedFk += 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  skipped group ${g.key} (FK or other): ${msg}`);
  }
}

console.log('\n--- Final tally ---');
console.log(`groups_planned     : ${plan.length}`);
console.log(`groups_applied     : ${groupsApplied}`);
console.log(`groups_skipped_fk  : ${groupsSkippedFk}`);
console.log(`rows_deleted       : ${rowsDeleted}`);

const remaining = await client.query(`
  SELECT COUNT(*)::int AS n FROM (
    SELECT 1 FROM picks
    GROUP BY game_id, market, pick_side, pick_date
    HAVING COUNT(*) > 1
  ) s;
`);
console.log(`remaining_dup_groups: ${remaining.rows[0].n} (0 expected; non-zero == FK-blocked)`);

await client.end();
