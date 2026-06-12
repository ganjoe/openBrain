import os
import json
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, Dict, Any
from risk_engine import Portfolio, TradeObject
from supabase import create_client, Client
import requests

def send_telemetry(text: str):
    url = "http://nexus-service:7734/api/send"
    payload = {
        "from_agent": "system",
        "to": "all",
        "text": text,
        "msg_type": "telemetry"
    }
    try:
        requests.post(url, json=payload, timeout=2)
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

@app.post("/")
async def handle_mcp_request(req: JsonRpcRequest):
    # The stateless bot client requests tools/list
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
                                "execute_asap": {"type": "boolean", "description": "If true, sets status to pending for immediate execution. If false, status is planned."}
                            },
                            "required": ["ticker", "price", "sl", "nos"]
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
    
    # The stateless bot client requests tools/call
    if req.method == "tools/call":
        tool_name = req.params.get("name")
        args = req.params.get("arguments", {})
        
        if tool_name == "get_portfolio":
            try:
                if not supabase:
                    return error_response(req.id, "Database not connected.")
                
                res = supabase.table("srm_portfolio").select("*").limit(1).execute()
                if not res.data:
                    return error_response(req.id, "No portfolio found in srm_portfolio table.")
                
                p_data = res.data[0]
                
                def to_pct(val, default):
                    v = float(val if val is not None else default)
                    return v * 100.0 if (0 < v <= 1.0) else v

                nav = float(p_data.get("nav") or 100000.0)
                cash = float(p_data.get("cash") or 100000.0)
                max_crisk_pct = to_pct(p_data.get("max_crisk_pct"), 1.25)
                max_heat_pct = to_pct(p_data.get("max_heat_pct"), 15.0)
                max_days = float(p_data.get("max_days") or 30.0)
                max_crisk_pos_pct = to_pct(p_data.get("max_crisk_pos_pct"), 15.0)
                current_heat_pct = float(p_data.get("heat_pct") or 0.0)
                current_crisk_pct = float(p_data.get("crisk_pct") or 0.0)
                
                available_heat_pct = max(0.0, max_heat_pct - current_heat_pct)
                available_heat_eur = (available_heat_pct / 100.0) * nav
                
                max_crisk_eur = (max_crisk_pct / 100.0) * nav
                
                portfolio_info = {
                    "nav": nav,
                    "cash": cash,
                    "cash_pct": float(p_data.get("cash_pct") or 0.0),
                    "current_heat_pct": current_heat_pct,
                    "max_heat_pct": max_heat_pct,
                    "available_heat_pct": available_heat_pct,
                    "available_heat_eur": available_heat_eur,
                    "max_crisk_pct_per_trade": max_crisk_pct,
                    "max_crisk_eur_per_trade": max_crisk_eur,
                    "current_crisk_pct": current_crisk_pct,
                    "min_r": float(p_data.get("min_r") or 3.0),
                    "max_days": max_days,
                    "max_crisk_pos_pct": max_crisk_pos_pct
                }
                
                telemetry_msg = (f"📈 **Portfolio Status**\n"
                                 f"NAV: {round(nav, 2)} EUR | Cash: {round(cash, 2)} EUR\n"
                                 f"Heat: {round(current_heat_pct, 2)}% / {round(max_heat_pct, 2)}% (Frei: {round(available_heat_pct, 2)}%)\n"
                                 f"Max Risk/Trade: {round(max_crisk_pct, 2)}%")
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
                if not supabase:
                    return error_response(req.id, "Database not connected.")
                    
                # Fetch active portfolio (assuming portfolio_id 1 for now)
                res = supabase.table("srm_portfolio").select("*").limit(1).execute()
                if not res.data:
                    return error_response(req.id, "No portfolio found in srm_portfolio table.")
                
                p_data = res.data[0]
                
                # Helper to convert decimals to percentages (e.g. 0.08 to 8.0)
                def to_pct(val, default):
                    v = float(val if val is not None else default)
                    return v * 100.0 if (0 < v <= 1.0) else v

                portfolio = Portfolio(
                    nav=float(p_data.get("nav") or 100000.0),
                    cash=float(p_data.get("cash") or 100000.0),
                    max_crisk_pct=to_pct(p_data.get("max_crisk_pct"), 1.25),
                    max_heat_pct=to_pct(p_data.get("max_heat_pct"), 15.0),
                    current_heat_pct=float(p_data.get("heat_pct") or 0.0),
                    min_r=float(p_data.get("min_r") or 3.0),
                    max_positions=10, 
                    current_positions=0 # Could be queried via: supabase.table("srm_trades").select("trade_id", count="exact").eq("closed", "null")
                )
                
                # Fetch optional tp / target_r (ensure floats if provided)
                tp_arg = args.get("tp")
                target_r_arg = args.get("target_r")
                tp_val = float(tp_arg) if tp_arg is not None else None
                tr_val = float(target_r_arg) if target_r_arg is not None else None
                
                trade = TradeObject(
                    ticker=args.get("ticker"),
                    price=float(args.get("price")),
                    sl=float(args.get("sl")),
                    tp=tp_val,
                    target_r=tr_val,
                    commission=float(args.get("commission", 0.0))
                )
                
                nos = args.get("nos")
                if nos is not None:
                    nos = int(nos)
                    
                impact = trade.simulate_impact(portfolio, nos)
                
                # Telemetry output
                if "error" in impact:
                    telemetry_msg = f"❌ **Simulation fehlgeschlagen**: {impact['error']}"
                elif impact.get("status") == "discovery_success":
                    limits = impact.get('limiting_factors', {})
                    telemetry_msg = (f"🔍 **Risiko-Limits für {impact['ticker']} (Preis: {impact['price']}, SL: {impact['stop_loss']})**\n"
                                     f"- **Ziel**: TP {impact.get('take_profit', '?')}$ ({impact.get('target_r', '?')}R)\n"
                                     f"- **Max. erlaubte Shares**: {impact['max_allowed_shares']}\n"
                                     f"- *Core Risk Limit*: {limits.get('Core Risk Limit')}\n"
                                     f"- *Portfolio Heat Limit*: {limits.get('Portfolio Heat Limit')}\n"
                                     f"- *Cash Limit*: {limits.get('Cash Limit')}\n\n")
                    
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
                if not supabase:
                    return error_response(req.id, "Database not connected.")
                
                # Fetch portfolio
                res = supabase.table("srm_portfolio").select("*").limit(1).execute()
                if not res.data:
                    return error_response(req.id, "No portfolio found in srm_portfolio table.")
                
                p_data = res.data[0]
                
                # Helper to convert decimals to percentages (e.g. 0.08 to 8.0)
                def to_pct(val, default):
                    v = float(val if val is not None else default)
                    return v * 100.0 if (0 < v <= 1.0) else v

                portfolio = Portfolio(
                    nav=float(p_data.get("nav") or 100000.0),
                    cash=float(p_data.get("cash") or 100000.0),
                    max_crisk_pct=to_pct(p_data.get("max_crisk_pct"), 1.25),
                    max_heat_pct=to_pct(p_data.get("max_heat_pct"), 15.0),
                    current_heat_pct=float(p_data.get("heat_pct") or 0.0),
                    min_r=float(p_data.get("min_r") or 3.0),
                    max_positions=10, 
                    current_positions=0,
                    max_days=float(p_data.get("max_days") or 30.0),
                    max_crisk_pos_pct=to_pct(p_data.get("max_crisk_pos_pct"), 15.0)
                )
                
                tp_arg = args.get("tp")
                target_r_arg = args.get("target_r")
                tp_val = float(tp_arg) if tp_arg is not None else None
                tr_val = float(target_r_arg) if target_r_arg is not None else None
                
                trade = TradeObject(
                    ticker=args.get("ticker"),
                    price=float(args.get("price")),
                    sl=float(args.get("sl")),
                    tp=tp_val,
                    target_r=tr_val,
                    commission=float(args.get("commission", 0.0))
                )
                
                nos = int(args.get("nos"))
                impact = trade.simulate_impact(portfolio, nos)
                
                if "error" in impact:
                    return error_response(req.id, impact["error"])
                
                p_impact = impact["portfolio_impact"]
                trade_cost = impact["trade_cost_eur"]
                crisk_eur = p_impact["trade_crisk_eur"]
                
                # Portfolio update logic
                cash_alt = float(p_data.get("cash") or 100000.0)
                assets_alt = float(p_data.get("assets") or 0.0)
                heat_eur_alt = float(p_data.get("heat_eur") or 0.0)
                crisk_eur_alt = float(p_data.get("crisk_eur") or 0.0)
                
                cash_neu = cash_alt - trade_cost
                assets_neu = assets_alt + (nos * trade.price)
                nav_neu = cash_neu + assets_neu
                
                heat_eur_neu = heat_eur_alt + crisk_eur
                heat_pct_neu = (heat_eur_neu / nav_neu) * 100 if nav_neu > 0 else 0.0
                
                crisk_eur_neu = crisk_eur_alt + crisk_eur
                crisk_pct_neu = (crisk_eur_neu / nav_neu) * 100 if nav_neu > 0 else 0.0
                
                cash_pct_neu = (cash_neu / nav_neu) * 100 if nav_neu > 0 else 0.0
                
                # Clean up percentage strings for db
                crisk_pct_val = float(p_impact["trade_crisk_pct"].replace('%', ''))
                
                status_val = "pending" if args.get("execute_asap", False) else "planned"
                
                # Insert into srm_trades
                from datetime import datetime, timezone
                trade_data = {
                    "portfolio_id": p_data["portfolio_id"],
                    "status": status_val,
                    "planned": datetime.now(timezone.utc).isoformat(),
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
                    "heat_eur": crisk_eur, 
                    "heat_pct": crisk_pct_val,
                    "days": 0
                }
                supabase.table("srm_trades").insert(trade_data).execute()
                
                # Update srm_portfolio
                port_update = {
                    "nav": nav_neu,
                    "cash": cash_neu,
                    "assets": assets_neu,
                    "cash_pct": cash_pct_neu,
                    "heat_eur": heat_eur_neu,
                    "heat_pct": heat_pct_neu,
                    "crisk_eur": crisk_eur_neu,
                    "crisk_pct": crisk_pct_neu
                }
                supabase.table("srm_portfolio").update(port_update).eq("portfolio_id", p_data["portfolio_id"]).execute()
                
                telemetry_msg = (f"💾 **Trade auf {trade.ticker} gebucht! [{status_val.upper()}]**\n"
                                 f"*{nos} Shares @ {trade.price} (SL: {trade.sl}, TP: {round(trade.tp, 2)} / {round(trade.target_r, 2)}R)*\n\n"
                                 f"**Neues Portfolio:**\n"
                                 f"Cash: {round(cash_neu, 2)}\n"
                                 f"Assets: {round(assets_neu, 2)}\n"
                                 f"Heat: {round(heat_pct_neu, 2)}%")
                send_telemetry(telemetry_msg)
                
                return {
                    "jsonrpc": "2.0",
                    "id": req.id,
                    "result": {
                        "content": [
                            {"type": "text", "text": "Trade successfully committed to database and portfolio updated."}
                        ]
                    }
                }
                
            except Exception as e:
                return error_response(req.id, f"Error committing trade: {str(e)}")
                
        return error_response(req.id, f"Unknown tool: {tool_name}")
