import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import type { Services } from '../src/config.js';
import { readConfig } from '../src/config.js';
import { createPortalAuth, type Portal } from '../src/providers/auth.js';
import { createPGliteDatabase } from '../src/providers/db.js';
import { createMemoryStorage } from '../src/providers/storage.js';
import { runMigrations } from '../src/lib/migrate.js';
import { loadSeed } from '../src/seed/loadSeed.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function setup(withSeed = true) {
  const db = await createPGliteDatabase();
  await runMigrations(db);
  const config = readConfig({ QR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), ALLOWED_ORIGINS: '*', PUBLIC_APP_URL: 'https://example.test/spir' });
  const storage = createMemoryStorage(config.fileSigningSecret);
  const services: Services = { db, storage, auth: createPortalAuth(db, config.sessionSecret), config };
  const report = withSeed ? await loadSeed(db, storage, config.qrKey, readFileSync(path.join(ROOT, 'seed/spir_seed.csv'), 'utf8')) : null;
  const app = createApp(services);

  const tokens = new Map<Portal, string>();
  /** Call the API as the supplier portal, the company portal, or anonymously (null). */
  async function call(as: Portal | null, method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (as) {
      if (!tokens.has(as)) tokens.set(as, (await services.auth.login(as, 'admin', 'admin'))!.token);
      headers.Authorization = `Bearer ${tokens.get(as)}`;
    }
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await app.request(`http://test${url}`, { method, headers, body: payload });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  return { db, storage, services, app, call, report };
}

/** OCR payload builder: text lines with one confidence each (like a simple OCR engine). */
export const ocr = (lines: string[], confidence = 93) => ({ engine: 'test', engineVersion: '1', text: lines.join('\n'), confidence });
