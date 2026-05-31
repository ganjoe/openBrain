"""
chart_data.py — DuckDB-powered chart data endpoint.
Reads OHLCV and feature data directly from Parquet files via DuckDB Arrow scan.
No API overhead — direct filesystem access via shared volume.
"""
import os
import logging
from pathlib import Path

import duckdb
from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger("pca.chart_data")
router = APIRouter()

# Mounted from stock-data-node via Docker shared volume (read-only)
PARQUET_BASE = Path(os.environ.get("PARQUET_BASE_PATH", "/parquet"))


def _parquet_path(symbol: str, timeframe: str, features: bool = False) -> Path:
    suffix = f"{timeframe}_features" if features else timeframe
    return PARQUET_BASE / symbol.upper() / f"{suffix}.parquet"


@router.get("/chartdata")
async def get_chart_data(
    symbol: str = Query(..., description="Ticker symbol, e.g. AAPL"),
    timeframe: str = Query(default="1D", description="Timeframe, e.g. 1D, 1H"),
    limit: int = Query(default=500, ge=1, le=5000, description="Number of bars to return (newest N)"),
    features: bool = Query(default=True, description="Include pre-computed feature columns if available"),
):
    """
    Returns OHLCV bars for the requested ticker/timeframe.
    Optionally merges feature columns from the _features.parquet file.

    Response format:
    {
        "symbol": "AAPL",
        "timeframe": "1D",
        "count": 250,
        "columns": ["timestamp", "open", "high", "low", "close", "volume", "ma_sma_50", ...],
        "data": [[ts, o, h, l, c, v, sma50, ...], ...]  // row-oriented for canvas renderer
    }
    """
    symbol = symbol.upper()
    
    if symbol.startswith("$STATS."):
        import httpx
        import datetime
        postgrest_url = os.environ.get("POSTGREST_URL", "http://postgrest:3000")
        columns = ["timestamp", "open", "high", "low", "close", "volume"]
        
        if symbol == "$STATS.CASH_QUOTE":
            try:
                r = httpx.get(f"{postgrest_url}/pta_execution_log?event_type=in.(FILL,CASH_TRANSFER)&order=created_at.asc")
                r.raise_for_status()
                exec_logs = r.json()
                
                r_rates = httpx.get(f"{postgrest_url}/exchange_rates?base_currency=eq.EUR&order=date.desc")
                rates_data = r_rates.json()
                latest_rates = {}
                for r_item in rates_data:
                    tc = r_item["target_currency"]
                    if tc not in latest_rates:
                        latest_rates[tc] = float(r_item["rate"])
            except Exception as e:
                logger.exception("Failed to fetch execution logs from DB: %s", e)
                raise HTTPException(status_code=500, detail="Failed to fetch execution logs")
                
            data = []
            cash = 0.0
            positions = {}
            for ev in exec_logs:
                action = ev.get("action")
                qty = float(ev.get("quantity") or 0.0)
                price = float(ev.get("price") or 0.0)
                comm = float(ev.get("commission") or 0.0)
                ticker = ev.get("ticker")
                currency = ev.get("currency")
                
                # Convert to EUR using latest known rate
                rate = 1.0
                if currency and currency != "EUR":
                    rate = latest_rates.get(currency, 1.0)
                    
                val_eur = (qty * price) / rate
                comm_eur = comm / rate
                
                if ev["event_type"] == "CASH_TRANSFER":
                    if action == "DEPOSIT":
                        cash += (qty / rate) # Deposit qty is in native currency
                    elif action == "WITHDRAW":
                        cash -= (qty / rate)
                elif ev["event_type"] == "FILL":
                    if action == "BUY":
                        cash -= (val_eur + comm_eur)
                        if ticker not in positions:
                            positions[ticker] = {"qty": 0.0, "cost": 0.0}
                        positions[ticker]["qty"] += qty
                        positions[ticker]["cost"] += val_eur
                    elif action == "SELL":
                        cash += (val_eur - comm_eur)
                        if ticker in positions and positions[ticker]["qty"] > 0:
                            avg_cost = positions[ticker]["cost"] / positions[ticker]["qty"]
                            positions[ticker]["qty"] -= qty
                            positions[ticker]["cost"] -= qty * avg_cost
                            if positions[ticker]["qty"] <= 0.0001:
                                del positions[ticker]
                
                nav = cash + sum(p["cost"] for p in positions.values())
                cash_quote = (cash / nav * 100.0) if nav > 0 else 0.0
                num_pos = len(positions)
                
                dt = datetime.datetime.fromisoformat(ev["created_at"].replace("Z", "+00:00"))
                ts_ms = int(dt.timestamp())
                data.append([ts_ms, cash_quote, cash_quote, cash_quote, cash_quote, num_pos])
            
            if limit > 0:
                data = data[-limit:]
            return {"symbol": symbol, "timeframe": timeframe, "count": len(data), "columns": columns, "data": data}

        try:
            r = httpx.get(f"{postgrest_url}/pta_trade_history?order=close_time.asc")
            r.raise_for_status()
            trades = r.json()
        except Exception as e:
            logger.exception("Failed to fetch trade stats from DB: %s", e)
            raise HTTPException(status_code=500, detail="Failed to fetch trade stats")
            
        columns = ["timestamp", "open", "high", "low", "close", "volume"]
        data = []
        
        for t in trades:
            close_time = t.get("close_time")
            if not close_time:
                continue
            
            # format timestamp in seconds for canvas renderer
            dt = datetime.datetime.fromisoformat(close_time.replace("Z", "+00:00"))
            ts_ms = int(dt.timestamp())
            
            val = 0.0
            if symbol == "$STATS.PNL":
                val = t.get("running_net_pnl_eur") or 0.0
                trade_pnl = t.get("net_pnl_eur") or 0.0
                data.append([ts_ms, val, val, val, val, trade_pnl])
            elif symbol == "$STATS.RMULTIPLE":
                val = t.get("r_multiple") or 0.0
                data.append([ts_ms, 0, val if val > 0 else 0, val if val < 0 else 0, val, 0])
            elif symbol == "$STATS.DRAWDOWN":
                val = t.get("current_drawdown_eur") or 0.0
                data.append([ts_ms, val, val, val, val, 0])
            elif symbol == "$STATS.WINRATE":
                val = t.get("running_winrate") or 0.0
                data.append([ts_ms, val, val, val, val, 0])
            elif symbol == "$STATS.PROFIT_FACTOR":
                val = t.get("running_profit_factor")
                if val is None:
                    continue
                data.append([ts_ms, val, val, val, val, 0])
            elif symbol == "$STATS.WINRATE_PF":
                winrate = t.get("running_winrate") or 0.0
                pf = t.get("running_profit_factor")
                if pf is None:
                    continue
                data.append([ts_ms, winrate, winrate, winrate, winrate, pf])
        
        if limit > 0:
            data = data[-limit:]
            
        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "count": len(data),
            "columns": columns,
            "data": data,
        }

    ohlcv_path = _parquet_path(symbol, timeframe, features=False)
    features_path = _parquet_path(symbol, timeframe, features=True)

    if not ohlcv_path.exists():
        raise HTTPException(status_code=404, detail=f"No data for {symbol}/{timeframe}")

    try:
        conn = duckdb.connect(database=":memory:", read_only=False)

        if features and features_path.exists():
            # JOIN on timestamp — features file has same length and index as OHLCV
            query = f"""
                SELECT o.*, f.* EXCLUDE (timestamp, open, high, low, close, volume)
                FROM read_parquet('{ohlcv_path}') o
                LEFT JOIN read_parquet('{features_path}') f
                  ON o.timestamp = f.timestamp
                ORDER BY o.timestamp ASC
                LIMIT {limit} OFFSET GREATEST(
                    (SELECT COUNT(*) FROM read_parquet('{ohlcv_path}')) - {limit}, 0
                )
            """
        else:
            query = f"""
                SELECT timestamp, open, high, low, close, volume
                FROM read_parquet('{ohlcv_path}')
                ORDER BY timestamp ASC
                LIMIT {limit} OFFSET GREATEST(
                    (SELECT COUNT(*) FROM read_parquet('{ohlcv_path}')) - {limit}, 0
                )
            """

        result = conn.execute(query).fetchall()
        col_names = [d[0] for d in conn.execute(query).description]

        # Re-execute cleanly to get both description and data
        rel = conn.execute(query)
        col_names = [d[0] for d in rel.description]
        rows = rel.fetchall()

        conn.close()

    except Exception as e:
        logger.exception("DuckDB error for %s/%s: %s", symbol, timeframe, e)
        raise HTTPException(status_code=500, detail=f"Data read error: {str(e)}")

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "count": len(rows),
        "columns": col_names,
        "data": [list(row) for row in rows],
    }


@router.get("/symbols")
async def list_symbols():
    """Returns all ticker symbols that have parquet data available."""
    if not PARQUET_BASE.exists():
        return {"symbols": []}
    symbols = sorted([p.name for p in PARQUET_BASE.iterdir() if p.is_dir()])
    return {"symbols": symbols, "count": len(symbols)}
