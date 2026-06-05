import os
import duckdb
import logging
from pathlib import Path
from fastapi import HTTPException

logger = logging.getLogger("pca.views.default")
PARQUET_BASE = Path(os.environ.get("PARQUET_BASE_PATH", "/parquet"))

def _parquet_path(symbol: str, timeframe: str, features: bool = False) -> Path:
    suffix = f"{timeframe}_features" if features else timeframe
    return PARQUET_BASE / symbol.upper() / f"{suffix}.parquet"

def get_chart_data_default(symbol: str, timeframe: str, limit: int, features: bool) -> dict:
    columns = ["timestamp", "open", "high", "low", "close", "volume"]
    data = []
    
    p = _parquet_path(symbol, timeframe, features=features)
    
    if not p.exists():
        if features:
            logger.warning(f"Feature parquet not found for {symbol}, falling back to OHLCV")
            p = _parquet_path(symbol, timeframe, features=False)
            
        if not p.exists():
            return {"symbol": symbol, "timeframe": timeframe, "count": 0, "columns": columns, "data": []}

    try:
        db = duckdb.connect()
        # Ensure timestamp is first, then OHLCV
        cols = "timestamp, open, high, low, close, volume"
        
        # Determine extra columns (if features are enabled)
        if features and p.name.endswith("_features.parquet"):
            schema_res = db.execute(f"DESCRIBE SELECT * FROM read_parquet('{p}') LIMIT 1").fetchall()
            all_cols = [r[0] for r in schema_res]
            base_cols = {"timestamp", "open", "high", "low", "close", "volume"}
            extra_cols = [c for c in all_cols if c not in base_cols]
            
            if extra_cols:
                cols += ", " + ", ".join(extra_cols)
                columns.extend(extra_cols)

        # We order by timestamp descending, limit, then flip so it's chronologically ascending
        res = db.execute(f"SELECT {cols} FROM read_parquet('{p}') ORDER BY timestamp DESC LIMIT {limit}").fetchall()
        db.close()
        
        # res is a list of tuples, newest first. Reverse to oldest first.
        res.reverse()

        for row in res:
            # Format: row is a tuple containing the selected columns
            row_list = list(row)
            
            # DuckDB timestamps might be returned as datetime objects or ints depending on schema
            # If it's a datetime object, convert to ms integer for lightweight charts
            ts = row_list[0]
            if hasattr(ts, "timestamp"):
                ts = int(ts.timestamp() * 1000)
                row_list[0] = ts
            elif isinstance(ts, int) and ts < 10000000000:
                row_list[0] = ts  # lightweight-charts accepts seconds if < 10000000000
                
            data.append(row_list)
            
    except Exception as e:
        logger.exception("DuckDB Error: %s", e)
        raise HTTPException(status_code=500, detail="Database error")

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "count": len(data),
        "columns": columns,
        "data": data
    }
