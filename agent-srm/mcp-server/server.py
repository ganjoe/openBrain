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
        "from_agent": "srm",
        "to": "boss",
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
                                "nos": {"type": "number", "description": "Optional: Number of shares to simulate. If omitted, returns max limits."},
                                "commission": {"type": "number", "description": "Optional: Estimated commission in currency."}
                            },
                            "required": ["ticker", "price", "sl"]
                        }
                    }
                ]
            }
        }
    
    # The stateless bot client requests tools/call
    if req.method == "tools/call":
        tool_name = req.params.get("name")
        args = req.params.get("arguments", {})
        
        if tool_name == "simulate_trade":
            try:
                if not supabase:
                    return error_response(req.id, "Database not connected.")
                    
                # Fetch active portfolio (assuming portfolio_id 1 for now)
                res = supabase.table("srm_portfolio").select("*").limit(1).execute()
                if not res.data:
                    return error_response(req.id, "No portfolio found in srm_portfolio table.")
                
                p_data = res.data[0]
                
                # Use "or" to handle None values gracefully if the user left them empty
                portfolio = Portfolio(
                    nav=float(p_data.get("nav") or 100000.0),
                    cash=float(p_data.get("cash") or 100000.0),
                    max_crisk_pct=float(p_data.get("max_crisk_pct") or 1.25),
                    max_heat_pct=float(p_data.get("max_heat_pct") or 15.0),
                    current_heat_pct=float(p_data.get("heat_pct") or 0.0),
                    max_positions=10, 
                    current_positions=0 # Could be queried via: supabase.table("srm_trades").select("trade_id", count="exact").eq("closed", "null")
                )
                
                trade = TradeObject(
                    ticker=args.get("ticker"),
                    price=float(args.get("price")),
                    sl=float(args.get("sl")),
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
                                     f"- **Max. erlaubte Shares**: {impact['max_allowed_shares']}\n"
                                     f"- *Core Risk Limit*: {limits.get('Core Risk Limit')}\n"
                                     f"- *Portfolio Heat Limit*: {limits.get('Portfolio Heat Limit')}\n"
                                     f"- *Cash Limit*: {limits.get('Cash Limit')}")
                else:
                    p = impact.get('portfolio_impact', {})
                    telemetry_msg = (f"📊 **Portfolio Impact Simulation für {impact['ticker']} ({impact['actual_nos']} Shares)**\n"
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
                
        return error_response(req.id, f"Unknown tool: {tool_name}")
