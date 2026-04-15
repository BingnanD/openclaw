import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/context-engine";
import type { ContextEngine, ContextEngineInfo } from "openclaw/plugin-sdk/context-engine";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  formatContextForPrompt,
  formatSessionContextForPrompt,
  parseDecayHalfLife,
  extractKeywords,
  filterAndScore,
} from "./retrieval.js";
import { discoverSessions, readRecentMessages } from "./session-reader.js";
import type { FactEntry, FactInsert } from "./store.js";
import { FactStore } from "./store.js";

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_RETRIEVAL_TOP_K = 10;
const DEFAULT_DECAY_HALF_LIFE = "7d";
const DEFAULT_MAX_MESSAGES_PER_SESSION = 10;
const DEFAULT_MAX_TOTAL_MESSAGES = 15;

type PluginConfig = {
  storeDir?: string;
  maxEntries?: number;
  retrievalTopK?: number;
  decayHalfLife?: string;
  maxMessagesPerSession?: number;
  maxTotalMessages?: number;
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

// ---------------------------------------------------------------------------
// Coordination dispatch extraction
// ---------------------------------------------------------------------------

type CoordinationEnvelope = {
  protocol?: string;
  coordinationId?: string;
  mode?: string;
  coordinator?: { agentId?: string; sessionKey?: string; channel?: string };
  delegate?: { agentId?: string };
  replyTarget?: string;
  resultRoute?: string;
  completionSignal?: string;
  taskContent?: string;
};

function tryParseCoordinationTask(content: string): CoordinationEnvelope | null {
  const idx = content.indexOf("[COORDINATION_TASK]");
  if (idx === -1) return null;

  const jsonStart = content.indexOf("{", idx);
  if (jsonStart === -1) return null;

  let depth = 0;
  let jsonEnd = jsonStart;
  for (let i = jsonStart; i < content.length; i++) {
    if (content[i] === "{") depth++;
    if (content[i] === "}") depth--;
    if (depth === 0) {
      jsonEnd = i + 1;
      break;
    }
  }

  try {
    const json = content.slice(jsonStart, jsonEnd);
    const parsed = JSON.parse(json);
    if (parsed.protocol?.includes?.("coordination")) {
      return parsed;
    }
  } catch {
    // Not valid JSON
  }

  return null;
}

function extractKeywordsFromFact(text: string): string {
  const chinesePhrases = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const latinWords = text
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
  return [...chinesePhrases, ...latinWords].join(",");
}

function factsFromCoordinationEnvelope(
  envelope: CoordinationEnvelope,
  content: string,
  agentId: string,
  sessionKey: string,
  timestamp: number,
): FactInsert[] {
  const delegateAgentId = envelope.delegate?.agentId;
  const coordinatorAgentId = envelope.coordinator?.agentId;
  const facts: FactInsert[] = [];

  const task = envelope as {
    task?: { title?: string; objective?: string; expectedOutput?: string };
  };
  const taskParts: string[] = [];
  if (task?.task?.title) taskParts.push(`任务: ${task.task.title}`);
  if (task?.task?.objective) taskParts.push(`内容: ${task.task.objective}`);
  if (task?.task?.expectedOutput) taskParts.push(`期望输出: ${task.task.expectedOutput}`);
  const taskSummary = taskParts.join("\n") || content.slice(0, 500);

  if (delegateAgentId) {
    facts.push({
      agentId: delegateAgentId,
      sourceAgent: coordinatorAgentId,
      sourceSessionKey: sessionKey,
      targetAgent: delegateAgentId,
      category: "coordination_task",
      fact: taskSummary,
      keywords: extractKeywordsFromFact(taskSummary),
      timestamp,
    });
  }

  if (coordinatorAgentId && envelope.coordinationId) {
    const summary = `向 ${delegateAgentId ?? "未知"} 发送了协调任务 (${envelope.mode ?? "dispatch"}): ${taskSummary.slice(0, 200)}`;
    facts.push({
      agentId: coordinatorAgentId,
      sourceAgent: coordinatorAgentId,
      sourceSessionKey: sessionKey,
      targetAgent: delegateAgentId,
      category: "coordination_sent",
      fact: summary,
      keywords: extractKeywordsFromFact(summary),
      timestamp,
    });
  }

  return facts;
}

function messageTimestamp(msg: AgentMessage): number {
  const ts = (msg as { timestamp?: number }).timestamp;
  if (ts) return ts;
  const meta = (msg as { metadata?: { timestamp?: number } }).metadata;
  if (meta?.timestamp) return meta.timestamp;
  return Date.now();
}

const DENIAL_PATTERNS = [
  "不知道",
  "我没有看到",
  "没有找到",
  "没有记录",
  "没有收到",
  "没有提到",
  "确实没有",
  "无法确认",
  "我不清楚",
  "我没有找到",
];

function isDenialResponse(text: string): boolean {
  return DENIAL_PATTERNS.some((p) => text.includes(p));
}

function shouldIngest(msg: AgentMessage): boolean {
  const role = (msg as { role?: string }).role;
  if (role !== "user" && role !== "assistant") return false;
  const content = messageContent(msg);
  return content.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Context Engine
// ---------------------------------------------------------------------------

export class CrossSessionContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "context-engine",
    name: "Cross-Session Context Engine",
    version: "0.3.0",
  };

  private store: FactStore | null = null;
  private config: Required<PluginConfig>;
  private bootstrappedSessions = new Set<string>();

  constructor(cfg?: OpenClawConfig) {
    this.config = resolvePluginConfig(cfg);
  }

  private getStore(): FactStore {
    if (!this.store) {
      this.store = new FactStore(this.config.storeDir);
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

    const content = messageContent(params.message);
    const ts = messageTimestamp(params.message);
    const role = (params.message as { role?: string }).role ?? "unknown";

    const envelope = tryParseCoordinationTask(content);
    if (envelope) {
      const facts = factsFromCoordinationEnvelope(
        envelope,
        content,
        agentId,
        params.sessionKey ?? params.sessionId,
        ts,
      );
      this.getStore().insertBatch(facts);
      return { ingested: facts.length > 0 };
    }

    if (role === "assistant") {
      const trimmed = content.trim();
      if (trimmed.includes("toolCall") || trimmed.includes("thinking") || trimmed.length > 500) {
        return { ingested: false };
      }
      if (!isDenialResponse(trimmed) && trimmed.length > 5 && trimmed.length <= 300) {
        this.getStore().insert({
          agentId,
          sourceAgent: agentId,
          sourceSessionKey: params.sessionKey ?? params.sessionId,
          category: "assistant_response",
          fact: trimmed,
          keywords: extractKeywordsFromFact(trimmed),
          timestamp: ts,
        });
        return { ingested: true };
      }
    }

    return { ingested: false };
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

    const facts: FactInsert[] = [];

    for (const msg of params.messages) {
      if (!shouldIngest(msg)) continue;

      const content = messageContent(msg);
      const ts = messageTimestamp(msg);
      const role = (msg as { role?: string }).role ?? "unknown";

      const envelope = tryParseCoordinationTask(content);
      if (envelope) {
        const extracted = factsFromCoordinationEnvelope(
          envelope,
          content,
          agentId,
          params.sessionKey ?? params.sessionId,
          ts,
        );
        facts.push(...extracted);
        continue;
      }

      if (role === "assistant") {
        const trimmed = content.trim();
        if (trimmed.includes("toolCall") || trimmed.includes("thinking") || trimmed.length > 500) {
          continue;
        }
        if (!isDenialResponse(trimmed) && trimmed.length > 5 && trimmed.length <= 300) {
          facts.push({
            agentId,
            sourceAgent: agentId,
            sourceSessionKey: params.sessionKey ?? params.sessionId,
            category: "assistant_response",
            fact: trimmed,
            keywords: extractKeywordsFromFact(trimmed),
            timestamp: ts,
          });
        }
      }
    }

    if (facts.length > 0) {
      this.getStore().insertBatch(facts);
    }

    return { ingestedCount: facts.length };
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

    if (!agentId || !params.prompt) {
      return { messages: params.messages, estimatedTokens: 0 };
    }

    const halfLifeMs = parseDecayHalfLife(this.config.decayHalfLife);
    const maxPerSession = this.config.maxMessagesPerSession;
    const maxTotal = this.config.maxTotalMessages;

    // Step 1: Discover all active sessions for this agent
    const sessions = discoverSessions(agentId);

    // Step 2: Read recent messages from each session (exclude current)
    const allMessages = [];
    for (const session of sessions) {
      if (session.id === params.sessionId) continue;
      const recent = readRecentMessages(session.file, session.id, maxPerSession);
      allMessages.push(...recent);
    }

    // Step 3: Filter by keyword relevance and score by time decay
    let relevant = filterAndScore(allMessages, params.prompt, halfLifeMs, maxTotal);

    // Step 4: Fall back to SQLite facts if no session messages matched
    if (relevant.length === 0) {
      const chinesePhrases = params.prompt.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
      if (chinesePhrases.length > 0) {
        const sqliteResults = this.getStore().search({
          agentId,
          keywords: chinesePhrases.slice(0, 6),
          excludeSessionKey: currentSessionKey,
          limit: this.config.retrievalTopK,
          halfLifeMs,
        });
        if (sqliteResults.length === 0) {
          const coordinationTasks = this.getStore().searchByCategory({
            agentId,
            categories: ["coordination_task"],
            excludeSessionKey: currentSessionKey,
            limit: this.config.retrievalTopK,
          });
          if (coordinationTasks.length > 0) {
            const contextText = formatContextForPrompt(coordinationTasks, currentSessionKey);
            return {
              messages: params.messages,
              estimatedTokens: Math.ceil(contextText.length / 4),
              _promptPrefix: `[以下是你之前在其他会话中的相关信息，请用来回答问题]\n\n${contextText}`,
            };
          }
        } else {
          const contextText = formatContextForPrompt(sqliteResults, currentSessionKey);
          return {
            messages: params.messages,
            estimatedTokens: Math.ceil(contextText.length / 4),
            _promptPrefix: `[以下是你之前在其他会话中的相关信息，请用来回答问题]\n\n${contextText}`,
          };
        }
      }
    }

    if (relevant.length === 0) {
      return { messages: params.messages, estimatedTokens: 0 };
    }

    const contextText = formatSessionContextForPrompt(relevant, currentSessionKey);

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
    const agentId = resolveAgentIdFromSession(params.sessionKey);
    if (!agentId) return;

    const newMessages = params.messages.slice(params.prePromptMessageCount);

    const facts: FactInsert[] = [];
    for (const msg of newMessages) {
      if (!shouldIngest(msg)) continue;

      const content = messageContent(msg);
      const ts = messageTimestamp(msg);
      const role = (msg as { role?: string }).role ?? "unknown";

      const envelope = tryParseCoordinationTask(content);
      if (envelope) {
        const extracted = factsFromCoordinationEnvelope(
          envelope,
          content,
          agentId,
          params.sessionKey ?? params.sessionId,
          ts,
        );
        facts.push(...extracted);
        continue;
      }

      if (role === "assistant") {
        const trimmed = content.trim();
        if (trimmed.includes("toolCall") || trimmed.includes("thinking") || trimmed.length > 500) {
          continue;
        }
        if (!isDenialResponse(trimmed) && trimmed.length > 5 && trimmed.length <= 300) {
          facts.push({
            agentId,
            sourceAgent: agentId,
            sourceSessionKey: params.sessionKey ?? params.sessionId,
            category: "assistant_response",
            fact: trimmed,
            keywords: extractKeywordsFromFact(trimmed),
            timestamp: ts,
          });
        }
      }
    }

    if (facts.length > 0) {
      this.getStore().insertBatch(facts);
    }

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
