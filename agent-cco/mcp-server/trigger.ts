import { runBackgroundSync, runLlmCategorizationLoop } from "./tools/x.ts";

async function main() {
  console.log("Triggering background sync for serenity...");
  const controller = new AbortController();
  await runBackgroundSync("@serenity", "serenity", 100, undefined, controller.signal);
  console.log("Sync complete. Starting categorization loop...");
  await runLlmCategorizationLoop();
  console.log("Categorization complete.");
}

main().catch(console.error);
