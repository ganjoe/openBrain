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
    # 1. Load close prices into a single DataFrame (columns = tickers, rows = dates)
    close_series = {}
    for ticker in tickers:
        try:
            df = storage.load_ticker_data(ticker, "1D")
            if len(df) < lookback_days:
                continue
            # Normalize timestamps to UTC midnight so all timezones align
            df["date"] = (df["timestamp"] // 86400) * 86400
            # Deduplicate (keep last value per day)
            df = df.drop_duplicates(subset="date", keep="last")
            tail = df.tail(lookback_days)
            series = tail.set_index("date")["close"]
            close_series[ticker] = series
        except Exception:
            continue

    if len(close_series) < num_clusters:
        raise ValueError(
            f"Only {len(close_series)} tickers with sufficient data, "
            f"but {num_clusters} clusters requested. Reduce num_clusters."
        )

    price_df = pd.DataFrame(close_series)

    # Forward-fill small gaps (weekends, holidays) so tickers align better
    price_df = price_df.sort_index().ffill(limit=5)

    logger.info("Loaded close prices for %d tickers (%d date rows).", len(price_df.columns), len(price_df))

    # 2. Calculate daily returns and drop rows where all are NaN
    returns_df = price_df.pct_change().dropna(how="all")

    # 3. Pearson correlation matrix (N x N) with pairwise complete observations
    correlation_matrix = returns_df.corr(method="pearson", min_periods=20)

    # Drop tickers that have no valid correlations (e.g. too little overlap)
    valid_mask = correlation_matrix.notna().sum(axis=1) > 1
    correlation_matrix = correlation_matrix.loc[valid_mask, valid_mask]

    # Fill remaining NaN correlations with 0 (uncorrelated assumption)
    correlation_matrix = correlation_matrix.fillna(0)

    logger.info("Computed %dx%d correlation matrix.", correlation_matrix.shape[0], correlation_matrix.shape[1])

    # 4. K-Means clustering on the correlation matrix
    kmeans = KMeans(n_clusters=num_clusters, random_state=42, n_init="auto")
    labels = kmeans.fit_predict(correlation_matrix)

    # 5. Group tickers by cluster label
    cluster_tickers = correlation_matrix.columns.tolist()
    result: dict[int, list[str]] = {}
    for ticker, label in zip(cluster_tickers, labels):
        cluster_id = int(label)
        if cluster_id not in result:
            result[cluster_id] = []
        result[cluster_id].append(ticker)

    for cid, members in sorted(result.items()):
        logger.info("Cluster %d: %d tickers", cid, len(members))

    return result
