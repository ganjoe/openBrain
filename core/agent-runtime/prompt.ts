// core/agent-runtime/prompt.ts
// Hot-reloading system prompt from disk

import * as fs from "fs";

let SYSTEM_PROMPT = "";
let promptMtimeMs = 0;
const PROMPT_PATH = process.env.PROMPT_PATH || "/app/prompt.txt";

/**
 * Load the system prompt from disk, cached by mtime. Called on every LLM
 * invocation so editing prompt.txt on the host (and waiting at most one ReAct
 * loop) is enough to take effect — no container restart required.
 */
export function loadSystemPrompt(agentName: string): string {
  try {
    const stat = fs.statSync(PROMPT_PATH);
    if (stat.mtimeMs !== promptMtimeMs) {
      const fresh = fs.readFileSync(PROMPT_PATH, "utf-8");
      if (fresh.length > 0) {
        SYSTEM_PROMPT = fresh;
        promptMtimeMs = stat.mtimeMs;
        console.log(
          `[prompt] Reloaded ${PROMPT_PATH} (${SYSTEM_PROMPT.length} chars, ` +
            `mtime=${new Date(promptMtimeMs).toISOString()})`,
        );
      }
    }
  } catch (err: any) {
    if (!SYSTEM_PROMPT || SYSTEM_PROMPT.startsWith("Du bist ")) {
      SYSTEM_PROMPT = `Du bist ${agentName}. Bitte mounte eine prompt.txt.`;
    }
    // First boot without a prompt: warn once, then stay silent.
    if (promptMtimeMs === 0) {
      console.warn(`⚠️  No prompt.txt at ${PROMPT_PATH} — using fallback.`);
    }
  }
  return SYSTEM_PROMPT;
}
