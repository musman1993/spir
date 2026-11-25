// npm run db:migrate  - creates/updates the spir schema in DATABASE_URL.
import { createPgDatabase } from '../src/providers/db.js';
import { runMigrations } from '../src/lib/migrate.js';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env).');
const db = await createPgDatabase(url);
await runMigrations(db, (m) => console.log('  ' + m));
console.log('Migrations up to date.');
await db.close();
