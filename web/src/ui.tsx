import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

/** Load data from the API; returns [data, error, reload]. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setError(null);
    api<T>(path).then((d) => live && setData(d)).catch((e) => live && setError(e));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return [data, error, reload, setData] as const;
}

/** Run an action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e: any) { setError(e instanceof ApiError ? e : new ApiError(0, 'CLIENT', e?.message ?? String(e))); return undefined; }
    finally { setBusy(false); }
  }, []);
  return { busy, error, run, setError };
}

export function ErrorBox({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const details = Array.isArray(error.details) ? error.details : null;
  return (
    <div className="notice error" role="alert">
      {error.message}
      {details && <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{details.map((d: any, i: number) => <li key={i}>{d.message ?? JSON.stringify(d)}</li>)}</ul>}
    </div>
  );
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <p className="muted"><span className="spin" /> {what}...</p>;
}

export function Chip({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const label: Record<string, string> = { APPROVED: 'Approved', PENDING: 'Pending review', DRAFT: 'Draft', REJECTED: 'Rejected', SUPERSEDED: 'Superseded', WITHDRAWN: 'Withdrawn', REVOKED: 'Revoked' };
  return <span className={`chip ${status}`}>{label[status] ?? status}</span>;
}

export const RESULT_LABEL: Record<string, string> = {
  MATCH: 'Match', MISMATCH: 'Mismatch', LOW_CONFIDENCE: 'Low confidence', UNREADABLE: 'Unreadable',
  MISSING_ON_LABEL: 'Missing on label', MISSING_IN_REGISTRY: 'Missing in registry', NOT_APPLICABLE: 'Not applicable',
  NOT_CHECKED: 'Not checked', REVIEW_REQUIRED: 'Review required',
  PASS: 'Pass', FAIL: 'Fail', PASS_WITH_WARNINGS: 'Pass with warnings', NEEDS_REVIEW: 'Needs review', UNRESOLVED: 'Unresolved',
  PENDING_SYNCHRONIZATION: 'Pending sync',
};
const MARK: Record<string, string> = { MATCH: '✓', PASS: '✓', MISMATCH: '✕', FAIL: '✕' };

export function Stamp({ result, big }: { result: string; big?: boolean }) {
  return <span className={`stamp ${result}${big ? ' big' : ''}`}>{MARK[result] ? <span aria-hidden>{MARK[result]}</span> : null}{RESULT_LABEL[result] ?? result}</span>;
}

export const Id = ({ children }: { children: ReactNode }) => <span className="id">{children}</span>;

export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '-');
export const fmtDay = (s: string | null | undefined) => (s ? new Date(s.length === 10 ? s + 'T00:00:00' : s).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '-');
export const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function TagMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 30 36" aria-hidden>
      <path d="M9 1h20v34H9L1 27V9z" fill="#FFF4E6" stroke="#F79428" strokeWidth="1.5" />
      <circle cx="9" cy="18" r="3.2" fill="#004B8D" />
      <path d="M14 10h11M14 15h8M14 21h11M14 26h6" stroke="#004B8D" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(34,39,43,.45)', display: 'grid', placeItems: 'center', zIndex: 50, padding: 16 }}>
      <div className="panel" style={{ width: 'min(560px, 100%)', maxHeight: '90vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="spread"><h2>{title}</h2><button className="btn small" onClick={onClose}>Close</button></div>
        {children}
      </div>
    </div>
  );
}
