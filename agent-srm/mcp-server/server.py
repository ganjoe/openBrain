import os
import json
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, Dict, Any
from risk_engine import PortfolioObject, TradeObject
from supabase import create_client, Client
import requests
import pandas as pd
from datetime import datetime, timezone

TELEMETRY_URL = os.environ.get("TELEMETRY_URL", "http://nexus-service:7734/api/send")

def send_telemetry(text: str):
    payload = {
        "from_agent": "system",
        "to": "all",
        "text": text,
        "msg_type": "telemetry"
    }
    try:
        requests.post(TELEMETRY_URL, json=payload, timeout=2)
    except Exception as e:
        print(f"Telemetry failed: {e}")

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

def load_portfolio_and_trades(client: Client, target_date: str = None) -> PortfolioObject:
    if not client:
        raise Exception("Database not connected.")
        
    res = client.table("srm_portfolio").select("*").limit(1).execute()
    if not res.data:
        raise Exception("No portfolio found in srm_portfolio table.")
        
    port_data = res.data[0]
    
    if port_data.get("portfolio_id") is not None:
        trades_res = client.table("srm_trades").select("*").eq("portfolio_id", port_data["portfolio_id"]).execute()
        all_trades = trades_res.data or []
    else:
        all_trades = []
        
    if target_date is None:
        target_date = datetime.now(timezone.utc).isoformat()
        
    t_date_pd = pd.to_datetime(target_date, utc=True)
    
    realized_capital = 0.0
    invested_capital = 0.0
    active_trades = []
    
    for t_data in all_trades:
        planned_str = t_data.get("planned")
        if not planned_str:
            planned = pd.to_datetime("2000-01-01", utc=True)
        else:
            planned = pd.to_datetime(planned_str, utc=True)
            
        if planned > t_date_pd:
            continue
            
        status = t_data.get("status")
        closed_date_str = t_data.get("closed")
        
        # Determine if trade was closed ON OR BEFORE the target date
        is_closed_then = False
        if status == "closed":
            if closed_date_str:
                closed_date = pd.to_datetime(closed_date_str, utc=True)
                if closed_date <= t_date_pd:
                    is_closed_then = True
            else:
                is_closed_then = True
                
        if is_closed_then:
            realized_capital += float(t_data.get("pnl") or 0.0)
        else:
            trade = TradeObject(t_data)
            active_trades.append(trade)
            invested_capital += float(t_data.get("cbase") or 0.0) * int(t_data.get("nos") or 0)
            
    cash = realized_capital - invested_capital
    port_data["nav"] = realized_capital # Base NAV
    port_data["cash"] = cash
    
    portfolio = PortfolioObject(port_data)
    portfolio.active_trades = active_trades
                    
    return portfolio

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
                            "properties": {},
                            "required": []
                        }
                    }
                ]
            }
        }
    
    if req.method == "tools/call":
        tool_name = req.params.get("name")
        args = req.params.get("arguments", {})
        
        if tool_name == "get_portfolio":
            try:
                portfolio = load_portfolio_and_trades(supabase)
                portfolio.recalculate_totals()
                
                cash_pct = (portfolio.cash / portfolio.nav * 100) if portfolio.nav > 0 else 0.0
                
                portfolio_info = {
                    "nav": portfolio.nav,
                    "cash": portfolio.cash,
                    "cash_pct": cash_pct,
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
                portfolio = load_portfolio_and_trades(supabase)
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
                    telemetry_msg = f"❌ **Simulation fehlgeschlagen**: {impact['error']}"
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
                    
                portfolio = load_portfolio_and_trades(supabase, planned_date_val)
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
                    return error_response(req.id, impact["error"])
                
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
                    "tp": trade.tp,
                    "target_r": trade.target_r,
                    "r_value": trade.r_per_share,
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
                
                # NOTE: We no longer update srm_portfolio nav/cash because it is dynamically calculated.
                
                telemetry_msg = (f"💾 **Trade auf {trade.ticker} gebucht! [{status_val.upper()}]**\n"
                                 f"*{nos} Shares @ {trade.price} (SL: {trade.sl}, TP: {round(trade.tp, 2)} / {round(trade.target_r, 2)}R)*\n\n"
                                 f"**Geplant am:** {planned_date_val[:10]}\n"
                                 f"Cash: {round(portfolio.cash, 2)}\n"
                                 f"Heat: {round(portfolio.current_heat_pct, 2)}%")
                send_telemetry(telemetry_msg)
                
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
                    "heat_eur": 0.0
                }
                supabase.table("srm_trades").insert(db_trade_data).execute()
                
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
                
        return error_response(req.id, f"Unknown tool: {tool_name}")
