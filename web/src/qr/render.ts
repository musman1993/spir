// QR rendering for printed labels.
// - Fewest squares first: the error-correction level is the strongest one (H, Q, then M) that does not
//   make the code bigger than level M would. Bigger squares matter more to a phone than spare correction.
//   The logo covers about 3-4% of the code, well inside even M's 15%.
// - A 2-module white border inside the image; the label's white padding around it brings the total to
//   at least the 4 modules the QR standard asks for. Callers that show the code on its own pass 4.
// - Vector SVG output, so the code prints crisply at any size on any printer.
// - Every code is decoded again with ZXing after drawing; if the logo makes it unreadable, the logo
//   is made smaller or dropped. A label is never printed with a code that failed this check.
import QRCode from 'qrcode';
import { zxingBarcode } from '../devices/barcode';

export const QUIET_ZONE = 2;
type Level = 'L' | 'M' | 'Q' | 'H';

/** Strongest level whose code is no larger than level M's. */
function pickLevel(text: string): Level {
  const base = QRCode.create(text, { errorCorrectionLevel: 'M' }).version;
  for (const l of ['H', 'Q'] as Level[]) if (QRCode.create(text, { errorCorrectionLevel: l }).version <= base) return l;
  return 'M';
}

export interface QrArt {
  svg: string;
  /** Modules per side, without the quiet zone. */
  modules: number;
  version: number;
  /** Fraction of the code's width given to the logo (0 = no logo). */
  logoRatio: number;
  /** Decoded back to the same text by ZXing. */
  verified: boolean;
  level: Level;
}

function buildSvg(text: string, logo: string | null, logoRatio: number, level: Level, quiet: number) {
  const QUIET_ZONE = quiet;
  const qr = QRCode.create(text, { errorCorrectionLevel: level });
  const n = qr.modules.size;
  const total = n + QUIET_ZONE * 2;
  // Logo zone: an odd number of whole modules, centred, so the knock-out lines up with the grid.
  let zone = logo && logoRatio > 0 ? Math.round(n * logoRatio) : 0;
  if (zone && zone % 2 === 0) zone += 1;
  const z0 = Math.floor((n - zone) / 2);
  const inZone = (x: number, y: number) => zone > 0 && x >= z0 && x < z0 + zone && y >= z0 && y < z0 + zone;

  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.modules.data[y * n + x] && !inZone(x, y)) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    }
  }
  let logoSvg = '';
  if (zone) {
    const p = 0.6; // breathing room between the logo and the nearest modules
    const x = z0 + QUIET_ZONE;
    logoSvg = `<rect x="${x}" y="${x}" width="${zone}" height="${zone}" rx="1" fill="#fff"/>`
      + `<image href="${logo}" x="${x + p}" y="${x + p}" width="${zone - 2 * p}" height="${zone - 2 * p}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/>${logoSvg}</svg>`;
  return { svg, modules: n, version: qr.version };
}

export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Rasterise an SVG string (logo must already be a data URL inside it). */
export function svgToCanvas(svg: string, px: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = px; c.height = px;
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, px, px);
      resolve(c);
    };
    img.onerror = () => reject(new Error('Could not draw the QR code.'));
    img.src = svgDataUrl(svg);
  });
}

async function decodesTo(svg: string, text: string) {
  try {
    const reads = await zxingBarcode.decodeImage(await svgToCanvas(svg, 480));
    return reads.some((r) => r.text === text);
  } catch {
    return false;
  }
}

const cache = new Map<string, Promise<QrArt>>();

/** Render a label QR, shrinking or dropping the logo until the code decodes reliably. */
export function renderQr(text: string, logo: string | null, quiet = QUIET_ZONE): Promise<QrArt> {
  const key = `${logo ? logo.length + logo.slice(-32) : '-'}|${quiet}|${text}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const level = pickLevel(text);
      const ratios = logo ? (level === 'M' ? [0.18, 0.14, 0] : [0.2, 0.16, 0.12, 0]) : [0];
      for (const ratio of ratios) {
        const b = buildSvg(text, logo, ratio, level, quiet);
        if (await decodesTo(b.svg, text)) return { ...b, logoRatio: ratio, verified: true, level };
      }
      const b = buildSvg(text, null, 0, level, quiet);
      return { ...b, logoRatio: 0, verified: false, level };
    })();
    cache.set(key, p);
  }
  return p;
}
