import sys
import pandas as pd
import os
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
        
        # Start date should be just the day
        start_dt = pd.to_datetime(start_date).normalize()
        end_dt = pd.to_datetime(end_date).normalize()
        
        mask = (df.index.normalize() >= start_dt) & (df.index.normalize() <= end_dt)
        return df.loc[mask]
    except Exception as e:
        print(f"Error reading parquet for {ticker}: {e}")
        return None
