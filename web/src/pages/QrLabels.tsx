import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { Link, useSearchParams } from 'react-router-dom';
import { qrLinkFor } from '../api';
import { ErrorBox, Id, Loading, useApi } from '../ui';

interface Label {
  code: string; token: string | null; url: string | null; hint: string; issuedAt: string; versionNo: number;
  partNumber: string; description: string; revision: string | null; supplier: string;
  purchaseOrder: string | null; poLine: string | null; quantity: string | null; patternNumber: string | null; heats: string[] | null;
}

const linkOf = (l: Label) => l.url ?? (l.token ? qrLinkFor(l.token) : '');

/** One printable label as a PNG: QR on the left, the identifying fields on the right. */
async function labelPng(l: Label): Promise<string> {
  const W = 1200; const H = 560;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#22272b'; ctx.lineWidth = 6; ctx.strokeRect(3, 3, W - 6, H - 6);
  const qr = document.createElement('canvas');
  await QRCode.toCanvas(qr, linkOf(l), { errorCorrectionLevel: 'M', margin: 1, width: 480 });
  ctx.drawImage(qr, 40, 40, 480, 480);
  ctx.fillStyle = '#22272b';
  const lines: [string, string, number][] = [
    [l.code, 'bold 52px "IBM Plex Mono", monospace', 70],
    [`Part ${l.partNumber}${l.revision ? `  Rev ${l.revision}` : ''}`, 'bold 34px Arial, sans-serif', 60],
    [l.description.slice(0, 34), '28px Arial, sans-serif', 50],
    [`PO ${l.purchaseOrder ?? '-'}  Line ${l.poLine ?? '-'}`, '30px Arial, sans-serif', 50],
    [`Qty ${l.quantity ?? '-'}   Heat ${(l.heats ?? []).join(', ')}`, '30px Arial, sans-serif', 50],
    [`Pattern ${l.patternNumber ?? '-'}`, '28px Arial, sans-serif', 50],
    [l.supplier.slice(0, 36), '26px Arial, sans-serif', 50],
  ];
  let y = 100;
  for (const [text, font, step] of lines) { ctx.font = font; ctx.fillText(text, 560, y); y += step; }
  return c.toDataURL('image/png');
}

function download(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href; a.download = name; a.click();
}

export function QrLabels() {
  const [params] = useSearchParams();
  const [data, error] = useApi<{ labels: Label[] }>('/qr-labels');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [images, setImages] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data) return;
    const only = params.get('codes')?.split(',').filter(Boolean);
    setSelected(new Set(only?.length ? only : data.labels.map((l) => l.code)));
    (async () => {
      const out: Record<string, string> = {};
      for (const l of data.labels) if (l.token) out[l.code] = await QRCode.toDataURL(linkOf(l), { errorCorrectionLevel: 'M', margin: 1, width: 260 });
      setImages(out);
    })();
  }, [data, params]);

  const shown = useMemo(() => {
    const s = q.trim().toUpperCase();
    return (data?.labels ?? []).filter((l) => !s || [l.code, l.partNumber, l.purchaseOrder, l.description, l.supplier, ...(l.heats ?? [])].some((v) => v?.toUpperCase().includes(s)));
  }, [data, q]);
  const chosen = shown.filter((l) => selected.has(l.code));
  const toggle = (code: string) => setSelected((s) => { const n = new Set(s); n.has(code) ? n.delete(code) : n.add(code); return n; });

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['record', 'part_number', 'revision', 'part_description', 'purchase_order_number', 'po_line_number', 'quantity', 'heat_numbers', 'pattern_number', 'supplier', 'qr_link'],
      ...chosen.map((l) => [l.code, l.partNumber, l.revision, l.description, l.purchaseOrder, l.poLine, l.quantity, (l.heats ?? []).join('|'), l.patternNumber, l.supplier, linkOf(l)])];
    download(URL.createObjectURL(new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' })), 'spir-qr-labels.csv');
  };
  const pngAll = async () => { for (const l of chosen) download(await labelPng(l), `${l.code}.png`); };

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <>
      <div className="page-head no-print">
        <h1>QR labels</h1>
        <p className="lede">One QR code per shipment record. Scanning it opens that shipment's details in SPIR. A QR code never changes when the
          data is updated by a later import.</p>
      </div>
      {data.labels.length === 0 ? (
        <div className="empty">No QR codes yet. <Link to="/import">Import a CSV</Link> to create them.</div>
      ) : (
        <>
          <div className="row no-print" style={{ marginBottom: 14 }}>
            <input className="search" type="search" placeholder="Filter by part number, PO, heat, record" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter labels" />
            <button className="btn small" onClick={() => setSelected(new Set(shown.map((l) => l.code)))}>Select all</button>
            <button className="btn small" onClick={() => setSelected(new Set())}>Select none</button>
            <span className="small muted">{chosen.length} of {data.labels.length} selected</span>
          </div>
          <div className="row no-print" style={{ marginBottom: 18 }}>
            <button className="btn primary" onClick={() => window.print()} disabled={!chosen.length}>Print selected labels</button>
            <button className="btn" onClick={pngAll} disabled={!chosen.length}>Download PNGs</button>
            <button className="btn" onClick={exportCsv} disabled={!chosen.length}>Export links as CSV</button>
          </div>
          {data.labels.some((l) => !l.url) && (
            <p className="small muted no-print">QR codes point to this web address ({qrLinkFor('...').replace('/#/t/...', '')}). Set PUBLIC_APP_URL on the API so labels point to your permanent address.</p>
          )}
          <div className="qr-sheet">
            {shown.map((l) => (
              <article key={l.code} className={`qr-label${selected.has(l.code) ? '' : ' unselected'}`}>
                <label className="qr-pick no-print"><input type="checkbox" checked={selected.has(l.code)} onChange={() => toggle(l.code)} /> Print</label>
                {l.token && images[l.code] ? <img src={images[l.code]} alt={`QR code for ${l.code}`} /> : <div className="small muted">QR unavailable (issued with another key)</div>}
                <div className="qr-text">
                  <div className="id qr-code">{l.code}</div>
                  <div><strong className="id">{l.partNumber}</strong>{l.revision ? <span className="small"> Rev {l.revision}</span> : null}</div>
                  <div className="small">{l.description}</div>
                  <div className="small">PO <span className="id">{l.purchaseOrder ?? '-'}</span> line {l.poLine ?? '-'}</div>
                  <div className="small">Qty {l.quantity ?? '-'}, heat <span className="id">{(l.heats ?? []).join(', ')}</span></div>
                  <div className="small">Pattern <span className="id">{l.patternNumber ?? '-'}</span></div>
                  <div className="small muted">{l.supplier}</div>
                  <div className="row no-print" style={{ marginTop: 6 }}>
                    <Link className="btn small" to={`/records/${l.code}`}>Details</Link>
                    {l.token && <Link className="btn small" to={`/t/${l.token}`}>Open as scanned</Link>}
                    <button className="btn small" onClick={async () => download(await labelPng(l), `${l.code}.png`)}>PNG</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}
