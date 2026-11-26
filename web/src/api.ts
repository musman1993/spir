// Thin API client. The signed-in portal's session token travels as "Authorization: Bearer <token>".
// VITE_API_BASE_URL points at the Neon Function in production; in dev the Vite proxy forwards /api.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

// Each portal keeps its own session token. Which one a request uses is decided by the address it is made
// from (#/supplier/... or #/company/...), so the two sessions can never be mixed up, even in one browser.
// The public scan page (#/t/...) sends no token.
const memory = new Map<string, string>(); // fallback when localStorage is unavailable
const tokenKey = (portal: Portal) => `spir.session.${portal}`;
export function portalFromAddress(): Portal | null {
  const h = window.location.hash;
  return h.startsWith('#/supplier') ? 'supplier' : h.startsWith('#/company') ? 'company' : null;
}
export function readToken(portal: Portal): string | null {
  try { return localStorage.getItem(tokenKey(portal)) ?? memory.get(portal) ?? null; } catch { return memory.get(portal) ?? null; }
}
export function writeToken(portal: Portal, token: string | null) {
  if (token) memory.set(portal, token); else memory.delete(portal);
  try { token ? localStorage.setItem(tokenKey(portal), token) : localStorage.removeItem(tokenKey(portal)); } catch { /* memory only */ }
}
const currentToken = () => { const p = portalFromAddress(); return p ? readToken(p) : null; };
/** Headers for a raw fetch (file downloads) made outside api(). */
export const authHeaders = (): Record<string, string> => { const t = currentToken(); return t ? { Authorization: `Bearer ${t}` } : {}; };

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = currentToken();
  if (token) headers.Authorization = `Bearer ${token}`;
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
    // An expired or invalid session: tell the portal to show its sign-in page again.
    if (res.status === 401 && token && path !== '/auth/login') window.dispatchEvent(new CustomEvent('spir:signed-out', { detail: portalFromAddress() }));
    throw new ApiError(res.status, e?.code ?? 'HTTP_' + res.status, e?.message ?? `Request failed (${res.status}).`, e?.details);
  }
  return json as T;
}

/** Base URL of this web app, used to build QR label links (works on Pages, Codespaces and localhost). */
export const appBaseUrl = () => window.location.href.split('#')[0].replace(/\/+$/, '').replace(/\/index\.html$/, '');
export const qrLinkFor = (token: string) => `${appBaseUrl()}/#/t/${token}`;

export type Role = 'SUPPLIER' | 'COMPANY';
export type Portal = 'supplier' | 'company';
export interface Me { userId: string; displayName: string; role: Role; portal: Portal; supplierId: string | null; supplier: { code: string; name: string } | null }
