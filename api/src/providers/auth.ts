// Authentication: two portals, one account each (RBAC comes later).
//   Supplier portal  username admin / password admin  -> app_user "supplier-admin" (role SUPPLIER)
//   Company portal   username admin / password admin  -> app_user "company-admin"  (role COMPANY)
// A successful login returns a signed session token (HMAC-SHA256, 12 hours) that the web app sends as
// "Authorization: Bearer <token>". The credentials are fixed for this proof of concept: anyone who knows
// them can sign in, so keep real data off a public address until proper accounts arrive.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';

export type Role = 'SUPPLIER' | 'COMPANY';
export type Portal = 'supplier' | 'company';

export interface Principal {
  userId: string;
  displayName: string;
  role: Role;
  supplierId: string | null;
}

export interface AuthProvider {
  readonly mode: string;
  authenticate(req: Request): Promise<Principal | null>;
  login(portal: Portal, username: string, password: string): Promise<{ token: string; expiresAt: string; principal: Principal } | null>;
}

const ACCOUNTS: Record<Portal, { userId: string; username: string; password: string }> = {
  supplier: { userId: 'supplier-admin', username: 'admin', password: 'admin' },
  company: { userId: 'company-admin', username: 'admin', password: 'admin' },
};
const SESSION_HOURS = 12;

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const same = (a: string, b: string) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createPortalAuth(db: Db, secret: string): AuthProvider {
  const sign = (payload: string) => b64(createHmac('sha256', secret).update(payload).digest());

  async function load(userId: string): Promise<Principal | null> {
    const u = await db.one<{ id: string; display_name: string; role: Role; supplier_id: string | null }>(
      `SELECT id, display_name, role, supplier_id FROM spir.app_user WHERE id = $1 AND active AND role IN ('SUPPLIER','COMPANY')`, [userId]);
    return u ? { userId: u.id, displayName: u.display_name, role: u.role, supplierId: u.supplier_id } : null;
  }

  return {
    mode: 'portals',
    async login(portal, username, password) {
      const acct = ACCOUNTS[portal];
      if (!acct) return null;
      // Compare both values every time so a wrong username and a wrong password take the same time.
      const ok = [same(username.trim(), acct.username), same(password, acct.password)].every(Boolean);
      if (!ok) return null;
      const principal = await load(acct.userId);
      if (!principal) return null;
      const exp = Date.now() + SESSION_HOURS * 3600_000;
      const payload = b64(JSON.stringify({ u: acct.userId, exp }));
      return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(exp).toISOString(), principal };
    },
    async authenticate(req) {
      const m = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(req.headers.get('authorization') ?? '');
      if (!m) return null;
      const [, payload, sig] = m;
      if (!same(sig, sign(payload))) return null;
      let data: { u?: string; exp?: number };
      try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
      if (!data.u || !data.exp || data.exp < Date.now()) return null;
      return load(data.u);
    },
  };
}
