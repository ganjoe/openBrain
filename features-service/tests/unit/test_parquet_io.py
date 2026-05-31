import pytest
import pandas as pd
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))
from parquet_io import ParquetStorage


@pytest.fixture
def storage(tmp_path):
    return ParquetStorage(str(tmp_path))


def test_load_ticker_data_exists(storage, tmp_path):
    """Test loading existing parquet file."""
    ticker_dir = tmp_path / "AAPL"
    ticker_dir.mkdir()
    
    df = pd.DataFrame({
        'timestamp': [1704067200, 1704153600, 1704240000],
        'open': [100.0, 110.0, 120.0],
        'high': [105.0, 115.0, 125.0],
        'low': [95.0, 105.0, 115.0],
        'close': [100.0, 110.0, 120.0],
        'volume': [1000, 1100, 1200]
    })
    table = pa.Table.from_pandas(df)
    pq.write_table(table, str(ticker_dir / "1D.parquet"))
    
    result_df = storage.load_ticker_data("AAPL", "1D")
    assert len(result_df) == 3
    assert "close" in result_df.columns


def test_load_ticker_data_missing(storage):
    """Test loading non-existent parquet file."""
    with pytest.raises(FileNotFoundError):
        storage.load_ticker_data("MISSING", "1D")


def test_save_ticker_features(storage, tmp_path):
    """Test saving features to parquet with atomic write."""
    df = pd.DataFrame({
        'timestamp': [1704067200, 1704153600],
        'open': [100.0, 110.0],
        'high': [105.0, 115.0],
        'low': [95.0, 105.0],
        'close': [100.0, 110.0],
        'volume': [1000, 1100]
    })
    
    storage.save_ticker_features("AAPL", "1D", df)
    
    output_path = Path(storage.base_dir) / "AAPL" / "1D_features.parquet"
    assert output_path.exists()
    
    table = pq.read_table(str(output_path))
    result_df = table.to_pandas()
    assert len(result_df) == 2
    assert "close" in result_df.columns


def test_save_ticker_features_creates_dir(storage, tmp_path):
    """Test that save creates ticker directory if it doesn't exist."""
    df = pd.DataFrame({
        'timestamp': [1704067200],
        'open': [100.0],
        'high': [105.0],
        'low': [95.0],
        'close': [100.0],
        'volume': [1000]
    })
    
    storage.save_ticker_features("NEW_TICKER", "1D", df)
    
    ticker_dir = Path(storage.base_dir) / "NEW_TICKER"
    assert ticker_dir.exists()


def test_get_available_tickers(storage, tmp_path):
    """Test getting list of available tickers."""
    (tmp_path / "AAPL").mkdir()
    (tmp_path / "TSLA").mkdir()
    (tmp_path / "other.txt").touch()
    
    tickers = storage.get_available_tickers()
    assert "AAPL" in tickers
    assert "TSLA" in tickers
    assert "other.txt" not in tickers
    assert len(tickers) == 2
