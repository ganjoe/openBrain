import { Client } from "npm:@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk/client/streamableHttp.js";

async function runTests() {
  let envFile = "";
  try {
    envFile = await Deno.readTextFile("./.env");
  } catch {
    try {
      envFile = await Deno.readTextFile("../.env");
    } catch {
      try {
        envFile = await Deno.readTextFile(new URL("./.env", import.meta.url).pathname);
      } catch {
        console.error("❌ Could not find .env file in current, parent, or script directory.");
        Deno.exit(1);
      }
    }
  }

  const keyMatch = envFile.match(/^MCP_ACCESS_KEY=(.+)$/m);
  const MCP_ACCESS_KEY = keyMatch ? keyMatch[1].trim() : "unknown";

  const PCA_URL = `http://localhost:8790?key=${MCP_ACCESS_KEY}`;
  console.log(`[PCA] Connecting to MCP Server: ${PCA_URL.split('?')[0]}...`);

  const transport = new StreamableHTTPClientTransport(new URL(PCA_URL));
  const client = new Client(
    { name: "test-client-pca-features", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    console.log("✅ Connection to PCA MCP successful!");
  } catch (err: any) {
    console.error("❌ Failed to connect to PCA MCP:", err.message);
    Deno.exit(1);
  }

  // --- Step 1: Verify tool list contains trigger_feature_calculation ---
  console.log("\n--- 1. List Available Tools ---");
  const tools = await client.listTools();
  const triggerTool = tools.tools.find(t => t.name === "trigger_feature_calculation");
  
  if (triggerTool) {
    console.log(`✅ Tool 'trigger_feature_calculation' is registered on PCA MCP!`);
    console.log(`   Description: ${triggerTool.description}`);
  } else {
    console.error(`❌ Tool 'trigger_feature_calculation' NOT found in tools list!`);
    await transport.close();
    Deno.exit(1);
  }

  // --- Step 2: Check current features service status ---
  console.log("\n--- 2. Checking Features Service Status ---");
  try {
    const statusRes = await fetch("http://localhost:8003/status");
    if (!statusRes.ok) {
      throw new Error(`HTTP ${statusRes.status}: ${await statusRes.text()}`);
    }
    const statusData = await statusRes.json();
    console.log(`   Features Service Status (is_running): ${statusData.is_running}`);
    
    if (statusData.is_running) {
      console.log("⚠️ A feature calculation job is already running. We will test the 409 Conflict path first.");
    }
  } catch (err: any) {
    console.error("❌ Failed to query Features Service status API:", err.message);
    await transport.close();
    Deno.exit(1);
  }

  // --- Step 3: Trigger feature calculation in the background ---
  console.log("\n--- 3. Trigger Feature Calculation (Background / stream_telemetry: false) ---");
  try {
    const res = await client.callTool({
      name: "trigger_feature_calculation",
      arguments: {
        stream_telemetry: false
      }
    });
    
    console.log("[Result]:", JSON.stringify(res, null, 2));
    const contentText = (res.content[0] as any).text;
    
    if (res.isError) {
      if (contentText.includes("already running")) {
        console.log("✅ Correctly returned 'already running' status message.");
      } else {
        console.error("❌ Unexpected error returned:", contentText);
        await transport.close();
        Deno.exit(1);
      }
    } else {
      console.log("✅ Feature calculation triggered successfully in background.");
      if (contentText.toLowerCase().includes("background")) {
        console.log("✅ Correctly returned background status response.");
      } else {
        console.error("❌ Unexpected success response:", contentText);
        await transport.close();
        Deno.exit(1);
      }
    }
  } catch (err: any) {
    console.error("❌ Error executing trigger_feature_calculation tool:", err.message);
    await transport.close();
    Deno.exit(1);
  }

  // --- Step 4: Verify Conflict State ---
  console.log("\n--- 4. Verify Conflict State (Trigger again while running) ---");
  try {
    // Wait a brief moment to ensure status registers
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const res = await client.callTool({
      name: "trigger_feature_calculation",
      arguments: {
        stream_telemetry: false
      }
    });
    
    console.log("[Result]:", JSON.stringify(res, null, 2));
    const contentText = (res.content[0] as any).text;
    
    if (res.isError && contentText.includes("already running")) {
      console.log("✅ Successfully verified conflict path: Second trigger returned 'already running' error.");
    } else {
      console.error("❌ Failed to verify conflict path! Result should be an error stating a process is already running.");
      await transport.close();
      Deno.exit(1);
    }
  } catch (err: any) {
    console.error("❌ Error calling trigger_feature_calculation second time:", err.message);
    await transport.close();
    Deno.exit(1);
  }

  console.log("\n✅ ALL automated integration tests for trigger_feature_calculation passed successfully!");
  await transport.close();
  Deno.exit(0);
}

runTests().catch(err => {
  console.error("💥 Fatal Error:", err);
  Deno.exit(1);
});
