// core/agent-runtime/cross-agent.ts
// Cross-agent MCP via MQTT (publish request, await response)

import type * as mqtt from "mqtt";
import { StatelessMcpClient } from "./mcp-client";

// Pending cross-agent MCP request callbacks
// key: request_id  value: resolve function
export const pendingMcpRequests = new Map<string, (result: any) => void>();

export function callCrossAgentTool(
  mqttClient: mqtt.MqttClient,
  agentId: string,
  targetAgentId: string,
  toolName: string,
  toolArgs: any,
  timeoutMs = 15000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const requestId = `${agentId}-${Date.now()}`;

    pendingMcpRequests.set(requestId, resolve);

    const payload = JSON.stringify({
      header: {
        from: agentId,
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

export async function handleMcpRequest(
  mqttClient: mqtt.MqttClient,
  agentId: string,
  localMcpClients: StatelessMcpClient[],
  envelope: any
) {
  const requestId = envelope.request_id;
  const from      = envelope.header?.from || "unknown";
  const mcp       = envelope.mcp || {};
  const tool      = mcp.command || "";
  const params    = mcp.params || {};

  if (!tool || !requestId) return;

  console.log(`🔧 [${agentId}] cross-agent MCP request from '${from}': ${tool}`);

  // Find tool in local servers
  let result: any = { error: `Tool '${tool}' not found on ${agentId}` };
  for (const c of localMcpClients) {
    try {
      result = await c.callTool(tool, params);
      break;
    } catch { /* try next */ }
  }

  const responseTopic = `agents/${from}/mcp/response/${requestId}`;
  mqttClient.publish(responseTopic, JSON.stringify({ request_id: requestId, result }), { qos: 1 });
}
