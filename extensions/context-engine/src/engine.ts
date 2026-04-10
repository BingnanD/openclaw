import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/context-engine";
import type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineMaintenanceResult,
} from "openclaw/plugin-sdk/context-engine";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { extractKeywords, formatContextForPrompt, parseDecayHalfLife } from "./retrieval.js";
import { ContextStore } from "./store.js";

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_RETRIEVAL_TOP_K = 10;
const DEFAULT_DECAY_HALF_LIFE = "7d";
const INGEST_CONTENT_MAX_LENGTH = 4000;

type PluginConfig = {
  storeDir?: string;
  maxEntries?: number;
  retrievalTopK?: number;
  decayHalfLife?: string;
};

function resolveStoreDir(cfg?: OpenClawConfig): string {
  const pluginCfg = cfg?.plugins?.entries?.["context-engine"]?.config as PluginConfig | undefined;
  if (pluginCfg?.storeDir) return pluginCfg.storeDir;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return `${home.replace(/\/$/, "")}/.openclaw/context-store`;
}

function resolvePluginConfig(cfg?: OpenClawConfig): Required<PluginConfig> {
  const pluginCfg = cfg?.plugins?.entries?.["context-engine"]?.config as PluginConfig | undefined;
  return {
    storeDir: pluginCfg?.storeDir ?? resolveStoreDir(cfg),
    maxEntries: pluginCfg?.maxEntries ?? DEFAULT_MAX_ENTRIES,
    retrievalTopK: pluginCfg?.retrievalTopK ?? DEFAULT_RETRIEVAL_TOP_K,
    decayHalfLife: pluginCfg?.decayHalfLife ?? DEFAULT_DECAY_HALF_LIFE,
  };
}

function resolveAgentIdFromSession(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const parts = sessionKey.split(":");
  if (parts.length >= 2 && parts[0] === "agent") {
    return parts[1];
  }
  return undefined;
}

function messageContent(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: "text"; text: string } =>
          !!b && typeof b === "object" && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function shouldIngest(msg: AgentMessage): boolean {
  const role = (msg as { role?: string }).role;
  if (role !== "user" && role !== "assistant") return false;
  const content = messageContent(msg);
  return content.trim().length > 0;
}

export class CrossSessionContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "context-engine",
    name: "Cross-Session Context Engine",
    version: "0.1.0",
  };

  private store: ContextStore | null = null;
  private config: Required<PluginConfig>;
  private bootstrappedSessions = new Set<string>();

  constructor(cfg?: OpenClawConfig) {
    this.config = resolvePluginConfig(cfg);
  }

  private getStore(): ContextStore {
    if (!this.store) {
      this.store = new ContextStore({ storeDir: this.config.storeDir });
    }
    return this.store;
  }

  async bootstrap(params: { sessionId: string; sessionKey?: string; sessionFile: string }) {
    if (this.bootstrappedSessions.has(params.sessionKey ?? params.sessionId)) {
      return { bootstrapped: false, reason: "already bootstrapped" };
    }
    this.bootstrappedSessions.add(params.sessionKey ?? params.sessionId);
    return { bootstrapped: true, reason: "engine ready" };
  }

  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }) {
    if (params.isHeartbeat) return { ingested: false };
    if (!shouldIngest(params.message)) return { ingested: false };

    const agentId = resolveAgentIdFromSession(params.sessionKey);
    if (!agentId) return { ingested: false };

    const content = messageContent(params.message).slice(0, INGEST_CONTENT_MAX_LENGTH);
    const role = (params.message as { role?: string }).role ?? "unknown";

    this.getStore().ingest({
      agentId,
      sessionKey: params.sessionKey ?? params.sessionId,
      role,
      content,
      timestamp: Date.now(),
    });

    // Periodic cleanup
    if (this.getStore().countByAgent(agentId) > this.config.maxEntries * 1.2) {
      this.getStore().cleanup({ agentId, maxEntries: this.config.maxEntries });
    }

    return { ingested: true };
  }

  async ingestBatch(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }) {
    if (params.isHeartbeat) return { ingestedCount: 0 };
    const agentId = resolveAgentIdFromSession(params.sessionKey);
    if (!agentId) return { ingestedCount: 0 };

    const entries = params.messages.filter(shouldIngest).map((msg) => ({
      agentId,
      sessionKey: params.sessionKey ?? params.sessionId,
      role: (msg as { role?: string }).role ?? "unknown",
      content: messageContent(msg).slice(0, INGEST_CONTENT_MAX_LENGTH),
      timestamp: Date.now(),
    }));

    if (entries.length === 0) return { ingestedCount: 0 };
    this.getStore().ingestBatch(entries);
    return { ingestedCount: entries.length };
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    model?: string;
    prompt?: string;
  }) {
    const agentId = resolveAgentIdFromSession(params.sessionKey);
    const currentSessionKey = params.sessionKey ?? params.sessionId;

    let systemPromptAddition: string | undefined;
    if (agentId && params.prompt) {
      const keywords = extractKeywords(params.prompt);
      const halfLifeMs = parseDecayHalfLife(this.config.decayHalfLife);
      const entries = this.getStore().searchByKeywords({
        agentId,
        keywords,
        excludeSessionKey: currentSessionKey,
        limit: this.config.retrievalTopK,
        halfLifeMs,
      });

      if (entries.length > 0) {
        systemPromptAddition = formatContextForPrompt(entries, currentSessionKey);
      }
    }

    // Estimate tokens: ~4 chars per token for the system prompt addition
    const extraTokens = systemPromptAddition ? Math.ceil(systemPromptAddition.length / 4) : 0;

    return {
      messages: params.messages,
      estimatedTokens: extraTokens,
      systemPromptAddition,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
  }) {
    return delegateCompactionToRuntime(params);
  }

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
  }) {
    const agentId = resolveAgentIdFromSession(params.sessionKey);
    if (!agentId) return;

    const newMessages = params.messages.slice(params.prePromptMessageCount);
    const entries = newMessages.filter(shouldIngest).map((msg) => ({
      agentId,
      sessionKey: params.sessionKey ?? params.sessionId,
      role: (msg as { role?: string }).role ?? "unknown",
      content: messageContent(msg).slice(0, INGEST_CONTENT_MAX_LENGTH),
      timestamp: Date.now(),
    }));

    if (entries.length > 0) {
      this.getStore().ingestBatch(entries);
    }

    // Periodic cleanup
    if (this.getStore().countByAgent(agentId) > this.config.maxEntries * 1.2) {
      this.getStore().cleanup({ agentId, maxEntries: this.config.maxEntries });
    }
  }

  async maintain(params: { sessionId: string; sessionKey?: string; sessionFile: string }) {
    const agentId = resolveAgentIdFromSession(params.sessionKey);
    if (agentId) {
      this.getStore().cleanup({ agentId, maxEntries: this.config.maxEntries });
    }
    return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
  }

  async dispose() {
    if (this.store) {
      this.store.close();
      this.store = null;
    }
  }
}
