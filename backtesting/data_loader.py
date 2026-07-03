"""
Backtesting Engine – Data Loader.
Reads OHLCV data from Parquet files and watchlists/configs from Supabase.
"""

import os
import pandas as pd
from supabase import Client
from config import PARQUET_BASE_PATH


def load_watchlist(client: Client, list_name: str) -> list[str]:
    """
    Load ticker symbols from pca_watchlists for the given list_name.
    Returns a sorted list of unique ticker strings.
    """
    res = client.table("pca_watchlists") \
        .select("ticker") \
        .eq("list_name", list_name) \
        .order("position") \
        .execute()

    if not res.data:
        raise ValueError(f"Watchlist '{list_name}' not found or empty.")

    return [row["ticker"] for row in res.data]


def load_ohlcv(ticker: str) -> pd.DataFrame:
    """
    Load daily OHLCV data from the Parquet file for a given ticker.
    Returns a DataFrame with DatetimeIndex and columns: open, high, low, close, volume.
    """
    parquet_path = os.path.join(PARQUET_BASE_PATH, ticker, "1D.parquet")

    if not os.path.exists(parquet_path):
        raise FileNotFoundError(f"No parquet file for ticker '{ticker}' at {parquet_path}")

    df = pd.read_parquet(parquet_path)

    # Convert Unix timestamp to datetime index
    if "timestamp" in df.columns:
        df["timestamp"] = pd.to_datetime(df["timestamp"], unit="s")
        df.set_index("timestamp", inplace=True)
    elif not pd.api.types.is_datetime64_any_dtype(df.index):
        df.index = pd.to_datetime(df.index)

    df.sort_index(inplace=True)

    # Ensure standard column names (lowercase)
    col_map = {}
    for col in ["Open", "High", "Low", "Close", "Volume"]:
        if col in df.columns:
            col_map[col] = col.lower()
    if col_map:
        df.rename(columns=col_map, inplace=True)

    return df[["open", "high", "low", "close", "volume"]]


def load_bt_config(client: Client, config_id: int) -> dict:
    """
    Load a backtest configuration from bt_configs by its ID.
    Returns the full row as a dictionary.
    """
    res = client.table("bt_configs") \
        .select("*") \
        .eq("config_id", config_id) \
        .single() \
        .execute()

    if not res.data:
        raise ValueError(f"bt_configs with config_id={config_id} not found.")

    return res.data
