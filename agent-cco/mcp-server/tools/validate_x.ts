import { supabase, X_BEARER_TOKEN, AGENT_ID, getEmbeddingsBatch } from "./shared.ts";

async function validateXIntegration() {
  console.log("--- X Integration Validation ---");
  const username = "aleabitoreddit";
  const cleanName = `@${username}`;

  try {
    // 1. Check if X_BEARER_TOKEN is set
    if (!X_BEARER_TOKEN || X_BEARER_TOKEN.includes("YOUR_X_BEARER_TOKEN")) {
      console.error("❌ X_BEARER_TOKEN is not configured.");
      return;
    }
    console.log("✅ X_BEARER_TOKEN configured.");

    // 2. Resolve User ID (Testing Cache Logic)
    console.log(`Resolving User ID for ${username}...`);
    const res = await fetch(`https://api.twitter.com/2/users/by/username/${username}`, {
      headers: { "Authorization": `Bearer ${X_BEARER_TOKEN}` }
    });
    if (!res.ok) throw new Error(`X API failed: ${res.status}`);
    const userData = await res.json();
    const xId = userData.data?.id;
    if (!xId) throw new Error("User not found.");
    console.log(`✅ User ID resolved: ${xId}`);

    // 3. Test Caching in DB
    const { error: cacheError } = await supabase.from("x_users").upsert({ username: username, x_id: xId });
    if (cacheError) console.warn("⚠️ Cache Update failed (Migration 02-x-optimization.sql applied?):", cacheError.message);
    else console.log("✅ Cache Update successful.");

    // 4. Download 1 Post
    console.log(`Fetching 1 post from ${username}...`);
    const tweetRes = await fetch(`https://api.twitter.com/2/users/${xId}/tweets?max_results=5&tweet.fields=created_at,entities`, {
      headers: { "Authorization": `Bearer ${X_BEARER_TOKEN}` }
    });
    if (!tweetRes.ok) throw new Error(`Tweet fetch failed: ${tweetRes.status}`);
    const tweetData = await tweetRes.json();
    const tweet = tweetData.data?.[0];
    
    if (!tweet) {
      console.log("ℹ️ No tweets found for this user.");
      return;
    }
    console.log(`✅ Found tweet: [${tweet.id}] ${tweet.text.substring(0, 50)}...`);

    // 5. Test Batch Embedding
    console.log("Testing batch embedding...");
    const embeddings = await getEmbeddingsBatch([tweet.text]);
    if (embeddings.length === 1) console.log("✅ Embedding generated.");
    else throw new Error("Embedding failed.");

    // 6. Test Upsert with unique index
    console.log("Testing DB Upsert...");
    const { error: upsertError } = await supabase.from("agent_workspace").upsert({
      agent_id: AGENT_ID,
      artifact_type: "x_post",
      content: tweet.text,
      embedding: embeddings[0],
      metadata: {
        author: cleanName,
        external_id: tweet.id,
        published_at: tweet.created_at,
        tickers: []
      }
    }, { 
      onConflict: "x_external_id" 
    });

    if (upsertError) {
      console.error("❌ Upsert failed:", upsertError.message);
    } else {
      console.log("✅ Validation successful: Post downloaded and stored.");
    }

  } catch (err: any) {
    console.error("❌ Validation failed:", err.message);
  }
}

validateXIntegration();
