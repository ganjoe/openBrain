"""
Backtesting Engine – Core Engine.
Iterates day-by-day over the backtest period for each ticker in the watchlist.
Produces trade logs and aggregated metrics.
"""

import pandas as pd
from datetime import datetime
from dataclasses import dataclass, field
try:
    from .indicators import calc_trend_strength, calc_trend_strength_sma, calc_atr
    from .strategy import (
        check_trend_filter,
        check_setup_count,
        check_trailing_exit,
        calc_position_size,
    )
except ImportError:
    from indicators import calc_trend_strength, calc_trend_strength_sma, calc_atr
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
    exit_reason: str = None  # 'trailing_exit', 'end_of_period', 'setup_exit', 'vstop_exit'
    commission: float = 0.0  # Total commission paid for this trade (entry + exit)
    current_vstop: float = None # Dynamic trailing stop loss


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
    ticker_metrics: dict = field(default_factory=dict)


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
        self.trend_sma_period = int(config.get("trend_sma_period", 50))
        self.trend_threshold = float(config.get("trend_threshold", 0.0))
        self.setup_count_enter_n = int(config.get("setup_count_enter_n", config.get("setup_count_n", 4)))
        self.setup_count_exit_n = int(config.get("setup_count_exit_n", config.get("setup_count_n", 4)))
        self.risk_pct = float(config.get("risk_pct", 0.01))
        self.initial_capital = float(config.get("initial_capital", 10000))
        self.min_tick = float(config.get("min_tick", 0.01))
        self.commission = float(config.get("commission", 2.0)) # Default commission is 2
        self.position_size_pct = float(config.get("position_size_pct", 10.0))
        self.vstop_period = int(config.get("vstop_period", 14))
        self.vstop_multiplier = float(config.get("vstop_multiplier", 2.0))
        self.start_date = config.get("start_date")
        if self.start_date:
            self.start_date = str(self.start_date)
        
        self.end_date = config.get("end_date")
        if self.end_date:
            self.end_date = str(self.end_date)

    def run(self, ticker_data: dict[str, pd.DataFrame]) -> BacktestResult:
        """
        Run the backtest across all tickers independently to test parameter robustness.
        Metrics are calculated as the average across all tickers.

        Args:
            ticker_data: Dict mapping ticker symbol -> OHLCV DataFrame.

        Returns:
            BacktestResult with all trades and aggregated (averaged) metrics.
        """
        all_trades: list[Trade] = []
        ticker_results: list[BacktestResult] = []
        ticker_metrics_dict = {}

        # Process each ticker completely independently starting with initial_capital
        for ticker, df in ticker_data.items():
            ticker_trades, ticker_final_cap = self._run_single_ticker(
                ticker, df, self.initial_capital
            )
            all_trades.extend(ticker_trades)
            
            # Calculate metrics isolated for this ticker
            res = self._calc_metrics(ticker_trades, ticker_final_cap, self.initial_capital)
            ticker_results.append(res)
            ticker_metrics_dict[ticker] = res

        # Aggregate the results (Averaging to evaluate Robustness across tickers)
        result = BacktestResult()
        result.ticker_metrics = ticker_metrics_dict
        result.trades = all_trades
        result.total_trades = sum(r.total_trades for r in ticker_results)
        result.winning_trades = sum(r.winning_trades for r in ticker_results)
        result.losing_trades = sum(r.losing_trades for r in ticker_results)
        
        valid_results = [r for r in ticker_results if r.total_trades > 0]
        n_valid = len(valid_results)
        
        if n_valid > 0:
            result.win_rate = sum(r.win_rate for r in valid_results) / n_valid
            result.total_pnl = sum(r.total_pnl for r in valid_results) / n_valid
            result.max_drawdown = sum(r.max_drawdown for r in valid_results) / n_valid
            
            pfs = [r.profit_factor for r in valid_results if r.profit_factor != float("inf")]
            result.profit_factor = sum(pfs) / len(pfs) if pfs else float("inf")
            
            result.avg_r_multiple = sum(r.avg_r_multiple for r in valid_results) / n_valid
            
            # Final capital reflects the average return applied to initial_capital
            avg_return_pct = sum((r.final_capital / self.initial_capital) - 1 for r in valid_results) / n_valid
            result.final_capital = self.initial_capital * (1 + avg_return_pct)
        else:
            result.final_capital = self.initial_capital

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
        if self.start_date and self.start_date != "None":
            start_dt = pd.to_datetime(self.start_date)
            df = df.loc[df.index >= start_dt]
            
        if self.end_date and self.end_date != "None":
            end_dt = pd.to_datetime(self.end_date)
            df = df.loc[df.index <= end_dt]
            
        df = df.copy()

        if len(df) < max(self.ema_slow, self.setup_count_enter_n * 2, self.setup_count_exit_n * 2) + 1:
            return [], capital

        # Pre-compute indicators on the full filtered data
        ts = calc_trend_strength(df, self.ema_fast, self.ema_slow)
        ts_sma = calc_trend_strength_sma(ts, self.trend_sma_period)
        atr_series = calc_atr(df, self.vstop_period)

        # Extract NumPy arrays for extremely fast iteration (10-50x speedup over df.iloc)
        lows = df["low"].values
        highs = df["high"].values
        opens = df["open"].values
        closes = df["close"].values
        ts_vals = ts.values
        ts_sma_vals = ts_sma.values
        atr_vals = atr_series.values
        dates = df.index.strftime('%Y-%m-%d').values

        trades: list[Trade] = []
        open_trade: Trade | None = None

        for i in range(1, len(df)):
            date_str = dates[i]
            current_low = lows[i]
            previous_low = lows[i - 1]
            close = closes[i]
            open_price = opens[i]
            high = highs[i]
            low = lows[i]

            # ── EXIT CHECK ──
            if open_trade is not None:
                # 1. Volatility Stop Check (Intraday)
                if low <= open_trade.current_vstop:
                    open_trade.exit_date = date_str
                    # Slippage/Gap assumption: If it opens below stop, we get filled at open
                    open_trade.exit_price = min(open_trade.current_vstop, open_price)
                    open_trade.commission = 2 * self.commission
                    open_trade.pnl = (
                        (open_trade.exit_price - open_trade.entry_price)
                        * open_trade.position_size
                        - open_trade.commission
                    )
                    if open_trade.risk_per_share > 0:
                        open_trade.r_multiple = (
                            open_trade.pnl
                            / (open_trade.position_size * open_trade.risk_per_share)
                        )
                    open_trade.exit_reason = "vstop_exit"

                    capital += open_trade.pnl
                    trades.append(open_trade)
                    open_trade = None

            if open_trade is not None:
                # 2. Setup Count Check (End of Day)
                # N-Tage Higher Lows prüfen für Exit (i-1 = Gestriger Stand)
                setup_ok_yesterday = check_setup_count(
                    lows, self.setup_count_exit_n, i - 1
                )
                
                if not setup_ok_yesterday:
                    # Close position at close price
                    open_trade.exit_date = date_str
                    open_trade.exit_price = close
                    open_trade.commission = 2 * self.commission
                    open_trade.pnl = (
                        (close - open_trade.entry_price)
                        * open_trade.position_size
                        - open_trade.commission
                    )
                    if open_trade.risk_per_share > 0:
                        open_trade.r_multiple = (
                            open_trade.pnl
                            / (open_trade.position_size * open_trade.risk_per_share)
                        )
                    open_trade.exit_reason = "setup_exit"

                    capital += open_trade.pnl
                    trades.append(open_trade)
                    open_trade = None

            if open_trade is not None:
                # 3. Update VStop for tomorrow
                atr_today = atr_vals[i]
                new_vstop = close - (self.vstop_multiplier * atr_today)
                open_trade.current_vstop = max(open_trade.current_vstop, new_vstop)

            # ── ENTRY CHECK (F-LOGIC-040 + F-LOGIC-050 / F-EXEC-060) ──
            if open_trade is None:
                trend_ok = check_trend_filter(
                    ts_vals[i], ts_sma_vals[i], self.trend_threshold
                )
                setup_ok_today = check_setup_count(
                    lows, self.setup_count_enter_n, i
                )
                green_candle = close > open_price

                if trend_ok and setup_ok_today and green_candle:
                    # Position Sizing with Position Cap (min of risk sizing and cap sizing)
                    risk_size = calc_position_size(
                        capital, self.risk_pct, high, low, self.min_tick
                    )
                    cap_value = capital * (self.position_size_pct / 100.0)
                    cap_size = int(cap_value / close)
                    pos_size = min(risk_size, cap_size)

                    if pos_size > 0:
                        risk_per_share = max(high - low, self.min_tick)
                        open_trade = Trade(
                            ticker=ticker,
                            entry_date=date_str,
                            entry_price=close,
                            position_size=pos_size,
                            risk_per_share=risk_per_share,
                            current_vstop=close - (self.vstop_multiplier * atr_series.iloc[i])
                        )

        # Close any open trade at end of period
        if open_trade is not None:
            last_row = df.iloc[-1]
            date_str = str(df.index[-1].date())
            open_trade.exit_date = date_str
            open_trade.exit_price = last_row["close"]
            open_trade.commission = 2 * self.commission
            open_trade.pnl = (
                (last_row["close"] - open_trade.entry_price)
                * open_trade.position_size
                - open_trade.commission
            )
            if open_trade.risk_per_share > 0:
                open_trade.r_multiple = (
                    open_trade.pnl
                    / (open_trade.position_size * open_trade.risk_per_share)
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
        sd_str = self.start_date if self.start_date and self.start_date != "None" else "All Time"
        ed_str = self.end_date if self.end_date and self.end_date != "None" else "All Time"
        lines.append(f"Period:          {sd_str} → {ed_str}")
        lines.append(f"Tickers:         {', '.join(ticker_data.keys())}")
        lines.append(f"Initial Capital: {self.initial_capital:,.2f}")
        lines.append(f"Parameters:      EMA({self.ema_fast}/{self.ema_slow}), "
                      f"SMA({self.trend_sma_period}), "
                      f"Threshold({self.trend_threshold}), "
                      f"SetupN(In:{self.setup_count_enter_n}/Out:{self.setup_count_exit_n}), "
                      f"Risk({self.risk_pct*100:.1f}%), "
                      f"PositionCap({self.position_size_pct}%), "
                      f"VStop({self.vstop_period}, {self.vstop_multiplier}x), "
                      f"Commission({self.commission:.2f}€ per Order)")
        lines.append("")

        # Per-ticker summary
        ticker_groups: dict[str, list[Trade]] = {}
        for t in trades:
            ticker_groups.setdefault(t.ticker, []).append(t)

        for ticker, t_trades in ticker_groups.items():
            ticker_pnl = sum(t.pnl for t in t_trades)
            ticker_wins = sum(1 for t in t_trades if t.pnl > 0)
            
            t_metrics = getattr(result, "ticker_metrics", {}).get(ticker)
            if t_metrics:
                m_ret = ((t_metrics.final_capital / self.initial_capital) - 1) * 100
                m_dd = t_metrics.max_drawdown
                m_pf = t_metrics.profit_factor
                lines.append(f"─── {ticker} ({len(t_trades)} Trades | Ret: {m_ret:+.2f}% | MaxDD: {m_dd:.2f}% | PF: {m_pf:.2f}) ───")
            else:
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
