import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "./shared.ts";

export function registerPyramidTools(server: McpServer) {
  server.registerTool(
    "calculate_risk_free_pyramid",
    {
      title: "Calculate Risk-Free Pyramid",
      description: "Calculates how many shares can be bought risk-free by raising the stop loss on an existing position.",
      inputSchema: {
        ticker: z.string().describe("Stock ticker symbol"),
        new_stop_loss: z.number().describe("The new, higher stop loss price"),
        commission: z.number().optional().default(2.0).describe("Estimated total commission for the new buy and eventual sell (default: 2.0)"),
      },
    },
    async (params: any) => {
      try {
        const ticker = params.ticker.toUpperCase();
        const newStopLoss = params.new_stop_loss;
        const commission = params.commission;

        // 1. Trigger live position refresh from IBKR by logging a REFRESH_REQUESTED event
        // This ensures we have the latest market price and orders
        const { data: refreshData, error: insertErr } = await supabase.from("pta_execution_log").insert({
          trade_id: "SYSTEM",
          ticker: "SYSTEM",
          event_type: "REFRESH_REQUESTED",
          action: "REFRESH",
          quantity: 0,
          price: 0
        }).select("id").single();

        if (insertErr || !refreshData) throw new Error("Failed to create REFRESH_REQUESTED event");
        const refreshId = refreshData.id;

        // Poll up to 10 seconds for the sync to complete (notes == 'COMPLETED')
        let attempts = 0;
        while (attempts < 20) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const { data: checkData } = await supabase
                .from("pta_execution_log")
                .select("notes")
                .eq("id", refreshId)
                .single();
            if (checkData && checkData.notes === "COMPLETED") {
                break;
            }
            attempts++;
        }
        await supabase.from("pta_execution_log").delete().eq("id", refreshId);

        // 2. Fetch live IBKR position
        const { data: positionData, error: posError } = await supabase
            .from("pta_ibkr_positions")
            .select("*")
            .eq("ticker", ticker)
            .single();

        if (posError || !positionData) {
            return { content: [{ type: "text", text: `Fehler: Keine aktive Position für ${ticker} bei IBKR gefunden.` }], isError: true };
        }

        const quantity = positionData.quantity;
        const avgCost = positionData.avg_cost;
        const currentPrice = positionData.market_price;

        if (quantity <= 0) {
            return { content: [{ type: "text", text: `Fehler: Du bist Short oder flach bei ${ticker}. Pyramiding-Logik aktuell nur für Long-Positionen.` }], isError: true };
        }

        if (newStopLoss <= avgCost) {
            return { content: [{ type: "text", text: `Warnung: Der neue Stop-Loss (${newStopLoss}) liegt unter oder auf deinem Einstiegskurs (${avgCost}). Für einen "Risk-Free" Nachkauf muss der Stop-Loss im Gewinn liegen.` }] };
        }

        if (newStopLoss >= currentPrice) {
            return { content: [{ type: "text", text: `Fehler: Der neue Stop-Loss (${newStopLoss}) liegt über oder auf dem aktuellen Kurs (${currentPrice}).` }], isError: true };
        }

        // 3. Fetch open orders to determine stop type
        const { data: ordersData, error: ordError } = await supabase
            .from("pta_ibkr_open_orders")
            .select("*")
            .eq("ticker", ticker);

        let stopOrderType = "STP"; // Default to Stop Market
        let existingOrdersText = "Keine Stop-Order gefunden. Neu anzulegende Order sollte STP sein.";

        if (!ordError && ordersData && ordersData.length > 0) {
            const stopOrders = ordersData.filter(o => o.order_type.includes("STP") || o.action === "SELL");
            if (stopOrders.length > 0) {
                const existingStop = stopOrders[0];
                stopOrderType = existingStop.order_type; // e.g. "STP LMT" or "STP"
                const limitStr = existingStop.limit_price ? ` LMT ${existingStop.limit_price}` : "";
                const stopStr = existingStop.stop_price ? ` STP ${existingStop.stop_price}` : "";
                existingOrdersText = `Gefundene alte Order: ${existingStop.action} ${existingStop.quantity} ${existingStop.order_type}${stopStr}${limitStr} (Status: ${existingStop.status}).\nDie Präferenz für die NEUE Order ist daher: **${stopOrderType}**.`;
            }
        }

        // 4. Calculate Math
        const lockedProfit = quantity * (newStopLoss - avgCost);
        const availableProfit = lockedProfit - commission; 
        const riskPerNewShare = currentPrice - newStopLoss;
        
        let sharesToBuy = 0;
        if (riskPerNewShare > 0) {
            sharesToBuy = Math.floor(availableProfit / riskPerNewShare);
        }

        let response = `=== RISK-FREE PYRAMID ANALYSIS: ${ticker} ===\n\n`;
        response += `**1. Live Status & Order-Prüfung**\n`;
        response += `- Bestand: ${quantity} Aktien\n`;
        response += `- Einstieg (Avg Cost): ${avgCost.toFixed(2)}\n`;
        response += `- Aktueller Kurs: ${currentPrice.toFixed(2)}\n`;
        response += `- Order-Status: ${existingOrdersText}\n\n`;

        response += `**2. Dein gesicherter Gewinn**\n`;
        response += `- Eingeloggter Gewinn der alten Tranche: ${quantity} × (${newStopLoss.toFixed(2)} - ${avgCost.toFixed(2)}) = +${lockedProfit.toFixed(2)}\n`;
        response += `- Abzug geplante Kommission (Kauf/Verkauf): -${commission.toFixed(2)}\n`;
        response += `- Verfügbares Risiko-Kapital: **${availableProfit.toFixed(2)}**\n\n`;

        response += `**3. Risiko der neuen Aktien**\n`;
        response += `- Risiko pro neuer Aktie: ${currentPrice.toFixed(2)} - ${newStopLoss.toFixed(2)} = ${riskPerNewShare.toFixed(2)}\n\n`;

        if (sharesToBuy <= 0) {
            response += `**Fazit:**\n`;
            response += `Du kannst **0 Aktien** risikofrei zukaufen. Der gesicherte Gewinn (nach Kommission) reicht nicht aus, um das Risiko einer einzigen neuen Aktie bei diesem Stop-Abstand zu decken.\n`;
        } else {
            const newTotalShares = quantity + sharesToBuy;
            const newCostBasis = (quantity * avgCost) + (sharesToBuy * currentPrice);
            const newAvgCost = newCostBasis / newTotalShares;
            
            const totalValueAtStop = newTotalShares * newStopLoss;
            const absoluteRisk = totalValueAtStop - newCostBasis - commission;

            response += `**4. Möglicher Zukauf & Break-Even**\n`;
            response += `- ${availableProfit.toFixed(2)} ÷ ${riskPerNewShare.toFixed(2)} = ${Math.floor(availableProfit / riskPerNewShare)} Aktien\n\n`;

            response += `**FAZIT & ERGEBNIS:**\n`;
            response += `Du kannst **${sharesToBuy} Aktien** von ${ticker} risikofrei zukaufen!\n\n`;
            
            response += `Wenn du das tust, sieht deine Position so aus:\n`;
            response += `- **Gesamtbestand:** ${newTotalShares} Aktien\n`;
            response += `- **Neuer Break-Even (Avg Cost):** ${newAvgCost.toFixed(2)}\n`;
            response += `- **Dein absolutes Rest-Risiko:** Wenn du bei ${newStopLoss.toFixed(2)} ausgestoppt wirst, machst du insgesamt einen PnL von **${absoluteRisk.toFixed(2)}**. Das ist ein astreiner Free-Trade!\n\n`;

            response += `**Aktion für den PTA:**\n`;
            response += `1. Führe 'trade' UPDATE für den Alt-Bestand aus (Stop auf ${newStopLoss.toFixed(2)}).\n`;
            response += `2. Erinnere den Boss daran, die alte IBKR-Order manuell anzupassen, falls nötig.\n`;
            response += `3. Kaufe ${sharesToBuy} Aktien Market und nutze als Stop-Typ **${stopOrderType}** bei ${newStopLoss.toFixed(2)}.\n`;
        }

        return { content: [{ type: "text", text: response }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error calculating pyramid: ${err.message}` }], isError: true };
      }
    }
  );
}
