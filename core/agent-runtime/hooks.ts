// core/agent-runtime/hooks.ts
// Hook interface for agent-specific extensions without modifying the shared runtime.

export interface AgentTask {
  id: string;
  agent_id: string;
  task_type: string;
  status: string;
  original_request: string;
  context: Record<string, any>;
  result?: Record<string, any>;
  created_at: string;
  completed_at?: string;
}

export interface AgentContext {
  agentId: string;
  mqttClient: any;
  buildEnvelope: (to: string, text: string, mcpInfo?: any, msgType?: string) => string;
}

export interface ReactContext extends AgentContext {
  messages: any[];
  from: string;
}

export interface AgentHooks {
  /**
   * Called before the ReAct loop starts, allows injecting extra system messages
   * or performing pre-processing based on the incoming envelope.
   */
  onBeforeReact?: (ctx: ReactContext, envelope: any) => Promise<void>;

  /**
   * Called when a message arrives on an extra MQTT subscription
   * (configured in config.yaml mqtt.extra_subscriptions with handler: "custom").
   */
  onExtraTopic?: (topic: string, envelope: any, ctx: AgentContext) => Promise<void>;

  /**
   * Called when a background task completion is detected (via task_id in metadata).
   * The task is loaded from the agent_tasks DB table and passed to the hook.
   * The hook should inject the relevant context into ctx.messages for the LLM.
   */
  onTaskCompleted?: (task: AgentTask, ctx: ReactContext) => Promise<void>;
}
