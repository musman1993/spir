// A4 sticker-sheet templates (all sizes in millimetres). Dimensions follow the common Avery/Herma
// layouts; any sheet with the same label size and margins works.
export interface SheetTemplate {
  id: string;
  name: string;
  detail: string;
  cols: number;
  rows: number;
  /** Label width and height. */
  w: number;
  h: number;
  /** Page margins to the first label, and gaps between labels. */
  top: number;
  left: number;
  gapX: number;
  gapY: number;
  /** QR size including its quiet zone, inner padding, caption and value text heights. */
  qr: number;
  pad: number;
  cap: number;
  val: number;
}

export const SHEETS: SheetTemplate[] = [
  { id: 'a4-8', name: '8 per sheet', detail: '99.1 × 67.7 mm, e.g. Avery L7165', cols: 2, rows: 4, w: 99.1, h: 67.7, top: 13.1, left: 4.65, gapX: 2.5, gapY: 0, qr: 54, pad: 5, cap: 2.6, val: 4.6 },
  { id: 'a4-14', name: '14 per sheet', detail: '99.1 × 38.1 mm, e.g. Avery L7163', cols: 2, rows: 7, w: 99.1, h: 38.1, top: 15.15, left: 4.65, gapX: 2.5, gapY: 0, qr: 33, pad: 2.6, cap: 2.1, val: 3.5 },
  { id: 'a4-21', name: '21 per sheet', detail: '63.5 × 38.1 mm, e.g. Avery L7160', cols: 3, rows: 7, w: 63.5, h: 38.1, top: 15.15, left: 7.25, gapX: 2.5, gapY: 0, qr: 32, pad: 2.4, cap: 1.9, val: 2.9 },
];

export const sheetById = (id: string | null | undefined) => SHEETS.find((s) => s.id === id) ?? SHEETS[0];
export const perSheet = (s: SheetTemplate) => s.cols * s.rows;

/** Position of slot i (0-based) on its page, in mm from the page's top-left corner. */
export function slotPosition(s: SheetTemplate, i: number, offset = { x: 0, y: 0 }) {
  const k = i % perSheet(s);
  const col = k % s.cols;
  const row = Math.floor(k / s.cols);
  return { x: s.left + col * (s.w + s.gapX) + offset.x, y: s.top + row * (s.h + s.gapY) + offset.y };
}

/** Small persisted settings (per browser). Storage can be unavailable, so failures are ignored. */
export function readSetting<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
export function writeSetting(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not persisted */ }
}
