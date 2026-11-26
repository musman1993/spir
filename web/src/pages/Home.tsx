import { Link } from 'react-router-dom';
import { ROLE_LABEL } from '../api';
import { useSession } from '../session';
import { ErrorBox, Loading, useApi } from '../ui';

interface Stats { products: number; records: number; pending: number; drafts: number; rejected: number; validationRuns: number; openDiscrepancies: number }

export function Home() {
  const { me } = useSession();
  const [s, error] = useApi<Stats>('/dashboard');
  const supplier = me!.role === 'SUPPLIER_CONTRIBUTOR';
  const reviewer = ['COMPANY_REVIEWER', 'REGISTRY_ADMIN', 'AUDITOR'].includes(me!.role);
  const inspector = ['INSPECTOR', 'COMPANY_REVIEWER', 'REGISTRY_ADMIN'].includes(me!.role);

  return (
    <>
      <div className="page-head">
        <h1>Good to see you, {me!.displayName.split(' ')[0]}</h1>
        <p className="lede">
          {supplier && `You're working for ${me!.supplier?.name}. Keep your product and shipment records up to date; nothing is published until the company approves it.`}
          {me!.role === 'COMPANY_REVIEWER' && 'Submitted changes wait for your decision. Approved records become visible to everyone scanning a QR label.'}
          {me!.role === 'REGISTRY_ADMIN' && 'You manage the registry configuration and QR label lifecycle.'}
          {me!.role === 'QR_USER' && 'Scan a SPIR QR label to see the approved product, manufacturing details and certificates.'}
          {me!.role === 'INSPECTOR' && 'Photograph a product sticker and SPIR compares what it says with the approved record.'}
          {me!.role === 'AUDITOR' && 'Everything here is read-only for you, including the full audit trail.'}
        </p>
      </div>
      <ErrorBox error={error} />
      {!s && !error && <Loading />}
      {s && (
        <div className="grid-cols">
          <Link className="stat" to="/products"><div className="stat-n">{s.products}</div><div className="stat-l">Products</div></Link>
          <Link className="stat" to="/records"><div className="stat-n">{s.records}</div><div className="stat-l">Shipment records</div></Link>
          {(reviewer || supplier) && <Link className="stat" to={reviewer ? '/review' : '/records'}><div className="stat-n">{s.pending}</div><div className="stat-l">Waiting for company review</div></Link>}
          {supplier && <Link className="stat" to="/records"><div className="stat-n">{s.drafts}</div><div className="stat-l">Drafts not yet submitted</div></Link>}
          {supplier && s.rejected > 0 && <Link className="stat" to="/records"><div className="stat-n" style={{ color: 'var(--hold)' }}>{s.rejected}</div><div className="stat-l">Rejected, need correction</div></Link>}
          {!supplier && <Link className="stat" to="/validations"><div className="stat-n">{s.validationRuns}</div><div className="stat-l">Label checks run</div></Link>}
          {!supplier && <Link className="stat" to="/validations"><div className="stat-n">{s.openDiscrepancies}</div><div className="stat-l">Open label discrepancies</div></Link>}
        </div>
      )}
      <div className="panel" style={{ marginTop: 20 }}>
        <h2>What you can do as a {ROLE_LABEL[me!.role].toLowerCase()}</h2>
        <div className="row">
          {supplier && <><Link className="btn primary" to="/products/new">Register a product</Link><Link className="btn" to="/records/new">Add a shipment record</Link></>}
          {reviewer && <Link className="btn primary" to="/review">Open the review queue</Link>}
          {!supplier && <Link className="btn" to="/scan">Scan a QR label</Link>}
          {inspector && <Link className="btn primary" to="/label-check">Check a product label</Link>}
          {me!.role === 'AUDITOR' && <Link className="btn" to="/audit">Read the audit trail</Link>}
        </div>
      </div>
    </>
  );
}
