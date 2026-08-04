// core/agent-runtime/envelope.ts
// Nexus message envelope builder

export function buildEnvelope(agentId: string, to: string, text: string, mcpInfo?: any, msgType: string = "chat"): string {
  const envelope: any = {
    header: {
      from: agentId,
      to,
      date: new Date().toISOString().slice(0, 10),
      unix: Math.floor(Date.now() / 1000),
      msg_type: msgType,
    },
    content: { text },
  };
  if (mcpInfo) envelope.mcp = mcpInfo;
  return JSON.stringify(envelope);
}
