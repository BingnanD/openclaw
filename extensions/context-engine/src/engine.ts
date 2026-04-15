import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/context-engine";
import type { ContextEngine, ContextEngineInfo } from "openclaw/plugin-sdk/context-engine";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { formatSessionContextForPrompt, parseDecayHalfLife, filterAndScore } from "./retrieval.js";
import { discoverSessions, readRecentMessages } from "./session-reader.js";

const DEFAULT_DECAY_HALF_LIFE = "7d";
const DEFAULT_MAX_MESSAGES_PER_SESSION = 10;
const DEFAULT_MAX_TOTAL_MESSAGES = 15;

type PluginConfig = {
  decayHalfLife?: string;
  maxMessagesPerSession?: number;
  maxTotalMessages?: number;
};

function resolvePluginConfig(cfg?: OpenClawConfig): Required<PluginConfig> {
  const pluginCfg = cfg?.plugins?.entries?.["context-engine"]?.config as PluginConfig | undefined;
  return {
    decayHalfLife: pluginCfg?.decayHalfLife ?? DEFAULT_DECAY_HALF_LIFE,
    maxMessagesPerSession: pluginCfg?.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES_PER_SESSION,
    maxTotalMessages: pluginCfg?.maxTotalMessages ?? DEFAULT_MAX_TOTAL_MESSAGES,
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

// ---------------------------------------------------------------------------
// Context Engine
// ---------------------------------------------------------------------------

export class CrossSessionContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "context-engine",
    name: "Cross-Session Context Engine",
    version: "0.4.0",
  };

  private config: Required<PluginConfig>;
  private bootstrappedSessions = new Set<string>();

  constructor(cfg?: OpenClawConfig) {
    this.config = resolvePluginConfig(cfg);
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
    return { ingested: false };
  }

  async ingestBatch(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }) {
    return { ingestedCount: 0 };
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

    if (!agentId || !params.prompt) {
      return { messages: params.messages, estimatedTokens: 0 };
    }

    const halfLifeMs = parseDecayHalfLife(this.config.decayHalfLife);
    const maxPerSession = this.config.maxMessagesPerSession;
    const maxTotal = this.config.maxTotalMessages;

    // Discover all active sessions for this agent
    const sessions = discoverSessions(agentId);

    // Read recent messages from each session (exclude current)
    const allMessages = [];
    for (const session of sessions) {
      if (session.id === params.sessionId) continue;
      const recent = readRecentMessages(session.file, session.id, maxPerSession);
      allMessages.push(...recent);
    }

    // Filter by keyword relevance and score by time decay
    const relevant = filterAndScore(allMessages, params.prompt, halfLifeMs, maxTotal);

    if (relevant.length === 0) {
      return { messages: params.messages, estimatedTokens: 0 };
    }

    const contextText = formatSessionContextForPrompt(relevant, params.sessionKey);

    return {
      messages: params.messages,
      estimatedTokens: Math.ceil(contextText.length / 4),
      _promptPrefix: `[以下是你之前在其他会话中的对话内容，请用来回答问题]\n\n${contextText}`,
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
    // No-op: context is read directly from session files at assemble time.
  }

  async maintain(params: { sessionId: string; sessionKey?: string; sessionFile: string }) {
    return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
  }

  async dispose() {
    // No resources to dispose.
  }
}
