// npm run db:reset  - DROPS the spir schema (all SPIR data), re-runs migrations and reseeds.
// Files already uploaded to Object Storage are left in place (they are simply no longer referenced).
import { execSync } from 'node:child_process';
import { createPgDatabase } from '../src/providers/db.js';
import { dropSchema, runMigrations } from '../src/lib/migrate.js';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env).');
const host = new URL(url).host;
if (!process.argv.includes('--yes')) {
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`This deletes ALL SPIR data in ${host}. Type "reset" to continue: `);
  rl.close();
  if (answer.trim() !== 'reset') { console.log('Cancelled.'); process.exit(0); }
}
const db = await createPgDatabase(url);
await dropSchema(db);
await runMigrations(db, (m) => console.log('  ' + m));
await db.close();
execSync('npm run db:seed', { stdio: 'inherit' });
