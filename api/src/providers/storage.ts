// FileStorageProvider: private object storage for documents and label images.
// Implementations: Neon Object Storage (S3 protocol), local disk (dev without credentials), memory (tests).
// Buckets stay private; downloads go through short-lived signed URLs only (spec 14.5).
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface StoredObject { bytes: Uint8Array; contentType: string }

export interface FileStorage {
  readonly kind: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  /** Short-lived URL the browser can open. Local adapters return an API-relative path ('/api/v1/files?...'). */
  signedUrl(key: string, expiresInSeconds: number, downloadName?: string): Promise<string>;
}

export async function createS3Storage(opts: {
  bucket: string; endpoint: string; region: string; accessKeyId?: string; secretAccessKey?: string;
}): Promise<FileStorage> {
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const s3 = new S3Client({
    forcePathStyle: true,
    endpoint: opts.endpoint,
    region: opts.region,
    ...(opts.accessKeyId && opts.secretAccessKey
      ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
      : {}),
  });
  return {
    kind: 's3',
    async put(key, bytes, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
    async get(key) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }));
        const bytes = await r.Body!.transformToByteArray();
        return { bytes, contentType: r.ContentType ?? 'application/octet-stream' };
      } catch (e: any) {
        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async signedUrl(key, expiresIn, downloadName) {
      return getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: opts.bucket,
          Key: key,
          ...(downloadName ? { ResponseContentDisposition: `inline; filename="${downloadName.replace(/"/g, '')}"` } : {}),
        }),
        { expiresIn },
      );
    },
  };
}

/** Local/memory storage serve files through the API itself with an HMAC-signed, expiring link. */
export function signLocal(secret: string, key: string, exp: number) {
  return createHmac('sha256', secret).update(`${key}:${exp}`).digest('base64url');
}
export function verifyLocal(secret: string, key: string, exp: number, sig: string) {
  if (Date.now() / 1000 > exp) return false;
  const a = Buffer.from(signLocal(secret, key, exp));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createMemoryStorage(secret: string): FileStorage & { objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  return {
    kind: 'memory',
    objects,
    async put(key, bytes, contentType) { objects.set(key, { bytes, contentType }); },
    async get(key) { return objects.get(key) ?? null; },
    async signedUrl(key, expiresIn) {
      const exp = Math.floor(Date.now() / 1000) + expiresIn;
      return `/api/v1/files?key=${encodeURIComponent(key)}&exp=${exp}&sig=${signLocal(secret, key, exp)}`;
    },
  };
}

export async function createLocalDiskStorage(root: string, secret: string): Promise<FileStorage> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const safe = (key: string) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(path.resolve(root))) throw new Error('invalid key');
    return p;
  };
  return {
    kind: 'local-disk',
    async put(key, bytes, contentType) {
      const p = safe(key);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, bytes);
      await fs.writeFile(p + '.meta', contentType);
    },
    async get(key) {
      try {
        const p = safe(key);
        const bytes = new Uint8Array(await fs.readFile(p));
        const contentType = await fs.readFile(p + '.meta', 'utf8').catch(() => 'application/octet-stream');
        return { bytes, contentType };
      } catch { return null; }
    },
    async signedUrl(key, expiresIn) {
      const exp = Math.floor(Date.now() / 1000) + expiresIn;
      return `/api/v1/files?key=${encodeURIComponent(key)}&exp=${exp}&sig=${signLocal(secret, key, exp)}`;
    },
  };
}
