"""
mqtt_listener.py — MQTT subscriber for inter-agent events.
Runs in a background thread (paho is synchronous).
Subscribes to:
  - agents/pca/commands    → direct MCP commands for the chart system
  - agents/pta/events      → PTA trade events (auto-focus chart on new position)
  - agents/stock-data/events → download complete/failed notifications
  - agents/features/events → feature calculation complete notifications
"""
import os
import json
import logging
import asyncio

import paho.mqtt.client as mqtt
import time

logger = logging.getLogger("pca.mqtt")

MQTT_HOST = os.environ.get("MQTT_BROKER_HOST", "nexus-broker")
MQTT_PORT = int(os.environ.get("MQTT_BROKER_PORT", "1883"))
AGENT_ID = "pca"

# We need a reference to the event loop to schedule coroutines from the MQTT thread
_event_loop: asyncio.AbstractEventLoop | None = None
_client: mqtt.Client | None = None

def publish_message(topic: str, payload: dict):
    global _client
    if _client:
        try:
            _client.publish(topic, json.dumps(payload), qos=1)
            logger.debug("Published to %s: %s", topic, payload)
        except Exception as e:
            logger.error("Failed to publish to %s: %s", topic, e)
    else:
        logger.warning("Cannot publish to %s, MQTT client not connected", topic)
def _on_connect(client: mqtt.Client, userdata, flags, rc, properties=None):
    if rc == 0:
        logger.info("MQTT connected to %s:%d", MQTT_HOST, MQTT_PORT)
        client.subscribe(f"agents/{AGENT_ID}/commands")
        client.subscribe("agents/pta/events")
        client.subscribe("agents/stock-data/events")
        client.subscribe("agents/features/events")
        # Publish online status
        online_payload = json.dumps({
            "agent": AGENT_ID,
            "status": "online",
            "unix": int(time.time())
        })
        client.publish("agents/status", online_payload, qos=1, retain=True)
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
    elif topic == "agents/stock-data/events":
        _schedule(_handle_stock_data_event(payload))
    elif topic == "agents/features/events":
        _schedule(_handle_features_event(payload))


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

async def _handle_stock_data_event(payload: dict):
    """React to stock-data-node events (e.g. download complete)."""
    from websocket_manager import manager
    event_type = payload.get("event")
    ticker = payload.get("ticker", "").upper()

    if event_type == "download_complete":
        logger.info("Stock data download complete for %s, notifying frontend", ticker)
        await manager.broadcast({"action": "download_complete", "symbol": ticker})
        # Trigger feature calculation with this ticker as priority
        await _trigger_feature_calculation(ticker)
    elif event_type == "download_failed":
        reason = payload.get("reason", "Unknown error")
        logger.error("Stock data download failed for %s: %s", ticker, reason)
        await manager.broadcast({"action": "download_failed", "symbol": ticker, "reason": reason})


async def _handle_features_event(payload: dict):
    """React to features-service events (e.g. features_complete)."""
    from websocket_manager import manager
    event_type = payload.get("event")
    ticker = payload.get("ticker", "").upper()

    if event_type == "features_complete" and ticker:
        logger.info("Features complete for %s, notifying frontend", ticker)
        await manager.broadcast({"action": "features_complete", "symbol": ticker})


FEATURES_SERVICE_URL = os.environ.get("FEATURES_SERVICE_URL", "http://features-service:8003")

async def _trigger_feature_calculation(ticker: str):
    """Trigger bulk feature calculation with priority ticker via features-service HTTP API."""
    import urllib.request
    import urllib.error
    try:
        url = f"{FEATURES_SERVICE_URL}/features/calculate?priority={ticker}"
        req = urllib.request.Request(url, method="POST")
        loop = asyncio.get_event_loop()
        resp = await loop.run_in_executor(None, lambda: urllib.request.urlopen(req, timeout=10))
        logger.info("Feature calc triggered for priority=%s, status=%d", ticker, resp.getcode())
    except urllib.error.HTTPError as e:
        if e.code == 409:
            logger.info("Feature calc already running (409), priority=%s will be picked up next cycle", ticker)
        else:
            logger.warning("Feature calc trigger failed for %s: HTTP %d", ticker, e.code)
    except Exception as e:
        logger.warning("Feature calc trigger failed for %s: %s", ticker, e)


def start_mqtt_listener():
    """
    Blocking MQTT loop. Call from asyncio executor so it runs in a background thread.
    Captures the current event loop for cross-thread scheduling.
    """
    global _event_loop, _client
    try:
        _event_loop = asyncio.get_event_loop()
    except RuntimeError:
        _event_loop = asyncio.new_event_loop()

    _client = mqtt.Client(
        client_id=f"pca-service-{os.getpid()}",
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
    )
    _client.on_connect = _on_connect
    _client.on_message = _on_message

    # Last Will: mark agent as offline if container crashes
    _client.will_set(
        "agents/status",
        json.dumps({"agent": AGENT_ID, "status": "offline", "unix": 0}),
        retain=True,
    )

    try:
        _client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
        _client.loop_forever()
    except Exception as e:
        logger.error("MQTT listener failed: %s", e)
