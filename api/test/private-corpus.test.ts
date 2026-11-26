// Real supplier label photos (OCR + barcode output in test/fixtures/local/, records in seed/local/*.csv).
// Both folders are git-ignored because they contain real POs, part numbers and supplier names, so this
// test only runs where those private files exist (e.g. your Codespace) and is skipped on GitHub.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { createPortalAuth } from '../src/providers/auth.js';
import { createPGliteDatabase } from '../src/providers/db.js';
import { createMemoryStorage } from '../src/providers/storage.js';
import { runMigrations } from '../src/lib/migrate.js';
import { loadSeed } from '../src/seed/loadSeed.js';
import { seedFiles } from '../src/seed/files.js';
import { ROOT } from './helpers.js';

const fixture = path.join(ROOT, 'api/test/fixtures/local/real-labels.json');
const expectations = path.join(ROOT, 'api/test/fixtures/local/expected.json');

describe.skipIf(!existsSync(fixture) || !existsSync(expectations))('private corpus: real label photos', () => {
  it('each real label gives the expected result', async () => {
    const db = await createPGliteDatabase();
    await runMigrations(db);
    const config = readConfig({ QR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64') });
    const storage = createMemoryStorage(config.fileSigningSecret);
    await loadSeed(db, storage, config.qrKey, seedFiles(ROOT));
    const auth = createPortalAuth(db, config.sessionSecret);
    const app = createApp({ db, storage, auth, config });
    const token = (await auth.login('company', 'admin', 'admin'))!.token;
    const corpus = JSON.parse(readFileSync(fixture, 'utf8'));
    const want: Record<string, { status: string; record?: string; fields?: Record<string, string> }> = JSON.parse(readFileSync(expectations, 'utf8'));
    for (const [file, w] of Object.entries(want)) {
      const res = await app.request('http://t/api/v1/validations', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(corpus[file]),
      });
      const r = await res.json();
      expect([file, r.overallStatus]).toEqual([file, w.status]);
      if (w.record) {
        const ext = (await db.one<{ external_ref: string }>('SELECT external_ref FROM spir.traceability_record WHERE traceability_code = $1', [r.record?.traceabilityCode]))?.external_ref;
        expect([file, ext]).toEqual([file, w.record]);
      }
      for (const [k, v] of Object.entries(w.fields ?? {})) expect([file, k, r.fields.find((f: any) => f.attributeKey === k)?.result]).toEqual([file, k, v]);
    }
  }, 60_000);
});
