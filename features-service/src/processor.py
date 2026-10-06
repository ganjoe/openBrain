import logging
import traceback
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor, as_completed
from typing import List, Optional, Dict
import numpy as np
import pandas as pd
import multiprocessing
from dataclasses import dataclass

from config_parser import FeatureConfig, ProcessingContext, FeatureType
from calculator import TechnicalCalculator
from parquet_io import ParquetStorage
from fast_rank import rank_percentile, rank_adr_neutral

logger = logging.getLogger(__name__)

@dataclass
class TickerProcessResult:
    """Result of processing a single ticker."""
    ticker: str
    timeframe: str
    success: bool
    data_points: int = 0
    error_message: Optional[str] = None

# ─── Pass 0a: Modul-Funktionen fuer den ProcessPoolExecutor ──────────────────
# Closures sind nicht picklable; Data-Dir, Configs und Timeframes gehen ueber den
# Initializer einmal pro Worker-Prozess.
_P0_STORAGE = None
_P0_CALCULATOR = None
_P0_CONFIGS = None
_P0_TIMEFRAMES = None


def _init_pass0_worker(data_dir, cs_configs, timeframes):
    global _P0_STORAGE, _P0_CALCULATOR, _P0_CONFIGS, _P0_TIMEFRAMES
    _P0_STORAGE = ParquetStorage(data_dir)
    _P0_CALCULATOR = TechnicalCalculator()
    _P0_CONFIGS = cs_configs
    _P0_TIMEFRAMES = timeframes


def _pass0_read_and_compute_raw(t: str):
    """Inhaltlich identisch zum frueheren Closure in _precompute_cross_sectional."""
    res = {}
    for tf in _P0_TIMEFRAMES:
        try:
            df = _P0_STORAGE.load_ticker_data(t, tf)
            if len(df) == 0: continue
            res[tf] = []
            # Compute raw values dynamically using calculator
            breadth_raw_cache: dict = {}
            for config in _P0_CONFIGS:
                if config.feature_type == FeatureType.IBD_RS:
                    _P0_CALCULATOR._calc_ibd_rs_raw(df, config)
                elif config.feature_type == FeatureType.RS_ADR_NEUTRAL:
                    _P0_CALCULATOR._calc_rs_adr_neutral_raw(df, config)
                    df[config.feature_id + "__adr"] = _P0_CALCULATOR._adr_series(df, config)
                elif config.feature_type in (FeatureType.BREADTH_MINERVINI, FeatureType.BREADTH_SMA):
                    # Der Cache-Schluessel MUSS den Typ UND das SMA-Fenster tragen:
                    # breadth_40_pct und breadth_200_pct teilen den Typ, liefern aber
                    # verschiedene Rohspalten. Ein Cache nur auf den Typ wuerde die
                    # 200er-Reihe still auf die 40er-Werte setzen.
                    cache_key = (config.feature_type,
                                 int(config.additional_params.get("sma_window") or 0))
                    col = f"{config.feature_id}_raw"
                    if cache_key not in breadth_raw_cache:
                        if config.feature_type == FeatureType.BREADTH_MINERVINI:
                            _P0_CALCULATOR._calc_breadth_minervini_raw(df, config)
                        else:
                            _P0_CALCULATOR._calc_breadth_sma_raw(df, config)
                        breadth_raw_cache[cache_key] = col
                    else:
                        df[col] = df[breadth_raw_cache[cache_key]]

                col_name = f"{config.feature_id}_raw"
                if col_name in df.columns:
                    series = df[col_name].copy()
                    if 'timestamp' in df.columns:
                        series.index = (df['timestamp'] // 86400) * 86400
                        series = series[~series.index.duplicated(keep='last')]
                    res[tf].append((col_name, series))
                adr_col = f"{config.feature_id}__adr"
                if adr_col in df.columns:
                    adr_series = df[adr_col].copy()
                    if 'timestamp' in df.columns:
                        adr_series.index = (df['timestamp'] // 86400) * 86400
                        adr_series = adr_series[~adr_series.index.duplicated(keep='last')]
                    res[tf].append((adr_col, adr_series))
        except Exception:
            pass
    return t, res


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
        
        ranked_configs = [c for c in self.context.features
                          if c.feature_type in (FeatureType.IBD_RS, FeatureType.RS_ADR_NEUTRAL)]
        agg_configs = [c for c in self.context.features if str(c.additional_params.get("aggregation", "")).lower() == "all"]
        cs_configs = ranked_configs + agg_configs
        
        if not cs_configs:
            return {}

        ticker_series_by_tf = {tf: {} for tf in self.context.timeframes}
        
        from job_manager import JobManager
        jm = JobManager()
        total_p0 = len(tickers)
        p0_completed = 0
        last_logged_p0_pct = 0

        # Paralleles Lesen + Rohberechnung in PROZESSEN statt Threads.
        # Die Arbeit ist pandas/numpy-lastig und serialisiert sich am GIL:
        # gemessen 16 Threads = 1 Thread, 16 Prozesse = 24,0 s statt 357 s.
        exec_ctx = multiprocessing.get_context('spawn')
        with ProcessPoolExecutor(
            max_workers=self.context.thread_count,
            mp_context=exec_ctx,
            initializer=_init_pass0_worker,
            initargs=(self.context.data_dir, cs_configs, list(self.context.timeframes)),
        ) as executor:
            futures = [executor.submit(_pass0_read_and_compute_raw, t) for t in tickers]
            for f in as_completed(futures):
                t, res = f.result()
                p0_completed += 1
                jm.update_progress(completed=p0_completed, total=total_p0, current_ticker=t)
                
                pct = int((p0_completed / total_p0) * 100)
                if pct - last_logged_p0_pct >= 10 or p0_completed == total_p0:
                    logger.info(f"⚙️  Pass 0 Loading: {pct}% ({p0_completed}/{total_p0} tickers)")
                    last_logged_p0_pct = pct

                for tf, tuples in res.items():
                    for (col_name, series) in tuples:
                        if col_name not in ticker_series_by_tf[tf]:
                            ticker_series_by_tf[tf][col_name] = {}
                        ticker_series_by_tf[tf][col_name][t] = series
                    
        # Now compute percentiles or aggregations globally
        jm.set_stage("PASS_0_RANKING", total_tickers=total_p0)
        logger.info("⚙️  Pass 0: Ranking / Aggregating features globally...")
        result_dict = {tf: {} for tf in self.context.timeframes}
        
        for tf, features in ticker_series_by_tf.items():
            agg_cache = {}
            for feature_raw_col, ticker_series_dict in features.items():
                if feature_raw_col.endswith("__adr"):
                    continue
                target_col = feature_raw_col.replace("_raw", "")
                
                config = next((c for c in cs_configs if f"{c.feature_id}_raw" == feature_raw_col), None)
                is_agg = config and str(config.additional_params.get("aggregation", "")).lower() == "all"
                
                if is_agg:
                    # Alle BREADTH_MINERVINI-Konfigurationen liefern dieselbe
                    # Rohspalte (siehe _pass0_read_and_compute_raw) und unterscheiden
                    # sich nur in der Aggregation. Deshalb EIN DataFrame und EIN
                    # Summenlauf fuer alle ihre Ausgabespalten: der Aufbau kostet
                    # ~14 s pro Spalte, sum(axis=1) ~3 s.
                    share_key = (config.feature_type
                                 if config.feature_type == FeatureType.BREADTH_MINERVINI
                                 else feature_raw_col)
                    # Nur MINERVINI teilt per Typ (alle Varianten liefern dieselbe
                    # Rohspalte). BREADTH_SMA darf das NICHT: je SMA-Fenster eine
                    # eigene Rohspalte, sonst waeren 40 und 200 identisch.
                    entry = agg_cache.get(share_key)
                    if entry is None:
                        cdf = pd.DataFrame(ticker_series_dict)
                        entry = {"df": cdf,
                                 "counts": cdf.sum(axis=1, skipna=True),
                                 "totals": None}
                        agg_cache[share_key] = entry
                    central_df = entry["df"]
                    mode = str(config.additional_params.get("mode", "absolute")).lower()

                    if mode == "pct_abs":
                        if entry["totals"] is None:
                            entry["totals"] = central_df.notna().sum(axis=1)
                        totals_safe = entry["totals"].replace(0, np.nan)
                        global_series = (entry["counts"] / totals_safe) * 100
                        global_series = global_series.round(2).fillna(0).astype("float64")
                    else:
                        global_series = entry["counts"].astype("Int64")

                    # Einmal dropna() statt 41.514 mal
                    gs = global_series.dropna()
                    for t in central_df.columns:
                        if t not in result_dict[tf]:
                            result_dict[tf][t] = {}
                        result_dict[tf][t][target_col] = gs
                else:
                    # Ranking logic (e.g. IBD_RS): nur die gueltigen Eintraege je
                    # Zeile ranken statt pandas rank() ueber die ganze 6-GiB-Matrix.
                    # Gemessen: 11,6x schneller, bit-identisch (verify_fast_rank_real.py).
                    central_df = pd.DataFrame(ticker_series_dict)
                    if config is not None and config.feature_type == FeatureType.RS_ADR_NEUTRAL:
                        adr_df = pd.DataFrame(features.get(config.feature_id + "__adr", {}))
                        rating_df = rank_adr_neutral(
                            central_df, adr_df,
                            n_buckets=int(config.additional_params.get("buckets") or 3),
                            letters_only=True,
                        )
                    else:
                        rating_df = rank_percentile(central_df)

                    # Verteilen: rating_df[t].dropna() legt je Ticker ein IntegerArray
                    # ueber ALLE 19.347 Zeilen an, obwohl im Schnitt nur ~700 gueltig
                    # sind. Stattdessen einmal transponieren (die pandas-Blockablage
                    # liefert das als View) und je Ticker die zusammenhaengende Zeile
                    # lesen. Gemessen 45,1 s -> 26,0 s, bit-identisch.
                    arr_t = np.ascontiguousarray(rating_df.to_numpy(dtype="float64").T)
                    days = central_df.index.to_numpy()
                    for j, t in enumerate(central_df.columns):
                        col = arr_t[j]
                        mask = ~np.isnan(col)
                        if mask.all():
                            vals, idx = col, days
                        else:
                            vals, idx = col[mask], days[mask]
                        if t not in result_dict[tf]:
                            result_dict[tf][t] = {}
                        result_dict[tf][t][target_col] = pd.Series(
                            pd.arrays.IntegerArray(vals.astype("int64"),
                                                   np.zeros(len(vals), dtype=bool)),
                            index=idx)
                    
        return result_dict

    def process_all_tickers(self, tickers: List[str], priority: Optional[str] = None, log_queue: Optional[multiprocessing.Queue] = None) -> List[TickerProcessResult]:
        """Spawns parallel processes to compute features for all tickers.
        If priority is set, that ticker is processed first and an MQTT event is published when done."""
        import time
        start_time = time.perf_counter()
        
        # --- Priority ticker: move to front ---
        if priority and priority in tickers:
            tickers.remove(priority)
            tickers.insert(0, priority)
            logger.info("⚡ Priority ticker %s moved to front of queue", priority)
        
        # --- PASS 0: PRE-COMPUTE CROSS SECTIONAL ---
        from job_manager import JobManager
        jm = JobManager()
        jm.set_stage("PASS_0_PRECOMPUTE", total_tickers=len(tickers))
        
        global_cs_data = self._precompute_cross_sectional(tickers)
        
        results = []
        total_tickers = len(tickers)
        completed = 0
        failed_count = 0
        last_logged_pct = 0
        priority_notified = False
        
        jm.set_stage("PASS_1_PROCESSING", total_tickers=total_tickers)
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
                    if any(not r.success for r in ticker_results):
                        failed_count += 1
                except Exception as exc:
                    failed_count += 1
                    logger.error(f"Ticker {ticker} generated an exception: {exc}")
                    logger.error(traceback.format_exc())
                    results.append(TickerProcessResult(ticker, "all", False, 0, str(exc)))
                
                # Update live progress tracker
                jm.update_progress(completed=completed, total=total_tickers, current_ticker=ticker, failed_count=failed_count)

                # Notify via MQTT when priority ticker is done
                if priority and ticker == priority and not priority_notified:
                    priority_notified = True
                    try:
                        from mqtt_publisher import publish_features_complete
                        publish_features_complete(priority)
                    except Exception as e:
                        logger.warning("MQTT notify for priority ticker failed: %s", e)
                
                pct = int((completed / total_tickers) * 100)
                if pct - last_logged_pct >= 10 or completed == total_tickers:
                    logger.info(f"⚙️  Feature processing: {pct}% ({completed}/{total_tickers} tickers)")
                    last_logged_pct = pct

        elapsed = time.perf_counter() - start_time
        successful_results = [r for r in results if r.success]
        failed_results = [r for r in results if not r.success]
        
        total_pts = sum(r.data_points for r in successful_results)
        num_features = len(self.context.features) if hasattr(self.context, 'features') and self.context.features else 0
        
        jm.record_completion(
            success_count=len(successful_results),
            failed_count=len(failed_results),
            data_points=total_pts,
            duration_seconds=elapsed
        )

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
                            mapped = ((df['timestamp'] // 86400) * 86400).map(series)
                            if series.dtype.name == 'Int64':
                                df[col] = mapped.astype("Int64")
                            else:
                                df[col] = mapped.astype("float64")
                    
                    # 2. Calculate Features
                    # IBD_RS wurde in Pass 0 bereits gerechnet und oben als
                    # precomputed_cs injiziert; der zweite Lauf wird verworfen.
                    feature_configs = [c for c in self.context.features
                                       if c.feature_type not in (FeatureType.IBD_RS, FeatureType.RS_ADR_NEUTRAL)]
                    df_with_features = self.calculator.calculate_features(df, feature_configs)
                    
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
