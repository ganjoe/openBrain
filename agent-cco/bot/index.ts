// agent-cco — Chief Communications Officer
// Bootstrapper with task continuation hook for background sync results
import { startAgent } from "./runtime/index";
import type { AgentHooks, AgentTask, ReactContext } from "./runtime/index";

const hooks: AgentHooks = {
  onTaskCompleted: async (task: AgentTask, ctx: ReactContext) => {
    // Inject the original user request and task result into the LLM context
    // so the CCO can continue fulfilling the request after a background sync.
    const author = task.context?.author || "unknown";
    const limit  = task.context?.limit || 100;
    const newPosts = task.result?.new_posts ?? "?";

    ctx.messages.push({
      role: "system",
      content:
        `TASK_CONTINUATION:\n` +
        `Ein Hintergrund-Task ist abgeschlossen. Führe jetzt den ursprünglichen Auftrag aus.\n\n` +
        `- task_id: ${task.id}\n` +
        `- task_type: ${task.task_type}\n` +
        `- original_request: ${task.original_request}\n` +
        `- author: ${author}\n` +
        `- new_posts_saved: ${newPosts}\n` +
        `- requested_limit: ${limit}\n\n` +
        `Verwende deine Such-Tools (z.B. search_influencer_posts) um die Posts von ${author} aus der Datenbank abzurufen ` +
        `und den ursprünglichen Auftrag vollständig zu erfüllen. Schreibe das Ergebnis an 'boss'.`,
    });
  },
};

startAgent("/app/config.yaml", hooks).catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
