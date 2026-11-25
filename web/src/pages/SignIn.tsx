import { useState } from 'react';
import { API_BASE, ROLE_LABEL, type Role } from '../api';
import { useSession } from '../session';
import { ErrorBox, Loading, TagMark, useApi } from '../ui';

interface DemoUser { id: string; displayName: string; role: Role; supplierName: string | null }

const WHAT_THEY_DO: Record<Role, string> = {
  SUPPLIER_CONTRIBUTOR: 'Registers products and manufacturing records, uploads certificates and submits them for approval.',
  COMPANY_REVIEWER: 'Checks submitted data and evidence, then approves or rejects it. Prints QR labels.',
  REGISTRY_ADMIN: 'Manages attribute definitions, label profiles and QR label lifecycle.',
  QR_USER: 'Scans a QR label and sees the approved record and its certificates.',
  INSPECTOR: 'Photographs existing product stickers and checks them against the approved record.',
  AUDITOR: 'Read-only access to approvals, history and the audit trail.',
};

export function SignIn({ returnTo }: { returnTo: string }) {
  const { signIn } = useSession();
  const [data, error] = useApi<{ users: DemoUser[] }>('/demo-users');
  const [err, setErr] = useState<any>(null);
  const fromQr = returnTo.startsWith('/t/');

  return (
    <div className="signin">
      <div className="signin-head">
        <TagMark />
        <div>
          <h1>Supplier Product Information Registry</h1>
          <p className="lede" style={{ marginBottom: 0 }}>
            Approved product identity, manufacturing traceability and certificates for cast valve bodies, behind one QR label.
          </p>
        </div>
      </div>
      {fromQr && <div className="notice" style={{ marginBottom: 18 }}>You scanned a SPIR QR label. Sign in as a company user to see the record. The QR code on its own doesn't give access.</div>}
      <h2>Choose who you are for this demo</h2>
      <p className="muted small">Real sign-in (company SSO) replaces this screen in production. Each person below sees only what their role allows.</p>
      {error && <div className="notice error">Can't reach the API{API_BASE ? ` at ${API_BASE}` : ''}: {error.message}</div>}
      {!data && !error && <Loading what="Loading demo users" />}
      <ErrorBox error={err} />
      {data && (
        <div className="grid-cols" style={{ marginTop: 14 }}>
          {data.users.map((u) => (
            <button key={u.id} className="persona" onClick={() => signIn(u.id).catch(setErr)}>
              <strong>{u.displayName}</strong>
              <span className="small" style={{ color: 'var(--cobalt)' }}>{ROLE_LABEL[u.role]}{u.supplierName ? `, ${u.supplierName}` : ''}</span>
              <span className="small muted">{WHAT_THEY_DO[u.role]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
