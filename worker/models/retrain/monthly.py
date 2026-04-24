"""
monthly.py — Automated monthly retrain + artifact versioning.

Pulls latest data from Supabase, rebuilds training parquet with any
accumulated news_signals features, trains B2 delta models for all three
markets using the same walk-forward protocol as train_b2_delta.py, and
evaluates against a 2024 holdout PLUS a "last 90 days live picks" window
using pick_outcomes data.

Auto-promote logic (per task spec):
  - Promote new model to "current" if BOTH:
      delta_CLV > +0.1 percentage points, AND
      new log_loss < prior log_loss (no regression)
  - Otherwise keep prior model; report is still written for visibility.

Null-prior policy (added 2026-04-24 per pick-scope-gate proposal #4):
  - If there is no prior (no current_version.json OR no metrics.json at the
    pointed-to artifact dir), the NEW artifact is still written to v<ts>/ for
    inspection but current_version.json is NOT updated. The summary flags
    "first-train, awaiting sign-off; run promote.py to activate".
  - Explicit override: pass --force-promote-no-prior AND --yes. Even with the
    override, promotion is refused if lgbm_best_iteration == 1 (the
    "LightGBM found no split" signal).
  - Use worker/models/retrain/promote.py to promote a specific artifact
    after operator review.

Run:
  python -m worker.models.retrain.monthly [--dry-run] [--offline]
                                          [--force-promote-no-prior] [--yes]

Output:
  worker/models/<market>/artifacts/v<timestamp>/model.pkl + manifest.json
  worker/models/retrain/reports/<timestamp>/summary.json
  worker/models/<market>/artifacts/current_version.json  (if promoted)

Compute SLA: under 30 min on Fly.io shared-cpu-1x (matches B2 benchmark).
No GPU required. LightGBM with n_jobs=-1 is CPU-only.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import pickle
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).parents[3]
sys.path.insert(0, str(ROOT))

MODELS_DIR = ROOT / "worker" / "models"
RETRAIN_DIR = MODELS_DIR / "retrain"
REPORTS_DIR = RETRAIN_DIR / "reports"
DATA_DIR = ROOT / "data" / "training"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("monthly_retrain")

# ±15% delta clip matches train_b2_delta.py exactly
DELTA_CLIP = 0.15

# Auto-promote thresholds (see task spec)
PROMOTE_MIN_CLV_DELTA_PCT = 0.1     # new model CLV must beat prior by at least +0.1%
PROMOTE_MAX_LOGLOSS_REGRESSION = 0.0  # new log_loss must not exceed prior

# Variance-collapse guardrail (pick cycle 1 Proposal #7, 2026-04-24).
# Thresholds derived from the moneyline-b2-v1 failure on 2026-04-23, whose
# holdout metrics were lgbm_best_iteration=1, nonzero_delta_rate_02=0.0,
# delta_std=0.0027. Each threshold is set comfortably above the failing
# values so a healthy model clears them with room to spare.
#
#   VARIANCE_COLLAPSE_MIN_BEST_ITER: B2's iter-1 was LightGBM finding zero
#     useful splits. Any artifact with <=1 iterations is degenerate by
#     definition — the model is returning the training-mean constant.
#     P4 (promote.py --allow-degenerate, shipped 2026-04-24) already guards
#     this at promote time; P7 moves the refusal upstream to retrain time.
#   VARIANCE_COLLAPSE_MIN_NONZERO_DELTA_RATE: fraction of holdout predictions
#     with |delta| > 0.02. B2 had 0.0 (pure passthrough of market prior).
#     A healthy run_line model (B2) measured 0.884; totals measured 0.554.
#     0.1 is well above the failing value and well below any observed healthy
#     value, so it cleanly separates the two regimes.
#   VARIANCE_COLLAPSE_MIN_DELTA_STD: standard deviation of the clipped
#     holdout delta. B2 measured 0.0027 — deltas are packed inside a ±0.0054
#     band around zero, so even a +8% EV pick is mostly the market prior
#     (LIVE picks become market-equivalent). 0.005 is ~1.85x B2's failing
#     value; healthy totals measured 0.0476 and healthy run_line 0.1358.
VARIANCE_COLLAPSE_MIN_BEST_ITER = 1
VARIANCE_COLLAPSE_MIN_NONZERO_DELTA_RATE = 0.1
VARIANCE_COLLAPSE_MIN_DELTA_STD = 0.005


def check_variance_collapse(metrics: dict) -> tuple[bool, list[str]]:
    """
    Inspect a per-market metrics dict for variance-collapse signals.

    Returns (collapsed: bool, reasons: list[str]). `collapsed` is True if ANY
    of the three signals fire. `reasons` lists each failing condition in a
    human-readable form for logging and the retrain summary.

    Guard layers (belt-and-suspenders vs P4's promote.py check):
      - lgbm_best_iteration <= 1 — the B2 trap: LightGBM early-stopped at
        iter 1 after finding no useful split. Already caught by
        promote.py's existing refusal; included here so monthly.py flags
        it BEFORE the promote-eligibility branch.
      - nonzero_delta_rate_02 < 0.1 — nearly every delta is <=2% in
        magnitude, so picks collapse to the market prior. B2 had 0.0.
      - delta_std < 0.005 — deltas are packed tightly around zero. B2 had
        0.0027, healthy markets measure 0.04-0.14.

    Missing metrics (training errored, skipped market) are NOT treated as
    a collapse — the caller already handles those via the "error"/"skipped"
    branches and we don't want to double-flag.
    """
    reasons: list[str] = []
    holdout = (metrics.get("holdout_2024") or {})

    best_iter = metrics.get("lgbm_best_iteration")
    if best_iter is not None and best_iter <= VARIANCE_COLLAPSE_MIN_BEST_ITER:
        reasons.append(
            f"lgbm_best_iteration={best_iter} <= {VARIANCE_COLLAPSE_MIN_BEST_ITER} "
            "(LightGBM found no useful split — the moneyline-b2-v1 failure mode)"
        )

    nonzero_rate = holdout.get("nonzero_delta_rate_02")
    if nonzero_rate is not None and nonzero_rate < VARIANCE_COLLAPSE_MIN_NONZERO_DELTA_RATE:
        reasons.append(
            f"nonzero_delta_rate_02={nonzero_rate} < {VARIANCE_COLLAPSE_MIN_NONZERO_DELTA_RATE} "
            "(model is a market-prior passthrough — deltas below ±0.02 for nearly every game)"
        )

    delta_std = holdout.get("delta_std")
    if delta_std is not None and delta_std < VARIANCE_COLLAPSE_MIN_DELTA_STD:
        reasons.append(
            f"delta_std={delta_std} < {VARIANCE_COLLAPSE_MIN_DELTA_STD} "
            "(holdout delta distribution too tight to carry edge)"
        )

    return (len(reasons) > 0, reasons)


# ---------------------------------------------------------------------------
# Supabase pull helpers
# ---------------------------------------------------------------------------

def _get_supabase_client():
    """Return a Supabase service-role client. Requires env vars."""
    try:
        from supabase import create_client
    except ImportError:
        raise ImportError(
            "supabase-py not installed. On Fly.io this is in requirements.txt. "
            "For local dry-runs use --offline to skip Supabase pulls."
        )

    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. "
            "For local dry-runs without credentials use --offline."
        )
    return create_client(url, key)


def pull_games_from_supabase(supabase) -> pd.DataFrame:
    """
    Pull all games with final status from Supabase games table.
    Returns DataFrame with game-level fields the training pipeline needs.
    """
    log.info("Pulling games from Supabase...")
    response = (
        supabase.table("games")
        .select(
            "id, game_date, commence_time, home_team_id, away_team_id, "
            "home_score, away_score, status, season"
        )
        .eq("status", "final")
        .execute()
    )
    rows = response.data or []
    log.info(f"  {len(rows)} final games pulled")
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    df["home_win"] = (df["home_score"] > df["away_score"]).astype(int)
    return df


def pull_odds_from_supabase(supabase) -> pd.DataFrame:
    """
    Pull odds rows from Supabase. Returns all three snapshot times
    (morning, afternoon, evening) joined as wide per the load_historical_odds_v2 schema.
    The Supabase odds table stores snapshot_time; we pivot here.
    """
    log.info("Pulling odds from Supabase...")
    response = (
        supabase.table("odds")
        .select(
            "game_id, snapshot_time, book, market, "
            "home_price, away_price, over_price, under_price, over_point"
        )
        .execute()
    )
    rows = response.data or []
    log.info(f"  {len(rows)} odds rows pulled")
    return pd.DataFrame(rows) if rows else pd.DataFrame()


def pull_news_signals_from_supabase(supabase) -> pd.DataFrame:
    """
    Pull accumulated news_signals from Supabase.
    Returns empty DataFrame if no rows yet — news signals accumulate over time.
    """
    log.info("Pulling news_signals from Supabase...")
    response = (
        supabase.table("news_signals")
        .select("game_id, signal_type, payload, confidence, created_at")
        .execute()
    )
    rows = response.data or []
    log.info(f"  {len(rows)} news_signal rows pulled")
    return pd.DataFrame(rows) if rows else pd.DataFrame()


def pull_pick_outcomes_from_supabase(supabase, days: int = 90) -> pd.DataFrame:
    """
    Pull pick_outcomes for the last `days` days — the live picks feedback loop.
    Used for the "last 90 days" evaluation window.
    """
    log.info(f"Pulling pick_outcomes (last {days} days) from Supabase...")
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

    # Join picks → pick_outcomes for graded picks
    response = (
        supabase.table("pick_outcomes")
        .select(
            "pick_id, outcome, graded_at, "
            "picks(game_id, market, pick_side, model_probability, "
            "market_novig_prior, model_delta, confidence_tier, created_at)"
        )
        .gte("graded_at", cutoff)
        .execute()
    )
    rows = response.data or []
    log.info(f"  {len(rows)} graded pick_outcomes in last {days} days")
    if not rows:
        return pd.DataFrame()

    # Flatten nested picks join
    flat = []
    for r in rows:
        pick_data = r.get("picks") or {}
        flat.append({
            "pick_id": r["pick_id"],
            "outcome": r["outcome"],
            "graded_at": r["graded_at"],
            "game_id": pick_data.get("game_id"),
            "market": pick_data.get("market"),
            "pick_side": pick_data.get("pick_side"),
            "model_probability": pick_data.get("model_probability"),
            "market_novig_prior": pick_data.get("market_novig_prior"),
            "model_delta": pick_data.get("model_delta"),
            "confidence_tier": pick_data.get("confidence_tier"),
            "created_at": pick_data.get("created_at"),
        })
    return pd.DataFrame(flat)


# ---------------------------------------------------------------------------
# News signal feature engineering
# ---------------------------------------------------------------------------

def build_news_features(df: pd.DataFrame, news_signals: pd.DataFrame) -> pd.DataFrame:
    """
    Aggregate news_signals per game into training features.

    Feature names MUST match the features.py inference path (canonical source):
      late_scratch_count         — count of late_scratch signals
      late_scratch_war_impact_sum — sum of payload.war_proxy for late scratches
      lineup_change_count        — count of lineup_change signals
      injury_update_severity_max — max SEVERITY_WEIGHT for injury_update signals
      opener_announced           — 1 if any opener_announcement signal
      weather_note_flag          — 1 if any weather_note signal

    Feature leakage audit:
      - news_signals are only written AFTER T-90min pipeline runs (pre-first-pitch).
        For TRAINING, signals are only present for games with accumulated data.
        Available at bet time — no leakage.
      - For any game without a news_signal row, all features default to 0.
    """
    SEVERITY_WEIGHT = {
        "day_to_day": 1, "questionable": 2,
        "il_10": 3, "il_15": 4, "il_60": 5,
    }

    news_cols = [
        "late_scratch_count", "late_scratch_war_impact_sum", "lineup_change_count",
        "injury_update_severity_max", "opener_announced", "weather_note_flag",
    ]

    if news_signals.empty or "game_id" not in news_signals.columns:
        for col in news_cols:
            df[col] = 0.0
        return df

    # Build per-game aggregates matching features.py SEVERITY_WEIGHT and payload logic
    records: list[dict] = []
    for game_id, grp in news_signals.groupby("game_id"):
        row: dict = {c: 0.0 for c in news_cols}
        row["game_id"] = game_id
        for _, sig in grp.iterrows():
            sig_type = sig.get("signal_type", "")
            payload = sig.get("payload") or {}
            if sig_type == "late_scratch":
                row["late_scratch_count"] += 1
                war = payload.get("war_proxy")
                if isinstance(war, (int, float)):
                    row["late_scratch_war_impact_sum"] += war
            elif sig_type == "lineup_change":
                row["lineup_change_count"] += 1
            elif sig_type == "injury_update":
                severity = payload.get("severity") or ""
                weight = SEVERITY_WEIGHT.get(severity, 1)
                if weight > row["injury_update_severity_max"]:
                    row["injury_update_severity_max"] = float(weight)
            elif sig_type == "opener_announcement":
                row["opener_announced"] = 1.0
            elif sig_type == "weather_note":
                row["weather_note_flag"] = 1.0
        records.append(row)

    if not records:
        for col in news_cols:
            df[col] = 0.0
        return df

    agg = pd.DataFrame(records)

    # Merge on game_id
    game_id_col = "id" if "id" in df.columns else "game_pk"
    if game_id_col in df.columns:
        df = df.merge(
            agg.rename(columns={"game_id": game_id_col}),
            on=game_id_col,
            how="left",
        )
    else:
        for col in news_cols:
            df[col] = 0.0
        return df

    for col in news_cols:
        if col in df.columns:
            df[col] = df[col].fillna(0.0)
        else:
            df[col] = 0.0

    return df


NEWS_FEATURES = [
    "late_scratch_count",
    "late_scratch_war_impact_sum",
    "lineup_change_count",
    "injury_update_severity_max",
    "opener_announced",
    "weather_note_flag",
]


# ---------------------------------------------------------------------------
# Training data rebuild — merges existing parquet with fresh Supabase data
# ---------------------------------------------------------------------------

def rebuild_training_parquet(
    supabase,
    out_path: Path,
    offline: bool = False,
) -> pd.DataFrame:
    """
    Rebuild the B2 training parquet by:
      1. Loading the existing games_b2.parquet (historical backfill)
      2. Pulling live games from Supabase (post-backfill seasons) — skipped in offline mode
      3. Joining news_signals features — empty in offline mode
      4. Writing the merged parquet to out_path

    The historical backfill (2022-2024) is the primary training corpus.
    Live Supabase games are supplemental (post-2024 seasons as they accumulate).

    offline=True: uses only existing parquet, skips all Supabase calls.
    Returns the merged DataFrame.
    """
    # --- Base: historical parquet ---
    b2_path = DATA_DIR / "games_b2.parquet"
    if b2_path.exists():
        log.info(f"Loading historical parquet: {b2_path}")
        df_hist = pd.read_parquet(b2_path)
        log.info(f"  Historical rows: {len(df_hist)}")
    else:
        log.warning("games_b2.parquet not found — rebuilding from scratch via build_training_data_b2")
        from worker.models.pipelines.build_training_data_b2 import build_b2_dataset
        df_hist = build_b2_dataset()
        df_hist.to_parquet(b2_path, index=False)

    if offline:
        log.info("  Offline mode: skipping Supabase pull, using historical parquet only")
        news_signals = pd.DataFrame()
    else:
        # --- Live: Supabase games (supplement) ---
        supabase_games = pull_games_from_supabase(supabase)
        news_signals = pull_news_signals_from_supabase(supabase)

        if not supabase_games.empty:
            hist_seasons = set(df_hist["season"].dropna().astype(int).unique()) if "season" in df_hist.columns else set()
            new_seasons = set(supabase_games["season"].dropna().astype(int).unique()) - hist_seasons
            log.info(f"  Seasons in historical parquet: {sorted(hist_seasons)}")
            log.info(f"  New seasons from Supabase: {sorted(new_seasons)}")
            # Merging live games into full feature rows requires the full feature pipeline.
            # That is out-of-scope for the 30-min retrain window.
            # Phase 3 will expand this when B3 news features accumulate.
            if new_seasons:
                log.info(
                    f"  NOTE: {len(new_seasons)} new season(s) detected in Supabase. "
                    "Full feature engineering requires pull_mlb_stats.py + feature_engineering.py. "
                    "Skipping for this retrain."
                )

    # --- Augment with news signal features ---
    df = build_news_features(df_hist.copy(), news_signals)

    # Write merged parquet
    df.to_parquet(out_path, index=False)
    log.info(f"  Rebuilt training parquet: {out_path} ({len(df)} rows, {len(df.columns)} cols)")
    return df


# ---------------------------------------------------------------------------
# Log-loss computation (calibration metric)
# ---------------------------------------------------------------------------

def _log_loss(y_true: np.ndarray, y_prob: np.ndarray, eps: float = 1e-7) -> float:
    """Binary log-loss. eps clips probabilities away from 0/1."""
    p = np.clip(y_prob, eps, 1.0 - eps)
    return float(-np.mean(y_true * np.log(p) + (1.0 - y_true) * np.log(1.0 - p)))


# ---------------------------------------------------------------------------
# Per-market training (delegates to train_b2_delta with versioned output dir)
# ---------------------------------------------------------------------------

def train_market_versioned(
    market: str,
    df: pd.DataFrame,
    feature_cols: list[str],
    target_col: str,
    prior_col: str,
    primary_odds_cols: tuple[str, str],
    opposing_odds_cols: tuple[str, str],
    closing_novig_col: str,
    version_dir: Path,
) -> tuple[dict, object | None]:
    """
    Train B2 delta model for one market, write artifacts to version_dir.
    Returns (metrics_dict, fitted_lgbm_model).

    This re-implements the core of train_b2_delta.train_b2_market but
    additionally writes the trained model object to version_dir/model_b2.pkl.
    The original train_b2_market does not return the model object; this
    wrapper captures it.
    """
    import lightgbm as lgb
    from sklearn.metrics import mean_absolute_error, mean_squared_error
    from worker.models.pipelines.train_b2_delta import (
        LGBM_PARAMS_B2,
        LGBM_PARAMS_B2_MONEYLINE_CLS,
        H2_2023_CUTOFF,
        _train_lgbm_regressor,
        _train_lgbm_classifier_b2_moneyline,
        compute_clv_delta,
        simulate_roi_delta,
        plot_reliability_b2,
        _remove_vig,
        drop_zero_variance_features,
        DELTA_CLIP as _DELTA_CLIP,
    )

    # Moneyline uses a binary classifier on the outcome (home_win) then
    # derives delta = predict_proba - prior. Regression-on-delta collapses to
    # iter-1 early-stop on moneyline (pick-research 2026-04-24 Proposal 1).
    # RL and totals keep the regression-on-delta path (both produce healthy
    # iteration counts — 87 and 37 on 2024 holdout).
    use_classifier = (market == "moneyline")

    log.info(f"Training {market.upper()} B2 delta model...")
    version_dir.mkdir(parents=True, exist_ok=True)

    valid = df.dropna(subset=[target_col, prior_col]).copy()
    valid["game_date_dt"] = pd.to_datetime(valid["game_date"])
    valid["season_dt"] = valid["game_date_dt"].dt.year

    train_2022 = valid[valid["season_dt"] == 2022].sort_values("game_date_dt")
    h2023_full = valid[valid["season_dt"] == 2023].sort_values("game_date_dt")
    h1_2023 = h2023_full[h2023_full["game_date_dt"] < H2_2023_CUTOFF]
    h2_2023 = h2023_full[h2023_full["game_date_dt"] >= H2_2023_CUTOFF]
    holdout = valid[valid["season_dt"] == 2024].sort_values("game_date_dt").copy()
    train_final = pd.concat([train_2022, h1_2023], ignore_index=True).sort_values("game_date_dt")

    log.info(f"  train={len(train_final)}, holdout={len(holdout)}")

    if len(train_final) < 500 or len(holdout) < 200:
        return {
            "market": market,
            "error": f"Insufficient data: train={len(train_final)}, holdout={len(holdout)}",
        }, None

    available_features = [f for f in feature_cols if f in valid.columns]
    missing_features = [f for f in feature_cols if f not in valid.columns]
    if missing_features:
        log.info(f"  Missing features (imputing 0): {missing_features[:5]}")
        for col in missing_features:
            for ds in [valid, train_final, h2_2023, holdout]:
                ds[col] = 0.0
        available_features = feature_cols

    # Drop zero-variance columns from the training matrix (pick-research
    # 2026-04-24 Proposal 2 — prevents feature_fraction bags from being
    # contaminated with constants that contributed to the iter-1 early-stop).
    declared_features = list(available_features)
    available_features, dropped_zero_var = drop_zero_variance_features(
        train_final[declared_features].fillna(0), declared_features,
    )
    if dropped_zero_var:
        log.info(
            f"  [{market}] Dropped {len(dropped_zero_var)} zero-variance features: "
            f"{dropped_zero_var}"
        )

    def to_xy(subset: pd.DataFrame):
        return (
            subset[available_features].fillna(0).values,
            subset[target_col].astype(float).values,
        )

    X_train_final, y_train_final = to_xy(train_final)
    _, y_hold = to_xy(holdout)
    X_hold = holdout[available_features].fillna(0).values

    prior_hold = holdout[prior_col].astype(float).values
    prior_train = train_final[prior_col].astype(float).values

    if use_classifier:
        # Binary classifier on absolute outcome (home_win = round(prior + delta)).
        # Delta is derived at inference as predict_proba() - prior (also below).
        y_binary_train = np.clip((prior_train + y_train_final).round(), 0, 1).astype(int)
        final_model = _train_lgbm_classifier_b2_moneyline(
            X_train_final, y_binary_train, f"{market}-final",
        )
        # Convert classifier prob -> delta for the holdout metrics pipeline.
        prob_hold = final_model.predict_proba(X_hold)[:, 1]
        delta_hold = prob_hold - prior_hold
        delta_source = "classifier_minus_prior"
    else:
        final_model = _train_lgbm_regressor(
            X_train_final, y_train_final, f"{market}-final",
        )
        delta_hold = final_model.predict(X_hold)
        delta_source = "regressor_raw"

    clipped_delta_hold = np.clip(delta_hold, -_DELTA_CLIP, _DELTA_CLIP)
    final_probs = np.clip(prior_hold + clipped_delta_hold, 0.05, 0.95)
    y_binary_hold = np.clip((prior_hold + y_hold).round(), 0, 1).astype(float)

    # RMSE is computed against the delta target for legacy comparability with
    # the regressor baseline. For the classifier path `delta_hold` is
    # predict_proba - prior, not the regressor output, but the RMSE here is
    # incidental metadata — the viability gates are log_loss / CLV / nonzero
    # rate / calibration deviation, not RMSE.
    rmse_hold = float(np.sqrt(mean_squared_error(y_hold, delta_hold)))
    rmse_prior = float(np.sqrt(mean_squared_error(y_hold, np.zeros(len(y_hold)))))

    # Log-loss on holdout
    log_loss_new = _log_loss(y_binary_hold, final_probs)
    log_loss_prior = _log_loss(y_binary_hold, np.clip(prior_hold, 1e-7, 1 - 1e-7))

    # Calibration diagram
    diag_path = version_dir / f"calibration_{market}.png"
    try:
        max_cal_dev = plot_reliability_b2(
            final_probs, y_binary_hold, f"{market} retrain", diag_path
        )
    except Exception as e:
        log.warning(f"  Calibration plot failed: {e}")
        max_cal_dev = 0.0

    # CLV
    clv_result = {"n": 0, "note": "closing novig column missing"}
    if closing_novig_col in holdout.columns:
        closing_novig = holdout[closing_novig_col].astype(float).values
        valid_closing = ~np.isnan(closing_novig) & ~np.isnan(prior_hold)
        if valid_closing.sum() > 50:
            clv_result = compute_clv_delta(
                prior_hold[valid_closing],
                clipped_delta_hold[valid_closing],
                closing_novig[valid_closing],
            )
        else:
            clv_result = {"n": int(valid_closing.sum()), "note": "insufficient closing novig rows"}

    # ROI simulation
    default_odds = -110
    pc1, pc2 = primary_odds_cols
    oc1, oc2 = opposing_odds_cols
    p_odds = np.maximum(
        holdout.get(pc1, pd.Series([default_odds] * len(holdout))).fillna(default_odds).values,
        holdout.get(pc2, pd.Series([default_odds] * len(holdout))).fillna(default_odds).values,
    ).astype(float)
    o_odds = np.maximum(
        holdout.get(oc1, pd.Series([default_odds] * len(holdout))).fillna(default_odds).values,
        holdout.get(oc2, pd.Series([default_odds] * len(holdout))).fillna(default_odds).values,
    ).astype(float)
    nv_primary = np.array([_remove_vig(float(hp), float(ho))[0] for hp, ho in zip(p_odds, o_odds)])

    roi_results: dict = {}
    for ev_thr in [0.04, 0.06, 0.08]:
        key = f"ev_thr_{int(ev_thr*100)}pct"
        roi_results[key] = simulate_roi_delta(
            prior_hold, clipped_delta_hold, y_binary_hold,
            p_odds, o_odds, nv_primary,
            ev_threshold=ev_thr,
        )

    best_roi = max(
        (roi_results.get(k, {}).get("delta_model", {}).get("roi") or 0)
        for k in roi_results
    )

    # Save model artifact. `delta_source` tells the serving path how to
    # derive the delta from model output:
    #   regressor_raw            -> model.predict(x) returns delta directly
    #   classifier_minus_prior   -> delta = model.predict_proba(x)[:, 1] - prior
    artifact = {
        "model": final_model,
        "features": available_features,
        "delta_clip": _DELTA_CLIP,
        "delta_source": delta_source,
        "prior_feature_name": prior_col,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_protocol": "walk_forward_b2_monthly_retrain",
    }
    pkl_path = version_dir / "model_b2.pkl"
    with open(pkl_path, "wb") as f:
        pickle.dump(artifact, f, protocol=5)
    log.info(f"  Model artifact written: {pkl_path}")

    metrics = {
        "market": market,
        "delta_source": delta_source,
        "holdout_2024": {
            "n": len(holdout),
            "rmse_b2": round(rmse_hold, 4),
            "rmse_prior_only": round(rmse_prior, 4),
            "beats_market_rmse": rmse_hold < rmse_prior,
            "log_loss_new_model": round(log_loss_new, 5),
            "log_loss_market_prior": round(log_loss_prior, 5),
            "log_loss_delta": round(log_loss_new - log_loss_prior, 5),
            "max_calibration_deviation": round(max_cal_dev, 4),
            "nonzero_delta_rate_02": round(float((np.abs(clipped_delta_hold) > 0.02).mean()), 3),
            "delta_std": round(float(np.std(clipped_delta_hold)), 4),
        },
        "clv": clv_result,
        "roi_simulation": roi_results,
        "best_roi_pct": round(best_roi, 2),
        "features": available_features,
        "n_features": len(available_features),
        "missing_features_imputed": missing_features,
        "declared_features": declared_features,
        "dropped_zero_var_features": dropped_zero_var,
        "lgbm_best_iteration": int(final_model.best_iteration_),
    }

    # Variance-collapse guardrail (P7, 2026-04-24). Stamp the flag + reasons
    # on the metrics dict BEFORE the promote-eligibility check sees them.
    collapsed, collapse_reasons = check_variance_collapse(metrics)
    metrics["variance_collapsed"] = collapsed
    metrics["variance_collapse_reasons"] = collapse_reasons
    if collapsed:
        log.warning(
            "  [%s] VARIANCE COLLAPSE DETECTED — artifact written to %s for "
            "inspection, but auto-promote is refused. Reasons: %s",
            market, version_dir, "; ".join(collapse_reasons),
        )

    return metrics, final_model


# ---------------------------------------------------------------------------
# Last 90 days live picks evaluation
# ---------------------------------------------------------------------------

def evaluate_live_picks(pick_outcomes: pd.DataFrame, market: str) -> dict:
    """
    Evaluate model performance on graded live picks from the last 90 days.
    Uses pick_outcomes to measure:
      - Win rate (per pick_side)
      - Log-loss of model_probability vs outcome
      - Mean CLV (if market_novig_prior available)

    Returns a metrics dict; empty/minimal if not enough graded picks exist.
    """
    if pick_outcomes.empty:
        return {"n": 0, "note": "No graded pick_outcomes available"}

    market_picks = pick_outcomes[pick_outcomes["market"] == market].copy()
    if len(market_picks) < 10:
        return {"n": len(market_picks), "note": "Fewer than 10 graded picks for this market"}

    # Binary outcome: 1 if pick won, 0 if lost
    market_picks["won"] = (market_picks["outcome"] == "won").astype(int)

    n = len(market_picks)
    win_rate = float(market_picks["won"].mean())

    # Log-loss of model_probability
    model_probs = market_picks["model_probability"].astype(float)
    log_loss = _log_loss(market_picks["won"].values, np.clip(model_probs.values, 1e-7, 1 - 1e-7))

    # CLV: market_novig_prior must exist in picks table
    clv_result: dict = {}
    if "market_novig_prior" in market_picks.columns:
        priors = market_picks["market_novig_prior"].astype(float)
        valid_priors = priors.notna() & model_probs.notna()
        if valid_priors.sum() > 5:
            # CLV here: model_probability vs market_novig_prior at pick time
            # (not vs closing, as closing data lives in pick_clv table)
            clv_values = (model_probs[valid_priors] - priors[valid_priors]).values
            clv_result = {
                "n_with_prior": int(valid_priors.sum()),
                "mean_model_vs_prior_edge_pct": round(float(np.mean(clv_values)) * 100, 3),
            }

    return {
        "n": n,
        "win_rate": round(win_rate, 4),
        "log_loss": round(log_loss, 5),
        "clv_vs_prior": clv_result,
    }


# ---------------------------------------------------------------------------
# Auto-promote logic
# ---------------------------------------------------------------------------

def _read_prior_version(market: str) -> dict | None:
    """Read the current_version.json pointer for a market. Returns None if absent."""
    pointer_path = MODELS_DIR / market / "artifacts" / "current_version.json"
    if not pointer_path.exists():
        return None
    try:
        with open(pointer_path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _promote_version(market: str, version_ts: str, new_metrics: dict) -> None:
    """Write current_version.json to point to the new version."""
    pointer_path = MODELS_DIR / market / "artifacts" / "current_version.json"
    pointer = {
        "version": version_ts,
        "promoted_at": datetime.now(timezone.utc).isoformat(),
        "artifact_dir": str(MODELS_DIR / market / "artifacts" / f"v{version_ts}"),
        "clv_pct": new_metrics.get("clv", {}).get("mean_clv_pct"),
        "log_loss": new_metrics.get("holdout_2024", {}).get("log_loss_new_model"),
        "best_roi_pct": new_metrics.get("best_roi_pct"),
    }
    with open(pointer_path, "w") as f:
        json.dump(pointer, f, indent=2, default=str)
    log.info(f"  [{market}] Promoted to version {version_ts}")


def should_promote(
    market: str,
    new_metrics: dict,
    prior_version: dict | None,
    prior_metrics: dict | None,
    force_promote_no_prior: bool = False,
) -> tuple[bool, str]:
    """
    Auto-promote decision per task spec:
      Promote if: delta_CLV > +0.1 AND log_loss didn't regress.

    Returns (should_promote: bool, reason: str).

    Null-prior behavior (changed 2026-04-24 per pick-scope-gate proposal #4;
    see docs/improvement-pipeline/pick-scope-gate-2026-04-24.md):
      - Default: do NOT auto-promote. Retrain writes the artifact non-destructively
        to v<ts>/ and leaves current_version.json untouched. Operator runs
        worker/models/retrain/promote.py to promote after reviewing metrics.
      - force_promote_no_prior=True: permits promotion on null-prior, EXCEPT when
        lgbm_best_iteration == 1 (LightGBM found no split — this is the bug that
        shipped moneyline-b2-v3 on 2026-04-23; never promote by automation).

    Rationale for thresholds:
      - +0.1% CLV delta: B2 backtested at ~0.0% CLV (mixed signal). Any measured
        improvement in a live window requires a conservative bar before overwriting
        a working model. +0.1% is 1/5 of the B2 viability threshold (+0.5%).
      - No log_loss regression: ensures calibration hasn't degraded even if
        the new model shows better CLV (CLV can spike on a small sample).
    """
    new_clv = (new_metrics.get("clv") or {}).get("mean_clv_pct") or 0.0
    new_ll = (new_metrics.get("holdout_2024") or {}).get("log_loss_new_model")
    new_best_iter = new_metrics.get("lgbm_best_iteration")

    if new_ll is None:
        return False, "New model log_loss not available (training error)"

    # Variance-collapse guardrail (P7, 2026-04-24) — refuse promote regardless
    # of prior state or CLV/log-loss thresholds. Symmetric with promote.py's
    # lgbm_best_iteration <= 1 refusal; generalizes via the summary flag so
    # any of the three collapse signals (best_iter, nonzero_delta_rate,
    # delta_std) short-circuits auto-promote.
    if new_metrics.get("variance_collapsed"):
        reasons = new_metrics.get("variance_collapse_reasons") or []
        detail = "; ".join(reasons) if reasons else "flag set without reasons"
        return False, f"Variance-collapsed artifact — refusing to auto-promote. {detail}"

    if prior_version is None or prior_metrics is None:
        if not force_promote_no_prior:
            return False, (
                "No prior version — first-train, awaiting manual sign-off. "
                "Run `python -m worker.models.retrain.promote "
                f"--market {market} --timestamp <ts>` to activate, "
                "or re-invoke retrain with --force-promote-no-prior --yes."
            )
        if new_best_iter is not None and new_best_iter <= 1:
            return False, (
                f"Rejected even with --force-promote-no-prior: "
                f"lgbm_best_iteration={new_best_iter} (<= 1) — model found no "
                "useful split. This is the moneyline-b2-v3 failure mode."
            )
        return True, (
            "No prior version — promoted under explicit --force-promote-no-prior "
            f"override (lgbm_best_iteration={new_best_iter})"
        )

    prior_clv = (prior_metrics.get("clv") or {}).get("mean_clv_pct") or 0.0
    prior_ll = (prior_metrics.get("holdout_2024") or {}).get("log_loss_new_model")

    if prior_ll is None:
        # Prior artifact exists but its metrics.json lacks log_loss_new_model —
        # this happens when the prior was written by train_b2_delta.train_b2_market
        # (the pre-monthly.py training path). Without a comparable log_loss we
        # can't enforce the no-regression gate, so fall back to the null-prior
        # policy: refuse auto-promote, require manual sign-off via promote.py.
        # Pre-fix behavior here was "auto-promote because no prior log_loss" —
        # that silently bypassed the gate and allowed moneyline-b2-v3 (the
        # iter-1 passthrough) to ship without comparative evidence.
        if not force_promote_no_prior:
            return False, (
                "Prior model log_loss not recorded (stale-schema prior) — "
                "awaiting manual sign-off. Run `python -m worker.models.retrain.promote "
                f"--market {market} --timestamp <ts>` to activate, "
                "or re-invoke retrain with --force-promote-no-prior --yes."
            )
        if new_best_iter is not None and new_best_iter <= 1:
            return False, (
                f"Rejected even with --force-promote-no-prior: "
                f"lgbm_best_iteration={new_best_iter} (<= 1) — model found no "
                "useful split. This is the moneyline-b2-v3 failure mode."
            )
        return True, (
            "Prior log_loss missing; promoted under explicit "
            f"--force-promote-no-prior override (lgbm_best_iteration={new_best_iter})"
        )

    clv_delta = new_clv - prior_clv
    ll_delta = new_ll - prior_ll  # positive = regression

    if clv_delta > PROMOTE_MIN_CLV_DELTA_PCT and ll_delta <= PROMOTE_MAX_LOGLOSS_REGRESSION:
        return True, (
            f"CLV delta={clv_delta:+.3f}% > {PROMOTE_MIN_CLV_DELTA_PCT}%, "
            f"log_loss delta={ll_delta:+.5f} (no regression)"
        )

    reasons = []
    if clv_delta <= PROMOTE_MIN_CLV_DELTA_PCT:
        reasons.append(f"CLV delta={clv_delta:+.3f}% <= threshold {PROMOTE_MIN_CLV_DELTA_PCT}%")
    if ll_delta > PROMOTE_MAX_LOGLOSS_REGRESSION:
        reasons.append(f"log_loss regression: new={new_ll:.5f} vs prior={prior_ll:.5f}")
    return False, "; ".join(reasons)


# ---------------------------------------------------------------------------
# Main retrain loop
# ---------------------------------------------------------------------------

def run_retrain(
    dry_run: bool = False,
    offline: bool = False,
    force_promote_no_prior: bool = False,
    assume_yes: bool = False,
) -> dict:
    """
    Full monthly retrain run. Returns summary dict.

    dry_run=True: trains and evaluates but does NOT write current_version.json.
    offline=True: skips all Supabase calls; uses existing parquet only (local dev/CI).
    force_promote_no_prior=True: allows auto-promote on null-prior (still refuses
      if lgbm_best_iteration <= 1). Ignored unless assume_yes=True as well.
    assume_yes=True: skips the interactive confirm for --force-promote-no-prior.
    """
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    log.info(f"=== Diamond Edge Monthly Retrain ===")
    log.info(f"Timestamp: {ts}")
    log.info(f"Dry run: {dry_run} | Offline: {offline}")
    t_start = time.time()

    # --- Connect to Supabase (skipped in offline mode) ---
    supabase = None
    pick_outcomes = pd.DataFrame()

    if not offline:
        supabase = _get_supabase_client()
        pick_outcomes = pull_pick_outcomes_from_supabase(supabase)
    else:
        log.info("Offline mode: no Supabase connection, pick_outcomes evaluation skipped")

    # --- Rebuild training parquet ---
    retrain_parquet = DATA_DIR / f"games_b2_retrain_{ts}.parquet"
    df = rebuild_training_parquet(supabase, retrain_parquet, offline=offline)
    log.info(f"Training data: {len(df)} rows, {len(df.columns)} columns")

    # --- Feature list (B2 + news features) ---
    from worker.models.pipelines.train_b2_delta import B2_NEW_FEATURES, get_b2_moneyline_features
    from worker.models.pipelines.train_models import RUN_LINE_FEATURES, TOTALS_FEATURES

    ml_features = get_b2_moneyline_features() + NEWS_FEATURES
    rl_features = list(RUN_LINE_FEATURES) + B2_NEW_FEATURES + NEWS_FEATURES
    if "market_novig_rl_prior_morning" not in rl_features:
        rl_features.append("market_novig_rl_prior_morning")
    tot_features = list(TOTALS_FEATURES) + B2_NEW_FEATURES + NEWS_FEATURES
    if "market_novig_over_prior_morning" not in tot_features:
        tot_features.append("market_novig_over_prior_morning")

    # --- Train all three markets ---
    MARKET_CONFIGS = [
        {
            "market": "moneyline",
            "target_col": "y_delta_ml",
            "prior_col": "market_novig_prior_morning",
            "primary_odds_cols": ("dk_ml_home", "fd_ml_home"),
            "opposing_odds_cols": ("dk_ml_away", "fd_ml_away"),
            "closing_novig_col": "market_novig_closing_evening",
            "feature_cols": ml_features,
        },
        {
            "market": "run_line",
            "target_col": "y_delta_rl",
            "prior_col": "market_novig_rl_prior_morning",
            "primary_odds_cols": ("dk_rl_home_price", "fd_rl_home_price"),
            "opposing_odds_cols": ("dk_rl_away_price", "fd_rl_away_price"),
            "closing_novig_col": "novig_rl_home_evening",
            "feature_cols": rl_features,
        },
        {
            "market": "totals",
            "target_col": "y_delta_tot",
            "prior_col": "market_novig_over_prior_morning",
            "primary_odds_cols": ("dk_over_price", "fd_over_price"),
            "opposing_odds_cols": ("dk_under_price", "fd_under_price"),
            "closing_novig_col": "novig_over_evening",
            "feature_cols": tot_features,
        },
    ]

    all_new_metrics: dict = {}
    all_prior_metrics: dict = {}
    promote_decisions: dict = {}
    pending_signoff: list[str] = []

    effective_force = force_promote_no_prior and assume_yes
    if force_promote_no_prior and not assume_yes:
        log.warning(
            "--force-promote-no-prior passed without --yes — treating as dry "
            "(null-prior markets will be flagged pending manual sign-off)."
        )

    for cfg in MARKET_CONFIGS:
        market = cfg["market"]
        target_col = cfg["target_col"]

        # Check coverage
        coverage = df[target_col].notna().sum() if target_col in df.columns else 0
        if coverage < 1000:
            log.warning(f"  {market}: insufficient coverage ({coverage} rows) — skipping")
            all_new_metrics[market] = {"market": market, "skipped": True, "reason": f"coverage={coverage}"}
            promote_decisions[market] = (False, f"Skipped — coverage={coverage}")
            continue

        version_dir = MODELS_DIR / market / "artifacts" / f"v{ts}"
        new_metrics, model_obj = train_market_versioned(
            market=market,
            df=df,
            feature_cols=cfg["feature_cols"],
            target_col=target_col,
            prior_col=cfg["prior_col"],
            primary_odds_cols=cfg["primary_odds_cols"],
            opposing_odds_cols=cfg["opposing_odds_cols"],
            closing_novig_col=cfg["closing_novig_col"],
            version_dir=version_dir,
        )
        all_new_metrics[market] = new_metrics

        # Load prior version metrics for comparison
        prior_version = _read_prior_version(market)
        prior_metrics: dict | None = None
        if prior_version and "artifact_dir" in prior_version:
            prior_report_path = Path(prior_version["artifact_dir"]) / "metrics.json"
            if prior_report_path.exists():
                with open(prior_report_path) as f:
                    prior_metrics = json.load(f)
        all_prior_metrics[market] = prior_metrics

        # Write metrics to version dir
        with open(version_dir / "metrics.json", "w") as f:
            json.dump(new_metrics, f, indent=2, default=str)

        # Auto-promote decision
        promote, reason = should_promote(
            market,
            new_metrics,
            prior_version,
            prior_metrics,
            force_promote_no_prior=effective_force,
        )
        promote_decisions[market] = (promote, reason)
        log.info(f"  [{market}] Auto-promote: {'YES' if promote else 'NO'} — {reason}")

        # Flag for manual sign-off when retrain refuses auto-promote because
        # prior comparison was not possible — either no prior exists at all,
        # or the prior's metrics.json lacks the log_loss field needed for the
        # no-regression gate (stale-schema case, e.g., artifacts written by
        # train_b2_delta.train_b2_market before monthly.py was introduced).
        prior_log_loss = (prior_metrics or {}).get("holdout_2024", {}).get("log_loss_new_model")
        unevaluable_prior = (
            prior_version is None
            or prior_metrics is None
            or prior_log_loss is None
        )
        if unevaluable_prior and not promote:
            pending_signoff.append(market)

        if promote and not dry_run and model_obj is not None:
            _promote_version(market, ts, new_metrics)

    # --- Live picks evaluation (last 90 days) ---
    live_eval: dict = {}
    for market in ["moneyline", "run_line", "totals"]:
        live_eval[market] = evaluate_live_picks(pick_outcomes, market)

    # --- Write summary report ---
    summary = {
        "retrain_timestamp": ts,
        "dry_run": dry_run,
        "wall_time_seconds": round(time.time() - t_start, 1),
        "training_data": {
            "parquet_path": str(retrain_parquet),
            "rows": len(df),
            "news_signal_rows": int((df.get("news_signal_count", pd.Series([0.0])) > 0).sum()),
        },
        "new_model_metrics": all_new_metrics,
        "prior_model_metrics": {
            m: v for m, v in all_prior_metrics.items()
        },
        "promote_decisions": {
            m: {"promote": v[0], "reason": v[1]}
            for m, v in promote_decisions.items()
        },
        "live_picks_last_90d": live_eval,
        "auto_promote_thresholds": {
            "min_clv_delta_pct": PROMOTE_MIN_CLV_DELTA_PCT,
            "max_log_loss_regression": PROMOTE_MAX_LOGLOSS_REGRESSION,
        },
        "pending_manual_signoff": {
            "markets": pending_signoff,
            "note": (
                "first-train, awaiting sign-off; run `python -m "
                "worker.models.retrain.promote --market <market> --timestamp "
                f"{ts}` after reviewing metrics.json to activate."
            ) if pending_signoff else "none",
        },
        "force_promote_no_prior": force_promote_no_prior,
        "assume_yes": assume_yes,
    }

    report_dir = REPORTS_DIR / ts
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "summary.json"
    with open(report_path, "w") as f:
        json.dump(summary, f, indent=2, default=str)

    log.info(f"\nRetrain complete. Wall time: {summary['wall_time_seconds']:.0f}s")
    log.info(f"Report: {report_path}")

    for market, (promote, reason) in promote_decisions.items():
        clv = (all_new_metrics.get(market, {}).get("clv") or {}).get("mean_clv_pct") or "N/A"
        roi = all_new_metrics.get(market, {}).get("best_roi_pct") or "N/A"
        log.info(f"  {market}: CLV={clv}% | best ROI={roi}% | promote={promote} | {reason}")

    if pending_signoff:
        log.warning(
            "PENDING MANUAL SIGN-OFF (%d market(s)): %s. Review %s and run "
            "`python -m worker.models.retrain.promote --market <m> --timestamp %s` "
            "to activate.",
            len(pending_signoff),
            ", ".join(pending_signoff),
            report_path,
            ts,
        )

    return summary


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Diamond Edge monthly retrain pipeline")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Train and evaluate but do NOT promote (write current_version.json)",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help=(
            "Skip all Supabase calls; use existing games_b2.parquet only. "
            "For local dev / CI dry-runs without Supabase credentials."
        ),
    )
    parser.add_argument(
        "--force-promote-no-prior",
        action="store_true",
        help=(
            "Permit auto-promote on null-prior markets. Still refuses if "
            "lgbm_best_iteration <= 1. Requires --yes."
        ),
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip confirmation prompts; required alongside --force-promote-no-prior.",
    )
    args = parser.parse_args()

    summary = run_retrain(
        dry_run=args.dry_run,
        offline=args.offline,
        force_promote_no_prior=args.force_promote_no_prior,
        assume_yes=args.yes,
    )

    # Exit non-zero if any market had a training error
    errors = [
        m for m, v in summary["new_model_metrics"].items()
        if isinstance(v, dict) and "error" in v
    ]
    if errors:
        log.error(f"Training errors in markets: {errors}")
        sys.exit(1)

    # Exit code 2 signals "training OK but manual sign-off required" — distinct
    # from training failure (exit 1) and clean-pass (exit 0). Callers that wrap
    # the retrain (cron, CI) should surface this to operators.
    pending = summary.get("pending_manual_signoff", {}).get("markets") or []
    if pending:
        log.warning(f"Exiting 2 — pending manual sign-off for markets: {pending}")
        sys.exit(2)


if __name__ == "__main__":
    main()
