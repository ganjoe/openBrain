"""
ws_router.py — WebSocket endpoint.
Handles connections from browser tabs (master and regular chart tabs).
Incoming commands from the mobile remote control are processed here.
"""
import json
import logging
import httpx

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from websocket_manager import manager

logger = logging.getLogger("pca.ws_router")
router = APIRouter()

SUPABASE_URL = __import__("os").environ.get("SUPABASE_URL", "http://gateway:80")
SUPABASE_KEY = __import__("os").environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


@router.websocket("/ws")
async def websocket_endpoint(
    ws: WebSocket,
    master: bool = Query(default=False, description="Set true for the master coordinator tab"),
):
    """
    WebSocket endpoint for browser clients.

    Query params:
        master=true  → Register as master tab (receives layout open/spawn commands)
        master=false → Regular chart tab (receives ticker and data commands)

    Incoming message format (from mobile remote):
        {"command": "next_in_watchlist"}
        {"command": "prev_in_watchlist"}
        {"command": "load_ticker", "symbol": "AAPL"}
    """
    await manager.connect(ws, is_master=master)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("Invalid JSON received: %s", raw)
                continue

            command = msg.get("command")
            logger.info("Received command: %s", command)

            if command == "next_in_watchlist":
                await _handle_watchlist_nav(msg, direction=1)
            elif command == "prev_in_watchlist":
                await _handle_watchlist_nav(msg, direction=-1)
            elif command == "load_ticker":
                symbol = msg.get("symbol", "").upper()
                if symbol:
                    await manager.broadcast({"action": "load_ticker", "symbol": symbol})
            elif command == "request_download":
                symbol = msg.get("ticker", "").upper()
                if symbol:
                    logger.info("Proxying request_download to MQTT for %s", symbol)
                    from mqtt_listener import publish_message
                    publish_message("agents/stock-data/commands", {
                        "action": "request_download",
                        "ticker": symbol
                    })
            else:
                logger.warning("Unknown command: %s", command)

    except WebSocketDisconnect:
        manager.disconnect(ws)


async def _handle_watchlist_nav(msg: dict, direction: int):
    """
    Reads the current watchlist state from Supabase and broadcasts the next/prev ticker.
    State: current ticker is tracked in pca_layouts config or passed by the client.
    Simple approach: client sends current_ticker, server resolves next/prev.
    """
    current_ticker = msg.get("current_ticker", "").upper()
    list_name = msg.get("watchlist", "growth_stocks")

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{SUPABASE_URL}/rest/v1/pca_watchlists",
                params={"list_name": f"eq.{list_name}", "order": "position.asc", "select": "ticker"},
                headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
            )
            resp.raise_for_status()
            rows = resp.json()
    except Exception as e:
        logger.error("Failed to fetch watchlist from Supabase: %s", e)
        return

    tickers = [r["ticker"] for r in rows]
    if not tickers:
        return

    try:
        idx = tickers.index(current_ticker)
    except ValueError:
        idx = 0

    next_idx = (idx + direction) % len(tickers)
    next_ticker = tickers[next_idx]

    await manager.broadcast({"action": "load_ticker", "symbol": next_ticker})
    logger.info("Navigated watchlist '%s': %s → %s", list_name, current_ticker, next_ticker)
