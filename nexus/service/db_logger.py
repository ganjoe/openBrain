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
    Persist a parsed Nexus message into nexus_chat.
    """
    header = parsed.get("header", {})
    content_obj = parsed.get("content", {})
    
    # Extract text content if available (for easy search/read in Supabase)
    text_content = content_obj.get("text") if isinstance(content_obj, dict) else str(content_obj)

    row = {
        "from_agent":   header.get("from", "unknown"),
        "to_agent":     header.get("to", "unknown"),
        "message_type": header.get("msg_type", "chat"),
        "content":      text_content,
        "unix_ts":      header.get("unix", 0),
        "raw_payload":  parsed,
    }

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{GATEWAY_URL}/rest/v1/nexus_chat",
                headers=HEADERS,
                json=row,
            )
            if response.status_code not in (200, 201):
                logger.error(
                    "DB write failed: %s — %s", response.status_code, response.text
                )
    except Exception as exc:
        logger.error("DB write exception: %s", exc)
