# OpenBrain Workspace Rules

## Docker Rebuilding Rule
- **Rebuild Mechanism**: When code changes are made in the workspace, always use the `rebuild-agents.sh` script to rebuild and restart the services.
- **Verification of Script**: Before executing the script, check if it needs to be extended to cover any new containers, services, or DB schema files added during the change.
- **Why**: The `rebuild-agents.sh` script is the proven and established way in this repository to rebuild all agent bots, MCP servers, and flush database caches in one go. Do not try to run manual docker compose build commands unless specifically requested.
