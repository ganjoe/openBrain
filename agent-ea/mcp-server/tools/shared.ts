import { createClient } from "@supabase/supabase-js";

// --- Configuration from environment ---
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

export const AGENT_ID = Deno.env.get("AGENT_ID") || "unknown";
export const GLOBAL_BRAIN_ACCESS = Deno.env.get("GLOBAL_BRAIN_ACCESS") === "true";
export const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

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
  const start = Date.now();
  const r = await fetch(`${OLLAMA_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`Ollama embeddings failed: ${r.status}`);
  const d = await r.json();
  const duration = (Date.now() - start) / 1000;
  await sendTelemetry(`[Ollama] Model: ${OLLAMA_EMBED_MODEL} | Zeit: ${duration.toFixed(2)}s | Aktion: Embedding`);
  return d.data[0].embedding;
}

// --- Provider helper ---
export async function getActiveProvider(): Promise<string> {
  try {
    const { data } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "provider_config")
      .single();
    
    if (data?.value && data.value[AGENT_ID]) {
      return data.value[AGENT_ID];
    }
  } catch (e) {
    console.warn("[Provider] Failed to fetch config, defaulting to local.");
  }
  return "local";
}

// --- Metadata extraction (LLM based) ---
export async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const provider = await getActiveProvider();
  const start = Date.now();
  
  let systemPrompt = "Extract metadata from the user's captured thought. Return ONLY valid JSON.";
  try {
    systemPrompt = Deno.readTextFileSync("/app/metadata-prompt.txt");
  } catch (e) {
    try {
      systemPrompt = Deno.readTextFileSync("metadata-prompt.txt");
    } catch(e2) {}
  }

  let d: any;
  let modelName = "unknown";

  if (provider === "gemini" && GEMINI_API_KEY) {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GEMINI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gemini-3-flash-preview",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
        temperature: 0.1
      }),
    });
    if (!res.ok) throw new Error(`Gemini failed: ${res.status} - ${await res.text()}`);
    d = await res.json();
    modelName = "gemini-3-flash";
  } else {
    const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "local-model",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
      }),
    });
    if (!res.ok) return { topics: ["uncategorized"], type: "observation" };
    d = await res.json();
    modelName = d.model || "local-model";
  }
  
  const duration = (Date.now() - start) / 1000;
  const tokens = d.usage?.completion_tokens || 0;
  const ts = duration > 0 ? (tokens / duration).toFixed(1) : "0.0";
  
  await sendTelemetry(`[${provider === 'gemini' ? 'Gemini' : 'LM Studio'}] Model: ${modelName} | Zeit: ${duration.toFixed(2)}s | Speed: ${ts} t/s | Tokens: ${tokens}`);

  try {
    const content = d.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}
