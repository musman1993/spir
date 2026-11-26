import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../session';
import { ErrorBox, Id, Loading, Modal, RESULT_LABEL, Stamp, fmtDate, useAction, useApi } from '../ui';

const VERDICT_TEXT: Record<string, string> = {
  PASS: 'Every critical field on the label matches the approved record.',
  PASS_WITH_WARNINGS: 'Critical fields match. Some non-critical fields differ or could not be checked.',
  NEEDS_REVIEW: 'Some critical fields could not be confirmed. Review the highlighted rows against the photo.',
  FAIL: 'At least one critical field on the label disagrees with the approved record. Hold the item and raise a discrepancy.',
  UNRESOLVED: 'SPIR could not tell which record this label belongs to. Choose the record below.',
};

const pct = (c: number | null) => (c == null ? 'n/a' : `${Math.round(c * 100)}%`);

function Evidence({ run, focus }: { run: any; focus: any | null }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  if (!run.image) return <p className="muted small">No photo was stored for this check.</p>;
  // Boxes come from the OCR input: the photo cropped, scaled by pre.scale (and possibly rotated).
  const pre = run.device?.preprocessing;
  const box = focus?.bbox && dims && (!pre || !pre.rotate) ? (() => {
    const s = pre?.scale ?? Math.min(1, 2400 / Math.max(dims.w, dims.h));
    const cx = pre?.crop?.x ?? 0; const cy = pre?.crop?.y ?? 0;
    return { left: `${((cx + focus.bbox.x0 / s) / dims.w) * 100}%`, top: `${((cy + focus.bbox.y0 / s) / dims.h) * 100}%`,
      width: `${((focus.bbox.x1 - focus.bbox.x0) / s / dims.w) * 100}%`, height: `${((focus.bbox.y1 - focus.bbox.y0) / s / dims.h) * 100}%` };
  })() : null;
  return (
    <div>
      <div className="evidence">
        <img src={run.image.url} alt="Captured label" onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        {box && <div className="box" style={box} />}
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>Original capture, SHA-256 <Id>{run.image.sha256.slice(0, 16)}...</Id>{focus ? `. Highlight: ${focus.label}` : '. Select a row to highlight where it was read.'}</p>
    </div>
  );
}

function ReviewDialog({ run, field, onClose, onSaved }: { run: any; field: any; onClose: () => void; onSaved: (r: any) => void }) {
  const [mode, setMode] = useState<'ACCEPT' | 'CORRECT' | 'UNREADABLE' | 'NOT_APPLICABLE' | 'DISCREPANCY'>(field.observedRaw ? 'ACCEPT' : 'CORRECT');
  const [value, setValue] = useState(field.observedRaw ?? '');
  const [note, setNote] = useState('');
  const [sev, setSev] = useState(field.critical ? 'HIGH' : 'MEDIUM');
  const [cls, setCls] = useState('UNKNOWN');
  const { busy, error, run: act } = useAction();
  const save = () => act(async () => {
    const r = mode === 'DISCREPANCY'
      ? await api(`/validations/${run.code}/discrepancies`, { body: { attributeKey: field.attributeKey, severity: sev, classification: cls, description: note } })
      : await api(`/validations/${run.code}/fields/${field.attributeKey}/review`, { body: { action: mode, value: mode === 'CORRECT' ? value : undefined, note: note || undefined } });
    onSaved(r);
  });
  const opt = (m: typeof mode, label: string, hint: string, disabled = false) => (
    <label className="row small" style={{ alignItems: 'flex-start', opacity: disabled ? 0.5 : 1 }}>
      <input type="radio" name="mode" checked={mode === m} disabled={disabled} onChange={() => setMode(m)} />
      <span><strong>{label}</strong><br /><span className="muted">{hint}</span></span>
    </label>
  );
  return (
    <Modal title={`Review: ${field.label}`} onClose={onClose}>
      <dl className="facts small" style={{ marginBottom: 12 }}>
        <dt>Approved</dt><dd><Id>{field.approvedValue ?? '-'}</Id></dd>
        <dt>Read from label</dt><dd><Id>{field.observedRaw ?? '(nothing)'}</Id> at {pct(field.confidence)} confidence</dd>
      </dl>
      <div className="stack">
        {opt('ACCEPT', 'The reading is right', 'You checked the photo and the label really says this.', !field.observedRaw)}
        {opt('CORRECT', 'Correct the reading', 'The OCR misread a character. Type what the label actually says.')}
        {opt('UNREADABLE', 'Unreadable', 'The field is on the label but cannot be read reliably.')}
        {opt('NOT_APPLICABLE', 'Not on this label type', 'This sticker layout does not carry this field.')}
        {opt('DISCREPANCY', 'Raise a discrepancy', 'The label and the registry genuinely disagree, or something else is wrong.')}
        {mode === 'CORRECT' && <label className="field">What the label says<input className="mono" value={value} onChange={(e) => setValue(e.target.value)} autoFocus /></label>}
        {mode === 'DISCREPANCY' && (
          <div className="form-grid">
            <label className="field">Severity<select value={sev} onChange={(e) => setSev(e.target.value)}><option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option></select></label>
            <label className="field">Likely cause<select value={cls} onChange={(e) => setCls(e.target.value)}>
              <option value="UNKNOWN">Not sure yet</option><option value="MISLABELLED_PRODUCT">Item is mislabelled</option><option value="REGISTRY_ERROR">Registry data is wrong</option>
              <option value="WRONG_RECORD">Wrong record selected</option><option value="OCR_ERROR">OCR error</option><option value="PROCESS_EXCEPTION">Known process exception</option>
            </select></label>
          </div>
        )}
        <label className="field">{mode === 'DISCREPANCY' ? 'What is wrong' : 'Note'}{mode === 'NOT_APPLICABLE' || mode === 'DISCREPANCY' ? '' : <span className="hint"> optional</span>}
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {mode === 'DISCREPANCY' && <p className="small muted">A discrepancy never edits the registry. If the registry is wrong, the supplier corrects it and the company approves a new version.</p>}
        <ErrorBox error={error} />
        <div className="row"><button className="btn primary" onClick={save} disabled={busy}>{mode === 'DISCREPANCY' ? 'Raise discrepancy' : 'Save review'}</button></div>
      </div>
    </Modal>
  );
}

export function ValidationRun() {
  const { code } = useParams();
  const { me } = useSession();
  const [run, error, , setRun] = useApi<any>(`/validations/${code}`);
  const [focus, setFocus] = useState<any | null>(null);
  const [reviewing, setReviewing] = useState<any | null>(null);
  const [manual, setManual] = useState('');
  const { busy, error: actErr, run: act } = useAction();
  if (error) return <ErrorBox error={error} />;
  if (!run) return <Loading />;
  const canAct = ['OPERATOR', 'INSPECTOR', 'COMPANY_REVIEWER', 'REGISTRY_ADMIN'].includes(me!.role) && !run.finalizedAt;
  const resolve = (traceabilityCode: string) => act(async () => setRun(await api(`/validations/${code}/resolve`, { body: { traceabilityCode } })));
  const finalize = () => act(async () => setRun(await api(`/validations/${code}/finalize`, { method: 'POST' })));
  const needsAttention = run.fields.filter((f: any) => !['MATCH', 'NOT_APPLICABLE', 'NOT_CHECKED'].includes(f.effectiveResult) && !f.review);

  return (
    <>
      <div className="page-head">
        <p className="muted small" style={{ marginBottom: 4 }}><Link to="/validations">Label check history</Link></p>
        <h1>Label check <Id>{run.code}</Id></h1>
        <p className="muted small">By {run.operator}, {fmtDate(run.createdAt)}. Profile {run.labelProfile.key} v{run.labelProfile.version}, OCR {run.ocr.engine} {run.ocr.engineVersion ?? ''}, rules {run.ruleVersion}.</p>
      </div>

      <div className={`verdict ${run.overallStatus}`}>
        <Stamp result={run.overallStatus} big />
        <div>
          <div>{VERDICT_TEXT[run.overallStatus]}</div>
          {run.record && <div className="small" style={{ marginTop: 4 }}>
            Compared with <Link to={`/records/${run.record.traceabilityCode}`}><Id>{run.record.traceabilityCode}</Id></Link> (approved version {run.record.pinnedTraceabilityVersion}) and product <Id>{run.record.productCode}</Id> version {run.record.pinnedProductVersion}. Matched by {String(run.resolution.method).replace(/_/g, ' ').toLowerCase()}: {run.resolution.note}
          </div>}
          {run.finalizedAt && <div className="small" style={{ marginTop: 4 }}>Finalised {fmtDate(run.finalizedAt)}. This check can no longer be changed.</div>}
        </div>
      </div>
      <ErrorBox error={actErr} />

      {!run.record && (
        <section className="panel" style={{ marginTop: 16 }}>
          <h2>Which record is this label for?</h2>
          <p>{run.resolution.note}</p>
          {run.resolution.candidates?.length > 0 && (
            <table className="table" style={{ marginBottom: 12 }}>
              <thead><tr><th>Record</th><th>Product</th><th>Matched on</th><th /></tr></thead>
              <tbody>{run.resolution.candidates.map((c: any) => (
                <tr key={c.code}><td><Id>{c.code}</Id></td><td>{c.productName} <Id>{c.productCode}</Id></td><td className="small">{c.matchedOn.map((m: string) => m.replace(/_/g, ' ')).join(', ')}</td>
                  <td>{canAct && <button className="btn small" onClick={() => resolve(c.code)} disabled={busy}>Compare with this record</button>}</td></tr>
              ))}</tbody>
            </table>
          )}
          {canAct && <div className="row"><input className="mono" placeholder="TRC-0000001" value={manual} onChange={(e) => setManual(e.target.value)} aria-label="Record ID" /><button className="btn" onClick={() => resolve(manual.trim())} disabled={!manual.trim() || busy}>Compare with this record</button></div>}
        </section>
      )}

      {run.record && (
        <div className="grid-matrix" style={{ marginTop: 16 }}>
          <section className="table-wrap">
            <table className="table matrix">
              <thead><tr><th>Field</th><th>Approved</th><th>On the label</th><th>Confidence</th><th>Result</th><th /></tr></thead>
              <tbody>
                {run.fields.map((f: any) => (
                  <tr key={f.attributeKey} className={`${f.critical ? 'crit' : ''} ${focus?.attributeKey === f.attributeKey ? 'sel' : ''}`} onClick={() => setFocus(f)} style={{ cursor: 'pointer' }}>
                    <td>{f.label}{f.critical && <div className="small muted">Critical</div>}</td>
                    <td className="val">{f.approvedValue ? f.approvedValue.split(', ').map((v: string, i: number, a: string[]) => <span key={v} className="nobr">{v}{i < a.length - 1 ? ', ' : ''}</span>) : '-'}</td>
                    <td>
                      <div className="val nobr">{f.review?.correctedValue ?? f.observedNormalized ?? f.observedRaw ?? '-'}</div>
                      {f.review?.correctedValue && <div className="raw">OCR read {f.observedRaw}</div>}
                      {!f.review?.correctedValue && f.observedRaw && f.observedNormalized && f.observedRaw.toUpperCase() !== f.observedNormalized && <div className="raw">as printed: {f.observedRaw}</div>}
                    </td>
                    <td className={`conf ${f.confidence != null && f.confidence < (f.rule?.threshold ?? 0.8) ? 'low' : ''}`}>{pct(f.confidence)}</td>
                    <td>
                      <Stamp result={f.effectiveResult} />
                      {f.review && f.effectiveResult !== f.result && <div className="raw">was {RESULT_LABEL[f.result]}</div>}
                      {f.review && <div className="small muted">{f.review.disposition.replace(/_/g, ' ').toLowerCase()} by {f.review.reviewer}</div>}
                    </td>
                    <td>{canAct && !['NOT_CHECKED'].includes(f.result) && <button className="btn small" onClick={(e) => { e.stopPropagation(); setReviewing(f); }}>Review</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className="stack">
            <section className="panel">
              <h2>Evidence</h2>
              <Evidence run={run} focus={focus} />
              {focus && <p className="small" style={{ marginTop: 8 }}>{focus.note}</p>}
            </section>
            <section className="panel">
              <h2>Discrepancies</h2>
              {run.discrepancies.length === 0 ? <p className="muted small">None raised.</p> : (
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{run.discrepancies.map((d: any) => <li key={d.code}><Id>{d.code}</Id> {d.severity.toLowerCase()}: {d.description} ({d.status.toLowerCase()})</li>)}</ul>
              )}
            </section>
            <section className="panel">
              <h2>Raw OCR text</h2>
              <pre className="ocr-text">{run.ocr.text || '(none)'}</pre>
              {run.barcodes?.length > 0 && <p className="small" style={{ marginTop: 8 }}>Codes: {run.barcodes.map((b: any) => b.format).join(', ')}</p>}
            </section>
            {canAct && (
              <section className="panel">
                <h2>Finish this check</h2>
                <p className="small">{needsAttention.length === 1 ? '1 field still needs a decision.' : needsAttention.length ? `${needsAttention.length} fields still need a decision.` : 'All fields have a result.'} Finalising locks the check as evidence.</p>
                <button className="btn primary" onClick={finalize} disabled={busy}>Finalise check</button>
              </section>
            )}
          </div>
        </div>
      )}
      {reviewing && <ReviewDialog run={run} field={reviewing} onClose={() => setReviewing(null)} onSaved={(r) => { setRun(r); setReviewing(null); }} />}
    </>
  );
}

export function Validations() {
  const [data, error] = useApi<{ runs: any[] }>('/validations');
  const [disc] = useApi<{ discrepancies: any[] }>('/discrepancies');
  return (
    <>
      <div className="spread page-head">
        <div><h1>Label check history</h1><p className="lede">Every check keeps its photo, raw OCR text, the exact record versions compared and every reviewer decision.</p></div>
        <Link className="btn primary" to="/label-check">Check a product label</Link>
      </div>
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data && (data.runs.length === 0 ? <div className="empty">No label checks yet. Start with "Check a product label".</div> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Check</th><th>When</th><th>Record</th><th>Result</th><th>Matched by</th><th>Operator</th><th>Discrepancies</th></tr></thead>
            <tbody>{data.runs.map((r) => (
              <tr key={r.code}>
                <td><Link to={`/validations/${r.code}`}><Id>{r.code}</Id></Link></td>
                <td className="small">{fmtDate(r.createdAt)}</td>
                <td>{r.traceabilityCode ? <Id>{r.traceabilityCode}</Id> : <span className="muted">-</span>}</td>
                <td><Stamp result={r.overallStatus} />{r.finalizedAt ? '' : <div className="small muted">open</div>}</td>
                <td className="small">{(r.resolutionMethod ?? '-').replace(/_/g, ' ').toLowerCase()}</td>
                <td className="small">{r.operator}</td>
                <td>{r.discrepancies || ''}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      {disc && disc.discrepancies.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2>Discrepancies</h2>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>ID</th><th>Check</th><th>Record</th><th>Field</th><th>Severity</th><th>Description</th><th>Status</th></tr></thead>
            <tbody>{disc.discrepancies.map((d) => (
              <tr key={d.code}><td><Id>{d.code}</Id></td><td><Link to={`/validations/${d.runCode}`}><Id>{d.runCode}</Id></Link></td><td><Id>{d.traceabilityCode ?? '-'}</Id></td>
                <td className="small">{d.attributeKey?.replace(/_/g, ' ') ?? '-'}</td><td>{d.severity.toLowerCase()}</td><td className="small">{d.description}</td><td>{d.status.toLowerCase()}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}
