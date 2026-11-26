// One session per portal, kept in this browser. Each portal has its own sign-in and its own token, so a
// person can be signed in to the supplier portal in one tab and the company portal in another.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, readToken, writeToken, type Me, type Portal } from './api';

interface Session {
  portal: Portal;
  me: Me | null;
  loading: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => void;
  refresh: () => Promise<void>;
}
const Ctx = createContext<Session>(null as any);

export function PortalSession({ portal, children }: { portal: Portal; children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const signOut = useCallback(() => { writeToken(portal, null); setMe(null); }, [portal]);
  const refresh = useCallback(async () => { setMe(await api<Me>('/me')); }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const { token } = await api<{ token: string }>('/auth/login', { body: { portal, username, password } });
    writeToken(portal, token);
    await refresh();
  }, [portal, refresh]);

  useEffect(() => {
    const saved = readToken(portal);
    setMe(null);
    setLoading(true);
    (async () => {
      try { if (saved) { const m = await api<Me>('/me'); if (m.portal === portal) setMe(m); else signOut(); } }
      catch { signOut(); }
      finally { setLoading(false); }
    })();
    const onOut = (e: Event) => { if ((e as CustomEvent).detail === portal) signOut(); };
    window.addEventListener('spir:signed-out', onOut);
    return () => window.removeEventListener('spir:signed-out', onOut);
  }, [portal, signOut]);

  return <Ctx.Provider value={{ portal, me, loading, signIn, signOut, refresh }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);

/** Addresses inside the current portal. */
export function useLinks() {
  const ctx = useContext(Ctx);
  const portal = ctx?.portal ?? null;
  const base = portal ? `/${portal}` : '';
  return {
    portal,
    home: base || '/',
    records: `${base}/shipments`,
    record: (code: string) => `${base}/shipments/${code}`,
    editRecord: (code: string) => `/supplier/shipments/${code}/edit`,
    newShipment: '/supplier/shipments/new',
    importCsv: '/supplier/import',
    qrLabels: '/supplier/qr-labels',
    profile: '/supplier/profile',
    scan: '/company',
    scanned: (token: string) => (portal === 'company' ? `/company/t/${token}` : `/t/${token}`),
    labelCheck: '/company/label-check',
    checks: '/company/checks',
    check: (code: string) => `/company/checks/${code}`,
  };
}
