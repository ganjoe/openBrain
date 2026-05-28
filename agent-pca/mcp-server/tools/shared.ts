import { createClient } from "@supabase/supabase-js";

// --- Configuration from environment ---
export const SUPABASE_URL            = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const MCP_ACCESS_KEY          = Deno.env.get("MCP_ACCESS_KEY")!;
export const AGENT_ID                = Deno.env.get("AGENT_ID") || "pca";

// PCA service base URL (FastAPI backend)
export const PCA_SERVICE_URL         = Deno.env.get("PCA_SERVICE_URL") || "http://agent-pca-service:8791";

// Optional — for shared Open Brain access
export const GEMINI_API_KEY          = Deno.env.get("GEMINI_API_KEY");
export const OLLAMA_URL              = Deno.env.get("OLLAMA_URL") || "http://ollama:11434";
export const OLLAMA_EMBED_MODEL      = Deno.env.get("OLLAMA_EMBED_MODEL") || "qwen3-embedding:8b";
export const LM_STUDIO_URL           = Deno.env.get("LM_STUDIO_URL") || "http://host.docker.internal:1234";

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Telemetry Helper (identical to other agents) ---
export async function sendTelemetry(text: string) {
  try {
    await fetch("http://nexus-service:7734/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_agent: AGENT_ID, to: "all", text, msg_type: "telemetry" }),
    });
  } catch (e) {
    console.error("Telemetry failed:", e);
  }
}

// --- PCA Service proxy helper ---
export async function pcaCommand(action: string, payload: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(`${PCA_SERVICE_URL}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`PCA service error ${r.status}: ${err}`);
  }
  const data = await r.json();
  return JSON.stringify(data);
}
