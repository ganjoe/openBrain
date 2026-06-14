"""
Nexus MQTT Listener — subscribes to all agent topics and routes to DB logger.

Topics subscribed:
  agents/+/inbox          → all inter-agent chat messages
  agents/status           → LWT events (agent online/offline)
  agents/+/mcp/request    → cross-agent MCP tool calls (logged for transparency)
  agents/+/mcp/response/+ → cross-agent MCP responses
"""
import asyncio
import json
import logging
import os
import time

import paho.mqtt.client as mqtt

from db_logger import log_message

logger = logging.getLogger("nexus.mqtt")

BROKER_HOST = os.environ.get("MQTT_BROKER_HOST", "nexus-broker")
BROKER_PORT = int(os.environ.get("MQTT_BROKER_PORT", "1883"))

# Live message queues for SSE endpoints (Pub-Sub Broadcast)
sse_clients: set[asyncio.Queue] = set()

# Shared MQTT client — set on connect, used by api.py for non-blocking publish
_mqtt_client: mqtt.Client | None = None

_seen_agents: set[str] = set()


def get_mqtt_client() -> mqtt.Client | None:
    return _mqtt_client


def get_seen_agents() -> set[str]:
    return _seen_agents

SUBSCRIPTIONS = [
    ("agents/+/inbox",           1),
    ("agents/status",            1),
    ("agents/+/mcp/request",     1),
    ("agents/+/mcp/response/+",  1),
]


def _derive_msg_type(topic: str) -> str:
    """Infer msg_type from topic when not present in the payload header."""
    if "mcp/request" in topic:
        return "mcp_request"
    if "mcp/response" in topic:
        return "mcp_response"
    if topic == "agents/status":
        return "status"
    return "chat"


def _build_status_envelope(raw: dict, topic: str) -> dict:
    """Wrap a bare LWT / status payload into a Nexus-compatible envelope."""
    agent_id = raw.get("agent", "unknown")
    return {
        "header": {
            "from": agent_id,
            "to":   "nexus",
            "date": "",
            "unix": raw.get("unix", int(time.time())),
            "msg_type": "status",
        },
        "content": {"text": f"Agent '{agent_id}' is {raw.get('status', 'unknown')}"},
        "raw_status": raw,
    }


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        logger.info("Connected to MQTT broker at %s:%s", BROKER_HOST, BROKER_PORT)
        client.subscribe(SUBSCRIPTIONS)
    else:
        logger.error("MQTT connect failed: reason_code=%s", reason_code)


def on_message(client, userdata, msg):
    loop: asyncio.AbstractEventLoop = userdata["loop"]

    try:
        raw = json.loads(msg.payload.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        logger.warning("Non-JSON message on %s: %s", msg.topic, exc)
        return

    # Normalise bare status payloads (LWT has no 'header' key)
    if "header" not in raw:
        raw = _build_status_envelope(raw, msg.topic)

    # Ensure msg_type is always set
    if not raw.get("header", {}).get("msg_type"):
        raw.setdefault("header", {})["msg_type"] = _derive_msg_type(msg.topic)

    # Track seen agents in memory
    from_id = raw.get("header", {}).get("from")
    if from_id and from_id not in ("unknown", "?", "nexus", "all"):
        _seen_agents.add(from_id)
    to_id = raw.get("header", {}).get("to")
    if to_id and to_id not in ("unknown", "?", "nexus", "all"):
        _seen_agents.add(to_id)

    # Push to all active SSE client queues (broadcast)
    dead_clients = set()
    for q in list(sse_clients):
        try:
            q.put_nowait(raw)
        except asyncio.QueueFull:
            try:
                q.get_nowait()
                q.put_nowait(raw)
            except Exception:
                dead_clients.add(q)
                
    for q in dead_clients:
        sse_clients.discard(q)

    # Persist to DB asynchronously (filter out automated/status messages)
    msg_type = raw.get("header", {}).get("msg_type", "chat")
    from_id  = raw.get("header", {}).get("from", "?")
    
    # We log only chat messages (human/agent) to the DB. Telemetry is UI-only.
    should_log = (msg_type in ["chat"])
    
    if should_log:
        asyncio.run_coroutine_threadsafe(log_message(raw), loop)
    else:
        logger.debug("Skipping DB log for msg_type=%s from=%s", msg_type, from_id)


def start_mqtt_client(loop: asyncio.AbstractEventLoop) -> mqtt.Client:
    global _mqtt_client

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="nexus-service",
        userdata={"loop": loop},
    )
    client.on_connect = on_connect
    client.on_message = on_message

    client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
    client.loop_start()

    _mqtt_client = client
    logger.info("MQTT client started, connecting to %s:%s", BROKER_HOST, BROKER_PORT)
    return client
