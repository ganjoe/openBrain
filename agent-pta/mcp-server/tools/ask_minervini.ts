import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "./shared.ts";

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
    "update_minervini_parameters",
    {
      title: "Update Minervini Risk Parameters",
      description: "Update the global Minervini risk parameters in the database.",
      inputSchema: {
        max_core_risk_pct: z.string().or(z.number()).optional().describe("Maximum allowed total portfolio core risk (default 6.0%)"),
        base_risk_pct: z.string().or(z.number()).optional().describe("Default risk per trade (default 1.0%)"),
        max_position_size_pct: z.string().or(z.number()).optional().describe("Max position size pct (default 25.0%)")
      },
    },
    async (params: any) => {
      try {
        const updateData: any = {};
        if (params.max_core_risk_pct !== undefined) updateData.max_core_risk_pct = parseEuroNumber(params.max_core_risk_pct);
        if (params.base_risk_pct !== undefined) updateData.base_risk_pct = parseEuroNumber(params.base_risk_pct);
        if (params.max_position_size_pct !== undefined) updateData.max_position_size_pct = parseEuroNumber(params.max_position_size_pct);

        if (Object.keys(updateData).length === 0) {
            return { content: [{ type: "text", text: "No valid parameters provided to update." }] };
        }

        const { error } = await supabase.from("minervini_risk_parameters").update(updateData).eq("id", 1);
        if (error) {
            return { content: [{ type: "text", text: `Error updating parameters: ${error.message}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Successfully updated Minervini Risk Parameters: ${JSON.stringify(updateData)}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "ask_minervini",
    {
      title: "Minervini Risk Validator & Solver",
      description: "Strict risk management tool. Validates trade setups, calculates missing parameters, and enforces GLOBAL Minervini rules based on pta_live_risk.",
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
        const { data: riskParams } = await supabase.from("minervini_risk_parameters").select("*").eq("id", 1).single();
        const baseRiskPct = riskParams?.base_risk_pct ?? 1.0;
        const maxPosSizePct = riskParams?.max_position_size_pct ?? 25.0;
        const maxCoreRiskPct = riskParams?.max_core_risk_pct ?? 6.0;

        // 2. Load Live Portfolio Risk and Equity
        const { data: riskData } = await supabase.from("pta_live_risk").select("nav_eur, core_risk_pct").limit(1).maybeSingle();
        let totalEquity = 10000;
        let currentCoreRiskPct = 0;
        if (riskData && riskData.nav_eur) {
            totalEquity = riskData.nav_eur;
            currentCoreRiskPct = riskData.core_risk_pct || 0;
        }

        // Simulating historical average loss from analytics (default -6%)
        let avgLossPct = 6.0; 

        const activeRiskPct = inputRiskPct ?? baseRiskPct;
        const maxRiskAmount = totalEquity * (activeRiskPct / 100);
        
        // Calculate the maximum allowed risk percentage for THIS new trade based on the global budget
        const remainingGlobalBudgetPct = Math.max(0, maxCoreRiskPct - currentCoreRiskPct);

        let response = `=== MINERVINI RISK VALIDATOR: ${symbol} ===\n`;
        response += `Aktueller Kurs: ${currentPrice.toFixed(2)} | Basis-Risiko: ${activeRiskPct}% | Erlaubter Avg Loss: -${avgLossPct}%\n`;
        response += `Global Core Risk Budget: ${currentCoreRiskPct.toFixed(2)}% / ${maxCoreRiskPct.toFixed(2)}% (Verbleibend: ${remainingGlobalBudgetPct.toFixed(2)}%)\n\n`;

        // 3. Solver Logic
        if (stopLossPrice !== undefined && positionSizePct === undefined) {
            const distance = currentPrice - stopLossPrice;
            const distancePct = (distance / currentPrice) * 100;
            
            if (distance <= 0) return { content: [{ type: "text", text: "Fehler: Stop-Loss muss unter dem aktuellen Kurs liegen." }] };

            response += `Analyse: Du hast einen Stop-Loss von ${stopLossPrice.toFixed(2)} (${distancePct.toFixed(2)}% Abstand) vorgegeben.\n`;

            const riskPerShare = distance;
            const sharesByRisk = Math.floor(maxRiskAmount / riskPerShare);
            const sharesByBudget = Math.floor((totalEquity * (remainingGlobalBudgetPct / 100)) / riskPerShare);
            const maxSharesByCap = Math.floor((totalEquity * (maxPosSizePct / 100)) / currentPrice);
            
            const finalShares = Math.max(0, Math.min(sharesByRisk, maxSharesByCap, sharesByBudget));
            const posSizePct = ((finalShares * currentPrice) / totalEquity) * 100;
            const newTradeRiskPct = ((finalShares * riskPerShare) / totalEquity) * 100;

            if (distancePct > avgLossPct * 1.5) { 
                response += `\n⚠️ STATUS: WARNING\nAnmerkung: Stop-Loss zu weit (${distancePct.toFixed(2)}%). Erhöht das Core Risk um ${newTradeRiskPct.toFixed(2)}%.\n`;
            } else if (remainingGlobalBudgetPct <= 0) {
                response += `\n⚠️ STATUS: WARNING\nAnmerkung: Das globale Core Risk Limit (${maxCoreRiskPct}%) ist bereits erreicht oder überschritten. Erhöht das Core Risk um ${newTradeRiskPct.toFixed(2)}%.\n`;
            } else if (finalShares === 0) {
                 response += `\n⚠️ STATUS: WARNING\nAnmerkung: Das verbleibende Budget (${remainingGlobalBudgetPct.toFixed(2)}%) erlaubt bei diesem Stop-Loss keine ganze Aktie.\n`;
            } else {
                response += `\n✅ STATUS: APPROVED\nErgebnis: Du kannst **${finalShares} Aktien** kaufen.\n`;
                response += `Begründung: Entspricht ${posSizePct.toFixed(2)}% Positionsgröße. Erhöht das Core Risk um ${newTradeRiskPct.toFixed(2)}% (Neues Total: ${(currentCoreRiskPct + newTradeRiskPct).toFixed(2)}%).`;
                if (sharesByBudget < sharesByRisk && sharesByBudget < maxSharesByCap) {
                    response += `\nℹ️ Hinweis: Die Stückzahl wurde durch das globale Risikobudget gedeckelt.`;
                }
            }
        } 
        else if (positionSizePct !== undefined && stopLossPrice === undefined) {
            if (positionSizePct > maxPosSizePct) {
                 response += `\n⚠️ STATUS: WARNING\nAnmerkung: Gewünschte Positionsgröße (${positionSizePct}%) überschreitet das Limit (${maxPosSizePct}%).\n`;
            }

            const targetPosValue = totalEquity * (positionSizePct / 100);
            const shares = Math.floor(targetPosValue / currentPrice);
            
            // Limit the max risk amount to the smaller of: individual rule OR remaining global budget
            const effectiveMaxRiskAmount = Math.min(maxRiskAmount, totalEquity * (remainingGlobalBudgetPct / 100));
            
            if (effectiveMaxRiskAmount <= 0) {
                response += `\n⚠️ STATUS: WARNING\nAnmerkung: Kein globales Risikobudget mehr vorhanden (${currentCoreRiskPct.toFixed(2)}% >= ${maxCoreRiskPct}%).\n`;
            }

            const requiredStopLoss = currentPrice - (effectiveMaxRiskAmount / shares);
            const distancePct = ((currentPrice - requiredStopLoss) / currentPrice) * 100;

            response += `Analyse: Du willst für ${positionSizePct}% vom Portfolio (${shares} Aktien) kaufen.\n`;
            
            if (distancePct > avgLossPct) {
                const betterStopLoss = currentPrice * (1 - (avgLossPct/100));
                response += `\n⚠️ STATUS: SUGGESTION / WARNING\n`;
                response += `Mathematisch dürfte der Stop bei ${requiredStopLoss.toFixed(2)} (-${distancePct.toFixed(2)}%) liegen.\n`;
                response += `Empfehlung: Setze den Stop strikt auf **${betterStopLoss.toFixed(2)}** (-${avgLossPct}%).`;
            } else {
                response += `\n✅ STATUS: APPROVED\nErgebnis: Setze den Stop-Loss auf mindestens **${requiredStopLoss.toFixed(2)}** (-${distancePct.toFixed(2)}%).\n`;
                if (effectiveMaxRiskAmount < maxRiskAmount) {
                    response += `ℹ️ Hinweis: Der Stop-Loss wurde durch das verbleibende globale Risikobudget enger berechnet!`;
                }
            }
        } 
        else if (stopLossPrice === undefined && positionSizePct === undefined) {
            const defaultStopDistPct = Math.min(avgLossPct, 8.0);
            const idealStopLoss = currentPrice * (1 - (defaultStopDistPct/100));
            const riskPerShare = currentPrice - idealStopLoss;
            
            // Limit shares by whichever risk bucket is smaller
            const effectiveMaxRiskAmount = Math.min(maxRiskAmount, totalEquity * (remainingGlobalBudgetPct / 100));
            
            if (effectiveMaxRiskAmount <= 0) {
                 response += `\n⚠️ STATUS: WARNING\nAnmerkung: Kein globales Risikobudget mehr vorhanden.\n`;
            }

            const shares = Math.floor(effectiveMaxRiskAmount / riskPerShare);
            const idealPosSizePct = ((shares * currentPrice) / totalEquity) * 100;

            response += `Analyse: Keine Parameter angegeben. Berechne ideales Setup...\n`;
            
            if (shares === 0) {
                 response += `\n⚠️ STATUS: WARNING\nAnmerkung: Verbleibendes Risiko reicht nicht mal für 1 Aktie bei optimalem Stop-Loss.\n`;
            } else {
                 response += `\n✅ STATUS: SUGGESTION\nErgebnis: Kaufe **${shares} Aktien** (${idealPosSizePct.toFixed(2)}%) mit Stop bei **${idealStopLoss.toFixed(2)}** (-${defaultStopDistPct.toFixed(2)}%).\n`;
                 if (effectiveMaxRiskAmount < maxRiskAmount) {
                     response += `ℹ️ Hinweis: Stückzahl wurde durch das globale Risikobudget reduziert.`;
                 }
            }
        } else if (stopLossPrice !== undefined && positionSizePct !== undefined) {
            const distance = currentPrice - stopLossPrice;
            const distancePct = (distance / currentPrice) * 100;
            
            if (distance <= 0) return { content: [{ type: "text", text: "Fehler: Stop-Loss muss unter Kurs liegen." }] };

            const targetPosValue = totalEquity * (positionSizePct / 100);
            const shares = Math.floor(targetPosValue / currentPrice);
            const totalRisk = shares * distance;
            const actualRiskPct = (totalRisk / totalEquity) * 100;

            response += `Analyse: ${positionSizePct}% Portfolio (${shares} Aktien), Stop bei ${stopLossPrice.toFixed(2)} (-${distancePct.toFixed(2)}%).\n`;
            response += `Das ergibt ein reales Risiko von ${actualRiskPct.toFixed(2)}% für diesen Trade.\n`;

            if (currentCoreRiskPct + actualRiskPct > maxCoreRiskPct) {
                response += `\n⚠️ STATUS: WARNING\nAnmerkung: Budget überschritten! Neues Core Risk wäre ${(currentCoreRiskPct + actualRiskPct).toFixed(2)}% (Max: ${maxCoreRiskPct}%).`;
            } else if (actualRiskPct > activeRiskPct) {
                response += `\n⚠️ STATUS: WARNING\nAnmerkung: Trade-Risiko (${actualRiskPct.toFixed(2)}%) über Basis-Limit (${activeRiskPct}%).`;
            } else if (distancePct > avgLossPct * 1.5) {
                response += `\n⚠️ STATUS: WARNING\nAnmerkung: Stop-Loss zu weit entfernt (${distancePct.toFixed(2)}%).`;
            } else if (distancePct > avgLossPct) {
                response += `\n⚠️ STATUS: WARNING\nTrade ok, aber Stop (-${distancePct.toFixed(2)}%) schlechter als Avg Loss (-${avgLossPct}%).`;
            } else {
                response += `\n✅ STATUS: APPROVED\nPerfektes Setup! (Neues Core Risk: ${(currentCoreRiskPct + actualRiskPct).toFixed(2)}%)`;
            }
        } else {
            response += `\n❌ STATUS: ERROR\nUnerwarteter Fehler bei der Parameter-Auswertung.`;
        }

        return { content: [{ type: "text", text: response }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error in ask_minervini: ${err.message}` }], isError: true };
      }
    }
  );
}
