export type { ContextEngineFactory } from "../context-engine/registry.js";
export type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineMaintenanceResult,
} from "../context-engine/types.js";
export { registerContextEngine } from "../context-engine/registry.js";
export { delegateCompactionToRuntime } from "../context-engine/delegate.js";
