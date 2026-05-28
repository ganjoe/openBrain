import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { AGENT_ID, MCP_ACCESS_KEY } from "./tools/shared.ts";
import { registerNexusTools } from "./tools/nexus.ts";
import { registerPcaTools } from "./tools/pca.ts";

// --- MCP Server Setup ---
const server = new McpServer({
  name: "open-brain-pca",
  version: "1.0.0",
});

// Register tool modules
registerNexusTools(server);
registerPcaTools(server);

// --- Hono App with auth middleware ---
const app = new Hono();

app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid key" }, 401);
  }
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

const port = parseInt(Deno.env.get("PORT") || "8790");
console.log(`${AGENT_ID.toUpperCase()} MCP server starting on port ${port}...`);
Deno.serve({ port }, app.fetch);
