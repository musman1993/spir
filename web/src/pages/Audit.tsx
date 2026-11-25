import { useSearchParams } from 'react-router-dom';
import { ErrorBox, Id, Loading, fmtDate, useApi } from '../ui';

const ACTION_TEXT: Record<string, string> = {
  CREATE: 'Created', SAVE_DRAFT: 'Saved draft', SUBMIT: 'Submitted for review', APPROVE: 'Approved', REJECT: 'Rejected',
  UPLOAD_DOCUMENT: 'Uploaded document', DOWNLOAD_DOCUMENT: 'Downloaded document', QR_ISSUE: 'Issued QR label', QR_ROTATE: 'Replaced QR label',
  QR_REVOKE: 'Revoked QR label', QR_RESOLVE: 'Scanned QR label', QR_RESOLVE_UNKNOWN: 'Scanned unknown QR', QR_RESOLVE_REVOKED: 'Scanned revoked QR',
  QR_LABEL_ACCESS: 'Opened printable label', LABEL_CAPTURED: 'Captured label photo', VALIDATION_EVALUATED: 'Compared label with registry',
  VALIDATION_FIELD_REVIEW: 'Reviewed label field', DISCREPANCY_RAISED: 'Raised discrepancy', VALIDATION_FINALIZED: 'Finalised label check', SEED_IMPORT: 'Imported demo data',
};

function summary(e: any) {
  const d = e.details ?? {};
  if (e.action === 'VALIDATION_FIELD_REVIEW') return `${d.attributeKey}: ${d.action}${d.correctedValue ? ` to ${d.correctedValue}` : ''} (${d.from} to ${d.to})`;
  if (e.action === 'VALIDATION_EVALUATED') return `${d.resolution}, ${d.overallStatus}`;
  if (d.versionNo) return `Version ${d.versionNo}${d.comment ? `: "${d.comment}"` : ''}`;
  if (d.reason) return d.reason;
  if (d.fileName) return `${d.docType} ${d.fileName}`;
  if (d.documentCode) return d.documentCode;
  return '';
}

export function Audit() {
  const [params, setParams] = useSearchParams();
  const code = params.get('code') ?? '';
  const [data, error] = useApi<{ events: any[] }>(`/audit?limit=300${code ? `&code=${encodeURIComponent(code)}` : ''}`);
  return (
    <>
      <div className="page-head">
        <h1>Audit trail</h1>
        <p className="lede">Append-only. The database refuses to edit or delete these entries.</p>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="mono search" placeholder="Filter by TRC-, PRD- or VAL- ID" defaultValue={code}
          onKeyDown={(e) => e.key === 'Enter' && setParams((e.target as HTMLInputElement).value ? { code: (e.target as HTMLInputElement).value.trim() } : {})} aria-label="Filter by ID" />
        {code && <button className="btn small" onClick={() => setParams({})}>Clear filter</button>}
      </div>
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>On</th><th>Detail</th></tr></thead>
            <tbody>{data.events.map((e) => (
              <tr key={e.id}>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.at)}</td>
                <td className="small">{e.actor ?? e.actorId}<div className="muted">{String(e.role).replace(/_/g, ' ').toLowerCase()}</div></td>
                <td>{ACTION_TEXT[e.action] ?? e.action}</td>
                <td>{e.entityCode ? <Id>{e.entityCode}</Id> : <span className="muted small">{e.entityType}</span>}</td>
                <td className="small">{summary(e)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
