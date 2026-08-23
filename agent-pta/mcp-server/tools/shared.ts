import { createClient } from "@supabase/supabase-js";

// --- Configuration from environment ---
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

export const AGENT_ID = Deno.env.get("AGENT_ID") || "unknown";
export const GLOBAL_BRAIN_ACCESS = Deno.env.get("GLOBAL_BRAIN_ACCESS") === "true";
export const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

// Local services / LLM Gateway Router
export const SWITCHYARD_URL = Deno.env.get("SWITCHYARD_URL") || "http://switchyard:4000/v1";
export const EMBED_MODEL = Deno.env.get("EMBED_MODEL") || "embeddings";
export const LM_STUDIO_URL = Deno.env.get("LM_STUDIO_URL") || "http://host.docker.internal:1234";

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Telemetry Helper ---
export async function sendTelemetry(text: string) {
  try {
    await fetch("http://nexus-service:7734/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_agent: "system", to: "all", text, msg_type: "telemetry" }),
    });
  } catch (e) {
    console.error("Telemetry failed:", e);
  }
}

// --- Embedding via Switchyard ---
export async function getEmbedding(text: string): Promise<number[]> {
  const start = Date.now();
  const baseUrl = SWITCHYARD_URL.endsWith("/v1") ? SWITCHYARD_URL : `${SWITCHYARD_URL}/v1`;
  const r = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Authorization": "Bearer switchyard"
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Embeddings failed (${baseUrl}/embeddings, status ${r.status}): ${errText}`);
  }
  const d = await r.json();
  const duration = (Date.now() - start) / 1000;
  await sendTelemetry(`[Switchyard] Route: ${EMBED_MODEL} | Zeit: ${duration.toFixed(2)}s | Aktion: Embedding`);
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
    console.warn("[Provider] Failed to fetch config, defaulting to auto.");
  }
  return "auto";
}

// --- Active Trading Mode helper ---
export async function getActiveTradingMode(): Promise<"live" | "paper"> {
  try {
    const { data } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "ib_gateway_config")
      .single();
    if (data?.value?.active_mode === "paper") return "paper";
  } catch (e) {
    console.warn("[Mode] Failed to fetch trading mode, defaulting to live.");
  }
  return "live";
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
      })
    });
    if (!res.ok) throw new Error(`Gemini failed: ${res.status}`);
    d = await res.json();
    modelName = internalModel;
  } else {
    // Route through Switchyard (auto / local / fast / reasoning)
    const baseUrl = SWITCHYARD_URL.endsWith("/v1") ? SWITCHYARD_URL : `${SWITCHYARD_URL}/v1`;
    const targetRoute = provider || "auto";
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": "Bearer switchyard"
      },
      body: JSON.stringify({
        model: targetRoute,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
      }),
    });
    if (!res.ok) {
      const fbRes = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "local-model",
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
        }),
      });
      if (!fbRes.ok) return { topics: ["uncategorized"], type: "observation" };
      d = await fbRes.json();
      modelName = d.model || "local-model";
    } else {
      d = await res.json();
      modelName = d.model || targetRoute;
    }
  }
  
  const duration = (Date.now() - start) / 1000;
  const tokens = d.usage?.completion_tokens || 0;
  const ts = duration > 0 ? (tokens / duration).toFixed(1) : "0.0";
  
  const metricsStr = `[${provider.startsWith('gemini') ? 'Gemini' : 'Switchyard'}] Model: ${modelName} | Zeit: ${duration.toFixed(2)}s | Speed: ${ts} t/s | Tokens: ${tokens}`;
  await sendTelemetry(metricsStr);

  try {
    const content = d.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}
