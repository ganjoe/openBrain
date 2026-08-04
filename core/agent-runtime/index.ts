// core/agent-runtime/index.ts
// Main entry point — startAgent() boots an agent from config.yaml + optional hooks

import * as mqtt from "mqtt";
import { loadConfig } from "./config";
import type { AgentConfig } from "./config";
import type { AgentHooks, AgentContext } from "./hooks";
import { StatelessMcpClient } from "./mcp-client";
import { buildEnvelope } from "./envelope";
import { loadSystemPrompt } from "./prompt";
import { handleIncoming } from "./react-loop";
import { handleMcpRequest, pendingMcpRequests } from "./cross-agent";

export type { AgentHooks, AgentContext, AgentConfig };
export type { AgentTask, ReactContext } from "./hooks";

const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY || "";
const POSTGREST_URL  = process.env.POSTGREST_URL || "http://postgrest:3000";

export async function startAgent(configPath: string, hooks?: AgentHooks) {
  const config = loadConfig(configPath);
  const AGENT_ID = config.agent.id;
  const INBOX_TOPIC    = `agents/${AGENT_ID}/inbox`;
  const MCP_REQ_TOPIC  = `agents/${AGENT_ID}/mcp/request`;
  const MCP_RESP_TOPIC = `agents/${AGENT_ID}/mcp/response/+`;

  let activeProvider = "local";
  let contextLimit = 10;

  console.log(`🚀 Starting Nexus agent: ${AGENT_ID} (${config.agent.name})`);

  // Local MCP clients
  const localMcpClients = config.mcp.local_servers.map(
    (s) => new StatelessMcpClient(s.url, MCP_ACCESS_KEY)
  );
  console.log(`🔌 Local MCP servers: ${config.mcp.local_servers.map(s => s.label).join(", ")}`);

  // Load initial system prompt
  loadSystemPrompt(config.agent.name);

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
          contextLimit = 0;
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

  // Subscribe to standard topics
  await mqttClient.subscribeAsync(INBOX_TOPIC,    { qos: 1 });
  await mqttClient.subscribeAsync(MCP_REQ_TOPIC,  { qos: 1 });
  await mqttClient.subscribeAsync(MCP_RESP_TOPIC, { qos: 1 });
  await mqttClient.subscribeAsync("system/config/provider", { qos: 1 });
  await mqttClient.subscribeAsync("system/config/context_limit", { qos: 1 });

  // Subscribe to extra topics from config
  const extraSubs = config.mqtt.extra_subscriptions || [];
  for (const sub of extraSubs) {
    await mqttClient.subscribeAsync(sub.topic, { qos: 1 });
  }

  const subList = [INBOX_TOPIC, MCP_REQ_TOPIC, MCP_RESP_TOPIC, "system/config/provider", "system/config/context_limit", ...extraSubs.map(s => s.topic)].join(" | ");
  console.log(`📡 Subscribed: ${subList}`);

  // Publish online status
  const onlinePayload = JSON.stringify({ agent: AGENT_ID, status: "online", unix: Math.floor(Date.now() / 1000) });
  mqttClient.publish(config.mqtt.lwt_topic, onlinePayload, { qos: 1, retain: true });

  // Build agent context for hooks
  const agentContext: AgentContext = {
    agentId: AGENT_ID,
    mqttClient,
    buildEnvelope: (to: string, text: string, mcpInfo?: any, msgType?: string) =>
      buildEnvelope(AGENT_ID, to, text, mcpInfo, msgType),
  };

  // Build a set of extra subscription topics for fast lookup
  const extraTopicSet = new Set(extraSubs.map(s => s.topic));
  const extraTopicHandlers = new Map(extraSubs.map(s => [s.topic, s.handler]));

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
      // System config: provider
      if (topic === "system/config/provider") {
        if (envelope[AGENT_ID]) {
          activeProvider = envelope[AGENT_ID];
          console.log(`🔄 Provider synchronized: ${activeProvider}`);
        }
        return;
      }

      // System config: context limit
      if (topic === "system/config/context_limit") {
        if (envelope.enabled) {
          contextLimit = envelope.limit || 10;
        } else {
          contextLimit = 0;
        }
        console.log(`🔄 Context limit synchronized: ${contextLimit}`);
        return;
      }

      // Extra subscriptions from config.yaml
      if (extraTopicSet.has(topic)) {
        const handler = extraTopicHandlers.get(topic);
        if (handler === "telemetry_forward") {
          // Built-in: forward event as telemetry without invoking LLM
          const eventType = envelope.event || "unknown_event";
          const ticker = envelope.ticker || "unknown_ticker";
          const reason = envelope.reason ? ` (Grund: ${envelope.reason})` : "";
          const eventText = `[SYSTEM EVENT] ${topic}: ${eventType} für ${ticker}${reason}`;
          console.log(`📊 ${eventText}`);
          fetch("http://nexus-service:7734/api/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from_agent: "system",
              to: "all",
              text: eventText,
              msg_type: "telemetry",
            }),
          }).catch((e) => console.error("Telemetry forward failed:", e));
        } else if (handler === "custom" && hooks?.onExtraTopic) {
          await hooks.onExtraTopic(topic, envelope, agentContext);
        }
        return;
      }

      // Cross-agent MCP request
      if (topic.endsWith("/mcp/request") && topic.includes(`agents/${AGENT_ID}/`)) {
        await handleMcpRequest(mqttClient, AGENT_ID, localMcpClients, envelope);
      }
      // Cross-agent MCP response
      else if (topic.match(/\/mcp\/response\//)) {
        const reqId = envelope.request_id;
        const resolve = pendingMcpRequests.get(reqId);
        if (resolve) {
          pendingMcpRequests.delete(reqId);
          resolve(envelope.result);
        }
      }
      // Regular inbox message → ReAct loop
      else {
        await handleIncoming(mqttClient, config, localMcpClients, envelope, activeProvider, contextLimit, hooks);
      }
    } catch (err) {
      console.error("❌ Message handler error:", err);
    }
  });

  console.log(`✅ ${config.agent.name} (${AGENT_ID}) is listening on The Nexus`);
}
