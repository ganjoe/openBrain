"""
Backtesting Engine – Data Loader.
Reads OHLCV data from Parquet files and watchlists/configs from Supabase.
"""

import os
import pandas as pd
from supabase import Client
try:
    from .config import PARQUET_BASE_PATH
except ImportError:
    from config import PARQUET_BASE_PATH


def load_watchlist(client: Client, list_name: str) -> list[str]:
    """
    Load ticker symbols from local text file for the given list_name.
    Expects /home/daniel/openBrain/backtesting/lists/{list_name}.txt
    Returns a list of unique ticker strings.
    """
    file_path = os.path.join(os.path.dirname(__file__), "lists", f"{list_name}.txt")
    
    if not os.path.exists(file_path):
        raise ValueError(f"Watchlist file '{file_path}' not found.")
        
    with open(file_path, "r", encoding="utf-8") as f:
        # Strip whitespace (including \r\n), uppercase, ignore empty lines
        tickers = [line.strip().upper() for line in f if line.strip()]
        
    if not tickers:
        raise ValueError(f"Watchlist file '{file_path}' is empty.")
        
    # Return unique tickers preserving order
    unique_tickers = []
    seen = set()
    for t in tickers:
        if t not in seen:
            seen.add(t)
            unique_tickers.append(t)
            
    return unique_tickers


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
