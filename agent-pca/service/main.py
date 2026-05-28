"""
main.py — agent-pca-service
FastAPI entry point. Registers all routers and starts the MQTT listener
as a background task on startup.
"""
import os
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from websocket_manager import manager
from ws_router import router as ws_router
from chart_data import router as chart_router
from state_api import router as state_router
from mqtt_listener import start_mqtt_listener

logger = logging.getLogger("pca.main")
logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start MQTT subscriber on service startup."""
    logger.info("agent-pca-service starting up...")
    # Run MQTT listener in a background thread (paho is synchronous)
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, start_mqtt_listener)
    yield
    logger.info("agent-pca-service shutting down.")


app = FastAPI(
    title="agent-pca-service",
    description="Chart data API, WebSocket server and MQTT listener for the PCA chart system.",
    version="1.0.0",
    lifespan=lifespan,
)

# Allow browser clients from the frontend origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten in production
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Routers ---
app.include_router(ws_router)
app.include_router(chart_router, prefix="/api")
app.include_router(state_router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok", "clients": manager.count()}
