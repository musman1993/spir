// DatabaseProvider: the only way modules talk to Postgres.
// Implementations: PgDatabase (Neon / any Postgres) and PGliteDatabase (in-process, for tests).
// All SQL in this codebase schema-qualifies tables as spir.<table>, so no search_path is needed
// (Neon's pooled connections do not reliably honour startup options).

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Run a multi-statement script without parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Run fn inside a transaction; nested calls reuse the outer transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Queryable = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };

function wrap(q: Queryable, txImpl: Db['tx'], execImpl: Db['exec'], closeImpl: Db['close']): Db {
  const db: Db = {
    async query(sql, params = []) {
      const r = await q.query(sql, params as any[]);
      return r.rows as any[];
    },
    async one(sql, params = []) {
      const rows = await db.query(sql, params);
      return (rows[0] as any) ?? null;
    },
    exec: execImpl,
    tx: txImpl,
    close: closeImpl,
  };
  return db;
}

export async function createPgDatabase(connectionString: string): Promise<Db> {
  const pg = await import('pg');
  const Pool = (pg as any).default?.Pool ?? (pg as any).Pool;
  const pool = new Pool({ connectionString, max: 5 });
  try {
    // Neon Functions: swallow expected idle disconnects instead of crashing the isolate.
    const fns = await import('@neon/functions');
    (fns as any).attachDatabasePool?.(pool);
  } catch {
    pool.on('error', (err: Error) => console.warn('[db] idle client error', err.message));
  }
  const root: Db = wrap(
    pool,
    async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inner: Db = wrap(client, (f) => f(inner), async (s) => { await client.query(s); }, async () => {});
        const result = await fn(inner);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async (sql) => { await pool.query(sql); },
    async () => { await pool.end(); },
  );
  return root;
}

export async function createPGliteDatabase(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.waitReady;
  const root: Db = wrap(
    pg as unknown as Queryable,
    async (fn) =>
      (pg as any).transaction(async (t: any) => {
        const inner: Db = wrap(t, (f) => f(inner), async (s) => { await t.exec(s); }, async () => {});
        return fn(inner);
      }),
    async (sql) => { await pg.exec(sql); },
    async () => { await pg.close(); },
  );
  return root;
}
