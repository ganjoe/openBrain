#!/usr/bin/env python3
"""
market_breadth.py — Universe Market Breadth Calculator for openBrain features-service

Calculates the percentage and count of stocks above/below the 50 SMA
across the entire local Parquet universe.
Saves the result as a synthetic stock:
  /parquet/$STATS.MARKET_BREADTH/1D.parquet
  /parquet/$STATS.MARKET_BREADTH/1D_features.parquet

Columns:
  timestamp: int64 (seconds)
  open, high, low, close: float64 (percentage of stocks above 50 SMA)
  volume: float64 (count of stocks above 50 SMA)
  count: int64 (count of stocks above 50 SMA)
  total: int64 (total active universe stocks on that date)
  percentage: float64 (pct above 50 SMA)
  days_back: int64 (signed lookback: positive = N-day high, negative = N-day low)
"""

import os
import sys
import time
import logging
import multiprocessing
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
import pandas as pd
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

logger = logging.getLogger("market_breadth")


def compute_days_back_signed(values: np.ndarray) -> np.ndarray:
    """
    Computes signed days_back for a 1D array of values.
    Negative = N-day Low (e.g. -34 for 34-day low)
    Positive = N-day High (e.g. +34 for 34-day high)
    """
    n = len(values)
    days_back = np.zeros(n, dtype=np.int64)

    for i in range(n):
        val = values[i]
        if np.isnan(val):
            days_back[i] = 0
            continue

        low_count = 0
        for k in range(i - 1, -1, -1):
            if np.isnan(values[k]):
                continue
            if values[k] > val:
                low_count += 1
            else:
                break

        high_count = 0
        for k in range(i - 1, -1, -1):
            if np.isnan(values[k]):
                continue
            if values[k] < val:
                high_count += 1
            else:
                break

        if low_count > high_count:
            days_back[i] = -low_count
        elif high_count > low_count:
            days_back[i] = high_count
        else:
            # Tie breaker: compare to previous day
            if i > 0 and values[i] < values[i - 1]:
                days_back[i] = -max(low_count, 1)
            else:
                days_back[i] = max(high_count, 1)

    return days_back


def _flags_for_window(tbl, close: np.ndarray, daily_ts: np.ndarray, window: int):
    """(timestamps, above_flags) je Handelstag fuer ein SMA-Fenster.

    Erst auf einen Wert je UTC-Tag reduzieren, dann die SMA rechnen. Die
    Chartdateien tragen bei ~1.200 Tickern zwei Zeilen fuer denselben Tag
    (settled + Live-Bar); ohne Dedup wandert die Live-Zeile in die SMA.
    """
    df = pd.DataFrame({"close": close}, index=daily_ts)
    ma_col = f"ma_sma_{window}"
    if ma_col in tbl.column_names:
        df["ma"] = tbl[ma_col].to_numpy(zero_copy_only=False).astype(float)
    df = df[~df.index.duplicated(keep="last")]
    if "ma" not in df.columns:
        df["ma"] = df["close"].rolling(window=window).mean()
    valid = (df["close"].notna() & df["ma"].notna()).to_numpy()
    if not valid.any():
        return None
    above = (df["close"].to_numpy() > df["ma"].to_numpy())
    idx = df.index.to_numpy(dtype=np.int64)[valid]
    return idx, above[valid]


def process_ticker_file(file_path: Path, ma_col: str = "ma_sma_50", extra_windows=(40, 200)):
    """Reads timestamp, close and ma_col from a 1D_features.parquet file using PyArrow directly.

    Rueckgabe: (timestamps, above_flags, extra) mit extra = {window: (ts, flags) | None}.
    ACHTUNG: Diese Funktion war zwischenzeitlich durch einen fehlerhaften Patch
    verschwunden (NameError: name 'process_ticker_file' is not defined im Batch) -
    sie ist Pflicht und steht VOR generate_market_breadth.
    """
    try:
        tbl = pq.read_table(str(file_path), columns=["timestamp", "close", ma_col])
        if tbl.num_rows == 0:
            return None

        ts = tbl["timestamp"].to_numpy()
        close = tbl["close"].to_numpy(zero_copy_only=False).astype(float)
        ma = tbl[ma_col].to_numpy(zero_copy_only=False).astype(float)

        if len(ts) > 0 and ts[0] > 10000000000:
            ts = ts // 1000
        daily_ts = (ts // 86400) * 86400

        valid = (~np.isnan(close)) & (~np.isnan(ma))
        if not np.any(valid):
            return None

        above = (close[valid] > ma[valid])

        # Real session observations only: one row per trading day. No calendar
        # reindex and no forward-fill: market breadth is a normal daily series
        # like any other ticker, and non-trading days carry no observation.
        valid_ts = daily_ts[valid]
        s = pd.Series(above, index=valid_ts)
        s = s[~s.index.duplicated(keep='last')]

        if s.empty:
            return None

        extra = {}
        for w in extra_windows or ():
            extra[int(w)] = _flags_for_window(tbl, close, daily_ts, int(w))
        return s.index.to_numpy(dtype=np.int64), s.to_numpy(dtype=bool), extra
    except Exception:
        return None


def generate_market_breadth(
    parquet_dir: str,
    symbol: str = "$STATS.MARKET_BREADTH",
    ma_col: str = "ma_sma_50",
    max_workers: int = 24
) -> Path:
    base_path = Path(parquet_dir)
    # Support both /parquet and /app/data or /data/parquet
    if not (base_path / "AAPL").exists():
        if (base_path / "parquet").exists():
            base_path = base_path / "parquet"

    logger.info("Starting market breadth calculation from %s", base_path)
    t0 = time.time()

    # Find all ticker directories, excluding those starting with '$'
    ticker_dirs = [
        d for d in base_path.iterdir()
        if d.is_dir() and not d.name.startswith("$")
    ]
    logger.info("Found %d ticker directories to inspect", len(ticker_dirs))

    feature_files = []
    for d in ticker_dirs:
        f = d / "1D_features.parquet"
        if f.exists():
            feature_files.append(f)

    logger.info("Found %d 1D_features.parquet files to process", len(feature_files))

    # Daily aggregators: timestamp -> [count_above, count_total]
    counts_above: dict[int, int] = {}
    counts_total: dict[int, int] = {}

    completed = 0
    day_chunks = []
    above_chunks = []
    extra_chunks: dict = {}
    # PROZESSE statt Threads: process_ticker_file ist pandas-lastig und serialisiert
    # sich am GIL. Gemessen mit 24 Threads 26,5 s, mit 16 Prozessen 3,6 s.
    mp_ctx = multiprocessing.get_context("spawn")
    with ProcessPoolExecutor(max_workers=max_workers, mp_context=mp_ctx) as executor:
        futures = [executor.submit(process_ticker_file, f, ma_col) for f in feature_files]
        for fut in as_completed(futures):
            res = fut.result()
            completed += 1
            if completed % 1000 == 0 or completed == len(feature_files):
                logger.info("Progress: %d / %d files scanned", completed, len(feature_files))

            if res is None:
                continue

            timestamps, above_flags, extra = res
            day_chunks.append(timestamps)
            above_chunks.append(above_flags)
            for w, item in (extra or {}).items():
                if item is None:
                    continue
                bucket = extra_chunks.setdefault(int(w), ([], []))
                bucket[0].append(item[0])
                bucket[1].append(item[1])

    # Aggregation vektorisiert statt Python-Schleife ueber 48,7 Mio Paare
    # (gemessen 7,4 s). Die Tage sind Sekundenstempel mit kleiner Spanne
    # (~23.600 Tage von 1962 bis heute), also genuegt ein bincount ohne Sortieren.
    # Achtung: fuenf Titel (CVX, XRX, CAT, IBM, HPQ) reichen bis 1962 zurueck,
    # ihre Tagesindizes sind also NEGATIV -> Index um shift verschieben.
    if day_chunks:
        all_days = np.concatenate(day_chunks)
        all_above = np.concatenate(above_chunks)
        day_idx = (all_days // 86400).astype(np.int64)
        if int(day_idx.max()) - int(day_idx.min()) < 500000:
            shift = int(day_idx.min())
            idx = day_idx - shift
            n_days = int(idx.max()) + 1
            totals_arr = np.bincount(idx, minlength=n_days)
            aboves_arr = np.bincount(idx[all_above], minlength=n_days)
            present = np.nonzero(totals_arr)[0]
            day_keys = present + shift
            tot_vals = totals_arr[present]
            abo_vals = aboves_arr[present]
        else:
            # Ausreisser-Schutz: unerwartet weite Spanne -> exakter, aber langsamer Weg
            day_keys, inv = np.unique(day_idx, return_inverse=True)
            tot_vals = np.bincount(inv)
            abo_vals = np.bincount(inv[all_above])
        counts_total = {int(k) * 86400: int(v) for k, v in zip(day_keys, tot_vals)}
        counts_above = {int(k) * 86400: int(v) for k, v in zip(day_keys, abo_vals)}
    del day_chunks, above_chunks

    # Zusatzfenster (40/200): gleiche Aggregation, eigener Zaehler und Nenner -
    # ein Titel ohne volle SMA fehlt in beiden, nicht nur im Zaehler.
    extra_counts: dict = {}
    for w, (ts_list, above_list) in extra_chunks.items():
        if not ts_list:
            continue
        days = np.concatenate(ts_list)
        flags = np.concatenate(above_list)
        di = (days // 86400).astype(np.int64)
        shift = int(di.min())
        idx = di - shift
        tot_arr = np.bincount(idx, minlength=int(idx.max()) + 1)
        abo_arr = np.bincount(idx[flags], minlength=int(idx.max()) + 1)
        present = np.nonzero(tot_arr)[0]
        extra_counts[w] = {
            int(k + shift) * 86400: (int(abo_arr[k]), int(tot_arr[k])) for k in present
        }
    logger.info(
        "Extra-Breadth-Fenster berechnet: %s",
        {w: len(v) for w, v in extra_counts.items()},
    )

    if not counts_total:
        logger.warning("No valid data found to compute market breadth")
        return None

    all_ts = sorted(counts_total.keys())
    logger.info("Aggregated %d distinct trading days", len(all_ts))

    min_stocks = int(os.environ.get("BREADTH_MIN_STOCKS", "100"))
    rows = []
    for t in all_ts:
        tot = counts_total[t]
        if tot < min_stocks:
            continue
        ab = counts_above.get(t, 0)
        pct = round((ab / tot) * 100.0, 2) if tot > 0 else 0.0
        row = {
            "timestamp": int(t),
            "close": pct,
            "open": pct,
            "high": pct,
            "low": pct,
            "volume": float(ab),
            "count": int(ab),
            "total": int(tot),
            "percentage": pct,
        }
        for w, per_day in extra_counts.items():
            hit = per_day.get(int(t))
            if hit is None:
                continue
            ab_w, tot_w = hit
            if tot_w < min_stocks:
                continue
            row[f"breadth_{w}_pct"] = round((ab_w / tot_w) * 100.0, 2)
            row[f"count_{w}"] = int(ab_w)
        rows.append(row)

    if not rows:
        logger.warning("No rows met min_stocks threshold (%d)", min_stocks)
        return None

    df = pd.DataFrame(rows)
    df = df.sort_values("timestamp").reset_index(drop=True)

    # Market breadth is a trading-session series: drop weekend timestamps
    # that arise from international/OTC tickers whose local session date
    # maps to a UTC Sunday (e.g. local midnight in UTC+1..+14).
    _wd = pd.to_datetime(df["timestamp"], unit="s", utc=True).dt.weekday
    df = df[_wd < 5].reset_index(drop=True)

    # Compute signed days_back
    logger.info("Computing signed days_back extremes...")
    df["days_back"] = compute_days_back_signed(df["percentage"].to_numpy())

    # Write output to synthetic ticker folder
    target_dir = base_path / symbol
    target_dir.mkdir(parents=True, exist_ok=True)

    out_1d = target_dir / "1D.parquet"
    out_feat = target_dir / "1D_features.parquet"

    table = pa.Table.from_pandas(df, preserve_index=False)
    pq.write_table(table, str(out_1d))
    pq.write_table(table, str(out_feat))

    elapsed = time.time() - t0
    logger.info(
        "Successfully wrote %s (1D.parquet and 1D_features.parquet) with %d rows in %.2fs",
        symbol, len(df), elapsed
    )
    return out_1d
