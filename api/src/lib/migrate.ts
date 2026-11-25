// Minimal forward-only migration runner. Each file runs in its own transaction and is recorded
// in spir.schema_migrations, so re-running is safe.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Db } from '../providers/db.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

export async function runMigrations(db: Db, log: (m: string) => void = () => {}) {
  await db.exec(`CREATE SCHEMA IF NOT EXISTS spir;
    CREATE TABLE IF NOT EXISTS spir.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM spir.schema_migrations')).map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
    const safeName = f.replace(/'/g, "''");
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO spir.schema_migrations(name) VALUES ('${safeName}');\nCOMMIT;`);
    log(`applied ${f}`);
  }
}

export async function dropSchema(db: Db) {
  await db.exec('DROP SCHEMA IF EXISTS spir CASCADE;');
}
