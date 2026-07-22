// router.ts
declare const Deno: any;

let currentMode = "cpu";
const CPU_URL = Deno.env.get("CPU_URL") || "http://ollama-cpu:11434";
const GPU_URL = Deno.env.get("GPU_URL") || "http://ollama-gpu:11434";

console.log(`[Router] Starting Ollama Router on port 11434...`);
console.log(`[Router] CPU Backend: ${CPU_URL}`);
console.log(`[Router] GPU Backend: ${GPU_URL}`);

Deno.serve({ port: 11434, hostname: "0.0.0.0" }, async (request: Request) => {
  const url = new URL(request.url);

  // Router management API
  if (url.pathname === "/_router/mode") {
    if (request.method === "POST") {
      try {
        const body = await request.json();
        if (body.mode === "cpu" || body.mode === "gpu") {
          currentMode = body.mode;
          console.log(`[Router] Switched active Ollama backend to: ${currentMode}`);
          return Response.json({ status: "success", mode: currentMode });
        }
      } catch (_) { /* ignore */ }
      return Response.json({ error: "Invalid mode" }, { status: 400 });
    }
    return Response.json({ mode: currentMode });
  }

  // Proxy the request to the active backend
  const targetBase = currentMode === "gpu" ? GPU_URL : CPU_URL;
  const targetUrl = new URL(url.pathname + url.search, targetBase);

  // Copy request headers
  const headers = new Headers(request.headers);
  
  // Prepare fetch options
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
  const fetchOpts: any = {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    duplex: hasBody ? "half" : undefined, 
  };

  try {
    const response = await fetch(targetUrl, fetchOpts);
    return response;
  } catch (err) {
    console.error(`[Router] Proxy error forwarding request to ${targetBase}:`, err);
    const errMsg = err instanceof Error ? err.message : String(err);
    return new Response(`Ollama proxy error: ${errMsg}`, { status: 502 });
  }
});

