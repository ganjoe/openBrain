"""
Nexus Service — main entry point.

Starts the MQTT listener on startup, mounts the REST API,
and serves the dashboard static files.
"""
import asyncio
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from api import router
from mqtt_listener import start_mqtt_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("nexus")

app = FastAPI(
    title="The Nexus",
    description="Central hub for the Open Brain multi-agent system.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

# Serve dashboard static files at /ui (frontend container serves / directly)
STATIC_DIR = os.environ.get("STATIC_DIR", "/app/static")
if os.path.isdir(STATIC_DIR):
    app.mount("/ui", StaticFiles(directory=STATIC_DIR, html=True), name="ui")


@app.on_event("startup")
async def startup():
    loop = asyncio.get_event_loop()
    start_mqtt_client(loop)
    logger.info("✅ Nexus Service started — MQTT listener active")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "nexus"}
