"""
Backtesting Engine – Configuration & Database Connection.
Loads environment variables and provides the Supabase client.
"""

import os
from dotenv import load_dotenv
from supabase import create_client, Client

# Load .env from project root
_env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(_env_path)

SERVER_IP = os.environ.get("SERVER_IP", "10.20.0.23")
SUPABASE_URL = os.environ.get("SUPABASE_URL", f"http://{SERVER_IP}:8001")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

PARQUET_BASE_PATH = os.environ.get(
    "PARQUET_BASE_PATH",
    "/home/daniel/stock-data-node/data/parquet"
)


def get_supabase_client() -> Client:
    """Create and return a Supabase client."""
    return create_client(SUPABASE_URL, SUPABASE_KEY)
