"""
chart_data.py — DuckDB-powered chart data endpoint.
Reads OHLCV and feature data directly from Parquet files via DuckDB Arrow scan.
No API overhead — direct filesystem access via shared volume.
"""
import os
import logging
from pathlib import Path

import duckdb
from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger("pca.chart_data")
router = APIRouter()

# Mounted from stock-data-node via Docker shared volume (read-only)
PARQUET_BASE = Path(os.environ.get("PARQUET_BASE_PATH", "/parquet"))


def _parquet_path(symbol: str, timeframe: str, features: bool = False) -> Path:
    suffix = f"{timeframe}_features" if features else timeframe
    return PARQUET_BASE / symbol.upper() / f"{suffix}.parquet"


@router.get("/chartdata")
async def get_chart_data(
    symbol: str = Query(..., description="Ticker symbol, e.g. AAPL"),
    timeframe: str = Query(default="1D", description="Timeframe, e.g. 1D, 1H"),
    limit: int = Query(default=500, ge=1, le=5000, description="Number of bars to return (newest N)"),
    features: bool = Query(default=True, description="Include pre-computed feature columns if available"),
):
    """
    Returns OHLCV bars for the requested ticker/timeframe.
    Optionally merges feature columns from the _features.parquet file.

    Response format:
    {
        "symbol": "AAPL",
        "timeframe": "1D",
        "count": 250,
        "columns": ["timestamp", "open", "high", "low", "close", "volume", "ma_sma_50", ...],
        "data": [[ts, o, h, l, c, v, sma50, ...], ...]  // row-oriented for canvas renderer
    }
    """
    symbol = symbol.upper()
    ohlcv_path = _parquet_path(symbol, timeframe, features=False)
    features_path = _parquet_path(symbol, timeframe, features=True)

    if not ohlcv_path.exists():
        raise HTTPException(status_code=404, detail=f"No data for {symbol}/{timeframe}")

    try:
        conn = duckdb.connect(database=":memory:", read_only=False)

        if features and features_path.exists():
            # JOIN on timestamp — features file has same length and index as OHLCV
            query = f"""
                SELECT o.timestamp, o.open, o.high, o.low, o.close, o.volume,
                       f.ma_sma_50, f.ma_sma_150, f.ma_sma_200,
                       f.ibd_rs, f.minervini_score, f.minervini_trend_template
                FROM read_parquet('{ohlcv_path}') o
                LEFT JOIN read_parquet('{features_path}') f
                  ON o.timestamp = f.timestamp
                ORDER BY o.timestamp ASC
                LIMIT {limit} OFFSET GREATEST(
                    (SELECT COUNT(*) FROM read_parquet('{ohlcv_path}')) - {limit}, 0
                )
            """
        else:
            query = f"""
                SELECT timestamp, open, high, low, close, volume
                FROM read_parquet('{ohlcv_path}')
                ORDER BY timestamp ASC
                LIMIT {limit} OFFSET GREATEST(
                    (SELECT COUNT(*) FROM read_parquet('{ohlcv_path}')) - {limit}, 0
                )
            """

        result = conn.execute(query).fetchall()
        col_names = [d[0] for d in conn.execute(query).description]

        # Re-execute cleanly to get both description and data
        rel = conn.execute(query)
        col_names = [d[0] for d in rel.description]
        rows = rel.fetchall()

        conn.close()

    except Exception as e:
        logger.exception("DuckDB error for %s/%s: %s", symbol, timeframe, e)
        raise HTTPException(status_code=500, detail=f"Data read error: {str(e)}")

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "count": len(rows),
        "columns": col_names,
        "data": [list(row) for row in rows],
    }


@router.get("/symbols")
async def list_symbols():
    """Returns all ticker symbols that have parquet data available."""
    if not PARQUET_BASE.exists():
        return {"symbols": []}
    symbols = sorted([p.name for p in PARQUET_BASE.iterdir() if p.is_dir()])
    return {"symbols": symbols, "count": len(symbols)}
