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
import glob
from fastapi import APIRouter, HTTPException, Query, BackgroundTasks
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
        {"unix_ts": f"gt.{since}", "order": "unix_ts.desc", "limit": 1000},
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
    seen.discard("nexus")  # internal nexus system agent (Redundant: has its own button)
    seen.discard("all")    # discard broadcast address (Breaks hierarchy)
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


# ─── System Settings ────────────────────────────────────────────────────────────

class ProviderUpdateRequest(BaseModel):
    agent_id: str
    provider: str

@router.get("/api/settings/provider")
async def get_provider():
    """Fetch the current provider config from the DB."""
    rows = await _db_get("system_settings", {"key": "eq.provider_config"})
    if rows:
        return rows[0].get("value", {})
    return {}

@router.post("/api/settings/provider")
async def update_provider(req: ProviderUpdateRequest):
    """Update an agent's provider and broadcast via MQTT."""
    # 1. Fetch current config
    rows = await _db_get("system_settings", {"key": "eq.provider_config"})
    current_config = rows[0].get("value", {}) if rows else {}
    
    # 2. Update config
    current_config[req.agent_id] = req.provider
    
    # 3. Save to DB
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.patch(
            f"{GATEWAY_URL}/rest/v1/system_settings?key=eq.provider_config",
            headers={**DB_HEADERS, "Content-Type": "application/json"},
            json={"value": current_config}
        )
        if r.status_code not in (200, 204):
            # Try POST if not exists
            r2 = await client.post(
                f"{GATEWAY_URL}/rest/v1/system_settings",
                headers={**DB_HEADERS, "Content-Type": "application/json"},
                json={"key": "provider_config", "value": current_config}
            )
            if r2.status_code not in (200, 201, 204):
                raise HTTPException(status_code=502, detail=f"DB error: {r2.text}")
                
    # 4. Broadcast via MQTT
    mqtt_client = get_mqtt_client()
    if mqtt_client:
        payload = json.dumps(current_config)
        mqtt_client.publish("system/config/provider", payload, qos=1, retain=True)
        
    return {"status": "updated", "config": current_config}


# ─── LM Studio Settings ───────────────────────────────────────────────────────

LM_STUDIO_URL = "http://host.docker.internal:1234/v1"

@router.get("/api/lmstudio/status")
async def get_lmstudio_status():
    """Check LM Studio availability and loaded models."""
    
    # Check loaded and available models via LM Studio v0 API
    async with httpx.AsyncClient(timeout=3.0) as client:
        try:
            r = await client.get(f"{LM_STUDIO_URL.replace('/v1', '/api/v0')}/models")
            if r.status_code == 200:
                data = r.json().get("data", [])
                loaded_models = []
                available_models = []
                
                for m in data:
                    model_id = m.get("id")
                    if model_id:
                        available_models.append(model_id)
                        if m.get("state") == "loaded":
                            loaded_models.append(model_id)
                
                state = "online"
                if not loaded_models:
                    state = "empty"
                    
                return {
                    "state": state,
                    "loaded_models": loaded_models,
                    "available_models": available_models
                }
            else:
                return {"state": "offline", "loaded_models": [], "available_models": available_models, "error": f"Status {r.status_code}"}
        except Exception as e:
            logger.error(f"LM Studio status check failed: {e}")
            return {"state": "offline", "loaded_models": [], "available_models": available_models, "error": str(e)}

class LoadModelRequest(BaseModel):
    model_id: str

async def _jit_load_model(model_id: str):
    """Background task to trigger JIT loading by sending a dummy chat completion."""
    logger.info(f"Triggering JIT load for model: {model_id}")
    # LM Studio supports very long timeouts for loading huge models
    async with httpx.AsyncClient(timeout=300.0) as client:
        try:
            payload = {
                "model": model_id,
                "messages": [{"role": "system", "content": "Model Request"}],
                "max_tokens": 1
            }
            # This will force LM Studio to load the model and process the ping
            r = await client.post(f"{LM_STUDIO_URL}/chat/completions", json=payload)
            logger.info(f"JIT load completed for {model_id} with status {r.status_code}")
        except Exception as e:
            logger.error(f"JIT load failed for {model_id}: {e}")

@router.post("/api/lmstudio/load")
async def load_lmstudio_model(req: LoadModelRequest, background_tasks: BackgroundTasks):
    """Load a specific model in LM Studio using the JIT exploit."""
    background_tasks.add_task(_jit_load_model, req.model_id)
    return {"status": "loading_initiated", "model_id": req.model_id}

class UnloadModelRequest(BaseModel):
    model_id: str

@router.post("/api/lmstudio/unload")
async def unload_lmstudio_model(req: UnloadModelRequest):
    """Unload a specific model in LM Studio."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            r = await client.post(
                "http://host.docker.internal:1234/api/v1/models/unload",
                json={"instance_id": req.model_id}
            )
            if r.status_code == 200:
                return {"status": "success"}
            else:
                return {"status": "error", "detail": r.text}
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e))



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
