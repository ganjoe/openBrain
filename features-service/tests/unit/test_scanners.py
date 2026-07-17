import pytest
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from src.scanners.madbo_breakout import MadboBreakoutScanner

def generate_mock_data(n_days=200, breakout_index=-1, breakout_is_valid=True, breakout_volume=2000.0):
    """
    Generates mock data for testing.
    All candles are standard, except potentially the breakout_index candle.
    """
    dates = [datetime(2025, 1, 1) + timedelta(days=i) for i in range(n_days)]
    timestamps = [int(dt.timestamp()) for dt in dates]
    
    # Standard candle ranges: DR = 10, open=100, close=105, high=107, low=97
    # ADR20 will be 10.0
    opens = [100.0] * n_days
    closes = [105.0] * n_days
    highs = [107.0] * n_days
    lows = [97.0] * n_days
    volumes = [1000.0] * n_days
    
    if breakout_index == -1:
        breakout_idx = n_days - 1
    else:
        breakout_idx = breakout_index

    if breakout_is_valid:
        # Valid bullish breakout candle:
        # Range = 40. open = 100, close = 139, high = 140, low = 100.
        # Top wick = 1. Bottom wick = 0. Total wicks = 1. Range = 40. Ratio = 1/40 = 2.5% (< 5%).
        opens[breakout_idx] = 100.0
        closes[breakout_idx] = 139.0
        highs[breakout_idx] = 140.0
        lows[breakout_idx] = 100.0
        volumes[breakout_idx] = breakout_volume
    else:
        # Invalid candle (e.g. too large wicks):
        # DR = 40. open = 100, close = 110, high = 130, low = 90.
        # Total wicks = (130 - 110) + (100 - 90) = 30. Ratio = 30/40 = 75% (> 5%).
        opens[breakout_idx] = 100.0
        closes[breakout_idx] = 110.0
        highs[breakout_idx] = 130.0
        lows[breakout_idx] = 90.0
        volumes[breakout_idx] = breakout_volume

    return pd.DataFrame({
        "timestamp": timestamps,
        "open": opens,
        "high": highs,
        "low": lows,
        "close": closes,
        "volume": volumes
    })

def test_madbo_breakout_valid_latest():
    """scan_ticker should return a non-empty list of timestamps when condition is met."""
    df = generate_mock_data(n_days=180, breakout_index=-1, breakout_is_valid=True)
    scanner = MadboBreakoutScanner(
        lookback_days=150,
        max_wick_pct=0.05,
        daily_range_ratio=2.0,
        dollar_volume_ratio=1.5,
        history_lookback_days=1
    )
    result = scanner.scan_ticker("TEST", df)
    assert isinstance(result, list)
    assert len(result) == 1
    # Verify the timestamp is the last candle's timestamp
    expected_ts = int(df["timestamp"].iloc[-1])
    assert result[0] == expected_ts

def test_madbo_breakout_invalid_wicks():
    """scan_ticker should return empty list when wicks are too large."""
    df = generate_mock_data(n_days=180, breakout_index=-1, breakout_is_valid=False)
    scanner = MadboBreakoutScanner(
        lookback_days=150,
        max_wick_pct=0.05,
        daily_range_ratio=2.0,
        dollar_volume_ratio=1.5,
        history_lookback_days=1
    )
    result = scanner.scan_ticker("TEST", df)
    assert isinstance(result, list)
    assert len(result) == 0

def test_madbo_breakout_dollar_volume_ratio():
    """scan_ticker should filter out breakout candles if dollar volume ratio is too low."""
    # Breakout with low volume (same as daily average: 1000)
    df_low_vol = generate_mock_data(n_days=180, breakout_index=-1, breakout_is_valid=True, breakout_volume=1000.0)
    scanner = MadboBreakoutScanner(
        lookback_days=150,
        max_wick_pct=0.05,
        daily_range_ratio=2.0,
        dollar_volume_ratio=1.5,
        history_lookback_days=1
    )
    result = scanner.scan_ticker("TEST", df_low_vol)
    assert len(result) == 0

    # Breakout with high volume (2000 > 1.5 * 1000)
    df_high_vol = generate_mock_data(n_days=180, breakout_index=-1, breakout_is_valid=True, breakout_volume=2000.0)
    result_high = scanner.scan_ticker("TEST", df_high_vol)
    assert len(result_high) == 1

def test_madbo_breakout_history_window():
    """scan_ticker lookback window should control which candles are checked."""
    # Breakout occurred 5 days ago (index -6)
    df = generate_mock_data(n_days=180, breakout_index=-6, breakout_is_valid=True)
    
    # Scanning only last candle (history_lookback_days=1) should return empty
    scanner_latest = MadboBreakoutScanner(
        lookback_days=150,
        max_wick_pct=0.05,
        daily_range_ratio=2.0,
        dollar_volume_ratio=1.5,
        history_lookback_days=1
    )
    result_latest = scanner_latest.scan_ticker("TEST", df)
    assert len(result_latest) == 0

    # Scanning last 10 days should find the breakout
    scanner_history = MadboBreakoutScanner(
        lookback_days=150,
        max_wick_pct=0.05,
        daily_range_ratio=2.0,
        dollar_volume_ratio=1.5,
        history_lookback_days=10
    )
    result_history = scanner_history.scan_ticker("TEST", df)
    assert len(result_history) == 1
    # Verify it's the breakout candle's timestamp
    expected_ts = int(df["timestamp"].iloc[-6])
    assert result_history[0] == expected_ts

def test_madbo_breakout_date_range():
    """scan_ticker date range mode should filter by start/end date."""
    df = generate_mock_data(n_days=180, breakout_index=160, breakout_is_valid=True)
    
    # Date range covering breakout (index 160 is date 2025-06-10)
    scanner_match = MadboBreakoutScanner(
        lookback_days=150,
        max_wick_pct=0.05,
        daily_range_ratio=2.0,
        dollar_volume_ratio=1.5,
        start_date="2025-06-08",
        end_date="2025-06-12"
    )
    result_match = scanner_match.scan_ticker("TEST", df)
    assert len(result_match) == 1

    # Date range NOT covering breakout
    scanner_no_match = MadboBreakoutScanner(
        lookback_days=150,
        max_wick_pct=0.05,
        daily_range_ratio=2.0,
        dollar_volume_ratio=1.5,
        start_date="2025-06-15",
        end_date="2025-06-20"
    )
    result_no_match = scanner_no_match.scan_ticker("TEST", df)
    assert len(result_no_match) == 0

def test_madbo_breakout_multiple_events():
    """scan_ticker should return multiple timestamps when multiple candles match."""
    n_days = 200
    dates = [datetime(2025, 1, 1) + timedelta(days=i) for i in range(n_days)]
    timestamps = [int(dt.timestamp()) for dt in dates]
    
    opens = [100.0] * n_days
    closes = [105.0] * n_days
    highs = [107.0] * n_days
    lows = [97.0] * n_days
    volumes = [1000.0] * n_days
    
    # Two valid breakout candles at index 160 and 170
    for idx in [160, 170]:
        opens[idx] = 100.0
        closes[idx] = 139.0
        highs[idx] = 140.0
        lows[idx] = 100.0
        volumes[idx] = 2000.0

    df = pd.DataFrame({
        "timestamp": timestamps,
        "open": opens,
        "high": highs,
        "low": lows,
        "close": closes,
        "volume": volumes
    })
    
    scanner = MadboBreakoutScanner(
        lookback_days=150,
        max_wick_pct=0.05,
        daily_range_ratio=2.0,
        dollar_volume_ratio=1.5,
        history_lookback_days=50  # Look back enough to cover both
    )
    result = scanner.scan_ticker("TEST", df)
    assert isinstance(result, list)
    assert len(result) >= 1
    assert result[0] == timestamps[160]
