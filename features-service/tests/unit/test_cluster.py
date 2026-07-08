import pytest
import pandas as pd
import numpy as np
from unittest.mock import MagicMock

from src.cluster import calculate_correlation_clusters
from src.parquet_io import ParquetStorage

@pytest.fixture
def mock_storage():
    """Mock storage returning predefined ticker histories."""
    storage = MagicMock(spec=ParquetStorage)
    
    # We will generate a base range of 100 days (in seconds)
    # 86400 seconds per day
    base_dates = [i * 86400 for i in range(100)]
    
    # ── Ticker A: Complete history (active)
    # Generates a sine wave price
    prices_a = [100.0 + 10.0 * np.sin(i / 5.0) for i in range(100)]
    df_a = pd.DataFrame({
        "timestamp": base_dates,
        "close": prices_a
    })
    
    # ── Ticker B: History with minor gaps (active)
    # Misses days 10 and 50, but continues to day 99
    dates_b = [d for idx, d in enumerate(base_dates) if idx not in (10, 50)]
    prices_b = [100.0 + 10.0 * np.sin(idx / 5.0 + 0.1) for idx in range(100) if idx not in (10, 50)]
    df_b = pd.DataFrame({
        "timestamp": dates_b,
        "close": prices_b
    })
    
    # ── Ticker C: Stale history (inactive, stops at day 40)
    dates_c = base_dates[:41]
    prices_c = [50.0 + 5.0 * np.cos(i / 5.0) for i in range(41)]
    df_c = pd.DataFrame({
        "timestamp": dates_c,
        "close": prices_c
    })
    
    # ── Ticker D: Another active ticker (moves opposite to A/B)
    prices_d = [100.0 - 10.0 * np.sin(i / 5.0) for i in range(100)]
    df_d = pd.DataFrame({
        "timestamp": base_dates,
        "close": prices_d
    })

    def mock_load(ticker, timeframe):
        if ticker == "TICK_A":
            return df_a.copy()
        if ticker == "TICK_B":
            return df_b.copy()
        if ticker == "TICK_C":
            return df_c.copy()
        if ticker == "TICK_D":
            return df_d.copy()
        raise FileNotFoundError(f"Mock data not found for {ticker}")

    storage.load_ticker_data.side_effect = mock_load
    return storage

def test_calculate_correlation_clusters_alignment_and_filtering(mock_storage):
    """
    Test that calculate_correlation_clusters:
    - Successfully clusters active stocks.
    - Excludes the stale stock TICK_C because it has too many NaNs in the lookback window.
    """
    tickers = ["TICK_A", "TICK_B", "TICK_C", "TICK_D"]
    
    # Run clustering with lookback_days = 30 and 2 clusters
    clusters = calculate_correlation_clusters(
        storage=mock_storage,
        tickers=tickers,
        lookback_days=30,
        num_clusters=2
    )
    
    # The result should contain exactly 2 clusters
    assert len(clusters) == 2
    
    # Gather all clustered tickers
    all_clustered = []
    for cid, members in clusters.items():
        all_clustered.extend(members)
        
    # Verify that TICK_A, TICK_B, and TICK_D are clustered, but TICK_C is excluded
    assert "TICK_A" in all_clustered
    assert "TICK_B" in all_clustered
    assert "TICK_D" in all_clustered
    assert "TICK_C" not in all_clustered

def test_calculate_correlation_clusters_insufficient_data(mock_storage):
    """
    Test that we raise a ValueError if too few tickers have sufficient data.
    """
    # TICK_C is stale. If we only pass TICK_A and TICK_C with 2 clusters requested,
    # TICK_C is filtered out, leaving only 1 ticker. But 2 clusters are requested, which should raise ValueError.
    tickers = ["TICK_A", "TICK_C"]
    
    with pytest.raises(ValueError) as excinfo:
        calculate_correlation_clusters(
            storage=mock_storage,
            tickers=tickers,
            lookback_days=30,
            num_clusters=2
        )
    assert "sufficient data" in str(excinfo.value)
