from typing import Optional
from pydantic import BaseModel, field_validator

class MARequest(BaseModel):
    """Request body for on-the-fly moving average calculation."""
    ticker: str                          # e.g. "AAPL"
    ma_type: str                         # "sma" or "ema"
    chart_timeframe: str = "1D"          # source data timeframe, e.g. "1D"
    ma_window: int                       # MA period, e.g. 50

    @field_validator("ma_type")
    @classmethod
    def validate_ma_type(cls, v: str) -> str:
        v = v.upper()
        if v not in ("SMA", "EMA"):
            raise ValueError(f"ma_type must be 'sma' or 'ema', got '{v}'")
        return v

    @field_validator("ma_window")
    @classmethod
    def validate_window(cls, v: int) -> int:
        if v < 1 or v > 500:
            raise ValueError(f"ma_window must be between 1 and 500, got {v}")
        return v

class RSRequest(BaseModel):
    """Request body for on-the-fly RS Rating calculation."""
    ticker: str                                  # e.g. "AAPL"
    benchmark: Optional[str] = None              # e.g. "SPX", None = vs all tickers
    chart_timeframe: str = "1D"                  # source data timeframe

class MinerviniRequest(BaseModel):
    """Request body for on-the-fly Minervini Trend Template calculation."""
    ticker: str                                  # e.g. "AAPL"
    chart_timeframe: str = "1D"                  # source data timeframe

class ClusterRequest(BaseModel):
    """Request body for correlation-based stock clustering."""
    source_watchlist: Optional[str] = None       # e.g. "growth_stocks", None = all tickers
    lookback_days: int = 63                      # number of trading days for correlation
    num_clusters: int = 10                       # number of groups to generate

    @field_validator("lookback_days")
    @classmethod
    def validate_lookback(cls, v: int) -> int:
        if v < 10 or v > 504:
            raise ValueError(f"lookback_days must be between 10 and 504, got {v}")
        return v

    @field_validator("num_clusters")
    @classmethod
    def validate_clusters(cls, v: int) -> int:
        if v < 2 or v > 50:
            raise ValueError(f"num_clusters must be between 2 and 50, got {v}")
        return v

class ScannerRequest(BaseModel):
    """Request body for running stock scanners."""
    scanner_type: str = "madbo_breakout"
    lookback_days: int = 150
    max_wick_pct: float = 0.05
    daily_range_ratio: float = 2.0
    history_lookback_days: int = 1
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    watchlist_name: Optional[str] = None
    stream_telemetry: bool = True
    list_all_tickers: bool = False

