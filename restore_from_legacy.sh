#!/bin/bash

# Check if legacy directory exists
if [ ! -d "legacy" ]; then
    echo "Error: 'legacy' directory not found."
    exit 1
fi

echo "Restoring items from ./legacy/ to current directory..."

# Move everything back from legacy to root
# We use a loop to avoid moving the 'legacy' directory into itself if run multiple times
for item in legacy/* legacy/.[!.]*; do
    if [ -e "$item" ]; then
        echo "Restoring $(basename "$item")..."
        mv "$item" ./
    fi
done

# Optionally remove the empty legacy directory
# rmdir legacy 2>/dev/null

echo "Done. Items restored."
