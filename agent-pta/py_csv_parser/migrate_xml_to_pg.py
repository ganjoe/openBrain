import os
import xml.etree.ElementTree as ET
import urllib.request
import urllib.error
import json
from datetime import datetime

# Configuration
ENV_FILE = "/home/daniel/openBrain/.env"
XML_FILE = "/home/daniel/openBrain/agent-pta/py_csv_parser/trades.xml"
POSTGREST_URL = "http://127.0.0.1:3001"

def load_env(env_path):
    env_vars = {}
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, val = line.split("=", 1)
                    env_vars[key.strip()] = val.strip()
    return env_vars

env = load_env(ENV_FILE)
SERVICE_ROLE_KEY = env.get("SERVICE_ROLE_KEY")

if not SERVICE_ROLE_KEY:
    print("Error: SERVICE_ROLE_KEY not found in .env file.")
    exit(1)

# Disable proxy auto-detection which can cause hangs on local addresses
proxy_handler = urllib.request.ProxyHandler({})
opener = urllib.request.build_opener(proxy_handler)
urllib.request.install_opener(opener)

def postgrest_request(path, method="GET", data=None):
    url = f"{POSTGREST_URL}{path}"
    headers = {
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    
    if method in ("POST", "PATCH"):
        headers["Prefer"] = "return=representation"
        
    req_data = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=req_data, headers=headers, method=method)
    
    print(f"-> Sending {method} request to {url}...", flush=True)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            res_data = response.read().decode("utf-8")
            if res_data:
                return json.loads(res_data)
            return None
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode('utf-8')}", flush=True)
        raise e
    except Exception as e:
        print(f"Request Error: {e}", flush=True)
        raise e


def get_existing_ids():
    try:
        # Fetch existing trade_ids from Postgres
        rows = postgrest_request("/pta_execution_log?select=trade_id")
        return {r["trade_id"] for r in rows if r.get("trade_id")}
    except Exception as e:
        print(f"Error fetching existing trade_ids: {e}")
        return set()

def parse_number(val):
    if not val:
        return 0.0
    val = val.strip().replace(",", ".")
    try:
        return float(val)
    except ValueError:
        return 0.0

def parse_datetime(date_str, time_str=None):
    if not time_str:
        time_str = "12:00:00"
    try:
        dt = datetime.strptime(f"{date_str.strip()} {time_str.strip()}", "%d.%m.%Y %H:%M:%S")
        return dt.isoformat() + "Z"
    except ValueError:
        try:
            dt = datetime.strptime(f"{date_str.strip()} {time_str.strip()}", "%Y-%m-%d %H:%M:%S")
            return dt.isoformat() + "Z"
        except ValueError:
            return None

def main():
    if not os.path.exists(XML_FILE):
        print(f"Error: XML file not found at {XML_FILE}")
        return

    print("Fetching existing IDs from database...", flush=True)
    existing_ids = get_existing_ids()
    print(f"Found {len(existing_ids)} existing trade/event IDs in the database.", flush=True)

    print(f"Parsing XML file: {XML_FILE}", flush=True)
    tree = ET.parse(XML_FILE)
    root = tree.getroot()

    events_to_insert = []

    # 1. Parse Trades
    trades_node = root.find("Trades")
    if trades_node is not None:
        for trade in trades_node.findall("Trade"):
            trade_id = trade.get("id")
            if not trade_id:
                continue
            if trade_id in existing_ids:
                continue

            name = trade.get("name", "")
            isin = trade.get("isin", "")

            meta = trade.find("Meta")
            date_str = meta.find("Date").text if meta is not None and meta.find("Date") is not None else ""
            time_str = meta.find("Time").text if meta is not None and meta.find("Time") is not None else ""

            instrument = trade.find("Instrument")
            symbol = instrument.find("Symbol").text if instrument is not None and instrument.find("Symbol") is not None else ""
            currency = instrument.find("Currency").text if instrument is not None and instrument.find("Currency") is not None else "USD"

            execution = trade.find("Execution")
            qty_raw = execution.find("Quantity").text if execution is not None and execution.find("Quantity") is not None else "0"
            price_raw = execution.find("Price").text if execution is not None and execution.find("Price") is not None else "0"
            comm_raw = execution.find("Commission").text if execution is not None and execution.find("Commission") is not None else "0"

            qty_val = parse_number(qty_raw)
            action = "BUY" if qty_val > 0 else "SELL"
            quantity = abs(qty_val)
            price = parse_number(price_raw)
            commission = abs(parse_number(comm_raw))

            created_at = parse_datetime(date_str, time_str)

            notes = f"{name} (ISIN: {isin})" if name or isin else "Migrated trade"

            events_to_insert.append({
                "trade_id": trade_id,
                "ticker": symbol,
                "event_type": "FILL",
                "action": action,
                "quantity": quantity,
                "price": price,
                "commission": commission,
                "currency": currency,
                "notes": notes,
                "created_at": created_at
            })

    # 2. Parse Dividends
    divs_node = root.find("Dividends")
    if divs_node is not None:
        for div in divs_node.findall("Dividend"):
            div_id = div.get("id")
            if not div_id:
                continue
            if div_id in existing_ids:
                continue

            date_str = div.find("Date").text if div.find("Date") is not None else ""
            symbol = div.find("Symbol").text if div.find("Symbol") is not None else ""
            amount_raw = div.find("Amount").text if div.find("Amount") is not None else "0"
            currency = div.find("Currency").text if div.find("Currency") is not None else "USD"
            desc = div.find("Desc").text if div.find("Desc") is not None else "Dividend payment"

            amount = abs(parse_number(amount_raw))
            created_at = parse_datetime(date_str, "12:00:00")

            events_to_insert.append({
                "trade_id": div_id,
                "ticker": symbol,
                "event_type": "CASH_TRANSFER",
                "action": "DEPOSIT",
                "quantity": amount,
                "price": None,
                "commission": 0.0,
                "currency": currency,
                "notes": desc,
                "created_at": created_at
            })

    # 3. Parse Deposits/Withdrawals
    deps_node = root.find("DepositsWithdrawals")
    if deps_node is not None:
        for trans in deps_node.findall("Transaction"):
            trans_id = trans.get("id")
            if not trans_id:
                continue
            if trans_id in existing_ids:
                continue

            date_str = trans.find("Date").text if trans.find("Date") is not None else ""
            desc = trans.find("Desc").text if trans.find("Desc") is not None else "Cash Transfer"
            amount_raw = trans.find("Amount").text if trans.find("Amount") is not None else "0"
            currency = trans.find("Currency").text if trans.find("Currency") is not None else "EUR"

            amount_val = parse_number(amount_raw)
            action = "DEPOSIT" if amount_val > 0 else "WITHDRAW"
            amount = abs(amount_val)
            created_at = parse_datetime(date_str, "12:00:00")

            events_to_insert.append({
                "trade_id": trans_id,
                "ticker": "CASH",
                "event_type": "CASH_TRANSFER",
                "action": action,
                "quantity": amount,
                "price": None,
                "commission": 0.0,
                "currency": currency,
                "notes": desc,
                "created_at": created_at
            })

    total_events = len(events_to_insert)
    if total_events == 0:
        print("No new events to migrate (all exist already or file is empty).")
        return

    print(f"Prepared {total_events} events for migration. Pushing to database...", flush=True)

    # PostgREST allows inserting multiple rows by POSTing a JSON list.
    # We will send them in chunks of 100 to avoid request size issues, although 1000s is usually fine.
    chunk_size = 100
    for i in range(0, total_events, chunk_size):
        chunk = events_to_insert[i:i+chunk_size]
        try:
            postgrest_request("/pta_execution_log", method="POST", data=chunk)
            print(f"Migrated {i + len(chunk)} / {total_events} events...", flush=True)
        except Exception as e:
            print(f"Error migrating chunk starting at index {i}: {e}", flush=True)
            return

    print("Migration completed successfully!", flush=True)

if __name__ == "__main__":
    main()
