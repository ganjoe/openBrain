#!/bin/sh
# Start the background sync loop via ts-node, then start the main bot process
npx ts-node ibkr_sync.ts &
SYNC_PID=$!

npx ts-node index.ts

# Cleanup if index.ts crashes
kill $SYNC_PID
