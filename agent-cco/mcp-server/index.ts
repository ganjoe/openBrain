import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { AGENT_ID, MCP_ACCESS_KEY } from "./tools/shared.ts";
import { registerOpenBrainTools } from "./tools/openbrain.ts";
import { registerXTools } from "./tools/x.ts";
import { registerNexusTools } from "./tools/nexus.ts";
import { registerYouTubeTools } from "./tools/youtube.ts";
import { registerWebTools } from "./tools/web.ts";

// --- MCP Server Setup ---
const server = new McpServer({
  name: "open-brain-cco",
  version: "1.0.0",
});

// Register tools from modular files
registerOpenBrainTools(server);
registerXTools(server);
registerNexusTools(server);
registerYouTubeTools(server);
registerWebTools(server);

// --- Hono App ---
const app = new Hono();

// Public OAuth 2.0 routes (no MCP API key required)
app.get("/auth/x/login", async (c) => {
  const { X_CLIENT_ID, generateCodeVerifier, generateCodeChallenge, supabase } = await import("./tools/shared.ts");
  if (!X_CLIENT_ID) {
    return c.text("Fehler: X_CLIENT_ID ist nicht in der .env konfiguriert.", 500);
  }

  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

  // Save verifier and state in DB
  const { error: stateErr } = await supabase.from("system_settings").upsert({
    key: "x_oauth_state",
    value: { verifier, state, created_at: Date.now() },
  }, { onConflict: "key" });
  if (stateErr) {
    console.error("[OAuth Login] State save failed:", stateErr);
  }

  const redirectUri = "http://127.0.0.1:8788/oauth/callback";
  const scopes = [
    "bookmark.read",
    "follows.read",
    "list.read",
    "tweet.read",
    "users.read",
    "offline.access"
  ].join(" ");

  const authUrl = new URL("https://twitter.com/i/oauth2/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", X_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return c.redirect(authUrl.toString());
});

app.get("/oauth/callback", async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return c.html(`<html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
      <h2 style="color: #e53e3e;">❌ Autorisierung abgebrochen oder fehlgeschlagen</h2>
      <p>Fehler von X: <code>${error}</code></p>
    </body></html>`, 400);
  }

  if (!code) {
    return c.text("Missing authorization code", 400);
  }

  const { X_CLIENT_ID, X_CLIENT_SECRET, supabase, saveXOAuthTokens } = await import("./tools/shared.ts");

  // Retrieve state and verifier from DB
  const { data: stateRecord } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", "x_oauth_state")
    .single();

  const savedVerifier = stateRecord?.value?.verifier;
  if (!savedVerifier) {
    return c.html(`<html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
      <h2 style="color: #e53e3e;">❌ Fehler: Kein aktiver Login-Status gefunden</h2>
      <p>Bitte starte den Login erneut unter <a href="/auth/x/login">/auth/x/login</a>.</p>
    </body></html>`, 400);
  }

  try {
    const redirectUri = "http://127.0.0.1:8788/oauth/callback";
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (X_CLIENT_SECRET) {
      headers["Authorization"] = `Basic ${btoa(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`)}`;
    }

    const bodyParams = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: X_CLIENT_ID || "",
      redirect_uri: redirectUri,
      code_verifier: savedVerifier,
    });

    const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers,
      body: bodyParams.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("[OAuth Callback] Token exchange failed:", errText);
      return c.html(`<html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h2 style="color: #e53e3e;">❌ Token-Austausch fehlgeschlagen</h2>
        <pre style="background: #f7f7f7; padding: 15px; border-radius: 8px;">${errText}</pre>
      </body></html>`, 500);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in || 7200;

    // Fetch user profile
    let userId = "";
    let username = "";
    let screenName = "";
    try {
      const meRes = await fetch("https://api.twitter.com/2/users/me?user.fields=profile_image_url,description", {
        headers: { "Authorization": `Bearer ${accessToken}` }
      });
      if (meRes.ok) {
        const meData = await meRes.json();
        userId = meData.data?.id || "";
        username = meData.data?.username || "";
        screenName = meData.data?.name || "";
      }
    } catch (e) {
      console.warn("[OAuth Callback] Could not resolve /users/me:", e);
    }

    await saveXOAuthTokens({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Date.now() + expiresIn * 1000,
      user_id: userId,
      username: username,
      name: screenName,
      scope: tokenData.scope,
    });

    // Clean up temporary state
    await supabase.from("system_settings").delete().eq("key", "x_oauth_state");

    return c.html(`<html><body style="font-family: sans-serif; padding: 40px; text-align: center; background: #0f172a; color: #f8fafc;">
      <div style="max-width: 500px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
        <h2 style="color: #10b981; margin-bottom: 10px;">✅ Erfolgreich verbunden!</h2>
        <p style="font-size: 16px; color: #94a3b8;">Dein X-Account <strong>@${username}</strong> (${screenName || 'N/A'}) ist nun dauerhaft mit OpenBrain autorisiert.</p>
        <div style="background: #0f172a; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: left; font-size: 14px;">
          <div>👤 <strong>User ID:</strong> ${userId}</div>
          <div>🔑 <strong>Scopes:</strong> ${tokenData.scope || 'Standard'}</div>
          <div>🔄 <strong>Auto-Refresh:</strong> Aktiv (offline.access)</div>
        </div>
        <p style="font-size: 14px; color: #64748b;">Du kannst diesen Tab jetzt schließen.</p>
      </div>
    </body></html>`);
  } catch (err: any) {
    console.error("[OAuth Callback] Error:", err);
    return c.text(`Internal error: ${err.message}`, 500);
  }
});

// Protected MCP Endpoint (requires key)
app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) return c.json({ error: "Invalid key" }, 401);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

const port = parseInt(Deno.env.get("PORT") || "8787");
console.log(`${AGENT_ID.toUpperCase()} MCP server starting...`);
Deno.serve({ port }, app.fetch);
