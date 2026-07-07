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

from mqtt_listener import sse_clients, get_mqtt_client

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
    Returns the definitive list of active agents derived from the system provider config.
    This replaces the old logic that dynamically inferred agents from chat history and MQTT,
    ensuring a single source of truth.
    """
    rows = await _db_get("system_settings", {"key": "eq.provider_config"})
    seen = {"boss"}  # Always include the human
    if rows:
        config = rows[0].get("value", {})
        seen.update(config.keys())

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


class ContextLimitRequest(BaseModel):
    enabled: bool
    limit: int

@router.get("/api/settings/context_limit")
async def get_context_limit():
    """Fetch the current context limit config from the DB."""
    rows = await _db_get("system_settings", {"key": "eq.chat_context_limit"})
    if rows:
        return rows[0].get("value", {"enabled": True, "limit": 10})
    return {"enabled": True, "limit": 10}


@router.post("/api/settings/context_limit")
async def update_context_limit(req: ContextLimitRequest):
    """Update context limit config and broadcast via MQTT."""
    config_val = {"enabled": req.enabled, "limit": req.limit}
    
    # Save to DB
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.patch(
            f"{GATEWAY_URL}/rest/v1/system_settings?key=eq.chat_context_limit",
            headers={**DB_HEADERS, "Content-Type": "application/json"},
            json={"value": config_val}
        )
        if r.status_code not in (200, 204):
            # Try POST if it doesn't exist
            r2 = await client.post(
                f"{GATEWAY_URL}/rest/v1/system_settings",
                headers={**DB_HEADERS, "Content-Type": "application/json"},
                json={"key": "chat_context_limit", "value": config_val}
            )
            if r2.status_code not in (200, 201, 204):
                raise HTTPException(status_code=502, detail=f"DB error: {r2.text}")
                
    # Broadcast via MQTT
    mqtt_client = get_mqtt_client()
    if mqtt_client:
        payload = json.dumps(config_val)
        mqtt_client.publish("system/config/context_limit", payload, qos=1, retain=True)
        
    return {"status": "updated", "config": config_val}

# ── Dynamic gateway config — loaded from DB ──────────────────────────────────

async def get_gateway_config() -> dict:
    """Load ib_gateway_config from system_settings. Falls back to live defaults."""
    try:
        rows = await _db_get("system_settings", {"key": "eq.ib_gateway_config"})
        if rows:
            return rows[0].get("value", {})
    except Exception as e:
        logger.warning(f"Could not load gateway config: {e}")
    return {
        "active_mode": "live",
        "live": {"container_name": "ib-gateway_live-ib-gateway-1", "port": 4002, "host": "10.20.0.23"},
        "paper": {"container_name": "ib-gateway_paper", "port": 4001, "host": "10.20.0.23"},
    }

async def get_active_container_name() -> str:
    cfg = await get_gateway_config()
    mode = cfg.get("active_mode", "live")
    return cfg.get(mode, {}).get("container_name", "ib-gateway_live-ib-gateway-1")

async def get_docker_container_running(container_name: str) -> bool:
    try:
        async with httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds="/var/run/docker.sock")) as client:
            r = await client.get(f"http://localhost/containers/{container_name}/json")
            if r.status_code == 200:
                data = r.json()
                return data.get("State", {}).get("Running", False)
    except Exception as e:
        logger.warning(f"Docker API error: {e}")
    return False

async def docker_container_action(container_name: str, action: str):
    """Start or stop a docker container via the Docker Unix socket."""
    async with httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds="/var/run/docker.sock")) as client:
        r = await client.post(f"http://localhost/containers/{container_name}/{action}")
        if r.status_code not in (204, 304):
            raise HTTPException(status_code=500, detail=f"Docker {action} failed for {container_name}: {r.text}")

@router.get("/api/settings/ib_gateway_status")
async def get_ib_gateway_status():
    """Return Docker + login status for BOTH gateway containers, plus active mode."""
    cfg = await get_gateway_config()
    active_mode = cfg.get("active_mode", "live")

    live_container  = cfg.get("live", {}).get("container_name", "ib-gateway_live-ib-gateway-1")
    paper_container = cfg.get("paper", {}).get("container_name", "ib-gateway_paper")

    # Query Docker status for both containers in parallel
    live_running, paper_running = await asyncio.gather(
        get_docker_container_running(live_container),
        get_docker_container_running(paper_container),
    )

    # ibkr_sync only connects to the active container — connected flag only meaningful for active mode
    rows = await _db_get("system_settings", {"key": "eq.ib_gateway_status"})
    active_connected = False
    if rows:
        active_connected = rows[0].get("value", {}).get("connected", False)

    return {
        "active_mode": active_mode,
        "live": {
            "docker_running": live_running,
            "connected": active_connected if active_mode == "live" else False,
        },
        "paper": {
            "docker_running": paper_running,
            "connected": active_connected if active_mode == "paper" else False,
        },
    }

@router.post("/api/settings/ib_gateway/start")
async def start_ib_gateway():
    container_name = await get_active_container_name()
    await docker_container_action(container_name, "start")
    return {"status": "started", "container": container_name}

@router.post("/api/settings/ib_gateway/stop")
async def stop_ib_gateway():
    container_name = await get_active_container_name()
    await docker_container_action(container_name, "stop")
    async with httpx.AsyncClient(timeout=5.0) as client:
        await client.post(
            f"{GATEWAY_URL}/rest/v1/system_settings",
            headers={**DB_HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"},
            json={"key": "ib_gateway_status", "value": {"connected": False}}
        )
    return {"status": "stopped", "container": container_name}

class StopContainerRequest(BaseModel):
    mode: str  # 'live' or 'paper'

@router.post("/api/settings/ib_gateway/stop_container")
async def stop_specific_container(body: StopContainerRequest):
    """Stop the gateway container for a specific mode (used by green-button click)."""
    if body.mode not in ("live", "paper"):
        raise HTTPException(status_code=400, detail="mode must be 'live' or 'paper'")
    cfg = await get_gateway_config()
    container_name = cfg.get(body.mode, {}).get("container_name")
    if not container_name:
        raise HTTPException(status_code=404, detail=f"No container configured for mode '{body.mode}'")
    await docker_container_action(container_name, "stop")
    # Mark as disconnected in DB
    async with httpx.AsyncClient(timeout=5.0) as client:
        await client.post(
            f"{GATEWAY_URL}/rest/v1/system_settings",
            headers={**DB_HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"},
            json={"key": "ib_gateway_status", "value": {"connected": False}}
        )
    # Telemetry
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            await client.post("http://localhost:7734/api/send", json={
                "from_agent": "system", "to": "all",
                "text": f"🔴 IBKR-{body.mode.upper()} Container gestoppt",
                "msg_type": "telemetry"
            })
    except Exception:
        pass
    return {"status": "stopped", "container": container_name, "mode": body.mode}

# ── Trading Mode Switch ───────────────────────────────────────────────────────

class TradingModeRequest(BaseModel):
    mode: str  # 'live' or 'paper'

@router.get("/api/settings/ib_gateway_mode")
async def get_ib_gateway_mode():
    """Get the currently active trading mode."""
    cfg = await get_gateway_config()
    return {"active_mode": cfg.get("active_mode", "live")}

@router.post("/api/settings/ib_gateway_mode")
async def set_ib_gateway_mode(body: TradingModeRequest):
    """Switch between 'live' and 'paper' trading mode.

    This will:
    1. Stop the current active gateway container
    2. Start the target gateway container
    3. Update active_mode in system_settings
    4. Broadcast the new mode via MQTT so agents hot-reload their connection
    """
    new_mode = body.mode
    if new_mode not in ("live", "paper"):
        raise HTTPException(status_code=400, detail="mode must be 'live' or 'paper'")

    cfg = await get_gateway_config()
    current_mode = cfg.get("active_mode", "live")

    if current_mode == new_mode:
        return {"status": "no_change", "active_mode": new_mode}

    old_container = cfg.get(current_mode, {}).get("container_name")
    new_container = cfg.get(new_mode, {}).get("container_name")
    new_host = cfg.get(new_mode, {}).get("host", "10.20.0.23")
    new_port = cfg.get(new_mode, {}).get("port", 4002)

    logger.info(f"Switching trading mode: {current_mode} → {new_mode}")

    # 1. Stop old gateway, start new gateway
    if old_container:
        try:
            await docker_container_action(old_container, "stop")
            logger.info(f"Stopped container: {old_container}")
        except Exception as e:
            logger.warning(f"Could not stop old gateway ({old_container}): {e}")

    if new_container:
        try:
            await docker_container_action(new_container, "start")
            logger.info(f"Started container: {new_container}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to start {new_container}: {e}")

    # 2. Update active_mode in DB
    cfg["active_mode"] = new_mode
    async with httpx.AsyncClient(timeout=5.0) as client:
        await client.patch(
            f"{GATEWAY_URL}/rest/v1/system_settings",
            params={"key": "eq.ib_gateway_config"},
            headers={**DB_HEADERS, "Content-Type": "application/json"},
            json={"value": cfg}
        )

    # 3. Mark gateway as disconnected (will reconnect shortly)
    async with httpx.AsyncClient(timeout=5.0) as client:
        await client.post(
            f"{GATEWAY_URL}/rest/v1/system_settings",
            headers={**DB_HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"},
            json={"key": "ib_gateway_status", "value": {"connected": False}}
        )

    # 4. Broadcast via MQTT so agents hot-reload their gateway connection
    mqtt_client = get_mqtt_client()
    if mqtt_client:
        payload = json.dumps({"mode": new_mode, "host": new_host, "port": new_port})
        mqtt_client.publish("system/config/trading_mode", payload, qos=1, retain=True)
        logger.info(f"Published trading_mode change to MQTT: {payload}")

    # 5. Telemetry message
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            await client.post("http://localhost:7734/api/send", json={
                "from_agent": "system", "to": "all",
                "text": f"🔄 Trading Mode gewechselt: {current_mode.upper()} → {new_mode.upper()}",
                "msg_type": "telemetry"
            })
    except Exception:
        pass

    return {"status": "switched", "active_mode": new_mode, "container": new_container}

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
    q = asyncio.Queue(maxsize=100)
    sse_clients.add(q)
    
    async def event_generator():
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25.0)
                    data = json.dumps(msg, ensure_ascii=False)
                    yield f"data: {data}\n\n"
                except asyncio.TimeoutError:
                    # Heartbeat to keep the connection alive
                    yield ": heartbeat\n\n"
                except asyncio.CancelledError:
                    break
        finally:
            sse_clients.discard(q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":               "no-cache",
            "X-Accel-Buffering":           "no",
            "Access-Control-Allow-Origin": "*",
        },
    )
