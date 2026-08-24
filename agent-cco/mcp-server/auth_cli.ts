import { X_CLIENT_ID, X_CLIENT_SECRET, generateCodeVerifier, generateCodeChallenge, supabase, saveXOAuthTokens, getXOAuthTokens } from "./tools/shared.ts";

const mode = Deno.args[0] || "status";

if (mode === "generate_link") {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

  await supabase.from("system_settings").upsert({
    key: "x_oauth_state",
    value: { verifier, state, created_at: Date.now() },
    description: "Temporary X OAuth 2.0 PKCE State"
  }, { onConflict: "key" });

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
  authUrl.searchParams.set("client_id", X_CLIENT_ID || "");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.log("AUTH_URL=" + authUrl.toString());
  Deno.exit(0);
}

if (mode === "exchange") {
  const code = Deno.args[1];
  if (!code) {
    console.error("Missing code argument");
    Deno.exit(1);
  }

  const { data: stateRecord } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", "x_oauth_state")
    .single();

  const verifier = stateRecord?.value?.verifier;
  if (!verifier) {
    console.error("No active verifier found in system_settings (x_oauth_state)");
    Deno.exit(1);
  }

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
    code_verifier: verifier,
  });

  const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers,
    body: bodyParams.toString(),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("Token exchange failed:", err);
    Deno.exit(1);
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;
  const expiresIn = tokenData.expires_in || 7200;

  // Resolve user identity
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
    console.warn("Could not fetch /users/me:", e);
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

  await supabase.from("system_settings").delete().eq("key", "x_oauth_state");

  console.log(`SUCCESS: Connected as @${username} (${screenName}, ID: ${userId})`);
  Deno.exit(0);
}

if (mode === "status") {
  const tokens = await getXOAuthTokens();
  if (tokens?.access_token) {
    console.log(`STATUS: Connected as @${tokens.username} (User ID: ${tokens.user_id})`);
  } else {
    console.log("STATUS: Not connected");
  }
  Deno.exit(0);
}
