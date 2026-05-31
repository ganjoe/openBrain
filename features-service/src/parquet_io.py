import pandas as pd
import os
from pathlib import Path
from typing import List

import pyarrow as pa
import pyarrow.parquet as pq
import logging

logger = logging.getLogger(__name__)


class ParquetStorage:
    def __init__(self, base_data_dir: str):
        self.base_dir = Path(base_data_dir)

    def load_ticker_data(self, ticker: str, timeframe: str) -> pd.DataFrame:
        """Loads /data/parquet/<ticker>/<timeframe>.parquet"""
        file_path = self.base_dir / ticker / f"{timeframe}.parquet"
        
        if not file_path.exists():
            raise FileNotFoundError(f"Source file not found: {file_path}")
            
        table = pq.read_table(str(file_path))
        df = table.to_pandas()
        # Reset index to ensure timestamp is a column (not an index)
        # Rename 'index' or 'level_0' to 'timestamp' if present
        if 'index' in df.columns:
            df = df.rename(columns={'index': 'timestamp'})
        elif 'level_0' in df.columns:
            df = df.rename(columns={'level_0': 'timestamp'})
        return df.reset_index(drop=True)

    def save_ticker_features(self, ticker: str, timeframe: str, df: pd.DataFrame) -> None:
        """Saves to /data/parquet/<ticker>/<timeframe>_features.parquet (atomic write via temp file + rename)"""
        output_dir = self.base_dir / ticker
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # Convert DataFrame to PyArrow Table without schema restriction
        # This allows feature columns to be included
        table = pa.Table.from_pandas(df, preserve_index=False)
        
        output_path = output_dir / f"{timeframe}_features.parquet"
        tmp_path = output_path.with_suffix(".parquet.tmp")
        
        try:
            pq.write_table(table, str(tmp_path))
            os.replace(str(tmp_path), str(output_path))
            logger.debug(f"Written {len(df)} rows to {ticker}/{timeframe}_features.parquet")
        except Exception as exc:
            logger.error(f"Failed to write parquet for {ticker}/{timeframe}: {exc}")
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
            raise
    
    def get_available_tickers(self) -> List[str]:
        """Scans the directory structure to identify which tickers have parquet data."""
        if not self.base_dir.exists():
            return []
        
        # Subdirectories in base_dir are assumed to be tickers
        return [d.name for d in self.base_dir.iterdir() if d.is_dir()]
