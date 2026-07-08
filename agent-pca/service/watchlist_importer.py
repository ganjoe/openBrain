"""
watchlist_importer.py
Background task for agent-pca-service to import watchlist .txt files,
store them in Supabase, check for missing parquet data, trigger downloads,
and archive the processed files.
"""
import os
import re
import shutil
import asyncio
import logging
from datetime import datetime
from pathlib import Path
import httpx

from mqtt_listener import publish_message

logger = logging.getLogger("pca.watchlist_importer")

WATCHLISTS_DIR = Path("/app/watchlists_import")
OLD_DIR = WATCHLISTS_DIR / "old"
PARQUET_BASE_PATH = os.environ.get("PARQUET_BASE_PATH", "/parquet")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://gateway:80")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

def _headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }

async def process_file(file_path: Path):
    list_name = file_path.stem
    try:
        content = file_path.read_text(encoding="utf-8")
    except Exception as e:
        logger.error(f"Failed to read file {file_path.name}: {e}")
        return

    # Split by whitespace, comma, newline
    raw_tokens = re.split(r"[,\s]+", content.strip())
    tickers = [t.strip().upper() for t in raw_tokens if t.strip()]
    
    # Remove duplicates but preserve order
    unique_tickers = []
    seen = set()
    for t in tickers:
        if t not in seen:
            seen.add(t)
            unique_tickers.append(t)

    if not unique_tickers:
        logger.info(f"Watchlist file {file_path.name} is empty or invalid. Archiving without processing.")
        _archive_file(file_path)
        return

    logger.info(f"Processing watchlist '{list_name}' with {len(unique_tickers)} tickers.")

    async with httpx.AsyncClient() as client:
        # 1. Delete existing entries for this watchlist
        del_res = await client.delete(
            f"{SUPABASE_URL}/rest/v1/pca_watchlists",
            params={"list_name": f"eq.{list_name}"},
            headers=_headers()
        )
        if del_res.status_code >= 400:
            logger.error(f"Failed to delete old entries for watchlist '{list_name}': {del_res.text}")
            return

        # 2. Batch insert new entries
        payload = [
            {"list_name": list_name, "ticker": t, "position": i}
            for i, t in enumerate(unique_tickers)
        ]
        ins_res = await client.post(
            f"{SUPABASE_URL}/rest/v1/pca_watchlists",
            json=payload,
            headers={**_headers(), "Prefer": "return=minimal"}
        )
        if ins_res.status_code >= 400:
            logger.error(f"Failed to insert tickers for watchlist '{list_name}': {ins_res.text}")
            return

    logger.info(f"Successfully saved watchlist '{list_name}' to Supabase.")

    # 3. Check for missing parquet files and request downloads
    missing_count = 0
    for t in unique_tickers:
        parquet_file = Path(PARQUET_BASE_PATH) / t / "1D.parquet"
        if not parquet_file.exists():
            logger.info(f"Ticker '{t}' missing 1D.parquet, requesting download via MQTT.")
            publish_message("agents/stock-data/commands", {
                "action": "request_download",
                "ticker": t
            })
            missing_count += 1

    if missing_count == 0:
        logger.info(f"All {len(unique_tickers)} tickers for '{list_name}' already have downloaded data.")
    else:
        logger.info(f"Requested downloads for {missing_count} missing tickers in '{list_name}'.")

    # 4. Archive file
    _archive_file(file_path)


def _archive_file(file_path: Path):
    OLD_DIR.mkdir(parents=True, exist_ok=True)
    target_path = OLD_DIR / file_path.name
    
    if target_path.exists():
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        target_path = OLD_DIR / f"{file_path.stem}_{timestamp}{file_path.suffix}"
        
    try:
        shutil.move(str(file_path), str(target_path))
        logger.info(f"Archived {file_path.name} to {target_path.name}")
    except Exception as e:
        logger.error(f"Failed to archive file {file_path.name}: {e}")

async def watchlist_importer_loop():
    logger.info("Watchlist importer loop started. Watching %s for .txt files", WATCHLISTS_DIR)
    while True:
        try:
            if WATCHLISTS_DIR.exists():
                txt_files = list(WATCHLISTS_DIR.glob("*.txt"))
                for file_path in txt_files:
                    if file_path.is_file():
                        await process_file(file_path)
        except Exception as e:
            logger.error(f"Error in watchlist importer loop: {e}", exc_info=True)
        
        await asyncio.sleep(10)
