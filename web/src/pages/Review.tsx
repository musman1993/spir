import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../session';
import { ErrorBox, Id, Loading, fmtDate, useAction, useApi } from '../ui';
import { DocumentList, useDefinitions } from './shared';

const FIELD_LABEL: Record<string, string> = { heats: 'Heat numbers', batches: 'Batch numbers', serials: 'Serial numbers', product_name: 'Part description', description: 'Notes' };

function ReviewItem({ item, canDecide, onDone }: { item: any; canDecide: boolean; onDone: (msg: string) => void }) {
  const defs = useDefinitions();
  const [comment, setComment] = useState('');
  const { busy, error, run } = useAction();
  const label = (k: string) => FIELD_LABEL[k] ?? defs?.find((d) => d.key === k)?.label ?? k;
  // Mono only for character-exact identifiers and governed codes; prose stays in the text face.
  const exact = (k: string) => ['heats', 'batches', 'serials'].includes(k) || ['IDENTIFIER', 'CODE'].includes(defs?.find((d) => d.key === k)?.dataType ?? '');
  const show = (k: string, v: string | null) => (v == null ? '-' : exact(k) ? <Id>{v}</Id> : v);
  const decide = (decision: 'approve' | 'reject') => run(async () => {
    const r = await api<any>(`/review/${item.kind}/${item.versionId}/${decision}`, { body: { comment: comment || null } });
    onDone(decision === 'approve'
      ? `Approved ${item.code} version ${item.versionNo}.${r.qrIssued ? ' A QR label is now active for it.' : ''}`
      : `Rejected ${item.code} version ${item.versionNo}. The supplier sees your reason.`);
  });
  return (
    <article className="panel">
      <div className="spread">
        <div>
          <h2 style={{ marginBottom: 2 }}>{item.kind === 'product' ? 'Product' : 'Shipment record'} <Link to={item.kind === 'product' ? `/products/${item.code}` : `/records/${item.code}`}><Id>{item.code}</Id></Link>, version {item.versionNo}</h2>
          <div className="small muted">{item.title}. {item.supplierName}, submitted by {item.submittedBy} {fmtDate(item.submittedAt)}</div>
        </div>
      </div>
      {item.blockedReason && <div className="notice warn" style={{ margin: '12px 0' }}>{item.blockedReason}</div>}
      <h3 style={{ marginTop: 14 }}>{item.comparedTo ? `Changes since version ${item.comparedTo.versionNo} (${item.comparedTo.status.toLowerCase()})` : 'New submission'}</h3>
      {item.changes.length === 0 ? <p className="muted small">No field changes.</p> : (
        <table className="table diff">
          <thead><tr><th>Field</th>{item.comparedTo && <th>Before</th>}<th>{item.comparedTo ? 'Proposed' : 'Value'}</th></tr></thead>
          <tbody>
            {item.changes.map((c: any) => (
              <tr key={c.field}><td>{label(c.field)}</td>{item.comparedTo && <td className="from">{show(c.field, c.from)}</td>}<td className="to">{show(c.field, c.to)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {item.kind === 'traceability' && (<><h3 style={{ marginTop: 14 }}>Evidence supplied with this version</h3><DocumentList docs={item.documents} /></>)}
      {canDecide && (
        <div style={{ marginTop: 14 }}>
          <label className="field">Comment<span className="hint">Required when rejecting. Tell the supplier exactly what to fix.</span>
            <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          <ErrorBox error={error} />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn accept" onClick={() => decide('approve')} disabled={busy || !!item.blockedReason}>Approve and publish</button>
            <button className="btn hold" onClick={() => decide('reject')} disabled={busy || !comment.trim()}>Reject</button>
          </div>
        </div>
      )}
    </article>
  );
}

export function ReviewQueue() {
  const { me } = useSession();
  const [data, error, reload] = useApi<{ items: any[] }>('/review-queue');
  const [msg, setMsg] = useState<string | null>(null);
  const canDecide = me!.role === 'COMPANY_REVIEWER';
  return (
    <>
      <div className="page-head">
        <h1>Review queue</h1>
        <p className="lede">Nothing a supplier submits is visible to QR users until it is approved here. Approving replaces the previous approved version, which stays in history.</p>
      </div>
      {!canDecide && <div className="notice" style={{ marginBottom: 14 }}>You can see the queue but only company reviewers can approve or reject.</div>}
      {msg && <div className="notice ok" style={{ marginBottom: 14 }}>{msg}</div>}
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data && data.items.length === 0 && <div className="empty">The queue is empty. Every submitted change has been reviewed.</div>}
      <div className="stack">
        {data?.items.map((i) => <ReviewItem key={i.versionId} item={i} canDecide={canDecide} onDone={(m) => { setMsg(m); reload(); window.scrollTo(0, 0); }} />)}
      </div>
    </>
  );
}
