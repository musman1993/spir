// The printed shipment label: QR on the left, Part #, PO # and Heat # beside it.
import type { CSSProperties } from 'react';
import { svgDataUrl, svgToCanvas, type QrArt } from './render';
import type { SheetTemplate } from './sheets';

export interface LabelData {
  code: string;
  partNumber: string;
  purchaseOrder: string | null;
  poLine: string | null;
  heats: string[] | null;
}

const fields = (l: LabelData): [string, string, string?][] => [
  ['Part #', l.partNumber],
  ['PO #', l.purchaseOrder ?? '-', l.poLine ? `line ${l.poLine}` : undefined],
  ['Heat #', (l.heats ?? []).join(', ') || '-'],
];

export function SheetLabel({ label, art, sheet, style }: { label: LabelData; art: QrArt | undefined; sheet: SheetTemplate; style?: CSSProperties }) {
  const vars = {
    '--lw': `${sheet.w}mm`, '--lh': `${sheet.h}mm`, '--qr': `${sheet.qr}mm`, '--pad': `${sheet.pad}mm`,
    '--cap': `${sheet.cap}mm`, '--val': `${sheet.val}mm`, ...style,
  } as CSSProperties;
  return (
    <div className="slabel" style={vars}>
      {art ? <img className="slabel-qr" src={svgDataUrl(art.svg)} alt={`QR code for ${label.code}`} /> : <div className="slabel-qr" />}
      <dl className="slabel-fields">
        {fields(label).map(([k, v, extra]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>
              {k === 'Heat #' && label.heats?.length
                ? label.heats.map((h, i) => <span key={h} className="nobr">{h}{i < label.heats!.length - 1 ? ', ' : ''}</span>)
                : v}
              {extra && <span className="slabel-extra"> {extra}</span>}
            </dd>
          </div>
        ))}
        <div className="slabel-code">{label.code}</div>
      </dl>
    </div>
  );
}

/** Shrink a font until the text fits the width. */
function fit(ctx: CanvasRenderingContext2D, text: string, font: (px: number) => string, px: number, maxW: number) {
  let s = px;
  ctx.font = font(s);
  while (s > 8 && ctx.measureText(text).width > maxW) { s -= 1; ctx.font = font(s); }
  return s;
}

/** The same label as a 300 dpi PNG at the sheet's real size, for label software or a print shop. */
export async function labelPng(label: LabelData, art: QrArt, sheet: SheetTemplate): Promise<string> {
  await document.fonts?.ready;
  const k = 300 / 25.4; // px per mm
  const W = Math.round(sheet.w * k); const H = Math.round(sheet.h * k);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const pad = sheet.pad * k; const qr = Math.min(sheet.qr * k, H - 2 * pad);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(await svgToCanvas(art.svg, Math.round(qr)), pad, (H - qr) / 2, qr, qr);

  const x = pad + qr + 2 * k; const maxW = W - x - pad;
  const cap = sheet.cap * k; const val = sheet.val * k;
  const sans = (px: number) => `500 ${px}px Archivo, Arial, sans-serif`;
  const mono = (px: number) => `600 ${px}px "IBM Plex Mono", monospace`;
  const block = cap * 1.2 + val * 1.25;
  let y = (H - (block * 3 + cap * 1.6)) / 2;
  ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
  for (const [kName, v, extra] of fields(label)) {
    ctx.font = sans(cap); ctx.fillStyle = '#444'; ctx.fillText(kName, x, y);
    y += cap * 1.2;
    const text = extra ? `${v}  ${extra}` : v;
    fit(ctx, text, mono, val, maxW); ctx.fillStyle = '#000'; ctx.fillText(text, x, y);
    y += val * 1.25;
  }
  ctx.font = sans(cap * 0.9); ctx.fillStyle = '#444'; ctx.fillText(label.code, x, y + cap * 0.5);
  return c.toDataURL('image/png');
}
