import { useEffect, useState } from 'react';
import { loadBrandLogo } from '../qr/brand';
import { renderQr, svgDataUrl } from '../qr/render';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, qrLinkFor } from '../api';
import { useLinks, useSession } from '../session';
import { Chip, ErrorBox, Id, Loading, Modal, fmtDate, useAction, useApi } from '../ui';
import { AttributeList, DocumentList, useDefinitions, useSearch } from './shared';

export function Records() {
  const { me } = useSession();
  const links = useLinks();
  const [q, setQ, dq] = useSearch();
  const [data, error] = useApi<{ records: any[] }>(`/traceability?q=${encodeURIComponent(dq)}`);
  const supplier = me!.role === 'SUPPLIER';
  return (
    <>
      <div className="spread page-head">
        <div>
          <h1>{supplier ? 'Shipments' : 'Search shipments'}</h1>
          <p className="lede">{supplier
            ? 'Each shipment is one part against one PO line, with its own QR label.'
            : 'Every supplier\'s shipments. Search by PO, part number, heat number or record ID.'}</p>
        </div>
        {supplier && <div className="row"><Link className="btn primary" to={links.newShipment}>Add a shipment</Link><Link className="btn" to={links.importCsv}>Upload CSV</Link></div>}
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="search" type="search" placeholder="Search by PO, part number, heat or record ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search records" />
      </div>
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data && (data.records.length === 0 ? <div className="empty">{dq ? 'No shipments match.' : supplier ? <>No shipments yet. <Link to={links.newShipment}>Add one</Link> or <Link to={links.importCsv}>upload a CSV</Link>.</> : 'No shipments yet.'}</div> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Record</th><th>Part number</th><th>PO / line</th><th>Qty</th><th>Heats</th>{!supplier && <th>Supplier</th>}<th>Version</th><th>QR</th></tr></thead>
            <tbody>
              {data.records.map((r) => (
                <tr key={r.code}>
                  <td><Link to={links.record(r.code)}><Id>{r.code}</Id></Link></td>
                  <td><Id>{r.partNumber}</Id><div className="small muted">{r.productName}</div></td>
                  <td className="nobr"><Id>{r.purchaseOrder ?? "-"}</Id>{r.poLine ? <span className="small muted"> / {r.poLine}</span> : null}</td>
                  <td>{r.quantity ?? '-'}</td>
                  <td><Id>{(r.heats ?? []).join(', ')}</Id></td>
                  {!supplier && <td>{r.supplierName}</td>}
                  <td className="small">{r.latestVersion ? `v${r.latestVersion}` : '-'}</td>
                  <td>{r.hasQr ? 'Active' : <span className="muted">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

/** The hang tag: the approved identity of one shipment record. */
export function HangTag({ rec, version }: { rec: any; version: any }) {
  const a = version?.attributes ?? {};
  return (
    <div className="tag">
      <div className="tag-code">{rec.code}</div>
      <div className="tag-title">{rec.product?.name}</div>
      <dl className="facts">
        <dt>Part number</dt><dd><Id>{rec.product?.partNumber}</Id>{rec.product?.attributes?.design_revision ? <> Rev <Id>{rec.product.attributes.design_revision}</Id></> : null}</dd>
        <dt>PO / line</dt><dd><Id>{a.purchase_order_number ?? '-'}</Id>{a.po_line_number ? <> line <Id>{a.po_line_number}</Id></> : null}</dd>
        <dt>Quantity</dt><dd>{a.quantity ?? '-'}</dd>
        <dt>Heats</dt><dd className="tag-heats">{version?.heats?.length ? version.heats.map((h: string) => <span key={h}>{h}</span>) : '-'}</dd>
        <dt>Pattern</dt><dd><Id>{a.pattern_number ?? '-'}</Id></dd>
        {a.radiographic_test_number && <><dt>RT report</dt><dd><Id>{a.radiographic_test_number}</Id></dd></>}
        {rec.product?.attributes?.material && <><dt>Material</dt><dd>{rec.product.attributes.material}</dd></>}
        <dt>Supplier</dt><dd>{rec.supplier?.name}</dd>
      </dl>
    </div>
  );
}

function QrPanel({ rec, onChange }: { rec: any; onChange: () => void }) {
  const links = useLinks();
  const [label, setLabel] = useState<{ token: string; img: string } | null>(null);
  const [modal, setModal] = useState<'rotate' | 'revoke' | null>(null);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();

  const show = () => run(async () => {
    const r = await api<{ token: string }>(`/traceability/${rec.code}/qr`);
    const art = await renderQr(qrLinkFor(r.token), await loadBrandLogo(), 4);
    setLabel({ token: r.token, img: svgDataUrl(art.svg) });
  });
  const act = () => run(async () => {
    await api(`/traceability/${rec.code}/qr/${modal}`, { body: { reason } });
    setModal(null); setReason(''); setLabel(null); onChange();
  });

  return (
    <section className="panel">
      <h2>QR label</h2>
      {rec.qr ? <p className="small">Active label ending in <Id>{rec.qr.hint}</Id>, issued {fmtDate(rec.qr.createdAt)}. The code holds only a random token, no product data.</p>
        : <p className="small muted">No active QR label. Use "Replace label" to issue a new one.</p>}
      <ErrorBox error={error} />
      {label && (
        <div className="print-label" style={{ margin: '10px 0' }}>
          <img src={label.img} alt={`QR label for ${rec.code}`} />
          <div>
            <div className="id" style={{ fontSize: '1.15rem' }}>{rec.code}</div>
            <div className="small">{rec.product?.name}</div>
            <div className="small">Part <Id>{rec.product?.partNumber}</Id>, PO <Id>{rec.approved?.attributes?.purchase_order_number}</Id> / {rec.approved?.attributes?.po_line_number}</div>
            <div className="small">Heat <Id>{rec.approved?.heats?.join(', ')}</Id>, qty {rec.approved?.attributes?.quantity}</div>
            <div className="small muted" style={{ marginTop: 6 }}>Scan with any phone camera to see this shipment.</div>
          </div>
        </div>
      )}
      <div className="row no-print">
        {rec.qr && !label && <button className="btn" onClick={show} disabled={busy}>Show printable label</button>}
        {label && <button className="btn primary" onClick={() => window.print()}>Print label</button>}
        {label && <Link className="btn" to={links.scanned(label.token)}>Open as scanned</Link>}
        {rec.approved && <button className="btn" onClick={() => setModal('rotate')}>Replace label</button>}
        {rec.qr && <button className="btn hold" onClick={() => setModal('revoke')}>Revoke label</button>}
      </div>
      {modal && (
        <Modal title={modal === 'rotate' ? 'Replace QR label' : 'Revoke QR label'} onClose={() => setModal(null)}>
          <p>{modal === 'rotate'
            ? 'A new QR code is issued and the old label stops working. The shipment keeps its record ID and data.'
            : 'The label stops resolving immediately. Scanners will see "revoked". You can issue a new label later with "Replace label".'}</p>
          <label className="field">Reason (kept in the audit trail)
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Label damaged during handling" autoFocus />
          </label>
          <div className="row" style={{ marginTop: 12 }}>
            <button className={modal === 'rotate' ? 'btn primary' : 'btn hold'} onClick={act} disabled={busy || reason.trim().length < 3}>{modal === 'rotate' ? 'Replace label' : 'Revoke label'}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

const DOC_TYPES: [string, string][] = [['MTC', 'Material test certificate (MTC)'], ['COC', 'Certificate of conformance (CoC)'], ['RT_REPORT', 'Radiographic test report'], ['INSPECTION_REPORT', 'Inspection report'], ['DRAWING', 'Drawing'], ['OTHER', 'Other']];

function UploadDocument({ code, onDone }: { code: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState('MTC');
  const [key, setKey] = useState(0);
  const { busy, error, run } = useAction();
  const upload = () => run(async () => {
    const form = new FormData();
    form.set('file', file!); form.set('docType', type);
    await api(`/traceability/${code}/documents`, { form });
    setFile(null); setKey((k) => k + 1); onDone();
  });
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <ErrorBox error={error} />
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: '1 1 220px' }}>Document type
          <select value={type} onChange={(e) => setType(e.target.value)}>{DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="field" style={{ flex: '1 1 220px' }}>File (PDF, PNG or JPEG, up to 15 MB)
          <input key={key} type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <button className="btn primary" onClick={upload} disabled={!file || busy} style={{ marginBottom: 12 }}>{busy ? 'Uploading...' : 'Upload'}</button>
      </div>
    </div>
  );
}

export function RecordDetail() {
  const { code } = useParams();
  const { me } = useSession();
  const links = useLinks();
  const loc = useLocation();
  const saved = (loc.state as { saved?: string } | null)?.saved;
  const defs = useDefinitions();
  const [rec, error, reload] = useApi<any>(`/traceability/${code}`);
  useEffect(() => { window.scrollTo(0, 0); }, [code]);
  if (error) return <ErrorBox error={error} />;
  if (!rec) return <Loading />;
  const supplier = me!.role === 'SUPPLIER';
  const shown = rec.approved ?? rec.versions[0];

  return (
    <>
      <div className="spread page-head">
        <div>
          <p className="muted small" style={{ marginBottom: 4 }}><Link to={links.records}>{supplier ? 'Shipments' : 'Search shipments'}</Link></p>
          <h1>Shipment <Id>{rec.code}</Id></h1>
          <div className="row">{shown && <span className="small muted">Version {shown.versionNo}, updated {fmtDate(shown.createdAt)}</span>}</div>
        </div>
        {supplier && <div className="row"><Link className="btn primary" to={links.editRecord(rec.code)}>Edit shipment</Link></div>}
      </div>
      {saved === 'created' && <div className="notice ok" style={{ marginBottom: 16 }}>Shipment saved and its QR code created. Print the label below, and upload the certificates.</div>}
      {saved === 'updated' && <div className="notice ok" style={{ marginBottom: 16 }}>Changes saved as version {shown?.versionNo}. They are live now, and the printed QR label shows them.</div>}
      {saved === 'unchanged' && <div className="notice" style={{ marginBottom: 16 }}>Nothing changed, so no new version was made.</div>}
      <div className="grid-2">
        <div className="stack">
          {shown && <HangTag rec={rec} version={shown} />}
          <section className="panel">
            <h2>Shipment details</h2>
            <AttributeList defs={defs} scope="TRACEABILITY" values={shown?.attributes ?? {}} />
          </section>
          <section className="panel">
            <h2>Certificates</h2>
            <DocumentList docs={rec.documents} />
            {supplier && <UploadDocument code={rec.code} onDone={reload} />}
          </section>
        </div>
        <div className="stack">
          {supplier && <QrPanel rec={rec} onChange={reload} />}
          <section className="panel">
            <h2>Version history</h2>
            <ol className="timeline">
              {rec.versions.map((v: any) => (
                <li key={v.id} className={v.status}>
                  <div className="row"><strong>Version {v.versionNo}</strong>{v.status === 'APPROVED' ? <span className="small muted">current</span> : <Chip status={v.status} />}</div>
                  <div className="small">PO <Id>{v.attributes?.purchase_order_number ?? '-'}</Id>{v.attributes?.po_line_number ? `/${v.attributes.po_line_number}` : ''}, qty {v.attributes?.quantity ?? '-'}, heat <Id>{v.heats.join(', ') || '-'}</Id></div>
                  <div className="small muted">Saved {fmtDate(v.createdAt)}</div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </>
  );
}
