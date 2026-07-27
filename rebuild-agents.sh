#!/bin/bash
cd /home/daniel/openBrain

echo "🛠️  Rebuilding all custom services in parallel..."
docker compose build \
  ollama \
  mcp-server mcp-cco mcp-pta mcp-pca mcp-cda mcp-srm mcp-drawio \
  nexus-frontend nexus-service \
  agent-cco-bot agent-ea-bot agent-pta-bot agent-pca-bot agent-cda-bot agent-srm-bot \
  agent-pca-service chart-frontend

echo "🚀 Starting updated services..."
docker compose up -d \
  ollama \
  mcp-server mcp-cco mcp-pta mcp-pca mcp-cda mcp-srm mcp-drawio \
  nexus-frontend nexus-service \
  agent-cco-bot agent-ea-bot agent-pta-bot agent-pca-bot agent-cda-bot agent-srm-bot \
  agent-pca-service chart-frontend



echo "🗄️  Restarting PostgREST (flushing SQL schema cache)..."
docker restart openbrain-postgrest

echo "🗃️  Applying Minervini Risk DB Schema..."
docker exec openbrain-db psql -U postgres -d postgres -f /docker-entrypoint-initdb.d/12-pta-risk-parameters.sql
docker exec openbrain-db psql -U postgres -d postgres -f /docker-entrypoint-initdb.d/13-srm-schema.sql

echo "🗃️  Applying Influencer Directory Schema (search_influencers v2 with match_quality)..."
docker exec openbrain-db psql -U postgres -d postgres -f /docker-entrypoint-initdb.d/05-influencers.sql

echo "🗃️  Applying YouTube Sync Logs Schema..."
docker exec openbrain-db psql -U postgres -d postgres -f /docker-entrypoint-initdb.d/21-yt-sync-logs.sql

echo "✅ All agents and services successfully rebuilt and refreshed!"
