import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenBrainTools } from "./tools/openbrain.ts";
import { registerXTools } from "./tools/x.ts";
import { registerNexusTools } from "./tools/nexus.ts";

const server = new McpServer({
  name: "open-brain-cco-stdio",
  version: "1.0.0",
});

registerOpenBrainTools(server);
registerXTools(server);
registerNexusTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
