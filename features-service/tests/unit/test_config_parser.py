import pytest
import json
from pathlib import Path
from src.config_parser import FeatureConfigParser, FeatureType, FeatureConfig

def test_config_parser_valid_file(tmp_path):
    # Setup
    config_data = {
        "features": {
            "ma_sma_10": {
                "window": 10,
                "type": "SMA",
                "color": "red"
            },
            "invalid_type": {
                "window": 5,
                "type": "NON_EXISTENT"
            }
        }
    }
    config_file = tmp_path / "features.json"
    config_file.write_text(json.dumps(config_data))
    
    # Act
    parser = FeatureConfigParser(str(config_file))
    configs = parser.parse()
    
    # Assert
    assert len(configs) == 2
    
    # First config
    ma10 = next(c for c in configs if c.feature_id == "ma_sma_10")
    assert ma10.feature_type == FeatureType.SMA
    assert ma10.window == 10
    assert "color" not in ma10.additional_params # Visual params should be ignored
    
    # Second config
    invalid = next(c for c in configs if c.feature_id == "invalid_type")
    assert invalid.feature_type == FeatureType.UNKNOWN

def test_config_parser_missing_file():
    parser = FeatureConfigParser("non_existent_file.json")
    configs = parser.parse()
    assert configs == []
