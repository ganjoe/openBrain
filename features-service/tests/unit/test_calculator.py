import pytest
import pandas as pd
import numpy as np
from src.calculator import TechnicalCalculator
from src.config_parser import FeatureConfig, FeatureType

@pytest.fixture
def sample_data():
    """Simple price data for 5 days."""
    return pd.DataFrame({
        'timestamp': [1, 2, 3, 4, 5],
        'close': [100.0, 110.0, 120.0, 130.0, 140.0]
    })

def test_sma_calculation_with_ipo_backfill(sample_data):
    """
    Test that SMA 3 on 5 days of data works.
    With window=3, the first day (index 0) should have a value of 100.0 
    because we prepend two copies of the first day.
    """
    calc = TechnicalCalculator()
    config = FeatureConfig(feature_id="sma3", feature_type=FeatureType.SMA, window=3)
    
    result = calc.calculate_features(sample_data, [config])
    
    assert result['sma3'].iloc[0] == pytest.approx(100.0)
    assert result['sma3'].iloc[1] == pytest.approx(103.333333)
    assert result['sma3'].iloc[2] == pytest.approx(110.0)
    assert result['sma3'].iloc[3] == pytest.approx(120.0)
    assert result['sma3'].iloc[4] == pytest.approx(130.0)

def test_ema_calculation_initial_values(sample_data):
    calc = TechnicalCalculator()
    config = FeatureConfig(feature_id="ema3", feature_type=FeatureType.EMA, window=3)
    
    result = calc.calculate_features(sample_data, [config])
    
    assert result['ema3'].iloc[0] == pytest.approx(100.0)
    assert result['ema3'].iloc[4] > result['ema3'].iloc[0]

def test_calculate_features_multiple_indicators(sample_data):
    calc = TechnicalCalculator()
    configs = [
        FeatureConfig(feature_id="sma3", feature_type=FeatureType.SMA, window=3),
        FeatureConfig(feature_id="ema3", feature_type=FeatureType.EMA, window=3)
    ]
    
    result = calc.calculate_features(sample_data, configs)
    assert "sma3" in result.columns
    assert "ema3" in result.columns
    assert len(result) == 5

def test_calculate_features_empty_df():
    calc = TechnicalCalculator()
    df = pd.DataFrame()
    config = FeatureConfig(feature_id="sma3", feature_type=FeatureType.SMA, window=3)
    
    result = calc.calculate_features(df, [config])
    assert result.empty
