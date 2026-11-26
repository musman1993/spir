// Authorization helpers. Two roles for now: SUPPLIER (one supplier's own data) and COMPANY (everything).
import type { Context } from 'hono';
import type { Principal, Role } from '../providers/auth.js';
import { forbidden, unauthenticated } from './errors.js';
import type { AppEnv } from '../app.js';

export function principal(c: Context<AppEnv>): Principal {
  const p = c.get('principal');
  if (!p) throw unauthenticated();
  return p;
}

export function requireRole(c: Context<AppEnv>, ...roles: Role[]): Principal {
  const p = principal(c);
  if (!roles.includes(p.role)) throw forbidden(p.role === 'SUPPLIER' ? 'This is part of the company portal.' : 'This is part of the supplier portal.');
  return p;
}

export const isSupplier = (p: Principal) => p.role === 'SUPPLIER';
export const isCompany = (p: Principal) => p.role === 'COMPANY';

/** The supplier account must have its profile set before it can add shipments. */
export function requireSupplierProfile(c: Context<AppEnv>): Principal & { supplierId: string } {
  const p = requireRole(c, 'SUPPLIER');
  if (!p.supplierId) throw forbidden('Set up your supplier profile first (Profile page).');
  return p as Principal & { supplierId: string };
}

/** Supplier users only ever reach their own organisation's records. */
export function assertSupplierScope(p: Principal, supplierId: string) {
  if (isSupplier(p) && p.supplierId !== supplierId) throw forbidden('This record belongs to another supplier.');
}
