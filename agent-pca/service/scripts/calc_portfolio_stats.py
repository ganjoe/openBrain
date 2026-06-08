"""
calc_portfolio_stats.py
-----------------------
Berechnet täglich NAV, Asset Value, Cash Quote und PnL aus der Datenbank.
Speichert die Ergebnisse als Parquet-Dateien für schnellen Zugriff im Chart.

Kernlogik:
  NAV(t) = net_cash_injected(t) + realized_pnl(t) - cost_basis_open(t) + asset_value_open(t)

Kann beliebig oft aufgerufen werden (idempotent). Überschreibt die Parquets.
"""
import os
import httpx
import logging
import datetime
from pathlib import Path
from collections import defaultdict
import duckdb
import json
import tempfile

logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s: %(message)s")
logger = logging.getLogger("calc_portfolio_stats")

postgrest_url = os.environ.get("POSTGREST_URL", "http://postgrest:3000")
PARQUET_BASE = Path(os.environ.get("PARQUET_BASE_PATH", "/parquet"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def fetch(url: str, timeout: float = 60.0):
    """Fetch all rows from a PostgREST endpoint, auto-handling 1000-row limit."""
    rows = []
    offset = 0
    limit = 1000
    while True:
        sep = "&" if "?" in url else "?"
        r = httpx.get(f"{url}{sep}limit={limit}&offset={offset}", timeout=timeout)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return rows


def build_fx_lookup(rates_data: list) -> dict:
    fx = defaultdict(dict)
    for item in rates_data:
        fx[item["target_currency"]][item["date"][:10]] = float(item["rate"])
    return dict(fx)


def get_fx(fx: dict, curr: str, target_date: str) -> float:
    if curr == "EUR" or not curr:
        return 1.0
    curr_rates = fx.get(curr, {})
    dates = sorted([d for d in curr_rates if d <= target_date])
    if dates:
        return curr_rates[dates[-1]]
    all_dates = sorted(curr_rates.keys())
    if all_dates:
        return curr_rates[all_dates[0]]
    return 1.0


def load_prices(tickers: set, parquet_base: Path) -> dict:
    """Load all daily close prices for given tickers from Parquet."""
    prices = defaultdict(dict)
    db = duckdb.connect()
    for t in tickers:
        p = parquet_base / t / "1D.parquet"
        if not p.exists():
            logger.warning(f"Parquet not found: {p}")
            continue
        try:
            res = db.execute(
                f"SELECT timestamp, close FROM read_parquet('{p}') WHERE close IS NOT NULL"
            ).fetchall()
            for row in res:
                ts = row[0]
                if hasattr(ts, "timestamp"):
                    ts = ts.timestamp()
                elif isinstance(ts, (int, float)) and ts > 10_000_000_000:
                    ts = ts / 1000.0
                dt_str = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).strftime("%Y-%m-%d")
                prices[t][dt_str] = float(row[1])
        except Exception as e:
            logger.error(f"Error reading {p}: {e}")
    db.close()
    return dict(prices)


def get_price(prices: dict, ticker: str, target_date: str) -> float:
    ticker_prices = prices.get(ticker, {})
    dates = sorted([d for d in ticker_prices if d <= target_date])
    if dates:
        return ticker_prices[dates[-1]]
    return 0.0


def save_parquet(db: duckdb.DuckDBPyConnection, symbol: str, data_list: list, parquet_base: Path):
    if not data_list:
        logger.warning(f"No data for {symbol}, skipping.")
        return
    target_dir = parquet_base / symbol
    target_dir.mkdir(parents=True, exist_ok=True)
    out_path = target_dir / "1D.parquet"

    with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
        for item in data_list:
            f.write(json.dumps(item) + "\n")
        temp_file = f.name

    try:
        db.execute(
            f"COPY (SELECT * FROM read_json_auto('{temp_file}')) TO '{out_path}' (FORMAT PARQUET)"
        )
        logger.info(f"Saved {symbol} -> {out_path} ({len(data_list)} rows)")
    except Exception as e:
        logger.error(f"Failed to save {symbol}: {e}")
    finally:
        os.unlink(temp_file)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    logger.info("=== calc_portfolio_stats.py starting ===")

    # 1. Fetch raw data
    logger.info("Fetching pta_execution_log (FILL + CASH_TRANSFER)...")
    exec_logs = fetch(
        f"{postgrest_url}/pta_execution_log?event_type=in.(FILL,CASH_TRANSFER)&order=created_at.asc"
    )
    logger.info(f"  {len(exec_logs)} execution log entries")

    logger.info("Fetching pta_trade_performance (all trades, open + closed)...")
    trade_perf = fetch(f"{postgrest_url}/pta_trade_performance?order=close_time.asc")
    logger.info(f"  {len(trade_perf)} trade performance entries")

    logger.info("Fetching exchange_rates...")
    rates_data = fetch(f"{postgrest_url}/exchange_rates?base_currency=eq.EUR&order=date.asc")
    logger.info(f"  {len(rates_data)} exchange rate entries")

    if not exec_logs:
        logger.error("No execution log data. Aborting.")
        return

    # 2. Build helpers
    fx = build_fx_lookup(rates_data)

    # Determine all tickers ever traded
    tickers = set()
    for ev in exec_logs:
        if ev.get("ticker"):
            tickers.add(ev["ticker"])

    logger.info(f"Loading Parquet prices for {len(tickers)} tickers...")
    prices = load_prices(tickers, PARQUET_BASE)
    logger.info(f"  Loaded prices for {len(prices)} tickers")

    # 3. Build daily snapshots using per-trade position tracking
    #
    # Strategy: track positions keyed by trade_id (not just ticker).
    # A trade is "open" when net_qty != 0 for that trade_id.
    # This exactly mirrors how pta_trade_performance / pta_active_positions works.

    # Group exec_logs by date
    start_dt = datetime.datetime.fromisoformat(
        exec_logs[0]["created_at"].replace("Z", "+00:00")
    ).date()
    end_dt = datetime.datetime.now(datetime.timezone.utc).date()

    # Per-trade state: {trade_id -> {ticker, currency, qty_net, cost_basis_usd}}
    trade_state: dict[str, dict] = {}
    # Cash state (EUR)
    current_cash_eur = 0.0

    # Index exec_logs by date
    log_idx = 0
    num_logs = len(exec_logs)

    nav_data = []
    assets_data = []
    cash_quote_data = []
    pnl_data = []

    # Build daily PnL map from trade_performance (closed trades only)
    daily_realized_pnl = defaultdict(float)
    for t in trade_perf:
        if t.get("is_closed") and t.get("close_time"):
            d = t["close_time"][:10]
            daily_realized_pnl[d] += float(t.get("net_pnl_eur") or 0.0)

    logger.info(f"Iterating {(end_dt - start_dt).days + 1} calendar days...")
    curr_date = start_dt

    while curr_date <= end_dt:
        curr_date_str = curr_date.strftime("%Y-%m-%d")

        # Process all events up to and including curr_date
        while log_idx < num_logs:
            ev = exec_logs[log_idx]
            ev_dt = datetime.datetime.fromisoformat(
                ev["created_at"].replace("Z", "+00:00")
            ).date()
            if ev_dt > curr_date:
                break

            action = ev.get("action")
            qty = float(ev.get("quantity") or 0.0)
            price = float(ev.get("price") or 0.0)
            comm = float(ev.get("commission") or 0.0)
            ticker = ev.get("ticker", "")
            currency = ev.get("currency", "EUR")
            trade_id = ev.get("trade_id", "")
            ev_date_str = ev_dt.strftime("%Y-%m-%d")

            rate = get_fx(fx, currency, ev_date_str)
            if rate == 0:
                rate = 1.0

            if ev["event_type"] == "CASH_TRANSFER":
                if action == "DEPOSIT":
                    current_cash_eur += qty / rate
                elif action == "WITHDRAW":
                    current_cash_eur -= qty / rate

            elif ev["event_type"] == "FILL":
                val_eur = (qty * price) / rate
                comm_eur = comm / rate

                if trade_id not in trade_state:
                    trade_state[trade_id] = {
                        "ticker": ticker,
                        "currency": currency,
                        "net_qty": 0.0,
                        "cost_basis_eur": 0.0,
                    }

                ts = trade_state[trade_id]

                if action == "BUY":
                    current_cash_eur -= (val_eur + comm_eur)
                    ts["net_qty"] += qty
                    ts["cost_basis_eur"] += val_eur  # track cost for shorts
                elif action == "SELL":
                    current_cash_eur += (val_eur - comm_eur)
                    ts["net_qty"] -= qty
                    if ts["net_qty"] < 0:
                        # Short sale: track proceeds as negative cost basis
                        ts["cost_basis_eur"] -= val_eur

                # Clean up fully closed trades (with tolerance)
                if abs(ts["net_qty"]) < 0.001:
                    del trade_state[trade_id]

            log_idx += 1

        # End-of-day valuation
        asset_value_eur = 0.0
        for tid, ts in trade_state.items():
            if abs(ts["net_qty"]) < 0.001:
                continue
            ticker = ts["ticker"]
            currency = ts["currency"]
            qty = ts["net_qty"]
            px = get_price(prices, ticker, curr_date_str)
            rate = get_fx(fx, currency, curr_date_str)
            if rate == 0:
                rate = 1.0
            # For longs: mark to market. For shorts: liability = -qty * price.
            asset_value_eur += (qty * px) / rate

        nav = current_cash_eur + asset_value_eur
        cash_quote = (current_cash_eur / nav * 100.0) if nav != 0 else 0.0
        pnl_val = daily_realized_pnl.get(curr_date_str, 0.0)

        # Only emit rows after first deposit
        if current_cash_eur != 0 or asset_value_eur != 0:
            ts_ms = int(
                datetime.datetime.combine(
                    curr_date, datetime.time(23, 59, 59), tzinfo=datetime.timezone.utc
                ).timestamp() * 1000
            )
            nav_data.append({"timestamp": ts_ms, "open": nav, "high": nav, "low": nav, "close": nav, "volume": 0.0})
            assets_data.append({"timestamp": ts_ms, "open": asset_value_eur, "high": asset_value_eur, "low": asset_value_eur, "close": asset_value_eur, "volume": 0.0})
            cash_quote_data.append({"timestamp": ts_ms, "open": cash_quote, "high": cash_quote, "low": cash_quote, "close": cash_quote, "volume": 0.0})
            pnl_data.append({"timestamp": ts_ms, "open": pnl_val, "high": pnl_val, "low": pnl_val, "close": pnl_val, "volume": 0.0})

        curr_date += datetime.timedelta(days=1)

    logger.info(f"Generated {len(nav_data)} daily data points.")
    if nav_data:
        last = nav_data[-1]
        logger.info(f"Latest NAV: {last['close']:.2f} EUR  (date: {datetime.datetime.fromtimestamp(last['timestamp']/1000, tz=datetime.timezone.utc).date()})")

    # 4. Save to Parquet
    logger.info("Saving Parquet files...")
    db = duckdb.connect()
    save_parquet(db, "$STATS.NAV", nav_data, PARQUET_BASE)
    save_parquet(db, "$STATS.ASSETS_VALUE", assets_data, PARQUET_BASE)
    save_parquet(db, "$STATS.CASH_QUOTE", cash_quote_data, PARQUET_BASE)
    save_parquet(db, "$STATS.PNL", pnl_data, PARQUET_BASE)
    db.close()

    logger.info("=== Done! ===")


if __name__ == "__main__":
    main()
