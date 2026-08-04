// core/agent-runtime/react-loop.ts
// The ReAct loop — core message handling for all agents

import type * as mqtt from "mqtt";
import type { AgentConfig } from "./config";
import type { AgentHooks, ReactContext } from "./hooks";
import { StatelessMcpClient } from "./mcp-client";
import { loadHistoryFromDb } from "./history";
import { loadSystemPrompt } from "./prompt";
import { buildEnvelope } from "./envelope";
import { callLLM } from "./llm";

const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const DEFAULT_MAX_TOOL_ITERATIONS = 12;

export async function handleIncoming(
  mqttClient: mqtt.MqttClient,
  config: AgentConfig,
  localMcpClients: StatelessMcpClient[],
  envelope: any,
  activeProvider: string,
  contextLimit: number,
  hooks?: AgentHooks,
) {
  const agentId = config.agent.id;
  const from    = envelope.header?.from || "unknown";
  const text    = envelope.content?.text || "";

  // Ignore own messages
  if (from === agentId) return;

  try {
    console.log(`\n💬 [${agentId}] message from '${from}': ${text.slice(0, 80)}`);

    // Load history + tools in parallel
    const actualLimit = from === "system" ? 0 : contextLimit;
    const historyPromise = loadHistoryFromDb(agentId, from, actualLimit);

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
      { role: "system", content: `${loadSystemPrompt(config.agent.name)}\n\nAktuelle Zeit: ${currentDateTime}` },
      ...history,
      { role: "user", content: text },
    ];

    // Build context objects for hooks
    const agentContext = {
      agentId,
      mqttClient,
      buildEnvelope: (to: string, txt: string, mcpInfo?: any, msgType?: string) =>
        buildEnvelope(agentId, to, txt, mcpInfo, msgType),
    };

    const reactContext: ReactContext = {
      ...agentContext,
      messages,
      from,
    };

    // Task completion handling: if the incoming envelope carries a task_id,
    // load the task from DB and let the hook inject continuation context.
    if (envelope?.metadata?.task_id && hooks?.onTaskCompleted) {
      try {
        const taskRes = await fetch(
          `${POSTGREST_URL}/agent_tasks?id=eq.${envelope.metadata.task_id}`,
        );
        if (taskRes.ok) {
          const tasks = await taskRes.json();
          if (tasks && tasks.length > 0) {
            await hooks.onTaskCompleted(tasks[0], reactContext);
            console.log(`🔄 [${agentId}] Task continuation loaded: ${envelope.metadata.task_id}`);
          }
        }
      } catch (err: any) {
        console.error(`❌ Failed to load task for continuation: ${err.message}`);
      }
    }

    // Allow hooks to inject additional context before the ReAct loop
    if (hooks?.onBeforeReact) {
      await hooks.onBeforeReact(reactContext, envelope);
    }

    // Gemini fallback warning
    let hasWarnedFallback = false;
    const onFallback = (err: Error) => {
      console.error(`❌ Gemini failed: ${err.message}. Falling back to LM Studio.`);
      if (!hasWarnedFallback) {
        hasWarnedFallback = true;
        const warningPayload = buildEnvelope(agentId, from, `⚠️ **System-Warnung**: Gemini-Verbindung fehlgeschlagen (${err.message}). Wechsle zu LM Studio (lokal) für diese Anfrage.`);
        mqttClient.publish(`agents/${from}/inbox`, warningPayload, { qos: 1 });
      }
    };

    console.log(`🧠 Calling LLM (${activeProvider})...`);
    let response = await callLLM(activeProvider, messages, availableTools, onFallback);

    const maxIterations = config.runtime?.max_tool_iterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    let toolIterations = 0;

    while (response.tool_calls?.length > 0) {
      if (toolIterations >= maxIterations) {
        console.warn(`⚠️ [${agentId}] Tool-Loop-Limit (${maxIterations}) erreicht. Erzwinge [STOP].`);
        const warnPayload = buildEnvelope(agentId, from, `⚠️ **System-Warnung**: Tool-Loop-Limit (${maxIterations}) erreicht. Die Iteration wird beendet. Bitte gib eine konkretere Anweisung, falls weitere Schritte nötig sind. [STOP]`);
        mqttClient.publish(`agents/${from}/inbox`, warnPayload, { qos: 1 });
        return;
      }
      toolIterations++;
      messages.push(response.message);

      for (const tc of response.tool_calls) {
        console.log(`🛠️  Tool [${toolIterations}/${maxIterations}]: ${tc.function.name}`);
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

      response = await callLLM(activeProvider, messages, availableTools, onFallback);
    }

    const replyText = response.message?.content || "";
    if (!replyText || replyText.trim() === "[STOP]") return;

    // Publish reply to the sender's inbox
    const replyTopic   = `agents/${from}/inbox`;
    const replyPayload = buildEnvelope(agentId, from, replyText);
    mqttClient.publish(replyTopic, replyPayload, { qos: 1 });
    console.log(`📤 [${agentId}] replied to '${from}'`);
  } catch (err: any) {
    console.error(`❌ [${agentId}] Error handling incoming message from '${from}':`, err);
    const errPayload = buildEnvelope(agentId, from, `❌ **System-Fehler**: ${err.message || err}`);
    mqttClient.publish(`agents/${from}/inbox`, errPayload, { qos: 1 });
  }
}
