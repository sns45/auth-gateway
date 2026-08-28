/**
 * A D1Database facade over node:sqlite, for integration tests.
 *
 * The unit tests hand Better Auth a node:sqlite database directly, which it
 * supports. Integration tests use this instead so the code under test takes
 * the same D1 dialect and the same `.prepare().bind().first()` calls it will
 * take in production.
 *
 * This is a stand in, not the real thing. For genuine bindings the upgrade is
 * @cloudflare/vitest-pool-workers, which runs tests inside workerd.
 */
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => any;
};

class Statement {
  constructor(private db: any, private sql: string, private params: unknown[] = []) {}

  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values);
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (row === undefined) return null;
    return (column ? row[column] : row) ?? null;
  }

  async all<T = unknown>() {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true, meta: {} };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return (this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[]).map((r) =>
      Object.values(r)
    ) as T[];
  }
}

export function createSqliteD1(schemaSql: string) {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);

  const d1 = {
    prepare: (sql: string) => new Statement(db, sql),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    batch: async (statements: Statement[]) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    dump: async () => {
      throw new Error('not implemented in tests');
    },
    withSession: () => {
      throw new Error('read replication is not used: session reads must stay on the primary');
    },
    close: () => db.close(),
    raw: db,
  };

  return d1 as unknown as D1Database & { close(): void; raw: any };
}
