"""
Nexus DB Logger — writes parsed Nexus messages into the nexus_messages table
via the existing PostgREST Gateway (port 8001).

Uses the same httpx + service_role pattern as the MCP-Server.
"""
import os
import json
import logging
import httpx

logger = logging.getLogger("nexus.db")

GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://gateway:80")
SERVICE_ROLE_KEY = os.environ.get("SERVICE_ROLE_KEY", "")

HEADERS = {
    "apikey": SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}


async def log_message(parsed: dict) -> None:
    """
    Persist a parsed Nexus message into nexus_messages.
    `parsed` must contain the already-validated message dict.
    """
    header = parsed.get("header", {})

    row = {
        "from_agent": header.get("from", "unknown"),
        "to_agent":   header.get("to", "unknown"),
        "msg_type":   header.get("msg_type", "chat"),
        "unix_ts":    header.get("unix", 0),
        "date_str":   header.get("date", None),
        "full_json":  parsed,
    }

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{GATEWAY_URL}/rest/v1/nexus_messages",
                headers=HEADERS,
                json=row,
            )
            if response.status_code not in (200, 201):
                logger.error(
                    "DB write failed: %s — %s", response.status_code, response.text
                )
    except Exception as exc:
        logger.error("DB write exception: %s", exc)
