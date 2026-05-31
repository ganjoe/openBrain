import pytest
import multiprocessing
import time
import logging
import sys
from unittest.mock import MagicMock

# Mock dependencies that are not installed in the environment to allow testing logic
sys.modules["uvicorn"] = MagicMock()
sys.modules["fastapi"] = MagicMock()
sys.modules["fastapi.responses"] = MagicMock()
sys.modules["fastapi.staticfiles"] = MagicMock()
sys.modules["pydantic"] = MagicMock()
sys.modules["pydantic_core"] = MagicMock()
sys.modules["starlette"] = MagicMock()

from pathlib import Path
import json
import os
import pandas as pd
import importlib

def test_streaming_logs(tmp_path, monkeypatch):
    """
    Test if logs are correctly streamed through the JobManager using a multiprocessing Queue.
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
            }
        }
    }
    features_json.write_text(json.dumps(config_data))
    
    # 4. Setup Environment Variables for the test to use tmp_path
    monkeypatch.setenv("APP_BASE_DIR", str(tmp_path))
    
    # Add src to path if not there
    src_path = str(Path(__file__).parent.parent.parent / "src")
    if src_path not in sys.path:
        sys.path.insert(0, src_path)

    # Reload or import modules to pick up the new APP_BASE_DIR
    def safe_reload(name):
        if name in sys.modules:
            return importlib.reload(sys.modules[name])
        return importlib.import_module(name)

    main_mod = safe_reload('main')
    run_feature_pipeline = main_mod.run_feature_pipeline
    
    safe_reload('job_manager')
    from job_manager import JobManager
    
    safe_reload('config_parser')
    from config_parser import FeatureConfigParser, ProcessingContext
    
    safe_reload('calculator')
    from calculator import TechnicalCalculator
    
    safe_reload('parquet_io')
    from parquet_io import ParquetStorage

    # 5. Initialize JobManager and run streaming
    job_manager = JobManager()
    
    logs = []
    
    # Use a generator to collect logs
    def collect_logs():
        for log_line in job_manager.stream_feature_calculation(run_feature_pipeline):
            logs.append(log_line)

    collect_logs()

    # 6. Verify logs were captured
    assert len(logs) > 0, f"No logs were captured during streaming. Logs: {logs}"
    
    # Check for some expected log content
    found_expected = any("Calculating features" in line or "Feature calculation finished" in line for line in logs)
    assert found_expected, f"Expected log content not found in captured logs: {logs}"

if __name__ == "__main__":
    pytest.main([__file__])
