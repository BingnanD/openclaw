import type { FactEntry } from "./store.js";

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
