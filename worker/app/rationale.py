"""
Diamond Edge — AI rationale generation (pick-level Anthropic call).

This module implements the real /rationale handler called from
`worker/app/main.py`. It mirrors `/rationale-news` for the Anthropic-SDK
+ prompt-caching pattern and ports the existing TypeScript reasoning
contract in `apps/web/lib/ai/*` to Python so the Fly.io worker is the
single source of truth for pick rationale at inference time.

Design invariants (from pick-scope-gate-2026-04-24.md, Proposal 3):

1. Model routing: pro → Haiku 4.5, elite → Sonnet 4.6. Locked.
2. Cache-eligible system prompt (cache_control: ephemeral). Variable
   pick data goes in the user message, uncached.
3. Grounding: rationale may ONLY cite facts present in
   `feature_attributions[].label` or `game_context.*`.
4. Architecture keyword ban: SHAP, LightGBM, gradient, tree,
   feature importance, model, algorithm, training, boosted, ensemble.
   Enforced both in the system prompt AND via a post-response scrub
   so a model that ignores the prompt still produces a compliant
   output.
5. Responsible-gambling hedge: programmatically appended to every
   returned rationale (not prompt-only) per the scope-gate
   belt-and-suspenders recommendation.
6. Temperature 0 for deterministic output — required for the
   rationale_cache prompt_hash dedup path in
   `supabase/functions/pick-pipeline/rationale.ts`.
7. Tier depth targets encoded in prompt: Pro 3–5 sentences + 2–3
   citations; Elite ≥6-sentence paragraph + bullet breakdown of ≥5
   citations.

Cache-version bump:
  RATIONALE_PROMPT_VERSION below is the worker-side marker for the
  current prompt structure. When this constant changes, the
  Edge-Function-side cache hash in
  `supabase/functions/pick-pipeline/rationale.ts` must also change
  (look for PROMPT_CACHE_VERSION there) so stale cached rows are not
  served under a new prompt contract.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

# Structural prompt version. Bump on any substantive edit to
# SYSTEM_PROMPT, tier-depth rules, ban list, or user-prompt shape.
# Must be kept in sync with PROMPT_CACHE_VERSION in
# supabase/functions/pick-pipeline/rationale.ts.
RATIONALE_PROMPT_VERSION = "v1"

# Locked model routing. Matches CLAUDE.md LLM routing + existing
# TypeScript module `apps/web/lib/ai/generate-rationale.ts`.
MODEL_PRO = "claude-haiku-4-5"
MODEL_ELITE = "claude-sonnet-4-6"

# Anthropic pricing (2026-04-22). Update when Anthropic changes pricing.
# Per 1M tokens, USD.
_PRICING: dict[str, dict[str, float]] = {
    "claude-haiku-4-5": {
        "input": 0.80,
        "output": 4.00,
        "cache_read": 0.08,
        "cache_write": 1.00,
    },
    "claude-sonnet-4-6": {
        "input": 3.00,
        "output": 15.00,
        "cache_read": 0.30,
        "cache_write": 3.75,
    },
}

# Programmatic responsible-gambling hedge. Must appear on every LIVE
# rationale. Canonical copy from docs/compliance/copy/responsible-gambling.md
# ("Surface 5: Pick Detail Page Sidebar" key sentence).
RG_HEDGE = (
    "Past model performance does not guarantee future results. "
    "Bet responsibly. Problem gambling? Call 1-800-522-4700."
)

# Architecture keywords that must NOT appear in subscriber-facing text.
# Enforced by a post-response scrub; the model is also instructed to
# avoid them in the system prompt. Whole-word, case-insensitive.
_BANNED_KEYWORDS = (
    "SHAP",
    "LightGBM",
    "gradient",
    "tree",
    "feature importance",
    "model",
    "algorithm",
    "training",
    "boosted",
    "ensemble",
)

# Neutral substitutions applied by the scrub when a banned word leaks
# through. Preserves sentence flow while guaranteeing compliance.
_BANNED_SUBSTITUTIONS: dict[str, str] = {
    "shap": "statistical",
    "lightgbm": "statistical analysis",
    "gradient": "signal",
    "tree": "factor",
    "feature importance": "factor weight",
    "model": "analysis",
    "algorithm": "analysis",
    "training": "historical data",
    "boosted": "combined",
    "ensemble": "combined",
}


# ---------------------------------------------------------------------------
# System prompt (cache-eligible)
# ---------------------------------------------------------------------------
# The RG hedge is NOT required in the model output here — we append it
# programmatically after the response. Leaving it out of the prompt
# saves tokens and ensures compliance even if the model ignores the
# instruction.
SYSTEM_PROMPT = """You are Diamond Edge, a statistical sports analysis service. \
Your job is to write clear, grounded rationale explaining why Diamond Edge's \
statistical analysis favors a particular MLB betting market outcome.

## Your Role

You translate statistical analysis into plain-English reasoning that helps \
subscribers understand the edge behind a pick. You write with authority but \
never with false certainty — the numbers suggest edges, they do not guarantee \
outcomes.

## Voice and Tone

- Direct, confident, and analytical — like a sharp sports bettor explaining \
their reasoning, not a tout hyping a pick.
- Use hedged language: "suggests," "tilts the edge toward," "Diamond Edge \
favors," "the numbers indicate," "statistical analysis points to." Never say \
"will win," "lock," "guaranteed," or any phrase implying certainty.
- Avoid superlatives. Let the numbers speak.
- Brand name in copy: Diamond Edge. Do not say "our model," "the AI," \
"our algorithm," or any technical term.

## Strict Grounding Rules

1. ONLY cite facts explicitly present in the Feature Attributions or Game \
Context provided in the user message. Do NOT introduce any statistic, player \
name, team name, record, or factual claim that is not in those inputs.
2. ALWAYS lead with the single strongest factor — the top feature attribution \
— and quote its label verbatim.
3. NEVER reference internal architecture. Forbidden words (must not appear \
anywhere in your output): SHAP, LightGBM, gradient, tree, feature importance, \
model, algorithm, training, boosted, ensemble. Use "statistical analysis," \
"the numbers," "Diamond Edge," or "factors" instead.
4. NEVER claim certainty. Every directional claim must use hedged language.
5. Do NOT write a responsible-gambling disclaimer — a standard hedge is \
appended automatically after your response. Focus the full response budget \
on analysis.

## Output Format by Tier

When the user message specifies TIER: PRO:
- Write 3 to 5 sentences total.
- Cite 2 to 3 feature attributions by their label verbatim.
- State the win probability as a percentage (e.g., "58% win probability").
- Do NOT include the expected value figure.
- Do NOT append a disclaimer — one is added after your response.

When the user message specifies TIER: ELITE:
- Write an opening paragraph of at least 6 sentences covering the primary \
factors. Aim for depth of analysis, not padding.
- Follow the paragraph with a bullet-point breakdown of 5 feature \
attributions, each formatted as: "- [Label]: [one-sentence interpretation \
tied to the pick]".
- State BOTH the win probability AND the expected value explicitly \
(e.g., "Diamond Edge favors this side at a 58% win probability with a +4.8% \
expected-value edge").
- Do NOT append a disclaimer — one is added after your response.

## What Not to Do

- Do not invent statistics not present in the inputs.
- Do not reference injuries, trades, or news unless they appear in the \
Game Context.
- Do not pad with filler. Every sentence should add analytical value.
- Do not reference cost, API, caching, or any technical plumbing."""


# ---------------------------------------------------------------------------
# User prompt (per-pick, uncached)
# ---------------------------------------------------------------------------
def _format_odds(american_odds: int) -> str:
    return f"+{american_odds}" if american_odds > 0 else f"{american_odds}"


def _format_pick_side(side: str, market: str) -> str:
    if market in ("moneyline", "run_line"):
        if side == "home":
            return "Home Team"
        if side == "away":
            return "Away Team"
    if market in ("total", "totals"):
        if side == "over":
            return "Over"
        if side == "under":
            return "Under"
    return side


def _format_market(market: str) -> str:
    labels = {
        "moneyline": "Moneyline",
        "run_line": "Run Line",
        "total": "Total (Over/Under)",
        "totals": "Total (Over/Under)",
        "prop": "Player Prop",
    }
    return labels.get(market, market)


def _format_attributions(attributions: list[dict], max_n: int) -> str:
    if not attributions:
        return "No attributions available."
    lines = []
    for i, attr in enumerate(attributions[:max_n]):
        direction = attr.get("direction", "positive")
        direction_label = (
            "supports pick" if direction == "positive" else "works against pick"
        )
        label = attr.get("label", attr.get("feature_name", "unknown"))
        lines.append(f"{i + 1}. {label} ({direction_label})")
    return "\n".join(lines)


def build_user_prompt(pick: dict, game_context: dict, tier: str) -> str:
    """Assemble the per-pick user message. Not cached; varies per pick."""
    tier_label = "ELITE" if tier == "elite" else "PRO"

    market = pick.get("market", "moneyline")
    pick_side = pick.get("pick_side", "home")
    pick_side_str = _format_pick_side(pick_side, market)

    best_line = pick.get("best_line") or {}
    odds_str = _format_odds(int(best_line.get("price", 0)))
    book_name = (
        "DraftKings"
        if best_line.get("sportsbook_key") == "draftkings"
        else "FanDuel"
    )

    prob_pct = f"{(float(pick.get('model_probability', 0.5)) * 100):.1f}"
    ev_pct = f"{(float(pick.get('expected_value', 0.0)) * 100):.1f}"

    max_attr = 5 if tier == "elite" else 3
    attributions = pick.get("feature_attributions") or []

    home_team = game_context.get("home_team") or {}
    away_team = game_context.get("away_team") or {}
    venue = game_context.get("venue", "Unknown venue")
    game_time = game_context.get("game_time_local") or game_context.get(
        "game_time_utc", "TBD"
    )

    home_pitcher_obj = game_context.get("probable_home_pitcher") or {}
    away_pitcher_obj = game_context.get("probable_away_pitcher") or {}
    home_pitcher = home_pitcher_obj.get("full_name", "TBD")
    away_pitcher = away_pitcher_obj.get("full_name", "TBD")

    weather = game_context.get("weather")
    if weather:
        weather_str = (
            f"{weather.get('temp_f', '?')}°F, "
            f"{weather.get('condition', 'unknown')}, "
            f"wind {weather.get('wind_mph', '?')} mph "
            f"{weather.get('wind_dir', '?')}"
        )
    else:
        weather_str = "Not available"

    ev_line = f"Expected Value: +{ev_pct}%\n" if tier == "elite" else ""

    return (
        f"TIER: {tier_label}\n\n"
        f"## Game Context\n\n"
        f"Matchup: {away_team.get('name', 'Away')} "
        f"({away_team.get('abbreviation', 'AWY')}) at "
        f"{home_team.get('name', 'Home')} "
        f"({home_team.get('abbreviation', 'HOM')})\n"
        f"Records: {away_team.get('abbreviation', 'AWY')} "
        f"{away_team.get('record', 'n/a')} / "
        f"{home_team.get('abbreviation', 'HOM')} "
        f"{home_team.get('record', 'n/a')}\n"
        f"Time: {game_time}\n"
        f"Venue: {venue}\n"
        f"Probable Pitchers: {away_pitcher} (away) vs. {home_pitcher} (home)\n"
        f"Weather: {weather_str}\n\n"
        f"## The Pick\n\n"
        f"Market: {_format_market(market)}\n"
        f"Pick: {pick_side_str}\n"
        f"Best Available Line: {odds_str} ({book_name})\n"
        f"Win Probability: {prob_pct}%\n"
        f"{ev_line}"
        f"Confidence Tier: {pick.get('confidence_tier', 3)}/5\n\n"
        f"## Feature Attributions (Key Factors)\n\n"
        f"{_format_attributions(attributions, max_attr)}\n\n"
        f"---\n\n"
        f"Write the rationale for this pick following the TIER: {tier_label} "
        f"format specified in your instructions. Use only the facts provided "
        f"above — do not introduce any statistics, names, or claims not "
        f"present in this message. Do not append a disclaimer."
    )


# ---------------------------------------------------------------------------
# Post-response scrub + hedge append
# ---------------------------------------------------------------------------
def scrub_banned_keywords(text: str) -> tuple[str, list[str]]:
    """
    Strip architecture keywords from rationale text. Whole-word,
    case-insensitive. Returns (scrubbed_text, list_of_leaks_detected).

    Leaks are logged upstream so repeat offenders trigger a prompt revision
    rather than hiding behind the scrub indefinitely.
    """
    leaks: list[str] = []
    out = text
    for banned in _BANNED_KEYWORDS:
        # Word-boundary match. "feature importance" contains a space, so
        # we anchor on (?<!\w) / (?!\w) rather than \b which doesn't
        # handle multi-word phrases cleanly.
        pattern = re.compile(
            r"(?<!\w)" + re.escape(banned) + r"(?!\w)",
            re.IGNORECASE,
        )
        if pattern.search(out):
            leaks.append(banned)
            substitution = _BANNED_SUBSTITUTIONS[banned.lower()]
            out = pattern.sub(substitution, out)
    # Collapse any double-whitespace artifacts from replacements.
    out = re.sub(r"\s{2,}", " ", out).strip()
    return out, leaks


def append_rg_hedge(text: str) -> str:
    """Programmatic responsible-gambling hedge. Idempotent — will not
    double-append if the canonical sentence is already present."""
    if "1-800-522-4700" in text and "Bet responsibly" in text:
        return text.strip()
    separator = " " if text.endswith((".", "!", "?")) else ". "
    return f"{text.strip()}{separator}{RG_HEDGE}"


def extract_preview(text: str) -> str:
    """First 1–2 sentences of rationale_text, for preview cards."""
    sentences = re.findall(r"[^.!?]+[.!?]+", text)
    if not sentences:
        return text.strip()[:280]
    return " ".join(s.strip() for s in sentences[:2]).strip()


def _compute_cost(usage: Any, model: str) -> float:
    pricing = _PRICING.get(model, _PRICING[MODEL_PRO])
    input_tokens = getattr(usage, "input_tokens", 0) or 0
    output_tokens = getattr(usage, "output_tokens", 0) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0
    return (
        (input_tokens / 1_000_000) * pricing["input"]
        + (output_tokens / 1_000_000) * pricing["output"]
        + (cache_read / 1_000_000) * pricing["cache_read"]
        + (cache_write / 1_000_000) * pricing["cache_write"]
    )


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
def generate_rationale(body: dict) -> dict:
    """
    Handle a /rationale request. Returns the response dict the caller
    JSON-encodes.

    Input shape (matches RationaleRequest in
    supabase/functions/pick-pipeline/types.ts):
        {
            "pick":         PickCandidate dict,
            "game_context": GameContext dict,
            "tier":         "pro" | "elite"
        }

    Output shape (matches RationaleResponse):
        {
            "rationale_text":    str,
            "rationale_preview": str,
            "model_used":        str,
            "tokens_used":       int,
            "cost_usd":          float,
            "generated_at":      ISO8601
        }

    Raises:
        ValueError on bad input.
        RuntimeError on configuration errors (missing API key / SDK).
        anthropic_sdk.APIError on upstream failure (caller decides
        whether to swallow and publish with rationale_id=null, matching
        existing fallback behavior).
    """
    pick = body.get("pick") or {}
    game_context = body.get("game_context") or {}
    tier = body.get("tier", "pro")

    if tier not in ("pro", "elite"):
        raise ValueError(f"tier must be 'pro' or 'elite', got {tier!r}")

    if not pick.get("feature_attributions"):
        raise ValueError(
            "pick.feature_attributions must be non-empty for rationale generation"
        )

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not anthropic_key:
        raise RuntimeError("ANTHROPIC_API_KEY not configured")

    try:
        import anthropic as anthropic_sdk
    except ImportError as e:
        raise RuntimeError("anthropic SDK not installed") from e

    client = anthropic_sdk.Anthropic(api_key=anthropic_key)
    model = MODEL_ELITE if tier == "elite" else MODEL_PRO
    # Elite rationales are ~6 sentences + 5-bullet breakdown; Pro is 3–5
    # sentences with no bullets. max_tokens sized so the model does not
    # truncate a compliant response.
    max_tokens = 1024 if tier == "elite" else 512

    user_prompt = build_user_prompt(pick, game_context, tier)

    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        temperature=0,
        system=[
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_prompt}],
    )

    raw_text = "".join(
        block.text for block in response.content if hasattr(block, "text")
    ).strip()

    if not raw_text:
        raise RuntimeError(
            f"Claude returned empty rationale for game_id="
            f"{pick.get('game_id', 'unknown')} tier={tier}"
        )

    # Scrub banned architecture keywords (belt and suspenders: system
    # prompt forbids, scrub enforces). Log any leaks for prompt-quality
    # tracking — the rationale-eval gate will also catch them.
    scrubbed_text, leaks = scrub_banned_keywords(raw_text)

    # Append the canonical RG hedge. Programmatic, not prompt-only:
    # guarantees compliance even if the model silently omitted one.
    final_text = append_rg_hedge(scrubbed_text)

    preview = extract_preview(final_text)

    usage = response.usage
    cost_usd = _compute_cost(usage, model)
    input_tokens = getattr(usage, "input_tokens", 0) or 0
    output_tokens = getattr(usage, "output_tokens", 0) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0

    return {
        "rationale_text": final_text,
        "rationale_preview": preview,
        "model_used": model,
        "tokens_used": input_tokens + output_tokens,
        "cost_usd": round(cost_usd, 8),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        # Non-contract telemetry fields (ignored by Edge Function insert
        # path; useful for observability in worker logs).
        "_telemetry": {
            "tokens_input": input_tokens,
            "tokens_output": output_tokens,
            "tokens_cache_read": cache_read,
            "tokens_cache_write": cache_write,
            "cache_hit": cache_read > 0,
            "banned_keyword_leaks": leaks,
            "prompt_version": RATIONALE_PROMPT_VERSION,
        },
    }
