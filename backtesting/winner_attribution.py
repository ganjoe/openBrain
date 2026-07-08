"""
Backtesting Engine – Winner Attribution.

Determines which ticker-level features (computed from local Parquet OHLCV data)
are associated with profitable vs. unprofitable backtest outcomes.

Distinct from `cluster.calculate_correlation_clusters` (which does Pearson
correlation on daily returns for watchlist grouping). This module answers a
different question: given a finished backtest run, what made the winners win?

Features (per ticker, computed from the Parquet file in isolation):
    - avg_volume_20d     : mean daily volume, last 20 bars
    - atr_pct            : mean daily True Range as % of close, last 20 bars
    - price_level        : most recent close
    - vol_of_vol         : std of daily returns, last 20 bars
    - adx_proxy          : mean |EMA_fast - EMA_slow| / close, last 50 bars
    - setup_density      : count of N-higher-low setups per 252 bars

Performance (per ticker, aggregated from bt_trades):
    - n_trades
    - win_rate
    - avg_r_multiple
    - total_pnl
    - profit_factor
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

try:
    from .data_loader import load_ohlcv
except ImportError:  # pragma: no cover
    from data_loader import load_ohlcv


PERF_COLS = ["win_rate", "avg_r_multiple", "total_pnl"]
FEATURE_COLS = [
    "avg_volume_20d",
    "atr_pct",
    "price_level",
    "vol_of_vol",
    "adx_proxy",
    "setup_density",
]


def _safe_float(x: Any) -> float | None:
    try:
        if x is None:
            return None
        f = float(x)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def _compute_ticker_features(ticker: str, lookback: int = 252) -> dict[str, float | None]:
    """
    Compute stock-level features from the local Parquet file.
    Returns a dict with NaN-safe floats. Missing file → all None.
    """
    try:
        df = load_ohlcv(ticker)
    except FileNotFoundError:
        return {"ticker": ticker, **{c: None for c in FEATURE_COLS}}

    if df is None or len(df) < 30:
        return {"ticker": ticker, **{c: None for c in FEATURE_COLS}}

    df = df.tail(lookback).copy()
    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df["volume"]

    # avg_volume_20d
    avg_vol_20 = volume.rolling(20, min_periods=1).mean().iloc[-1]
    # atr_pct (mean true range as % of close, last 20 bars)
    prev_close = close.shift(1)
    tr = pd.concat(
        [
            (high - low),
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    atr_pct = (tr / close).rolling(20, min_periods=1).mean().iloc[-1] * 100.0
    # price_level
    px = close.iloc[-1]
    # vol_of_vol (std of daily returns, last 20 bars)
    rets = close.pct_change()
    vol_of_vol = rets.rolling(20, min_periods=2).std().iloc[-1]
    # adx_proxy: |EMA(14) - EMA(18)| / close
    ema_fast = close.ewm(span=14, adjust=False).mean()
    ema_slow = close.ewm(span=18, adjust=False).mean()
    adx = ((ema_fast - ema_slow).abs() / close).rolling(50, min_periods=1).mean().iloc[-1] * 100.0
    # setup_density: count of N=4 higher-lows setups in the lookback window
    lows_arr = low.values
    n = 4
    setups = 0
    for i in range(n, len(lows_arr)):
        window = lows_arr[i - n: i + 1]
        if all(window[j] > window[j - n] for j in range(n)):
            setups += 1
    setup_density = setups / max(len(lows_arr) - n, 1) * 100.0

    return {
        "ticker": ticker,
        "avg_volume_20d": _safe_float(avg_vol_20),
        "atr_pct": _safe_float(atr_pct),
        "price_level": _safe_float(px),
        "vol_of_vol": _safe_float(vol_of_vol),
        "adx_proxy": _safe_float(adx),
        "setup_density": _safe_float(setup_density),
    }


def _aggregate_trades(trades: list[dict]) -> pd.DataFrame:
    """
    Aggregate raw trade rows into per-ticker performance metrics.
    Empty input → empty DataFrame with the expected columns.
    """
    if not trades:
        return pd.DataFrame(columns=["ticker", "n_trades", *PERF_COLS, "profit_factor"])

    df = pd.DataFrame(trades)
    rows = []
    for ticker, g in df.groupby("ticker"):
        n = len(g)
        wins = (g["pnl"] > 0).sum()
        gross_profit = g.loc[g["pnl"] > 0, "pnl"].sum()
        gross_loss = abs(g.loc[g["pnl"] < 0, "pnl"].sum())
        pf = (gross_profit / gross_loss) if gross_loss > 0 else float("inf")
        rows.append(
            {
                "ticker": ticker,
                "n_trades": n,
                "win_rate": (wins / n) * 100.0 if n else 0.0,
                "avg_r_multiple": float(g["r_multiple"].mean()) if "r_multiple" in g else 0.0,
                "total_pnl": float(g["pnl"].sum()),
                "profit_factor": pf,
            }
        )
    return pd.DataFrame(rows)


def _spearman(series_x: pd.Series, series_y: pd.Series) -> tuple[float | None, float | None]:
    """Spearman rank correlation (rho, p-value) with NaN/constant safety.
    Implemented manually via rank-transform + Pearson to avoid a scipy
    dependency (pandas.corr(method='spearman') requires scipy in pandas 3.x)."""
    s = pd.concat([series_x, series_y], axis=1).dropna()
    if len(s) < 3:
        return None, None
    x = s.iloc[:, 0]
    y = s.iloc[:, 1]
    if x.nunique() < 2 or y.nunique() < 2:
        return None, None
    rx = x.rank(method="average")
    ry = y.rank(method="average")
    rho = rx.corr(ry)  # default = Pearson on ranks
    if rho is None or pd.isna(rho):
        return None, None
    rho = float(rho)
    n = len(s)
    if abs(rho) >= 1.0:
        pval = 0.0
    else:
        try:
            from statistics import NormalDist
            t = rho * math.sqrt((n - 2) / (1 - rho * rho))
            pval = 2.0 * (1.0 - NormalDist().cdf(abs(t)))
        except Exception:
            pval = None
    return rho, pval


def _group_comparison(merged: pd.DataFrame, target: str) -> dict[str, Any]:
    """
    Split the merged table by median of `target` and compare feature means
    between the upper and lower halves. Returns per-feature dict.
    """
    if target not in merged.columns or len(merged) < 4:
        return {}

    median = merged[target].median()
    upper = merged[merged[target] >= median]
    lower = merged[merged[target] < median]

    out: dict[str, Any] = {
        "split_column": target,
        "split_value_median": _safe_float(median),
        "upper_half": sorted(upper["ticker"].tolist()),
        "lower_half": sorted(lower["ticker"].tolist()),
        "features": {},
    }
    for f in FEATURE_COLS:
        if f not in merged.columns:
            continue
        u = upper[f].dropna()
        l = lower[f].dropna()
        out["features"][f] = {
            "upper_mean": _safe_float(u.mean()) if len(u) else None,
            "lower_mean": _safe_float(l.mean()) if len(l) else None,
            "upper_median": _safe_float(u.median()) if len(u) else None,
            "lower_median": _safe_float(l.median()) if len(l) else None,
            "ratio_upper_over_lower": (
                _safe_float(u.mean() / l.mean())
                if (len(u) and len(l) and l.mean() not in (0, None))
                else None
            ),
        }
    return out


def attribute_winner_performance(supabase_client, run_id: int) -> dict[str, Any]:
    """
    Main entry point. For a given bt_runs.run_id:
      1. Load trades from bt_trades.
      2. Aggregate per-ticker performance.
      3. Compute per-ticker features from local Parquet.
      4. Join and compute Spearman (feature, performance) pairs.
      5. Median-split on the headline performance metric and compare features
         between upper/lower halves.

    Returns a JSON-serialisable dict that the LLM can interpret directly.
    """
    # 1. Fetch run + trades
    try:
        run_row = (
            supabase_client.table("bt_runs")
            .select("run_id,config_id,total_trades,win_rate,total_pnl")
            .eq("run_id", run_id)
            .single()
            .execute()
        )
    except Exception as e:
        return {"error": f"bt_runs lookup failed: {e}"}
    if not run_row.data:
        return {"error": f"run_id={run_id} not found in bt_runs"}

    trades = (
        supabase_client.table("bt_trades")
        .select("ticker,entry_date,exit_date,entry_price,exit_price,pnl,r_multiple,exit_reason")
        .eq("run_id", run_id)
        .execute()
        .data
        or []
    )

    if not trades:
        return {
            "error": f"run_id={run_id} has no trades in bt_trades — cannot attribute winners.",
            "run_id": run_id,
        }

    # 2. Per-ticker performance
    perf = _aggregate_trades(trades)

    # 3. Per-ticker features
    feat_rows = [_compute_ticker_features(t) for t in perf["ticker"].tolist()]
    feat_df = pd.DataFrame(feat_rows)

    # 4. Join
    merged = perf.merge(feat_df, on="ticker", how="left")

    # 5. Spearman matrix
    attributions: dict[str, dict[str, Any]] = {}
    for f in FEATURE_COLS:
        if f not in merged.columns:
            continue
        attributions[f] = {}
        for p in PERF_COLS:
            if p not in merged.columns:
                continue
            rho, pval = _spearman(merged[f], merged[p])
            attributions[f][p] = {
                "spearman_rho": _safe_float(rho),
                "p_value": _safe_float(pval),
                "n": int(merged[[f, p]].dropna().shape[0]),
            }

    # 6. Median split on total_pnl
    group_split = _group_comparison(merged, "total_pnl")

    # 7. Headline interpretation hints (let the LLM write the prose)
    strongest: list[dict[str, Any]] = []
    for f, perf_map in attributions.items():
        for p, stats in perf_map.items():
            rho = stats.get("spearman_rho")
            if rho is None:
                continue
            strongest.append({"feature": f, "metric": p, "rho": rho, "p": stats.get("p_value")})
    strongest.sort(key=lambda x: abs(x["rho"]), reverse=True)

    n_tickers = len(merged)
    warning = None
    if n_tickers < 8:
        warning = (
            f"Only {n_tickers} tickers in this run — Spearman results are NOT "
            f"statistically meaningful. Treat as exploratory only."
        )
    elif n_tickers < 15:
        warning = (
            f"{n_tickers} tickers is borderline for Spearman inference. "
            f"Use p-values strictly; consider collecting more data."
        )

    return {
        "run_id": run_id,
        "config_id": run_row.data.get("config_id"),
        "n_tickers": n_tickers,
        "n_trades": len(trades),
        "headline_metrics": {
            "total_pnl_sum": _safe_float(merged["total_pnl"].sum()),
            "win_rate_mean": _safe_float(merged["win_rate"].mean()),
            "avg_r_multiple_mean": _safe_float(merged["avg_r_multiple"].mean()),
        },
        "per_ticker_performance": [
            {
                "ticker": r["ticker"],
                "n_trades": int(r["n_trades"]),
                "win_rate": _safe_float(r["win_rate"]),
                "avg_r_multiple": _safe_float(r["avg_r_multiple"]),
                "total_pnl": _safe_float(r["total_pnl"]),
                "profit_factor": (
                    _safe_float(r["profit_factor"])
                    if (r["profit_factor"] != float("inf"))
                    else 9999.0
                ),
            }
            for _, r in merged.iterrows()
        ],
        "per_ticker_features": [
            {k: _safe_float(v) if k != "ticker" else v for k, v in row.items()}
            for row in feat_rows
        ],
        "attributions": attributions,  # Spearman(feature, perf_metric) → rho, p, n
        "winner_vs_loser_split": group_split,  # median-split on total_pnl
        "strongest_associations": strongest[:6],  # top 6 by |rho|
        "warning": warning,
    }


if __name__ == "__main__":
    # Manual smoke test: requires a valid SUPABASE_URL / SERVICE_ROLE_KEY in env.
    try:
        from config import get_supabase_client
    except Exception:
        import sys, os
        sys.path.append(os.path.dirname(__file__))
        from config import get_supabase_client
    import json

    client = get_supabase_client()
    res = (
        client.table("bt_runs")
        .select("run_id,status,total_trades")
        .eq("status", "completed")
        .order("run_id", desc=True)
        .limit(1)
        .execute()
    )
    if not res.data:
        print("No completed bt_runs found.")
    else:
        rid = res.data[0]["run_id"]
        print(f"Latest completed run: {rid}")
        print(json.dumps(attribute_winner_performance(client, rid), indent=2, default=str))
