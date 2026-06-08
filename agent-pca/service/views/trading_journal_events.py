import os
import httpx
import logging
import datetime
from pathlib import Path
from collections import defaultdict
import duckdb
from fastapi import HTTPException

logger = logging.getLogger("pca.views.trading_journal_events")
postgrest_url = os.environ.get("POSTGREST_URL", "http://postgrest:3000")
PARQUET_BASE = Path(os.environ.get("PARQUET_BASE_PATH", "/parquet"))

def _parquet_path(symbol: str, timeframe: str) -> Path:
    return PARQUET_BASE / symbol.upper() / f"{timeframe}.parquet"

def get_chart_data_events(symbol: str, timeframe: str, limit: int) -> dict:
    columns = ["timestamp", "open", "high", "low", "close", "volume"]
    
    try:
        # Fetch execution logs
        r = httpx.get(f"{postgrest_url}/pta_execution_log?event_type=in.(FILL,CASH_TRANSFER)&order=created_at.asc&limit=50000")
        r.raise_for_status()
        exec_logs = r.json()
        
        # Fetch trade history for the events
        r_trades = httpx.get(f"{postgrest_url}/pta_trade_history?order=close_time.asc&limit=50000")
        r_trades.raise_for_status()
        trades = r_trades.json()
        
        # Fetch FX rates
        r_rates = httpx.get(f"{postgrest_url}/exchange_rates?base_currency=eq.EUR&order=date.asc&limit=50000")
        r_rates.raise_for_status()
        rates_data = r_rates.json()
    except Exception as e:
        logger.exception("Failed to fetch data from DB: %s", e)
        raise HTTPException(status_code=500, detail="Failed to fetch stats data")

    if not exec_logs or not trades:
        return {"symbol": symbol, "timeframe": timeframe, "count": 0, "columns": columns, "data": []}

    # Prepare FX rates
    fx = defaultdict(dict)
    for r_item in rates_data:
        curr = r_item["target_currency"]
        d = r_item["date"][:10]
        fx[curr][d] = float(r_item["rate"])
        
    def get_fx(curr, target_date):
        if curr == "EUR" or not curr: return 1.0
        dates = sorted([d for d in fx[curr].keys() if d <= target_date])
        if dates: return fx[curr][dates[-1]]
        all_dates = sorted(fx[curr].keys())
        if all_dates: return fx[curr][all_dates[0]]
        return 1.0

    # Load Prices
    ticker_currency = {}
    for ev in exec_logs:
        if ev.get("ticker") and ev.get("currency"):
            ticker_currency[ev["ticker"]] = ev["currency"]
    tickers = set(ticker_currency.keys())
    prices = defaultdict(dict)
    
    try:
        db = duckdb.connect()
        for t in tickers:
            p = _parquet_path(t, "1D")
            if p.exists():
                try:
                    res = db.execute(f"SELECT timestamp, close FROM read_parquet('{p}') WHERE close IS NOT NULL").fetchall()
                    for row in res:
                        ts = row[0]
                        if ts > 10000000000:
                            ts = ts / 1000.0
                        dt_str = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).strftime("%Y-%m-%d")
                        prices[t][dt_str] = float(row[1])
                except Exception as e:
                    logger.error(f"Error reading {p}: {e}")
        db.close()
    except Exception as e:
        logger.error(f"Duckdb error: {e}")

    def get_price(t, target_date):
        dates = sorted([d for d in prices[t].keys() if d <= target_date])
        if dates: return prices[t][dates[-1]]
        return 0.0

    # Build Events
    valid_trades = [t for t in trades if t.get("close_time")]
    
    current_cash = 0.0
    positions = defaultdict(float)
    
    data = []
    log_idx = 0
    num_logs = len(exec_logs)
    
    for t in valid_trades:
        close_dt = datetime.datetime.fromisoformat(t["close_time"].replace("Z", "+00:00"))
        
        # Advance execution logs up to this close_time
        while log_idx < num_logs:
            ev = exec_logs[log_idx]
            ev_dt = datetime.datetime.fromisoformat(ev["created_at"].replace("Z", "+00:00"))
            if ev_dt > close_dt:
                break
                
            action = ev.get("action")
            qty = float(ev.get("quantity") or 0.0)
            price = float(ev.get("price") or 0.0)
            comm = float(ev.get("commission") or 0.0)
            ticker = ev.get("ticker")
            currency = ev.get("currency")
            
            rate = get_fx(currency, ev_dt.strftime("%Y-%m-%d"))
            if rate == 0: rate = 1.0
            val_eur = (qty * price) / rate
            comm_eur = comm / rate
            
            if ev["event_type"] == "CASH_TRANSFER":
                if action == "DEPOSIT":
                    current_cash += (qty / rate)
                elif action == "WITHDRAW":
                    current_cash -= (qty / rate)
            elif ev["event_type"] == "FILL":
                if action == "BUY":
                    current_cash -= (val_eur + comm_eur)
                    positions[ticker] += qty
                elif action == "SELL":
                    current_cash += (val_eur - comm_eur)
                    positions[ticker] -= qty
                    
                if positions[ticker] <= 0.0001:
                    del positions[ticker]
                    
            log_idx += 1
            
        # Calculate snapshot at this event
        curr_date_str = close_dt.strftime("%Y-%m-%d")
        asset_value = 0.0
        for pos_t, q in positions.items():
            px = get_price(pos_t, curr_date_str)
            r = get_fx(ticker_currency.get(pos_t, "EUR"), curr_date_str)
            if r == 0: r = 1.0
            asset_value += (q * px) / r
            
        nav = current_cash + asset_value
        cash_quote = (current_cash / nav * 100.0) if nav > 0 else 0.0
        
        if symbol == "$STATS.NAV":
            val = nav
        elif symbol == "$STATS.ASSETS_VALUE":
            val = asset_value
        elif symbol == "$STATS.CASH_QUOTE":
            val = cash_quote
        elif symbol == "$STATS.PNL":
            val = float(t.get("pnl_net", 0.0))
        else:
            val = 0.0
            
        ts_sec = int(close_dt.timestamp())
        data.append([ts_sec, val, val, val, val, 0])

    if limit > 0:
        data = data[-limit:]

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "count": len(data),
        "columns": columns,
        "data": data
    }
