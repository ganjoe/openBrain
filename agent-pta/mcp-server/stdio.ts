import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenBrainTools } from "./tools/openbrain.ts";
import { registerNexusTools } from "./tools/nexus.ts";
import { registerPtaTools } from "./tools/pta.ts";
import { registerMinerviniTools } from "./tools/ask_minervini.ts";
import { registerQuoteTools } from "./tools/get_quote.ts";

const server = new McpServer({
  name: "open-brain-pta-stdio",
  version: "1.0.0",
});

registerOpenBrainTools(server);
registerNexusTools(server);
registerPtaTools(server);
registerMinerviniTools(server);
registerQuoteTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
