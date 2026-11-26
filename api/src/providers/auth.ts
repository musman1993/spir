// AuthenticationProvider: turns a request into a Principal (or null).
// PoC uses DemoHeaderAuth: the web app's role switcher sends `X-SPIR-User: <user id>`.
// This is NOT secure - anyone can claim any demo user. It exists so the authorization rules
// (who may see/approve what) can be demonstrated. Replace with an OIDC / Neon Managed Auth
// provider that verifies a JWT; nothing else in the API needs to change.
import type { Db } from './db.js';

export type Role =
  | 'OPERATOR'
  | 'SUPPLIER_CONTRIBUTOR'
  | 'COMPANY_REVIEWER'
  | 'REGISTRY_ADMIN'
  | 'QR_USER'
  | 'INSPECTOR'
  | 'AUDITOR';

export const COMPANY_ROLES: Role[] = ['OPERATOR', 'COMPANY_REVIEWER', 'REGISTRY_ADMIN', 'QR_USER', 'INSPECTOR', 'AUDITOR'];

export interface Principal {
  userId: string;
  displayName: string;
  role: Role;
  supplierId: string | null;
}

export interface AuthProvider {
  readonly mode: string;
  authenticate(req: Request): Promise<Principal | null>;
}

export function createDemoHeaderAuth(db: Db): AuthProvider {
  return {
    mode: 'demo',
    async authenticate(req) {
      const id = req.headers.get('x-spir-user')?.trim();
      if (!id) return null;
      const u = await db.one<{ id: string; display_name: string; role: Role; supplier_id: string | null }>(
        'SELECT id, display_name, role, supplier_id FROM spir.app_user WHERE id = $1 AND active',
        [id],
      );
      return u ? { userId: u.id, displayName: u.display_name, role: u.role, supplierId: u.supplier_id } : null;
    },
  };
}

/**
 * Open mode (AUTH_MODE=open, the default for now): no sign-in, no roles. Every request is the generic
 * "operator", who may do everything. Anyone who can reach the API can read and change data, so only use
 * it where the network itself is private (e.g. Codespaces with private ports) or with fictional data.
 */
export function createOpenAuth(): AuthProvider {
  const operator: Principal = { userId: 'operator', displayName: 'Operator', role: 'OPERATOR', supplierId: null };
  return { mode: 'open', async authenticate() { return operator; } };
}
