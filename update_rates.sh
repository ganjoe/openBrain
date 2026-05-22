#!/bin/bash
# Script to update exchange rates via Docker
# Suitable for execution via Cron
cd /home/daniel/openBrain
docker run --rm --network host -v $(pwd):/app -w /app --env-file .env denoland/deno:latest run -A fetch_exchange_rates.ts >> /home/daniel/openBrain/fetch_exchange_rates.log 2>&1
