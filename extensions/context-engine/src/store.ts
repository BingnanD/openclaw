import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type FactEntry = {
  id: number;
  agentId: string;
  sourceAgent?: string;
  sourceSessionKey?: string;
  targetAgent?: string;
  category: string;
  fact: string;
  keywords: string;
  timestamp: number;
  createdAt: number;
};

export type FactInsert = Omit<FactEntry, "id" | "createdAt">;

/**
 * SQLite-backed fact store.
 * One database file per deployment (~/.openclaw/context-store/facts.db).
 */
export class FactStore {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(private storeDir: string) {
    this.dbPath = path.join(storeDir, "facts.db");
  }

  private getDb(): Database.Database {
    if (this.db) return this.db;

    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        source_agent TEXT,
        source_session_key TEXT,
        target_agent TEXT,
        category TEXT NOT NULL,
        fact TEXT NOT NULL,
        keywords TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_facts_agent ON facts(agent_id);
      CREATE INDEX IF NOT EXISTS idx_facts_agent_ts ON facts(agent_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(agent_id, category);
    `);

    return this.db;
  }

  insert(entry: FactInsert): void {
    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT INTO facts (agent_id, source_agent, source_session_key, target_agent, category, fact, keywords, timestamp, created_at)
      VALUES (@agentId, @sourceAgent, @sourceSessionKey, @targetAgent, @category, @fact, @keywords, @timestamp, @createdAt)
    `);
    stmt.run({
      agentId: entry.agentId,
      sourceAgent: entry.sourceAgent ?? null,
      sourceSessionKey: entry.sourceSessionKey ?? null,
      targetAgent: entry.targetAgent ?? null,
      category: entry.category,
      fact: entry.fact,
      keywords: entry.keywords ?? null,
      timestamp: entry.timestamp,
      createdAt: Date.now(),
    });
  }

  insertBatch(entries: FactInsert[]): void {
    if (entries.length === 0) return;
    const db = this.getDb();
    const insert = db.prepare(`
      INSERT INTO facts (agent_id, source_agent, source_session_key, target_agent, category, fact, keywords, timestamp, created_at)
      VALUES (@agentId, @sourceAgent, @sourceSessionKey, @targetAgent, @category, @fact, @keywords, @timestamp, @createdAt)
    `);
    const insertMany = db.transaction((rows: FactInsert[]) => {
      for (const e of rows) {
        insert.run({
          agentId: e.agentId,
          sourceAgent: e.sourceAgent ?? null,
          sourceSessionKey: e.sourceSessionKey ?? null,
          targetAgent: e.targetAgent ?? null,
          category: e.category,
          fact: e.fact,
          keywords: e.keywords ?? null,
          timestamp: e.timestamp,
          createdAt: Date.now(),
        });
      }
    });
    insertMany(entries);
  }

  search(params: {
    agentId: string;
    keywords: string[];
    excludeSessionKey?: string;
    limit: number;
    halfLifeMs: number;
  }): FactEntry[] {
    const db = this.getDb();

    // Build dynamic query: match keywords against fact text and keywords field
    const conditions: string[] = ["agent_id = ?"];
    const bindValues: (string | number)[] = [params.agentId];

    if (params.excludeSessionKey) {
      conditions.push("source_session_key != ?");
      bindValues.push(params.excludeSessionKey);
    }

    if (params.keywords.length > 0) {
      const likeClauses = params.keywords.map(() => "(fact LIKE ? OR keywords LIKE ?)");
      conditions.push(`(${likeClauses.join(" OR ")})`);
      for (const kw of params.keywords) {
        bindValues.push(`%${kw}%`);
        bindValues.push(`%${kw}%`);
      }
    }

    const query = `SELECT * FROM facts WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT ?`;
    bindValues.push(params.limit);

    const rows = db.prepare(query).all(...bindValues) as FactEntry[];

    // Apply time decay scoring
    const now = Date.now();
    return rows
      .map((row) => ({
        ...row,
        score: Math.pow(0.5, (now - row.timestamp) / params.halfLifeMs),
      }))
      .sort((a, b) => b.score - a.score);
  }

  searchByCategory(params: {
    agentId: string;
    categories: string[];
    excludeSessionKey?: string;
    limit: number;
  }): FactEntry[] {
    const db = this.getDb();
    const conditions: string[] = ["agent_id = ?"];
    const bindValues: (string | number)[] = [params.agentId];

    if (params.categories.length > 0) {
      const placeholders = params.categories.map(() => "?").join(", ");
      conditions.push(`category IN (${placeholders})`);
      bindValues.push(...params.categories);
    }

    if (params.excludeSessionKey) {
      conditions.push("source_session_key != ?");
      bindValues.push(params.excludeSessionKey);
    }

    const query = `SELECT * FROM facts WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT ?`;
    bindValues.push(params.limit);

    return db.prepare(query).all(...bindValues) as FactEntry[];
  }

  countByAgent(agentId: string): number {
    const db = this.getDb();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM facts WHERE agent_id = ?").get(agentId) as {
      cnt: number;
    };
    return row.cnt;
  }

  cleanup(params: { agentId: string; maxEntries: number }): void {
    const db = this.getDb();
    const count = this.countByAgent(params.agentId);
    if (count <= params.maxEntries) return;

    // Delete oldest entries
    db.prepare(
      `DELETE FROM facts WHERE id IN (
        SELECT id FROM facts WHERE agent_id = ? ORDER BY timestamp DESC LIMIT -1 OFFSET ?
      )`,
    ).run(params.agentId, params.maxEntries);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
