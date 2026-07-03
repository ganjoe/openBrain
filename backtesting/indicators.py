"""
Backtesting Engine – Technical Indicators.
Implements F-IND-020 (Trend Strength) and F-IND-030 (Trend Strength SMA).
"""

import pandas as pd


def calc_trend_strength(df: pd.DataFrame, ema_fast: int, ema_slow: int) -> pd.Series:
    """
    F-IND-020: Calculate Trend Strength.

    Formula: abs(EMA(Fast) - EMA(Slow)) / EMA(Fast) * 100

    Args:
        df: DataFrame with 'close' column.
        ema_fast: Period for the fast EMA (e.g. 14).
        ema_slow: Period for the slow EMA (e.g. 18).

    Returns:
        pd.Series with trend strength values (percentage).
    """
    ema_f = df["close"].ewm(span=ema_fast, adjust=False).mean()
    ema_s = df["close"].ewm(span=ema_slow, adjust=False).mean()

    # Avoid division by zero: replace 0 with NaN, forward-fill
    safe_ema_f = ema_f.replace(0, float("nan"))
    ts = (ema_f - ema_s).abs() / safe_ema_f * 100
    ts = ts.fillna(0.0)

    return ts


def calc_trend_strength_sma(trend_strength: pd.Series, period: int) -> pd.Series:
    """
    F-IND-030: Calculate the SMA of the Trend Strength values.

    Args:
        trend_strength: Series from calc_trend_strength().
        period: SMA period (e.g. 10).

    Returns:
        pd.Series with smoothed trend strength values.
    """
    return trend_strength.rolling(window=period, min_periods=1).mean()
