"""
Nexus REST API — FastAPI router for all dashboard endpoints.

Endpoints:
  GET  /api/messages                    → Global stream (all messages, paginated)
  GET  /api/messages/{from_id}/{to_id}  → Agenten-Vektor (bidirectional)
  GET  /api/status                      → Status-channel (LWT events only)
  GET  /api/history                     → History-Provider: messages since unix_ts
  GET  /api/agents                      → Known agents (derived from nexus_messages)
  POST /api/send                        → Boss sends a message to an agent via MQTT
  GET  /api/stream                      → Server-Sent Events live stream
"""
import asyncio
import json
import logging
import os
import time

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from mqtt_listener import message_queue, get_mqtt_client

logger = logging.getLogger("nexus.api")

router = APIRouter()

GATEWAY_URL   = os.environ.get("GATEWAY_URL", "http://gateway:80")
SERVICE_KEY   = os.environ.get("SERVICE_ROLE_KEY", "")
MQTT_BROKER   = os.environ.get("MQTT_BROKER_HOST", "nexus-broker")
MQTT_PORT     = int(os.environ.get("MQTT_BROKER_PORT", "1883"))

DB_HEADERS = {
    "apikey":        SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

async def _db_get(path: str, params: dict | None = None) -> list[dict]:
    async with httpx.AsyncClient(timeout=8.0) as client:
        r = await client.get(
            f"{GATEWAY_URL}/rest/v1/{path}",
            headers={**DB_HEADERS, "Accept": "application/json"},
            params=params or {},
        )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"DB error: {r.text}")
    return r.json()


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/api/messages")
async def get_all_messages(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """Global stream — all messages ordered by unix_ts descending."""
    return await _db_get(
        "nexus_chat",
        {"order": "unix_ts.desc", "limit": limit, "offset": offset},
    )


@router.get("/api/messages/{from_id}/{to_id}")
async def get_vector(
    from_id: str,
    to_id: str,
    limit: int = Query(100, ge=1, le=500),
):
    """
    Agenten-Vektor — all messages between two agents (bidirectional).
    Implements the Virtual Chatroom filter:
      (from=A AND to=B) OR (from=B AND to=A)
    """
    params = {
        "or":   f"(and(from_agent.eq.{from_id},to_agent.eq.{to_id}),and(from_agent.eq.{to_id},to_agent.eq.{from_id}))",
        "order": "unix_ts.asc",
        "limit": limit,
    }
    return await _db_get("nexus_chat", params)


@router.get("/api/status")
async def get_status():
    """Status-Channel — LWT events only."""
    return await _db_get(
        "nexus_chat",
        {"message_type": "eq.status", "order": "unix_ts.desc", "limit": 200},
    )


@router.get("/api/history")
async def get_history(since: int = Query(0, description="Unix timestamp")):
    """
    History-Provider — returns all messages with unix_ts > since.
    Used by the dashboard on load to rehydrate missed messages.
    """
    return await _db_get(
        "nexus_chat",
        {"unix_ts": f"gt.{since}", "order": "unix_ts.asc", "limit": 500},
    )


@router.get("/api/agents")
async def get_agents():
    """
    Returns a deduplicated list of all known agent IDs seen in nexus_messages.
    The dashboard uses this to populate the checkboxes.
    """
    # Pull distinct from_agent and to_agent values
    rows = await _db_get("nexus_chat", {"select": "from_agent,to_agent", "limit": 1000})
    seen: set[str] = set()
    for row in rows:
        seen.add(row["from_agent"])
        seen.add(row["to_agent"])
    seen.discard("nexus")  # internal nexus system agent
    return sorted(seen)


# ─── Boss sends a message ─────────────────────────────────────────────────────

class SendRequest(BaseModel):
    from_agent: str          # e.g. "boss"
    to: str                  # e.g. "ea"
    text: str
    msg_type: str = "chat"


@router.post("/api/send")
async def send_message(req: SendRequest):
    """
    Boss sends a message to an agent via MQTT.
    Uses the shared persistent MQTT client (non-blocking).
    """
    mqtt_client = get_mqtt_client()
    if mqtt_client is None:
        raise HTTPException(status_code=503, detail="MQTT client not connected")

    now = int(time.time())
    envelope = {
        "header": {
            "from":     req.from_agent,
            "to":       req.to,
            "date":     "",
            "unix":     now,
            "msg_type": req.msg_type,
        },
        "content": {"text": req.text},
    }

    result = mqtt_client.publish(
        topic=f"agents/{req.to}/inbox",
        payload=json.dumps(envelope),
        qos=1,
    )

    if result.rc != 0:
        raise HTTPException(status_code=503, detail=f"MQTT publish failed: rc={result.rc}")

    return {"status": "sent", "unix": now}


# ─── Server-Sent Events ───────────────────────────────────────────────────────

@router.get("/api/stream")
async def sse_stream():
    """
    SSE endpoint — pushes new messages to the dashboard in real-time.
    The dashboard subscribes here to avoid polling.
    """
    async def event_generator():
        while True:
            try:
                msg = await asyncio.wait_for(message_queue.get(), timeout=25.0)
                data = json.dumps(msg, ensure_ascii=False)
                yield f"data: {data}\n\n"
            except asyncio.TimeoutError:
                # Heartbeat to keep the connection alive
                yield ": heartbeat\n\n"
            except asyncio.CancelledError:
                break

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":               "no-cache",
            "X-Accel-Buffering":           "no",
            "Access-Control-Allow-Origin": "*",
        },
    )
