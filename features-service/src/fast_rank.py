#!/usr/bin/env python3
"""
fast_rank.py — Ersatz fuer processor.py:126-145 (Cross-Section-Rating).

Statt pandas ueber die volle 19.347 x 41.512-Matrix (6 GiB, 96 % NaN) zu jagen,
wird jede Zeile nur ueber ihre gueltigen Eintraege gerankt (np.argsort) — gleiche
Semantik, Bruchteil der Arbeit und des Speichers.

Unterschied zur Produktion (bewusste Korrektur):
  processor.py:135-137 setzt fuer Zeilen mit <= 1 bewertbarem Ticker die GANZE
  Zeile auf 50 — auch Zellen, die vorher NaN waren. Diese Variante setzt nur die
  tatsaechlich bewerteten Zellen auf 50 (NaN bleibt NaN).

Aufruf als Selbsttest:
    python fast_rank.py --verify
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def rank_percentile(central_df: pd.DataFrame) -> pd.DataFrame:
    """1:1-Semantik von processor.py:128-139, vektorisiert je Zeile."""
    arr = central_df.to_numpy(dtype="float64")
    n_rows, n_cols = arr.shape
    out = np.full((n_rows, n_cols), np.nan, dtype="float64")
    for i in range(n_rows):
        row = arr[i]
        idx = np.nonzero(~np.isnan(row))[0]
        k = idx.size
        if k == 0:
            continue
        if k == 1:
            out[i, idx[0]] = 50.0
            continue
        vals = row[idx]
        # Durchschnitts-Raenge wie pandas rank() bei Ties
        uniq, inv, counts = np.unique(vals, return_inverse=True, return_counts=True)
        avg_rank = np.cumsum(counts) - (counts - 1) / 2.0
        r = avg_rank[inv]
        out[i, idx] = np.round((r - 1) / (k - 1) * 98 + 1).clip(1, 99)
    return pd.DataFrame(out, index=central_df.index, columns=central_df.columns)


def rank_percentile_production(central_df: pd.DataFrame) -> pd.DataFrame:
    """Original aus processor.py:128-139 (nur zum Vergleich)."""
    n_per_row = central_df.notna().sum(axis=1)
    rank_df = central_df.rank(axis=1, na_option="keep")
    n1 = (n_per_row - 1).clip(lower=1)
    rating = ((rank_df.sub(1)).div(n1, axis=0) * 98 + 1).round().clip(1, 99)
    single = n_per_row <= 1
    if single.any():
        rating.loc[single] = 50
    return rating.astype("Int64")


def _verify():
    import time
    rng = np.random.default_rng(0)
    T, N = 4000, 3000
    a = rng.normal(0, 30, size=(T, N))
    mask = rng.random((T, N)) < 0.94
    a[mask] = np.nan
    df = pd.DataFrame(a)
    t0 = time.perf_counter(); p = rank_percentile_production(df); tp = time.perf_counter() - t0
    t0 = time.perf_counter(); f = rank_percentile(df); tf = time.perf_counter() - t0
    pa = p.to_numpy(dtype="float64", na_value=np.nan)
    fa = f.to_numpy()
    both = ~np.isnan(pa) & ~np.isnan(fa)
    d = np.abs(pa[both] - fa[both])
    print(f"Produktion : {tp:6.2f} s")
    print(f"numpy      : {tf:6.2f} s   ({tp/tf:.1f}x schneller)")
    print(f"gemeinsame Zellen: {both.sum():,}  max|diff|={d.max() if d.size else 0:.0f}  ungleich: {int((d>0).sum())}")
    print(f"nur Produktion gesetzt (Zeilen-Quirk): {int((~np.isnan(pa) & np.isnan(fa)).sum())}")
    print(f"nur numpy gesetzt: {int((np.isnan(pa) & ~np.isnan(fa)).sum())}")
    # Zeilen mit <=1 Wert pruefen
    ones = (np.sum(~np.isnan(a), axis=1) <= 1)
    print(f"Zeilen mit <=1 bewertbarem Ticker: {int(ones.sum())}")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()
    if args.verify:
        _verify()


def rank_adr_neutral(central_df, adr_df, n_buckets=3, letters_only=True):
    """Cross-Section-Perzentil 1..99 innerhalb von ADR-Buckets je Zeile (Datum).

    Gleiche Semantik wie rank_percentile, aber statt global wird pro Datum
    innerhalb von n_buckets ADR-Quantil-Buckets gerankt. Optional werden
    Ticker ohne Buchstaben-Prefix (z.B. 093370) aus dem Ranking ausgeschlossen.
    """
    adr_df = adr_df.reindex(index=central_df.index, columns=central_df.columns)
    cols = list(central_df.columns)
    if letters_only:
        keep = np.array([bool(c) and str(c)[0].isalpha() for c in cols], dtype=bool)
    else:
        keep = np.ones(len(cols), dtype=bool)

    cvals = central_df.to_numpy(dtype="float64")
    avals = adr_df.to_numpy(dtype="float64")
    out = np.full(cvals.shape, np.nan, dtype="float64")
    quantiles = [(j + 1) / n_buckets for j in range(n_buckets - 1)]
    for i in range(cvals.shape[0]):
        row = cvals[i]
        a = avals[i]
        m = (~np.isnan(row)) & (~np.isnan(a)) & keep
        if int(m.sum()) < n_buckets * 2:
            continue
        idx = np.nonzero(m)[0]
        av = a[idx]
        qs = np.quantile(av, quantiles)
        b = np.digitize(av, qs)
        for bb in range(n_buckets):
            sel = idx[b == bb]
            n_sel = int(sel.size)
            if n_sel == 0:
                continue
            if n_sel == 1:
                out[i, sel[0]] = 50.0
                continue
            r = pd.Series(row[sel]).rank(method="average").to_numpy()
            out[i, sel] = np.round((r - 1) / (n_sel - 1) * 98 + 1).clip(1, 99)
    return pd.DataFrame(out, index=central_df.index, columns=central_df.columns)

