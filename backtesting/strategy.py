"""
Backtesting Engine – Strategy Logic.
Implements entry/exit conditions and position sizing.
"""

import pandas as pd


def check_trend_filter(ts_value: float, ts_sma_value: float, threshold: float) -> bool:
    """
    F-LOGIC-040: Trend Filter Condition.
    Returns True if trend strength is above its SMA OR above the static threshold.

    Args:
        ts_value: Current Trend Strength value (F-IND-020).
        ts_sma_value: Current SMA of Trend Strength (F-IND-030).
        threshold: Static threshold value.
    """
    return ts_value > ts_sma_value or ts_value > threshold


def check_setup_count(lows: pd.Series, n: int, current_idx: int) -> bool:
    """
    F-LOGIC-050: Setup Counting Condition.
    Returns True if for the last N consecutive days, each day's low is greater
    than the low from N days before that day.

    In other words: for each of the last N days (positions current_idx-N+1 .. current_idx),
    low[i] > low[i - N].

    Args:
        lows: Series of daily low prices (by positional index).
        n: Number of consecutive days required.
        current_idx: Current positional index in the lows Series.

    Returns:
        True if the setup count condition is met.
    """
    # Need at least 2*N data points to compare
    if current_idx < 2 * n - 1:
        return False

    for offset in range(n):
        i = current_idx - offset
        if lows.iloc[i] <= lows.iloc[i - n]:
            return False

    return True


def check_trailing_exit(current_low: float, previous_low: float) -> bool:
    """
    F-LOGIC-070: Trailing Exit Condition.
    Returns True if the current day's low is less than the previous day's low.
    """
    return current_low < previous_low


def calc_position_size(
    portfolio_value: float,
    risk_pct: float,
    high: float,
    low: float,
    min_tick: float
) -> int:
    """
    F-RISK-100 + F-RISK-110: Position Sizing.

    Formula: int((portfolio_value * risk_pct) / range)
    Where range = max(high - low, min_tick).

    F-RISK-110: If high == low, use min_tick as the range fallback
    so the trade is never rejected.

    Args:
        portfolio_value: Current total portfolio value.
        risk_pct: Risk percentage as decimal (e.g. 0.01 for 1%).
        high: Day's high price.
        low: Day's low price.
        min_tick: Minimum tick size fallback.

    Returns:
        Number of shares (always >= 1 if portfolio allows it).
    """
    price_range = high - low
    if price_range <= 0:
        price_range = min_tick

    risk_amount = portfolio_value * risk_pct
    shares = int(risk_amount / price_range)

    return max(shares, 0)
