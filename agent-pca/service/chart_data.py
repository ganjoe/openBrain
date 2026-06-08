"""
chart_data.py — DuckDB-powered chart data endpoint.
Reads OHLCV and feature data directly from Parquet files via DuckDB Arrow scan.
No API overhead — direct filesystem access via shared volume.
"""
import os
import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

# Import View Controllers
from views.default import get_chart_data_default
from views.trading_journal_daily import get_chart_data_daily
from views.trading_journal_events import get_chart_data_events

logger = logging.getLogger("pca.chart_data")
router = APIRouter()

@router.get("/chartdata")
async def get_chart_data(
    symbol: str = Query(..., description="Ticker symbol, e.g. AAPL"),
    timeframe: str = Query(default="1D", description="Timeframe, e.g. 1D, 1H"),
    limit: int = Query(default=500, ge=1, le=5000, description="Number of bars to return (newest N)"),
    features: bool = Query(default=True, description="Include pre-computed feature columns if available"),
    layout: Optional[str] = Query(default=None, description="The layout name requesting the data (for view-specific logic)"),
):
    """
    Returns OHLCV bars for the requested ticker/timeframe.
    Optionally merges feature columns from the _features.parquet file.
    Routes to view-specific controllers if special logic is needed based on layout.
    """
    symbol = symbol.upper()
    
    # 1. Check if we need a specialized view controller based on layout and symbol
    if symbol.startswith("$STATS."):
        if layout == "trading_journal_events":
            return get_chart_data_events(symbol, timeframe, limit)
        elif layout == "trading_journal_daily":
            # Now that we have Parquet caching, we can load it just like a default ticker!
            return get_chart_data_default(symbol, timeframe, limit, features)
        else:
            return get_chart_data_default(symbol, timeframe, limit, features)

    # 2. Default behavior for normal tickers (AAPL, TSLA, etc.)
    return get_chart_data_default(symbol, timeframe, limit, features)
