"""
state_api.py — REST endpoints for state management.
Reads/writes pca_watchlists and pca_layouts via Supabase PostgREST.
Also handles the /command endpoint used by the MCP server to push
layout-open commands to connected browser tabs.
"""
import os
import logging

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from websocket_manager import manager

logger = logging.getLogger("pca.state_api")
router = APIRouter()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://gateway:80")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

_HEADERS = lambda: {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}


# ─── Watchlists ───────────────────────────────────────────────

@router.get("/watchlists")
async def get_watchlists():
    """Return all available watchlist names."""
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{SUPABASE_URL}/rest/v1/pca_watchlists",
            params={"select": "list_name", "order": "list_name.asc"},
            headers=_HEADERS(),
        )
        r.raise_for_status()
    names = sorted(set(row["list_name"] for row in r.json()))
    return {"watchlists": names}


@router.get("/watchlists/{list_name}")
async def get_watchlist(list_name: str):
    """Return all tickers in a named watchlist, ordered by position."""
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{SUPABASE_URL}/rest/v1/pca_watchlists",
            params={
                "list_name": f"eq.{list_name}",
                "order": "position.asc",
                "select": "ticker,position,added_at",
            },
            headers=_HEADERS(),
        )
        r.raise_for_status()
    return {"list_name": list_name, "tickers": r.json()}


class WatchlistAddRequest(BaseModel):
    list_name: str
    ticker: str
    position: int = 0


@router.post("/watchlists")
async def add_to_watchlist(body: WatchlistAddRequest):
    """Add a ticker to a watchlist."""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{SUPABASE_URL}/rest/v1/pca_watchlists",
            json={"list_name": body.list_name, "ticker": body.ticker.upper(), "position": body.position},
            headers={**_HEADERS(), "Prefer": "return=minimal"},
        )
        if r.status_code == 409:
            raise HTTPException(status_code=409, detail=f"{body.ticker} already in {body.list_name}")
        r.raise_for_status()
    return {"status": "added", "ticker": body.ticker.upper(), "list_name": body.list_name}


@router.delete("/watchlists/{list_name}/{ticker}")
async def remove_from_watchlist(list_name: str, ticker: str):
    """Remove a ticker from a watchlist."""
    async with httpx.AsyncClient() as client:
        r = await client.delete(
            f"{SUPABASE_URL}/rest/v1/pca_watchlists",
            params={"list_name": f"eq.{list_name}", "ticker": f"eq.{ticker.upper()}"},
            headers=_HEADERS(),
        )
        r.raise_for_status()
    return {"status": "removed", "ticker": ticker.upper(), "list_name": list_name}


# ─── Layouts ──────────────────────────────────────────────────

@router.get("/layouts")
async def get_layouts():
    """Return all available layout names and their descriptions."""
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{SUPABASE_URL}/rest/v1/pca_layouts",
            params={"select": "name,description,is_default", "order": "name.asc"},
            headers=_HEADERS(),
        )
        r.raise_for_status()
    return {"layouts": r.json()}


@router.get("/layouts/{name}")
async def get_layout(name: str):
    """Return the full config for a named layout."""
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{SUPABASE_URL}/rest/v1/pca_layouts",
            params={"name": f"eq.{name}", "select": "*", "limit": "1"},
            headers=_HEADERS(),
        )
        r.raise_for_status()
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail=f"Layout '{name}' not found")
    return rows[0]


class SaveLayoutRequest(BaseModel):
    name: str
    description: str = ""
    config: dict
    is_default: bool = False


@router.post("/layouts")
async def save_layout(body: SaveLayoutRequest):
    """Create or update a layout (upsert by name)."""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{SUPABASE_URL}/rest/v1/pca_layouts",
            json={
                "name": body.name,
                "description": body.description,
                "config": body.config,
                "is_default": body.is_default,
            },
            headers={**_HEADERS(), "Prefer": "resolution=merge-duplicates,return=minimal"},
        )
        r.raise_for_status()
    return {"status": "saved", "name": body.name}


# ─── Command Endpoint (called by MCP server) ──────────────────

class CommandRequest(BaseModel):
    action: str          # e.g. "open_layout", "load_ticker"
    payload: dict = {}


@router.post("/command")
async def send_command(body: CommandRequest):
    """
    Entry point for MCP-server-initiated commands.
    Routes the command to the appropriate WebSocket broadcast.
    """
    action = body.action

    if action == "open_layout":
        layout_name = body.payload.get("layout", "desktop")
        # Fetch layout config from DB
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{SUPABASE_URL}/rest/v1/pca_layouts",
                params={"name": f"eq.{layout_name}", "select": "config", "limit": "1"},
                headers=_HEADERS(),
            )
            r.raise_for_status()
        rows = r.json()
        if not rows:
            raise HTTPException(status_code=404, detail=f"Layout '{layout_name}' not found")
        layout_config = rows[0]["config"]
        # Instruct master tab to open child windows
        await manager.broadcast_to_masters({
            "action": "open_layout",
            "layout_name": layout_name,
            "config": layout_config,
        })
        return {"status": "broadcasted", "action": "open_layout", "layout": layout_name}

    elif action == "load_ticker":
        symbol = body.payload.get("symbol", "").upper()
        if not symbol:
            raise HTTPException(status_code=400, detail="Missing 'symbol' in payload")
        await manager.broadcast({"action": "load_ticker", "symbol": symbol})
        return {"status": "broadcasted", "action": "load_ticker", "symbol": symbol}

    elif action == "load_watchlist":
        list_name   = body.payload.get("list_name", "")
        layout_name = body.payload.get("layout_name", "desktop")
        if not list_name:
            raise HTTPException(status_code=400, detail="Missing 'list_name' in payload")

        # 1. Fetch current layout config from DB
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{SUPABASE_URL}/rest/v1/pca_layouts",
                params={"name": f"eq.{layout_name}", "select": "config", "limit": "1"},
                headers=_HEADERS(),
            )
            r.raise_for_status()
        rows = r.json()
        if not rows:
            raise HTTPException(status_code=404, detail=f"Layout '{layout_name}' not found")

        # 2. Update watchlist field in layout config root
        config = rows[0]["config"]
        config["watchlist"] = list_name

        # 3. Persist updated layout back to DB
        async with httpx.AsyncClient() as client:
            r = await client.patch(
                f"{SUPABASE_URL}/rest/v1/pca_layouts",
                params={"name": f"eq.{layout_name}"},
                json={"config": config},
                headers={**_HEADERS(), "Prefer": "return=minimal"},
            )
            r.raise_for_status()
        logger.info("Layout '%s' updated: watchlist → '%s'", layout_name, list_name)

        # 4. Broadcast to all connected browser tabs
        await manager.broadcast({"action": "load_watchlist", "list_name": list_name})
        return {
            "status": "broadcasted",
            "action": "load_watchlist",
            "list_name": list_name,
            "layout": layout_name,
        }

    elif action == "request_download":
        ticker = body.payload.get("ticker", "").upper()
        if not ticker:
            raise HTTPException(status_code=400, detail="Missing 'ticker' in payload")
        from mqtt_listener import publish_message
        publish_message("agents/stock-data/commands", {
            "action": "request_download",
            "ticker": ticker
        })
        return {"status": "published", "action": "request_download", "ticker": ticker}

    else:
        raise HTTPException(status_code=400, detail=f"Unknown action: {action}")
