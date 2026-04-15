import fs from "node:fs";
import path from "node:path";

export type SessionInfo = {
  id: string;
  file: string;
  mtime: number;
};

export type SessionMessage = {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

/**
 * Scan ~/.openclaw/agents/<agentId>/sessions/ for active .jsonl session files.
 * Excludes .deleted and .reset suffixed files.
 */
export function discoverSessions(agentId: string): SessionInfo[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const sessionsDir = path.join(
    home.replace(/\/$/, ""),
    ".openclaw",
    "agents",
    agentId,
    "sessions",
  );

  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  const entries = fs.readdirSync(sessionsDir);
  const results: SessionInfo[] = [];

  for (const entry of entries) {
    // Only active .jsonl files (exclude .deleted, .reset, and sessions.json)
    if (!entry.endsWith(".jsonl")) continue;
    if (entry.includes(".deleted.") || entry.includes(".reset.")) continue;

    const fullPath = path.join(sessionsDir, entry);
    const stat = fs.statSync(fullPath);
    const sessionId = entry.replace(/\.jsonl$/, "");

    results.push({
      id: sessionId,
      file: fullPath,
      mtime: stat.mtimeMs,
    });
  }

  // Sort by modification time, most recent first
  return results.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Read the last N user/assistant messages from a JSONL session file.
 * Reads from tail to get the most recent messages efficiently.
 */
export function readRecentMessages(
  jsonlPath: string,
  sessionId: string,
  limit: number = 10,
): SessionMessage[] {
  if (!fs.existsSync(jsonlPath)) {
    return [];
  }

  const content = fs.readFileSync(jsonlPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);

  const messages: SessionMessage[] = [];

  // Read from tail, collect recent user/assistant messages
  for (let i = lines.length - 1; i >= 0 && messages.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message") continue;

      const msg = entry.message;
      if (!msg || !msg.role) continue;

      if (msg.role !== "user" && msg.role !== "assistant") continue;

      const text = extractTextContent(msg);
      if (!text || text.trim().length === 0) continue;

      // Skip messages that are purely context-engine injected prefixes
      // (these pollute retrieval with recursive context)
      const trimmed = text.trim();
      if (trimmed.includes("[以下是你之前在其他会话")) continue;

      // Skip pure coordination JSON that got mixed with injected context
      if (trimmed.includes("[COORDINATION_TASK]") && trimmed.includes("[以下是你之前")) continue;

      // Parse timestamp from ISO string or use entry timestamp
      let ts = 0;
      if (msg.timestamp) {
        ts = typeof msg.timestamp === "number" ? msg.timestamp : new Date(msg.timestamp).getTime();
      } else if (entry.timestamp) {
        ts =
          typeof entry.timestamp === "number"
            ? entry.timestamp
            : new Date(entry.timestamp).getTime();
      }

      messages.push({
        sessionId,
        role: msg.role,
        content: text.trim(),
        timestamp: ts,
      });
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  // Return in chronological order (we read in reverse)
  return messages.reverse();
}

/**
 * Extract plain text from an AgentMessage's content array.
 * Skips thinking, toolCall, and other non-text blocks.
 */
function extractTextContent(msg: { content?: unknown }): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        !!b && typeof b === "object" && (b as { type?: string }).type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}
