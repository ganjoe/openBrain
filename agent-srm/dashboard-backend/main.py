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
from risk_engine import PortfolioObject, TradeObject, PortfolioRepository

env_path = os.path.join(os.path.dirname(__file__), '../../.env')
load_dotenv(env_path)

SERVER_IP = os.environ.get("SERVER_IP", "10.20.0.23")
SUPABASE_URL = os.environ.get("SUPABASE_URL", f"http://{SERVER_IP}:8001")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

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
    target_date: str

class PortfolioStateRequest(BaseModel):
    target_date: str

def get_parquet_price(ticker: str, target_date: str):
    parquet_path = f"/home/daniel/stock-data-node/data/parquet/{ticker}/1D.parquet"
    if not os.path.exists(parquet_path):
        return None, None, None
    try:
        df = pd.read_parquet(parquet_path)
        if 'timestamp' in df.columns:
            df['timestamp'] = pd.to_datetime(df['timestamp'], unit='s')
            df.set_index('timestamp', inplace=True)
        elif not pd.api.types.is_datetime64_any_dtype(df.index):
            df.index = pd.to_datetime(df.index)
        
        mask = df.index <= pd.to_datetime(target_date)
        df_filtered = df.loc[mask]
        
        if df_filtered.empty:
            return None, None, None
            
        last_row = df_filtered.iloc[-1]
        
        close_col = 'close' if 'close' in last_row else 'Close'
        low_col = 'low' if 'low' in last_row else 'Low'
        
        last_date = last_row.name.normalize()
        return last_row[close_col], last_row[low_col], last_date
    except Exception as e:
        print(f"Error reading parquet for {ticker}: {e}")
        return None, None, None

def get_parquet_history(ticker: str, start_date: str, end_date: str):
    parquet_path = f"/home/daniel/stock-data-node/data/parquet/{ticker}/1D.parquet"
    if not os.path.exists(parquet_path):
        return None
    try:
        df = pd.read_parquet(parquet_path)
        if 'timestamp' in df.columns:
            df['timestamp'] = pd.to_datetime(df['timestamp'], unit='s')
            df.set_index('timestamp', inplace=True)
        elif not pd.api.types.is_datetime64_any_dtype(df.index):
            df.index = pd.to_datetime(df.index)
        
        start_dt = pd.to_datetime(start_date, utc=True).tz_localize(None).normalize()
        end_dt = pd.to_datetime(end_date, utc=True).tz_localize(None).normalize()
        
        mask = (df.index.normalize() >= start_dt) & (df.index.normalize() <= end_dt)
        return df.loc[mask]
    except Exception as e:
        print(f"Error reading parquet history for {ticker}: {e}")
        return None

@app.post("/api/portfolio_state")
def get_portfolio_state(req: PortfolioStateRequest):
    target_date = req.target_date
    target_dt = pd.to_datetime(target_date, utc=True)
    
    port_res = supabase.table("srm_portfolio").select("max_heat_pct, max_crisk_pct").limit(1).execute()
    port_data = port_res.data[0] if port_res.data else {"max_heat_pct": 1.0, "max_crisk_pct": 5.0}
    
    trades_res = supabase.table("srm_trades").select("*").order("ticker").execute()
    all_trades = trades_res.data or []
    
    simulated_trades = []
    realized_capital = 0.0
    invested_capital = 0.0
    open_pnl = 0.0
    total_heat_eur = 0.0
    total_crisk_eur = 0.0
    
    for t_data in all_trades:
        planned_str = t_data.get("planned") or "2000-01-01"
        planned_dt = pd.to_datetime(planned_str, utc=True)
        
        if planned_dt > target_dt:
            continue
            
        trade = TradeObject(t_data)
        ticker = trade.ticker
        
        history_df = get_parquet_history(ticker, planned_str, target_date)
        
        is_closed = False
        final_price = trade.price
        close_date = None
        
        if history_df is not None and not history_df.empty:
            for idx, row in history_df.iterrows():
                row_dt = idx.tz_localize('UTC') if idx.tz is None else idx
                active_sl = trade.get_active_sl(row_dt)
                
                low_col = 'low' if 'low' in row else 'Low'
                close_col = 'close' if 'close' in row else 'Close'
                
                if row[low_col] <= active_sl:
                    is_closed = True
                    final_price = active_sl
                    close_date = row_dt
                    break
                else:
                    final_price = row[close_col]
                    
            trade.update_current_price(final_price)
        else:
            # No parquet history. If it's a manual/deposit trade already closed in DB, respect it.
            if str(t_data.get("status")).lower() == "closed":
                db_closed_str = t_data.get("closed")
                if db_closed_str:
                    db_closed_dt = pd.to_datetime(db_closed_str, utc=True)
                    if db_closed_dt <= target_dt:
                        is_closed = True
                        close_date = db_closed_dt
                        trade.current_pnl = float(t_data.get("pnl", 0.0))
                else:
                    is_closed = True
                    trade.current_pnl = float(t_data.get("pnl", 0.0))
            else:
                trade.update_current_price(final_price)
        
        if is_closed:
            trade.status = "closed"
            realized_capital += trade.current_pnl
        else:
            trade.status = "ACTIVE"
            invested_capital += (trade.price * trade.nos)
            open_pnl += trade.current_pnl
            total_heat_eur += ((trade.current_price - trade.get_active_sl(target_dt)) * trade.nos)
            total_crisk_eur += trade.crisk_eur
            
        sim_data = dict(t_data)
        sim_data.update({
            "status": trade.status,
            "current_price": trade.current_price,
            "pnl": trade.current_pnl,
            "rmultiple": trade.current_r_multiple,
            "heat_eur": ((trade.current_price - trade.get_active_sl(target_dt)) * trade.nos) if not is_closed else 0.0,
            "closed": close_date.isoformat() if close_date else None
        })
        simulated_trades.append(sim_data)
        
    cash = realized_capital - invested_capital
    live_nav = realized_capital + open_pnl
    
    return {
        "trades": simulated_trades,
        "portfolio": {
            "nav": live_nav,
            "cash": cash,
            "cash_pct": (cash / live_nav * 100) if live_nav > 0 else 0,
            "heat_eur": total_heat_eur,
            "heat_pct": (total_heat_eur / live_nav * 100) if live_nav > 0 else 0,
            "crisk_eur": total_crisk_eur,
            "crisk_pct": (total_crisk_eur / live_nav * 100) if live_nav > 0 else 0,
        }
    }

@app.post("/api/advance_time")
def advance_time(req: AdvanceTimeRequest):
    return {"status": "success", "message": "advance_time is deprecated for simulations. Please use /api/portfolio_state"}

@app.get("/api/config")
async def get_config():
    return {
        "supabaseUrl": os.environ.get("SUPABASE_URL", "http://10.20.0.23:8001"),
        "supabaseKey": os.environ.get("ANON_KEY", "")
    }

@app.get("/api/check_data")
def check_data(target_date: str):
    trades_res = supabase.table("srm_trades").select("ticker, planned").execute()
    open_trades_data = trades_res.data or []
    
    t_date_pd = pd.to_datetime(target_date, utc=True)
    results = {}
    
    for t_data in open_trades_data:
        ticker = t_data.get("ticker")
        if not ticker: continue
        
        planned_str = t_data.get("planned")
        if planned_str and pd.to_datetime(planned_str, utc=True) > t_date_pd:
            continue
            
        close_price, low_price, _ = get_parquet_price(ticker, target_date)
        results[ticker] = (close_price is not None)
        
    return results

app.mount("/", StaticFiles(directory="../dashboard", html=True), name="dashboard")
