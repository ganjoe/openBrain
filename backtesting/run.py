#!/usr/bin/env python3
"""
Backtesting Engine – CLI Entry Point.

Usage:
    python run.py --config-id <ID>
    python run.py --config-id <ID> --watchlist <list_name>

The --watchlist flag overrides the watchlist from the bt_configs table.
"""

import argparse
import sys
from datetime import datetime, timezone

from config import get_supabase_client
from data_loader import load_watchlist, load_ohlcv, load_bt_config
from engine import BacktestEngine


def main():
    parser = argparse.ArgumentParser(description="Open Brain Backtesting Engine")
    parser.add_argument(
        "--config-id",
        type=int,
        required=True,
        help="ID of the backtest configuration in bt_configs table.",
    )
    parser.add_argument(
        "--watchlist",
        type=str,
        default=None,
        help="Override: watchlist name from pca_watchlists (overrides config).",
    )
    args = parser.parse_args()

    client = get_supabase_client()

    # ── Load config ──
    print(f"Loading config #{args.config_id}...")
    config = load_bt_config(client, args.config_id)
    print(f"  Name:    {config['name']}")
    print(f"  Period:  {config['start_date']} → {config['end_date']}")

    # ── Determine watchlist ──
    watchlist_name = args.watchlist or config["watchlist"]
    print(f"  Watchlist: {watchlist_name}")

    tickers = load_watchlist(client, watchlist_name)
    print(f"  Tickers: {tickers}")

    # ── Create run entry (status=running) ──
    run_data = {
        "config_id": args.config_id,
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    run_res = client.table("bt_runs").insert(run_data).execute()
    run_id = run_res.data[0]["run_id"]
    print(f"\nRun ID: {run_id}")

    try:
        # ── Load OHLCV data ──
        ticker_data = {}
        for ticker in tickers:
            try:
                df = load_ohlcv(ticker)
                ticker_data[ticker] = df
                print(f"  Loaded {ticker}: {len(df)} rows")
            except FileNotFoundError as e:
                print(f"  SKIP {ticker}: {e}")

        if not ticker_data:
            raise ValueError("No valid ticker data found for the watchlist.")

        # ── Run backtest ──
        print("\nRunning backtest...")
        engine = BacktestEngine(config)
        result = engine.run(ticker_data)

        # ── Print report ──
        print("\n" + result.report_text)

        # ── Write trades to DB ──
        if result.trades:
            trade_rows = []
            for t in result.trades:
                trade_rows.append({
                    "run_id": run_id,
                    "ticker": t.ticker,
                    "entry_date": t.entry_date,
                    "entry_price": t.entry_price,
                    "exit_date": t.exit_date,
                    "exit_price": t.exit_price,
                    "position_size": t.position_size,
                    "risk_per_share": t.risk_per_share,
                    "pnl": round(t.pnl, 2),
                    "r_multiple": round(t.r_multiple, 4),
                    "exit_reason": t.exit_reason,
                })
            client.table("bt_trades").insert(trade_rows).execute()
            print(f"\n{len(trade_rows)} trades written to bt_trades.")

        # ── Update run with results ──
        update_data = {
            "status": "completed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "total_trades": result.total_trades,
            "winning_trades": result.winning_trades,
            "losing_trades": result.losing_trades,
            "win_rate": round(result.win_rate, 2),
            "total_pnl": round(result.total_pnl, 2),
            "max_drawdown": round(result.max_drawdown, 2),
            "profit_factor": round(result.profit_factor, 4) if result.profit_factor != float("inf") else 9999.0,
            "avg_r_multiple": round(result.avg_r_multiple, 4),
            "final_capital": round(result.final_capital, 2),
            "report_text": result.report_text,
        }
        client.table("bt_runs").update(update_data).eq("run_id", run_id).execute()
        print(f"Run #{run_id} completed successfully.")

    except Exception as e:
        # Mark run as failed
        client.table("bt_runs").update({
            "status": "failed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "error_message": str(e),
        }).eq("run_id", run_id).execute()
        print(f"\nERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
