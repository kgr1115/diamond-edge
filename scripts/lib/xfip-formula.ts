/**
 * xFIP formula module — TypeScript reference (serving-side)
 *
 * Pure compute. No API calls. No Supabase imports. Mirror of `scripts/lib/xfip_formula.py`.
 *
 * Formula:
 *   xFIP = ((13 * FB * lgHRperFB) + 3 * (BB + HBP) - 2 * K) / IP + xFIP_const
 *
 * IP convention: MLB Stats API encodes fractional innings as .1 = 1/3 and .2 = 2/3 (NOT decimal
 * thirds). The formula treats IP as a numeric value; callers MUST pre-convert if they need
 * decimal-third semantics. Within this codebase, pitcher_game_log.ip is stored as the MLB API
 * value (e.g., 6.1 means 6 and 1/3 IP), and existing FIP computation uses it directly. We follow
 * the same convention here for train/serve parity with starter_fip.
 *
 * Source citation (constants hand-transcribed from FanGraphs leaders + cross-referenced against
 * Tom Tango's blog):
 *   - FanGraphs guts: https://www.fangraphs.com/guts.aspx?type=cn (FIP/xFIP constants table)
 *   - FanGraphs pitching leaders (HR/FB): https://www.fangraphs.com/leaders/major-league?type=8&season=2024&season1=2024&stats=pit
 *   - Tom Tango cross-reference: http://www.tangotiger.com/index.php/site/comments/fip-and-xfip
 *   - Transcription date: 2026-05-04
 *
 * Scope this cycle: this module is the source-of-truth FORMULA for xFIP. It is NOT imported by
 * apps/web/lib/features/moneyline-v0.ts during the infra-only chain — the production v0 served
 * payload is unchanged. Future retrain chain (post fresh holdout declaration) will import.
 */

// LG_HR_PER_FB by season — league-average HR/FB rate (homers per flyball).
// Source: FanGraphs pitching leaders (HR/FB%, BIS-classified). Hand-transcribed 2026-05-04.
// 2026-05-05 audit (docs/research/xfip-constants-audit-2026-05-05.md) could NOT confirm
// to 4-decimal precision because FG leaderboard is Cloudflare-protected; Statcast-derived
// estimates differ by ~0.005–0.009 per year (consistent with the known BIS/Statcast gap).
// The transcribed values are directionally plausible but not 4-decimal-verified.
// TODO: hand-verify from a real browser session against FG pitching leaders HR/FB column.
export const LG_HR_PER_FB: Readonly<Record<number, number>> = {
  2022: 0.111,
  2023: 0.121,
  2024: 0.115,
} as const;

// XFIP_CONST by season — additive constant such that league-avg xFIP equals league-avg ERA.
// Source: FanGraphs guts (https://www.fangraphs.com/guts.aspx?type=cn), cFIP column.
// Per FG documentation, cFIP and the xFIP additive constant are the same value.
// Re-verified 2026-05-05 against FG primary source (audit memo:
// docs/research/xfip-constants-audit-2026-05-05.md). The 2026-05-04 transcription
// was off by 0.036–0.068 across all three years; corrected here.
export const XFIP_CONST: Readonly<Record<number, number>> = {
  2021: 3.170, // FG guts: 3.170 (added 2026-05-05; pgl has no 2021 rows yet)
  2022: 3.112, // FG guts: 3.112 (was 3.18 — error +0.068)
  2023: 3.255, // FG guts: 3.255 (was 3.20 — error −0.055)
  2024: 3.166, // FG guts: 3.166 (was 3.13 — error −0.036)
} as const;

// TODO: add 2025 constants before any 2025-data retrain.
// (Hand-transcribe from FanGraphs once 2025 EOS values are published; cross-reference tangotiger.com.)

/**
 * Fallback xFIP value when the per-pitcher window has insufficient IP (< 3 IP) or no rows.
 * Approximate league-average xFIP (~4.20). Same fallback semantics as starter_fip's
 * league-average fallback. Used by serving callers; not used inside computeXfip itself.
 */
export const LEAGUE_AVG_XFIP = 4.20;

export interface XfipInputs {
  /** Innings pitched in window (MLB convention: .1 = 1/3, .2 = 2/3). Must be > 0. */
  ip: number;
  /** Flyouts in window (excludes popouts). */
  fb: number;
  /** Walks in window. */
  bb: number;
  /** Hit-by-pitches in window. */
  hbp: number;
  /** Strikeouts in window. */
  k: number;
  /** Season year for constants lookup (e.g., 2024). Falls back to 2024 values if missing. */
  seasonYear: number;
}

/**
 * Compute xFIP from per-window counting stats.
 *
 * Returns LEAGUE_AVG_XFIP if ip <= 0 (caller responsibility to check; this is a safety net,
 * not a substitute for the IP-floor gate at the call site).
 *
 * Constants lookup falls back to 2024 values if seasonYear is not in LG_HR_PER_FB / XFIP_CONST.
 * This is intentional to avoid throwing during the year-boundary window before new constants
 * are transcribed; the TODO above tracks the requirement to add 2025 before any 2025 retrain.
 */
export function computeXfip({ ip, fb, bb, hbp, k, seasonYear }: XfipInputs): number {
  if (ip <= 0) return LEAGUE_AVG_XFIP;
  const lgHRperFB = LG_HR_PER_FB[seasonYear] ?? LG_HR_PER_FB[2024];
  const xfipConst = XFIP_CONST[seasonYear] ?? XFIP_CONST[2024];
  const numerator = 13 * fb * lgHRperFB + 3 * (bb + hbp) - 2 * k;
  return numerator / ip + xfipConst;
}
