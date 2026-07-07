"""
main.py — Stock Data Features Service
Standalone FastAPI microservice for calculating technical indicators.
Triggered via POST /features/calculate from stock-data-node or manually.
"""
from __future__ import annotations

import json
import logging
import multiprocessing
import os
import re
import sys
from pathlib import Path

from typing import Optional

import numpy as np
import pandas as pd

import uvicorn
from fastapi import FastAPI, status
from fastapi.responses import JSONResponse, StreamingResponse

# ─── Bootstrap: ensure src/ is on the path ──────────────────────
sys.path.insert(0, str(Path(__file__).parent))

from calculator import TechnicalCalculator
from config_parser import FeatureConfigParser, ProcessingContext, FeatureType
from parquet_io import ParquetStorage
from processor import FeatureProcessor
from job_manager import JobManager
from schemas import MARequest, RSRequest, MinerviniRequest, ClusterRequest
from cluster import calculate_correlation_clusters
from logging_setup import configure_logging


# ─── Config ──────────────────────────────────────────────────────

logger = logging.getLogger(__name__)

BASE_DIR = Path(os.environ.get("APP_BASE_DIR", Path(__file__).parent.parent))
CONFIG_DIR = str(BASE_DIR / "config")
LOG_DIR = str(BASE_DIR / "logs")
DATA_DIR = str(BASE_DIR / "data" / "parquet")
WATCHLISTS_DIR = str(BASE_DIR / "data" / "watchlists")
API_PORT = int(os.environ.get("FEATURES_API_PORT", "8003"))


def _load_settings() -> dict:
    """Load settings.json for processing_threads etc."""
    settings_path = Path(CONFIG_DIR) / "settings.json"
    if settings_path.exists():
        with open(settings_path, "r") as f:
            return json.load(f)
    return {}


# ─── Feature Pipeline Runner ────────────────────────────────────

def run_feature_pipeline(log_queue: Optional[multiprocessing.Queue] = None, priority: Optional[str] = None) -> None:
    """Runs the full feature calculation pipeline (blocking).
    If priority is set, that ticker is processed first and an MQTT event is published."""
    # Import inside to ensure availability in background threads and avoid name collisions/shadowing
    from config_parser import FeatureConfigParser, ProcessingContext
    from calculator import TechnicalCalculator
    from parquet_io import ParquetStorage
    from processor import FeatureProcessor

    config_parser = FeatureConfigParser(str(Path(CONFIG_DIR) / "features.json"))
    features = config_parser.parse()

    if not features:
        logger.info("ℹ️  No features defined in features.json. Skipping.")
        return

    settings = _load_settings()
    thread_count = settings.get("processing_threads", 4)

    ctx = ProcessingContext(
        thread_count=thread_count,
        data_dir=DATA_DIR,
        timeframes=["1D"],
        features=features,
    )

    storage = ParquetStorage(ctx.data_dir)
    raw_tickers = storage.get_available_tickers()

    if not raw_tickers:
        logger.info("ℹ️  No data available yet. Skipping feature calculation.")
        return

    # Pre-filter to exclude tickers missing the required parquet files
    valid_tickers = []
    base_dir = Path(ctx.data_dir)
    for t in raw_tickers:
        if all((base_dir / t / f"{tf}.parquet").exists() for tf in ctx.timeframes):
            valid_tickers.append(t)
            
    skipped = len(raw_tickers) - len(valid_tickers)
    if skipped > 0:
        logger.info("ℹ️  Skipped %d tickers without complete source files.", skipped)
        
    tickers = valid_tickers

    if not tickers:
        logger.info("ℹ️  No valid tickers with data found. Skipping.")
        return

    logger.info(
        "▶️  Calculating features for %d ticker(s) with %d thread(s)...",
        len(tickers),
        ctx.thread_count,
    )

    calculator = TechnicalCalculator()
    processor = FeatureProcessor(ctx, storage, calculator)
    results = processor.process_all_tickers(tickers, priority=priority, log_queue=log_queue)
    success_count = sum(1 for r in results if r.success)
    logger.info("✅ Feature calculation finished: %d/%d successful", success_count, len(results))


# ─── FastAPI App ─────────────────────────────────────────────────

def create_app() -> FastAPI:
    app = FastAPI(
        title="Stock Data Features API",
        description="Technical indicator calculation service.",
        version="1.0.0",
    )

    job_manager = JobManager()
    storage = ParquetStorage(DATA_DIR)

    @app.post("/features/calculate")
    async def trigger_feature_calculation(stream: bool = False, priority: str = None):
        """
        Triggers the feature calculation process.
        Returns 202 if started, 409 if already running. (F-API-010, F-SYS-030)
        If stream=True, returns a StreamingResponse with real-time logs.
        If priority is set, that ticker is processed first.
        """
        if stream:
            return StreamingResponse(
                job_manager.stream_feature_calculation(run_feature_pipeline, priority=priority),
                media_type="text/plain",
            )

        success = job_manager.start_feature_calculation(run_feature_pipeline, priority=priority)

        if success:
            return JSONResponse(
                status_code=status.HTTP_202_ACCEPTED,
                content={
                    "status": "Job started in background",
                    "priority": priority,
                    "hint": "Use ?stream=true to see real-time log output",
                },
            )
        else:
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={
                    "status": "Ignored",
                    "detail": "A feature calculation process is already running.",
                },
            )

    @app.post("/features/ma")
    async def calculate_moving_average(req: MARequest):
        """
        On-the-fly moving average calculation for a single ticker.
        Loads OHLCV data, computes the requested MA, returns JSON arrays.
        """
        storage = ParquetStorage(DATA_DIR)
        calculator = TechnicalCalculator()

        # 1. Load source data
        try:
            df = storage.load_ticker_data(req.ticker, req.chart_timeframe)
        except FileNotFoundError:
            return JSONResponse(
                status_code=status.HTTP_404_NOT_FOUND,
                content={
                    "error": f"No data found for ticker '{req.ticker}' "
                             f"with timeframe '{req.chart_timeframe}'",
                },
            )

        if df.empty:
            return JSONResponse(
                status_code=status.HTTP_404_NOT_FOUND,
                content={"error": f"Data for '{req.ticker}' is empty"},
            )

        # 2. Calculate MA using existing calculator engine
        ma_type_enum = FeatureType.EMA if req.ma_type == "EMA" else FeatureType.SMA
        ma_series = calculator._get_ma_series(df, "close", req.ma_window, ma_type_enum)

        # 3. Build response — only timestamp, close, and the computed MA
        timestamps = df["timestamp"].tolist()
        closes = df["close"].tolist()
        ma_values = ma_series.tolist()

        ma_label = f"{req.ma_type.lower()}_{req.ma_window}"

        return {
            "ticker": req.ticker,
            "chart_timeframe": req.chart_timeframe,
            "ma_type": req.ma_type,
            "ma_window": req.ma_window,
            "ma_label": ma_label,
            "data_points": len(timestamps),
            "timestamps": timestamps,
            "close": closes,
            "values": ma_values,
        }

    @app.post("/features/rs")
    async def calculate_rs_rating(req: RSRequest):
        """
        On-the-fly RS Rating calculation.
        - Without benchmark: cross-sectional percentile rank (1-99) vs all tickers.
        - With benchmark:    relative strength of ticker vs benchmark ticker.
        Returns the most recent value.
        """

        storage = ParquetStorage(DATA_DIR)
        calculator = TechnicalCalculator()

        # 1. Load ticker data
        try:
            df_ticker = storage.load_ticker_data(req.ticker, req.chart_timeframe)
        except FileNotFoundError:
            return JSONResponse(
                status_code=status.HTTP_404_NOT_FOUND,
                content={"error": f"No data found for ticker '{req.ticker}'"},
            )

        if len(df_ticker) < 63:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"error": f"Not enough data for '{req.ticker}' (need >= 63 rows, have {len(df_ticker)})"},
            )

        # ── Mode A: vs specific benchmark ticker ──────────────────
        if req.benchmark is not None:
            try:
                df_bench = storage.load_ticker_data(req.benchmark, req.chart_timeframe)
            except FileNotFoundError:
                return JSONResponse(
                    status_code=status.HTTP_404_NOT_FOUND,
                    content={"error": f"No data found for benchmark '{req.benchmark}'"},
                )

            if len(df_bench) < 63:
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={"error": f"Not enough data for benchmark '{req.benchmark}' (need >= 63, have {len(df_bench)})"},
                )

            ticker_raw, ticker_comp, _ = calculator.compute_normalized_roc(df_ticker["close"])
            bench_raw, bench_comp, _ = calculator.compute_normalized_roc(df_bench["close"])

            rs_relative = round(ticker_raw - bench_raw, 4)

            return {
                "ticker": req.ticker,
                "benchmark": req.benchmark,
                "mode": "vs_benchmark",
                "ticker_raw_score": ticker_raw,
                "ticker_components": ticker_comp,
                "benchmark_raw_score": bench_raw,
                "benchmark_components": bench_comp,
                "rs_relative": rs_relative,
                "interpretation": "positive = ticker outperforms benchmark",
            }

        # ── Mode B: vs all tickers (cross-sectional rank) ─────────
        all_tickers = storage.get_available_tickers()
        raw_scores: dict[str, float] = {}
        skipped = 0

        for t in all_tickers:
            try:
                df_t = storage.load_ticker_data(t, req.chart_timeframe)
                if len(df_t) >= 63:
                    score, comp, _ = calculator.compute_normalized_roc(df_t["close"])
                    if comp > 0:
                        raw_scores[t] = score
                    else:
                        skipped += 1
                else:
                    skipped += 1
            except Exception:
                skipped += 1
                continue

        if req.ticker not in raw_scores:
            score, comp, _ = calculator.compute_normalized_roc(df_ticker["close"])
            if comp > 0:
                raw_scores[req.ticker] = score

        N = len(raw_scores)
        if N <= 1:
            percentile = 50
        else:
            scores_series = pd.Series(raw_scores)
            ranks = scores_series.rank()
            percentile = int(round(((ranks[req.ticker] - 1) / (N - 1)) * 98 + 1))
            percentile = max(1, min(99, percentile))

        ticker_score = raw_scores.get(req.ticker, 0.0)

        return {
            "ticker": req.ticker,
            "benchmark": None,
            "mode": "vs_all",
            "rs_rating": percentile,
            "raw_score": ticker_score,
            "universe_size": N,
            "skipped_tickers": skipped,
            "interpretation": f"Outperforms {percentile}% of {N} tickers ({skipped} excluded due to insufficient data)",
        }

    @app.post("/features/minervini")
    async def calculate_minervini(req: MinerviniRequest):
        """
        On-the-fly Minervini Trend Template calculation.
        Computes all 8 conditions and returns the latest score.
        """
        storage = ParquetStorage(DATA_DIR)
        calculator = TechnicalCalculator()

        try:
            df = storage.load_ticker_data(req.ticker, req.chart_timeframe)
        except FileNotFoundError:
            return JSONResponse(
                status_code=status.HTTP_404_NOT_FOUND,
                content={"error": f"No data found for ticker '{req.ticker}'"},
            )

        if len(df) < 260:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "error": f"Not enough data for '{req.ticker}' "
                             f"(need >= 260 rows for 52-week analysis, have {len(df)})",
                },
            )

        # --- RS Rating (try to load from pre-computed features) ---
        rs_rating = None
        rs_available = False
        try:
            df_feat = storage.load_ticker_data(req.ticker, f"{req.chart_timeframe}_features")
            if "ibd_rs" in df_feat.columns and len(df_feat) > 0:
                last_rs = df_feat["ibd_rs"].iloc[-1]
                if not pd.isna(last_rs):
                    rs_rating = int(last_rs)
                    rs_available = True
        except Exception:
            pass

        try:
            res = calculator.calculate_minervini_on_the_fly(df, rs_rating)
        except ValueError as e:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"error": str(e)},
            )

        return {
            "ticker": req.ticker,
            "chart_timeframe": req.chart_timeframe,
            **res,
            "rs_rating": rs_rating,
            "rs_available": rs_available,
        }

    # ── Correlation Clustering ────────────────────────────────────
    @app.post("/features/cluster")
    async def cluster_tickers(req: ClusterRequest):
        """
        Compute correlation-based clusters and write them as watchlists to Supabase.
        Deletes all existing cluster_* watchlists, then inserts the new ones.
        """
        import httpx

        postgrest_url = os.environ.get("POSTGREST_URL", "http://postgrest:3000")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }

        # 1. Resolve ticker list
        if req.source_watchlist:
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.get(
                        f"{postgrest_url}/pca_watchlists",
                        params={
                            "list_name": f"eq.{req.source_watchlist}",
                            "select": "ticker",
                            "order": "position.asc",
                        },
                        headers=headers,
                    )
                    resp.raise_for_status()
                    tickers = [r["ticker"] for r in resp.json()]
            except Exception as e:
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={"error": f"Failed to load watchlist '{req.source_watchlist}': {e}"},
                )
        else:
            tickers = storage.get_available_tickers()

        if not tickers:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"error": "No tickers available for clustering."},
            )

        # 2. Run clustering
        try:
            clusters = calculate_correlation_clusters(
                storage, tickers, req.lookback_days, req.num_clusters
            )
        except ValueError as e:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"error": str(e)},
            )

        # 3. Write to Supabase: delete old cluster_* lists, insert new ones
        try:
            async with httpx.AsyncClient() as client:
                # Delete all existing cluster_ watchlists
                await client.delete(
                    f"{postgrest_url}/pca_watchlists",
                    params={"list_name": "like.cluster_*"},
                    headers=headers,
                )

                # Insert new cluster watchlists
                rows = []
                for cluster_id, cluster_tickers_list in sorted(clusters.items()):
                    list_name = f"cluster_{cluster_id}"
                    for pos, ticker in enumerate(sorted(cluster_tickers_list)):
                        rows.append({
                            "list_name": list_name,
                            "ticker": ticker,
                            "position": pos,
                        })

                # Batch insert in chunks of 500 to stay within PostgREST limits
                chunk_size = 500
                for i in range(0, len(rows), chunk_size):
                    chunk = rows[i : i + chunk_size]
                    resp = await client.post(
                        f"{postgrest_url}/pca_watchlists",
                        json=chunk,
                        headers=headers,
                    )
                    resp.raise_for_status()

        except Exception as e:
            return JSONResponse(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                content={"error": f"Failed to write clusters to Supabase: {e}"},
            )

        # 4. Build response summary
        summary = {
            "clusters": len(clusters),
            "tickers_total": sum(len(v) for v in clusters.values()),
            "lookback_days": req.lookback_days,
            "source": req.source_watchlist or "all",
            "groups": {f"cluster_{k}": v for k, v in sorted(clusters.items())},
        }

        return summary

    @app.get("/status")
    async def get_status() -> dict:
        """Returns whether a feature calculation is currently running."""
        return {"is_running": job_manager.is_running}

    @app.get("/health")
    async def health_check() -> dict:
        """Simple liveness probe for Docker health checks."""
        return {"status": "ok"}

    return app


# ─── Entrypoint ──────────────────────────────────────────────────

def main() -> None:
    configure_logging(LOG_DIR)

    logger.info("═══════════════════════════════════════════════════════════════")
    logger.info("  Stock Data Features Service — starting up")
    logger.info("═══════════════════════════════════════════════════════════════")
    logger.info("ℹ️  Config dir: %s", CONFIG_DIR)
    logger.info("ℹ️  Data dir:   %s", DATA_DIR)
    logger.info("ℹ️  API port:   %d", API_PORT)

    app = create_app()

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=API_PORT,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
