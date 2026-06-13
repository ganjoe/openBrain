import os
import requests
from dotenv import load_dotenv

load_dotenv("/home/daniel/openBrain/.env")
key = os.environ.get("SERVICE_ROLE_KEY")

# Get portfolio ID
port_res = requests.get("http://127.0.0.1:3001/srm_portfolio", headers={"Authorization": f"Bearer {key}"})
portfolio_id = port_res.json()[0]["portfolio_id"]

db_trade_data = {
    "portfolio_id": portfolio_id,
    "status": "closed",
    "planned": "2020-01-01T00:00:00Z",
    "closed": "2020-01-01T00:00:00Z",
    "ticker": "DEPOSIT",
    "cbase": 0.0,
    "nos": 0,
    "sl": 0.0,
    "tp": 0.0,
    "pnl": 10000.0,
    "crisk_eur": 0.0,
    "heat_eur": 0.0
}

res = requests.post("http://127.0.0.1:3001/srm_trades", json=db_trade_data, headers={"Authorization": f"Bearer {key}", "Prefer": "return=representation"})
print("STATUS:", res.status_code)
print("RESPONSE:", res.text)
