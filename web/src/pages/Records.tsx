import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Link, useParams } from 'react-router-dom';
import { api, qrLinkFor } from '../api';
import { useSession } from '../session';
import { Chip, ErrorBox, Id, Loading, Modal, fmtDate, fmtDay, useAction, useApi } from '../ui';
import { AttributeList, DocumentList, useDefinitions, useSearch } from './shared';

export function Records() {
  const { me } = useSession();
  const [q, setQ, dq] = useSearch();
  const [data, error] = useApi<{ records: any[] }>(`/traceability?q=${encodeURIComponent(dq)}`);
  const supplier = me!.role === 'SUPPLIER_CONTRIBUTOR';
  return (
    <>
      <div className="spread page-head">
        <div>
          <h1>{supplier ? 'My traceability records' : 'Traceability records'}</h1>
          <p className="lede">Each record is one manufacturing context (heats, batches, serials, certificates) for one product, with its own QR label.</p>
        </div>
        {supplier && <Link className="btn primary" to="/records/new">Add a manufacturing record</Link>}
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="search" type="search" placeholder="Search by record ID, product ID, heat or supplier ref" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search records" />
      </div>
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data && (data.records.length === 0 ? <div className="empty">No records match.</div> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Record</th><th>Product</th><th>Heats</th><th>Manufactured</th>{!supplier && <th>Supplier</th>}<th>Status</th><th>QR</th></tr></thead>
            <tbody>
              {data.records.map((r) => (
                <tr key={r.code}>
                  <td><Link to={`/records/${r.code}`}><Id>{r.code}</Id></Link></td>
                  <td>{r.productName}<div className="small muted"><Id>{r.productCode}</Id></div></td>
                  <td><Id>{(r.heats ?? []).join(', ')}</Id></td>
                  <td>{fmtDay(r.manufacturingDate)}</td>
                  {!supplier && <td>{r.supplierName}</td>}
                  <td>{r.approvedVersion ? <Chip status="APPROVED" /> : null} {r.latestStatus !== 'APPROVED' && <Chip status={r.latestStatus} />}</td>
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

/** The hang tag: the approved identity of one manufacturing record. */
export function HangTag({ rec, version }: { rec: any; version: any }) {
  return (
    <div className="tag">
      <div className="tag-code">{rec.code}</div>
      <div className="tag-title">{rec.product?.name}</div>
      <dl className="facts">
        <dt>Product</dt><dd><Id>{rec.product?.code}</Id></dd>
        <dt>Part number</dt><dd><Id>{rec.product?.supplierPartNumber}</Id></dd>
        <dt>Material</dt><dd><Id>{rec.product?.attributes?.body_material_grade ?? '-'}</Id>{rec.product?.attributes?.pressure_class ? `, ${rec.product.attributes.pressure_class}` : ''}{rec.product?.attributes?.nominal_size ? `, ${rec.product.attributes.nominal_size}` : ''}</dd>
        <dt>Heats</dt><dd className="tag-heats">{version?.heats?.length ? version.heats.map((h: string) => <span key={h}>{h}</span>) : '-'}</dd>
        <dt>Batches</dt><dd><Id>{version?.batches?.join(', ') || '-'}</Id></dd>
        <dt>Serials</dt><dd style={{ whiteSpace: 'normal' }}>{version?.serials?.length ? version.serials.map((x: string) => <span key={x} className="id" style={{ marginRight: 10 }}>{x}</span>) : '-'}</dd>
        <dt>Manufactured</dt><dd>{fmtDay(version?.attributes?.manufacturing_date)}</dd>
        <dt>Supplier</dt><dd>{rec.supplier?.name}</dd>
      </dl>
    </div>
  );
}

function QrPanel({ rec, onChange }: { rec: any; onChange: () => void }) {
  const [label, setLabel] = useState<{ token: string; img: string } | null>(null);
  const [modal, setModal] = useState<'rotate' | 'revoke' | null>(null);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();

  const show = () => run(async () => {
    const r = await api<{ token: string }>(`/traceability/${rec.code}/qr`);
    const img = await QRCode.toDataURL(qrLinkFor(r.token), { errorCorrectionLevel: 'M', margin: 1, width: 300 });
    setLabel({ token: r.token, img });
  });
  const act = () => run(async () => {
    await api(`/traceability/${rec.code}/qr/${modal}`, { body: { reason } });
    setModal(null); setReason(''); setLabel(null); onChange();
  });

  return (
    <section className="panel">
      <h2>QR label</h2>
      {rec.qr ? <p className="small">Active label ending in <Id>{rec.qr.hint}</Id>, issued {fmtDate(rec.qr.createdAt)}. The code holds only a random token, no product data.</p>
        : <p className="small muted">No active QR label. One is issued when the record is first approved.</p>}
      <ErrorBox error={error} />
      {label && (
        <div className="print-label" style={{ margin: '10px 0' }}>
          <img src={label.img} alt={`QR label for ${rec.code}`} />
          <div>
            <div className="id" style={{ fontSize: '1.15rem' }}>{rec.code}</div>
            <div className="small">{rec.product?.name}</div>
            <div className="small"><Id>{rec.approved?.heats?.join(', ')}</Id></div>
            <div className="small muted" style={{ marginTop: 6 }}>Scan with a company device. Sign-in required.</div>
          </div>
        </div>
      )}
      <div className="row no-print">
        {rec.qr && !label && <button className="btn" onClick={show} disabled={busy}>Show printable label</button>}
        {label && <button className="btn primary" onClick={() => window.print()}>Print label</button>}
        {label && <Link className="btn" to={`/t/${label.token}`}>Open as scanned</Link>}
        {rec.approved && <button className="btn" onClick={() => setModal('rotate')}>Replace label</button>}
        {rec.qr && <button className="btn hold" onClick={() => setModal('revoke')}>Revoke label</button>}
      </div>
      {modal && (
        <Modal title={modal === 'rotate' ? 'Replace QR label' : 'Revoke QR label'} onClose={() => setModal(null)}>
          <p>{modal === 'rotate'
            ? 'A new token is issued and the old label stops working. The traceability ID stays the same.'
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

export function RecordDetail() {
  const { code } = useParams();
  const { me } = useSession();
  const defs = useDefinitions();
  const [rec, error, reload] = useApi<any>(`/traceability/${code}`);
  const { busy, error: actErr, run } = useAction();
  useEffect(() => { window.scrollTo(0, 0); }, [code]);
  if (error) return <ErrorBox error={error} />;
  if (!rec) return <Loading />;
  const supplier = me!.role === 'SUPPLIER_CONTRIBUTOR';
  const canQr = ['COMPANY_REVIEWER', 'REGISTRY_ADMIN'].includes(me!.role);
  const latest = rec.versions[0];
  const open = rec.versions.find((v: any) => v.status === 'DRAFT' || v.status === 'PENDING');
  const shown = rec.approved ?? latest;
  const submit = () => run(async () => { await api(`/traceability/${rec.code}/submit`, { method: 'POST' }); reload(); });

  return (
    <>
      <div className="spread page-head">
        <div>
          <p className="muted small" style={{ marginBottom: 4 }}><Link to="/records">Traceability records</Link> / <Link to={`/products/${rec.product.code}`}>{rec.product.code}</Link></p>
          <h1>Manufacturing record <Id>{rec.code}</Id></h1>
          <div className="row">{rec.approved ? <Chip status="APPROVED" /> : <Chip status={latest?.status} />}{open && rec.approved && <Chip status={open.status} />}{rec.externalRef && <span className="small muted">Supplier ref {rec.externalRef}</span>}</div>
        </div>
        {supplier && (
          <div className="row">
            {open?.status !== 'PENDING' && <Link className="btn" to={`/records/${rec.code}/edit`}>{open ? 'Edit draft' : 'Propose a change'}</Link>}
            {open?.status === 'DRAFT' && <button className="btn primary" onClick={submit} disabled={busy}>Submit for review</button>}
          </div>
        )}
      </div>
      <ErrorBox error={actErr} />
      {latest?.status === 'REJECTED' && supplier && <div className="notice error" style={{ marginBottom: 16 }}>Version {latest.versionNo} was rejected by {latest.reviewedBy}: "{latest.reviewComment}". Choose "Propose a change" to correct and resubmit.</div>}
      {open?.status === 'PENDING' && <div className="notice warn" style={{ marginBottom: 16 }}>Version {open.versionNo} is waiting for company review.{rec.approved ? ` QR scans keep showing approved version ${rec.approved.versionNo} until it is approved.` : ''}</div>}
      <div className="grid-2">
        <div className="stack">
          {shown && <HangTag rec={rec} version={shown} />}
          <section className="panel">
            <h2>Manufacturing attributes{shown ? `, version ${shown.versionNo}` : ''}</h2>
            <AttributeList defs={defs} scope="TRACEABILITY" values={shown?.attributes ?? {}} />
          </section>
          <section className="panel">
            <h2>Certificates and evidence</h2>
            <DocumentList docs={rec.documents} />
          </section>
        </div>
        <div className="stack">
          {canQr && <QrPanel rec={rec} onChange={reload} />}
          <section className="panel">
            <h2>Version history</h2>
            <ol className="timeline">
              {rec.versions.map((v: any) => (
                <li key={v.id} className={v.status}>
                  <div className="row"><strong>Version {v.versionNo}</strong><Chip status={v.status} /></div>
                  <div className="small">Heats <Id>{v.heats.join(', ') || '-'}</Id>, serials <Id>{v.serials.join(', ') || '-'}</Id></div>
                  <div className="small muted">{v.source === 'SEED' ? 'Imported' : 'Created'} {fmtDate(v.createdAt)}{v.reviewedAt ? `, reviewed by ${v.reviewedBy}` : ''}</div>
                  {v.reviewComment && <div className="small">"{v.reviewComment}"</div>}
                </li>
              ))}
            </ol>
            {['AUDITOR', 'REGISTRY_ADMIN', 'COMPANY_REVIEWER'].includes(me!.role) && <Link className="small" to={`/audit?code=${rec.code}`}>Full audit trail for this record</Link>}
          </section>
        </div>
      </div>
    </>
  );
}
