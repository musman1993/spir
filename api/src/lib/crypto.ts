// QR token handling (spec 14.4): high-entropy random tokens, looked up by hash,
// stored encrypted only so authorised users can re-print a label.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const sha256Hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

/** 256-bit random token, base64url (43 chars). Encodes no business data. */
/**
 * QR token: 16 characters of Crockford base32 (80 random bits). Short enough that the QR stays coarse and
 * easy for a phone camera, still unguessable (lookups are rate limited and only the SHA-256 is stored).
 * Older 43-character base64url tokens remain valid.
 */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const newQrToken = () => {
  const b = randomBytes(10);
  let bits = 0; let acc = 0; let out = '';
  for (const byte of b) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(acc >> (bits - 5)) & 31]; bits -= 5; }
  }
  return out;
};

export function encryptToken(key: Buffer, token: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decryptToken(key: Buffer, payload: string): string {
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export function parseKey(b64: string | undefined): { key: Buffer; insecureDevKey: boolean } {
  if (b64) {
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error('QR_TOKEN_KEY must be 32 bytes, base64-encoded');
    return { key, insecureDevKey: false };
  }
  // Development fallback only. neon.ts makes QR_TOKEN_KEY required for deployed functions.
  return { key: createHash('sha256').update('spir-insecure-dev-key').digest(), insecureDevKey: true };
}
