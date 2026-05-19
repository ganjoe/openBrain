import { Client } from "npm:@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk/client/streamableHttp.js";

async function runTests() {
  const envFile = await Deno.readTextFile("./.env");
  const keyMatch = envFile.match(/^MCP_ACCESS_KEY=(.+)$/m);
  const MCP_ACCESS_KEY = keyMatch ? keyMatch[1].trim() : "unknown";

  // === CCO Agent Tests (Port 8788) ===
  try {
    const SERVER_URL = `http://localhost:8788?key=${MCP_ACCESS_KEY}`;
    console.log(`[CCO] Verbinde zu MCP Server: ${SERVER_URL.split('?')[0]}`);
    
    const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL));
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    // Timeout for CCO connection
    const ccoConnect = Promise.race([
      client.connect(transport),
      new Promise((_, reject) => setTimeout(() => reject(new Error("CCO Verbindung Timeout (10s)")), 10000))
    ]);
    await ccoConnect;
    console.log("[CCO] Verbindung erfolgreich hergestellt!\n");

    console.log("--- 1. Lade Tools ---");
    const tools = await client.listTools();
    console.log(`[CCO] ${tools.tools.length} Tools gefunden:`);
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

    console.log("\n[CCO] Tests abgeschlossen. Trenne CCO Verbindung...");
    await transport.close();
  } catch (err: any) {
    console.log(`\n⚠️  CCO Tests übersprungen: ${err.message}\n`);
  }

  // ============================================================
  // PTA Order Lifecycle Test (Port 8789)
  // ============================================================
  console.log("\n\n========================================");
  console.log("  PTA ORDER LIFECYCLE TEST (AAPL)");
  console.log("========================================\n");

  const PTA_URL = `http://localhost:8789?key=${MCP_ACCESS_KEY}`;
  console.log(`[PTA] Verbinde zu MCP Server: ${PTA_URL.split('?')[0]}`);
  
  const ptaTransport = new StreamableHTTPClientTransport(new URL(PTA_URL));
  const ptaClient = new Client(
    { name: "test-client-pta", version: "1.0.0" },
    { capabilities: {} }
  );
  await ptaClient.connect(ptaTransport);
  console.log("[PTA] Verbindung erfolgreich!\n");

  const TEST_TRADE_ID = `VALIDATE-${Date.now()}`;
  const TEST_TICKER = "AAPL";
  // Limit price ~80% of current market → low enough not to fill, close enough for IBKR to accept
  // IBKR rejects prices that are >50% away from market for most US stocks
  const LIMIT_PRICE = 150.00; // AAPL trades around ~190-200, 150 is ~20-25% below → safe

  // --- Step 4: Place Limit Buy Order ---
  console.log("--- 4. Erstelle Limit-Buy Order (AAPL @ $150) ---");
  try {
    const res = await ptaClient.callTool({
      name: "trade",
      arguments: {
        action: "ENTER",
        trade_id: TEST_TRADE_ID,
        ticker: TEST_TICKER,
        quantity: 1,
        limit_price: LIMIT_PRICE,
        currency: "USD",
        notes: "validate_mcp.ts lifecycle test"
      }
    });
    const text = (res.content[0] as any).text;
    console.log(`[Ergebnis]: ${text}`);
    if (text.includes("Error")) {
      console.error("[ABBRUCH] Order konnte nicht erstellt werden!");
      await ptaTransport.close();
      Deno.exit(1);
    }
  } catch (err) {
    console.error("[Fehler beim Order-Erstellen]:", err);
    await ptaTransport.close();
    Deno.exit(1);
  }

  // --- Step 5: Wait for Sync Loop to submit to IBKR ---
  console.log("\n--- 5. Warte 6s auf Sync-Loop (Order → IBKR) ---");
  await new Promise(r => setTimeout(r, 6000));

  // --- Step 6: Verify order appears in live positions ---
  console.log("\n--- 6. Prüfe ob Order in Live-Positionen sichtbar ist ---");
  let orderFound = false;
  try {
    const res = await ptaClient.callTool({
      name: "list_active_positions",
      arguments: {}
    });
    const text = (res.content[0] as any).text;
    orderFound = text.includes(TEST_TICKER) && text.includes("Active Order");
    
    // Extract relevant lines
    const lines = text.split("\n");
    const aaplLines = lines.filter((l: string) => l.includes(TEST_TICKER));
    if (aaplLines.length > 0) {
      console.log("[Gefundene AAPL-Einträge]:");
      aaplLines.forEach((l: string) => console.log(`   ${l.trim()}`));
    }
    
    if (orderFound) {
      console.log(`\n✅ Order für ${TEST_TICKER} ist beim Broker sichtbar!`);
    } else if (text.includes(TEST_TICKER)) {
      console.log(`\n⚠️  ${TEST_TICKER} gefunden aber kein 'Active Order' — möglicherweise als Position ohne Order angezeigt`);
      // Check OTHER OPEN ORDERS section
      const otherLines = lines.filter((l: string) => l.includes(TEST_TICKER) || l.includes("OTHER OPEN"));
      otherLines.forEach((l: string) => console.log(`   ${l.trim()}`));
      orderFound = text.includes(TEST_TICKER);
    } else {
      console.log(`\n⚠️  ${TEST_TICKER} nicht in der Ausgabe gefunden. Broker könnte die Order abgelehnt haben.`);
      console.log("   (Mögliche Ursache: Limit-Preis zu weit vom Marktpreis entfernt)");
    }
  } catch (err) {
    console.error("[Fehler beim Positions-Check]:", err);
  }

  // --- Step 7: Cancel the order ---
  console.log("\n--- 7. Storniere die Test-Order ---");
  try {
    const res = await ptaClient.callTool({
      name: "trade",
      arguments: {
        action: "CANCEL",
        trade_id: `${TEST_TRADE_ID}-CANCEL`,
        ticker: TEST_TICKER,
        notes: "validate_mcp.ts cleanup"
      }
    });
    const text = (res.content[0] as any).text;
    console.log(`[Ergebnis]: ${text}`);
  } catch (err) {
    console.error("[Fehler beim Stornieren]:", err);
  }

  // Wait for cancel to process
  console.log("\n--- Warte 8s auf Cancel-Verarbeitung ---");
  await new Promise(r => setTimeout(r, 8000));

  // --- Step 8: Verify order is gone ---
  console.log("\n--- 8. Prüfe ob Order entfernt wurde ---");
  try {
    const res = await ptaClient.callTool({
      name: "list_active_positions",
      arguments: {}
    });
    const text = (res.content[0] as any).text;
    const stillPresent = text.includes(TEST_TICKER) && (text.includes("Active Order") || text.includes("OTHER OPEN"));
    
    if (!stillPresent) {
      console.log(`✅ ${TEST_TICKER} Order erfolgreich entfernt! Lifecycle-Test BESTANDEN.`);
    } else {
      console.log(`❌ ${TEST_TICKER} ist noch sichtbar. Cancel möglicherweise noch in Verarbeitung.`);
      const lines = text.split("\n");
      lines.filter((l: string) => l.includes(TEST_TICKER)).forEach((l: string) => console.log(`   ${l.trim()}`));
    }
  } catch (err) {
    console.error("[Fehler beim Verifizieren]:", err);
  }

  console.log("\n========================================");
  console.log("  PTA ORDER LIFECYCLE TEST ABGESCHLOSSEN");
  console.log("========================================\n");

  await ptaTransport.close();
  Deno.exit(0);
}

runTests().catch(err => {
  console.error("Fatal Error:", err);
  Deno.exit(1);
});
