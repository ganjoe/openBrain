"""
websocket_manager.py — Central WebSocket connection manager.
Tracks all connected browser tabs. Supports broadcasting to all clients
or exclusively to master tabs (for spawning child windows).
"""
import logging
from fastapi import WebSocket

logger = logging.getLogger("pca.ws_manager")


class ConnectionManager:
    def __init__(self):
        # All active WebSocket connections: {websocket: {"is_master": bool}}
        self._connections: dict[WebSocket, dict] = {}

    async def connect(self, ws: WebSocket, is_master: bool = False):
        await ws.accept()
        self._connections[ws] = {"is_master": is_master}
        logger.info("Client connected (master=%s). Total: %d", is_master, len(self._connections))

    def disconnect(self, ws: WebSocket):
        self._connections.pop(ws, None)
        logger.info("Client disconnected. Total: %d", len(self._connections))

    async def broadcast(self, message: dict):
        """Send a message to ALL connected clients."""
        import json
        payload = json.dumps(message)
        dead = []
        for ws in self._connections:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    async def broadcast_to_masters(self, message: dict):
        """Send a message only to master tabs (for window.open() calls)."""
        import json
        payload = json.dumps(message)
        dead = []
        for ws, meta in self._connections.items():
            if meta.get("is_master"):
                try:
                    await ws.send_text(payload)
                except Exception:
                    dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    def count(self) -> int:
        return len(self._connections)


# Singleton — imported by all routers
manager = ConnectionManager()
