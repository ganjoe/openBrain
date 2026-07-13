import os
import time
import logging
import httpx
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Optional
from datetime import datetime, timezone
import pandas as pd

from parquet_io import ParquetStorage
from scanners.base import BaseScanner

logger = logging.getLogger("scanners.manager")

MONTH_NAMES_DE = [
    "Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
    "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"
]

def _format_ts(ts: int) -> str:
    """Format a Unix timestamp to a human-readable German date string."""
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return f"{dt.day}. {MONTH_NAMES_DE[dt.month - 1]} {dt.year}"


class ScannerManager:
    def __init__(self, storage: ParquetStorage, postgrest_url: Optional[str] = None, service_key: Optional[str] = None):
        self.storage = storage
        self.postgrest_url = postgrest_url or os.environ.get("POSTGREST_URL", "http://postgrest:3000")
        self.service_key = service_key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        self.headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
        }

    def send_telemetry(self, text: str):
        try:
            payload = {
                "from_agent": "pca", # Routed as telemetry from the 'pca' agent
                "to": "all",
                "text": text,
                "msg_type": "telemetry"
            }
            httpx.post("http://nexus-service:7734/api/send", json=payload, timeout=2.0)
        except Exception as e:
            logger.warning(f"Failed to send telemetry: {e}")

    def scan_single_ticker(self, scanner: BaseScanner, ticker: str) -> List[int]:
        """Scan a single ticker and return list of hit timestamps (empty = no match)."""
        try:
            df = self.storage.load_ticker_data(ticker, "1D")
            if len(df) == 0:
                return []
            return scanner.scan_ticker(ticker, df)
        except Exception:
            return []

    def run_scan(
        self,
        scanner: BaseScanner,
        watchlist_name: str,
        max_workers: int = 16,
        stream_telemetry: bool = True,
        list_all_tickers: bool = False,
        annotation_color: Optional[str] = None,
        annotation_label: Optional[str] = None,
    ) -> Dict[str, Any]:
        
        tickers = self.storage.get_available_tickers()
        # Filter out stats/log folders
        tickers = [t for t in tickers if not t.startswith("$")]

        total_tickers = len(tickers)
        if total_tickers == 0:
            return {"status": "error", "message": "No tickers available to scan"}

        start_msg = f"▶️ Starting scan for '{watchlist_name}' (16 threads) over {total_tickers} tickers..."
        logger.info(start_msg)
        if stream_telemetry:
            self.send_telemetry(start_msg)

        start_time = time.perf_counter()
        # match_details: ticker -> [unix_timestamps]
        match_details: Dict[str, List[int]] = {}
        completed = 0
        last_pct_logged = 0

        # Run multi-threaded scan using ThreadPoolExecutor (GIL released during parquet read/numpy)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_ticker = {
                executor.submit(self.scan_single_ticker, scanner, ticker): ticker
                for ticker in tickers
            }

            for future in as_completed(future_to_ticker):
                ticker = future_to_ticker[future]
                completed += 1
                
                try:
                    hit_timestamps = future.result()
                    if hit_timestamps:
                        match_details[ticker] = sorted(hit_timestamps)
                        if list_all_tickers and stream_telemetry:
                            dates_str = ", ".join(_format_ts(ts) for ts in hit_timestamps[:5])
                            extra = f" (+{len(hit_timestamps)-5} more)" if len(hit_timestamps) > 5 else ""
                            self.send_telemetry(f"🔍 Match: {ticker} — 📅 {dates_str}{extra}")
                except Exception as e:
                    logger.warning(f"Error scanning ticker {ticker}: {e}")

                # Telemetry updates (every 10% progress)
                pct = int((completed / total_tickers) * 100)
                if pct - last_pct_logged >= 10 or completed == total_tickers:
                    progress_msg = f"⚙️ Scan progress: {pct}% ({completed}/{total_tickers} tickers)"
                    logger.info(progress_msg)
                    if stream_telemetry:
                        self.send_telemetry(progress_msg)
                    last_pct_logged = pct

        duration = time.perf_counter() - start_time
        speed = total_tickers / duration if duration > 0 else 0
        matches = sorted(match_details.keys())

        perf_msg = (
            f"⚡ Scan complete: {len(matches)} matches found.\n"
            f"   • Tickers scanned: {total_tickers}\n"
            f"   • Duration       : {duration:.2f} seconds\n"
            f"   • Performance    : {speed:.1f} tickers/sec"
        )
        logger.info(perf_msg)
        if stream_telemetry:
            self.send_telemetry(perf_msg)

            # Human-readable report with event dates
            if matches:
                report_lines = [f"📋 Scan Report: {watchlist_name}", f"   {len(matches)} Treffer aus {total_tickers} Tickern", ""]
                for ticker in matches:
                    dates = match_details[ticker]
                    dates_str = ", ".join(_format_ts(ts) for ts in dates)
                    report_lines.append(f"   {ticker}")
                    report_lines.append(f"      📅 {dates_str}")
                self.send_telemetry("\n".join(report_lines))

        # Write results to PostgREST DB
        db_write_success = False
        db_error_message = None
        try:
            with httpx.Client(headers=self.headers) as client:
                # 1. Clear current watchlist
                client.delete(
                    f"{self.postgrest_url}/pca_watchlists?list_name=eq.{watchlist_name}"
                )

                # 2. Insert new watchlist entries in chunks of 500
                if matches:
                    rows = [
                        {
                            "list_name": watchlist_name,
                            "ticker": ticker,
                            "position": idx
                        }
                        for idx, ticker in enumerate(matches)
                    ]
                    chunk_size = 500
                    for i in range(0, len(rows), chunk_size):
                        chunk = rows[i:i + chunk_size]
                        resp = client.post(
                            f"{self.postgrest_url}/pca_watchlists",
                            json=chunk
                        )
                        resp.raise_for_status()

                # 3. Clear old annotations for this source
                client.delete(
                    f"{self.postgrest_url}/pca_annotations?source=eq.{watchlist_name}"
                )

                # 4. Insert new annotations (ticker + event timestamps)
                if match_details:
                    ann_rows = []
                    for ticker, timestamps in match_details.items():
                        for ts in timestamps:
                            ann_rows.append({
                                "source": watchlist_name,
                                "ticker": ticker,
                                "timestamp": ts,
                                "type": "arrow_up",
                                "color": annotation_color,
                                "label": annotation_label,
                            })
                    # Insert in chunks of 500
                    for i in range(0, len(ann_rows), chunk_size):
                        chunk = ann_rows[i:i + chunk_size]
                        resp = client.post(
                            f"{self.postgrest_url}/pca_annotations",
                            json=chunk
                        )
                        resp.raise_for_status()

            db_write_success = True
            ann_count = sum(len(ts) for ts in match_details.values())
            db_msg = f"💾 Watchlist '{watchlist_name}' updated: {len(matches)} tickers, {ann_count} annotations."
            logger.info(db_msg)
            if stream_telemetry:
                self.send_telemetry(db_msg)

        except Exception as e:
            db_error_message = str(e)
            logger.exception("Failed to write watchlist/annotations to database")
            if stream_telemetry:
                self.send_telemetry(f"❌ Database write failed: {db_error_message}")

        # 5. Prune old scanner watchlists and their annotations
        self.prune_scanner_watchlists()

        return {
            "status": "success",
            "scanner_parameters": scanner.get_parameters(),
            "watchlist_name": watchlist_name,
            "tickers_scanned": total_tickers,
            "match_count": len(matches),
            "matches": matches,
            "match_details": {t: ts for t, ts in match_details.items()},
            "duration_seconds": duration,
            "tickers_per_second": speed,
            "database_written": db_write_success,
            "database_error": db_error_message
        }

    def prune_scanner_watchlists(self):
        try:
            with httpx.Client(headers=self.headers) as client:
                # Fetch lists starting with scanner_
                resp = client.get(
                    f"{self.postgrest_url}/pca_watchlists?list_name=like.scanner_*&select=list_name,added_at"
                )
                resp.raise_for_status()
                rows = resp.json()

                if not rows:
                    return

                # Find the latest added_at for each unique list name
                watchlist_dates = {}
                for row in rows:
                    name = row["list_name"]
                    added_at = row["added_at"]
                    if name not in watchlist_dates or added_at > watchlist_dates[name]:
                        watchlist_dates[name] = added_at

                # Sort by date descending
                sorted_watchlists = sorted(
                    watchlist_dates.items(),
                    key=lambda x: x[1],
                    reverse=True
                )

                max_lists_to_keep = 5
                lists_to_prune = []

                # Keep top 5 lists, mark older ones for pruning
                if len(sorted_watchlists) > max_lists_to_keep:
                    for name, _ in sorted_watchlists[max_lists_to_keep:]:
                        lists_to_prune.append(name)

                # Prune anything older than 3 days
                from datetime import timedelta
                three_days_ago = datetime.now(timezone.utc) - timedelta(days=3)
                
                for name, date_str in sorted_watchlists[:max_lists_to_keep]:
                    try:
                        dt = pd.to_datetime(date_str).to_pydatetime()
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        if dt < three_days_ago:
                            if name not in lists_to_prune:
                                lists_to_prune.append(name)
                    except Exception:
                        pass

                for name in lists_to_prune:
                    logger.info(f"🧹 Pruning old scanner watchlist + annotations: {name}")
                    client.delete(f"{self.postgrest_url}/pca_watchlists?list_name=eq.{name}")
                    client.delete(f"{self.postgrest_url}/pca_annotations?source=eq.{name}")

        except Exception as e:
            logger.warning(f"Failed to prune old scanner watchlists: {e}")
