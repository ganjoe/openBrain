// agent-cda — Chief Data Architect
// Minimal bootstrapper — stock-data/events is handled generically
// via config.yaml mqtt.extra_subscriptions with handler: "telemetry_forward"
import { startAgent } from "./runtime/index";

startAgent("/app/config.yaml").catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
