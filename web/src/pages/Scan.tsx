import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { listenForHidScanner, type CameraDevice } from '../devices';
import { zxingBarcode } from '../devices/barcode';
import { browserCamera, describeCameraError } from '../devices/camera';
import { useLinks } from '../session';
import { api } from '../api';
import { ErrorBox, Id, Loading, TagMark, fmtDate, useAction, useApi } from '../ui';
import { AttributeList, useDefinitions } from './shared';
import { HangTag } from './Records';

/** Same rules as the API: a SPIR QR carries only an opaque token. */
export function parseSpirQr(text: string): string | null {
  const t = text.trim();
  const m = t.match(/\/t\/([A-Za-z0-9_-]{16,})\/?$/) ?? t.match(/^spir:([A-Za-z0-9_-]{16,})$/i);
  if (m) return m[1];
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(t) || /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
}

export function Scan() {
  const nav = useNavigate();
  const links = useLinks();
  const video = useRef<HTMLVideoElement>(null);
  const [cams, setCams] = useState<CameraDevice[]>([]);
  const [cam, setCam] = useState<string>('');
  const [live, setLive] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'warn'; text: string } | null>(null);
  const [manual, setManual] = useState('');
  const stopRef = useRef<(() => void) | null>(null);

  const handle = (text: string, source: string) => {
    const token = parseSpirQr(text);
    if (token) { stopRef.current?.(); nav(links.scanned(token)); return; }
    setMsg({ kind: 'warn', text: `${source} read "${text.slice(0, 60)}", which isn't a SPIR QR label. To check a supplier sticker, use "Check a product label".` });
  };

  useEffect(() => listenForHidScanner((t) => handle(t, 'The scanner')), []);
  useEffect(() => () => { stopRef.current?.(); browserCamera.stop(); }, []);

  const start = async () => {
    setMsg(null);
    try {
      stopRef.current?.();
      stopRef.current = await zxingBarcode.startLive(video.current!, (r) => handle(r.text, 'The camera'), cam || undefined);
      setLive(true);
      setCams(await browserCamera.list());
    } catch (e) { setMsg({ kind: 'error', text: describeCameraError(e) }); setLive(false); }
  };
  const stop = () => { stopRef.current?.(); stopRef.current = null; setLive(false); };

  return (
    <>
      <div className="page-head">
        <h1>Scan a QR label</h1>
        <p className="lede">Point the camera at a SPIR QR label, or use a handheld scanner: just scan, no need to click anything first.</p>
      </div>
      <div className="grid-2">
        <section className="panel">
          <div className="capture-stage">
            <video ref={video} muted playsInline aria-label="Camera preview" style={{ display: live ? 'block' : 'none' }} />
            {!live && <span>Camera is off</span>}
            {live && <div className="guide" />}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {!live ? <button className="btn primary" onClick={start}>Start camera</button> : <button className="btn" onClick={stop}>Stop camera</button>}
            {cams.length > 1 && (
              <select value={cam} onChange={(e) => { setCam(e.target.value); if (live) setTimeout(start, 0); }} aria-label="Camera">
                <option value="">Default camera</option>
                {cams.map((c) => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)}
              </select>
            )}
          </div>
          {msg && <div className={`notice ${msg.kind}`} style={{ marginTop: 12 }}>{msg.text}</div>}
        </section>
        <section className="panel">
          <h2>No camera?</h2>
          <p className="small">Handheld USB or Bluetooth scanners in keyboard mode work on this page automatically.</p>
          <label className="field">Or paste the QR link or token
            <input className="mono" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handle(manual, 'The text you entered')} placeholder="https://.../#/t/..." />
          </label>
          <div className="row" style={{ marginTop: 10 }}><button className="btn" onClick={() => handle(manual, 'The text you entered')} disabled={!manual.trim()}>Open record</button></div>
          <p className="small muted" style={{ marginTop: 14 }}>The QR code holds a random token, not product data. Phones can also scan labels with their normal camera app, without signing in.</p>
        </section>
      </div>
    </>
  );
}

const DOC_LABEL: Record<string, string> = { MTC: 'Material test certificate', COC: 'Certificate of conformance', RT_REPORT: 'Radiographic test report', INSPECTION_REPORT: 'Inspection report', DRAWING: 'Drawing', OTHER: 'Document' };
const DOC_SHORT: Record<string, string> = { MTC: 'MTC', COC: 'CoC', RT_REPORT: 'RT', INSPECTION_REPORT: 'INSP', DRAWING: 'DWG', OTHER: 'DOC' };

/** Certificates as large touch targets, opened through the scanned label's token. */
function DocButtons({ token, docs }: { token: string; docs: any[] }) {
  const { error, run } = useAction();
  const open = (code: string) => run(async () => {
    const w = window.open('', '_blank');
    const { url } = await api<{ url: string }>(`/qr/${token}/documents/${code}`);
    if (w) w.location.href = url; else window.location.href = url;
  });
  if (!docs.length) return <p className="muted small">No certificates uploaded yet.</p>;
  return (
    <div className="doc-buttons">
      <ErrorBox error={error} />
      {docs.map((d) => (
        <button key={d.code} className="doc-btn" onClick={() => open(d.code)}>
          <span className="doc-kind">{DOC_SHORT[d.type] ?? 'DOC'}</span>
          <span style={{ flex: 1, minWidth: 0 }}><strong style={{ display: 'block' }}>{DOC_LABEL[d.type] ?? d.type}</strong><span className="small muted" style={{ overflowWrap: 'anywhere' }}>{d.fileName}</span></span>
          <span className="small" style={{ color: 'var(--link)', fontWeight: 600 }}>Open</span>
        </button>
      ))}
    </div>
  );
}

function ScanResult({ token, inPortal }: { token: string; inPortal: boolean }) {
  const defs = useDefinitions();
  const links = useLinks();
  const [rec, error] = useApi<any>(`/qr/${token}`);
  if (error) {
    const text = error.status === 410 ? 'This QR label has been revoked. Keep the item aside and ask the supplier for a replacement label.'
      : error.status === 404 ? "SPIR doesn't recognise this QR label. It may be damaged, or it isn't a SPIR label."
      : error.message;
    return (
      <>
        <h1>QR label</h1>
        <div className={`notice ${error.status === 410 ? 'error' : 'warn'}`}>{text}</div>
        {inPortal && <p style={{ marginTop: 14 }}><Link to={links.scan}>Scan another label</Link></p>}
      </>
    );
  }
  if (!rec) return <Loading what="Looking up the label" />;
  const v = rec.approved;
  return (
    <>
      <div className="spread page-head">
        <div>
          <h1>Shipment <Id>{rec.code}</Id></h1>
          <p className="lede" style={{ marginBottom: 0 }}>{rec.supplier.name}. Version {v.versionNo}, updated {fmtDate(v.createdAt)}.</p>
        </div>
        {inPortal && <div className="row"><Link className="btn" to={links.scan}>Scan another</Link><Link className="btn primary" to={`${links.labelCheck}?record=${rec.code}`}>Check the sticker on this item</Link></div>}
      </div>
      <div className="grid-2">
        <div className="stack">
          <HangTag rec={rec} version={v} />
          <section className="panel"><h2>Certificates</h2><DocButtons token={token} docs={rec.documents} /></section>
        </div>
        <div className="stack">
          <section className="panel"><h2>Shipment</h2><AttributeList defs={defs} scope="TRACEABILITY" values={v.attributes} /></section>
          {Object.values(rec.product.attributes ?? {}).some(Boolean) && <section className="panel"><h2>Part</h2><AttributeList defs={defs} scope="PRODUCT" values={rec.product.attributes} /></section>}
          <section className="panel small"><dl className="facts"><dt>Record</dt><dd><Id>{rec.code}</Id></dd><dt>Supplier</dt><dd>{rec.supplier.name} <Id>{rec.supplier.code}</Id></dd></dl></section>
        </div>
      </div>
    </>
  );
}

/** Company portal: the scanned label, inside the portal. */
export function QrResult() {
  const { token } = useParams();
  return <ScanResult token={token!} inPortal />;
}

/** Anyone with a phone: the scanned label, no sign-in. */
export function PublicScan() {
  const { token } = useParams();
  useEffect(() => { document.title = 'SPIR shipment'; }, []);
  return (
    <div>
      <header className="public-top"><TagMark className="brand-mark" /><strong>SPIR</strong><span className="small" style={{ marginLeft: 'auto', color: '#CFE3F3' }}>Supplier product information</span></header>
      <main className="public-page"><ScanResult token={token!} inPortal={false} /></main>
    </div>
  );
}
