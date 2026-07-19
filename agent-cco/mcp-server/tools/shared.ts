import { createClient } from "@supabase/supabase-js";

// --- Configuration from environment ---
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

export const AGENT_ID = Deno.env.get("AGENT_ID") || "unknown";
export const GLOBAL_BRAIN_ACCESS = Deno.env.get("GLOBAL_BRAIN_ACCESS") === "true";
export const X_BEARER_TOKEN = Deno.env.get("X_BEARER_TOKEN");
export const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

// Local services
export const OLLAMA_URL = Deno.env.get("OLLAMA_URL") || "http://ollama:11434";
export const OLLAMA_EMBED_MODEL = Deno.env.get("OLLAMA_EMBED_MODEL") || "qwen3-embedding:8b";
export const LM_STUDIO_URL = Deno.env.get("LM_STUDIO_URL") || "http://host.docker.internal:1234";

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Telemetry Helper ---
export async function sendTelemetry(text: string) {
  console.log(`[Telemetry] ${text}`);
  try {
    await fetch("http://nexus-service:7734/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_agent: "system", to: "boss", text, msg_type: "telemetry" }),
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

// --- Provider helper ---
export async function getActiveProvider(key: string = AGENT_ID): Promise<string> {
  try {
    const { data } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "provider_config")
      .single();
    
    if (data?.value && data.value[key]) {
      return data.value[key];
    }
  } catch (e) {
    console.warn(`[Provider] Failed to fetch config for ${key}, defaulting to local.`);
  }
  return "local";
}

// --- Metadata extraction (LLM based) ---
export async function extractMetadata(text: string, sendTelemetryMessage: boolean = true, signal?: AbortSignal): Promise<Record<string, unknown>> {
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

  if (provider && provider.startsWith("gemini") && GEMINI_API_KEY) {
    let internalModel = "gemini-3-flash-preview";
    if (provider === "gemini-pro") {
      internalModel = "gemini-3.1-pro-preview";
    } else if (provider === "gemini-3.5-flash") {
      internalModel = "gemini-3.5-flash";
    } else if (provider === "gemini-2.5-pro") {
      internalModel = "gemini-2.5-pro";
    } else if (provider === "gemini-2.5-flash") {
      internalModel = "gemini-2.5-flash";
    }

    let retries = 0;
    while (true) {
      if (signal?.aborted) throw new Error("Sync abgebrochen.");
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GEMINI_API_KEY}`
        },
        body: JSON.stringify({
          model: internalModel,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
          temperature: 0.1
        }),
        signal: signal
      });
      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 503) {
          retries++;
          await sendTelemetry(`[Gemini] 503 Error. Warte 5 Sekunden (Versuch ${retries})...`);
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 5000);
            if (signal) {
              signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                reject(new Error("Sync abgebrochen."));
              }, { once: true });
            }
          });
          continue;
        }
        throw new Error(`Gemini failed: ${res.status} - ${errText}`);
      }
      d = await res.json();
      modelName = internalModel;
      break;
    }
  } else {
    const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "local-model",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
      }),
      signal: signal
    });
    if (!res.ok) return { topics: ["uncategorized"], type: "observation" };
    d = await res.json();
    modelName = d.model || "local-model";
  }
  
  const duration = (Date.now() - start) / 1000;
  const tokens = d.usage?.completion_tokens || 0;
  const ts = duration > 0 ? (tokens / duration).toFixed(1) : "0.0";
  
  const metricsStr = `[${provider === 'gemini' ? 'Gemini' : 'LM Studio'}] Model: ${modelName} | Zeit: ${duration.toFixed(2)}s | Speed: ${ts} t/s | Tokens: ${tokens}`;
  if (sendTelemetryMessage) {
    await sendTelemetry(metricsStr);
  }

  let parsed: any = { topics: ["uncategorized"], type: "observation" };
  try {
    const content = d.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
  } catch {
    // fallback
  }
  
  return { ...parsed, _metrics: metricsStr };
}
