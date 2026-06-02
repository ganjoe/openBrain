import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, pcaCommand, PCA_SERVICE_URL, sendTelemetry } from "./shared.ts";


export function registerPcaTools(server: McpServer) {

  // ── open_layout ─────────────────────────────────────────────
  server.registerTool(
    "open_layout",
    {
      title: "Open Chart Layout",
      description: "Open a named layout in the browser. Instructs the master tab to spawn chart windows. Example: 'desktop'.",
      inputSchema: {
        layout: z.string().describe("Layout name, e.g. 'desktop'"),
      },
    },
    async ({ layout }: any) => {
      try {
        const result = await pcaCommand("open_layout", { layout });
        return { content: [{ type: "text", text: `Layout '${layout}' opened. ${result}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── load_ticker ─────────────────────────────────────────────
  server.registerTool(
    "load_ticker",
    {
      title: "Load Ticker in Chart",
      description: "Display a specific ticker symbol in all open chart windows.",
      inputSchema: {
        symbol: z.string().describe("Ticker symbol, e.g. 'AAPL' or 'NVDA'"),
      },
    },
    async ({ symbol }: any) => {
      try {
        const result = await pcaCommand("load_ticker", { symbol: symbol.toUpperCase() });
        return { content: [{ type: "text", text: `Ticker ${symbol.toUpperCase()} loaded. ${result}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── list_watchlists ──────────────────────────────────────────
  server.registerTool(
    "list_watchlists",
    {
      title: "List Watchlists",
      description: "Show all available watchlist names and their tickers.",
      inputSchema: {
        list_name: z.string().optional().describe("Optional: name of a specific watchlist to inspect"),
      },
    },
    async ({ list_name }: any) => {
      try {
        if (list_name) {
          const { data, error } = await supabase
            .from("pca_watchlists")
            .select("ticker, position")
            .eq("list_name", list_name)
            .order("position");
          if (error) throw error;
          const tickers = data.map((r: any) => r.ticker).join(", ");
          return { content: [{ type: "text", text: `Watchlist '${list_name}': ${tickers}` }] };
        } else {
          const { data, error } = await supabase
            .from("pca_watchlists")
            .select("list_name")
            .order("list_name");
          if (error) throw error;
          const names = [...new Set(data.map((r: any) => r.list_name))].join(", ");
          return { content: [{ type: "text", text: `Available watchlists: ${names}` }] };
        }
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── load_watchlist ───────────────────────────────────────────
  server.registerTool(
    "load_watchlist",
    {
      title: "Load Watchlist in Browser",
      description:
        "Display a named watchlist in all open watchlist windows AND persist the selection " +
        "in the layout so it survives a tab refresh. Use this whenever the user wants to switch " +
        "which watchlist is shown in the watchlist panel.",
      inputSchema: {
        list_name:   z.string().describe("Name of the watchlist, e.g. 'growth_stocks' or 'ipo_stocks'"),
        layout_name: z.string().optional().default("desktop")
                      .describe("Layout to update (default: 'desktop')"),
      },
    },
    async ({ list_name, layout_name }: any) => {
      try {
        const result = await pcaCommand("load_watchlist", {
          list_name,
          layout_name: layout_name ?? "desktop",
        });
        return { content: [{ type: "text", text: `Watchlist '${list_name}' loaded and persisted in layout. ${result}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── add_to_watchlist ─────────────────────────────────────────
  server.registerTool(
    "add_to_watchlist",
    {
      title: "Add Ticker to Watchlist",
      description: "Add a ticker symbol to a named watchlist.",
      inputSchema: {
        list_name: z.string().describe("Watchlist name, e.g. 'growth_stocks'"),
        ticker: z.string().describe("Ticker symbol to add"),
        position: z.number().optional().default(999).describe("Position in the list (default: append)"),
      },
    },
    async ({ list_name, ticker, position }: any) => {
      try {
        const { error } = await supabase
          .from("pca_watchlists")
          .insert({ list_name, ticker: ticker.toUpperCase(), position: position ?? 999 });
        if (error) throw error;
        return { content: [{ type: "text", text: `${ticker.toUpperCase()} added to '${list_name}'.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── remove_from_watchlist ────────────────────────────────────
  server.registerTool(
    "remove_from_watchlist",
    {
      title: "Remove Ticker from Watchlist",
      description: "Remove a ticker symbol from a named watchlist.",
      inputSchema: {
        list_name: z.string().describe("Watchlist name"),
        ticker: z.string().describe("Ticker symbol to remove"),
      },
    },
    async ({ list_name, ticker }: any) => {
      try {
        const { error } = await supabase
          .from("pca_watchlists")
          .delete()
          .eq("list_name", list_name)
          .eq("ticker", ticker.toUpperCase());
        if (error) throw error;
        return { content: [{ type: "text", text: `${ticker.toUpperCase()} removed from '${list_name}'.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── list_layouts ─────────────────────────────────────────────
  server.registerTool(
    "list_layouts",
    {
      title: "List Layouts",
      description: "Show all saved chart layouts with their descriptions.",
      inputSchema: {},
    },
    async () => {
      try {
        const { data, error } = await supabase
          .from("pca_layouts")
          .select("name, description, is_default")
          .order("name");
        if (error) throw error;
        const lines = data.map((l: any) =>
          `• ${l.name}${l.is_default ? " [default]" : ""}: ${l.description ?? "—"}`
        );
        return { content: [{ type: "text", text: lines.join("\n") || "No layouts found." }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
  // ── next_ticker / prev_ticker ────────────────────────────────
  server.registerTool(
    "next_ticker",
    {
      title: "Next Ticker in Watchlist",
      description: "Advance to the next ticker in a watchlist and display it in all chart windows.",
      inputSchema: {
        list_name: z.string().default("growth_stocks").describe("Watchlist name"),
        current_ticker: z.string().describe("The currently displayed ticker"),
      },
    },
    async ({ list_name, current_ticker }: any) => {
      return _navigateWatchlist(list_name, current_ticker, 1);
    }
  );

  server.registerTool(
    "prev_ticker",
    {
      title: "Previous Ticker in Watchlist",
      description: "Go back to the previous ticker in a watchlist and display it in all chart windows.",
      inputSchema: {
        list_name: z.string().default("growth_stocks").describe("Watchlist name"),
        current_ticker: z.string().describe("The currently displayed ticker"),
      },
    },
    async ({ list_name, current_ticker }: any) => {
      return _navigateWatchlist(list_name, current_ticker, -1);
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

  // ── get_option_chains ─────────────────────────────────────────
  server.registerTool(
    "get_option_chains",
    {
      title: "Get Option Chains",
      description: "Retrieve available option expirations and strikes for a given ticker from IB Broker.",
      inputSchema: {
        ticker: z.string().describe("Ticker symbol (e.g. AAPL)"),
      },
    },
    async ({ ticker }: any) => {
      try {
        const res = await fetch(`${PCA_SERVICE_URL}/api/options/chain/${ticker.toUpperCase()}`);
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Options API error ${res.status}: ${err}`);
        }
        const data = await res.json();
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
