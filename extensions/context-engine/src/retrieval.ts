import { cut } from "@node-rs/jieba";
import type { SessionMessage } from "./session-reader.js";
import type { FactEntry } from "./store.js";

// Stop words to filter out from keyword matching
const STOP_WORDS = new Set([
  "的",
  "了",
  "是",
  "在",
  "我",
  "你",
  "他",
  "她",
  "它",
  "们",
  "这",
  "那",
  "什么",
  "怎么",
  "为什么",
  "有没有",
  "怎么样",
  "和",
  "或",
  "与",
  "及",
  "到",
  "从",
  "把",
  "被",
  "给",
  "吗",
  "呢",
  "吧",
  "啊",
  "哦",
  "嗯",
  "吧",
  "请",
  "说",
  "看",
  "让",
  "用",
  "对",
  "关于",
]);

/**
 * Extract keywords from prompt using jieba segmentation.
 * Filters stop words and keeps meaningful terms (2+ chars for Chinese, 2+ for Latin).
 */
export function extractKeywords(prompt: string): string[] {
  const keywords = new Set<string>();

  // Jieba segmentation for Chinese text
  const tokens = cut(prompt, true);
  for (const token of tokens) {
    const t = token.trim();
    if (t.length < 2) continue;
    if (STOP_WORDS.has(t)) continue;
    // Skip pure punctuation/numbers
    if (/^[^\u4e00-\u9fff\w]+$/.test(t)) continue;
    keywords.add(t);
  }

  return [...keywords];
}

export function formatContextForPrompt(
  entries: FactEntry[],
  currentSessionKey: string | undefined,
): string {
  if (entries.length === 0) return "";

  const lines = ["以下是你之前在其他会话中提到的相关信息：", ""];

  for (const entry of entries) {
    const timeStr = new Date(entry.timestamp).toISOString().replace("T", " ").slice(0, 19);
    const sourceLabel = entry.sourceAgent ? `${entry.sourceAgent}` : "未知来源";
    const categoryLabel = entry.category === "coordination_task" ? "协调任务" : entry.category;
    const preview = entry.fact.length > 500 ? entry.fact.slice(0, 500) + "..." : entry.fact;
    lines.push(`[${timeStr}] ${sourceLabel} (${categoryLabel}):`);
    lines.push(preview);
    lines.push("");
  }

  lines.push("请根据以上信息回答问题。");
  return lines.join("\n");
}

export function parseDecayHalfLife(value: string): number {
  const match = value.match(/^(\d+)([smhdw])$/i);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return n * (multipliers[unit] ?? 24 * 60 * 60 * 1000);
}

/**
 * Score session messages by keyword match and time decay.
 * Returns messages sorted by score, limited to maxTotal.
 */
export function filterAndScore(
  messages: SessionMessage[],
  prompt: string,
  halfLifeMs: number,
  maxTotal: number = 15,
): (SessionMessage & { score: number })[] {
  const keywords = extractKeywords(prompt);

  const scored = messages
    .map((msg) => {
      let score = 1.0; // base recency score
      if (keywords.length > 0) {
        const matchCount = keywords.filter((kw) => msg.content.includes(kw)).length;
        if (matchCount === 0) return null; // no keyword match, skip
        score = matchCount / keywords.length; // relevance ratio
      }
      // Apply time decay
      const now = Date.now();
      const decay = Math.pow(0.5, (now - msg.timestamp) / halfLifeMs);
      score *= decay;

      return { ...msg, score };
    })
    .filter((m): m is SessionMessage & { score: number } => m !== null);

  return scored.sort((a, b) => b.score - a.score).slice(0, maxTotal);
}

/**
 * Format session messages into a text block for prompt injection.
 */
export function formatSessionContextForPrompt(
  messages: (SessionMessage & { score: number })[],
  currentSessionKey: string | undefined,
): string {
  if (messages.length === 0) return "";

  const lines = ["以下是你之前在其他会话中的对话内容：", ""];

  for (const msg of messages) {
    const timeStr = new Date(msg.timestamp).toISOString().replace("T", " ").slice(0, 19);
    const roleLabel = msg.role === "user" ? "用户" : "助手";
    const preview = msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content;
    lines.push(`[${timeStr}] ${roleLabel} (会话 ${msg.sessionId.slice(0, 8)}):`);
    lines.push(preview);
    lines.push("");
  }

  lines.push("请根据以上信息回答问题。");
  return lines.join("\n");
}
