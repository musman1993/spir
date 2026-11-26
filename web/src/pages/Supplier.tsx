import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useLinks, useSession } from '../session';
import { ErrorBox, Loading, useAction, useApi } from '../ui';

/** Pages that add or list shipments need the supplier profile first. */
export function ProfileGate({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const links = useLinks();
  if (me?.supplierId) return <>{children}</>;
  return (
    <div className="empty">
      <h2 style={{ marginTop: 0 }}>Set up your supplier profile first</h2>
      <p>Your company name goes on every shipment and QR label, so SPIR needs it before you add data.</p>
      <Link className="btn primary" to={links.profile}>Set up profile</Link>
    </div>
  );
}

export function SupplierHome() {
  const { me } = useSession();
  const links = useLinks();
  const [d] = useApi<{ records: number; products: number; qrLabels: number }>(me?.supplierId ? '/dashboard' : null);
  if (!me?.supplierId) {
    return (
      <>
        <div className="page-head">
          <h1>Welcome to the supplier portal</h1>
          <p className="lede">Start by telling SPIR who you are. Your supplier name appears on every shipment and QR label.</p>
        </div>
        <ProfileGate><span /></ProfileGate>
      </>
    );
  }
  return (
    <>
      <div className="page-head">
        <h1>{me.supplier?.name}</h1>
        <p className="lede">Add your shipments, then print a QR label for each one. Anyone who scans a label sees its details and certificates.</p>
      </div>
      <ol className="steps">
        <li className="panel">
          <h2>Add shipment data</h2>
          <p className="small">One shipment with the form, or many at once from a CSV file. Saved data is live straight away.</p>
          <div className="row"><Link className="btn primary" to={links.newShipment}>Add a shipment</Link><Link className="btn" to={links.importCsv}>Upload CSV</Link></div>
        </li>
        <li className="panel">
          <h2>Print the QR labels</h2>
          <p className="small">Every shipment gets its own QR code. Print a sheet of labels or download them as images.</p>
          <Link className="btn" to={links.qrLabels}>QR labels</Link>
        </li>
        <li className="panel">
          <h2>Keep it up to date</h2>
          <p className="small">Edit a shipment or upload certificates at any time. Printed labels keep working and show the latest data.</p>
          <Link className="btn" to={links.records}>Shipments</Link>
        </li>
      </ol>
      {d && (
        <div className="stat-row">
          <Link className="stat" to={links.records}><div className="stat-n">{d.records}</div><div className="stat-l">Shipments</div></Link>
          <Link className="stat" to={links.qrLabels}><div className="stat-n">{d.qrLabels}</div><div className="stat-l">Active QR labels</div></Link>
          <div className="stat"><div className="stat-n">{d.products}</div><div className="stat-l">Parts</div></div>
        </div>
      )}
    </>
  );
}

interface ProfileData { code?: string; name: string; country: string; contactName: string; contactEmail: string; contactPhone: string; address: string }
const EMPTY: ProfileData = { name: '', country: '', contactName: '', contactEmail: '', contactPhone: '', address: '' };

export function Profile() {
  const { me, refresh } = useSession();
  const nav = useNavigate();
  const links = useLinks();
  const [data, loadError] = useApi<{ profile: ProfileData | null }>('/supplier/profile');
  const [form, setForm] = useState<ProfileData>(EMPTY);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => { if (data) setForm({ ...EMPTY, ...(data.profile ?? {}) }); }, [data]);
  const first = !me?.supplierId;

  const set = (k: keyof ProfileData) => (e: { target: { value: string } }) => { setSaved(false); setForm({ ...form, [k]: e.target.value }); };
  const save = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api('/supplier/profile', { method: 'PUT', body: form });
      await refresh();
      setSaved(true);
      if (first) nav(links.home);
    });
  };

  if (loadError) return <ErrorBox error={loadError} />;
  if (!data) return <Loading />;
  return (
    <>
      <div className="page-head">
        <h1>Supplier profile</h1>
        <p className="lede">{first ? 'Tell SPIR who you are. This name goes on every shipment and QR label you create.' : 'Changes apply to all your shipments straight away.'}</p>
      </div>
      <form className="panel form-narrow" onSubmit={save}>
        <ErrorBox error={error} />
        {saved && <div className="notice ok">Profile saved.</div>}
        {form.code && <p className="small muted">Supplier ID <span className="id">{form.code}</span></p>}
        <label className="field"><span>Supplier name <span className="req">required</span></span>
          <input value={form.name} onChange={set('name')} placeholder="As on your shipping labels, e.g. Falcon Crest Foundry LLC" required />
        </label>
        <div className="form-row">
          <label className="field">Country (2-letter code)
            <input value={form.country} onChange={set('country')} maxLength={2} placeholder="IN" style={{ textTransform: 'uppercase' }} />
          </label>
          <label className="field">Contact person
            <input value={form.contactName} onChange={set('contactName')} />
          </label>
        </div>
        <div className="form-row">
          <label className="field">Contact email
            <input type="email" value={form.contactEmail} onChange={set('contactEmail')} />
          </label>
          <label className="field">Contact phone
            <input type="tel" value={form.contactPhone} onChange={set('contactPhone')} />
          </label>
        </div>
        <label className="field">Address
          <textarea rows={3} value={form.address} onChange={set('address')} />
        </label>
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn primary" disabled={busy || form.name.trim().length < 2}>{busy ? 'Saving...' : first ? 'Save and continue' : 'Save profile'}</button>
        </div>
      </form>
    </>
  );
}
