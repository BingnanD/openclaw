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
 * For coordination tasks, extracts only the human-readable task description.
 */
function extractTextContent(msg: { content?: unknown }): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts = content
    .filter(
      (b): b is { type: "text"; text: string } =>
        !!b && typeof b === "object" && (b as { type?: string }).type === "text",
    )
    .map((b) => b.text)
    .join("\n");

  // Clean up coordination task JSON — extract just the task description
  if (texts.includes("[COORDINATION_TASK]")) {
    return simplifyCoordinationTask(texts);
  }

  return texts;
}

/**
 * Simplify a coordination task message to just the human-readable parts.
 * Strips the raw JSON envelope and keeps task title/objective/task content.
 */
function simplifyCoordinationTask(text: string): string {
  try {
    const jsonStart = text.indexOf("{", text.indexOf("[COORDINATION_TASK]"));
    if (jsonStart === -1) return text;

    let depth = 0;
    let jsonEnd = jsonStart;
    for (let i = jsonStart; i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}") depth--;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }

    const json = text.slice(jsonStart, jsonEnd);
    const parsed = JSON.parse(json);

    const parts: string[] = [];
    const prefix = text.slice(0, jsonStart).trim();

    const task = parsed.task as { title?: string; objective?: string } | undefined;
    if (task?.title) parts.push(`[协调任务: ${task.title}]`);
    if (task?.objective) parts.push(task.objective);
    if (!task?.title && !task?.objective && parsed.task) {
      parts.push(JSON.stringify(parsed.task, null, 2).slice(0, 300));
    }

    // Keep metadata like timestamp and coordinator info (but strip injected context)
    const metaLines = prefix
      .split("\n")
      .filter((l) => l.trim().length > 0 && !l.includes("[以下是你之前"));
    if (metaLines.length > 0) {
      parts.unshift(metaLines.join(" "));
    }

    return parts.join("\n").slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}
