import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, pcaCommand, PCA_SERVICE_URL, sendTelemetry } from "./shared.ts";


export function registerPcaTools(server: McpServer) {

  // ── manage_chart_view ─────────────────────────────────────────────
  server.registerTool(
    "manage_chart_view",
    {
      title: "Manage Chart View",
      description: "Manage layouts, load tickers, and navigate watchlists.",
      inputSchema: {
        action: z.enum(["OPEN_LAYOUT", "LIST_LAYOUTS", "LOAD_TICKER", "NEXT_TICKER", "PREV_TICKER"]).describe("The action to perform"),
        layout: z.string().optional().describe("Layout name, e.g. 'desktop' (for OPEN_LAYOUT)"),
        symbol: z.string().optional().describe("Ticker symbol (for LOAD_TICKER)"),
        list_name: z.string().optional().describe("Watchlist name (for NEXT/PREV)"),
        current_ticker: z.string().optional().describe("Currently displayed ticker (for NEXT/PREV)"),
      },
    },
    async ({ action, layout, symbol, list_name, current_ticker }: any) => {
        try {
            if (action === "OPEN_LAYOUT") {
                if (!layout) throw new Error("layout required for OPEN_LAYOUT");
                const result = await pcaCommand("open_layout", { layout });
                return { content: [{ type: "text", text: `Layout '${layout}' opened. ${result}` }] };
            } else if (action === "LIST_LAYOUTS") {
                const { data, error } = await supabase.from("pca_layouts").select("name, description, is_default").order("name");
                if (error) throw error;
                const lines = data.map((l: any) => `• ${l.name}${l.is_default ? " [default]" : ""}: ${l.description ?? "—"}`);
                return { content: [{ type: "text", text: lines.join("\n") || "No layouts found." }] };
            } else if (action === "LOAD_TICKER") {
                if (!symbol) throw new Error("symbol required for LOAD_TICKER");
                const result = await pcaCommand("load_ticker", { symbol: symbol.toUpperCase() });
                return { content: [{ type: "text", text: `Ticker ${symbol.toUpperCase()} loaded. ${result}` }] };
            } else if (action === "NEXT_TICKER" || action === "PREV_TICKER") {
                if (!current_ticker) throw new Error("current_ticker required");
                return _navigateWatchlist(list_name ?? "growth_stocks", current_ticker, action === "NEXT_TICKER" ? 1 : -1);
            }
            throw new Error("Invalid action");
        } catch (err: any) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
  );

  // ── manage_watchlist ──────────────────────────────────────────
  server.registerTool(
    "manage_watchlist",
    {
      title: "Manage Watchlist",
      description: "List, load, add to, or remove from watchlists.",
      inputSchema: {
        action: z.enum(["LIST", "LOAD", "ADD", "REMOVE"]).describe("The action to perform"),
        list_name: z.string().optional().describe("Watchlist name"),
        ticker: z.string().optional().describe("Ticker symbol (for ADD, REMOVE)"),
        position: z.number().optional().describe("Position in list (for ADD)"),
        layout_name: z.string().optional().describe("Layout to update (for LOAD)"),
      },
    },
    async ({ action, list_name, ticker, position, layout_name }: any) => {
        try {
            if (action === "LIST") {
                if (list_name) {
                  const { data, error } = await supabase.from("pca_watchlists").select("ticker, position").eq("list_name", list_name).order("position");
                  if (error) throw error;
                  const tickers = data.map((r: any) => r.ticker).join(", ");
                  return { content: [{ type: "text", text: `Watchlist '${list_name}': ${tickers}` }] };
                } else {
                  const { data, error } = await supabase.from("pca_watchlists").select("list_name").order("list_name");
                  if (error) throw error;
                  const names = [...new Set(data.map((r: any) => r.list_name))].join(", ");
                  return { content: [{ type: "text", text: `Available watchlists: ${names}` }] };
                }
            } else if (action === "LOAD") {
                if (!list_name) throw new Error("list_name required for LOAD");
                const result = await pcaCommand("load_watchlist", { list_name, layout_name: layout_name ?? "desktop" });
                return { content: [{ type: "text", text: `Watchlist '${list_name}' loaded and persisted in layout. ${result}` }] };
            } else if (action === "ADD") {
                if (!list_name || !ticker) throw new Error("list_name and ticker required for ADD");
                const { error } = await supabase.from("pca_watchlists").insert({ list_name, ticker: ticker.toUpperCase(), position: position ?? 999 });
                if (error) throw error;
                return { content: [{ type: "text", text: `${ticker.toUpperCase()} added to '${list_name}'.` }] };
            } else if (action === "REMOVE") {
                if (!list_name || !ticker) throw new Error("list_name and ticker required for REMOVE");
                const { error } = await supabase.from("pca_watchlists").delete().eq("list_name", list_name).eq("ticker", ticker.toUpperCase());
                if (error) throw error;
                return { content: [{ type: "text", text: `${ticker.toUpperCase()} removed from '${list_name}'.` }] };
            }
            throw new Error("Invalid action");
        } catch (err: any) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
  );

  // ── Technical Indicators (On-the-fly) ────────────────────────
  server.registerTool(
    "get_technical_indicator",
    {
      title: "Get Technical Indicator",
      description: "Calculate and retrieve technical indicators (MA, RS Rating, Minervini) on-the-fly.",
      inputSchema: {
        indicator: z.enum(["ma", "rs", "minervini"]).describe("Which indicator to calculate"),
        ticker: z.string().describe("Ticker symbol (e.g. AAPL)"),
        chart_timeframe: z.string().optional().default("1D").describe("Data timeframe"),
        ma_type: z.enum(["sma", "ema"]).optional().describe("For 'ma' only: type of moving average"),
        ma_window: z.number().optional().describe("For 'ma' only: window period (e.g. 50, 150, 200)"),
        benchmark: z.string().optional().describe("For 'rs' only: benchmark ticker (e.g. SPX)"),
      },
    },
    async ({ indicator, ticker, chart_timeframe, ma_type, ma_window, benchmark }: any) => {
      try {
        const FEATURES_URL = "http://features-service:8003/features";
        let endpoint = "";
        let body: any = { ticker: ticker.toUpperCase(), chart_timeframe };

        if (indicator === "ma") {
          if (!ma_type || !ma_window) throw new Error("ma_type and ma_window are required for 'ma' indicator.");
          endpoint = `${FEATURES_URL}/ma`;
          body.ma_type = ma_type.toUpperCase();
          body.ma_window = ma_window;
        } else if (indicator === "rs") {
          endpoint = `${FEATURES_URL}/rs`;
          if (benchmark) body.benchmark = benchmark.toUpperCase();
        } else if (indicator === "minervini") {
          endpoint = `${FEATURES_URL}/minervini`;
        }

        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Features API error ${res.status}: ${err}`);
        }

        const data = await res.json();
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── get_options_data ──────────────────────────────────────────
  server.registerTool(
    "get_options_data",
    {
      title: "Get Options Data",
      description: "Retrieve available option chains or live quotes for a specific contract.",
      inputSchema: {
        action: z.enum(["CHAIN", "QUOTE"]).describe("The action to perform"),
        ticker: z.string().describe("Ticker symbol (e.g. AAPL)"),
        expiry: z.string().optional().describe("Expiration date (YYYYMMDD) (for QUOTE)"),
        strike: z.number().optional().describe("Strike price (for QUOTE)"),
        right: z.enum(["C", "P"]).optional().describe("Call (C) or Put (P) (for QUOTE)"),
      },
    },
    async ({ action, ticker, expiry, strike, right }: any) => {
      try {
        if (action === "CHAIN") {
            const res = await fetch(`${PCA_SERVICE_URL}/api/options/chain/${ticker.toUpperCase()}`);
            if (!res.ok) {
              const err = await res.text();
              throw new Error(`Options API error ${res.status}: ${err}`);
            }
            const data = await res.json();
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } else if (action === "QUOTE") {
            if (!expiry || strike === undefined || !right) {
                throw new Error("expiry, strike, and right are required for QUOTE");
            }
            const queryParams = new URLSearchParams({
              expiry,
              strike: strike.toString(),
              right
            });
            const url = `${PCA_SERVICE_URL}/api/options/quote/${ticker.toUpperCase()}?${queryParams.toString()}`;
            const res = await fetch(url);
            if (!res.ok) {
              const err = await res.text();
              throw new Error(`Option Quote API error ${res.status}: ${err}`);
            }
            const data = await res.json();
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
        throw new Error("Invalid action");
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── trigger_feature_calculation ──────────────────────────────
  server.registerTool(
    "request_historical_data",
    {
      title: "Request Historical Data Download",
      description: "Trigger the stock-data-node to download missing historical OHLCV data for a ticker via IBKR.",
      inputSchema: {
        ticker: z.string().describe("Ticker symbol (e.g. PATH)"),
        timeframes: z.array(z.string()).optional().describe("Optional specific timeframes to download, e.g. ['1D', '1W']"),
      },
    },
    async ({ ticker, timeframes }: any) => {
      try {
        const hosts = ["172.17.0.1", "host.docker.internal", "localhost"];
        let lastErr: Error | null = null;
        let successData: any = null;

        for (const host of hosts) {
          try {
            const url = `http://${host}:8002/download`;
            const bodyPayload: any = { ticker: ticker.toUpperCase() };
            if (timeframes) bodyPayload.timeframes = timeframes;

            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(bodyPayload)
            });
            
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`HTTP ${res.status}: ${errText}`);
            }
            successData = await res.json();
            break; // Success
          } catch (e: any) {
            lastErr = e;
          }
        }

        if (!successData) {
            throw new Error(`Could not reach stock-data-node on any host. Last error: ${lastErr?.message}`);
        }

        return { content: [{ type: "text", text: `Successfully enqueued download for ${ticker.toUpperCase()}: ${successData.message}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "trigger_feature_calculation",
    {
      title: "Trigger Feature Calculation",
      description: "Trigger the features service to recalculate technical indicators (MAs, RS Rating, Minervini) for all tickers.",
      inputSchema: {
        stream_telemetry: z.boolean().optional().default(true).describe("If true, streams progress updates via telemetry in real-time."),
      },
    },
    async ({ stream_telemetry }: any) => {
      try {
        const stream = stream_telemetry ?? true;
        const FEATURES_CALCULATE_URL = `http://features-service:8003/features/calculate${stream ? "?stream=true" : ""}`;
        
        const res = await fetch(FEATURES_CALCULATE_URL, {
          method: "POST"
        });
        
        if (!res.ok) {
          if (res.status === 409) {
            return { content: [{ type: "text", text: "Feature calculation is already running." }], isError: true };
          }
          const err = await res.text();
          throw new Error(`Features API error ${res.status}: ${err}`);
        }
        
        if (!stream) {
          const data = await res.json();
          return { content: [{ type: "text", text: `Feature calculation triggered in background. Status: ${data.status || "Unknown"}` }] };
        }
        
        const reader = res.body?.getReader();
        if (!reader) {
          return { content: [{ type: "text", text: "Feature calculation triggered, but log stream is unavailable." }] };
        }
        
        // Notify start
        await sendTelemetry("▶️ Starting feature calculation...");
        
        const decoder = new TextDecoder();
        let buffer = "";
        let finalSummary = "";
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            
            for (const line of lines) {
              const cleanLine = line.trim();
              if (!cleanLine) continue;
              
              if (
                cleanLine.includes("Feature processing:") ||
                cleanLine.includes("Feature calculation finished:") ||
                cleanLine.includes("Skipped") ||
                cleanLine.includes("Calculating features") ||
                cleanLine.includes("Feature Calculation Summary:") ||
                cleanLine.includes("Tickers processed") ||
                cleanLine.includes("Duration")
              ) {
                // Parse out logging format prefix if any, e.g. "18:31:09 | INFO | processor | "
                const match = cleanLine.match(/\|\s*[A-Z]+\s*\|\s*[\w_]+\s*\|\s*(.*)$/);
                const msg = match ? match[1] : cleanLine;
                
                await sendTelemetry(`⚙️ [Feature Service] ${msg}`);
                if (cleanLine.includes("Feature calculation finished:") || cleanLine.includes("Duration")) {
                  finalSummary += `${msg}\n`;
                }
              }
            }
          }
        } catch (err: any) {
          await sendTelemetry(`❌ [Feature Service] Streaming error: ${err.message}`);
          throw err;
        }
        
        await sendTelemetry("✅ Feature calculation completed.");
        return { content: [{ type: "text", text: `Feature calculation completed successfully.\n${finalSummary}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// Helper for watchlist navigation
async function _navigateWatchlist(list_name: string, current_ticker: string, direction: number) {
  try {
    const { data, error } = await supabase
      .from("pca_watchlists")
      .select("ticker")
      .eq("list_name", list_name)
      .order("position");
    if (error) throw error;
    if (!data || data.length === 0) throw new Error(`Watchlist '${list_name}' is empty.`);

    const tickers = data.map((r: any) => r.ticker);
    const idx = tickers.indexOf(current_ticker.toUpperCase());
    const nextIdx = ((idx === -1 ? 0 : idx) + direction + tickers.length) % tickers.length;
    const nextTicker = tickers[nextIdx];

    await pcaCommand("load_ticker", { symbol: nextTicker });
    return { content: [{ type: "text", text: `Chart switched to ${nextTicker} (${nextIdx + 1}/${tickers.length}).` }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}
