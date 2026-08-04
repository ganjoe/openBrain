// core/agent-runtime/history.ts
// Database history loader via PostgREST (nexus_messages / nexus_chat)

const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";

export async function loadHistoryFromDb(agentId: string, otherAgentId: string, limit: number = 10) {
  if (limit <= 0) return [];

  try {
    const params = new URLSearchParams({
      or: `(and(from_agent.eq.${agentId},to_agent.eq.${otherAgentId}),and(from_agent.eq.${otherAgentId},to_agent.eq.${agentId}))`,
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
        const isAssistant = r.from_agent === agentId;
        const text = r.raw_payload?.content?.text || r.content || "";
        return { role: isAssistant ? "assistant" : "user", content: text };
      });
  } catch (err) {
    console.error("❌ History load failed:", err);
    return [];
  }
}
