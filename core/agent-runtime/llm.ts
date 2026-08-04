// core/agent-runtime/llm.ts
// LLM providers: LM Studio (local) and Gemini (cloud) with automatic fallback

const LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

export async function callLMStudio(messages: any[], tools: any[]) {
  const payload: any = { model: "local-model", messages, temperature: 0.2 };
  if (tools.length > 0) payload.tools = tools;

  const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`LM Studio error: ${res.status} — ${await res.text()}`);

  const data: any = await res.json();
  if (!data.choices?.length) throw new Error("LM Studio returned empty response");

  const message = data.choices[0].message;
  return { message, tool_calls: message.tool_calls || null };
}

export async function callGemini(messages: any[], tools: any[], provider: string) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY") {
    throw new Error("GEMINI_API_KEY not configured in .env");
  }

  let modelName = "gemini-3-flash-preview";
  if (provider === "gemini-pro") {
    modelName = "gemini-3.1-pro-preview";
  } else if (provider === "gemini-3.5-flash") {
    modelName = "gemini-3.5-flash";
  } else if (provider === "gemini-2.5-pro") {
    modelName = "gemini-2.5-pro";
  } else if (provider === "gemini-2.5-flash") {
    modelName = "gemini-2.5-flash";
  }

  const sanitizedMessages = messages.map((m: any) => {
    const copy = { ...m };
    if (copy.role === "assistant" && (copy.content === null || copy.content === undefined)) {
      copy.content = "";
    }
    return copy;
  });

  const payload: any = {
    model: modelName,
    messages: sanitizedMessages,
    temperature: 0.2
  };
  if (tools.length > 0) payload.tools = tools;

  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GEMINI_API_KEY}`
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Gemini error: ${res.status} — ${await res.text()}`);

  const data: any = await res.json();
  if (!data.choices?.length) throw new Error("Gemini returned empty response");

  const message = data.choices[0].message;
  return { message, tool_calls: message.tool_calls || null };
}

export async function callLLM(
  activeProvider: string,
  messages: any[],
  tools: any[],
  onFallback?: (err: Error) => void
) {
  if (activeProvider && activeProvider.startsWith("gemini")) {
    try {
      return await callGemini(messages, tools, activeProvider);
    } catch (err: any) {
      if (onFallback) onFallback(err);
      return await callLMStudio(messages, tools);
    }
  }
  return await callLMStudio(messages, tools);
}
