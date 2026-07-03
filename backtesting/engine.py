"""
Backtesting Engine – Core Engine.
Iterates day-by-day over the backtest period for each ticker in the watchlist.
Produces trade logs and aggregated metrics.
"""

import pandas as pd
from datetime import datetime
from dataclasses import dataclass, field
from indicators import calc_trend_strength, calc_trend_strength_sma
from strategy import (
    check_trend_filter,
    check_setup_count,
    check_trailing_exit,
    calc_position_size,
)


@dataclass
class Trade:
    """Represents a single completed or open trade."""
    ticker: str
    entry_date: str          # YYYY-MM-DD
    entry_price: float
    position_size: int
    risk_per_share: float    # High - Low on entry day (or min_tick)
    exit_date: str = None
    exit_price: float = None
    pnl: float = 0.0
    r_multiple: float = 0.0
    exit_reason: str = None  # 'trailing_exit' or 'end_of_period'


@dataclass
class BacktestResult:
    """Aggregated results of a backtest run across all tickers."""
    trades: list = field(default_factory=list)
    total_pnl: float = 0.0
    final_capital: float = 0.0
    max_drawdown: float = 0.0
    winning_trades: int = 0
    losing_trades: int = 0
    total_trades: int = 0
    win_rate: float = 0.0
    profit_factor: float = 0.0
    avg_r_multiple: float = 0.0
    report_text: str = ""


class BacktestEngine:
    """
    Main backtesting engine. Iterates day-by-day through the specified period
    for each ticker in the watchlist, running the Trend Strength + Setup Counter
    strategy sequentially.
    """

    def __init__(self, config: dict):
        """
        Args:
            config: Dictionary from bt_configs table with all strategy parameters.
        """
        self.ema_fast = int(config.get("ema_fast", 14))
        self.ema_slow = int(config.get("ema_slow", 18))
        self.trend_sma_period = int(config.get("trend_sma_period", 10))
        self.trend_threshold = float(config.get("trend_threshold", 0.0))
        self.setup_count_n = int(config.get("setup_count_n", 4))
        self.risk_pct = float(config.get("risk_pct", 0.01))
        self.initial_capital = float(config.get("initial_capital", 10000))
        self.min_tick = float(config.get("min_tick", 0.01))
        self.start_date = str(config.get("start_date"))
        self.end_date = str(config.get("end_date"))

    def run(self, ticker_data: dict[str, pd.DataFrame]) -> BacktestResult:
        """
        Run the backtest across all tickers sequentially.

        Args:
            ticker_data: Dict mapping ticker symbol -> OHLCV DataFrame.

        Returns:
            BacktestResult with all trades and aggregated metrics.
        """
        all_trades: list[Trade] = []
        capital = self.initial_capital
        peak_capital = capital

        # Process each ticker independently
        for ticker, df in ticker_data.items():
            ticker_trades, capital = self._run_single_ticker(
                ticker, df, capital
            )
            all_trades.extend(ticker_trades)

            # Track peak for drawdown
            if capital > peak_capital:
                peak_capital = capital

        # Calculate aggregated metrics
        result = self._calc_metrics(all_trades, capital, self.initial_capital)

        # Generate textual report
        result.report_text = self._generate_report(
            all_trades, result, ticker_data
        )

        return result

    def _run_single_ticker(
        self,
        ticker: str,
        df: pd.DataFrame,
        capital: float,
    ) -> tuple[list[Trade], float]:
        """
        Run the strategy on a single ticker within the backtest period.

        Returns:
            Tuple of (list of trades, updated capital).
        """
        # Filter to backtest period
        start_dt = pd.to_datetime(self.start_date)
        end_dt = pd.to_datetime(self.end_date)
        df = df.loc[(df.index >= start_dt) & (df.index <= end_dt)].copy()

        if len(df) < max(self.ema_slow, self.setup_count_n * 2) + 1:
            return [], capital

        # Pre-compute indicators on the full filtered data
        ts = calc_trend_strength(df, self.ema_fast, self.ema_slow)
        ts_sma = calc_trend_strength_sma(ts, self.trend_sma_period)

        trades: list[Trade] = []
        open_trade: Trade | None = None

        for i in range(1, len(df)):
            row = df.iloc[i]
            prev_row = df.iloc[i - 1]
            date_str = str(df.index[i].date())
            current_low = row["low"]
            previous_low = prev_row["low"]
            close = row["close"]
            high = row["high"]
            low = row["low"]

            # ── EXIT CHECK (F-LOGIC-070 / F-EXEC-080) ──
            if open_trade is not None:
                if check_trailing_exit(current_low, previous_low):
                    # Close position at close price
                    open_trade.exit_date = date_str
                    open_trade.exit_price = close
                    open_trade.pnl = (
                        (close - open_trade.entry_price)
                        * open_trade.position_size
                    )
                    if open_trade.risk_per_share > 0:
                        open_trade.r_multiple = (
                            (close - open_trade.entry_price)
                            / open_trade.risk_per_share
                        )
                    open_trade.exit_reason = "trailing_exit"

                    capital += open_trade.pnl
                    trades.append(open_trade)
                    open_trade = None

            # ── ENTRY CHECK (F-LOGIC-040 + F-LOGIC-050 / F-EXEC-060) ──
            if open_trade is None:
                trend_ok = check_trend_filter(
                    ts.iloc[i], ts_sma.iloc[i], self.trend_threshold
                )
                setup_ok = check_setup_count(
                    df["low"], self.setup_count_n, i
                )

                if trend_ok and setup_ok:
                    # Position Sizing (F-RISK-100 / F-RISK-110)
                    pos_size = calc_position_size(
                        capital, self.risk_pct, high, low, self.min_tick
                    )

                    if pos_size > 0:
                        risk_per_share = max(high - low, self.min_tick)
                        open_trade = Trade(
                            ticker=ticker,
                            entry_date=date_str,
                            entry_price=close,
                            position_size=pos_size,
                            risk_per_share=risk_per_share,
                        )

        # Close any open trade at end of period
        if open_trade is not None:
            last_row = df.iloc[-1]
            date_str = str(df.index[-1].date())
            open_trade.exit_date = date_str
            open_trade.exit_price = last_row["close"]
            open_trade.pnl = (
                (last_row["close"] - open_trade.entry_price)
                * open_trade.position_size
            )
            if open_trade.risk_per_share > 0:
                open_trade.r_multiple = (
                    (last_row["close"] - open_trade.entry_price)
                    / open_trade.risk_per_share
                )
            open_trade.exit_reason = "end_of_period"
            capital += open_trade.pnl
            trades.append(open_trade)

        return trades, capital

    def _calc_metrics(
        self,
        trades: list[Trade],
        final_capital: float,
        initial_capital: float,
    ) -> BacktestResult:
        """Calculate aggregated metrics from the list of completed trades."""
        result = BacktestResult()
        result.trades = trades
        result.total_trades = len(trades)
        result.final_capital = final_capital

        if not trades:
            result.total_pnl = 0.0
            result.max_drawdown = 0.0
            return result

        # Win/Loss
        result.winning_trades = sum(1 for t in trades if t.pnl > 0)
        result.losing_trades = sum(1 for t in trades if t.pnl <= 0)
        result.total_pnl = sum(t.pnl for t in trades)
        result.win_rate = (
            result.winning_trades / result.total_trades * 100
            if result.total_trades > 0
            else 0.0
        )

        # Profit Factor
        gross_profit = sum(t.pnl for t in trades if t.pnl > 0)
        gross_loss = abs(sum(t.pnl for t in trades if t.pnl < 0))
        result.profit_factor = (
            gross_profit / gross_loss if gross_loss > 0 else float("inf")
        )

        # Average R-Multiple
        r_multiples = [t.r_multiple for t in trades if t.r_multiple != 0]
        result.avg_r_multiple = (
            sum(r_multiples) / len(r_multiples) if r_multiples else 0.0
        )

        # Max Drawdown (equity-curve based)
        equity = initial_capital
        peak = equity
        max_dd = 0.0
        for t in trades:
            equity += t.pnl
            if equity > peak:
                peak = equity
            dd = (peak - equity) / peak * 100 if peak > 0 else 0.0
            if dd > max_dd:
                max_dd = dd
        result.max_drawdown = max_dd

        return result

    def _generate_report(
        self,
        trades: list[Trade],
        result: BacktestResult,
        ticker_data: dict[str, pd.DataFrame],
    ) -> str:
        """Generate a human-readable text report of the entire backtest run."""
        lines = []
        lines.append("=" * 70)
        lines.append("BACKTEST REPORT")
        lines.append("=" * 70)
        lines.append(f"Period:          {self.start_date} → {self.end_date}")
        lines.append(f"Tickers:         {', '.join(ticker_data.keys())}")
        lines.append(f"Initial Capital: {self.initial_capital:,.2f}")
        lines.append(f"Parameters:      EMA({self.ema_fast}/{self.ema_slow}), "
                      f"SMA({self.trend_sma_period}), "
                      f"Threshold({self.trend_threshold}), "
                      f"SetupN({self.setup_count_n}), "
                      f"Risk({self.risk_pct*100:.1f}%)")
        lines.append("")

        # Per-ticker summary
        ticker_groups: dict[str, list[Trade]] = {}
        for t in trades:
            ticker_groups.setdefault(t.ticker, []).append(t)

        for ticker, t_trades in ticker_groups.items():
            ticker_pnl = sum(t.pnl for t in t_trades)
            ticker_wins = sum(1 for t in t_trades if t.pnl > 0)
            lines.append(f"─── {ticker} ({len(t_trades)} Trades) ───")

            for idx, t in enumerate(t_trades, 1):
                pnl_str = f"+{t.pnl:,.2f}" if t.pnl >= 0 else f"{t.pnl:,.2f}"
                r_str = f"+{t.r_multiple:.2f}R" if t.r_multiple >= 0 else f"{t.r_multiple:.2f}R"
                lines.append(
                    f"  #{idx:>3d}  {t.entry_date} → {t.exit_date}  "
                    f"Entry: {t.entry_price:>8.2f}  Exit: {t.exit_price:>8.2f}  "
                    f"Size: {t.position_size:>5d}  "
                    f"PnL: {pnl_str:>12s}  {r_str:>8s}  "
                    f"({t.exit_reason})"
                )

            wr = ticker_wins / len(t_trades) * 100 if t_trades else 0
            lines.append(
                f"  Subtotal: {ticker_pnl:+,.2f}  "
                f"(Win Rate: {wr:.1f}%, {ticker_wins}W/{len(t_trades)-ticker_wins}L)"
            )
            lines.append("")

        # Overall summary
        lines.append("=" * 70)
        lines.append("SUMMARY")
        lines.append("=" * 70)
        lines.append(f"Total Trades:    {result.total_trades}")
        lines.append(f"Winning:         {result.winning_trades}")
        lines.append(f"Losing:          {result.losing_trades}")
        lines.append(f"Win Rate:        {result.win_rate:.1f}%")
        lines.append(f"Total PnL:       {result.total_pnl:+,.2f}")
        lines.append(f"Final Capital:   {result.final_capital:,.2f}")
        lines.append(f"Return:          {((result.final_capital / self.initial_capital - 1) * 100):+.2f}%")
        lines.append(f"Max Drawdown:    {result.max_drawdown:.2f}%")
        lines.append(f"Profit Factor:   {result.profit_factor:.2f}")
        lines.append(f"Avg R-Multiple:  {result.avg_r_multiple:+.2f}R")
        lines.append("=" * 70)

        return "\n".join(lines)
