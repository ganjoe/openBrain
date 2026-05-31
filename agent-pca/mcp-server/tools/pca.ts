import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, pcaCommand, PCA_SERVICE_URL } from "./shared.ts";

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

  // ── save_layout ──────────────────────────────────────────────
  server.registerTool(
    "save_layout",
    {
      title: "Save Layout",
      description: "Create or update a chart layout configuration in the database.",
      inputSchema: {
        name: z.string().describe("Layout name, e.g. 'mobile'"),
        description: z.string().optional().describe("Short description"),
        config: z.string().describe("Layout config as a JSON string"),
        is_default: z.boolean().optional().default(false),
      },
    },
    async ({ name, description, config, is_default }: any) => {
      try {
        let parsedConfig: any;
        try {
          parsedConfig = JSON.parse(config);
        } catch {
          return { content: [{ type: "text", text: "Error: config is not valid JSON." }], isError: true };
        }
        const { error } = await supabase
          .from("pca_layouts")
          .upsert(
            { name, description: description ?? "", config: parsedConfig, is_default: is_default ?? false },
            { onConflict: "name" }
          );
        if (error) throw error;
        return { content: [{ type: "text", text: `Layout '${name}' saved successfully.` }] };
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
