# Implementation Plan: Features Logic

## Overview
This document defines how stock data features and technical indicators are implemented, calculated, and orchestrated within the system.

## 1. Feature Configuration Parsing
Features are defined in `features.json` and parsed into functional components, stripping visual properties.
- **Target File:** `src/features/config_parser.py`
- **Logic:**
  - Extracts `type`, `window`, and `period` for calculations.
  - Skips visual properties like `color`, `style`, `pane`, `chart_type`.
  - Maps to `FeatureType` enum (`SMA`, `EMA`, `BOLLINGER_BAND`, `STOCHASTIC`, `IBD_RS`). Unrecognized parameters go into `additional_params`.

## 2. Technical Calculator & Backfilling
Applies technical indicators to the DataFrame loaded from parquet using pandas rolling logic.
- **Target File:** `src/features/calculator.py`
- **Logic:**
  - Calculates specific features (e.g., `_calc_sma`, `_calc_ema`) based on the requested window.
  - **Backfilling:** Duplicates the first valid value backwards to fill missing early data (first `window` rows), ensuring no `NaN` or `0` logic disrupts subsequent pipeline stages.
  - Stubs provided for complex features like `BOLLINGER_BAND` and `STOCHASTIC`.

## 3. Storage & IO Integration
Reads raw OHLCV Parquet files, calculates the features, and saves them as specialized feature parquet files.
- **Target File:** `src/features/parquet_io.py`
- **Logic:**
  - `load_ticker_data`: Loads base data from `/data/parquet/<ticker>/<timeframe>.parquet`.
  - `save_ticker_features`: Writes calculated feature data to `/data/parquet/<ticker>/<timeframe>_features.parquet` by overwriting.

## 4. Multi-Core Processor Orchestration
Handles processing of multiple tickers in isolation using parallel threads/processes.
- **Target File:** `src/features/processor.py`
- **Logic:**
  - Uses `ProcessPoolExecutor` utilizing threads as configured in context.
  - Dispatches atomic batch compute logic down to individual tickers and timeframes.
  - Ensures failures in a single ticker process do not crash the executor.

## 5. Job Overlap Protection
Limits concurrent feature calculation jobs to prevent state corruption.
- **Target File:** `src/features/job_manager.py`
- **Logic:**
  - Singleton Mutex lock (`threading.Lock`) enforcing synchronous start over an asynchronous worker.
  - Drop/Skip repeated inputs if `self._is_running` is True. Automatically resets via `finally` blocks.

## 6. Triggering Endpoint
Feature calculation is manually triggered via the API.
- **Target Route:** `POST /features/calculate` -> `src/api/routes_features.py`
- **Logic:**
  - Triggers the background task using `job_manager.start_feature_calculation(...)`.
  - Returns `202 Accepted` if started, `409 Conflict` if currently running.

## 7. Cross-Sectional Feature Processing
Certain features (like IBD RS Rating) require data across all tickers on a given date to compute percentiles/ranks.
- **Target File:** `src/features/processor.py` & `src/features/calculator.py`
- **Logic:**
  - **Pass 1:** Per-ticker calculation in `calculator.py` appends temporary hidden columns ending in `_raw` (e.g. `ibd_rs_raw`).
  - **Memory Transfer:** `processor.py` extracts these `_raw` columns into individual Pandas Series and returns them via `TickerProcessResult.cross_sectional_data` over IPC. It explicitly drops the `_raw` columns before saving the feature parquet to disk.
  - **Pass 2:** Central `processor` main loop (`_process_cross_sectional_features`) aggregates all raw series into a single matrix.
  - **Ranking:** Computes the cross-sectional percentile via `.rank(pct=True, axis=1)`.
  - **Pass 3:** Injects the resulting bounded integer rank (1-99) back into the saved parquet feature files.

## 8. Minervini Trend Template Score
Evaluates stock against Stan Weinstein/Mark Minervini trend template criteria using 8 conditions.
- **Target File:** `src/features/calculator.py` (`_calc_minervini_trend`) & `config/features.json`
- **Logic:**
  - Calculates two output columns: `minervini_score` (0-8 points), `minervini_trend_template` (boolean).
  - **Condition 1:** Current price > SMA_150 AND price > SMA_200
  - **Condition 2:** SMA_150 > SMA_200 (bullish MA alignment)
  - **Condition 3:** SMA_200 trending upward (> value from 20 trading days ago)
  - **Condition 4:** SMA_50 > SMA_150 AND SMA_50 > SMA_200 (short-term momentum)
  - **Condition 5:** Current price > SMA_50 (price above short-term average)
  - **Condition 6:** Price >= 52-week low * 1.30 (at least 30% gain from bottom)
  - **Condition 7:** Price >= 52-week high * 0.75 (within 25% of yearly high)
  - **Condition 8:** RS_Rating >= 70 (outperforming 70% of universe)
  - Score = 8 indicates a perfect trend template match.
