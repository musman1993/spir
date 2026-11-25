// Thin API client. The demo role switcher's user id travels in X-SPIR-User.
// VITE_API_BASE_URL points at the Neon Function in production; in dev the Vite proxy forwards /api.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

let currentUser: string | null = null;
export const setApiUser = (id: string | null) => { currentUser = id; };

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (currentUser) headers['X-SPIR-User'] = currentUser;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  } catch {
    throw new ApiError(0, 'NETWORK', `Can't reach the SPIR API at ${API_BASE || 'this site'}. Check that it is running.`);
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? 'HTTP_' + res.status, e?.message ?? `Request failed (${res.status}).`, e?.details);
  }
  return json as T;
}

/** Base URL of this web app, used to build QR label links (works on Pages, Codespaces and localhost). */
export const appBaseUrl = () => window.location.href.split('#')[0].replace(/\/+$/, '').replace(/\/index\.html$/, '');
export const qrLinkFor = (token: string) => `${appBaseUrl()}/#/t/${token}`;

export type Role = 'SUPPLIER_CONTRIBUTOR' | 'COMPANY_REVIEWER' | 'REGISTRY_ADMIN' | 'QR_USER' | 'INSPECTOR' | 'AUDITOR';
export interface Me { userId: string; displayName: string; role: Role; supplierId: string | null; supplier: { code: string; name: string } | null }
export const ROLE_LABEL: Record<Role, string> = {
  SUPPLIER_CONTRIBUTOR: 'Supplier contributor',
  COMPANY_REVIEWER: 'Company reviewer',
  REGISTRY_ADMIN: 'Registry administrator',
  QR_USER: 'QR user',
  INSPECTOR: 'Label inspector',
  AUDITOR: 'Auditor',
};
