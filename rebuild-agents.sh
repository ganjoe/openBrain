#!/bin/bash
cd /home/daniel/openBrain

echo "🛠️  Rebuilding all custom services in parallel..."
docker compose build \
  mcp-server mcp-cco mcp-pta mcp-pca \
  nexus-frontend nexus-service \
  agent-cco-bot agent-ea-bot agent-pta-bot agent-pca-bot \
  agent-pca-service chart-frontend

echo "🚀 Starting updated services..."
docker compose up -d \
  mcp-server mcp-cco mcp-pta mcp-pca \
  nexus-frontend nexus-service \
  agent-cco-bot agent-ea-bot agent-pta-bot agent-pca-bot \
  agent-pca-service chart-frontend

echo "🗄️  Restarting PostgREST (flushing SQL schema cache)..."
docker restart openbrain-postgrest

echo "🗃️  Applying Minervini Risk DB Schema..."
docker exec openbrain-db psql -U postgres -d postgres -f /docker-entrypoint-initdb.d/12-pta-minervini-risk.sql

echo "✅ All agents and services successfully rebuilt and refreshed!"
