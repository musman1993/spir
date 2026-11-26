// Composition root: reads environment variables and wires the providers together.
import { parseKey } from './lib/crypto.js';
import { createDemoHeaderAuth, createOpenAuth, type AuthProvider } from './providers/auth.js';
import { createPgDatabase, type Db } from './providers/db.js';
import { createLocalDiskStorage, createS3Storage, type FileStorage } from './providers/storage.js';

export interface AppConfig {
  allowedOrigins: string[];
  publicAppUrl: string;
  qrKey: Buffer;
  insecureDevKey: boolean;
  fileSigningSecret: string;
  documentMaxBytes: number;
  imageMaxBytes: number;
}

export interface Services {
  db: Db;
  storage: FileStorage;
  auth: AuthProvider;
  config: AppConfig;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const { key, insecureDevKey } = parseKey(env.QR_TOKEN_KEY);
  return {
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
    publicAppUrl: (env.PUBLIC_APP_URL ?? '').replace(/\/+$/, ''),
    qrKey: key,
    insecureDevKey,
    // Local-disk file links are signed with a key derived from the QR key (never sent to clients).
    fileSigningSecret: key.toString('base64') + ':files',
    documentMaxBytes: 15 * 1024 * 1024,
    imageMaxBytes: 12 * 1024 * 1024,
  };
}

export async function createStorageFromEnv(env: NodeJS.ProcessEnv, signingSecret: string): Promise<FileStorage> {
  if (env.AWS_ENDPOINT_URL_S3 && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return createS3Storage({
      bucket: env.SPIR_BUCKET ?? 'spir',
      endpoint: env.AWS_ENDPOINT_URL_S3,
      region: env.AWS_REGION ?? 'us-east-2',
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    });
  }
  const dir = env.LOCAL_STORAGE_DIR ?? new URL('../../.data/storage', import.meta.url).pathname;
  console.warn(`[storage] No Object Storage credentials found - storing files on local disk at ${dir}`);
  return createLocalDiskStorage(dir, signingSecret);
}

export async function createServicesFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Services> {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  const config = readConfig(env);
  if (config.insecureDevKey) console.warn('[config] QR_TOKEN_KEY not set - using an INSECURE development key.');
  const db = await createPgDatabase(env.DATABASE_URL);
  const storage = await createStorageFromEnv(env, config.fileSigningSecret);
  const mode = env.AUTH_MODE ?? 'open';
  if (!['open', 'demo'].includes(mode)) throw new Error(`AUTH_MODE=${mode} is not implemented yet; use "open" or "demo".`);
  const auth = mode === 'demo' ? createDemoHeaderAuth(db) : createOpenAuth();
  return { db, storage, auth, config };
}
