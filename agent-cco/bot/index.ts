import * as fs from "fs";
import * as path from "path";
import * as mqtt from "mqtt";
import * as yaml from "js-yaml";

// ─────────────────────────────────────────────────────────────
// 1. Load config.yaml — single source of truth for agent identity
// ─────────────────────────────────────────────────────────────
interface AgentConfig {
  agent:  { id: string; name: string; display_name: string };
  mqtt:   { broker_url: string; lwt_topic: string; lwt_payload: string };
  mcp:    { local_servers: Array<{ url: string; label: string }> };
}

const CONFIG_PATH = process.env.CONFIG_PATH || "/app/config.yaml";
let config: AgentConfig;

try {
  config = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as AgentConfig;
  console.log(`🤖 Agent identity loaded: ${config.agent.id} (${config.agent.name})`);
} catch (e) {
  console.error("❌ Failed to load config.yaml:", e);
  process.exit(1);
}

const AGENT_ID       = config.agent.id;           // e.g. "ea" — never hardcoded
const INBOX_TOPIC    = `agents/${AGENT_ID}/inbox`;
const MCP_REQ_TOPIC  = `agents/+/mcp/request`;    // watch cross-agent MCP requests
const MCP_RESP_TOPIC = `agents/${AGENT_ID}/mcp/response/+`;

// ─────────────────────────────────────────────────────────────
// 2. Other environment config
// ─────────────────────────────────────────────────────────────
const LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY || "";
const POSTGREST_URL  = process.env.POSTGREST_URL || "http://postgrest:3000";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

let activeProvider = "local"; // Dynamically updated via Nexus
let contextLimit = 10; // Dynamically updated via Nexus

// ─────────────────────────────────────────────────────────────
// 3. System prompt (mounted via Docker volume)
// ─────────────────────────────────────────────────────────────
let SYSTEM_PROMPT = `Du bist ${config.agent.name}. Bitte mounte eine prompt.txt.`;
const PROMPT_PATH = process.env.PROMPT_PATH || "/app/prompt.txt";
if (fs.existsSync(PROMPT_PATH)) {
  SYSTEM_PROMPT = fs.readFileSync(PROMPT_PATH, "utf-8");
} else {
  console.warn(`⚠️  No prompt.txt at ${PROMPT_PATH} — using fallback.`);
}

// ─────────────────────────────────────────────────────────────
// 4. Pending cross-agent MCP request callbacks
//    key: request_id  value: resolve function
// ─────────────────────────────────────────────────────────────
const pendingMcpRequests = new Map<string, (result: any) => void>();

// ─────────────────────────────────────────────────────────────
// 5. Stateless MCP HTTP client (for LOCAL servers only)
// ─────────────────────────────────────────────────────────────
class StatelessMcpClient {
  constructor(public url: string, private key: string) {}

  private async request(method: string, params: any) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000); // 10 minutes timeout for syncs

    try {
      const res = await fetch(`${this.url}?key=${this.key}`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Date.now() }),
        signal: controller.signal,
      });

      const text = await res.text();
      clearTimeout(timeout);
      let jsonStr = text;

      if (text.includes("event: message")) {
        const dataLine = text.split("\n").find(l => l.startsWith("data: "));
        if (dataLine) jsonStr = dataLine.substring(6);
      }

      const data = JSON.parse(jsonStr);
      if (data.error) throw new Error(data.error.message);
      return data.result;
    } catch (err: any) {
      clearTimeout(timeout);
      throw err;
    }
  }

  async listTools()              { return this.request("tools/list", {}); }
  async callTool(name: string, args: any) { return this.request("tools/call", { name, arguments: args }); }
}

// ─────────────────────────────────────────────────────────────
// 6. Cross-agent MCP via MQTT (publish request, await response)
// ─────────────────────────────────────────────────────────────
function callCrossAgentTool(
  mqttClient: mqtt.MqttClient,
  targetAgentId: string,
  toolName: string,
  toolArgs: any,
  timeoutMs = 15000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const requestId = `${AGENT_ID}-${Date.now()}`;

    pendingMcpRequests.set(requestId, resolve);

    const payload = JSON.stringify({
      header: {
        from: AGENT_ID,
        to: targetAgentId,
        date: "",
        unix: Math.floor(Date.now() / 1000),
        msg_type: "mcp_request",
      },
      mcp: { server: targetAgentId, command: toolName, params: toolArgs },
      request_id: requestId,
    });

    mqttClient.publish(`agents/${targetAgentId}/mcp/request`, payload, { qos: 1 });

    setTimeout(() => {
      if (pendingMcpRequests.has(requestId)) {
        pendingMcpRequests.delete(requestId);
        reject(new Error(`Cross-agent MCP timeout: ${targetAgentId}/${toolName}`));
      }
    }, timeoutMs);
  });
}

// ─────────────────────────────────────────────────────────────
// 7. Database history loader (PostgREST — via nexus_messages)
// ─────────────────────────────────────────────────────────────
async function loadHistoryFromDb(otherAgentId: string, limit = 10) {
  try {
    const params = new URLSearchParams({
      or: `(and(from_agent.eq.${AGENT_ID},to_agent.eq.${otherAgentId}),and(from_agent.eq.${otherAgentId},to_agent.eq.${AGENT_ID}))`,
      order: "unix_ts.desc",
      limit: limit.toString(),
    });

    const res = await fetch(`${POSTGREST_URL}/nexus_chat?${params.toString()}`);
    if (!res.ok) return [];

    const data: any[] = await res.json();
    // Return in chronological order (asc) for LLM context
    return data
      .sort((a, b) => a.unix_ts - b.unix_ts)
      .map(r => {
        const isAssistant = r.from_agent === AGENT_ID;
        const text = r.raw_payload?.content?.text || r.content || "";
        return { role: isAssistant ? "assistant" : "user", content: text };
      });
  } catch (err) {
    console.error("❌ History load failed:", err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 8. LM Studio helper (unchanged)
// ─────────────────────────────────────────────────────────────
async function callLMStudio(messages: any[], tools: any[]) {
  const payload: any = { model: "local-model", messages, temperature: 0.2 };
  if (tools.length > 0) payload.tools = tools;

  const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`LM Studio error: ${res.status} — ${await res.text()}`);

  const data: any = await res.json();
  if (!data.choices?.length) throw new Error("LM Studio returned empty response");

  const message = data.choices[0].message;
  return { message, tool_calls: message.tool_calls || null };
}

async function callGemini(messages: any[], tools: any[], provider: string) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY") {
    throw new Error("GEMINI_API_KEY not configured in .env");
  }
  
  const modelName = provider === "gemini-pro" ? "gemini-3.1-pro-preview" : "gemini-3-flash-preview";
  const payload: any = { 
    model: modelName, 
    messages, 
    temperature: 0.2 
  };
  if (tools.length > 0) payload.tools = tools;

  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GEMINI_API_KEY}`
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Gemini error: ${res.status} — ${await res.text()}`);

  const data: any = await res.json();
  if (!data.choices?.length) throw new Error("Gemini returned empty response");

  const message = data.choices[0].message;
  return { message, tool_calls: message.tool_calls || null };
}

async function callLLM(messages: any[], tools: any[], onFallback?: (err: Error) => void) {
  if (activeProvider === "gemini" || activeProvider === "gemini-pro") {
    try {
      return await callGemini(messages, tools, activeProvider);
    } catch (err: any) {
      if (onFallback) onFallback(err);
      return await callLMStudio(messages, tools);
    }
  }
  return await callLMStudio(messages, tools);
}

// ─────────────────────────────────────────────────────────────
// 9. Nexus message envelope builder
// ─────────────────────────────────────────────────────────────
function buildEnvelope(to: string, text: string, mcpInfo?: any): string {
  const envelope: any = {
    header: {
      from: AGENT_ID,
      to,
      date: new Date().toISOString().slice(0, 10),
      unix: Math.floor(Date.now() / 1000),
      msg_type: "chat",
    },
    content: { text },
  };
  if (mcpInfo) envelope.mcp = mcpInfo;
  return JSON.stringify(envelope);
}

// ─────────────────────────────────────────────────────────────
// 10. Handle incoming chat message
// ─────────────────────────────────────────────────────────────
async function handleIncoming(
  mqttClient: mqtt.MqttClient,
  localMcpClients: StatelessMcpClient[],
  envelope: any
) {
  const from    = envelope.header?.from || "unknown";
  const text    = envelope.content?.text || "";
  const textL   = text.toLowerCase();

  // Ignore own messages
  if (from === AGENT_ID) return;

  // If message is from another agent, we process it as long as it's in our inbox.
  // The 'isMentioned' check was previously here but is redundant for private inboxes.
  const isFromAgent = from !== "boss" && from !== AGENT_ID;

  console.log(`\n💬 [${AGENT_ID}] message from '${from}': ${text.slice(0, 80)}`);

  // Load history + tools in parallel (fetch specific history with sender)
  const historyPromise = loadHistoryFromDb(from, contextLimit);

  const availableTools: any[] = [];
  const toolToClient = new Map<string, StatelessMcpClient>();

  await Promise.all(
    localMcpClients.map(async (c) => {
      try {
        const res = await c.listTools();
        for (const t of res.tools) {
          availableTools.push({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          });
          toolToClient.set(t.name, c);
        }
      } catch (err) {
        console.error(`❌ Tool list failed for ${c.url}:`, err);
      }
    })
  );

  const history = await historyPromise;
  const currentDateTime = new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
  const messages: any[] = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\nAktuelle Zeit: ${currentDateTime}` },
    ...history,
    { role: "user", content: text },
  ];

  let hasWarnedFallback = false;
  const onFallback = (err: Error) => {
    console.error(`❌ Gemini failed: ${err.message}. Falling back to LM Studio.`);
    if (!hasWarnedFallback) {
      hasWarnedFallback = true;
      const warningPayload = buildEnvelope(from, `⚠️ **System-Warnung**: Gemini-Verbindung fehlgeschlagen (${err.message}). Wechsle zu LM Studio (lokal) für diese Anfrage.`);
      mqttClient.publish(`agents/${from}/inbox`, warningPayload, { qos: 1 });
    }
  };

  console.log(`🧠 Calling LLM (${activeProvider})...`);
  let response = await callLLM(messages, availableTools, onFallback);

  while (response.tool_calls?.length > 0) {
    messages.push(response.message);

    for (const tc of response.tool_calls) {
      console.log(`🛠️  Tool: ${tc.function.name}`);
      try {
        const args   = JSON.parse(tc.function.arguments);
        const client = toolToClient.get(tc.function.name);
        if (!client) throw new Error(`Tool not found: ${tc.function.name}`);

        const result      = await client.callTool(tc.function.name, args);
        const resultText  = result.content
          .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
          .join("\n");

        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: resultText });
      } catch (err: any) {
        console.error(`❌ Tool error: ${err.message}`);
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: `Error: ${err.message}` });
      }
    }

    response = await callLLM(messages, availableTools, onFallback);
  }

  const replyText = response.message?.content || "";
  if (!replyText || replyText.trim() === "[STOP]") return;

  // Response is logged automatically by nexus-service when published to MQTT

  // Publish reply to the sender's inbox (or boss channel)
  const replyTopic   = `agents/${from}/inbox`;
  const replyPayload = buildEnvelope(from, replyText);
  mqttClient.publish(replyTopic, replyPayload, { qos: 1 });
  console.log(`📤 [${AGENT_ID}] replied to '${from}'`);
}

// ─────────────────────────────────────────────────────────────
// 11. Handle incoming MCP request (cross-agent)
// ─────────────────────────────────────────────────────────────
async function handleMcpRequest(
  mqttClient: mqtt.MqttClient,
  localMcpClients: StatelessMcpClient[],
  envelope: any
) {
  const requestId = envelope.request_id;
  const from      = envelope.header?.from || "unknown";
  const mcp       = envelope.mcp || {};
  const tool      = mcp.command || "";
  const params    = mcp.params || {};

  if (!tool || !requestId) return;

  console.log(`🔧 [${AGENT_ID}] cross-agent MCP request from '${from}': ${tool}`);

  // Find tool in local servers
  let result: any = { error: `Tool '${tool}' not found on ${AGENT_ID}` };
  for (const c of localMcpClients) {
    try {
      result = await c.callTool(tool, params);
      break;
    } catch { /* try next */ }
  }

  const responseTopic = `agents/${from}/mcp/response/${requestId}`;
  mqttClient.publish(responseTopic, JSON.stringify({ request_id: requestId, result }), { qos: 1 });
}

// ─────────────────────────────────────────────────────────────
// 12. Main
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`🚀 Starting Nexus agent: ${AGENT_ID} (${config.agent.name})`);

  // Local MCP clients
  const localMcpClients = config.mcp.local_servers.map(
    (s) => new StatelessMcpClient(s.url, MCP_ACCESS_KEY)
  );
  console.log(`🔌 Local MCP servers: ${config.mcp.local_servers.map(s => s.label).join(", ")}`);

  // Fetch initial provider config
  try {
    const res = await fetch(`${POSTGREST_URL}/system_settings?key=eq.provider_config`);
    if (res.ok) {
      const data: any = await res.json();
      if (data && data.length > 0) {
        const configMap = data[0].value || {};
        if (configMap[AGENT_ID]) activeProvider = configMap[AGENT_ID];
      }
    }
  } catch (err) {
    console.warn("⚠️ Could not fetch initial provider config, defaulting to local.");
  }
  console.log(`🧠 Active LLM Provider: ${activeProvider}`);

  // Fetch initial context limit config
  try {
    const res = await fetch(`${POSTGREST_URL}/system_settings?key=eq.chat_context_limit`);
    if (res.ok) {
      const data: any = await res.json();
      if (data && data.length > 0) {
        const configMap = data[0].value || {};
        if (configMap.enabled) {
          contextLimit = configMap.limit || 10;
        } else {
          contextLimit = 10;
        }
      }
    }
  } catch (err) {
    console.warn("⚠️ Could not fetch initial context limit config, defaulting to 10.");
  }

  // MQTT connect with LWT
  const lwt = JSON.parse(config.mqtt.lwt_payload);
  lwt.unix  = Math.floor(Date.now() / 1000);

  const mqttClient = await mqtt.connectAsync(config.mqtt.broker_url, {
    clientId:  `agent-${AGENT_ID}-${Date.now()}`,
    clean:     true,
    will: {
      topic:   config.mqtt.lwt_topic,
      payload: Buffer.from(JSON.stringify(lwt)),
      qos:     1,
      retain:  true,
    },
  });

  console.log(`✅ MQTT connected to ${config.mqtt.broker_url}`);

  // Subscribe
  await mqttClient.subscribeAsync(INBOX_TOPIC,    { qos: 1 });
  await mqttClient.subscribeAsync(MCP_REQ_TOPIC,  { qos: 1 });
  await mqttClient.subscribeAsync(MCP_RESP_TOPIC, { qos: 1 });
  await mqttClient.subscribeAsync("system/config/provider", { qos: 1 });
  await mqttClient.subscribeAsync("system/config/context_limit", { qos: 1 });
  console.log(`📡 Subscribed: ${INBOX_TOPIC} | ${MCP_REQ_TOPIC} | ${MCP_RESP_TOPIC} | system/config/provider | system/config/context_limit`);

  // Publish online status
  const onlinePayload = JSON.stringify({ agent: AGENT_ID, status: "online", unix: Math.floor(Date.now() / 1000) });
  mqttClient.publish(config.mqtt.lwt_topic, onlinePayload, { qos: 1, retain: true });

  // Message router
  mqttClient.on("message", async (topic: string, rawPayload: Buffer) => {
    let envelope: any;
    try {
      envelope = JSON.parse(rawPayload.toString("utf-8"));
    } catch {
      console.warn(`⚠️  Non-JSON on topic ${topic}`);
      return;
    }

    try {
      if (topic === "system/config/provider") {
        if (envelope[AGENT_ID]) {
          activeProvider = envelope[AGENT_ID];
          console.log(`🔄 Provider synchronized: ${activeProvider}`);
        }
        return;
      }

      if (topic === "system/config/context_limit") {
        if (envelope.enabled) {
          contextLimit = envelope.limit || 10;
        } else {
          contextLimit = 10;
        }
        console.log(`🔄 Context limit synchronized: ${contextLimit}`);
        return;
      }
      
      if (topic.endsWith("/mcp/request") && topic.includes(`agents/${AGENT_ID}/`)) {
        await handleMcpRequest(mqttClient, localMcpClients, envelope);
      } else if (topic.match(/\/mcp\/response\//)) {
        // Resolve pending cross-agent MCP call
        const reqId = envelope.request_id;
        const resolve = pendingMcpRequests.get(reqId);
        if (resolve) {
          pendingMcpRequests.delete(reqId);
          resolve(envelope.result);
        }
      } else {
        // Regular inbox message → ReAct loop
        await handleIncoming(mqttClient, localMcpClients, envelope);
      }
    } catch (err) {
      console.error("❌ Message handler error:", err);
    }
  });

  console.log(`✅ ${config.agent.name} (${AGENT_ID}) is listening on The Nexus`);
}

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
