import { createClient } from "@supabase/supabase-js";

// --- Configuration from environment ---
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

export const AGENT_ID = Deno.env.get("AGENT_ID") || "unknown";
export const GLOBAL_BRAIN_ACCESS = Deno.env.get("GLOBAL_BRAIN_ACCESS") === "true";
export const X_BEARER_TOKEN = Deno.env.get("X_BEARER_TOKEN");

// Local services
export const OLLAMA_URL = Deno.env.get("OLLAMA_URL") || "http://ollama:11434";
export const OLLAMA_EMBED_MODEL = Deno.env.get("OLLAMA_EMBED_MODEL") || "qwen3-embedding:8b";
export const LM_STUDIO_URL = Deno.env.get("LM_STUDIO_URL") || "http://host.docker.internal:1234";

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Telemetry Helper ---
export async function sendTelemetry(text: string) {
  try {
    await fetch("http://nexus-service:7734/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_agent: "system", to: "all", text, message_type: "telemetry" }),
    });
  } catch (e) {
    console.error("Telemetry failed:", e);
  }
}

// --- Embedding via Ollama ---
export async function getEmbedding(text: string): Promise<number[]> {
  const embeddings = await getEmbeddingsBatch([text]);
  return embeddings[0];
}

export async function getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  const start = Date.now();
  const r = await fetch(`${OLLAMA_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: texts }),
  });
  if (!r.ok) throw new Error(`Ollama embeddings failed: ${r.status}`);
  const d = await r.json();
  const duration = (Date.now() - start) / 1000;
  await sendTelemetry(`[Ollama] Model: ${OLLAMA_EMBED_MODEL} | Zeit: ${duration.toFixed(2)}s | Aktion: Batch Embedding (${texts.length})`);
  return d.data.map((item: any) => item.embedding);
}

// --- Metadata extraction (LLM based) ---
export async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const start = Date.now();
  let systemPrompt = "Extract metadata from the user's captured thought. Return ONLY valid JSON.";
  try {
    systemPrompt = Deno.readTextFileSync("/app/metadata-prompt.txt");
  } catch (e) {
    try {
      systemPrompt = Deno.readTextFileSync("metadata-prompt.txt");
    } catch(e2) {}
  }

  const r = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local-model",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
    }),
  });
  if (!r.ok) return { topics: ["uncategorized"], type: "observation" };
  const d = await r.json();
  
  const duration = (Date.now() - start) / 1000;
  const tokens = d.usage?.completion_tokens || 0;
  const ts = duration > 0 ? (tokens / duration).toFixed(1) : "0.0";
  const model = d.model || "local-model";
  
  await sendTelemetry(`[LM Studio] Model: ${model} | Zeit: ${duration.toFixed(2)}s | Speed: ${ts} t/s | Tokens: ${tokens}`);

  try {
    const content = d.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}
