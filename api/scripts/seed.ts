// npm run db:seed  - loads seed/spir_seed.csv (or a CSV path given as argument).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgDatabase } from '../src/providers/db.js';
import { createStorageFromEnv, readConfig } from '../src/config.js';
import { loadSeed } from '../src/seed/loadSeed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const csvPath = path.resolve(process.argv[2] ?? path.join(root, 'seed/spir_seed.csv'));
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env).');

const config = readConfig(process.env);
if (config.insecureDevKey) console.warn('!! QR_TOKEN_KEY is not set: seeded QR labels will only re-print with the same insecure dev key.');
const db = await createPgDatabase(url);
const storage = await createStorageFromEnv(process.env, config.fileSigningSecret);
console.log(`Seeding from ${path.relative(process.cwd(), csvPath)} (storage: ${storage.kind})`);
try {
  const report = await loadSeed(db, storage, config.qrKey, readFileSync(csvPath, 'utf8'), {
    documentsDir: path.join(root, 'seed/documents'),
    log: (m) => console.log(m),
  });
  console.log('\nDone:', report);
} catch (e: any) {
  console.error('\nSeed failed - nothing was written to the database.\n' + e.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
