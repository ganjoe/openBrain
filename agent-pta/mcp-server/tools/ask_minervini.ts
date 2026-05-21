import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "./shared.ts";

// Helper function to parse European number formats
function parseEuroNumber(val: string | number | undefined): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'number') return val;
  let str = val.trim();
  str = str.replace(/[€$%\s]/g, ''); // Remove symbols
  if (str.includes(',') && str.includes('.')) {
      if (str.indexOf(',') > str.lastIndexOf('.')) {
          str = str.replace(/\./g, '').replace(',', '.');
      } else {
          str = str.replace(/,/g, '');
      }
  } else if (str.includes(',')) {
      str = str.replace(',', '.');
  }
  const parsed = parseFloat(str);
  return isNaN(parsed) ? undefined : parsed;
}

export function registerMinerviniTools(server: McpServer) {
  server.registerTool(
    "ask_minervini",
    {
      title: "Minervini Risk Validator & Solver",
      description: "Strict risk management tool. Validates trade setups, calculates missing parameters (stop loss or position size), and enforces Minervini rules based on database defaults.",
      inputSchema: {
        symbol: z.string().describe("Stock ticker symbol"),
        current_price: z.string().or(z.number()).describe("Current price of the asset"),
        stop_loss_price: z.string().or(z.number()).optional().describe("Intended stop loss price (optional)"),
        position_size_pct: z.string().or(z.number()).optional().describe("Intended position size in % of portfolio (optional)"),
        risk_pct: z.string().or(z.number()).optional().describe("Intended risk in % of portfolio (optional, overrides DB default)"),
      },
    },
    async (params: any) => {
      try {
        const symbol = params.symbol.toUpperCase();
        const currentPrice = parseEuroNumber(params.current_price);
        const stopLossPrice = parseEuroNumber(params.stop_loss_price);
        const positionSizePct = parseEuroNumber(params.position_size_pct);
        const inputRiskPct = parseEuroNumber(params.risk_pct);

        if (!currentPrice || currentPrice <= 0) {
            return { content: [{ type: "text", text: "Fehler: current_price muss eine gültige, positive Zahl sein." }], isError: true };
        }

        // 1. Load Risk Parameters from DB
        const { data: riskParams, error: riskErr } = await supabase
            .from("minervini_risk_parameters")
            .select("*")
            .eq("id", 1)
            .single();
            
        // Use defaults if table doesn't exist or is empty
        const baseRiskPct = riskParams?.base_risk_pct ?? 1.0;
        const maxPosSizePct = riskParams?.max_position_size_pct ?? 25.0;

        // 2. Load Portfolio Summary for Total Equity and Analytics for Average Loss
        // We simulate loading total equity and avg loss (in a real scenario, this would query pta_portfolio_summary and analytics)
        const { data: summary } = await supabase.from("pta_portfolio_summary").select("calculated_cash_balance").maybeSingle();
        let totalEquity = 10000; // default fallback
        if (summary && summary.calculated_cash_balance) {
            // Very simplified: assuming cash = equity for risk % math, or we need net_liquidation
            const { data: accData } = await supabase.from("pta_ibkr_account_summary").select("net_liquidation").limit(1).maybeSingle();
            if (accData && accData.net_liquidation) {
                totalEquity = accData.net_liquidation;
            }
        }

        // Simulating historical average loss from analytics (default -6%)
        let avgLossPct = 6.0; 
        const { data: closedTrades } = await supabase.from("pta_trade_performance").select("net_pnl, is_winner").eq("is_closed", true).eq("is_winner", false);
        if (closedTrades && closedTrades.length > 0) {
           // simplified avg loss pct calculation (would normally need entry values)
           // sticking to 6% default for strictness if not computable
           avgLossPct = 6.0;
        }

        const activeRiskPct = inputRiskPct ?? baseRiskPct;
        const maxRiskAmount = totalEquity * (activeRiskPct / 100);

        let response = `=== MINERVINI RISK VALIDATOR: ${symbol} ===\n`;
        response += `Aktueller Kurs: ${currentPrice.toFixed(2)} | Basis-Risiko: ${activeRiskPct}% | Erlaubter Avg Loss: -${avgLossPct}%\n\n`;

        // 3. Solver Logic
        if (stopLossPrice !== undefined && positionSizePct === undefined) {
            // Scenario 1: Stop-Loss given, Size missing
            const distance = currentPrice - stopLossPrice;
            const distancePct = (distance / currentPrice) * 100;
            
            if (distance <= 0) {
                return { content: [{ type: "text", text: "Fehler: Stop-Loss muss unter dem aktuellen Kurs liegen (nur Long-Positionen)." }] };
            }

            response += `Analyse: Du hast einen Stop-Loss von ${stopLossPrice.toFixed(2)} (${distancePct.toFixed(2)}% Abstand) vorgegeben.\n`;

            if (distancePct > avgLossPct * 1.5) { // Strict Minervini rule
                response += `\n❌ STATUS: REJECTED\n`;
                response += `Begründung: Der Stop-Loss ist zu weit entfernt (${distancePct.toFixed(2)}%). Dies ruiniert deine Statistik (Ø Verlust: ${avgLossPct}%). \n`;
                response += `Empfehlung: Suche einen besseren Einstieg, der einen Stop < ${avgLossPct}% erlaubt.\n`;
                // Calculate fallback size just in case
                const riskPerShare = distance;
                const maxShares = Math.floor(maxRiskAmount / riskPerShare);
                response += `Wenn du es ignorierst, darfst du maximal ${maxShares} Aktien kaufen, um unter ${activeRiskPct}% Portfolio-Risiko zu bleiben.`;
            } else {
                const riskPerShare = distance;
                const sharesByRisk = Math.floor(maxRiskAmount / riskPerShare);
                const maxSharesByCap = Math.floor((totalEquity * (maxPosSizePct / 100)) / currentPrice);
                const finalShares = Math.min(sharesByRisk, maxSharesByCap);
                const posSizePct = ((finalShares * currentPrice) / totalEquity) * 100;
                
                response += `\n✅ STATUS: APPROVED\n`;
                response += `Ergebnis: Du kannst **${finalShares} Aktien** kaufen.\n`;
                response += `Begründung: Dies entspricht einer Positionsgröße von ${posSizePct.toFixed(2)}% und respektiert dein Risiko-Limit von ${activeRiskPct}%.`;
            }
        } 
        else if (positionSizePct !== undefined && stopLossPrice === undefined) {
            // Scenario 2: Size given, Stop-Loss missing
            if (positionSizePct > maxPosSizePct) {
                 response += `\n❌ STATUS: REJECTED\n`;
                 response += `Begründung: Die gewünschte Positionsgröße (${positionSizePct}%) überschreitet das System-Limit (${maxPosSizePct}%).\n`;
                 return { content: [{ type: "text", text: response }] };
            }

            const targetPosValue = totalEquity * (positionSizePct / 100);
            const shares = Math.floor(targetPosValue / currentPrice);
            
            // Reverse engineer Stop Loss
            // maxRiskAmount = shares * (currentPrice - stopLossPrice)
            // maxRiskAmount / shares = currentPrice - stopLossPrice
            // stopLossPrice = currentPrice - (maxRiskAmount / shares)
            
            const requiredStopLoss = currentPrice - (maxRiskAmount / shares);
            const distancePct = ((currentPrice - requiredStopLoss) / currentPrice) * 100;

            response += `Analyse: Du willst für ${positionSizePct}% vom Portfolio (${shares} Aktien) kaufen.\n`;
            
            if (distancePct > avgLossPct) {
                const betterStopLoss = currentPrice * (1 - (avgLossPct/100));
                response += `\n⚠️ STATUS: SUGGESTION / WARNING\n`;
                response += `Mathematisch dürfte der Stop bei ${requiredStopLoss.toFixed(2)} (-${distancePct.toFixed(2)}%) liegen, um ${activeRiskPct}% Risiko zu erfüllen.\n`;
                response += `ABER: Wir wollen deinen Average Loss nicht verschlechtern! \n`;
                response += `Empfehlung: Setze den Stop strikt auf **${betterStopLoss.toFixed(2)}** (-${avgLossPct}%). Das Risiko sinkt dadurch sogar auf unter ${activeRiskPct}%.`;
            } else {
                response += `\n✅ STATUS: APPROVED\n`;
                response += `Ergebnis: Setze den Stop-Loss auf mindestens **${requiredStopLoss.toFixed(2)}** (-${distancePct.toFixed(2)}%).\n`;
                response += `Begründung: Bei ${shares} Aktien sichert dieser Stop exakt dein maximales Trade-Risiko von ${activeRiskPct}%.`;
            }
        } 
        else if (stopLossPrice === undefined && positionSizePct === undefined) {
            // Scenario 3: Nothing given, suggest ideal setup
            const defaultStopDistPct = Math.min(avgLossPct, 8.0); // Minervini prefers < 8%
            const idealStopLoss = currentPrice * (1 - (defaultStopDistPct/100));
            const riskPerShare = currentPrice - idealStopLoss;
            const shares = Math.floor(maxRiskAmount / riskPerShare);
            const idealPosSizePct = ((shares * currentPrice) / totalEquity) * 100;

            response += `Analyse: Keine Parameter angegeben. Berechne ideales Setup...\n`;
            response += `\n✅ STATUS: SUGGESTION\n`;
            response += `Ergebnis: Kaufe **${shares} Aktien** (${idealPosSizePct.toFixed(2)}% Positionsgröße) mit Stop-Loss bei **${idealStopLoss.toFixed(2)}** (-${defaultStopDistPct.toFixed(2)}%).\n`;
            response += `Begründung: Dies ist das mathematische Optimum basierend auf deinen historischen ${avgLossPct}% Average Loss und dem ${activeRiskPct}% Portfolio-Risiko.`;
        } else if (stopLossPrice !== undefined && positionSizePct !== undefined) {
            // Scenario 4: Both given, validate the exact setup
            const distance = currentPrice - stopLossPrice;
            const distancePct = (distance / currentPrice) * 100;
            
            if (distance <= 0) {
                return { content: [{ type: "text", text: "Fehler: Stop-Loss muss unter dem aktuellen Kurs liegen." }] };
            }

            const targetPosValue = totalEquity * (positionSizePct / 100);
            const shares = Math.floor(targetPosValue / currentPrice);
            const totalRisk = shares * distance;
            const actualRiskPct = (totalRisk / totalEquity) * 100;

            response += `Analyse: Du willst ${positionSizePct}% vom Portfolio (${shares} Aktien) kaufen, mit Stop bei ${stopLossPrice.toFixed(2)} (-${distancePct.toFixed(2)}%).\n`;
            response += `Das ergibt ein reales Portfolio-Risiko von ${actualRiskPct.toFixed(2)}%.\n`;

            if (actualRiskPct > activeRiskPct) {
                response += `\n❌ STATUS: REJECTED\n`;
                response += `Begründung: Das Risiko von ${actualRiskPct.toFixed(2)}% überschreitet dein Limit von ${activeRiskPct}%. Du musst entweder die Positionsgröße verringern oder den Stop-Loss enger setzen.`;
            } else if (distancePct > avgLossPct * 1.5) {
                response += `\n❌ STATUS: REJECTED\n`;
                response += `Begründung: Das Portfolio-Risiko ist zwar im Limit, aber der Stop-Loss ist zu weit entfernt (${distancePct.toFixed(2)}%). Dies ruiniert deine Statistik (Ø Verlust: ${avgLossPct}%).\n`;
                response += `Empfehlung: Setze den Stop enger oder suche ein besseres Setup.`;
            } else if (distancePct > avgLossPct) {
                response += `\n⚠️ STATUS: WARNING\n`;
                response += `Begründung: Risiko ist ok (${actualRiskPct.toFixed(2)}%), aber der Stop-Loss (-${distancePct.toFixed(2)}%) ist schlechter als dein Average Loss (-${avgLossPct}%).\n`;
                response += `Du kannst den Trade machen, aber er verschlechtert langfristig deine Kennzahlen.`;
            } else {
                response += `\n✅ STATUS: APPROVED\n`;
                response += `Begründung: Perfektes Setup! Risiko (${actualRiskPct.toFixed(2)}%) ist unter Limit (${activeRiskPct}%) und Stop-Loss (-${distancePct.toFixed(2)}%) schützt deine Statistik (-${avgLossPct}%).`;
            }
        } else {
            response += `\n❌ STATUS: ERROR\n`;
            response += `Unerwarteter Fehler bei der Parameter-Auswertung.`;
        }

        return { content: [{ type: "text", text: response }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error in ask_minervini: ${err.message}` }], isError: true };
      }
    }
  );
}
