// Authorization helpers (spec 14.2 / 14.3). Every route checks the principal explicitly.
import type { Context } from 'hono';
import { COMPANY_ROLES, type Principal, type Role } from '../providers/auth.js';
import { forbidden, unauthenticated } from './errors.js';
import type { AppEnv } from '../app.js';

export function principal(c: Context<AppEnv>): Principal {
  const p = c.get('principal');
  if (!p) throw unauthenticated();
  return p;
}

export function requireRole(c: Context<AppEnv>, ...roles: Role[]): Principal {
  const p = principal(c);
  if (!roles.includes(p.role)) throw forbidden(`This action needs one of: ${roles.join(', ')}.`);
  return p;
}

export const isSupplier = (p: Principal) => p.role === 'SUPPLIER_CONTRIBUTOR';
export const isCompany = (p: Principal) => COMPANY_ROLES.includes(p.role);
/** Roles that may see versions that are not approved yet (review, administration, audit). */
export const seesUnpublished = (p: Principal) =>
  p.role === 'COMPANY_REVIEWER' || p.role === 'REGISTRY_ADMIN' || p.role === 'AUDITOR';

/** Supplier users only ever reach their own organisation's records (FR-SUP-004). */
export function assertSupplierScope(p: Principal, supplierId: string) {
  if (isSupplier(p) && p.supplierId !== supplierId) throw forbidden('This record belongs to another supplier.');
}
