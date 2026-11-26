import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../session';
import { ErrorBox, Id, Loading, useAction, useApi } from '../ui';
import { DocumentList, useDefinitions, valueAttrs, type AttrDef } from './shared';

function AttrInput({ d, value, onChange, error }: { d: AttrDef; value: string; onChange: (v: string) => void; error?: string }) {
  const id = `attr-${d.key}`;
  let input;
  if (d.allowedValues?.length) {
    input = (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose...</option>
        {d.allowedValues.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  } else if (d.dataType === 'DATE') input = <input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
  else if (d.dataType === 'DECIMAL' || d.dataType === 'INTEGER') input = <input id={id} type="number" step="any" value={value} onChange={(e) => onChange(e.target.value)} />;
  else if (d.dataType === 'COUNTRY') input = <input id={id} maxLength={2} placeholder="AE" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />;
  else input = <input id={id} className={d.dataType === 'IDENTIFIER' ? 'mono' : ''} value={value} onChange={(e) => onChange(e.target.value)} />;
  return (
    <label className="field" htmlFor={id}>
      <span>{d.label}{d.unit ? ` (${d.unit})` : ''}{d.required ? '' : <span className="hint"> optional</span>}</span>
      {input}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

const fieldErrors = (e: any): Record<string, string> =>
  Object.fromEntries((Array.isArray(e?.details) ? e.details : []).map((d: any) => [d.field, d.message]));

function useSupplierOnly() {
  const { me } = useSession();
  return me!.role === 'SUPPLIER_CONTRIBUTOR';
}

export function NewProduct() {
  const ok = useSupplierOnly();
  const defs = useDefinitions();
  const nav = useNavigate();
  const { busy, error, run } = useAction();
  const [f, setF] = useState({ productName: '', partNumber: '', supplierPartNumber: '' });
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  if (!ok) return <div className="notice warn">Only supplier contributors register products.</div>;
  if (!defs) return <Loading />;
  const errs = fieldErrors(error);
  const save = (submitToo: boolean) => run(async () => {
    const r = await api<{ code: string }>('/products', { body: { categoryCode: 'VALVE_COMPONENT', ...f, supplierPartNumber: f.supplierPartNumber || null, attributes: attrs } });
    if (submitToo) await api(`/products/${r.code}/submit`, { method: 'POST' });
    nav(`/products/${r.code}`);
  });
  return (
    <>
      <div className="page-head">
        <p className="muted small" style={{ marginBottom: 4 }}><Link to="/products">My products</Link></p>
        <h1>Register a product</h1>
        <p className="lede">One product per company part number you supply. Each shipment (PO line, quantity, heats, certificates) is added afterwards as its own record.</p>
      </div>
      <div className="panel stack">
        <div className="form-grid">
          <label className="field">Part number<span className="hint">The company item number, exactly as on the purchase order</span><input className="mono" value={f.partNumber} onChange={(e) => setF({ ...f, partNumber: e.target.value })} placeholder="24B3170X012" /></label>
          <label className="field">Part description<span className="hint">As on the purchase order</span><input value={f.productName} onChange={(e) => setF({ ...f, productName: e.target.value })} placeholder="BODY,GLOBE ~ 2,CL300,RF,WCB" /></label>
          <label className="field"><span>Your own part number <span className="hint">optional</span></span><input className="mono" value={f.supplierPartNumber} onChange={(e) => setF({ ...f, supplierPartNumber: e.target.value })} /></label>
        </div>
        <h3>Product details</h3>
        <div className="form-grid">
          {valueAttrs(defs, 'PRODUCT').map((d) => <AttrInput key={d.key} d={d} value={attrs[d.key] ?? ''} onChange={(v) => setAttrs({ ...attrs, [d.key]: v })} error={errs[d.key]} />)}
        </div>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn" onClick={() => save(false)} disabled={busy}>Save draft</button>
          <button className="btn primary" onClick={() => save(true)} disabled={busy}>Save and submit for review</button>
        </div>
      </div>
    </>
  );
}

export function EditProduct() {
  const { code } = useParams();
  const ok = useSupplierOnly();
  const defs = useDefinitions();
  const nav = useNavigate();
  const [p, loadErr] = useApi<any>(`/products/${code}`);
  const { busy, error, run } = useAction();
  const [f, setF] = useState<{ productName: string } | null>(null);
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!p) return;
    const base = p.versions.find((v: any) => v.status === 'DRAFT') ?? p.approved ?? p.versions[0];
    setF({ productName: base.productName });
    setAttrs(base.attributes ?? {});
  }, [p]);
  if (!ok) return <div className="notice warn">Only supplier contributors edit products.</div>;
  if (loadErr) return <ErrorBox error={loadErr} />;
  if (!p || !defs || !f) return <Loading />;
  const errs = fieldErrors(error);
  const save = (submitToo: boolean) => run(async () => {
    await api(`/products/${code}/draft`, { method: 'PUT', body: { ...f, attributes: attrs } });
    if (submitToo) await api(`/products/${code}/submit`, { method: 'POST' });
    nav(`/products/${code}`);
  });
  return (
    <>
      <div className="page-head">
        <p className="muted small" style={{ marginBottom: 4 }}><Link to={`/products/${code}`}><Id>{code}</Id></Link></p>
        <h1>Change product details</h1>
        <p className="lede">Your change becomes a new version. The approved version stays visible until the company approves this one.</p>
      </div>
      <div className="panel stack">
        <label className="field">Part description<input value={f.productName} onChange={(e) => setF({ ...f, productName: e.target.value })} /></label>
        <div className="form-grid">
          {valueAttrs(defs, 'PRODUCT').map((d) => <AttrInput key={d.key} d={d} value={attrs[d.key] ?? ''} onChange={(v) => setAttrs({ ...attrs, [d.key]: v })} error={errs[d.key]} />)}
        </div>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn" onClick={() => save(false)} disabled={busy}>Save draft</button>
          <button className="btn primary" onClick={() => save(true)} disabled={busy}>Save and submit for review</button>
        </div>
      </div>
    </>
  );
}

const splitList = (s: string) => s.split(/[\s,;|]+/).map((x) => x.trim()).filter(Boolean);

export function EditRecord() {
  const { code } = useParams();
  const [params] = useSearchParams();
  const isNew = !code;
  const ok = useSupplierOnly();
  const defs = useDefinitions();
  const nav = useNavigate();
  const [products] = useApi<{ products: any[] }>(isNew ? '/products' : null);
  const [rec, loadErr, reload] = useApi<any>(isNew ? null : `/traceability/${code}`);
  const { busy, error, run } = useAction();
  const [productCode, setProductCode] = useState(params.get('product') ?? '');
  const [f, setF] = useState({ externalRef: '', heats: '', batches: '', serials: '' });
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  const [upload, setUpload] = useState<{ file: File | null; docType: string; revision: string }>({ file: null, docType: 'MTC', revision: 'A' });

  useEffect(() => {
    if (!rec) return;
    const base = rec.versions.find((v: any) => v.status === 'DRAFT') ?? rec.approved ?? rec.versions[0];
    setF({ externalRef: rec.externalRef ?? '', heats: base.heats.join(', '), batches: base.batches.join(', '), serials: base.serials.join(', ') });
    setAttrs(base.attributes ?? {});
  }, [rec]);

  if (!ok) return <div className="notice warn">Only supplier contributors edit shipment records.</div>;
  if (loadErr) return <ErrorBox error={loadErr} />;
  if (!defs || (!isNew && !rec)) return <Loading />;
  const errs = fieldErrors(error);
  const draft = rec?.versions.find((v: any) => v.status === 'DRAFT');
  const body = { externalRef: f.externalRef || null, heats: splitList(f.heats), batches: splitList(f.batches), serials: splitList(f.serials), attributes: attrs };

  const save = (submitToo: boolean) => run(async () => {
    let c = code;
    if (isNew) {
      if (!productCode) throw new Error('Choose the product this record belongs to.');
      c = (await api<{ code: string }>('/traceability', { body: { productCode, ...body } })).code;
    } else {
      await api(`/traceability/${c}/draft`, { method: 'PUT', body });
    }
    if (submitToo) { await api(`/traceability/${c}/submit`, { method: 'POST' }); nav(`/records/${c}`); }
    else if (isNew) nav(`/records/${c}/edit`);
    else reload();
  });
  const doUpload = () => run(async () => {
    if (!upload.file) throw new Error('Choose a file first.');
    const form = new FormData();
    form.set('file', upload.file); form.set('docType', upload.docType); form.set('revision', upload.revision);
    await api(`/traceability/${code}/documents`, { form });
    setUpload({ ...upload, file: null });
    (document.getElementById('doc-file') as HTMLInputElement).value = '';
    reload();
  });

  return (
    <>
      <div className="page-head">
        <p className="muted small" style={{ marginBottom: 4 }}><Link to="/records">My shipment records</Link>{code && <> / <Link to={`/records/${code}`}><Id>{code}</Id></Link></>}</p>
        <h1>{isNew ? 'Add a shipment record' : 'Edit shipment record'}</h1>
        <p className="lede">One record per shipment of this part against a PO line: the quantity, the heats it was made from, the pattern, any RT report and the certificates. It gets its own QR label once approved.</p>
      </div>
      <div className="panel stack">
        <div className="form-grid">
          {isNew ? (
            <label className="field">Product
              <select value={productCode} onChange={(e) => setProductCode(e.target.value)}>
                <option value="">Choose a product...</option>
                {products?.products.map((p) => <option key={p.code} value={p.code}>{p.partNumber} {p.name}</option>)}
              </select>
            </label>
          ) : <div className="field">Product<div><Id>{rec.product.partNumber}</Id> {rec.product.name}</div></div>}
          <label className="field"><span>Your record reference <span className="hint">optional</span></span><input className="mono" value={f.externalRef} onChange={(e) => setF({ ...f, externalRef: e.target.value })} /></label>
        </div>
        <div className="form-grid">
          <label className="field">Heat numbers<span className="hint">Separate several with commas</span><input className="mono" value={f.heats} onChange={(e) => setF({ ...f, heats: e.target.value })} placeholder="HT-77812, HT-77813" />{errs.heat_number && <span className="field-error">{errs.heat_number}</span>}</label>
          <label className="field"><span>Batch / lot numbers <span className="hint">optional</span></span><input className="mono" value={f.batches} onChange={(e) => setF({ ...f, batches: e.target.value })} /></label>
          <label className="field"><span>Serial numbers <span className="hint">optional</span></span><input className="mono" value={f.serials} onChange={(e) => setF({ ...f, serials: e.target.value })} /></label>
        </div>
        <h3>Shipment details</h3>
        <div className="form-grid">
          {valueAttrs(defs, 'TRACEABILITY').map((d) => <AttrInput key={d.key} d={d} value={attrs[d.key] ?? ''} onChange={(v) => setAttrs({ ...attrs, [d.key]: v })} error={errs[d.key]} />)}
        </div>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn" onClick={() => save(false)} disabled={busy}>Save draft</button>
          <button className="btn primary" onClick={() => save(true)} disabled={busy}>Save and submit for review</button>
        </div>
      </div>
      {!isNew && (
        <section className="panel" style={{ marginTop: 16 }}>
          <h2>Certificates and evidence</h2>
          {draft ? (
            <div className="row" style={{ alignItems: 'flex-end', marginBottom: 14 }}>
              <label className="field">Type
                <select value={upload.docType} onChange={(e) => setUpload({ ...upload, docType: e.target.value })}>
                  <option value="MTC">Material test certificate</option><option value="COC">Certificate of conformance</option><option value="RT_REPORT">Radiographic test report</option>
                  <option value="INSPECTION_REPORT">Inspection report</option><option value="DRAWING">Drawing</option><option value="OTHER">Other</option>
                </select>
              </label>
              <label className="field">Revision<input style={{ width: 70 }} value={upload.revision} onChange={(e) => setUpload({ ...upload, revision: e.target.value })} /></label>
              <label className="field">File (PDF, PNG or JPEG, max 15 MB)<input id="doc-file" type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => setUpload({ ...upload, file: e.target.files?.[0] ?? null })} /></label>
              <button className="btn" onClick={doUpload} disabled={busy || !upload.file}>Upload</button>
            </div>
          ) : <p className="notice">Save a draft first, then upload certificates to it.</p>}
          <DocumentList docs={rec.documents} />
        </section>
      )}
    </>
  );
}
