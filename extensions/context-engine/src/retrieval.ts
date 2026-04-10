import type { ContextEntry, ContextStore } from "./store.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "used",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "while",
  "about",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "myself",
  "we",
  "our",
  "ours",
  "ourselves",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "he",
  "him",
  "his",
  "himself",
  "she",
  "her",
  "hers",
  "herself",
  "it",
  "its",
  "itself",
  "they",
  "them",
  "their",
  "theirs",
  "themselves",
  "am",
  "了",
  "的",
  "我",
  "你",
  "他",
  "她",
  "它",
  "我们",
  "你们",
  "他们",
  "她们",
  "它们",
  "是",
  "在",
  "有",
  "这",
  "那",
  "这",
  "一个",
  "个",
  "什么",
  "怎么",
  "为什么",
  "吗",
  "呢",
  "吧",
  "啊",
  "哦",
  "嗯",
  "和",
  "或",
  "与",
  "但",
  "而",
  "如果",
  "因为",
  "所以",
]);

export function extractKeywords(text: string, maxKeywords = 8): string[] {
  const words = text
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));
  const freq: Record<string, number> = {};
  for (const w of words) {
    const key = w.toLowerCase();
    freq[key] = (freq[key] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([w]) => w);
}

export function formatContextForPrompt(
  entries: ContextEntry[],
  currentSessionKey: string | undefined,
): string {
  if (entries.length === 0) return "";

  const lines = ["<cross_session_context>"];
  lines.push(
    "The following are relevant messages from your other sessions. Use them to answer consistently:",
  );
  lines.push("");

  for (const entry of entries) {
    const sessionLabel = entry.sessionKey === currentSessionKey ? "this session" : entry.sessionKey;
    const timeStr = new Date(entry.timestamp).toISOString().replace("T", " ").slice(0, 19);
    const roleLabel = entry.role === "user" ? "User" : "Assistant";
    const preview =
      entry.content.length > 500 ? entry.content.slice(0, 500) + "..." : entry.content;
    lines.push(`[${timeStr}] ${sessionLabel} (${roleLabel}):`);
    lines.push(preview);
    lines.push("");
  }

  lines.push("</cross_session_context>");
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
