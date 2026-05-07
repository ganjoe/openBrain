import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { AGENT_ID, MCP_ACCESS_KEY } from "./tools/shared.ts";
import { registerOpenBrainTools } from "./tools/openbrain.ts";
import { registerXTools } from "./tools/x.ts";
import { registerNexusTools } from "./tools/nexus.ts";

// --- MCP Server Setup ---
const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// Register tools from modular files
registerOpenBrainTools(server);
registerXTools(server);
registerNexusTools(server);

// --- Hono App ---
const app = new Hono();
app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) return c.json({ error: "Invalid key" }, 401);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

const port = parseInt(Deno.env.get("PORT") || "8787");
console.log(`${AGENT_ID.toUpperCase()} MCP server starting...`);
Deno.serve({ port }, app.fetch);
