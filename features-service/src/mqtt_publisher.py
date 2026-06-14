"""
mqtt_publisher.py — Simple MQTT publisher for the features service.
Publishes events like features_complete after priority ticker calculation.
"""
import json
import logging
import os
import threading

import paho.mqtt.client as mqtt

logger = logging.getLogger("features.mqtt")

MQTT_HOST = os.environ.get("MQTT_BROKER_HOST", "nexus-broker")
MQTT_PORT = int(os.environ.get("MQTT_BROKER_PORT", "1883"))
TOPIC = "agents/features/events"

_client: mqtt.Client | None = None
_lock = threading.Lock()


def _get_client() -> mqtt.Client:
    global _client
    with _lock:
        if _client is None:
            _client = mqtt.Client(
                client_id=f"features-service-{os.getpid()}",
                callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            )
            try:
                _client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
                _client.loop_start()
                logger.info("MQTT connected to %s:%d", MQTT_HOST, MQTT_PORT)
            except Exception as e:
                logger.warning("MQTT connect failed (%s:%d): %s", MQTT_HOST, MQTT_PORT, e)
                _client = None
                raise
        return _client


def publish_features_complete(ticker: str) -> None:
    """Publish that features have been calculated for a specific ticker."""
    try:
        client = _get_client()
        payload = json.dumps({"event": "features_complete", "ticker": ticker})
        client.publish(TOPIC, payload, qos=1)
        logger.info("Published features_complete for %s", ticker)
    except Exception as e:
        logger.warning("Failed to publish features_complete for %s: %s", ticker, e)
