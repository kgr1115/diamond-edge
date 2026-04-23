/**
 * Factuality and compliance eval harness for Diamond Edge AI rationale.
 *
 * Run against generated rationale text to catch hallucinations, missing
 * responsible-gambling copy, and tier-gating violations before publishing.
 *
 * Not a live-inference harness — evals run on RationaleOutput objects,
 * comparing them against the RationaleInput that produced them.
 */

import type { RationaleInput, RationaleOutput } from '@/lib/ai/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvalResult {
  passed: boolean;
  /** List of failure descriptions. Empty when passed === true. */
  failures: string[];
}

export interface EvalTestCase {
  name: string;
  input: RationaleInput;
  output: RationaleOutput;
  /** Whether this test case is expected to pass or fail the eval. */
  expectedResult: 'pass' | 'fail';
}

// ---------------------------------------------------------------------------
// Banned model-architecture keywords (never appear in published rationale)
// ---------------------------------------------------------------------------

const ARCHITECTURE_KEYWORDS = [
  'lightgbm',
  'gradient boost',
  'gradient-boost',
  'shap',
  'machine learning',
  'neural network',
  'neural net',
  'deep learning',
  'random forest',
  'xgboost',
  'scikit',
  'algorithm',
];

// ---------------------------------------------------------------------------
// Hedged language patterns — at least one must appear
// ---------------------------------------------------------------------------

const HEDGE_PATTERNS = [
  /\bsuggests\b/i,
  /\btilts\b/i,
  /\bfavors\b/i,
  /\bindicates\b/i,
  /\bthe model\b/i,
  /\bstatistical analysis\b/i,
  /\bedge toward\b/i,
  /\bpoints toward\b/i,
];

// ---------------------------------------------------------------------------
// Responsible gambling markers
// ---------------------------------------------------------------------------

const RG_MARKERS = [
  'bet responsibly',
  '1-800-522-4700',
  'does not guarantee',
];

// ---------------------------------------------------------------------------
// Main eval function
// ---------------------------------------------------------------------------

/**
 * Evaluate a rationale output for factuality, compliance, and tier correctness.
 *
 * Checks:
 * 1. No hallucinated stats — all numbers and proper nouns must appear in inputs.
 * 2. Responsible-gambling hedge sentence is present.
 * 3. No model-architecture keywords.
 * 4. Elite tier: model probability percentage is stated.
 * 5. Pro tier: EV value is NOT stated.
 * 6. At least one hedged-language phrase is present.
 */
export function evalRationale(input: RationaleInput, output: RationaleOutput): EvalResult {
  const failures: string[] = [];
  const text = output.rationale_text;
  const textLower = text.toLowerCase();

  // ---- Check 1: No hallucinated numbers or team/player names ---------------
  const hallucinations = findHallucinations(text, input);
  if (hallucinations.length > 0) {
    failures.push(
      `Hallucination detected — the following values appear in the rationale but not in ` +
      `the provided inputs: ${hallucinations.map((h) => `"${h}"`).join(', ')}`
    );
  }

  // ---- Check 2: Responsible-gambling hedge sentence -------------------------
  const hasRgMarker = RG_MARKERS.some((marker) => textLower.includes(marker.toLowerCase()));
  if (!hasRgMarker) {
    failures.push(
      `Missing responsible-gambling hedge. Rationale must contain one of: ` +
      `"Bet responsibly", "1-800-522-4700", or "does not guarantee".`
    );
  }

  // ---- Check 3: No model-architecture keywords -----------------------------
  const foundKeywords = ARCHITECTURE_KEYWORDS.filter((kw) => textLower.includes(kw));
  if (foundKeywords.length > 0) {
    failures.push(
      `Model architecture keywords found (must not appear in published rationale): ` +
      foundKeywords.map((k) => `"${k}"`).join(', ')
    );
  }

  // ---- Check 4: Elite tier must state model probability --------------------
  if (input.tier === 'elite') {
    const probPct = (input.pick.model_probability * 100).toFixed(0);
    // Look for the probability as a percentage (within 1% rounding tolerance)
    const probLow = Math.floor(input.pick.model_probability * 100);
    const probHigh = Math.ceil(input.pick.model_probability * 100);
    const hasProbability =
      text.includes(`${probLow}%`) ||
      text.includes(`${probHigh}%`) ||
      text.includes(`${probPct}%`);

    if (!hasProbability) {
      failures.push(
        `Elite tier rationale must state the model probability as a percentage ` +
        `(expected ~${probPct}%). Not found in rationale text.`
      );
    }
  }

  // ---- Check 5: Pro tier must NOT state the EV value -----------------------
  if (input.tier === 'pro') {
    const evPct = (input.pick.expected_value * 100).toFixed(1);
    // EV is a small percentage — check for patterns like "+4.2%", "4.2% edge", etc.
    const evPatterns = [
      `${evPct}%`,
      `${Math.floor(input.pick.expected_value * 100)}.${Math.round((input.pick.expected_value * 100 % 1) * 10)}%`,
      'expected value',
    ];
    const hasEv = evPatterns.some((p) => textLower.includes(p.toLowerCase()));
    if (hasEv) {
      failures.push(
        `Pro tier rationale must NOT include the expected value (EV). ` +
        `EV is an Elite-only field. Found EV-related content in rationale.`
      );
    }
  }

  // ---- Check 6: At least one hedged-language phrase present ----------------
  const hasHedge = HEDGE_PATTERNS.some((pattern) => pattern.test(text));
  if (!hasHedge) {
    failures.push(
      `No hedged language found. Rationale must include at least one of: ` +
      `"suggests," "tilts," "favors," "indicates," "the model," ` +
      `"statistical analysis," "edge toward," "points toward."`
    );
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Hallucination detection
// ---------------------------------------------------------------------------

/**
 * Find numeric values and proper nouns in the rationale that do NOT appear
 * in the provided inputs (feature attribution labels or game context).
 *
 * Strategy: extract all numeric values from the rationale text, then
 * verify each appears in an attribution label or game context field.
 * Also checks player names from the game context.
 */
function findHallucinations(rationaleText: string, input: RationaleInput): string[] {
  const hallucinations: string[] = [];

  // Build the corpus of allowed values from inputs
  const allowedCorpus = buildAllowedCorpus(input);

  // Extract numeric values from the rationale (e.g., "3.42", "58%", "7.2")
  const numerics = rationaleText.match(/\d+\.?\d*/g) ?? [];

  for (const num of numerics) {
    // Skip single-digit numbers (confidence tier, innings, etc.) — too common
    // to be hallucinations and hard to trace precisely.
    if (num.length <= 1) continue;
    // Skip year-like numbers (2024, 2025, 2026)
    if (/^202[0-9]$/.test(num)) continue;

    if (!allowedCorpus.numerics.has(num)) {
      hallucinations.push(num);
    }
  }

  // Check player names (only the ones we explicitly know about)
  const knownPlayers = [
    input.game_context.probable_home_pitcher?.full_name,
    input.game_context.probable_away_pitcher?.full_name,
  ].filter(Boolean) as string[];

  // Find proper-noun-looking words in the rationale (capitalized, 4+ chars)
  const properNouns = rationaleText.match(/\b[A-Z][a-z]{3,}\b/g) ?? [];

  for (const noun of properNouns) {
    // Skip common non-proper nouns that appear at sentence start
    const commonWords = new Set([
      'The', 'This', 'That', 'When', 'With', 'For', 'From', 'Past',
      'Model', 'Diamond', 'Edge', 'Based', 'Note', 'Pick', 'Bet',
      'Statistical', 'Analysis', 'Home', 'Away', 'Over', 'Under',
    ]);
    if (commonWords.has(noun)) continue;

    // Check if this noun appears in any allowed source
    const appearsInCorpus =
      allowedCorpus.properNouns.has(noun) ||
      knownPlayers.some((name) => name.includes(noun));

    if (!appearsInCorpus) {
      // Only flag if it looks genuinely like a name/stat we can't source
      // (heuristic: appears nowhere in attribution labels or game context)
      if (!allowedCorpus.fullText.includes(noun)) {
        hallucinations.push(noun);
      }
    }
  }

  return [...new Set(hallucinations)]; // deduplicate
}

interface AllowedCorpus {
  numerics: Set<string>;
  properNouns: Set<string>;
  fullText: string;
}

function buildAllowedCorpus(input: RationaleInput): AllowedCorpus {
  const parts: string[] = [];

  // Attribution labels (the primary source of citable facts)
  for (const attr of input.pick.feature_attributions) {
    parts.push(attr.label);
    parts.push(String(attr.feature_value));
  }

  // Game context
  const gc = input.game_context;
  parts.push(gc.home_team.name, gc.home_team.abbreviation, gc.home_team.record);
  parts.push(gc.away_team.name, gc.away_team.abbreviation, gc.away_team.record);
  parts.push(gc.game_time_local, gc.venue);
  if (gc.probable_home_pitcher) parts.push(gc.probable_home_pitcher.full_name);
  if (gc.probable_away_pitcher) parts.push(gc.probable_away_pitcher.full_name);
  if (gc.weather) {
    parts.push(
      String(gc.weather.temp_f),
      String(gc.weather.wind_mph),
      gc.weather.condition,
      gc.weather.wind_dir
    );
  }

  // Pick metadata
  parts.push(
    String(Math.floor(input.pick.model_probability * 100)),
    String(Math.ceil(input.pick.model_probability * 100)),
    String((input.pick.model_probability * 100).toFixed(1)),
    String(Math.floor(input.pick.expected_value * 100)),
    String((input.pick.expected_value * 100).toFixed(1)),
    String(input.pick.best_line.price),
    String(Math.abs(input.pick.best_line.price)),
    String(input.pick.confidence_tier),
  );

  const fullText = parts.join(' ');

  // Extract numerics from the full allowed corpus
  const numerics = new Set(fullText.match(/\d+\.?\d*/g) ?? []);

  // Extract proper nouns from the full allowed corpus
  const properNouns = new Set(fullText.match(/\b[A-Z][a-z]{3,}\b/g) ?? []);

  return { numerics, properNouns, fullText };
}

// ---------------------------------------------------------------------------
// Batch eval runner
// ---------------------------------------------------------------------------

/**
 * Run a batch of eval test cases and print a summary to stdout.
 * Returns the count of passed and failed cases.
 */
export function runEvalSuite(testCases: EvalTestCase[]): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;

  console.info('\n=== Diamond Edge Rationale Eval Suite ===\n');

  for (const tc of testCases) {
    const result = evalRationale(tc.input, tc.output);
    const expectPass = tc.expectedResult === 'pass';
    const matches = result.passed === expectPass;

    if (matches) {
      passed++;
      console.info(`PASS  ${tc.name}`);
      if (!result.passed && tc.expectedResult === 'fail') {
        console.info(`      (Expected failures: ${result.failures.join('; ')})`);
      }
    } else {
      failed++;
      const verdict = result.passed ? 'PASS' : 'FAIL';
      const expected = tc.expectedResult.toUpperCase();
      console.error(`FAIL  ${tc.name}`);
      console.error(`      Expected: ${expected} | Got: ${verdict}`);
      if (result.failures.length > 0) {
        for (const f of result.failures) {
          console.error(`      - ${f}`);
        }
      }
    }
  }

  console.info(`\nResults: ${passed}/${testCases.length} passed`);
  if (failed > 0) {
    console.error(`        ${failed} failed — review output above`);
  }

  return { passed, failed };
}
