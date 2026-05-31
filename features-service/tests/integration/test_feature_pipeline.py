import pytest
import pandas as pd
import json
import os
from pathlib import Path
from src.config_parser import FeatureConfigParser, ProcessingContext
from src.calculator import TechnicalCalculator
from src.parquet_io import ParquetStorage
from src.processor import FeatureProcessor

def test_feature_calculation_pipeline(tmp_path):
    """
    Integration test for the full feature processing pipeline.
    F-PRC-010 to F-PRC-100.
    """
    # 1. Setup temporary directory structure
    data_dir = tmp_path / "data"
    parquet_dir = data_dir / "parquet"
    ticker = "TEST_TICKER"
    ticker_dir = parquet_dir / ticker
    ticker_dir.mkdir(parents=True)
    
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    features_json = config_dir / "features.json"
    
    # 2. Create sample source data (1D.parquet)
    source_df = pd.DataFrame({
        'timestamp': [1704067200, 1704153600, 1704240000, 1704326400, 1704412800],
        'open': [100.0, 110.0, 120.0, 130.0, 140.0],
        'high': [105.0, 115.0, 125.0, 135.0, 145.0],
        'low': [95.0, 105.0, 115.0, 125.0, 135.0],
        'close': [100.0, 110.0, 120.0, 130.0, 140.0],
        'volume': [1000, 1100, 1200, 1300, 1400]
    })
    source_df.to_parquet(ticker_dir / "1D.parquet", index=False)
    
    # 3. Create features.json
    config_data = {
        "features": {
            "ma_sma_3": {
                "window": 3,
                "type": "SMA",
                "color": "blue"
            },
            "ma_ema_2": {
                "window": 2,
                "type": "EMA",
                "color": "green"
            }
        }
    }
    features_json.write_text(json.dumps(config_data))
    
    # 4. Initialize Components
    config_parser = FeatureConfigParser(str(features_json))
    features = config_parser.parse()
    
    ctx = ProcessingContext(
        thread_count=1,
        data_dir=str(parquet_dir),
        timeframes=["1D"],
        features=features
    )
    
    storage = ParquetStorage(ctx.data_dir)
    calculator = TechnicalCalculator()
    processor = FeatureProcessor(ctx, storage, calculator)
    
    # 5. Execute Pipeline
    results = processor.process_all_tickers([ticker])
    
    # 6. Verify Results
    assert len(results) == 1
    assert results[0].success is True
    
    output_path = ticker_dir / "1D_features.parquet"
    assert output_path.exists()
    
    result_df = pd.read_parquet(output_path)
    
    assert "ma_sma_3" in result_df.columns
    assert "ma_ema_2" in result_df.columns
    
    assert result_df["ma_sma_3"].iloc[0] == pytest.approx(100.0)
    assert result_df["ma_sma_3"].iloc[4] == pytest.approx(130.0)
    
    assert result_df["ma_ema_2"].iloc[0] == pytest.approx(100.0)
    assert result_df["ma_ema_2"].iloc[4] > result_df["ma_ema_2"].iloc[0]
