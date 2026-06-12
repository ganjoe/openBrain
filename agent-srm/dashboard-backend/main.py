import os
import sys
import pandas as pd
from datetime import datetime
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client, Client
from dotenv import load_dotenv

# Import Domain Models from SRM agent
sys.path.append(os.path.join(os.path.dirname(__file__), '../mcp-server'))
from risk_engine import PortfolioObject, TradeObject

# Load environment variables (expecting to run from agent-srm where .env is located, or load it explicitly)
env_path = os.path.join(os.path.dirname(__file__), '../../.env')
load_dotenv(env_path)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://127.0.0.1:8001")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_KEY:
    print("Warning: SUPABASE_KEY not found in environment!")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = FastAPI(title="SRM Backtest Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class AdvanceTimeRequest(BaseModel):
    target_date: str  # Format YYYY-MM-DD

def get_parquet_price(ticker: str, target_date: str):
    """
    Reads the local parquet file for the ticker and returns the Close and Low price
    on or just before the target_date.
    """
    parquet_path = f"/home/daniel/stock-data-node/data/parquet/{ticker}/1D.parquet"
    if not os.path.exists(parquet_path):
        print(f"Warning: No parquet file found for {ticker} at {parquet_path}")
        return None, None

    try:
        df = pd.read_parquet(parquet_path)
        # Ensure index is datetime
        if 'timestamp' in df.columns and not pd.api.types.is_datetime64_any_dtype(df.index):
            df['timestamp'] = pd.to_datetime(df['timestamp'], unit='s')
            df.set_index('timestamp', inplace=True)
        elif not pd.api.types.is_datetime64_any_dtype(df.index):
            df.index = pd.to_datetime(df.index)
        
        # Filter up to the target date
        mask = df.index <= pd.to_datetime(target_date)
        df_filtered = df.loc[mask]
        
        if df_filtered.empty:
            return None, None
            
        last_row = df_filtered.iloc[-1]
        
        # Parquet columns might vary, usually 'close' and 'low'
        close_col = 'close' if 'close' in last_row else 'Close'
        low_col = 'low' if 'low' in last_row else 'Low'
        
        return last_row[close_col], last_row[low_col]
        
    except Exception as e:
        print(f"Error reading parquet for {ticker}: {e}")
        return None, None

@app.post("/api/advance_time")
def advance_time(req: AdvanceTimeRequest):
    target_date = req.target_date
    
    # 1. Load active portfolio
    res = supabase.table("srm_portfolio").select("*").limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Portfolio not found")
        
    portfolio = PortfolioObject(res.data[0])
    
    # Load open trades
    trades_res = supabase.table("srm_trades").select("*").eq("portfolio_id", portfolio.portfolio_id).execute()
    open_trades_data = [t for t in trades_res.data if t.get("status") != "closed"]
    
    trades_updated = 0
    t_date_pd = pd.to_datetime(target_date, utc=True)
    
    for t_data in open_trades_data:
        planned_str = t_data.get("planned")
        if planned_str and pd.to_datetime(planned_str, utc=True) > t_date_pd:
            continue
            
        trade = TradeObject(t_data)
        ticker = trade.ticker
        
        close_price, low_price = get_parquet_price(ticker, target_date)
        if close_price is None:
            portfolio.active_trades.append(trade) # Keep it in active for risk calculation
            continue
            
        # Stop-Loss Check
        if low_price <= trade.sl:
            # Trade hit stop loss today!
            trade.status = "closed"
            trade.update_current_price(trade.sl) # Exited at SL (slippage not modeled here)
            
            # Record the realized loss directly into the DB without tracking in memory
            
            # Write back to DB
            supabase.table("srm_trades").update({
                "status": "closed",
                "closed": f"{target_date}T23:59:59Z", # Fake closing time
                "current_price": trade.sl,
                "pnl": trade.current_pnl,
                "rmultiple": trade.current_r_multiple,
                "heat_eur": 0.0,
                "heat_pct": 0.0,
                "crisk_eur": 0.0,
                "crisk_pct": 0.0
            }).eq("trade_id", t_data["trade_id"]).execute()
            
        else:
            # Trade is still alive, update current price
            trade.update_current_price(close_price)
            # Re-calculate dynamic heat based on current price
            heat_eur = (trade.current_price - trade.sl) * trade.nos
            
            # Add to portfolio active trades so recalculate_totals can work
            portfolio.active_trades.append(trade)
            
            # Write updated price back to DB
            supabase.table("srm_trades").update({
                "current_price": trade.current_price,
                "pnl": trade.current_pnl,
                "rmultiple": trade.current_r_multiple,
                "heat_eur": heat_eur
                # heat_pct will be updated after portfolio recalculation
            }).eq("trade_id", t_data["trade_id"]).execute()
            
        trades_updated += 1
        
    # 2. Portfolio Level Updates
    # Dynamically compute NAV
    all_trades_res = supabase.table("srm_trades").select("*").eq("portfolio_id", portfolio.portfolio_id).execute()
    all_trades = all_trades_res.data or []
    
    realized_capital = 0.0
    active_trades = []
    
    for t_data in all_trades:
        planned_str = t_data.get("planned")
        if planned_str and pd.to_datetime(planned_str, utc=True) > t_date_pd:
            continue
            
        status = t_data.get("status")
        closed_date_str = t_data.get("closed")
        
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
            
    portfolio.nav = realized_capital # Base NAV
    portfolio.active_trades = active_trades
    
    # Recalculate Heat and Core Risk
    portfolio.recalculate_totals()
    
    # Update trades with their new heat_pct (since NAV might have changed)
    for t in portfolio.active_trades:
        heat_eur = (t.current_price - t.sl) * t.nos
        heat_pct = (heat_eur / portfolio.nav) * 100 if portfolio.nav > 0 else 0.0
        supabase.table("srm_trades").update({
            "heat_pct": heat_pct
        }).eq("trade_id", getattr(t, "trade_id")).execute() 
        
    # NOTE: We no longer write to srm_portfolio as it's computed dynamically.

    return {"status": "success", "trades_evaluated": trades_updated, "new_nav": portfolio.nav}

@app.get("/api/config")
def get_config():
    return {
        "supabaseUrl": SUPABASE_URL,
        "supabaseKey": SUPABASE_KEY
    }

@app.get("/api/check_data")
def check_data(date: str):
    res = supabase.table("srm_trades").select("ticker").neq("status", "closed").execute()
    tickers = set(t["ticker"] for t in res.data)
    
    status = {}
    for ticker in tickers:
        parquet_path = f"/home/daniel/stock-data-node/data/parquet/{ticker}/1D.parquet"
        if not os.path.exists(parquet_path):
            status[ticker] = "red"
            continue
            
        try:
            df = pd.read_parquet(parquet_path)
            if 'timestamp' in df.columns and not pd.api.types.is_datetime64_any_dtype(df.index):
                df['timestamp'] = pd.to_datetime(df['timestamp'], unit='s')
                df.set_index('timestamp', inplace=True)
            elif not pd.api.types.is_datetime64_any_dtype(df.index):
                df.index = pd.to_datetime(df.index)
                
            # Normalize index to date only for comparison
            dates_only = df.index.normalize()
            exact_date = pd.to_datetime(date)
            
            if exact_date in dates_only:
                status[ticker] = "green"
            else:
                status[ticker] = "yellow"
        except Exception as e:
            status[ticker] = "red"
            
    return status

# Mount static dashboard
dashboard_dir = os.path.join(os.path.dirname(__file__), "../dashboard")
if os.path.exists(dashboard_dir):
    app.mount("/", StaticFiles(directory=dashboard_dir, html=True), name="dashboard")
