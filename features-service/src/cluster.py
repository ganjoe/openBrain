"""
cluster.py — Correlation-based stock clustering.
Computes Pearson correlation of daily returns and groups tickers via K-Means.
"""

import logging
from typing import Optional

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans

from parquet_io import ParquetStorage

logger = logging.getLogger(__name__)


def calculate_correlation_clusters(
    storage: ParquetStorage,
    tickers: list[str],
    lookback_days: int = 63,
    num_clusters: int = 10,
) -> dict[int, list[str]]:
    """
    Cluster tickers by Pearson correlation of their daily returns.

    Args:
        storage: ParquetStorage instance to load price data.
        tickers: List of ticker symbols to cluster.
        lookback_days: Number of trading days to use for correlation (default 63 = ~3 months).
        num_clusters: Number of clusters / watchlists to generate.

    Returns:
        Dict mapping cluster_id -> list of ticker symbols.
    """
    # 1. Load ALL close prices into a single DataFrame without slicing first
    close_series = {}
    for ticker in tickers:
        try:
            df = storage.load_ticker_data(ticker, "1D")
            # Normalize timestamps to UTC midnight so all timezones align
            df["date"] = (df["timestamp"] // 86400) * 86400
            df = df.drop_duplicates(subset="date", keep="last")
            close_series[ticker] = df.set_index("date")["close"]
        except Exception:
            continue

    if not close_series:
        raise ValueError("No tickers with valid data found.")

    price_df = pd.DataFrame(close_series).sort_index()

    # 2. Forward-fill small gaps (weekends, holidays) up to 5 days
    price_df = price_df.ffill(limit=5)

    # 3. Calculate daily returns on the entire aligned history first (prevents losing first day return)
    returns_df = price_df.pct_change()

    # 4. Take the last `lookback_days` of returns
    returns_df = returns_df.tail(lookback_days)

    # 5. Filter out tickers with too many NaNs in the lookback period
    # (Require at least 90% valid trading days in the lookback window)
    min_valid = int(lookback_days * 0.9)
    valid_tickers = [t for t in returns_df.columns if returns_df[t].notna().sum() >= min_valid]
    
    if len(valid_tickers) < num_clusters:
        raise ValueError(
            f"Only {len(valid_tickers)} tickers with sufficient data for lookback={lookback_days}, "
            f"but {num_clusters} clusters requested. Reduce num_clusters or choose different tickers."
        )
    returns_df = returns_df[valid_tickers].fillna(0)

    # 6. Standardize returns (Z-Score)
    # Subtract mean, divide by standard deviation for each stock.
    # Transpose so that rows are stocks (samples) and columns are dates (features).
    standardized_returns = (returns_df - returns_df.mean()) / returns_df.std()
    features = standardized_returns.T

    # 7. K-Means clustering on the standardized return vectors
    # This is mathematically equivalent to minimizing 1 - Pearson correlation coefficient,
    # but scales much better to thousands of tickers.
    kmeans = KMeans(n_clusters=num_clusters, random_state=42, n_init="auto")
    labels = kmeans.fit_predict(features)

    # 8. Group tickers by cluster label
    result: dict[int, list[str]] = {}
    for ticker, label in zip(features.index, labels):
        cluster_id = int(label)
        result.setdefault(cluster_id, []).append(ticker)

    for cid, members in sorted(result.items()):
        logger.info("Cluster %d: %d tickers", cid, len(members))

    return result
