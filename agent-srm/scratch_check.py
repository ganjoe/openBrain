import os
from supabase import create_client
from dotenv import load_dotenv

load_dotenv("/home/daniel/openBrain/.env")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://127.0.0.1:8001")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

client = create_client(SUPABASE_URL, SUPABASE_KEY)
trades = client.table("srm_trades").select("*").execute()
print("TRADES:", trades.data)
portfolio = client.table("srm_portfolio").select("*").execute()
print("PORTFOLIO:", portfolio.data)
