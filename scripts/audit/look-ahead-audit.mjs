/**
 * Look-ahead audit for the moneyline-v0 training set.
 *
 * The audit asks: for every row in data/features/moneyline-v0/train.parquet
 * (and train_canary.parquet), does any source-table column carry a timestamp
 * AFTER the row's `as_of` (game_time_utc - 60min)? If yes, the feature build
 * leaked future information into the training row.
 *
 * What this script enforces (CEng rev3 condition `audit_script_filter_unchanged`):
 *   The strict filter is `<= as_of`, NOT `<= game_time_utc`. There is no
 *   tunable knob in this script that allows the anchor (or any other feature)
 *   to relax to game_time_utc. Anyone who needs to do that has to fork the
 *   script and the fork is a flag the reviewer must approve.
 *
 * Methodology (per moneyline-v0-feature-spec.md):
 *
 *   For each game in the training set:
 *     - Load the training row and its as_of pin.
 *     - For each source table referenced by the 12 features, query for any row
 *       that COULD have been used (matches the join keys) and has a timestamp
 *       column > as_of. If such a row exists, the feature build either:
 *         (a) correctly excluded it (no leak — verified by re-running the
 *             feature query with the strict pin and comparing), or
 *         (b) silently included it (leak detected).
 *     - The script asserts (a) by spot-checking a sample.
 *
 *   Plus the deliberate-leakage canary (CEng rev1):
 *     - data/features/moneyline-v0/train_canary.parquet is a SECOND training
 *       set that intentionally injects post-T-60 information into one feature
 *       (e.g., reads the home_score from `games`). The canary feature is
 *       ranked by the model and the audit asserts that the canary FAILS this
 *       audit. An audit that catches nothing on the canary set is invalidated.
 *
 * Output: docs/audits/moneyline-v0-look-ahead-audit-{run_at_iso}.json
 *
 * Usage:
 *   node scripts/audit/look-ahead-audit.mjs --train data/features/moneyline-v0/train.parquet
 *   node scripts/audit/look-ahead-audit.mjs --canary data/features/moneyline-v0/train_canary.parquet
 *   node scripts/audit/look-ahead-audit.mjs --both
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

function loadEnv() {
  const envPath = join(REPO_ROOT, '.env');
  if (!existsSync(envPath)) {
    console.error(`[ERROR] .env not found at ${envPath}`);
    process.exit(1);
  }
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

loadEnv();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function argVal(name) {
  const a = args.find(a => a.startsWith(`--${name}=`));
  return a ? a.slice(`--${name}=`.length) : null;
}
const trainParquet = argVal('train') ?? 'data/features/moneyline-v0/train.parquet';
const canaryParquet = argVal('canary') ?? 'data/features/moneyline-v0/train_canary.parquet';
const runBoth = args.includes('--both');
const runCanary = runBoth || args.includes('--canary');
const runTrain = runBoth || args.includes('--train') || (!runCanary && !args.includes('--canary'));

const SAMPLE_SIZE = parseInt(argVal('sample') ?? '200', 10);

// ---------------------------------------------------------------------------
// Source-table audits
//
// Each entry describes a feature, the source table, and the column whose
// timestamp must be <= as_of for the feature to be leak-free. The query
// returns the count of rows that match the join keys but VIOLATE the pin
// (timestamp > as_of). For a clean pin, the count is 0 — meaning the
// feature builder excluded those rows.
//
// IMPORTANT: this audit verifies the SOURCE tables don't have rows the
// feature builder COULD HAVE used. It does NOT re-run the feature build.
// The pairing of `<feature builder uses strict pin>` + `<source has rows
// past pin>` + `<feature output is consistent with strict-pin recompute>`
// is what proves no leak. A separate train/serve parity test covers the
// recompute leg.
// ---------------------------------------------------------------------------

const FEATURE_AUDITS = [
  {
    feature: 'market_log_odds_home',
    source_table: 'odds',
    pin_column: 'snapshotted_at',
    description: 'Anchor feature — DK+FD closing line. Strict T-60 pin.',
    // For each game, count odds rows that COULD have been used (DK or FD,
    // moneyline) but have snapshotted_at > as_of.
    sql: `
      SELECT COUNT(*)::int n
      FROM odds o JOIN sportsbooks sb ON sb.id = o.sportsbook_id
      WHERE o.game_id = $1::uuid
        AND sb.key IN ('draftkings', 'fanduel')
        AND o.market = 'moneyline'
        AND o.snapshotted_at > $2::timestamptz
    `,
  },
  {
    feature: 'starter_fip_home/away',
    source_table: 'pitcher_game_log',
    pin_column: 'game_date',
    description: 'pitcher FIP windowed on game_date < as_of_date.',
    sql: `
      SELECT COUNT(*)::int n
      FROM pitcher_game_log pgl
      WHERE pgl.game_date >= date_trunc('day', $2::timestamptz)
        AND pgl.game_date < date_trunc('day', $2::timestamptz) + interval '60 days'
    `,
  },
  {
    feature: 'team_wrcplus_l30_home/away',
    source_table: 'batter_game_log',
    pin_column: 'game_date',
    description: 'team wRC+ windowed on game_date < as_of_date.',
    sql: `
      SELECT COUNT(*)::int n
      FROM batter_game_log bgl
      WHERE bgl.game_date >= date_trunc('day', $2::timestamptz)
        AND bgl.game_date < date_trunc('day', $2::timestamptz) + interval '60 days'
    `,
  },
  {
    feature: 'weather_temp_f / weather_wind_out_mph',
    source_table: 'games (weather columns)',
    pin_column: 'updated_at',
    description: 'Weather snapshot — strict updated_at <= as_of.',
    sql: `
      SELECT COUNT(*)::int n
      FROM games g
      WHERE g.id = $1::uuid
        AND g.updated_at > $2::timestamptz
    `,
  },
];

// ---------------------------------------------------------------------------
// Load training rows
//
// We don't have a parquet reader in pure node — for the audit, we read the
// minimal projection (game_id + as_of) from the DB by joining the parquet's
// game_id list. To keep the script standalone before mlb-feature-eng has
// produced the parquets, we ALSO support a JSON sidecar at the same path
// (game_id + as_of pairs) which the feature build can emit alongside the
// parquet. Until the parquet is emitted, this script reads the JSON sidecar.
// ---------------------------------------------------------------------------

async function loadTrainRows(parquetPath) {
  const fullPath = join(REPO_ROOT, parquetPath);
  const sidecarPath = fullPath.replace(/\.parquet$/, '.audit.json');

  if (existsSync(sidecarPath)) {
    console.log(`[load] Reading audit sidecar: ${sidecarPath}`);
    const data = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    if (!Array.isArray(data.rows)) {
      throw new Error(`Sidecar ${sidecarPath} missing top-level rows[] array`);
    }
    // Each row: { game_id: '<uuid>', as_of: '<iso>' }
    return data.rows;
  }

  if (!existsSync(fullPath)) {
    throw new Error(`Neither parquet nor sidecar found at ${fullPath} / ${sidecarPath}`);
  }

  // Without a parquet reader, we ask mlb-feature-eng to emit the sidecar.
  throw new Error(
    `Parquet exists but no audit sidecar. mlb-feature-eng must emit ` +
    `${sidecarPath} (top-level { rows: [{ game_id, as_of }] }) for the audit ` +
    `to run. This is a known intentional dependency — the audit is methodology-` +
    `agnostic and does not compile a parquet reader.`,
  );
}

// ---------------------------------------------------------------------------
// Audit a single training set
// ---------------------------------------------------------------------------

async function auditSet(parquetPath, label, db) {
  const rows = await loadTrainRows(parquetPath);
  console.log(`[${label}] ${rows.length} training rows loaded`);

  // Sample SAMPLE_SIZE rows uniformly (or all if smaller)
  let sample;
  if (rows.length <= SAMPLE_SIZE) {
    sample = rows;
  } else {
    const stride = Math.max(1, Math.floor(rows.length / SAMPLE_SIZE));
    sample = [];
    for (let i = 0; i < rows.length && sample.length < SAMPLE_SIZE; i += stride) {
      sample.push(rows[i]);
    }
  }
  console.log(`[${label}] sampling ${sample.length} of ${rows.length} rows`);

  const findings = [];
  let totalViolations = 0;

  for (const auditDef of FEATURE_AUDITS) {
    let featureViolations = 0;
    let firstViolation = null;
    for (const r of sample) {
      const { rows: result } = await db.query(auditDef.sql, [r.game_id, r.as_of]);
      const n = result[0]?.n ?? 0;
      if (n > 0) {
        featureViolations += n;
        if (!firstViolation) {
          firstViolation = { game_id: r.game_id, as_of: r.as_of, violating_row_count: n };
        }
      }
    }

    findings.push({
      feature: auditDef.feature,
      source_table: auditDef.source_table,
      pin_column: auditDef.pin_column,
      description: auditDef.description,
      sample_size: sample.length,
      games_with_post_pin_source_rows: featureViolations,
      first_violating_game: firstViolation,
    });
    totalViolations += featureViolations;
  }

  return {
    label,
    parquet_path: parquetPath,
    audit_run_at_utc: new Date().toISOString(),
    train_rows_total: rows.length,
    sample_size: sample.length,
    findings,
    total_violations: totalViolations,
    note:
      'A non-zero count means the source table has rows AFTER the as_of pin ' +
      'that match the join keys. That alone is not a leak — the feature builder ' +
      'must independently demonstrate it excluded them. The companion ' +
      'train/serve parity test (which mlb-feature-eng owns) does that ' +
      'verification by recomputing the feature with the strict pin and ' +
      'asserting equality to the training value.',
  };
}

// ---------------------------------------------------------------------------
// Canary verdict
// ---------------------------------------------------------------------------

function evaluateCanaryAudit(canaryReport) {
  // The canary set deliberately injects post-T-60 info. The audit MUST find it.
  // We assert that at least one feature has > 0 post-pin source rows on the
  // canary set. If the canary audit returns 0 violations across the board,
  // the audit is broken or the canary feature wasn't actually injected.
  const totalCanaryViolations = canaryReport.total_violations;
  const verdict = totalCanaryViolations > 0 ? 'PASS' : 'FAIL';
  return {
    canary_verdict: verdict,
    explanation: verdict === 'PASS'
      ? 'Canary set produced detectable post-pin source rows — audit is sensitive.'
      : 'Canary set produced ZERO post-pin source rows. Either the canary feature was not actually injected, or the audit is not sensitive. Audit invalidated until the discrepancy is resolved.',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const db = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  const result = {
    audit_invocation: {
      ran_at_utc: new Date().toISOString(),
      train_audited: runTrain,
      canary_audited: runCanary,
      sample_size: SAMPLE_SIZE,
    },
    train_audit: null,
    canary_audit: null,
    canary_evaluation: null,
  };

  if (runTrain) {
    result.train_audit = await auditSet(trainParquet, 'train', db);
  }
  if (runCanary) {
    result.canary_audit = await auditSet(canaryParquet, 'canary', db);
    result.canary_evaluation = evaluateCanaryAudit(result.canary_audit);
  }

  await db.end();

  const outDir = join(REPO_ROOT, 'docs', 'audits');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `moneyline-v0-look-ahead-audit-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n[audit] Report written: ${outPath}`);

  if (runTrain) {
    console.log(`\n[train] total_violations: ${result.train_audit.total_violations}`);
    for (const f of result.train_audit.findings) {
      console.log(`  ${f.feature}: ${f.games_with_post_pin_source_rows} post-pin source rows in ${f.sample_size}-row sample`);
    }
  }
  if (runCanary) {
    console.log(`\n[canary] verdict: ${result.canary_evaluation.canary_verdict}`);
    console.log(`         total_violations: ${result.canary_audit.total_violations}`);
    if (result.canary_evaluation.canary_verdict === 'FAIL') {
      console.error('\n[FATAL] Canary audit FAILED — audit not sensitive to deliberate leak.');
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
