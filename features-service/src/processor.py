import logging
import traceback
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor, as_completed
from typing import List, Optional, Dict
import pandas as pd
import multiprocessing
from dataclasses import dataclass

from config_parser import FeatureConfig, ProcessingContext, FeatureType
from calculator import TechnicalCalculator
from parquet_io import ParquetStorage

logger = logging.getLogger(__name__)

@dataclass
class TickerProcessResult:
    """Result of processing a single ticker."""
    ticker: str
    timeframe: str
    success: bool
    data_points: int = 0
    error_message: Optional[str] = None

class FeatureProcessor:
    def __init__(self, context: ProcessingContext, storage: ParquetStorage, calculator: TechnicalCalculator):
        self.context = context
        self.storage = storage
        self.calculator = calculator

    def _precompute_cross_sectional(self, tickers: List[str]) -> Dict[str, Dict[str, Dict[str, pd.Series]]]:
        """
        Reads data for all tickers and pre-computes cross-sectional features like RS Rating.
        Returns: {timeframe: {ticker: {feature_col: pd.Series(ratings)}}}
        """
        logger.info("⚙️  Pass 0: Pre-computing cross-sectional features (e.g. RS Rating). Loading data...")
        
        ranked_configs = [c for c in self.context.features if c.feature_type == FeatureType.IBD_RS]
        agg_configs = [c for c in self.context.features if str(c.additional_params.get("aggregation", "")).lower() == "all"]
        cs_configs = ranked_configs + agg_configs
        
        if not cs_configs:
            return {}

        ticker_series_by_tf = {tf: {} for tf in self.context.timeframes}
        
        def _read_and_compute_raw(t: str):
            res = {}
            for tf in self.context.timeframes:
                try:
                    df = self.storage.load_ticker_data(t, tf)
                    if len(df) == 0: continue
                    res[tf] = []
                    # Compute raw values dynamically using calculator
                    for config in cs_configs:
                        if config.feature_type == FeatureType.IBD_RS:
                            self.calculator._calc_ibd_rs_raw(df, config)
                        elif config.feature_type == FeatureType.BREADTH_MINERVINI:
                            self.calculator._calc_breadth_minervini_raw(df, config)
                            
                        col_name = f"{config.feature_id}_raw"
                        if col_name in df.columns:
                            series = df[col_name].copy()
                            if 'timestamp' in df.columns:
                                series.index = df['timestamp']
                            res[tf].append((col_name, series))
                except Exception:
                    pass
            return t, res

        # Fast parallel reading and raw calculation
        with ThreadPoolExecutor(max_workers=self.context.thread_count) as executor:
            futures = [executor.submit(_read_and_compute_raw, t) for t in tickers]
            for f in as_completed(futures):
                t, res = f.result()
                for tf, tuples in res.items():
                    for (col_name, series) in tuples:
                        if col_name not in ticker_series_by_tf[tf]:
                            ticker_series_by_tf[tf][col_name] = {}
                        ticker_series_by_tf[tf][col_name][t] = series
                    
        # Now compute percentiles or aggregations globally
        logger.info("⚙️  Pass 0: Ranking / Aggregating features globally...")
        result_dict = {tf: {} for tf in self.context.timeframes}
        
        for tf, features in ticker_series_by_tf.items():
            for feature_raw_col, ticker_series_dict in features.items():
                target_col = feature_raw_col.replace("_raw", "")
                central_df = pd.DataFrame(ticker_series_dict)
                
                config = next((c for c in cs_configs if f"{c.feature_id}_raw" == feature_raw_col), None)
                is_agg = config and str(config.additional_params.get("aggregation", "")).lower() == "all"
                
                if is_agg:
                    counts = central_df.sum(axis=1, skipna=True)
                    mode = str(config.additional_params.get("mode", "absolute")).lower()
                    
                    if mode == "pct_abs":
                        totals = central_df.notna().sum(axis=1)
                        import numpy as np
                        totals_safe = totals.replace(0, np.nan)
                        global_series = (counts / totals_safe) * 100
                        global_series = global_series.round(2).fillna(0).astype("float64")
                    else:
                        global_series = counts.astype("Int64")
                    
                    for t in central_df.columns:
                        if t not in result_dict[tf]:
                            result_dict[tf][t] = {}
                        result_dict[tf][t][target_col] = global_series.dropna()
                else:
                    # Ranking logic (e.g. IBD_RS)
                    N_per_row = central_df.notna().sum(axis=1)
                    rank_df = central_df.rank(axis=1, na_option='keep')
                    
                    N_minus_1 = (N_per_row - 1).clip(lower=1)
                    rating_df = ((rank_df.sub(1)).div(N_minus_1, axis=0) * 98 + 1)
                    rating_df = rating_df.round().clip(1, 99)
                    
                    single_ticker_rows = N_per_row <= 1
                    if single_ticker_rows.any():
                        rating_df.loc[single_ticker_rows] = 50
                        
                    rating_df = rating_df.astype("Int64")
                    
                    # Distribute back to mapping
                    for t in rating_df.columns:
                        if t not in result_dict[tf]:
                            result_dict[tf][t] = {}
                        result_dict[tf][t][target_col] = rating_df[t].dropna()
                    
        return result_dict

    def process_all_tickers(self, tickers: List[str], log_queue: Optional[multiprocessing.Queue] = None) -> List[TickerProcessResult]:
        """Spawns parallel processes to compute features for all tickers."""
        import time
        start_time = time.perf_counter()
        
        # --- PASS 0: PRE-COMPUTE CROSS SECTIONAL ---
        global_cs_data = self._precompute_cross_sectional(tickers)
        
        results = []
        total_tickers = len(tickers)
        completed = 0
        last_logged_pct = 0
        
        logger.info(f"⚙️  Pass 1: Spawning {self.context.thread_count} worker processes for parallel calculation and I/O...")
        ctx = multiprocessing.get_context('spawn')
        with ProcessPoolExecutor(max_workers=self.context.thread_count, mp_context=ctx) as executor:
            future_to_ticker = {}
            for t in tickers:
                # Extract the small CS dictionary for this specific ticker across all timeframes
                ticker_cs = {tf: global_cs_data.get(tf, {}).get(t, {}) for tf in self.context.timeframes}
                future_to_ticker[executor.submit(self._process_single_ticker, t, ticker_cs, log_queue)] = t
            
            for future in as_completed(future_to_ticker):
                ticker = future_to_ticker[future]
                completed += 1
                try:
                    ticker_results = future.result()
                    results.extend(ticker_results)
                except Exception as exc:
                    logger.error(f"Ticker {ticker} generated an exception: {exc}")
                    logger.error(traceback.format_exc())
                    results.append(TickerProcessResult(ticker, "all", False, 0, str(exc)))
                
                pct = int((completed / total_tickers) * 100)
                if pct - last_logged_pct >= 10 or completed == total_tickers:
                    logger.info(f"⚙️  Feature processing: {pct}% ({completed}/{total_tickers} tickers)")
                    last_logged_pct = pct

        elapsed = time.perf_counter() - start_time
        successful_results = [r for r in results if r.success]
        failed_results = [r for r in results if not r.success]
        
        total_pts = sum(r.data_points for r in successful_results)
        num_features = len(self.context.features) if hasattr(self.context, 'features') and self.context.features else 0
        
        logger.info("═══════════════════════════════════════════════════════════════")
        logger.info(f"✨ Feature Calculation Summary:")
        logger.info(f"   • Tickers processed : {total_tickers}")
        logger.info(f"   • Data points       : {total_pts:,d}".replace(",", "."))
        logger.info(f"   • Features per point: {num_features}")
        logger.info(f"   • Duration          : {elapsed:.2f}s")
        if failed_results:
            logger.warning(f"   • Failed tickers    : {len(failed_results)}")
        logger.info("═══════════════════════════════════════════════════════════════")
        
        return results

    def _process_single_ticker(self, ticker: str, precomputed_cs: Dict[str, Dict[str, pd.Series]], log_queue: Optional[multiprocessing.Queue] = None) -> List[TickerProcessResult]:
        """The atomic unit of work executed by worker threads/processes."""
        handler = None
        if log_queue:
            import logging
            from logging.handlers import QueueHandler
            handler = QueueHandler(log_queue)
            root_logger = logging.getLogger()
            root_logger.addHandler(handler)
            root_logger.setLevel(logging.DEBUG)

        ticker_results = []
        
        try:
            for tf in self.context.timeframes:
                try:
                    # 1. Load Data
                    df = self.storage.load_ticker_data(ticker, tf)
                    
                    # 1.5 Inject pre-computed cross-sectional features FIRST so Minervini/etc can use them
                    if precomputed_cs and tf in precomputed_cs and precomputed_cs[tf]:
                        for col, series in precomputed_cs[tf].items():
                            mapped = df['timestamp'].map(series)
                            if series.dtype.name == 'Int64':
                                df[col] = mapped.astype("Int64")
                            else:
                                df[col] = mapped.astype("float64")
                    
                    # 2. Calculate Features
                    df_with_features = self.calculator.calculate_features(df, self.context.features)
                    
                    # Clean up intermediate "_raw" columns before saving
                    raw_cols = [c for c in df_with_features.columns if c.endswith("_raw")]
                    df_with_features.drop(columns=raw_cols, inplace=True, errors='ignore')
                    
                    # 3. Save Data
                    self.storage.save_ticker_features(ticker, tf, df_with_features)
                    
                    pts = len(df_with_features) if df_with_features is not None else 0
                    ticker_results.append(TickerProcessResult(ticker, tf, True, data_points=pts))
                    
                except Exception as e:
                    error_msg = f"Error processing {ticker} [{tf}]: {str(e)}"
                    logger.error(error_msg)
                    ticker_results.append(TickerProcessResult(ticker, tf, False, 0, error_msg))
        finally:
            if handler:
                logging.getLogger().removeHandler(handler)

        return ticker_results
