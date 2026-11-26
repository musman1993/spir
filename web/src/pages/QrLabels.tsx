import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { appBaseUrl, qrLinkFor } from '../api';
import { useBrandLogo } from '../qr/brand';
import { labelPng, SheetLabel } from '../qr/labels';
import { renderQr, svgDataUrl, type QrArt } from '../qr/render';
import { perSheet, readSetting, SHEETS, sheetById, slotPosition, writeSetting } from '../qr/sheets';
import { ErrorBox, Loading, useApi } from '../ui';

interface Label {
  code: string; token: string | null; url: string | null; hint: string; issuedAt: string; versionNo: number;
  partNumber: string; description: string; revision: string | null; supplier: string;
  purchaseOrder: string | null; poLine: string | null; quantity: string | null; patternNumber: string | null; heats: string[] | null;
}

const linkOf = (l: Label) => l.url ?? (l.token ? qrLinkFor(l.token) : '');

function download(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href; a.download = name; a.click();
}

export function QrLabels() {
  const [params] = useSearchParams();
  const [data, error] = useApi<{ labels: Label[] }>('/qr-labels');
  const logo = useBrandLogo();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [arts, setArts] = useState<Record<string, QrArt>>({});
  const [sheetId, setSheetId] = useState(() => readSetting('spir.sheet', SHEETS[0].id));
  const [startAt, setStartAt] = useState(1);
  const [offset, setOffset] = useState(() => readSetting('spir.sheetOffset', { x: 0, y: 0 }));
  const [outlines, setOutlines] = useState(false);
  const sheet = sheetById(sheetId);
  const slots = perSheet(sheet);

  useEffect(() => { writeSetting('spir.sheet', sheetId); setStartAt((s) => Math.min(s, perSheet(sheetById(sheetId)))); }, [sheetId]);
  useEffect(() => { writeSetting('spir.sheetOffset', offset); }, [offset]);

  useEffect(() => {
    if (!data) return;
    const only = params.get('codes')?.split(',').filter(Boolean);
    setSelected(new Set(only?.length ? only : data.labels.map((l) => l.code)));
  }, [data, params]);

  useEffect(() => {
    if (!data || logo === undefined) return;
    let live = true;
    (async () => {
      for (const l of data.labels) {
        if (!l.token) continue;
        const art = await renderQr(linkOf(l), logo);
        if (!live) return;
        setArts((a) => ({ ...a, [l.code]: art }));
      }
    })();
    return () => { live = false; };
  }, [data, logo]);

  const shown = useMemo(() => {
    const s = q.trim().toUpperCase();
    return (data?.labels ?? []).filter((l) => !s || [l.code, l.partNumber, l.purchaseOrder, l.description, l.supplier, ...(l.heats ?? [])].some((v) => v?.toUpperCase().includes(s)));
  }, [data, q]);
  const chosen = shown.filter((l) => selected.has(l.code) && l.token);
  const toggle = (code: string) => setSelected((s) => { const n = new Set(s); n.has(code) ? n.delete(code) : n.add(code); return n; });

  // Fill pages: skip the slots already used on the first sheet.
  const pages = useMemo(() => {
    const cells: (Label | null)[] = [...Array(startAt - 1).fill(null), ...chosen];
    const out: (Label | null)[][] = [];
    for (let i = 0; i < cells.length; i += slots) out.push(cells.slice(i, i + slots));
    return out;
  }, [chosen, startAt, slots]);

  const rendered = chosen.filter((l) => arts[l.code]).length;
  const failed = chosen.filter((l) => arts[l.code] && !arts[l.code].verified);
  const ready = rendered === chosen.length;

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['record', 'part_number', 'revision', 'part_description', 'purchase_order_number', 'po_line_number', 'quantity', 'heat_numbers', 'pattern_number', 'supplier', 'qr_link'],
      ...chosen.map((l) => [l.code, l.partNumber, l.revision, l.description, l.purchaseOrder, l.poLine, l.quantity, (l.heats ?? []).join('|'), l.patternNumber, l.supplier, linkOf(l)])];
    download(URL.createObjectURL(new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' })), 'spir-qr-labels.csv');
  };
  const pngOne = async (l: Label) => { const a = arts[l.code]; if (a) download(await labelPng(l, a, sheet), `${l.code}.png`); };
  const pngAll = async () => { for (const l of chosen) await pngOne(l); };

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const base = data.labels.find((l) => l.url)?.url?.replace(/\/#\/t\/.*$/, '') ?? appBaseUrl();
  const sample = chosen[0] ? linkOf(chosen[0]) : `${base}/#/t/XXXXXXXXXXXXXXXX`;
  const codespace = /\.app\.github\.dev|\.github\.dev/.test(base);

  return (
    <>
      <div className="page-head no-print">
        <h1>QR labels</h1>
        <p className="lede">One QR code per shipment record. Scanning it with a phone camera opens that shipment in SPIR. The code never
          changes when a later import updates the data, so a printed label stays valid.</p>
      </div>
      {data.labels.length === 0 ? (
        <div className="empty">No QR codes yet. <Link to="/import">Import a CSV</Link> to create them.</div>
      ) : (
        <>
          <section className="panel no-print">
            <h2>Print setup</h2>
            <fieldset className="sheet-pick">
              <legend className="small muted">A4 sticker sheet</legend>
              {SHEETS.map((s) => (
                <label key={s.id} className={`sheet-opt${s.id === sheet.id ? ' on' : ''}`}>
                  <input type="radio" name="sheet" value={s.id} checked={s.id === sheet.id} onChange={() => setSheetId(s.id)} />
                  <SheetIcon cols={s.cols} rows={s.rows} />
                  <span><strong>{s.name}</strong><span className="small muted">{s.detail}</span></span>
                </label>
              ))}
            </fieldset>
            <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
              <label className="field" style={{ width: 190 }}>Start at label
                <input type="number" min={1} max={slots} value={startAt}
                  onChange={(e) => setStartAt(Math.max(1, Math.min(slots, Number(e.target.value) || 1)))} />
              </label>
              <span className="small muted" style={{ paddingBottom: 10 }}>Use this to finish a part-used sheet. Labels count left to right, top to bottom.</span>
            </div>
            <details style={{ marginTop: 8 }}>
              <summary className="small">Printer alignment</summary>
              <p className="small muted">Print one page on plain paper with outlines on, hold it against a sticker sheet, and nudge if the
                labels sit off. Saved for this browser.</p>
              <div className="row">
                <label className="field" style={{ width: 150 }}>Move right (mm)
                  <input type="number" step={0.5} value={offset.x} onChange={(e) => setOffset({ ...offset, x: Number(e.target.value) || 0 })} />
                </label>
                <label className="field" style={{ width: 150 }}>Move down (mm)
                  <input type="number" step={0.5} value={offset.y} onChange={(e) => setOffset({ ...offset, y: Number(e.target.value) || 0 })} />
                </label>
                <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', paddingTop: 18 }}>
                  <input type="checkbox" checked={outlines} onChange={(e) => setOutlines(e.target.checked)} /> Print label outlines
                </label>
              </div>
            </details>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={() => window.print()} disabled={!chosen.length || !ready}>
                {ready ? `Print ${chosen.length} label${chosen.length === 1 ? '' : 's'} (${pages.length} sheet${pages.length === 1 ? '' : 's'})` : `Preparing codes ${rendered}/${chosen.length}`}
              </button>
              <button className="btn" onClick={pngAll} disabled={!chosen.length || !ready}>Download PNGs</button>
              <button className="btn" onClick={exportCsv} disabled={!chosen.length}>Export links as CSV</button>
            </div>
            <p className="small muted" style={{ marginTop: 10 }}>In the print dialog choose A4, scale 100% (Actual size) and margins None.</p>
          </section>

          <div className="qr-status no-print">
            <div className={`notice${failed.length ? ' error' : ready ? ' ok' : ''}`}>
              {!ready ? 'Checking each code as it is drawn...'
                : failed.length ? `${failed.length} code${failed.length === 1 ? '' : 's'} did not pass the scan check and will print without the logo: ${failed.map((l) => l.code).join(', ')}.`
                : `All ${chosen.length} selected codes passed the scan check${logo ? ' with the logo in place' : ''}.`}
            </div>
            <div className={`notice${codespace ? ' warn' : ''}`}>
              Codes open <span className="id">{base}</span> ({sample.length} characters inside each code).
              {codespace ? ' This is a Codespace address: a phone must be signed in to GitHub to open it, and it stops working when the Codespace is deleted. Set PUBLIC_APP_URL to the permanent address before printing labels for real parts.' : ''}
            </div>
          </div>

          <div className="row no-print" style={{ margin: '18px 0 12px' }}>
            <input className="search" type="search" placeholder="Filter by part number, PO, heat, record" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter labels" />
            <button className="btn small" onClick={() => setSelected(new Set(shown.map((l) => l.code)))}>Select all</button>
            <button className="btn small" onClick={() => setSelected(new Set())}>Select none</button>
            <span className="small muted">{chosen.length} of {data.labels.length} selected</span>
          </div>

          <div className="qr-layout">
            <div className="qr-sheet no-print">
              {shown.map((l) => {
                const art = arts[l.code];
                return (
                  <article key={l.code} className={`qr-label${selected.has(l.code) ? '' : ' unselected'}`}>
                    <label className="qr-pick"><input type="checkbox" checked={selected.has(l.code)} onChange={() => toggle(l.code)} /> Print</label>
                    {!l.token ? <div className="small muted">QR unavailable (issued with another key)</div>
                      : art ? <img src={svgDataUrl(art.svg)} alt={`QR code for ${l.code}`} /> : <div className="qr-wait"><span className="spin" /></div>}
                    <div className="qr-text">
                      <div className="id qr-code">{l.code}</div>
                      <div className="small">Part <span className="id">{l.partNumber}</span></div>
                      <div className="small">PO <span className="id">{l.purchaseOrder ?? '-'}</span>, line {l.poLine ?? '-'}</div>
                      <div className="small">Heat <span className="id">{(l.heats ?? []).join(', ') || '-'}</span></div>
                      <div className="small muted">{l.description}</div>
                      {art && <div className={`small check ${art.verified ? 'ok' : 'bad'}`}>{art.verified ? 'Scan check passed' : 'Scan check failed'}</div>}
                      <div className="row" style={{ marginTop: 6 }}>
                        <Link className="btn small" to={`/records/${l.code}`}>Details</Link>
                        {l.token && <Link className="btn small" to={`/t/${l.token}`}>Open as scanned</Link>}
                        <button className="btn small" disabled={!art} onClick={() => pngOne(l)}>PNG</button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            <aside className="sheet-preview-wrap">
              <h2 className="no-print">Sheet preview</h2>
              <p className="small muted no-print">{sheet.name}, {sheet.detail}. Grey boxes are skipped slots.</p>
              <div className={`print-sheets${outlines ? ' outlines' : ''}`}>
                {pages.map((cells, p) => (
                  <div key={p} className="sheet-page">
                    {Array.from({ length: slots }, (_, i) => {
                      const l = cells[i];
                      const pos = slotPosition(sheet, i, offset);
                      const at = { left: `${pos.x}mm`, top: `${pos.y}mm` };
                      return l ? <SheetLabel key={i} label={l} art={arts[l.code]} sheet={sheet} style={at} />
                        : <div key={i} className={`slabel-empty${p === 0 && i < startAt - 1 ? ' used' : ''}`} style={{ ...at, width: `${sheet.w}mm`, height: `${sheet.h}mm` }} />;
                    })}
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </>
      )}
    </>
  );
}

function SheetIcon({ cols, rows }: { cols: number; rows: number }) {
  const w = 21; const h = 29.7; const gx = 1; const m = 1.4;
  const cw = (w - 2 * m - gx * (cols - 1)) / cols; const ch = (h - 2 * m) / rows;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="30" height="42" aria-hidden="true">
      <rect x=".3" y=".3" width={w - .6} height={h - .6} fill="#fff" stroke="currentColor" strokeWidth=".6" />
      {Array.from({ length: cols * rows }, (_, i) => (
        <rect key={i} x={m + (i % cols) * (cw + gx)} y={m + Math.floor(i / cols) * ch + .25} width={cw} height={ch - .5} rx=".5" fill="currentColor" opacity=".28" />
      ))}
    </svg>
  );
}
