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
