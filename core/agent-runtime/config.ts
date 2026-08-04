// core/agent-runtime/config.ts
// Config loading & typing — single source of truth for agent identity

import * as fs from "fs";
import * as yaml from "js-yaml";

export interface AgentMcpServer {
  url: string;
  label: string;
}

export interface ExtraSubscription {
  topic: string;
  handler: "telemetry_forward" | "custom";
}

export interface AgentConfig {
  agent: {
    id: string;
    name: string;
    display_name: string;
  };
  mqtt: {
    broker_url: string;
    lwt_topic: string;
    lwt_payload: string;
    extra_subscriptions?: ExtraSubscription[];
  };
  mcp: {
    local_servers: AgentMcpServer[];
  };
  runtime?: {
    max_tool_iterations?: number;       // Default: 12
    history_limit_system_messages?: number; // Context limit for system messages
  };
}

export function loadConfig(configPath: string): AgentConfig {
  try {
    const config = yaml.load(fs.readFileSync(configPath, "utf-8")) as AgentConfig;
    console.log(`🤖 Agent identity loaded: ${config.agent.id} (${config.agent.name})`);
    return config;
  } catch (e) {
    console.error("❌ Failed to load config.yaml:", e);
    process.exit(1);
  }
}
