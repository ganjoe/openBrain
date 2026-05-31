import pytest
from unittest.mock import MagicMock, patch
import pandas as pd
from src.processor import FeatureProcessor, TickerProcessResult
from src.config_parser import ProcessingContext

@pytest.fixture
def mock_deps():
    storage = MagicMock()
    calculator = MagicMock()
    context = MagicMock(spec=ProcessingContext)
    context.timeframes = ["1D"]
    context.features = []
    context.thread_count = 2
    return context, storage, calculator

def test_process_single_ticker_success(mock_deps):
    context, storage, calculator = mock_deps
    processor = FeatureProcessor(context, storage, calculator)
    
    storage.load_ticker_data.return_value = pd.DataFrame({'close': [100]})
    calculator.calculate_features.return_value = pd.DataFrame({'close': [100], 'feat': [1]})
    
    results = processor._process_single_ticker("AAPL")
    
    assert len(results) == 1
    assert results[0].success is True
    assert results[0].ticker == "AAPL"
    storage.save_ticker_features.assert_called_once()

def test_process_single_ticker_error(mock_deps):
    context, storage, calculator = mock_deps
    processor = FeatureProcessor(context, storage, calculator)
    
    storage.load_ticker_data.side_effect = Exception("Load fail")
    
    results = processor._process_single_ticker("AAPL")
    
    assert len(results) == 1
    assert results[0].success is False
    assert "Load fail" in results[0].error_message

def test_process_all_tickers_uses_executor(mock_deps):
    context, storage, calculator = mock_deps
    processor = FeatureProcessor(context, storage, calculator)
    
    with patch.object(processor, "_process_single_ticker", return_value=[TickerProcessResult("AAPL", "1D", True)]):
        results = processor.process_all_tickers(["AAPL"])
        
        assert len(results) == 1
        assert results[0].ticker == "AAPL"
