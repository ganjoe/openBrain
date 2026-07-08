import os
import json
import time
import concurrent.futures
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, Dict, Any
from risk_engine import PortfolioObject, TradeObject, PortfolioRepository
from supabase import create_client, Client
import requests
import pandas as pd
from datetime import datetime, timezone
import paho.mqtt.publish as publish
import sys
sys.path.append("/app")
from backtesting.engine import BacktestEngine
from backtesting.data_loader import load_watchlist, load_ohlcv, load_bt_config
from backtesting.winner_attribution import attribute_winner_performance

TELEMETRY_URL = os.environ.get("TELEMETRY_URL", "http://nexus-service:7734/api/send")
MQTT_BROKER_HOST = os.environ.get("MQTT_BROKER_HOST", "nexus-broker")
MQTT_BROKER_PORT = int(os.environ.get("MQTT_BROKER_PORT", "1883"))

def broadcast_load_ticker(ticker: str):
    payload = json.dumps({"action": "load_ticker", "symbol": ticker.upper()})
    try:
        publish.single("agents/pca/commands", payload, hostname=MQTT_BROKER_HOST, port=MQTT_BROKER_PORT)
    except Exception as e:
        print(f"MQTT publish failed: {e}")

def send_telemetry(text: str):
    payload = {
        "from_agent": "srm",
        "to": "system",
        "text": text,
        "msg_type": "telemetry"
    }
    try:
        requests.post(TELEMETRY_URL, json=payload, timeout=2)
    except Exception as e:
        print(f"Telemetry failed: {e}")

def _run_backtest_combo(args):
    combo, ticker_data, risk_pct, initial_capital, position_size_pct, start_date, end_date = args
    f, s, sma, thresh, enter_n, exit_n, vperiod, vmult = combo
    
    config = {
        "ema_fast": f,
        "ema_slow": s,
        "trend_sma_period": sma,
        "trend_threshold": thresh,
        "setup_count_enter_n": enter_n,
        "setup_count_exit_n": exit_n,
        "risk_pct": risk_pct,
        "initial_capital": initial_capital,
        "min_tick": 0.01,
        "commission": 2.0,
        "position_size_pct": position_size_pct,
        "vstop_period": vperiod,
        "vstop_multiplier": vmult,
        "start_date": start_date,
        "end_date": end_date
    }
    
    engine = BacktestEngine(config)
    res = engine.run(ticker_data)
    
    ret_pct = ((res.final_capital / initial_capital) - 1) * 100
    
    return {
        "ema_fast": f,
        "ema_slow": s,
        "sma": sma,
        "thresh": thresh,
        "enter_n": enter_n,
        "exit_n": exit_n,
        "vperiod": vperiod,
        "vmult": vmult,
        "trades": res.total_trades,
        "winrate": res.win_rate,
        "pnl": res.total_pnl,
        "return_pct": ret_pct,
        "max_dd": res.max_drawdown,
        "profit_factor": res.profit_factor if res.profit_factor != float('inf') else 999.0
    }

app = FastAPI(title="SRM Risk Engine MCP Server")

# Initialize Supabase
SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://gateway:80")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

try:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
except Exception as e:
    print(f"Failed to initialize Supabase: {e}")
    supabase = None

class JsonRpcRequest(BaseModel):
    jsonrpc: str
    method: str
    params: Dict[str, Any]
    id: Optional[int] = None

def error_response(req_id, message):
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {
            "code": -32601,
            "message": message
        }
    }



@app.post("/")
async def handle_mcp_request(req: JsonRpcRequest):
    if req.method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req.id,
            "result": {
                "tools": [
                    {
                        "name": "simulate_trade",
                        "description": "Calculate position size limits and simulate portfolio impact for a planned trade.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "ticker": {"type": "string", "description": "Stock ticker (e.g. HOOD)"},
                                "price": {"type": "number", "description": "Current or planned entry price"},
                                "sl": {"type": "number", "description": "Stop loss price"},
                                "tp": {"type": "number", "description": "Optional: Take Profit price (Required if target_r is omitted)"},
                                "target_r": {"type": "number", "description": "Optional: Target R multiple (Required if tp is omitted)"},
                                "nos": {"type": "number", "description": "Optional: Number of shares to simulate. If omitted, returns max limits."},
                                "commission": {"type": "number", "description": "Optional: Estimated commission in currency."}
                            },
                            "required": ["ticker", "price", "sl"]
                        }
                    },
                    {
                        "name": "commit_trade",
                        "description": "Commit/save a planned trade to the database and update portfolio balances.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "ticker": {"type": "string", "description": "Stock ticker (e.g. HOOD)"},
                                "price": {"type": "number", "description": "Entry price"},
                                "sl": {"type": "number", "description": "Stop loss price"},
                                "tp": {"type": "number", "description": "Optional: Take Profit price"},
                                "target_r": {"type": "number", "description": "Optional: Target R multiple"},
                                "nos": {"type": "number", "description": "Number of shares to buy"},
                                "commission": {"type": "number", "description": "Optional: Estimated commission in currency."},
                                "execute_asap": {"type": "boolean", "description": "If true, sets status to pending for immediate execution. If false, status is planned."},
                                "planned_date": {"type": "string", "description": "Optional: Specific date to plan the trade, format YYYY-MM-DD."}
                            },
                            "required": ["ticker", "price", "sl", "nos"]
                        }
                    },
                    {
                        "name": "update_stoploss",
                        "description": "Update the stop loss for an active trade. Use either trade_id or ticker to identify the trade.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "trade_id": {"type": "number", "description": "Optional: ID of the trade to update"},
                                "ticker": {"type": "string", "description": "Optional: Ticker symbol (e.g. WULF). Used to look up the active trade if trade_id is not provided."},
                                "new_sl": {"type": "number", "description": "New stop loss price"},
                                "date": {"type": "string", "description": "Optional: Date of the update (YYYY-MM-DD). Defaults to today."}
                            },
                            "required": ["new_sl"]
                        }
                    },
                    {
                        "name": "commit_transaction",
                        "description": "Log a cash deposit or withdrawal as a closed trade.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "type": {"type": "string", "description": "DEPOSIT or WITHDRAWAL"},
                                "amount": {"type": "number", "description": "Amount in currency (positive)."},
                                "date": {"type": "string", "description": "Date of transaction, format YYYY-MM-DD"}
                            },
                            "required": ["type", "amount", "date"]
                        }
                    },
                    {
                        "name": "get_portfolio",
                        "description": "Get current portfolio state, balances, and risk parameters (heat and crisk allowed).",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "target_date": {"type": "string", "description": "Optional: Date to get portfolio status for, format YYYY-MM-DD. Defaults to today."}
                            },
                            "required": []
                        }
                    },
                    {
                        "name": "run_backtest",
                        "description": "Run a historical backtest simulation using the Trend Strength + Setup Counter strategy.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "config_id": {"type": "integer", "description": "Optional: Load base configuration parameters from bt_configs by ID."},
                                "watchlist": {"type": "string", "description": "Optional: Watchlist name (e.g. 'growth_stocks')."},
                                "ticker": {"type": "string", "description": "Optional: Single ticker (e.g. 'AAPL') to test instead of a watchlist."},
                                "ema_fast": {"type": "integer", "description": "Optional: Override fast EMA period."},
                                "ema_slow": {"type": "integer", "description": "Optional: Override slow EMA period."},
                                "trend_sma_period": {"type": "integer", "description": "Optional: Override trend strength SMA period."},
                                "trend_threshold": {"type": "number", "description": "Optional: Override static threshold for trend filter."},
                                "setup_count_enter_n": {"type": "integer", "description": "Optional: Override setup entry counting consecutive days (N)."},
                                "setup_count_exit_n": {"type": "integer", "description": "Optional: Override setup exit counting consecutive days (N)."},
                                "risk_pct": {"type": "number", "description": "Optional: Override risk percent per trade (decimal, e.g. 0.01)."},
                                "initial_capital": {"type": "number", "description": "Optional: Override initial starting capital (default 10000)."},
                                "min_tick": {"type": "number", "description": "Optional: Override minimum tick range fallback (default 0.01)."},
                                "commission": {"type": "number", "description": "Optional: Override commission per order (default 2.00)."},
                                "start_date": {"type": "string", "description": "Optional: Override start date (YYYY-MM-DD)."},
                                "end_date": {"type": "string", "description": "Optional: Override end date (YYYY-MM-DD)."},
                                "position_size_pct": {"type": "number", "description": "Optional: Override maximum position sizing cap as percent of NAV (default 10)."},
                                "vstop_period": {"type": "integer", "description": "Optional: Override volatility stop ATR period (default 14)."},
                                "vstop_multiplier": {"type": "number", "description": "Optional: Override volatility stop ATR multiplier (default 2.0)."}
                            }
                        }
                    },
                    {
                        "name": "run_batch_optimization",
                        "description": "Run a batch grid search backtest over multiple parameter combinations. Runs in-memory and returns a sorted markdown table of the top results.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "watchlist": {"type": "string", "description": "Optional: Watchlist name (e.g. 'growth_stocks')."},
                                "ticker": {"type": "string", "description": "Optional: Single ticker to test instead of a watchlist."},
                                "ema_fast_list": {"type": "array", "items": {"type": "integer"}, "description": "Array of fast EMA periods to test."},
                                "ema_slow_list": {"type": "array", "items": {"type": "integer"}, "description": "Array of slow EMA periods to test."},
                                "trend_sma_period_list": {"type": "array", "items": {"type": "integer"}, "description": "Array of trend strength SMA periods to test."},
                                "trend_threshold_list": {"type": "array", "items": {"type": "number"}, "description": "Array of thresholds to test."},
                                "setup_count_enter_n_list": {"type": "array", "items": {"type": "integer"}, "description": "Array of setup entry consecutive days (N) to test."},
                                "setup_count_exit_n_list": {"type": "array", "items": {"type": "integer"}, "description": "Array of setup exit consecutive days (N) to test."},
                                "risk_pct": {"type": "number", "description": "Optional: Risk percent per trade (decimal, e.g. 0.01)."},
                                "initial_capital": {"type": "number", "description": "Optional: Initial starting capital (default 10000)."},
                                "start_date": {"type": "string", "description": "Optional: Start date (YYYY-MM-DD)."},
                                "end_date": {"type": "string", "description": "Optional: End date (YYYY-MM-DD)."},
                                "position_size_pct": {"type": "number", "description": "Optional: Maximum position sizing cap as percent of NAV (default 10)."},
                                "vstop_period_list": {"type": "array", "items": {"type": "integer"}, "description": "Array of ATR periods to test."},
                                "vstop_multiplier_list": {"type": "array", "items": {"type": "number"}, "description": "Array of ATR multipliers to test."}
                            }
                        }
                    },
                    {
                        "name": "manage_local_watchlist",
                        "description": "List, read, or archive local watchlist text files from /backtesting/lists/.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "action": {"type": "string", "enum": ["LIST", "READ", "ARCHIVE", "CREATE"], "description": "The action to perform."},
                                "filename": {"type": "string", "description": "Optional: Watchlist filename (e.g. 'my_list.txt') for READ, ARCHIVE, or CREATE."},
                                "content": {"type": "string", "description": "Optional: The content (ticker list, newline separated) when using CREATE action."}
                            },
                            "required": ["action"]
                        }
                    },
                    {
                        "name": "attribute_winner_performance",
                        "description": "Analyze a finished backtest run and attribute the winners to ticker-level features. Computes per-ticker Parquet-derived features (avg_volume_20d, atr_pct, price_level, vol_of_vol, adx_proxy, setup_density), joins them with per-ticker performance (win_rate, avg_r_multiple, total_pnl), and returns a Spearman rank-correlation matrix plus a winner-vs-loser median-split group comparison. Use this AFTER a run_backtest to investigate which stock characteristics correlate with profitability in this strategy.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "run_id": {"type": "integer", "description": "The bt_runs.run_id to analyze. Must reference a run with status='completed' and at least one row in bt_trades."}
                            },
                            "required": ["run_id"]
                        }
                    }
                ]
            }
        }
    
    if req.method == "tools/call":
        tool_name = req.params.get("name")
        args = req.params.get("arguments", {})
        
        if tool_name == "manage_local_watchlist":
            action = args.get("action")
            filename = args.get("filename")
            content = args.get("content")
            import shutil
            base_dir = "/app/backtesting/lists"
            
            try:
                if action == "LIST":
                    if not os.path.exists(base_dir):
                        os.makedirs(base_dir, exist_ok=True)
                    files = [f for f in os.listdir(base_dir) if f.endswith(".txt")]
                    return {
                        "jsonrpc": "2.0",
                        "id": req.id,
                        "result": {
                            "content": [{"type": "text", "text": f"Found watchlists: {files}"}]
                        }
                    }
                elif action == "READ":
                    if not filename:
                        return error_response(req.id, "filename is required for READ")
                    path = os.path.join(base_dir, filename)
                    with open(path, "r", encoding="utf-8") as f:
                        content = f.read()
                    return {
                        "jsonrpc": "2.0",
                        "id": req.id,
                        "result": {
                            "content": [{"type": "text", "text": f"Contents of {filename}:\n{content}"}]
                        }
                    }
                elif action == "CREATE":
                    if not filename or not content:
                        return error_response(req.id, "filename and content are required for CREATE")
                    path = os.path.join(base_dir, filename)
                    with open(path, "w", encoding="utf-8") as f:
                        f.write(content)
                    return {
                        "jsonrpc": "2.0",
                        "id": req.id,
                        "result": {
                            "content": [{"type": "text", "text": f"Successfully created {filename} with the provided tickers."}]
                        }
                    }
                elif action == "ARCHIVE":
                    if not filename:
                        return error_response(req.id, "filename is required for ARCHIVE")
                    src = os.path.join(base_dir, filename)
                    dst = os.path.join(base_dir, "old", filename)
                    if not os.path.exists(os.path.dirname(dst)):
                        os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.move(src, dst)
                    return {
                        "jsonrpc": "2.0",
                        "id": req.id,
                        "result": {
                            "content": [{"type": "text", "text": f"Successfully archived {filename} to old/."}]
                        }
                    }
                else:
                    return error_response(req.id, "Invalid action")
            except Exception as e:
                return error_response(req.id, f"Error managing watchlist: {str(e)}")

        elif tool_name == "get_portfolio":
            try:
                target_date_arg = args.get("target_date")
                if target_date_arg:
                    target_date_val = pd.to_datetime(target_date_arg, utc=True).isoformat()
                else:
                    target_date_val = datetime.now(timezone.utc).isoformat()
                    
                portfolio = PortfolioRepository.load_portfolio_and_trades(supabase, target_date_val)
                portfolio.recalculate_totals()
                
                PortfolioRepository.save_portfolio(supabase, portfolio)
                
                portfolio_info = {
                    "nav": portfolio.nav,
                    "cash": portfolio.cash,
                    "cash_pct": (portfolio.cash / portfolio.nav * 100) if portfolio.nav > 0 else 0.0,
                    "current_heat_pct": portfolio.current_heat_pct,
                    "max_heat_pct": portfolio.max_heat_pct,
                    "available_heat_pct": portfolio.get_available_heat_pct(),
                    "available_heat_eur": portfolio.get_available_heat_eur(),
                    "max_crisk_pct_per_trade": portfolio.max_crisk_pos_pct,
                    "max_crisk_eur_per_trade": portfolio.get_max_crisk_pos_eur(),
                    "current_crisk_pct": portfolio.current_crisk_pct,
                    "available_crisk_eur": portfolio.get_available_crisk_eur(),
                    "min_r": portfolio.min_r,
                    "max_days": portfolio.max_days,
                    "max_crisk_pos_pct": portfolio.max_crisk_pos_pct,
                    "current_positions": portfolio.current_positions,
                    "max_positions": portfolio.max_positions
                }
                
                telemetry_msg = (f"📈 **Portfolio Status**\n"
                                 f"NAV: {round(portfolio.nav, 2)} EUR | Cash: {round(portfolio.cash, 2)} EUR\n"
                                 f"Heat: {round(portfolio.current_heat_pct, 2)}% / {round(portfolio.max_heat_pct, 2)}% (Frei: {round(portfolio.get_available_heat_pct(), 2)}%)\n"
                                 f"Max Risk/Trade: {round(portfolio.max_crisk_pct, 2)}%\n"
                                 f"Positionen: {portfolio.current_positions}/{portfolio.max_positions}")
                send_telemetry(telemetry_msg)
                
                return {
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "result": {
                        "content": [
                            {"type": "text", "text": json.dumps(portfolio_info, indent=2)}
                        ]
                    }
                }
            except Exception as e:
                return error_response(req.id, f"Error getting portfolio: {str(e)}")

        elif tool_name == "simulate_trade":
            try:
                planned_date_arg = args.get("planned_date")
                if planned_date_arg:
                    planned_date_val = pd.to_datetime(planned_date_arg, utc=True).isoformat()
                else:
                    planned_date_val = datetime.now(timezone.utc).isoformat()
                    
                portfolio = PortfolioRepository.load_portfolio_and_trades(supabase, planned_date_val)
                portfolio.recalculate_totals()
                
                # Build trade dict from args to initialize TradeObject
                trade_data = {
                    "ticker": args.get("ticker"),
                    "price": args.get("price"),
                    "sl": args.get("sl"),
                    "tp": args.get("tp"),
                    "target_r": args.get("target_r"),
                    "commission": args.get("commission", 0.0)
                }
                
                trade = TradeObject(trade_data)
                nos = args.get("nos")
                if nos is not None:
                    nos = int(nos)
                    
                impact = trade.validate(portfolio, requested_nos=nos)
                
                if "error" in impact:
                    err_msg = impact.get("message", impact["error"])
                    telemetry_msg = f"❌ **Simulation fehlgeschlagen**: {err_msg}"
                elif impact.get("status") == "discovery_success":
                    limits = impact.get('limiting_factors', {})
                    telemetry_msg = (f"🔍 **Risiko-Limits für {impact['ticker']} (Preis: {impact['price']}, SL: {impact['stop_loss']})**\n"
                                     f"- **Ziel**: TP {impact.get('take_profit', '?')}$ ({impact.get('target_r', '?')}R)\n"
                                     f"- **Max. erlaubte Shares**: {impact['max_allowed_shares']}\n"
                                     f"- *Position Core Risk Limit*: {limits.get('Position Core Risk Limit')}\n"
                                     f"- *Portfolio Core Risk Limit*: {limits.get('Portfolio Core Risk Limit')}\n"
                                     f"- *Portfolio Heat Limit*: {limits.get('Portfolio Heat Limit')}\n"
                                     f"- *Cash Limit*: {limits.get('Cash Limit')}\n"
                                     f"- *Positions Limit*: {limits.get('Max Positions Limit')}\n\n")
                    
                    p = impact.get('portfolio_impact', {})
                    if p:
                        telemetry_msg += (f"📊 **Simulierter Portfolio Impact bei {impact['max_allowed_shares']} Shares**\n"
                                          f"- **Cash**: {p.get('cash_before')} -> {p.get('cash_after')} ({p.get('cash_delta')})\n"
                                          f"- **Cash Quote**: {p.get('cash_pct_before')} -> {p.get('cash_pct_after')}\n"
                                          f"- **Heat Quote**: {p.get('heat_pct_before')} -> {p.get('heat_pct_after')} ({p.get('heat_pct_delta')})\n"
                                          f"- **Trade Cost**: {impact.get('trade_cost_eur')} EUR\n"
                                          f"- **Trade Core Risk**: {p.get('trade_crisk_eur')} EUR ({p.get('trade_crisk_pct')})")
                else:
                    p = impact.get('portfolio_impact', {})
                    telemetry_msg = (f"📊 **Portfolio Impact Simulation für {impact['ticker']} ({impact['actual_nos']} Shares)**\n"
                                     f"- **Ziel**: TP {impact.get('take_profit', '?')}$ ({impact.get('target_r', '?')}R)\n"
                                     f"- **Cash**: {p.get('cash_before')} -> {p.get('cash_after')} ({p.get('cash_delta')})\n"
                                     f"- **Cash Quote**: {p.get('cash_pct_before')} -> {p.get('cash_pct_after')}\n"
                                     f"- **Heat Quote**: {p.get('heat_pct_before')} -> {p.get('heat_pct_after')} ({p.get('heat_pct_delta')})\n"
                                     f"- **Trade Cost**: {impact.get('trade_cost_eur')} EUR\n"
                                     f"- **Trade Core Risk**: {p.get('trade_crisk_eur')} EUR ({p.get('trade_crisk_pct')})")
                
                send_telemetry(telemetry_msg)
                broadcast_load_ticker(trade.ticker)
                
                return {
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "result": {
                        "content": [
                            {"type": "text", "text": json.dumps(impact, indent=2)}
                        ]
                    }
                }
                
            except Exception as e:
                return error_response(req.id, f"Error calculating impact: {str(e)}")
                
        elif tool_name == "commit_trade":
            try:
                planned_date_arg = args.get("planned_date")
                if planned_date_arg:
                    planned_date_val = pd.to_datetime(planned_date_arg, utc=True).isoformat()
                else:
                    planned_date_val = datetime.now(timezone.utc).isoformat()
                    
                portfolio = PortfolioRepository.load_portfolio_and_trades(supabase, planned_date_val)
                portfolio.recalculate_totals()
                
                trade_data_args = {
                    "ticker": args.get("ticker"),
                    "price": args.get("price"),
                    "sl": args.get("sl"),
                    "tp": args.get("tp"),
                    "target_r": args.get("target_r"),
                    "commission": args.get("commission", 0.0)
                }
                trade = TradeObject(trade_data_args)
                
                nos = int(args.get("nos"))
                impact = trade.validate(portfolio, requested_nos=nos)
                
                if "error" in impact:
                    err_msg = impact.get("message", impact["error"])
                    return error_response(req.id, err_msg)
                
                p_impact = impact["portfolio_impact"]
                trade_cost = impact["trade_cost_eur"]
                crisk_eur = p_impact["trade_crisk_eur"]
                
                trade_heat_eur = p_impact.get("trade_heat_eur", nos * (trade.current_price - trade.sl))
                
                # Portfolio update logic in memory
                portfolio.deduct_cash(trade_cost)
                portfolio.add_crisk_eur(crisk_eur)
                portfolio.add_heat_eur(trade_heat_eur)
                
                trade.nos = nos
                trade.crisk_eur = crisk_eur
                portfolio.active_trades.append(trade) # Adding to track for future recalculations
                
                # Need assets calculation for NAV
                # The total NAV shouldn't change instantly on buy (excluding commissions)
                # nav = cash + assets -> assets_neu = nav_alt - cash_neu
                # Let's compute actual assets:
                assets_neu = (portfolio.nav - portfolio.cash) # rough estimate, or base it on DB if needed
                cash_pct_neu = (portfolio.cash / portfolio.nav) * 100 if portfolio.nav > 0 else 0.0
                
                # Clean up percentage strings for db
                crisk_pct_val = float(p_impact["trade_crisk_pct"].replace('%', ''))
                status_val = "pending" if args.get("execute_asap", False) else "planned"
                
                # Insert into srm_trades
                db_trade_data = {
                    "portfolio_id": portfolio.portfolio_id,
                    "status": status_val,
                    "planned": planned_date_val,
                    "ticker": trade.ticker,
                    "cbase": trade.price,
                    "nos": nos,
                    "sl": trade.sl,
                    "sl_history": [{"date": planned_date_val, "sl": trade.sl}],
                    "tp": trade.tp,
                    "target_r": trade.target_r,
                    "r_value": trade.risk_per_share,
                    "commission": trade.commission,
                    "rmultiple": 0.0,
                    "rmultiple_pct": 0.0,
                    "pnl": 0.0,
                    "crisk_eur": crisk_eur,
                    "crisk_pct": crisk_pct_val,
                    "heat_eur": trade_heat_eur, 
                    "heat_pct": float(p_impact["trade_heat_pct"].replace('%', '')),
                    "days": 0
                }
                supabase.table("srm_trades").insert(db_trade_data).execute()
                
                PortfolioRepository.save_portfolio(supabase, portfolio)
                
                telemetry_msg = (f"💾 **Trade auf {trade.ticker} gebucht! [{status_val.upper()}]**\n"
                                 f"*{nos} Shares @ {trade.price} (SL: {trade.sl}, TP: {round(trade.tp, 2)} / {round(trade.target_r, 2)}R)*\n\n"
                                 f"**Geplant am:** {planned_date_val[:10]}\n"
                                 f"Cash: {round(portfolio.cash, 2)}\n"
                                 f"Heat: {round(portfolio.current_heat_pct, 2)}%")
                send_telemetry(telemetry_msg)
                broadcast_load_ticker(trade.ticker)
                
                return {
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "result": {
                        "content": [
                            {"type": "text", "text": "Trade successfully committed to database."}
                        ]
                    }
                }
                
            except Exception as e:
                return error_response(req.id, f"Error committing trade: {str(e)}")
                
        elif tool_name == "commit_transaction":
            try:
                t_type = args.get("type", "DEPOSIT").upper()
                amount = float(args.get("amount", 0.0))
                date_val = args.get("date")
                
                if t_type == "WITHDRAWAL":
                    amount = -abs(amount)
                else:
                    amount = abs(amount)
                    
                planned_date_val = pd.to_datetime(date_val, utc=True).isoformat()
                
                # get portfolio id
                port_res = supabase.table("srm_portfolio").select("portfolio_id").limit(1).execute()
                portfolio_id = port_res.data[0]["portfolio_id"]
                
                db_trade_data = {
                    "portfolio_id": portfolio_id,
                    "status": "closed",
                    "planned": planned_date_val,
                    "closed": planned_date_val,
                    "ticker": t_type,
                    "cbase": 0.0,
                    "nos": 0,
                    "sl": 0.0,
                    "tp": 0.0,
                    "pnl": amount,
                    "crisk_eur": 0.0,
                    "heat_eur": 0.0,
                    "target_r": 0.0,
                    "r_value": 0.0,
                    "commission": 0.0,
                    "rmultiple": 0.0,
                    "rmultiple_pct": 0.0,
                    "crisk_pct": 0.0,
                    "heat_pct": 0.0,
                    "sl_history": [],
                    "days": 0
                }
                res = supabase.table("srm_trades").insert(db_trade_data).execute()
                
                if getattr(res, "error", None) is not None:
                    return error_response(req.id, f"Error committing transaction: {res.error}")
                
                telemetry_msg = f"💸 **{t_type}** in Höhe von {amount} EUR am {date_val} verbucht."
                send_telemetry(telemetry_msg)
                
                return {
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "result": {
                        "content": [
                            {"type": "text", "text": f"Transaction {t_type} successfully recorded."}
                        ]
                    }
                }
                
            except Exception as e:
                return error_response(req.id, f"Error committing transaction: {str(e)}")
                
        elif tool_name == "update_stoploss":
            try:
                trade_id = args.get("trade_id")
                ticker = args.get("ticker")
                new_sl = float(args.get("new_sl"))
                date_val = args.get("date")
                
                if date_val:
                    date_iso = pd.to_datetime(date_val, utc=True).isoformat()
                else:
                    date_iso = datetime.now(timezone.utc).isoformat()

                # Look up trade by trade_id or ticker
                if trade_id:
                    res = supabase.table("srm_trades").select("*").eq("trade_id", trade_id).single().execute()
                elif ticker:
                    res = supabase.table("srm_trades").select("*").eq("ticker", ticker.upper()).neq("status", "closed").order("planned", desc=True).limit(1).execute()
                    if res.data and isinstance(res.data, list):
                        res.data = res.data[0]
                else:
                    return error_response(req.id, "Either trade_id or ticker must be provided.")
                    
                if not res.data:
                    return error_response(req.id, f"Trade not found (trade_id={trade_id}, ticker={ticker}).")
                
                trade_data = res.data
                trade_id = trade_data.get("trade_id")
                sl_history = trade_data.get("sl_history") or []
                
                # Append new SL
                sl_history.append({"date": date_iso, "sl": new_sl})
                
                # Update DB
                supabase.table("srm_trades").update({
                    "sl": new_sl,
                    "sl_history": sl_history
                }).eq("trade_id", trade_id).execute()
                
                telemetry_msg = f"🛡️ **Trailing Stop Update**\nStop-Loss für Trade #{trade_id} ({trade_data.get('ticker')}) auf {new_sl}$ nachgezogen."
                send_telemetry(telemetry_msg)
                
                return {
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "result": {
                        "content": [
                            {"type": "text", "text": f"Stop loss for trade {trade_id} updated to {new_sl}."}
                        ]
                    }
                }
            except Exception as e:
                return error_response(req.id, f"Error updating stoploss: {str(e)}")

        elif tool_name == "run_backtest":
            try:
                # 1. Determine parameters
                config_id = args.get("config_id")
                base_config = {}
                if config_id is not None:
                    base_config = load_bt_config(supabase, int(config_id))
                
                # Default configuration values
                merged_config = {
                    "ema_fast": 14,
                    "ema_slow": 18,
                    "trend_sma_period": 10,
                    "trend_threshold": 0.0,
                    "setup_count_enter_n": 4,
                    "setup_count_exit_n": 4,
                    "risk_pct": 0.01,
                    "initial_capital": 10000.0,
                    "min_tick": 0.01,
                    "commission": 2.0,
                    "position_size_pct": 10.0,
                    "vstop_period": 14,
                    "vstop_multiplier": 2.0,
                    "start_date": None,
                    "end_date": None,
                    "watchlist": "growth_stocks"
                }
                
                # Merge base config
                for k, v in base_config.items():
                    if v is not None:
                        # Convert Decimal/numeric types to float
                        if k in ["risk_pct", "initial_capital", "min_tick", "commission", "trend_threshold", "position_size_pct", "vstop_multiplier"] and v is not None:
                            merged_config[k] = float(v)
                        else:
                            merged_config[k] = v
                
                # Merge user overrides
                overrides_exist = False
                for k in merged_config.keys():
                    if args.get(k) is not None:
                        if k in ["ema_fast", "ema_slow", "trend_sma_period", "setup_count_enter_n", "setup_count_exit_n", "vstop_period"]:
                            val = int(args.get(k))
                        elif k in ["risk_pct", "initial_capital", "min_tick", "commission", "trend_threshold", "position_size_pct", "vstop_multiplier"]:
                            val = float(args.get(k))
                        else:
                            val = str(args.get(k))
                        
                        if base_config.get(k) != val:
                            overrides_exist = True
                        merged_config[k] = val

                # If single ticker is specified, override watchlist completely
                single_ticker = args.get("ticker")
                
                # 2. Handle DB configuration entry if overrides exist OR if config_id was not provided
                active_config_id = config_id
                if overrides_exist or config_id is None:
                    # Create a new config in bt_configs
                    timestamp_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
                    new_config_name = f"agent_run_{timestamp_str}"
                    if single_ticker:
                        new_config_name += f"_{single_ticker}"
                    
                    db_config_data = {
                        "name": new_config_name,
                        "watchlist": single_ticker if single_ticker else merged_config["watchlist"],
                        "start_date": merged_config["start_date"],
                        "end_date": merged_config["end_date"],
                        "ema_fast": merged_config["ema_fast"],
                        "ema_slow": merged_config["ema_slow"],
                        "trend_sma_period": merged_config["trend_sma_period"],
                        "trend_threshold": merged_config["trend_threshold"],
                        "setup_count_enter_n": merged_config["setup_count_enter_n"],
                        "setup_count_exit_n": merged_config["setup_count_exit_n"],
                        "risk_pct": merged_config["risk_pct"],
                        "initial_capital": merged_config["initial_capital"],
                        "min_tick": merged_config["min_tick"],
                        "commission": merged_config["commission"],
                        "position_size_pct": merged_config["position_size_pct"],
                        "vstop_period": merged_config["vstop_period"],
                        "vstop_multiplier": merged_config["vstop_multiplier"]
                    }
                    res_config = supabase.table("bt_configs").insert(db_config_data).execute()
                    active_config_id = res_config.data[0]["config_id"]
                
                # 3. Create run entry
                run_data = {
                    "config_id": active_config_id,
                    "status": "running",
                    "started_at": datetime.now(timezone.utc).isoformat(),
                }
                run_res = supabase.table("bt_runs").insert(run_data).execute()
                run_id = run_res.data[0]["run_id"]
                
                # 4. Resolve Tickers and load data
                if single_ticker:
                    tickers = [single_ticker.upper()]
                else:
                    tickers = load_watchlist(supabase, merged_config["watchlist"])
                
                ticker_data = {}
                skipped_tickers = []
                for ticker in tickers:
                    try:
                        df = load_ohlcv(ticker)
                        ticker_data[ticker] = df
                    except Exception as e:
                        skipped_tickers.append((ticker, str(e)))
                
                if not ticker_data:
                    err_msg = f"No valid ticker data found. Skipped tickers: {skipped_tickers}"
                    supabase.table("bt_runs").update({
                        "status": "failed",
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                        "error_message": err_msg
                    }).eq("run_id", run_id).execute()
                    return error_response(req.id, err_msg)
                
                # 5. Run backtest
                engine = BacktestEngine(merged_config)
                result = engine.run(ticker_data)
                
                # 6. Write trades to DB
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
                            "commission": round(t.commission, 2)
                        })
                    supabase.table("bt_trades").insert(trade_rows).execute()
                
                # 7. Update run status and save report
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
                    "report_text": result.report_text
                }
                supabase.table("bt_runs").update(update_data).eq("run_id", run_id).execute()
                
                # Send telemetry
                telemetry_msg = (
                    f"📊 **Backtest #{run_id} abgeschlossen**\n"
                    f"- Config ID: {active_config_id}\n"
                    f"- Trades: {result.total_trades} (Winrate: {round(result.win_rate, 1)}%)\n"
                    f"- Return: {round((result.final_capital / merged_config['initial_capital'] - 1) * 100, 2):+.2f}%\n"
                    f"- Max DD: {round(result.max_drawdown, 2)}%"
                )
                send_telemetry(telemetry_msg)
                
                return {
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "result": {
                        "content": [
                            {"type": "text", "text": result.report_text}
                        ]
                    }
                }
            except Exception as e:
                return error_response(req.id, f"Error executing backtest: {str(e)}")

        elif tool_name == "run_batch_optimization":
            try:
                watchlist = args.get("watchlist", "growth_stocks")
                single_ticker = args.get("ticker")
                ema_fast_list = args.get("ema_fast_list", [14])
                ema_slow_list = args.get("ema_slow_list", [18])
                trend_sma_period_list = args.get("trend_sma_period_list", [10])
                trend_threshold_list = args.get("trend_threshold_list", [0.0])
                setup_count_enter_n_list = args.get("setup_count_enter_n_list", [4])
                setup_count_exit_n_list = args.get("setup_count_exit_n_list", [4])
                vstop_period_list = args.get("vstop_period_list", [14])
                vstop_multiplier_list = args.get("vstop_multiplier_list", [2.0])
                
                risk_pct = float(args.get("risk_pct", 0.01))
                initial_capital = float(args.get("initial_capital", 10000.0))
                position_size_pct = float(args.get("position_size_pct", 10.0))
                start_date = args.get("start_date")
                end_date = args.get("end_date")

                import itertools
                
                if single_ticker:
                    tickers = [single_ticker.upper()]
                else:
                    tickers = load_watchlist(supabase, watchlist)
                
                # Preload data once
                ticker_data = {}
                skipped_tickers = []
                for ticker in tickers:
                    try:
                        df = load_ohlcv(ticker)
                        ticker_data[ticker] = df
                    except Exception as e:
                        skipped_tickers.append((ticker, str(e)))
                
                if not ticker_data:
                    return error_response(req.id, f"No valid ticker data found. Skipped: {skipped_tickers}")

                combinations = list(itertools.product(
                    ema_fast_list, ema_slow_list, trend_sma_period_list, trend_threshold_list, setup_count_enter_n_list, setup_count_exit_n_list, vstop_period_list, vstop_multiplier_list
                ))
                
                results_list = []
                start_time = time.time()
                
                tasks = [
                    (combo, ticker_data, risk_pct, initial_capital, position_size_pct, start_date, end_date)
                    for combo in combinations
                ]
                
                with concurrent.futures.ProcessPoolExecutor(max_workers=os.cpu_count()) as executor:
                    results_list = list(executor.map(_run_backtest_combo, tasks))
                
                end_time = time.time()
                duration = end_time - start_time
                runs_per_sec = len(combinations) / duration if duration > 0 else 0
                
                # Filter out zero-trades runs for rankings
                valid_results = [r for r in results_list if r["trades"] > 0]
                if not valid_results:
                    valid_results = results_list
                
                def format_table(title, top_results):
                    lines = [f"#### {title}"]
                    lines.append("| EMA F/S | SMA | Thr | In/Out | VStop | Trades | Win% | Return% | Max DD% | PF |")
                    lines.append("|---------|-----|-----|--------|-------|--------|------|---------|---------|----|")
                    for r in top_results:
                        params = f"{r['ema_fast']}/{r['ema_slow']}"
                        vstop = f"{r['vperiod']}/{r['vmult']}"
                        lines.append(
                            f"| {params} | {r['sma']} | {r['thresh']} | {r['enter_n']}/{r['exit_n']} | {vstop} | "
                            f"{r['trades']} | {r['winrate']:.1f}% | {r['return_pct']:.2f}% | "
                            f"{r['max_dd']:.2f}% | {r['profit_factor']:.2f} |"
                        )
                    lines.append("")
                    return lines
                
                md_lines = []
                md_lines.append(f"### Batch Optimization Results ({len(combinations)} Runs)")
                md_lines.append("")
                
                # 1. Top 10 by Max Drawdown (Ascending)
                valid_results.sort(key=lambda x: x["max_dd"])
                md_lines.extend(format_table("Top 10 by Max Drawdown (Lowest is better)", valid_results[:10]))
                
                # 2. Top 10 by Return
                valid_results.sort(key=lambda x: x["return_pct"], reverse=True)
                md_lines.extend(format_table("Top 10 by Return (%)", valid_results[:10]))
                
                # 3. Top 10 by Win Rate
                valid_results.sort(key=lambda x: x["winrate"], reverse=True)
                md_lines.extend(format_table("Top 10 by Win Rate (%)", valid_results[:10]))
                
                # 4. Top 10 by Profit Factor
                valid_results.sort(key=lambda x: x["profit_factor"] if x["profit_factor"] < 999 else 0, reverse=True)
                md_lines.extend(format_table("Top 10 by Profit Factor", valid_results[:10]))
                
                md_lines.append(f"**Performance Benchmark:** {len(combinations)} Runs completed in {duration:.2f}s ({runs_per_sec:.1f} Runs/sec)")
                
                final_md = "\n".join(md_lines)
                
                # Sende die Tabelle auch als Telemetrie an das System
                send_telemetry(f"Batch Optimization Report:\n\n{final_md}")
                
                return {
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "result": {
                        "content": [
                            {"type": "text", "text": final_md}
                        ]
                    }
                }
                
            except Exception as e:
                return error_response(req.id, f"Error executing batch optimization: {str(e)}")

        elif tool_name == "attribute_winner_performance":
            try:
                run_id = int(args.get("run_id"))
                if not run_id:
                    return error_response(req.id, "run_id is required for attribute_winner_performance")

                result = attribute_winner_performance(supabase, run_id)
                if "error" in result:
                    return error_response(req.id, result["error"])

                n_tickers = result.get("n_tickers", 0)
                top_assoc = result.get("strongest_associations", [])[:5]
                assoc_lines = []
                for a in top_assoc:
                    rho = a.get("rho")
                    p = a.get("p")
                    assoc_lines.append(
                        f"  - {a['feature']} ↔ {a['metric']}: rho={rho:+.3f} (p={p if p is not None else 'n/a'})"
                    )
                assoc_text = "\n".join(assoc_lines) if assoc_lines else "  (keine)"

                split = result.get("winner_vs_loser_split", {})
                upper = split.get("upper_half", [])
                lower = split.get("lower_half", [])

                summary = (
                    f"### Winner Attribution für Run #{run_id}\n"
                    f"- Ticker im Run: **{n_tickers}** | Trades gesamt: **{result.get('n_trades', 0)}**\n"
                    f"- Headline: Win-Rate Ø {result['headline_metrics']['win_rate_mean']:.1f}%, "
                    f"Avg-R {result['headline_metrics']['avg_r_multiple_mean']:+.2f}, "
                    f"Total PnL {result['headline_metrics']['total_pnl_sum']:+,.2f}\n"
                    f"- **Top Assoziationen (|Spearman rho|)**:\n{assoc_text}\n"
                    f"- **Median-Split auf total_pnl**:\n"
                    f"  - Winner (obere Hälfte): {upper}\n"
                    f"  - Loser (untere Hälfte): {lower}\n"
                )
                if result.get("warning"):
                    summary += f"\n⚠️ **Caveat:** {result['warning']}\n"

                telemetry_msg = (
                    f"🔬 **Winner Attribution für Run #{run_id}**\n"
                    f"Ticker: {n_tickers} | Top-Assoziation: "
                    f"{top_assoc[0]['feature']}↔{top_assoc[0]['metric']} rho={top_assoc[0]['rho']:+.3f}"
                    if top_assoc
                    else f"🔬 Winner Attribution für Run #{run_id}: keine Assoziationen"
                )
                send_telemetry(telemetry_msg)

                return {
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "result": {
                        "content": [
                            {"type": "text", "text": summary + "\n\n```json\n" + json.dumps(result, indent=2, default=str) + "\n```"}
                        ]
                    }
                }

            except Exception as e:
                return error_response(req.id, f"Error in winner attribution: {str(e)}")

        return error_response(req.id, f"Unknown tool: {tool_name}")
