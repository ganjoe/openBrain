#!/bin/bash
cd /home/daniel/openBrain

echo "🛠️  Rebuilding MCP servers (compiling TypeScript)..."
docker compose build mcp-cco
docker compose up -d mcp-cco

echo "🤖 Restarting Bots (reloading prompts)..."
docker restart openbrain-cco-bot openbrain-ea-bot

echo "🗄️  Restarting PostgREST (flushing SQL schema cache)..."
docker restart openbrain-postgrest

echo "✅ All agents successfully rebuilt and refreshed!"
