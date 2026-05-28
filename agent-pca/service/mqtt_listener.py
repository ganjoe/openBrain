"""
mqtt_listener.py — MQTT subscriber for inter-agent events.
Runs in a background thread (paho is synchronous).
Subscribes to:
  - agents/pca/commands  → direct MCP commands for the chart system
  - agents/pta/events    → PTA trade events (auto-focus chart on new position)
"""
import os
import json
import logging
import asyncio

import paho.mqtt.client as mqtt

logger = logging.getLogger("pca.mqtt")

MQTT_HOST = os.environ.get("MQTT_BROKER_HOST", "nexus-broker")
MQTT_PORT = int(os.environ.get("MQTT_BROKER_PORT", "1883"))
AGENT_ID = "pca"

# We need a reference to the event loop to schedule coroutines from the MQTT thread
_event_loop: asyncio.AbstractEventLoop | None = None


def _on_connect(client: mqtt.Client, userdata, flags, rc, properties=None):
    if rc == 0:
        logger.info("MQTT connected to %s:%d", MQTT_HOST, MQTT_PORT)
        client.subscribe(f"agents/{AGENT_ID}/commands")
        client.subscribe("agents/pta/events")
    else:
        logger.error("MQTT connection failed, rc=%d", rc)


def _on_message(client: mqtt.Client, userdata, msg: mqtt.MQTTMessage):
    topic = msg.topic
    try:
        payload = json.loads(msg.payload.decode())
    except Exception:
        logger.warning("Non-JSON MQTT message on %s: %s", topic, msg.payload)
        return

    logger.info("MQTT [%s]: %s", topic, payload)

    if _event_loop is None:
        return

    # Route based on topic
    if topic == f"agents/{AGENT_ID}/commands":
        _schedule(_handle_pca_command(payload))
    elif topic == "agents/pta/events":
        _schedule(_handle_pta_event(payload))


def _schedule(coro):
    """Thread-safe: schedule an async coroutine onto the main event loop."""
    if _event_loop and not _event_loop.is_closed():
        asyncio.run_coroutine_threadsafe(coro, _event_loop)


async def _handle_pca_command(payload: dict):
    """Handle a direct command sent to the PCA agent via MQTT."""
    from websocket_manager import manager
    action = payload.get("action")
    if action == "load_ticker":
        symbol = payload.get("symbol", "").upper()
        if symbol:
            await manager.broadcast({"action": "load_ticker", "symbol": symbol})
    elif action == "open_layout":
        # For MQTT-triggered layout opens, broadcast to master tab
        layout_name = payload.get("layout", "desktop")
        await manager.broadcast_to_masters({"action": "open_layout", "layout_name": layout_name})


async def _handle_pta_event(payload: dict):
    """
    React to PTA trade events.
    If the PTA submits or fills a BUY order, auto-focus the chart on that ticker.
    """
    from websocket_manager import manager
    event_type = payload.get("event_type", "")
    action = payload.get("action", "")
    ticker = payload.get("ticker", "").upper()

    # Only react to new BUY fills or ORDER_SUBMITTED events
    if event_type in ("ORDER_SUBMITTED", "FILL") and action == "BUY" and ticker:
        logger.info("PTA %s for %s — auto-focusing chart", event_type, ticker)
        await manager.broadcast({"action": "load_ticker", "symbol": ticker, "source": "pta_auto"})


def start_mqtt_listener():
    """
    Blocking MQTT loop. Call from asyncio executor so it runs in a background thread.
    Captures the current event loop for cross-thread scheduling.
    """
    global _event_loop
    try:
        _event_loop = asyncio.get_event_loop()
    except RuntimeError:
        _event_loop = asyncio.new_event_loop()

    client = mqtt.Client(
        client_id=f"pca-service-{os.getpid()}",
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
    )
    client.on_connect = _on_connect
    client.on_message = _on_message

    # Last Will: mark agent as offline if container crashes
    client.will_set(
        "agents/status",
        json.dumps({"agent": AGENT_ID, "status": "offline", "unix": 0}),
        retain=True,
    )

    try:
        client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
        client.loop_forever()
    except Exception as e:
        logger.error("MQTT listener failed: %s", e)
