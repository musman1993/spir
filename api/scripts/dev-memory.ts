// npm run dev:memory - runs the full API with an in-memory Postgres (PGlite) and in-memory file
// storage, seeded from seed/spir_seed.csv. No Neon account or credentials needed. Data resets on restart.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { readConfig, type Services } from '../src/config.js';
import { createDemoHeaderAuth } from '../src/providers/auth.js';
import { createPGliteDatabase } from '../src/providers/db.js';
import { createMemoryStorage } from '../src/providers/storage.js';
import { runMigrations } from '../src/lib/migrate.js';
import { loadSeed } from '../src/seed/loadSeed.js';
import { seedFiles } from '../src/seed/files.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const db = await createPGliteDatabase();
await runMigrations(db);
const config = readConfig(process.env);
const storage = createMemoryStorage(config.fileSigningSecret);
const report = await loadSeed(db, storage, config.qrKey, seedFiles(root), {
  documentsDir: path.join(root, 'seed/documents'),
});
const services: Services = { db, storage, auth: createDemoHeaderAuth(db), config };
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp(services).fetch, port }, () => {
  console.log(`SPIR API (in-memory demo) on http://localhost:${port}`, report);
});
