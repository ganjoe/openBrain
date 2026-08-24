import { createClient } from "@supabase/supabase-js";

// --- Configuration from environment ---
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

export const AGENT_ID = Deno.env.get("AGENT_ID") || "unknown";
export const GLOBAL_BRAIN_ACCESS = Deno.env.get("GLOBAL_BRAIN_ACCESS") === "true";
export const X_BEARER_TOKEN = Deno.env.get("X_BEARER_TOKEN");
export const X_CLIENT_ID = Deno.env.get("X_CLIENT_ID");
export const X_CLIENT_SECRET = Deno.env.get("X_CLIENT_SECRET");
export const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

// Local services / LLM Gateway Router
export const SWITCHYARD_URL = Deno.env.get("SWITCHYARD_URL") || "http://switchyard:4000/v1";
export const EMBED_MODEL = Deno.env.get("EMBED_MODEL") || "embeddings";
export const LM_STUDIO_URL = Deno.env.get("LM_STUDIO_URL") || "http://host.docker.internal:1234";

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- X OAuth 2.0 PKCE Helpers & Token Manager ---
function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

export interface XOAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  user_id?: string;
  username?: string;
  name?: string;
  scope?: string;
}

export async function getXOAuthTokens(): Promise<XOAuthTokens | null> {
  try {
    const { data } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "x_oauth_tokens")
      .single();
    if (data?.value && data.value.access_token) {
      return data.value as XOAuthTokens;
    }
  } catch (e) {
    console.error("[OAuth] Failed to load X OAuth tokens:", e);
  }
  return null;
}

export async function saveXOAuthTokens(tokens: XOAuthTokens): Promise<void> {
  const { error } = await supabase.from("system_settings").upsert({
    key: "x_oauth_tokens",
    value: tokens,
  }, { onConflict: "key" });
  if (error) {
    console.error("[OAuth] Failed to save X OAuth tokens:", error);
    throw error;
  }
}

export async function getValidXUserAccessToken(): Promise<{ access_token: string; user_id?: string; username?: string }> {
  const tokens = await getXOAuthTokens();
  if (!tokens || !tokens.access_token) {
    throw new Error("X OAuth 2.0 ist noch nicht autorisiert. Bitte öffne http://127.0.0.1:8788/auth/x/login im Browser.");
  }

  // If token expires in less than 2 minutes, refresh it
  if (Date.now() >= tokens.expires_at - 120000) {
    if (!tokens.refresh_token) {
      throw new Error("Kein Refresh-Token vorhanden. Bitte erneut unter http://127.0.0.1:8788/auth/x/login anmelden.");
    }
    if (!X_CLIENT_ID) {
      throw new Error("X_CLIENT_ID ist nicht konfiguriert.");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (X_CLIENT_SECRET) {
      headers["Authorization"] = `Basic ${btoa(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`)}`;
    }

    const bodyParams = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: X_CLIENT_ID,
    });

    const res = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers,
      body: bodyParams.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[OAuth] Refresh failed:", errText);
      throw new Error(`X OAuth Token-Refresh fehlgeschlagen: ${errText}`);
    }

    const data = await res.json();
    const updated: XOAuthTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (data.expires_in * 1000),
      user_id: tokens.user_id,
      username: tokens.username,
      name: tokens.name,
      scope: data.scope || tokens.scope,
    };
    await saveXOAuthTokens(updated);
    console.log("[OAuth] X Token erfolgreich erneuert.");
    return { access_token: updated.access_token, user_id: updated.user_id, username: updated.username };
  }

  return { access_token: tokens.access_token, user_id: tokens.user_id, username: tokens.username };
}

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

// --- Embedding via Switchyard ---
export async function getEmbedding(text: string): Promise<number[]> {
  const embeddings = await getEmbeddingsBatch([text]);
  return embeddings[0];
}

export async function getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  const start = Date.now();
  const baseUrl = SWITCHYARD_URL.endsWith("/v1") ? SWITCHYARD_URL : `${SWITCHYARD_URL}/v1`;
  const r = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Authorization": "Bearer switchyard"
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Embeddings failed (${baseUrl}/embeddings, status ${r.status}): ${errText}`);
  }
  const d = await r.json();
  const duration = (Date.now() - start) / 1000;
  await sendTelemetry(`[Switchyard] Route: ${EMBED_MODEL} | Zeit: ${duration.toFixed(2)}s | Aktion: Batch Embedding (${texts.length})`);
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
    console.warn(`[Provider] Failed to fetch config for ${key}, defaulting to auto.`);
  }
  return "auto";
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
      signal: signal
    });
    if (!res.ok) {
      // Fallback directly to LM Studio if Switchyard route had an issue
      const fbRes = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "local-model",
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
        }),
        signal: signal
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

// --- Author Resolution Helper ---
export async function resolveAuthorHandles(authorInput: string): Promise<{ primaryUsername: string, allHandles: string[] }> {
  const clean = authorInput.replace(/^@/, "").trim().toLowerCase();
  if (!clean) return { primaryUsername: "", allHandles: [] };

  const handles = new Set<string>();
  handles.add(`@${clean}`);
  handles.add(clean);

  let primaryUsername = clean;

  try {
    const { data: matchedUsers } = await supabase
      .from("x_users")
      .select("username, screen_name, is_active")
      .or(`username.ilike.%${clean}%,screen_name.ilike.%${clean}%`);

    if (matchedUsers && matchedUsers.length > 0) {
      const activeMatch = matchedUsers.find((u: any) => u.is_active) || matchedUsers[0];
      if (activeMatch?.username) {
        primaryUsername = activeMatch.username.toLowerCase();
      }

      for (const u of matchedUsers) {
        if (u.username) {
          handles.add(`@${u.username.toLowerCase()}`);
          handles.add(u.username.toLowerCase());
        }
        if (u.screen_name) {
          handles.add(`@${u.screen_name.toLowerCase()}`);
          handles.add(u.screen_name.toLowerCase());
        }
      }
    }
  } catch (e) {
    console.warn("[Author Resolution] Failed to query x_users:", e);
  }

  return {
    primaryUsername,
    allHandles: Array.from(handles)
  };
}

