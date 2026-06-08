import httpx
import duckdb
import os
import sys

def main():
    print("Fetching unique tickers from pta_trade_history...")
    try:
        r = httpx.get("http://postgrest:3000/pta_trade_history?select=ticker")
        r.raise_for_status()
        data = r.json()
        tickers = set([item["ticker"] for item in data if item.get("ticker")])
    except Exception as e:
        print(f"Error fetching from postgrest: {e}")
        return

    print(f"Found {len(tickers)} unique traded tickers.")

    parquet_dir = "/parquet"
    con = duckdb.connect()

    missing_files = []
    null_prices = []
    ok_tickers = []

    for ticker in tickers:
        filepath = os.path.join(parquet_dir, f"{ticker}/1D.parquet")
        if not os.path.exists(filepath):
            missing_files.append(ticker)
            continue
        
        try:
            # Check if there are any rows with NULL close price
            query = f"SELECT count(*) as null_count FROM read_parquet('{filepath}') WHERE close IS NULL"
            result = con.execute(query).fetchone()
            null_count = result[0]
            
            if null_count > 0:
                null_prices.append((ticker, null_count))
            else:
                ok_tickers.append(ticker)
        except Exception as e:
            print(f"Error reading {ticker}.parquet: {e}")
            missing_files.append(ticker)

    print("\n--- TEST RESULTS ---")
    print(f"Total Tickers Checked: {len(tickers)}")
    print(f"Tickers OK (File exists, no NULL close prices): {len(ok_tickers)}")
    
    if missing_files:
        print(f"\n[WARNING] Missing or unreadable Parquet files ({len(missing_files)}):")
        for t in missing_files:
            print(f"  - {t}")
            
    if null_prices:
        print(f"\n[WARNING] Tickers with NULL close prices ({len(null_prices)}):")
        for t, count in null_prices:
            print(f"  - {t}: {count} NULL rows")

    if not missing_files and not null_prices:
        print("\n[SUCCESS] All traded tickers have valid Parquet data without NULL close prices!")
        sys.exit(0)
    else:
        sys.exit(1)

if __name__ == "__main__":
    main()
