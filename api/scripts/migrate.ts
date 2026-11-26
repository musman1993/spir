// npm run db:migrate  - creates/updates the spir schema in DATABASE_URL.
import { createPgDatabase } from '../src/providers/db.js';
import { runMigrations } from '../src/lib/migrate.js';
import { databaseUrl } from './db-url.js';

const url = databaseUrl();
const db = await createPgDatabase(url);
await runMigrations(db, (m) => console.log('  ' + m));
console.log('Migrations up to date.');
await db.close();
