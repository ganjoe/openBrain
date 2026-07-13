"""
annotations.py — Load chart annotations from pca_annotations table.
Used by chart_data.py to enrich chart responses with arrow markers.
"""
import os
import logging
from typing import List, Dict, Any, Optional

import httpx

logger = logging.getLogger("pca.views.annotations")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://gateway:80")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


def _headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


async def load_annotations(ticker: str, source: str) -> List[Dict[str, Any]]:
    """
    Load annotations for a specific ticker and source from the pca_annotations table.
    Returns a list of annotation dicts suitable for the frontend renderer.
    """
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{SUPABASE_URL}/rest/v1/pca_annotations",
                params={
                    "source": f"eq.{source}",
                    "ticker": f"eq.{ticker.upper()}",
                    "select": "timestamp,type,color,label",
                    "order": "timestamp.asc",
                },
                headers=_headers(),
            )
            r.raise_for_status()
            rows = r.json()

        annotations = []
        for row in rows:
            annotations.append({
                "timestamp": row["timestamp"],
                "type": row.get("type", "arrow_up"),
                "color": row.get("color"),
                "label": row.get("label"),
                "source": source,
            })
        return annotations

    except Exception as e:
        logger.warning(f"Failed to load annotations for {ticker}/{source}: {e}")
        return []
