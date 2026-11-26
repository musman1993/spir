import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApi, useAction, ErrorBox, fmtBytes, fmtDay } from '../ui';

export interface AttrDef {
  key: string; version: number; label: string; scope: 'PRODUCT' | 'TRACEABILITY'; dataType: string; unit: string | null;
  category: string | null; required: boolean; allowedValues: string[] | null; comparisonRule: any; critical: boolean; labelChecked: boolean; displayOrder: number;
}

let defsCache: Promise<{ definitions: AttrDef[] }> | null = null;
export function useDefinitions() {
  const [defs, setDefs] = useState<AttrDef[] | null>(null);
  useEffect(() => {
    defsCache ??= api('/attribute-definitions');
    defsCache.then((d) => setDefs(d.definitions)).catch(() => { defsCache = null; });
  }, []);
  return defs;
}

/** Attributes stored as values (not identifiers/heats/serials, which have their own fields). */
export const valueAttrs = (defs: AttrDef[], scope: 'PRODUCT' | 'TRACEABILITY') =>
  defs.filter((d) => d.scope === scope && (d.comparisonRule?.source ?? 'attr') === 'attr');

export function AttributeList({ defs, scope, values }: { defs: AttrDef[] | null; scope: 'PRODUCT' | 'TRACEABILITY'; values: Record<string, string> }) {
  if (!defs) return null;
  const list = valueAttrs(defs, scope).filter((d) => values?.[d.key]);
  const extra = Object.keys(values ?? {}).filter((k) => !defs.some((d) => d.key === k));
  if (!list.length && !extra.length) return <p className="muted small">No attributes recorded.</p>;
  return (
    <dl className="facts">
      {list.map((d) => (
        <div key={d.key} style={{ display: 'contents' }}>
          <dt>{d.label}</dt>
          <dd>{d.dataType === 'DATE' ? fmtDay(values[d.key]) : <>{values[d.key]}{d.unit ? ` ${d.unit}` : ''}</>}</dd>
        </div>
      ))}
      {extra.map((k) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{values[k]}</dd></div>)}
    </dl>
  );
}

export interface Doc { code: string; type: string; revision: string; fileName: string; sizeBytes: number; versionNo: number; versionStatus: string; sha256: string; createdAt: string }
const DOC_LABEL: Record<string, string> = { MTC: 'Material test certificate', COC: 'Certificate of conformance', RT_REPORT: 'Radiographic test report', INSPECTION_REPORT: 'Inspection report', DRAWING: 'Drawing', OTHER: 'Other document' };

export function DocumentList({ docs }: { docs: Doc[] }) {
  const { error, run } = useAction();
  const open = (code: string) => run(async () => {
    const { url } = await api<{ url: string }>(`/documents/${code}/download`);
    window.open(url, '_blank', 'noopener');
  });
  if (!docs.length) return <p className="muted small">No documents attached.</p>;
  return (
    <>
      <ErrorBox error={error} />
      <table className="table">
        <thead><tr><th>Document</th><th>Revision</th><th>Supplied in</th><th /></tr></thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.code}>
              <td><div>{DOC_LABEL[d.type] ?? d.type}</div><div className="small muted">{d.fileName}, {fmtBytes(d.sizeBytes)}</div></td>
              <td>{d.revision}</td>
              <td className="small">Version {d.versionNo}{d.versionStatus !== 'APPROVED' ? ` (${d.versionStatus.toLowerCase()})` : ''}</td>
              <td><button className="btn small" onClick={() => open(d.code)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted" style={{ marginTop: 6 }}>Links expire after 5 minutes. Each download is recorded in the audit trail.</p>
    </>
  );
}

export function useSearch(initial = '') {
  const [q, setQ] = useState(initial);
  const [debounced, setDebounced] = useState(initial);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  return [q, setQ, debounced] as const;
}

export { useApi };
