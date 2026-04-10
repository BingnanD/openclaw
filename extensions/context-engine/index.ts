import { registerContextEngine } from "openclaw/plugin-sdk/context-engine";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { CrossSessionContextEngine } from "./src/engine.js";

export { CrossSessionContextEngine } from "./src/engine.js";
export { ContextStore } from "./src/store.js";
export { extractKeywords, formatContextForPrompt } from "./src/retrieval.js";

export default definePluginEntry({
  id: "context-engine",
  name: "Cross-Session Context Engine",
  description:
    "Unified context storage and retrieval across agent sessions. " +
    "Ingests messages into a shared JSONL store and retrieves relevant " +
    "cross-session context during model assembly.",
  kind: "context-engine",
  register(api) {
    registerContextEngine("context-engine", () => new CrossSessionContextEngine(api.config));
  },
});
