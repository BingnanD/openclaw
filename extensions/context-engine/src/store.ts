import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ContextEntry = {
  id: number;
  agentId: string;
  sessionKey: string;
  role: string;
  content: string;
  timestamp: number;
  createdAt: number;
};

export type ContextStoreConfig = {
  storeDir: string;
};

/**
 * JSONL-backed context store.
 * One .jsonl file per agent (e.g. linxuyuan.jsonl).
 * Each line is a JSON object matching ContextEntry.
 * An auto-increment id counter is tracked per file.
 */
export class ContextStore {
  private cache = new Map<string, { entries: ContextEntry[]; nextId: number }>();
  private mtime = new Map<string, number>();

  constructor(private config: ContextStoreConfig) {}

  private agentPath(agentId: string): string {
    return path.join(this.config.storeDir, `${agentId}.jsonl`);
  }

  private loadAgent(agentId: string): { entries: ContextEntry[]; nextId: number } {
    if (this.cache.has(agentId)) {
      return this.cache.get(agentId)!;
    }
    const filePath = this.agentPath(agentId);
    let entries: ContextEntry[] = [];
    let nextId = 1;

    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const cachedMtime = this.mtime.get(agentId);
      if (cachedMtime && stat.mtimeMs <= cachedMtime) {
        // No change on disk, but we don't have cache — shouldn't happen.
      } else {
        const content = fs.readFileSync(filePath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed) as ContextEntry;
            entries.push(entry);
            if (entry.id >= nextId) nextId = entry.id + 1;
          } catch {
            // Skip malformed lines
          }
        }
        this.mtime.set(agentId, stat.mtimeMs);
      }
    }

    const result = { entries, nextId };
    this.cache.set(agentId, result);
    return result;
  }

  private saveAgent(agentId: string, data: { entries: ContextEntry[]; nextId: number }): void {
    const filePath = this.agentPath(agentId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = filePath + ".tmp";
    const content = data.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
    const stat = fs.statSync(filePath);
    this.mtime.set(agentId, stat.mtimeMs);
    this.cache.set(agentId, data);
  }

  ingest(entry: Omit<ContextEntry, "id" | "createdAt">): void {
    const data = this.loadAgent(entry.agentId);
    const newEntry: ContextEntry = {
      ...entry,
      id: data.nextId++,
      createdAt: Date.now(),
    };
    data.entries.push(newEntry);
    this.saveAgent(entry.agentId, data);
  }

  ingestBatch(entries: Omit<ContextEntry, "id" | "createdAt">[]): void {
    if (entries.length === 0) return;
    // Group by agent
    const byAgent = new Map<string, Omit<ContextEntry, "id" | "createdAt">[]>();
    for (const e of entries) {
      const arr = byAgent.get(e.agentId) ?? [];
      arr.push(e);
      byAgent.set(e.agentId, arr);
    }
    for (const [agentId, agentEntries] of byAgent) {
      const data = this.loadAgent(agentId);
      const now = Date.now();
      for (const e of agentEntries) {
        data.entries.push({ ...e, id: data.nextId++, createdAt: now });
      }
      this.saveAgent(agentId, data);
    }
  }

  searchByKeywords(params: {
    agentId: string;
    keywords: string[];
    excludeSessionKey?: string;
    limit: number;
    halfLifeMs: number;
  }): ContextEntry[] {
    if (params.keywords.length === 0) return [];
    const data = this.loadAgent(params.agentId);
    const filtered = data.entries.filter(
      (e) => !params.excludeSessionKey || e.sessionKey !== params.excludeSessionKey,
    );

    const now = Date.now();
    const scored = filtered.map((row) => {
      const contentLower = row.content.toLowerCase();
      const matchCount = params.keywords.filter((k) =>
        contentLower.includes(k.toLowerCase()),
      ).length;
      if (matchCount === 0) return { ...row, score: 0 };
      const ageMs = now - row.timestamp;
      const decayFactor = Math.pow(0.5, ageMs / params.halfLifeMs);
      return { ...row, score: matchCount * decayFactor };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.filter((r) => r.score > 0).slice(0, params.limit);
  }

  countByAgent(agentId: string): number {
    return this.loadAgent(agentId).entries.length;
  }

  cleanup(params: { agentId: string; maxEntries: number }): void {
    const data = this.loadAgent(params.agentId);
    if (data.entries.length <= params.maxEntries) return;
    data.entries.sort((a, b) => b.timestamp - a.timestamp);
    data.entries = data.entries.slice(0, params.maxEntries);
    this.saveAgent(params.agentId, data);
  }

  getRecentByAgent(params: { agentId: string; limit: number }): ContextEntry[] {
    const data = this.loadAgent(params.agentId);
    const sorted = [...data.entries].sort((a, b) => b.timestamp - a.timestamp);
    return sorted.slice(0, params.limit);
  }

  close(): void {
    this.cache.clear();
    this.mtime.clear();
  }
}
