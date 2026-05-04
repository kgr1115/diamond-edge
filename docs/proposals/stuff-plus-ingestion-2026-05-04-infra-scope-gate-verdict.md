### Proposal: stuff-plus-ingestion-2026-05-04 (reshaped to kind: infra)

**Verdict:** APPROVED

**Rationale:** All eight locked criteria pass on the reshaped kind:infra proposal. The reshape removes the only two criteria that were contested under the original kind:feature-change shape — holdout consumption and retrain. What remains is a migration, a parser extension, a standalone compute module, a verification gate fixture, and a coverage audit, all on the existing Vercel/Supabase/Upstash/MLB-Stats-API stack at $0 recurring cost. CSO verdict (`docs/proposals/stuff-plus-ingestion-2026-05-04-verdict-cso.md`) and CEng verdict (`docs/proposals/stuff-plus-ingestion-2026-05-04-verdict-ceng.md`) converge on the same conclusion: the infra precursor ships now; the holdout question and retrain are deferred until a fresh holdout declaration exists. No locked invariant is activated by infra-only work.

**Scope annotations (on APPROVED):**

Binding lens verdicts for this scope gate:
- CSO `docs/proposals/stuff-plus-ingestion-2026-05-04-verdict-cso.md` — kind:infra ship with deferred retrain; retrain trigger conditions in that verdict are binding on any future kind:feature-change re-submission.
- CEng `docs/proposals/stuff-plus-ingestion-2026-05-04-verdict-ceng.md` — strict reading on holdout invalidator #6; fresh-holdout path required before any retrain; diff-must-be-swap-only condition binding on both this chain and the future retrain chain.

Specialist chain this cycle: `mlb-data-engineer` → `mlb-feature-eng` → STOP. `mlb-model`, `mlb-calibrator`, `mlb-backtester`, and `pick-tester` are NOT dispatched this cycle. Any attempt to fire them is a scope breach requiring re-circulation through scope-gate.

Allowed new files (5 total, strictly enumerated):

1. `supabase/migrations/00NN_pitcher_game_log_fb.sql` (next sequential number after the existing migrations — implementer to confirm; original verdict said 0029 but data-engineer's earlier work referenced 0029 already; pick the next free number) — `ALTER TABLE pitcher_game_log ADD COLUMN fb SMALLINT NOT NULL DEFAULT 0 CHECK (fb >= 0);` plus a `COMMENT ON COLUMN` stating: fb = flyouts per appearance, sourced from MLB Stats API boxscore `flyOuts` field, used for xFIP computation. No other DDL in this file.
2. `scripts/lib/xfip-formula.ts` — standalone TS compute module. Must export: the constants objects `LG_HR_PER_FB` (keyed by integer season year, values for 2022/2023/2024), `XFIP_CONST` (same keying), the scalar `LEAGUE_AVG_XFIP` fallback, and a pure function `computeXfip({ ip, fb, bb, hbp, k, seasonYear }: XfipInputs): number`. No API calls. No Supabase imports. The comment directly above the constants declaration must include both source URLs (FanGraphs leaders page URL + tangotiger.com URL) and the transcription date. A `// TODO: add 2025 constants before any 2025-data retrain` must appear immediately after the constants declaration.
3. `scripts/lib/xfip_formula.py` — Python mirror of `xfip-formula.ts`. Identical constants table, identical formula, identical fallback value. Comment above the constants must cite the same source URLs and transcription date as the TS file. This file is the training-side formula reference; it is NOT imported by `scripts/features/build-moneyline-v0.py` until the retrain chain fires. Any import of this module into `build-moneyline-v0.py` is out of scope this cycle.
4. `scripts/run-migrations/check-xfip-coverage.mjs` — read-only diagnostic. Reports percentage non-NULL `fb` per season across 2022-09-01 to 2024-12-31, broken out by season. No writes to any table.
5. `tests/fixtures/feature-parity/xfip-verification-2026-05-04.json` — verification gate output artifact written by mlb-feature-eng during the verification gate run. Must store per-pitcher: pitcher name, season year, computed xFIP (full-season from pitcher_game_log), MLB Stats API sabermetrics endpoint xfip value, delta (computed minus endpoint), PASS/FAIL per pitcher, and overall PASS/FAIL.

Allowed modification to one existing file:
- `scripts/backfill-db/07-pitcher-game-log.mjs` — add `fb: parseInt(pit.flyOuts ?? '0', 10) || 0` inside `parsePitcherStats()` (currently lines 48-61). Also add `fb` to the upsert `UPDATE SET` clause. No other lines change. If the MLB API boxscore does not expose a standalone `flyOuts` field and only exposes `airOuts`, add a comment documenting that `flyOuts` was absent and `airOuts - popOuts` was used as the substitution (with null-safety on `popOuts`). Confirm the field name during dev against a live boxscore response before committing.

Files that MUST NOT be modified this cycle:
- `apps/web/lib/features/moneyline-v0.ts` — CSO condition binding. The `fetchStarterXfip` function described in memo section 3 is NOT added to this file this cycle. The `team_wrcplus_l30_home/away` slot references in `buildMoneylineV0Row` remain as-is (zeroed at runtime, no structural change). Any edit to this file — including adding the xFIP serving function or swapping slot names — is a scope breach and requires re-circulation through scope-gate.
- `scripts/features/build-moneyline-v0.py` — CSO condition binding. The training script's feature construction does not change until the retrain chain fires. The Python xFIP formula lives in `scripts/lib/xfip_formula.py` as a standalone file, not as a modification to this script.
- `models/moneyline/current/` — no artifact in this directory is read, written, or deleted during this chain.
- `models/moneyline/holdout-declaration.json` — MUST NOT be consumed (no metrics computed against it, no rows from its holdout window used for any selection or evaluation). The implementer may read the `declaration_id` field for the integrity check at chain close, but that is a filesystem read, not a holdout consumption. Current `declaration_id` on disk: `moneyline-v0-holdout-2026-05-03`. If the file's content has changed from that value when mlb-feature-eng runs the end-of-chain check, stop immediately and surface to CEng.
- Any subscriber row, bet row, bankroll row, subscription row, or RLS policy.

xFIP formula constants (non-negotiable):
- Hand-transcribe `LG_HR_PER_FB` and `XFIP_CONST` for 2022, 2023, 2024 from FanGraphs leaders and cross-reference against tangotiger.com. Both source URLs and the transcription date appear in comments in both `xfip-formula.ts` and `xfip_formula.py`. This is a direct carryover of the wRC+ pause lesson: source-citation discipline is mandatory.
- 2025 constants: documented as a TODO. Add before any 2025-data retrain. Not a current-proposal blocker.

Verification gate — CEng's tightening is binding:
- Gate runs BEFORE mlb-feature-eng writes any serving or training files. Gate failure stops the chain at that point.
- Five spot-check pitchers: Corbin Burnes 2024, Zack Wheeler 2024, Tarik Skubal 2024, Jacob deGrom 2023, Justin Verlander 2022.
- For each: pull `xfip` from MLB Stats API (`/api/v1/people/{id}/stats?stats=sabermetrics&season={year}&group=pitching`). Compute xFIP using the full-season counting stats from `pitcher_game_log` + `computeXfip()` from the formula module.
- PASS: ALL 5 within ±0.20 xFIP units. No "4 of 5" exception. This is CEng's explicit tightening from the original memo's implicit 5-of-5.
- Flyball-leaning diversity requirement (CEng condition, binding): at least one of the 5 must be a pitcher with above-league-average flyball rate for that season. Zack Wheeler 2024 satisfies this requirement and is already on the list. If Wheeler is substituted for any reason, the replacement must also be flyball-leaning (FB% above the ~35-37% league-average range for that season). This requirement exists because the xFIP HR/FB term (`13 × FB × lgHRperFB`) is the component most exposed to constants-table bugs; a groundball-heavy spot-check set would mask an incorrect `LG_HR_PER_FB` value.
- If any spot-check misses by >0.40 xFIP units: chain stops; mlb-data-engineer debugs constants table and formula before any file is written.
- If exactly 1 of 5 misses by between 0.20 and 0.40: mlb-feature-eng writes a one-paragraph rationale in the fixture JSON explaining why the miss is a legitimate window-edge or rounding artifact. Chain may advance only with that written rationale.
- Results written to `tests/fixtures/feature-parity/xfip-verification-2026-05-04.json`.

Retrain trigger conditions (CSO conditions — recorded for audit trail, not actionable this cycle):
- (a) 2025 backfill lands AND a fresh holdout slice is pre-declared as `models/moneyline/holdout-declaration-stuffplus-2026-05-04.json` per CEng's `fresh_holdout_required_before_retrain` condition.
- (b) Live-pick evidence at the 200-pick re-check surfaces pitcher-quality residual as the binding constraint AND CSO + CEng agree the xFIP candidate has higher prior than alternatives.
- (c) Live pace falls below 3 picks/night for 2 weeks per the validation verdict's fallback authorization, in which case 2025 backfill triggers and the xFIP retrain rides on the fresh holdout.

When any trigger fires, the retrain chain starts as a new kind:feature-change proposal. CEng's B-1 path (hold out 2024-04-01 through 2024-07-15 from the existing training window; train on 2023-04-01 through 2024-03-31) is the default fresh-holdout path. B-2 (2025 season slice) is fallback only if B-1 yields fewer than 200 graded picks at the +3% EV floor.

Compliance surface: none touched. No 21+ gate, geo-block, or responsible-gambling disclaimer surface is affected.

**Testing requirements (on APPROVED):**

Migration (mlb-data-engineer):
- Apply migration to the Supabase local dev stack before touching production. Confirm no existing rows error on the ADD COLUMN. Confirm default value of 0 is applied to all existing rows.

Backfill correctness (mlb-data-engineer):
- Run the updated `07-pitcher-game-log.mjs` against a 10-game sample twice. Row count identical after both runs, no duplicate rows. Confirms idempotent upsert with the new `fb` field.
- Sample known flyball pitchers (e.g., Wheeler 2024 appearances) after backfill. Confirm `fb` > 0 on at least 80% of their game rows. A run of all-zero `fb` values on a flyball pitcher is a parser field-name bug.
- Confirm `ip`, `hr`, `bb`, `hbp`, `k`, `is_starter` are unchanged on 50 randomly sampled rows post-backfill. The parser extension must not disturb existing fields.

Coverage check (mlb-data-engineer, after full backfill):
- `check-xfip-coverage.mjs` must report ≥95% non-NULL `fb` per season for 2022, 2023, and 2024. Below 95% on any single season stops the chain.

Verification gate (mlb-feature-eng):
- As specified in scope annotations above. 5-of-5 within ±0.20; Wheeler 2024 or a flyball-leaning substitute included; full results written to fixture file.

Formula parity check (mlb-feature-eng):
- For at least one spot-check pitcher (Burnes 2024 is sufficient), compute xFIP using the full-season counting stats from `pitcher_game_log` via both the TS formula module and the Python formula module with identical numeric inputs. Outputs must agree to 4 decimal places. Any divergence indicates a constants-table or formula transcription mismatch between the two files; mlb-data-engineer fixes before chain closes.

Holdout integrity check (mlb-feature-eng, end of chain):
- Read `models/moneyline/holdout-declaration.json`. Confirm `declaration_id` is `moneyline-v0-holdout-2026-05-03`. Confirm the file's git commit hash matches the last commit before this infra chain started. If either check fails, stop immediately and escalate to CEng. This check satisfies CEng's binding condition that the pinned holdout was not consumed or modified during the infra chain.

Diff-is-infra-only check (implementer self-certifies; scope-gate records here):
- The final PR diff must touch ONLY the 5 new files + the 1 modification listed above. Any other file appearing in the diff requires the implementer to stop and re-circulate through scope-gate with the additional change explicitly named. No hyperparameter changes, no drop-predicate edits, no anchor-coef adjustments, no coefficient-file edits, no `vercel.json` additions, and no cron entries ride along (no new cron is introduced; existing nightly pitcher_game_log refresh already handles ongoing `fb` population once the parser extension is live).

**Revision guidance (on DENIED):** N/A — verdict is APPROVED.

---

**Auto-chain status:** Auto mode active. Scope-gate APPROVED fires `pick-implement` per CLAUDE.md. Implementer chain constrained to `mlb-data-engineer` → `mlb-feature-eng` → STOP per CSO + CEng. No pause-point conditions apply. Implementer enforces the STOP at mlb-feature-eng explicitly.
