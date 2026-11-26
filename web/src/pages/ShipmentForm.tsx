// Add or edit one shipment. Saved data is live at once; an edit becomes a new version under the same QR code.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useLinks, useSession } from '../session';
import { ErrorBox, Id, Loading, useApi } from '../ui';

interface Form {
  partNumber: string; designRevision: string; partDescription: string; material: string; supplierPartNumber: string;
  purchaseOrder: string; poLine: string; quantity: string; heats: string; patternNumber: string;
  radiographicTestNumber: string; countryOfOrigin: string;
}
const EMPTY: Form = {
  partNumber: '', designRevision: '', partDescription: '', material: '', supplierPartNumber: '',
  purchaseOrder: '', poLine: '', quantity: '', heats: '', patternNumber: '', radiographicTestNumber: '', countryOfOrigin: '',
};
const splitHeats = (s: string) => [...new Set(s.split(/[,|\n;]+/).map((h) => h.trim()).filter(Boolean))];

export function ShipmentForm() {
  const { code } = useParams();
  const editing = !!code;
  const nav = useNavigate();
  const links = useLinks();
  const { me } = useSession();
  const [rec, loadError] = useApi<any>(editing ? `/traceability/${code}` : null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!rec) return;
    const a = rec.approved?.attributes ?? {};
    const pa = rec.product?.attributes ?? {};
    setForm({
      partNumber: rec.product?.partNumber ?? '', designRevision: pa.design_revision ?? '', partDescription: rec.product?.name ?? '',
      material: pa.material ?? '', supplierPartNumber: rec.product?.supplierPartNumber ?? '',
      purchaseOrder: a.purchase_order_number ?? '', poLine: a.po_line_number ?? '', quantity: a.quantity ?? '',
      heats: (rec.approved?.heats ?? []).join(', '), patternNumber: a.pattern_number ?? '',
      radiographicTestNumber: a.radiographic_test_number ?? '', countryOfOrigin: a.country_of_origin ?? pa.country_of_origin ?? '',
    });
  }, [rec]);

  const heats = useMemo(() => splitHeats(form.heats), [form.heats]);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setFieldErrors((fe) => { const n = { ...fe }; delete n[k === 'heats' ? 'heatNumbers' : k]; return n; });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setFieldErrors({});
    const { heats: _h, ...rest } = form;
    const body = { ...rest, heatNumbers: heats };
    try {
      const r = await api<{ code: string; created: boolean; changed: boolean }>(
        editing ? `/supplier/shipments/${code}` : '/supplier/shipments', { method: editing ? 'PUT' : 'POST', body });
      nav(links.record(r.code), { state: { saved: r.created ? 'created' : r.changed ? 'updated' : 'unchanged' } });
    } catch (err) {
      const ae = err as ApiError;
      const per: Record<string, string> = {};
      for (const d of (Array.isArray(ae.details) ? ae.details : [])) if (d?.field) per[d.field] ??= d.message;
      setFieldErrors(per);
      setError(Object.keys(per).length ? new ApiError(ae.status, ae.code, 'Please fix the marked fields.') : ae);
      window.scrollTo(0, 0);
    } finally { setBusy(false); }
  };

  if (loadError) return <ErrorBox error={loadError} />;
  if (editing && !rec) return <Loading />;

  const F = ({ k, label, required, hint, locked, ...input }: { k: keyof Form; label: string; required?: boolean; hint?: string; locked?: boolean } & Record<string, any>) => {
    const errKey = k === 'heats' ? 'heatNumbers' : k;
    return (
      <label className="field">
        <span>{label}{required && <span className="req">required</span>}</span>
        <input value={form[k]} onChange={set(k)} readOnly={locked} aria-invalid={!!fieldErrors[errKey]} className={input.mono ? 'mono' : undefined}
          style={locked ? { background: 'var(--neutral-wash)' } : undefined} placeholder={input.placeholder} maxLength={input.maxLength} inputMode={input.inputMode} />
        {locked && <span className="locked-note">Identifies the shipment and its QR code, so it can't change here.</span>}
        {hint && !locked && <span className="small muted">{hint}</span>}
        {fieldErrors[errKey] && <span className="field-error">{fieldErrors[errKey]}</span>}
      </label>
    );
  };

  return (
    <>
      <div className="page-head">
        <p className="muted small" style={{ marginBottom: 4 }}><Link to={links.records}>Shipments</Link>{editing && <> / <Link to={links.record(code!)}><Id>{code}</Id></Link></>}</p>
        <h1>{editing ? <>Edit shipment <Id>{code}</Id></> : 'Add a shipment'}</h1>
        <p className="lede">{editing
          ? 'Saving creates a new version. It is live at once: the printed QR label keeps working and shows the new data.'
          : <>One part against one PO line, for <strong>{me?.supplier?.name}</strong>. Saving creates the shipment and its QR code straight away.</>}</p>
      </div>
      <form className="stack form-narrow" onSubmit={submit} noValidate>
        <ErrorBox error={error} />
        <section className="panel">
          <h2>Part</h2>
          <div className="form-row">
            {F({ k: 'partNumber', label: 'Part number', required: true, mono: true, placeholder: '24B3170X012', locked: editing })}
            {F({ k: 'designRevision', label: 'Design revision', placeholder: 'C', maxLength: 20 })}
          </div>
          {F({ k: 'partDescription', label: 'Part description', required: true, placeholder: 'BODY,GLOBE ~ 2,CL300,RF,WCB' })}
          <div className="form-row">
            {F({ k: 'material', label: 'Material', placeholder: 'ASTM A216 WCB' })}
            {F({ k: 'supplierPartNumber', label: 'Your own part number', mono: true, hint: 'Optional, if it differs from the part number' })}
          </div>
        </section>
        <section className="panel">
          <h2>Order</h2>
          <div className="form-row">
            {F({ k: 'purchaseOrder', label: 'PO number', required: true, mono: true, placeholder: '7700104512', locked: editing })}
            {F({ k: 'poLine', label: 'PO line', required: true, inputMode: 'numeric', placeholder: '1', locked: editing })}
          </div>
          <div className="form-row">
            {F({ k: 'quantity', label: 'Quantity', required: true, inputMode: 'numeric', placeholder: '3', hint: 'Pieces shipped on this PO line' })}
            {F({ k: 'countryOfOrigin', label: 'Country of origin', placeholder: 'IN', maxLength: 2, hint: '2-letter code' })}
          </div>
        </section>
        <section className="panel">
          <h2>Traceability</h2>
          {F({ k: 'heats', label: 'Heat numbers', required: true, mono: true, placeholder: 'HT-77812, HT-77813', hint: 'Several? Separate them with commas.' })}
          {heats.length > 0 && <div className="heat-chips" aria-label="Heat numbers">{heats.map((h) => <span key={h}>{h}</span>)}</div>}
          <div className="form-row" style={{ marginTop: 10 }}>
            {F({ k: 'patternNumber', label: 'Pattern number', required: true, mono: true, placeholder: 'PT-2417-A' })}
            {F({ k: 'radiographicTestNumber', label: 'Radiographic test (RT) number', mono: true, placeholder: 'RT-2026-0311' })}
          </div>
        </section>
        <div className="row">
          <button className="btn primary" disabled={busy}>{busy ? 'Saving...' : editing ? 'Save changes' : 'Save and create QR code'}</button>
          <Link className="btn" to={editing ? links.record(code!) : links.records}>Cancel</Link>
          {!editing && <span className="small muted">Certificates (MTC, CoC, RT report) can be uploaded on the next page.</span>}
        </div>
      </form>
    </>
  );
}
