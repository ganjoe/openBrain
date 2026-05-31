import json
from enum import Enum
from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional
from pathlib import Path

class FeatureType(str, Enum):
    SMA = "SMA"
    EMA = "EMA"
    BOLLINGER_BAND = "BOLLINGER_BAND"
    STOCHASTIC = "STOCHASTIC"
    IBD_RS = "IBD_RS"
    MINERVINI_TREND = "MINERVINI_TREND"
    BREADTH_MINERVINI = "BREADTH_MINERVINI"
    UNKNOWN = "UNKNOWN"

@dataclass
class FeatureConfig:
    """Represents the purely functional arguments of a feature from features.json"""
    feature_id: str             # e.g., "ma_sma_10"
    feature_type: FeatureType
    window: Optional[int] = None
    period: str = "D"
    additional_params: Dict[str, Any] = field(default_factory=dict)

@dataclass
class ProcessingContext:
    """Orchestration context for feature calculation."""
    thread_count: int
    data_dir: str
    timeframes: List[str]
    features: List[FeatureConfig]

class FeatureConfigParser:
    def __init__(self, config_path: str):
        self.config_path = Path(config_path)
        
    def parse(self) -> List[FeatureConfig]:
        """Reads features.json and maps to FeatureConfig objects, ignoring visual properties."""
        if not self.config_path.exists():
            return []
            
        with open(self.config_path, 'r') as f:
            data = json.load(f)
            
        features = data.get("features", {})
        configs = []
        
        visual_keys = {'color', 'style', 'pane', 'chart_type', 'thickness'}
        
        for feature_id, params in features.items():
            f_type_str = params.get("type", "UNKNOWN")
            try:
                # Type safe conversion from string to enum
                f_type = FeatureType(f_type_str.upper())
            except ValueError:
                f_type = FeatureType.UNKNOWN
                
            # Extract core params
            window = params.get("window")
            period = params.get("period", "D")
            
            # Extract additional non-visual params
            additional: Dict[str, Any] = {
                str(k): v for k, v in params.items() 
                if k not in visual_keys and k not in {'type', 'window', 'period'}
            }
            
            configs.append(FeatureConfig(
                feature_id=str(feature_id),
                feature_type=f_type,
                window=int(window) if window is not None else None,
                period=str(period),
                additional_params=additional
            ))
            
        return configs
