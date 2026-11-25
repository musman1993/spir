// Image quality checks + preprocessing before OCR (spec 11A.5, FR-OCR-002).
// The ORIGINAL capture is always what gets stored as evidence; preprocessing only feeds the OCR engine.

export interface Preprocess { rotate: 0 | 90 | 180 | 270; grayscale: boolean; contrast: number; threshold: boolean; crop?: { x: number; y: number; w: number; h: number } }
export const DEFAULT_PREPROCESS: Preprocess = { rotate: 0, grayscale: true, contrast: 1.4, threshold: false };

export async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

export function preprocess(img: HTMLImageElement, p: Preprocess, maxSide = 2400): HTMLCanvasElement {
  const crop = p.crop ?? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  const scale = Math.min(1, maxSide / Math.max(crop.w, crop.h));
  const w = Math.round(crop.w * scale);
  const h = Math.round(crop.h * scale);
  const swap = p.rotate === 90 || p.rotate === 270;
  const c = document.createElement('canvas');
  c.width = swap ? h : w;
  c.height = swap ? w : h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((p.rotate * Math.PI) / 180);
  ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (p.grayscale || p.contrast !== 1 || p.threshold) {
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const a = d.data;
    for (let i = 0; i < a.length; i += 4) {
      let v = p.grayscale ? 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2] : a[i];
      v = (v - 128) * p.contrast + 128;
      if (p.threshold) v = v > 140 ? 255 : 0;
      v = Math.max(0, Math.min(255, v));
      if (p.grayscale || p.threshold) { a[i] = a[i + 1] = a[i + 2] = v; }
      else {
        a[i] = Math.max(0, Math.min(255, (a[i] - 128) * p.contrast + 128));
        a[i + 1] = Math.max(0, Math.min(255, (a[i + 1] - 128) * p.contrast + 128));
        a[i + 2] = Math.max(0, Math.min(255, (a[i + 2] - 128) * p.contrast + 128));
      }
    }
    ctx.putImageData(d, 0, 0);
  }
  return c;
}

/** Quick suitability checks: resolution, brightness, and a blur estimate (variance of a Laplacian). */
export function qualityCheck(img: HTMLImageElement): { ok: boolean; warnings: string[]; metrics: Record<string, number> } {
  const w = 480;
  const h = Math.round((img.naturalHeight / img.naturalWidth) * w) || 1;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0; i < w * h; i++) { g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]; sum += g[i]; }
  const mean = sum / (w * h);
  let lapSum = 0; let lapSq = 0; let n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
    lapSum += l; lapSq += l * l; n++;
  }
  const sharpness = lapSq / n - (lapSum / n) ** 2;
  const warnings: string[] = [];
  if (Math.min(img.naturalWidth, img.naturalHeight) < 600) warnings.push('Low resolution - move closer or use a higher-resolution camera.');
  if (mean < 60) warnings.push('Image is dark - add light or avoid shadows on the label.');
  if (mean > 225) warnings.push('Image is very bright - reduce glare or reflections.');
  if (sharpness < 60) warnings.push('Image looks blurred - hold steady and refocus.');
  return { ok: warnings.length === 0, warnings, metrics: { width: img.naturalWidth, height: img.naturalHeight, brightness: Math.round(mean), sharpness: Math.round(sharpness) } };
}
