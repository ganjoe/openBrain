#!/bin/bash
cd /home/daniel/openBrain

echo "🛠️  Rebuilding all custom services in parallel..."
docker compose build \
  mcp-server mcp-cco \
  nexus-frontend nexus-service \
  agent-cco-bot agent-ea-bot

echo "🚀 Starting updated services..."
docker compose up -d \
  mcp-server mcp-cco \
  nexus-frontend nexus-service \
  agent-cco-bot agent-ea-bot

echo "🗄️  Restarting PostgREST (flushing SQL schema cache)..."
docker restart openbrain-postgrest

echo "✅ All agents and services successfully rebuilt and refreshed!"
