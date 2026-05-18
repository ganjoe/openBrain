import { Client } from "npm:@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "npm:@modelcontextprotocol/sdk/client/sse.js";

async function runTests() {
  const envFile = await Deno.readTextFile("./.env");
  const keyMatch = envFile.match(/^MCP_ACCESS_KEY=(.+)$/m);
  const MCP_ACCESS_KEY = keyMatch ? keyMatch[1].trim() : "unknown";

  // Target CCO agent on port 8788
  const SERVER_URL = `http://10.20.0.23:8788?key=${MCP_ACCESS_KEY}`;
  console.log(`[Validation] Verbinde zu MCP Server: ${SERVER_URL.split('?')[0]}`);
  
  const transport = new SSEClientTransport(new URL(SERVER_URL));
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log("[Validation] Verbindung erfolgreich hergestellt!\n");

  console.log("--- 1. Lade Tools ---");
  const tools = await client.listTools();
  console.log(`[Validation] ${tools.tools.length} Tools gefunden:`);
  tools.tools.forEach(t => console.log(`   - ${t.name} : ${t.description.substring(0, 50)}...`));
  console.log("\n");

  console.log("--- 2. Teste 'exact_keyword_search' (FURUYA, snippets) ---");
  try {
    const res = await client.callTool({
      name: "exact_keyword_search",
      arguments: {
        keyword: "FURUYA",
        return_mode: "snippets",
        limit: 5
      }
    });
    console.log("[Ergebnis]:");
    const content = (res.content[0] as any).text;
    console.log(content.length > 500 ? content.substring(0, 500) + "...\n[abgeschnitten]" : content);
  } catch (err) {
    console.error("[Fehler beim Tool-Call]:", err);
  }
  
  console.log("\n--- 3. Teste 'read_workspace_posts' (dummy ID) ---");
  try {
    const res = await client.callTool({
      name: "read_workspace_posts",
      arguments: {
        ids: ["00000000-0000-0000-0000-000000000000"]
      }
    });
    console.log("[Ergebnis]:");
    console.log((res.content[0] as any).text);
  } catch (err) {
    console.error("[Fehler beim Tool-Call]:", err);
  }

  console.log("\n[Validation] Tests abgeschlossen. Trenne Verbindung...");
  await transport.close();
  Deno.exit(0);
}

runTests().catch(err => {
  console.error("Fatal Error:", err);
  Deno.exit(1);
});
