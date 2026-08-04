// agent-srm — Senior Risk Manager
// Minimal bootstrapper — all logic lives in core/agent-runtime
import { startAgent } from "./runtime/index";

startAgent("/app/config.yaml").catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
