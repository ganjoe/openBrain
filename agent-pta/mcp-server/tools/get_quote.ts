import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "./shared.ts";

function triggerBulkDownload(ticker: string) {
  fetch("http://localhost:8002/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticker: ticker })
  }).catch(err => console.error(`[Webhook] Failed to notify stock-data-node for ${ticker}:`, err.message));
}

export function registerQuoteTools(server: McpServer) {
  server.registerTool(
    "get_quote",
    {
      title: "Get Live Market Quote (IBKR)",
      description: "Fetches the real-time current price of a stock ticker from Interactive Brokers. Crucial for Minervini calculations.",
      inputSchema: {
        ticker: z.string().describe("Stock ticker symbol (e.g., AAPL)"),
      },
    },
    async (params: any) => {
      try {
        const ticker = params.ticker.toUpperCase();

        // 1. Insert QUOTE_REQUESTED event
        const { data: insertData, error: insertErr } = await supabase
          .from("pta_execution_log")
          .insert({
            trade_id: "QUOTE_FETCH",
            event_type: "QUOTE_REQUESTED",
            ticker: ticker,
            action: "INFO",
            quantity: 0,
            notes: "PENDING",
          })
          .select("id")
          .single();

        if (insertErr || !insertData) {
          return { content: [{ type: "text", text: `Error inserting quote request: ${insertErr?.message}` }], isError: true };
        }

        const requestId = insertData.id;

        // 2. Poll for completion (up to 10 seconds = 20 loops * 500ms)
        let quotePrice: number | null = null;
        for (let i = 0; i < 20; i++) {
          await new Promise(resolve => setTimeout(resolve, 500));

          const { data: checkData, error: checkErr } = await supabase
            .from("pta_execution_log")
            .select("notes, price")
            .eq("id", requestId)
            .single();

          if (checkErr) continue;

          if (checkData && checkData.notes === "COMPLETED" && checkData.price) {
            quotePrice = checkData.price;
            break;
          }
          if (checkData && checkData.notes === "ERROR") {
            break; // Stop polling immediately, IBKR threw an error
          }
        }

        // 3. Clean up the database row
        await supabase.from("pta_execution_log").delete().eq("id", requestId);

        if (quotePrice !== null) {
          triggerBulkDownload(ticker);
          return { content: [{ type: "text", text: `Der aktuelle Live-Kurs für ${ticker} (via IBKR) beträgt: ${quotePrice}` }] };
        } else {
          // Fallback to Yahoo Finance
          try {
             const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`, {
                 headers: {
                     "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
                     "Accept": "application/json"
                 }
             });
             if (res.ok) {
                 const data = await res.json();
                 const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                 if (price) {
                     triggerBulkDownload(ticker);
                     return { content: [{ type: "text", text: `Der aktuelle Kurs für ${ticker} (via Yahoo Finance Fallback) beträgt: ${price}` }] };
                 }
             } else {
                 console.error(`Yahoo Fallback HTTP error: ${res.status} ${res.statusText}`);
             }
          } catch(e) {
             console.error("Yahoo Fallback failed", e);
          }
          return { content: [{ type: "text", text: `Fehler: Konnte keinen Kurs für ${ticker} abrufen (IBKR Timeout & Fallback fehlgeschlagen).` }], isError: true };
        }

      } catch (err: any) {
        return { content: [{ type: "text", text: `Error in get_quote: ${err.message}` }], isError: true };
      }
    }
  );
}
