/**
 * Canned eval test cases for the Diamond Edge rationale eval harness.
 *
 * These are fixture inputs with pre-written outputs — not live LLM calls.
 * Run with runEvalSuite() from rationale-eval.ts.
 *
 * Test coverage:
 *   (a) Clean Pro pick — should PASS all checks
 *   (b) Clean Elite pick — should PASS all checks
 *   (c) Hallucination injection — should FAIL the factuality check
 */

import type { EvalTestCase } from './rationale-eval';
import type { RationaleInput, RationaleOutput } from '@/lib/ai/types';

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------

const NYY_ATL_GAME_CONTEXT: RationaleInput['game_context'] = {
  home_team: { name: 'New York Yankees', abbreviation: 'NYY', record: '18-10' },
  away_team: { name: 'Atlanta Braves', abbreviation: 'ATL', record: '15-13' },
  game_time_local: '7:05 PM ET',
  venue: 'Yankee Stadium',
  probable_home_pitcher: { full_name: 'Gerrit Cole' },
  probable_away_pitcher: { full_name: 'Spencer Strider' },
  weather: {
    condition: 'Clear',
    temp_f: 68,
    wind_mph: 7,
    wind_dir: 'out to CF',
  },
};

const NYY_ATL_PICK_BASE: RationaleInput['pick'] = {
  game_id: 'test-game-001',
  market: 'moneyline',
  pick_side: 'home',
  model_probability: 0.587,
  implied_probability: 0.524,
  expected_value: 0.048,
  confidence_tier: 3,
  best_line: {
    price: -115,
    sportsbook_key: 'draftkings',
    snapshotted_at: '2026-04-22T12:00:00Z',
  },
  feature_attributions: [
    {
      feature_name: 'home_sp_era_last_30d',
      feature_value: 2.14,
      shap_value: 0.42,
      direction: 'positive',
      label: 'Home Starter ERA (30-day): 2.14',
    },
    {
      feature_name: 'away_bullpen_usage_2d',
      feature_value: 7.2,
      shap_value: 0.28,
      direction: 'positive',
      label: 'Away Bullpen Load (2-day IP): 7.2 innings — elevated fatigue',
    },
    {
      feature_name: 'park_run_factor',
      feature_value: 98,
      shap_value: -0.12,
      direction: 'negative',
      label: 'Park Run Factor: 98 (slight pitcher-friendly environment)',
    },
    {
      feature_name: 'weather_wind_factor',
      feature_value: 7,
      shap_value: 0.08,
      direction: 'positive',
      label: 'Wind: 7 mph blowing out to CF (mild offense-favorable conditions)',
    },
    {
      feature_name: 'home_record_home',
      feature_value: '11-4',
      shap_value: 0.19,
      direction: 'positive',
      label: 'Home Record at Yankee Stadium: 11-4',
    },
  ],
  features: {
    home_sp_era_last_30d: 2.14,
    away_bullpen_usage_2d: 7.2,
    park_run_factor: 98,
    weather_wind_factor: 7,
    home_record_home: '11-4',
  },
  model_version: 'moneyline-v1.0.0',
  generated_at: '2026-04-22T12:30:00Z',
};

// ---------------------------------------------------------------------------
// Test Case A: Clean Pro Pick (expected: PASS)
// ---------------------------------------------------------------------------

const PRO_INPUT: RationaleInput = {
  pick: NYY_ATL_PICK_BASE,
  game_context: NYY_ATL_GAME_CONTEXT,
  tier: 'pro',
};

const PRO_OUTPUT: RationaleOutput = {
  rationale_text: `Statistical analysis favors the New York Yankees at home against the Atlanta Braves. \
Gerrit Cole enters with a Home Starter ERA (30-day): 2.14, suggesting elite-level performance over the \
past month, which tilts the edge toward the home side. The Away Bullpen Load (2-day IP): 7.2 innings — \
elevated fatigue indicates the Braves' relief corps enters this game compromised, which the model \
flags as a meaningful disadvantage for Atlanta. The Yankees' Home Record at Yankee Stadium: 11-4 \
further supports the edge, with the model assigning a 58.7% win probability on the moneyline. \
Past model performance does not guarantee future results. Bet responsibly.`,
  rationale_preview: `Statistical analysis favors the New York Yankees at home against the Atlanta Braves. \
Gerrit Cole enters with a Home Starter ERA (30-day): 2.14, suggesting elite-level performance over the past month, which tilts the edge toward the home side.`,
  model_used: 'claude-haiku-4-5',
  tokens_used: 540,
  cost_usd: 0.000312,
  generated_at: '2026-04-22T12:31:00Z',
};

// ---------------------------------------------------------------------------
// Test Case B: Clean Elite Pick (expected: PASS)
// ---------------------------------------------------------------------------

const ELITE_INPUT: RationaleInput = {
  pick: { ...NYY_ATL_PICK_BASE, confidence_tier: 5, expected_value: 0.094 },
  game_context: NYY_ATL_GAME_CONTEXT,
  tier: 'elite',
};

const ELITE_OUTPUT: RationaleOutput = {
  rationale_text: `Statistical analysis indicates a meaningful edge for the New York Yankees hosting the \
Atlanta Braves at Yankee Stadium tonight. Gerrit Cole's recent dominance — Home Starter ERA (30-day): 2.14 \
— is the primary driver, suggesting he is pitching at the top of his form heading into this matchup. \
Compounding Atlanta's challenge, the Away Bullpen Load (2-day IP): 7.2 innings — elevated fatigue signal \
indicates their bullpen enters the game compromised. The Yankees' own Home Record at Yankee Stadium: 11-4 \
provides further structural support for a home-side edge. Mild offensive conditions (Wind: 7 mph blowing \
out to CF (mild offense-favorable conditions)) offer limited weather-related edge, while the Park Run \
Factor: 98 (slight pitcher-friendly environment) marginally benefits Cole's approach. The model assigns \
a 58.7% win probability with a +9.4% expected value edge on the moneyline.

**Key factors driving this pick:**
• Home Starter ERA (30-day): 2.14: Cole's recent ERA sits well below league average, indicating \
  sustained command and effectiveness — a strong predictor of home-side outcomes.
• Away Bullpen Load (2-day IP): 7.2 innings — elevated fatigue: An overworked Braves bullpen is a \
  structural disadvantage that statistically correlates with opponent scoring opportunities.
• Home Record at Yankee Stadium: 11-4: The Yankees have been dominant at home this season, reflecting \
  a genuine home-field advantage in this environment.
• Wind: 7 mph blowing out to CF (mild offense-favorable conditions): Modest offense-favoring wind that \
  slightly edges the over and can benefit power hitters.
• Park Run Factor: 98 (slight pitcher-friendly environment): Yankee Stadium runs marginally below \
  neutral, offering a modest advantage to an elite starter like Cole.

Past model performance does not guarantee future results. Bet responsibly.`,
  rationale_preview: `Statistical analysis indicates a meaningful edge for the New York Yankees hosting the \
Atlanta Braves at Yankee Stadium tonight. Gerrit Cole's recent dominance — Home Starter ERA (30-day): 2.14 \
— is the primary driver, suggesting he is pitching at the top of his form heading into this matchup.`,
  model_used: 'claude-sonnet-4-6',
  tokens_used: 1120,
  cost_usd: 0.002180,
  generated_at: '2026-04-22T12:31:05Z',
};

// ---------------------------------------------------------------------------
// Test Case C: Hallucination Injection (expected: FAIL)
// Rationale cites a pitcher ERA (1.87) that does NOT appear in any attribution.
// ---------------------------------------------------------------------------

const HALLUCINATION_INPUT: RationaleInput = {
  pick: NYY_ATL_PICK_BASE,
  game_context: NYY_ATL_GAME_CONTEXT,
  tier: 'pro',
};

// This output hallucinations a specific ERA value (1.87) that was not provided
// in the feature attributions — the attribution says 2.14, not 1.87.
const HALLUCINATION_OUTPUT: RationaleOutput = {
  rationale_text: `The New York Yankees hold a statistical edge against the Atlanta Braves tonight. \
Gerrit Cole has been dominant, posting an ERA of 1.87 over his last five starts — well below the league \
average and indicating he is in top form. The model assigns a 58.7% win probability on this moneyline. \
Away Bullpen Load (2-day IP): 7.2 innings — elevated fatigue suggests Atlanta's relief corps is \
stretched heading into this game. Past model performance does not guarantee future results. Bet responsibly.`,
  rationale_preview: `The New York Yankees hold a statistical edge against the Atlanta Braves tonight. \
Gerrit Cole has been dominant, posting an ERA of 1.87 over his last five starts — well below the league average.`,
  model_used: 'claude-haiku-4-5',
  tokens_used: 490,
  cost_usd: 0.000280,
  generated_at: '2026-04-22T12:31:10Z',
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const EVAL_TEST_CASES: EvalTestCase[] = [
  {
    name: 'Pro pick — clean rationale, all checks should pass',
    input: PRO_INPUT,
    output: PRO_OUTPUT,
    expectedResult: 'pass',
  },
  {
    name: 'Elite pick — clean rationale with EV and bullets, all checks should pass',
    input: ELITE_INPUT,
    output: ELITE_OUTPUT,
    expectedResult: 'pass',
  },
  {
    name: 'Hallucination injection — fabricated ERA (1.87) not in inputs, should fail',
    input: HALLUCINATION_INPUT,
    output: HALLUCINATION_OUTPUT,
    expectedResult: 'fail',
  },
];
