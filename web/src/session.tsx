import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setApiUser, type Me } from './api';

const KEY = 'spir.demoUser';
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = (v: string | null) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* storage unavailable */ } };

interface Session { me: Me | null; loading: boolean; signIn: (id: string) => Promise<void>; signOut: () => void }
const Ctx = createContext<Session>(null as any);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const signIn = useCallback(async (id: string) => {
    setApiUser(id);
    try {
      setMe(await api<Me>('/me'));
      write(id);
    } catch (e) {
      setApiUser(null); setMe(null); write(null);
      throw e;
    }
  }, []);
  const signOut = useCallback(() => { setApiUser(null); setMe(null); write(null); }, []);

  useEffect(() => {
    // Open mode: the API answers /me without any sign-in (one generic operator). Demo mode: role switcher.
    const saved = read();
    (async () => {
      try { setApiUser(saved); setMe(await api<Me>('/me')); }
      catch { setApiUser(null); write(null); }
      finally { setLoading(false); }
    })();
  }, []);

  return <Ctx.Provider value={{ me, loading, signIn, signOut }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
