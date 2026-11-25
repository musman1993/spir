import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { BarcodeRead, CameraDevice } from '../devices';
import { zxingBarcode } from '../devices/barcode';
import { browserCamera, describeCameraError } from '../devices/camera';
import { tesseractOcr, type OcrResult } from '../devices/ocr';
import { DEFAULT_PREPROCESS, loadImage, preprocess, qualityCheck, type Preprocess } from '../devices/preprocess';
import { ErrorBox, Id, useAction, useApi } from '../ui';

type Stage = 'capture' | 'review' | 'reading' | 'read';

export function LabelCheck() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const pinned = params.get('record');
  const [profiles] = useApi<{ profiles: { key: string; version: number; name: string }[] }>('/label-profiles');
  const [profileKey, setProfileKey] = useState('GENERIC_VALVE_CASTING');
  const [stage, setStage] = useState<Stage>('capture');
  const [live, setLive] = useState(false);
  const [cams, setCams] = useState<CameraDevice[]>([]);
  const [cam, setCam] = useState('');
  const [camErr, setCamErr] = useState<string | null>(null);
  const [original, setOriginal] = useState<Blob | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [quality, setQuality] = useState<ReturnType<typeof qualityCheck> | null>(null);
  const [pre, setPre] = useState<Preprocess>(DEFAULT_PREPROCESS);
  const [preview, setPreview] = useState<string>('');
  const [progress, setProgress] = useState({ p: 0, s: '' });
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [barcodes, setBarcodes] = useState<BarcodeRead[]>([]);
  const [source, setSource] = useState<'camera' | 'upload'>('upload');
  const video = useRef<HTMLVideoElement>(null);
  const { busy, error, run, setError } = useAction();

  useEffect(() => () => browserCamera.stop(), []);
  useEffect(() => {
    if (!img) return;
    setPreview(preprocess(img, pre, 1200).toDataURL('image/jpeg', 0.85));
  }, [img, pre]);

  const accept = async (blob: Blob, from: 'camera' | 'upload') => {
    const i = await loadImage(blob);
    setOriginal(blob); setImg(i); setQuality(qualityCheck(i)); setSource(from);
    setOcr(null); setBarcodes([]); setStage('review');
  };

  const startCam = async () => {
    setCamErr(null);
    try { await browserCamera.start(video.current!, cam || undefined); setLive(true); setCams(await browserCamera.list()); }
    catch (e) { setCamErr(describeCameraError(e)); setLive(false); }
  };
  const capture = async () => {
    const blob = await browserCamera.capture(video.current!);
    browserCamera.stop(); setLive(false);
    await accept(blob, 'camera');
  };

  const read = () => run(async () => {
    setStage('reading');
    const canvas = preprocess(img!, pre);
    // QR/barcodes are decoded from the original and the processed image; OCR reads the processed one.
    const [codesA, codesB, text] = await Promise.all([
      zxingBarcode.decodeImage(img!),
      zxingBarcode.decodeImage(canvas),
      tesseractOcr.recognize(canvas, (p, s) => setProgress({ p, s })),
    ]);
    const seen = new Set<string>();
    setBarcodes([...codesA, ...codesB].filter((b) => !seen.has(b.text) && seen.add(b.text)));
    setOcr(text);
    setStage('read');
    return true;
  }).then((ok) => { if (!ok) setStage('review'); });

  const compare = () => run(async () => {
    if (!navigator.onLine) throw new Error("You're offline. The comparison runs on the server; reconnect and press Compare again. Your capture is kept on this page.");
    const form = new FormData();
    const ext = original!.type === 'image/png' ? 'png' : 'jpg';
    form.set('image', new File([original!], `label.${ext}`, { type: original!.type || 'image/jpeg' }));
    form.set('payload', JSON.stringify({
      labelProfileKey: profileKey,
      traceabilityCode: pinned,
      ocr: { engine: ocr!.engine, engineVersion: ocr!.engineVersion, text: ocr!.text, confidence: ocr!.confidence, lines: ocr!.lines },
      barcodes,
      device: {
        source, cameraLabel: cams.find((c) => c.deviceId === cam)?.label ?? null,
        image: quality?.metrics, preprocessing: pre, capturedAt: new Date().toISOString(),
      },
    }));
    const r = await api<{ code: string }>('/validations', { form });
    nav(`/validations/${r.code}`);
  });

  const reset = () => { setStage('capture'); setOriginal(null); setImg(null); setOcr(null); setBarcodes([]); setError(null); };

  return (
    <>
      <div className="page-head">
        <h1>Check a product label</h1>
        <p className="lede">Photograph the supplier's sticker or tag. SPIR reads it and compares every field with the approved record. Nothing on the label ever changes the registry.</p>
        {pinned && <div className="notice">Comparing against record <Id>{pinned}</Id> (from the QR label you scanned). <Link to="/label-check">Identify the record from the label instead</Link></div>}
      </div>

      <div className="grid-2">
        <section className="panel">
          {stage === 'capture' && (
            <>
              <div className="capture-stage">
                <video ref={video} muted playsInline aria-label="Camera preview" style={{ display: live ? 'block' : 'none' }} />
                {!live && <span>Start the camera or upload a photo</span>}
                {live && <div className="guide" />}
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                {!live ? <button className="btn primary" onClick={startCam}>Start camera</button> : <button className="btn primary" onClick={capture}>Capture photo</button>}
                <label className="btn">Upload photo<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && accept(e.target.files[0], 'upload')} /></label>
                {cams.length > 1 && (
                  <select value={cam} onChange={(e) => { setCam(e.target.value); if (live) setTimeout(startCam, 0); }} aria-label="Camera">
                    <option value="">Default camera</option>
                    {cams.map((c) => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)}
                  </select>
                )}
              </div>
              {camErr && <div className="notice error" style={{ marginTop: 12 }}>{camErr}</div>}
              <p className="small muted" style={{ marginTop: 12 }}>Fill the dashed frame with the label, square on, without glare. Include any QR or barcode on it.</p>
            </>
          )}
          {stage !== 'capture' && img && (
            <>
              <div className="capture-stage" style={{ aspectRatio: 'auto' }}><img src={preview} alt="Label as the OCR engine will read it" /></div>
              {quality && !quality.ok && <div className="notice warn" style={{ marginTop: 12 }}>{quality.warnings.map((w) => <div key={w}>{w}</div>)}</div>}
              {stage === 'review' && (
                <div className="stack" style={{ marginTop: 12 }}>
                  <div className="row">
                    <button className="btn small" onClick={() => setPre({ ...pre, rotate: ((pre.rotate + 90) % 360) as Preprocess['rotate'] })}>Rotate 90 degrees</button>
                    <label className="row small"><input type="checkbox" checked={pre.grayscale} onChange={(e) => setPre({ ...pre, grayscale: e.target.checked })} /> Greyscale</label>
                    <label className="row small"><input type="checkbox" checked={pre.threshold} onChange={(e) => setPre({ ...pre, threshold: e.target.checked })} /> Black and white</label>
                    <label className="row small">Contrast <input type="range" min={0.8} max={2.5} step={0.1} value={pre.contrast} onChange={(e) => setPre({ ...pre, contrast: Number(e.target.value) })} aria-label="Contrast" /></label>
                  </div>
                  <p className="small muted">These adjustments only help the OCR engine. The original photo is what gets stored as evidence.</p>
                </div>
              )}
            </>
          )}
        </section>

        <section className="panel stack">
          <label className="field">Label profile
            <span className="hint">Tells SPIR which words on the sticker mean which field (for example "HT NO" means heat number).</span>
            <select value={profileKey} onChange={(e) => setProfileKey(e.target.value)}>
              {profiles?.profiles.map((p) => <option key={p.key} value={p.key}>{p.name} (v{p.version})</option>)}
            </select>
          </label>
          {stage === 'capture' && <p className="muted">Waiting for a photo.</p>}
          {stage === 'review' && (
            <div className="row">
              <button className="btn primary" onClick={read} disabled={busy}>Read the label</button>
              <button className="btn" onClick={reset}>Retake</button>
            </div>
          )}
          {stage === 'reading' && (
            <div>
              <p>Reading the label on this device{progress.s ? `: ${progress.s}` : ''}...</p>
              <div className="progress"><div style={{ width: `${Math.round(progress.p * 100)}%` }} /></div>
              <p className="small muted" style={{ marginTop: 8 }}>The first read downloads the OCR language model (about 10 MB). Later reads are quicker.</p>
            </div>
          )}
          {stage === 'read' && ocr && (
            <>
              <div>
                <h3>Text read from the label</h3>
                <p className="small muted">Overall OCR confidence {Math.round(ocr.confidence)}%. This raw text is kept as evidence; you can correct individual fields after the comparison.</p>
                <pre className="ocr-text">{ocr.text.trim() || '(no text found)'}</pre>
              </div>
              <div>
                <h3>Codes found</h3>
                {barcodes.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{barcodes.map((b) => <li key={b.text}>{b.format.replace(/_/g, ' ').toLowerCase()}: <Id>{b.text.length > 60 ? b.text.slice(0, 60) + '...' : b.text}</Id></li>)}</ul> : <p className="small muted">No QR code or barcode was found.</p>}
              </div>
              <div className="row">
                <button className="btn primary" onClick={compare} disabled={busy}>{busy ? 'Comparing...' : 'Compare with the registry'}</button>
                <button className="btn" onClick={() => setStage('review')} disabled={busy}>Adjust and re-read</button>
                <button className="btn" onClick={reset} disabled={busy}>Retake</button>
              </div>
            </>
          )}
          <ErrorBox error={error} />
        </section>
      </div>
    </>
  );
}
