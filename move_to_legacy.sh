#!/bin/bash

# List of legacy directories and files
LEGACY_ITEMS=(
    "dashboards"
    "docs"
    "extensions"
    "integrations"
    "primitives"
    "recipes"
    "resources"
    "schemas"
    "server"
    "skills"
    "supabase"
    "handbuch.html"
)

# Create legacy directory if it doesn't exist
mkdir -p legacy

echo "Moving legacy items to ./legacy/..."

for item in "${LEGACY_ITEMS[@]}"; do
    if [ -e "$item" ]; then
        echo "Moving $item..."
        mv "$item" legacy/
    else
        echo "Skipping $item (not found)"
    fi
done

echo "Done. Legacy items are now in the ./legacy/ directory."
