// Traceability QR tokens and authenticated resolution (spec 8.7, 11.2, 14.4).
// The QR carries only an opaque random token. Possession of it grants nothing: every resolution
// requires an authenticated company user, and only the latest APPROVED data is returned.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import type { Db } from '../providers/db.js';
import type { Principal } from '../providers/auth.js';
import { isCompany, principal, requireRole } from '../lib/authz.js';
import { ApiError, conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { decryptToken, encryptToken, newQrToken, sha256Hex } from '../lib/crypto.js';
import { findRecord, recordDetail, visibleRecord } from './traceability.js';

export async function issueToken(db: Db, key: Buffer, recordId: string, actor: Principal | null, reason: string, cid?: string) {
  const prev = await db.one<{ id: string }>(`SELECT id FROM spir.qr_token WHERE traceability_id = $1 AND status = 'ACTIVE' FOR UPDATE`, [recordId]);
  if (prev) {
    await db.query(`UPDATE spir.qr_token SET status = 'REVOKED', revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1`,
      [prev.id, actor?.userId ?? null, `Replaced: ${reason}`]);
  }
  const token = newQrToken();
  await db.query(
    `INSERT INTO spir.qr_token (traceability_id, token_hash, token_ciphertext, token_hint, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [recordId, sha256Hex(token), encryptToken(key, token), token.slice(-4), actor?.userId ?? null],
  );
  await audit(db, actor, prev ? 'QR_ROTATE' : 'QR_ISSUE', 'traceability', recordId, { reason, replacedTokenId: prev?.id ?? null, hint: token.slice(-4) }, cid);
  return token;
}

/** Called on approval: the first approved version activates the record's QR (spec 4.3 step 7). */
export async function ensureActiveToken(db: Db, key: Buffer, recordId: string, actor: Principal | null, cid?: string) {
  const active = await db.one(`SELECT id FROM spir.qr_token WHERE traceability_id = $1 AND status = 'ACTIVE'`, [recordId]);
  if (active) return { issued: false };
  await issueToken(db, key, recordId, actor, 'First approval', cid);
  return { issued: true };
}

// Simple per-user sliding window (spec 11.3: rate limiting on QR resolution). Per isolate; fine for a PoC.
const hits = new Map<string, number[]>();
function rateLimit(userId: string, limit = 60, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(userId) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(userId, arr);
  if (arr.length > limit) throw new ApiError(429, 'RATE_LIMITED', 'Too many QR lookups. Wait a minute and try again.');
}

const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export function qrRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/qr/:token', async (c) => {
    const p = principal(c);
    if (!isCompany(p)) throw forbidden('QR lookup is for authenticated company users only.');
    rateLimit(p.userId);
    const { db } = c.get('services');
    const token = c.req.param('token');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notFound('QR code');
    const row = await db.one<{ id: string; traceability_id: string; status: string; traceability_code: string; current_approved_version_id: string | null }>(
      `SELECT q.id, q.traceability_id, q.status, t.traceability_code, t.current_approved_version_id
         FROM spir.qr_token q JOIN spir.traceability_record t ON t.id = q.traceability_id WHERE q.token_hash = $1`, [sha256Hex(token)]);
    if (!row) {
      await audit(db, p, 'QR_RESOLVE_UNKNOWN', 'qr_token', null, { hint: token.slice(-4) }, c.get('cid'));
      throw notFound('QR code');
    }
    if (row.status !== 'ACTIVE') {
      await audit(db, p, 'QR_RESOLVE_REVOKED', 'qr_token', row.id, {}, c.get('cid'));
      throw new ApiError(410, 'QR_REVOKED', 'This QR label has been revoked. Ask quality for a replacement label.');
    }
    if (!row.current_approved_version_id) throw notFound('QR code');
    const rec = (await findRecord(db, row.traceability_code))!;
    // Always the approved, published view - regardless of the caller's review privileges (FR-WF-008).
    const detail = await recordDetail(db, { ...p, role: 'QR_USER' }, rec);
    await audit(db, p, 'QR_RESOLVE', 'traceability', row.traceability_id, { traceabilityCode: row.traceability_code }, c.get('cid'));
    return c.json({ ...detail, versions: undefined, resolvedVia: 'QR' });
  });

  // Authorised label printing: reveals the token so a QR label can be printed.
  r.get('/traceability/:code/qr', async (c) => {
    const p = requireRole(c, 'COMPANY_REVIEWER', 'REGISTRY_ADMIN');
    const { db, config } = c.get('services');
    const rec = await visibleRecord(db, p, c.req.param('code'));
    const row = await db.one<{ token_ciphertext: string; token_hint: string; created_at: string }>(
      `SELECT token_ciphertext, token_hint, created_at FROM spir.qr_token WHERE traceability_id = $1 AND status = 'ACTIVE'`, [rec.id]);
    if (!row) throw notFound('Active QR token');
    let token: string;
    try { token = decryptToken(config.qrKey, row.token_ciphertext); } catch {
      throw new ApiError(500, 'QR_KEY_MISMATCH', 'This token was created with a different QR_TOKEN_KEY. Rotate the QR to issue a new one.');
    }
    await audit(db, p, 'QR_LABEL_ACCESS', 'traceability', rec.id, { hint: row.token_hint }, c.get('cid'));
    return c.json({
      token, hint: row.token_hint, createdAt: row.created_at,
      url: config.publicAppUrl ? `${config.publicAppUrl}/#/t/${token}` : null,
    });
  });

  r.post('/traceability/:code/qr/rotate', async (c) => {
    const p = requireRole(c, 'COMPANY_REVIEWER', 'REGISTRY_ADMIN');
    const { db, config } = c.get('services');
    const { reason } = reasonSchema.parse(await c.req.json());
    const rec = await visibleRecord(db, p, c.req.param('code'));
    if (!rec.current_approved_version_id) throw conflict('NOT_PUBLISHED', 'Only published records have QR labels.');
    await db.tx((tx) => issueToken(tx, config.qrKey, rec.id, p, reason, c.get('cid')));
    return c.json({ ok: true });
  });

  r.post('/traceability/:code/qr/revoke', async (c) => {
    const p = requireRole(c, 'COMPANY_REVIEWER', 'REGISTRY_ADMIN');
    const { db } = c.get('services');
    const { reason } = reasonSchema.parse(await c.req.json());
    const rec = await visibleRecord(db, p, c.req.param('code'));
    const n = await db.tx(async (tx) => {
      const rows = await tx.query(
        `UPDATE spir.qr_token SET status = 'REVOKED', revoked_at = now(), revoked_by = $2, revoke_reason = $3
          WHERE traceability_id = $1 AND status = 'ACTIVE' RETURNING id`, [rec.id, p.userId, reason]);
      if (rows.length) await audit(tx, p, 'QR_REVOKE', 'traceability', rec.id, { reason }, c.get('cid'));
      return rows.length;
    });
    if (!n) throw invalid('There is no active QR token to revoke.');
    return c.json({ ok: true });
  });

  return r;
}
