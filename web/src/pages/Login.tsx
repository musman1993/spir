import { useState, type FormEvent } from 'react';
import type { Portal } from '../api';
import { useSession } from '../session';
import { ErrorBox, TagMark } from '../ui';

const COPY: Record<Portal, { title: string; lede: string }> = {
  supplier: { title: 'Supplier portal', lede: 'Enter your shipment data and print QR labels for your parts.' },
  company: { title: 'Company portal', lede: 'Scan QR labels, search shipments and check supplier labels.' },
};

export function Login({ portal }: { portal: Portal }) {
  const { signIn } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await signIn(username, password); } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={submit} aria-labelledby="login-title">
        <div className="login-brand">
          <TagMark className="brand-mark" />
          <div><div className="login-name">SPIR</div><div className="small muted">Supplier product information registry</div></div>
        </div>
        <h1 id="login-title">{COPY[portal].title}</h1>
        <p className="lede">{COPY[portal].lede}</p>
        <ErrorBox error={error} />
        <label className="field">Username
          <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </label>
        <label className="field">Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="btn primary login-btn" disabled={busy || !username || !password}>{busy ? 'Signing in...' : 'Sign in'}</button>
        <p className="small muted" style={{ marginTop: 14 }}>Proof of concept: the default sign-in is <strong>admin</strong> / <strong>admin</strong>.</p>
      </form>
    </div>
  );
}
