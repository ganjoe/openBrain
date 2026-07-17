import pandas as pd
import numpy as np
from typing import Optional, List
from scanners.base import BaseScanner

class MadboBreakoutScanner(BaseScanner):
    def __init__(
        self,
        lookback_days: int = 150,
        max_wick_pct: float = 0.05,
        daily_range_ratio: float = 2.0,
        dollar_volume_ratio: float = 1.5,
        history_lookback_days: int = 1,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None
    ):
        self.lookback_days = lookback_days
        self.max_wick_pct = max_wick_pct
        self.daily_range_ratio = daily_range_ratio
        self.dollar_volume_ratio = dollar_volume_ratio
        self.history_lookback_days = history_lookback_days
        self.start_date = start_date
        self.end_date = end_date

    def get_parameters(self) -> dict:
        return {
            "lookback_days": self.lookback_days,
            "max_wick_pct": self.max_wick_pct,
            "daily_range_ratio": self.daily_range_ratio,
            "dollar_volume_ratio": self.dollar_volume_ratio,
            "history_lookback_days": self.history_lookback_days,
            "start_date": self.start_date,
            "end_date": self.end_date
        }

    def scan_ticker(self, ticker: str, df: pd.DataFrame) -> List[int]:
        # Check basic column requirements
        required_cols = {"timestamp", "open", "high", "low", "close"}
        if self.dollar_volume_ratio > 0:
            required_cols.add("volume")
            
        if not required_cols.issubset(df.columns):
            return []

        n_rows = len(df)
        min_required = max(self.lookback_days, 20, 50 if self.dollar_volume_ratio > 0 else 0) + 1
        if n_rows < min_required:
            return []

        timestamps = df["timestamp"]
        # Convert timestamps to pd.Series of datetime if they aren't already
        if pd.api.types.is_integer_dtype(timestamps) or pd.api.types.is_float_dtype(timestamps):
            # Check if ms or s
            if timestamps.iloc[0] > 1e11: # milliseconds
                dates = pd.to_datetime(timestamps, unit="ms")
            else:
                dates = pd.to_datetime(timestamps, unit="s")
        else:
            dates = pd.to_datetime(timestamps)

        # 1. Determine index range based on scan window parameters
        indices = []
        if self.start_date or self.end_date:
            # Date range mode
            start_dt = pd.to_datetime(self.start_date) if self.start_date else None
            end_dt = pd.to_datetime(self.end_date) if self.end_date else None
            
            for i in range(min_required - 1, n_rows):
                dt = dates.iloc[i]
                if start_dt and dt < start_dt:
                    continue
                if end_dt and dt > end_dt:
                    continue
                indices.append(i)
        else:
            # Lookback window mode (default is last 1 candle)
            lookback_size = max(1, self.history_lookback_days)
            start_idx = max(min_required - 1, n_rows - lookback_size)
            indices = list(range(start_idx, n_rows))

        if not indices:
            return []

        # Extract values to numpy arrays for speed
        highs = df["high"].to_numpy()
        lows = df["low"].to_numpy()
        closes = df["close"].to_numpy()
        opens = df["open"].to_numpy()

        dr = highs - lows
        
        # Calculate ADR20: shift(1) means c-20 to c-1 (preceding 20 days)
        adr20 = df["high"].sub(df["low"]).rolling(window=20).mean().shift(1).to_numpy()

        # Calculate Dollar Volume rolling average
        if self.dollar_volume_ratio > 0:
            dollar_vol = df["close"].mul(df["volume"]).to_numpy()
            avg_dollar_vol_50 = df["close"].mul(df["volume"]).rolling(window=50).mean().shift(1).to_numpy()

        # Raw timestamps for conversion to Unix seconds
        raw_timestamps = df["timestamp"].to_numpy()

        hit_timestamps = []

        for c in indices:
            # A. Bullish candle check
            if closes[c] <= opens[c]:
                continue

            # B. Daily Range vs ADR20 ratio check
            if self.daily_range_ratio > 0:
                cur_dr = dr[c]
                cur_adr = adr20[c]
                if pd.isna(cur_adr) or cur_adr <= 0 or cur_dr < self.daily_range_ratio * cur_adr:
                    continue

            # C. Marubozu / Wick check
            cur_range = dr[c]
            if cur_range <= 0:
                continue
            
            top_wick = highs[c] - closes[c]
            bottom_wick = opens[c] - lows[c]
            if (top_wick + bottom_wick) > self.max_wick_pct * cur_range:
                continue

            # D. Dollar Volume Ratio check
            if self.dollar_volume_ratio > 0:
                cur_dv = dollar_vol[c]
                avg_dv = avg_dollar_vol_50[c]
                if pd.isna(avg_dv) or avg_dv <= 0 or cur_dv < self.dollar_volume_ratio * avg_dv:
                    continue

            # E. Breakout check
            lookback_start = c - self.lookback_days
            if lookback_start < 0:
                continue
            
            prev_highs = highs[lookback_start:c]
            if not len(prev_highs):
                continue
            
            max_prev_high = np.max(prev_highs)
            if closes[c] > max_prev_high:
                # Convert timestamp to Unix seconds
                ts = raw_timestamps[c]
                if ts > 1e11:  # milliseconds
                    ts = int(ts // 1000)
                else:
                    ts = int(ts)
                hit_timestamps.append(ts)

        return hit_timestamps
