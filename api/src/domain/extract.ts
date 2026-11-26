// Label field extraction (spec 11A.6): turns raw OCR output + decoded barcodes into
// field candidates using a versioned label profile. Raw text, confidence, bounding box and
// method are kept for every candidate (FR-OCR-006).
import { levenshtein } from './normalize.js';

export interface BBox { x0: number; y0: number; x1: number; y1: number }
export interface OcrWord { text: string; confidence?: number; bbox?: BBox }
export interface OcrLine { text: string; confidence?: number; bbox?: BBox; words?: OcrWord[] }
export interface OcrInput {
  engine?: string;
  engineVersion?: string;
  text: string;
  confidence?: number | null;     // 0..100 (tesseract) or 0..1
  lines?: OcrLine[];
}
export interface BarcodeRead { format: string; text: string }

export interface FieldProfile {
  aliases: string[];
  pattern?: string;
  patternFallback?: boolean;
  barcodePattern?: string;
  fallbackPattern?: string;
  confidenceThreshold?: number;
}
export interface LabelProfileConfig {
  language?: string;
  dateFormats: string[];
  defaultConfidenceThreshold: number;
  fields: Record<string, FieldProfile>;
}

export interface Candidate {
  attributeKey: string;
  raw: string | null;
  confidence: number | null;   // 0..1, null when the engine gave none
  bbox: BBox | null;
  method: 'ALIAS_LINE' | 'FUZZY_ALIAS' | 'PATTERN' | 'BARCODE' | 'NONE';
  sourceLine: string | null;
  alternatives: string[];      // other distinct values seen for this field (ambiguity)
  note?: string;
}

export interface Extraction {
  candidates: Record<string, Candidate>;
  qrTokens: string[];          // SPIR QR tokens decoded from barcodes
  meanConfidence: number | null;
}

const to01 = (c: number | undefined | null): number | null =>
  c == null || Number.isNaN(c) ? null : c > 1 ? Math.max(0, Math.min(1, c / 100)) : Math.max(0, c);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

function unionBox(boxes: (BBox | undefined)[]): BBox | null {
  const b = boxes.filter(Boolean) as BBox[];
  if (!b.length) return null;
  return {
    x0: Math.min(...b.map((x) => x.x0)), y0: Math.min(...b.map((x) => x.y0)),
    x1: Math.max(...b.map((x) => x.x1)), y1: Math.max(...b.map((x) => x.y1)),
  };
}

/** Confidence/bbox for a value: the weakest OCR word that makes up the value. */
function locate(line: OcrLine, value: string): { confidence: number | null; bbox: BBox | null } {
  const words = line.words ?? [];
  const tokens = value.toUpperCase().split(/\s+/).filter(Boolean);
  const hits = words.filter((w) => {
    const wt = w.text.toUpperCase().replace(/^[:;,]+|[:;,]+$/g, '');
    if (wt.length < 2) return false;
    return tokens.some((t) => wt === t || wt.includes(t) || t.includes(wt));
  });
  if (hits.length) {
    const cs = hits.map((w) => to01(w.confidence)).filter((c): c is number => c != null);
    return { confidence: cs.length ? Math.min(...cs) : to01(line.confidence), bbox: unionBox(hits.map((h) => h.bbox)) };
  }
  return { confidence: to01(line.confidence), bbox: line.bbox ?? null };
}

/** Accepts "https://host/#/t/<token>", "spir:<token>" or a bare 43-char base64url token. */
export function parseSpirQr(text: string): string | null {
  const t = text.trim();
  const m = t.match(/\/t\/([A-Za-z0-9_-]{16,})\/?$/) ?? t.match(/^spir:([A-Za-z0-9_-]{16,})$/i);
  if (m) return m[1];
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(t) || /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
}

export function linesFrom(ocr: OcrInput): OcrLine[] {
  if (ocr.lines?.length) return ocr.lines;
  return (ocr.text ?? '').split(/\r?\n/).map((text) => ({ text, confidence: ocr.confidence ?? undefined }));
}

/** Pull the value out of the text that follows a field label. */
function valueFrom(rest: string, fp: FieldProfile): string | null {
  if (fp.pattern) {
    const text = ' ' + rest;
    const m = text.match(new RegExp(`(?:^|[^A-Z0-9])(${fp.pattern})(?![A-Z0-9])`, 'i'));
    // A field with a known value shape never accepts text that doesn't have that shape.
    if (!m) return null;
    // If OCR glued junk onto the value ("DH-55%0"), keep the whole token as the raw read so the
    // comparison can flag it for review instead of silently comparing a truncated "DH-55".
    const start = text.indexOf(m[1], m.index ?? 0);
    const tail = text.slice(start + m[1].length).match(/^[^\s,;|]*/)?.[0] ?? '';
    return (m[1] + (/[^A-Za-z0-9\s]/.test(tail) && /[A-Za-z0-9]/.test(tail) ? tail : '')).trim();
  }
  // Free text: up to a wide gap, a column separator, or the next "LABEL:" on the same line.
  const v = rest.split(/\s{3,}|\s+\|\s+|\t/)[0].split(/\s+(?=[A-Z][A-Za-z /]{1,24}\s?[:#])/)[0];
  return v.replace(/^[\s:;,.|+¢~=-]+/, '').replace(/[\s;,|]+$/, '').trim() || null;
}

const sepRe = (alias: string) => new RegExp(`(?:^|[^A-Z0-9])${escapeRe(alias.toUpperCase())}(?![A-Z0-9])\\.?\\s*[:#=\\-.+¢]?\\s*(.*)$`);

/** Exact, word-bounded field label anywhere on the line. */
function matchExact(line: string, aliases: string[]): string | null {
  const upper = line.toUpperCase();
  for (const alias of aliases) {
    const m = upper.match(sepRe(alias));
    if (m && m[1].trim()) return line.slice(line.length - m[1].length);
  }
  return null;
}

/** Does the line START with any known field label (exactly)? Then OCR-tolerant matching must not touch it. */
function startsWithKnownLabel(line: string, allAliases: string[]): boolean {
  const head = alnum(line.slice(0, 40));
  return allAliases.some((a) => { const x = alnum(a); return x.length >= 2 && head.startsWith(x); });
}

/** OCR-tolerant label at the START of the line: 1 error for 4-6 letter labels, 2 for longer ("PONe" = "PO NO"). */
function fuzzyDistance(line: string, alias: string): { distance: number; rest: string } | null {
  const head = line.replace(/^[^A-Za-z0-9]+/, '');
  const a = alnum(alias);
  if (a.length < 3) return null;
  // 3-letter labels ("QTY" read as "Qry") tolerate one error only if the first letter is right.
  if (a.length === 3 && head[0]?.toUpperCase() !== a[0]) return null;
  const allowed = a.length >= 7 ? 2 : 1;
  let best: { distance: number; rest: string } | null = null;
  for (const len of [a.length, a.length - 1, a.length + 1]) {
    let count = 0; let idx = 0;
    while (idx < head.length && count < len) { if (/[A-Za-z0-9]/.test(head[idx])) count++; idx++; }
    if (count < len) continue;
    const d = levenshtein(alnum(head.slice(0, idx)), a);
    const rest = head.slice(idx);
    if (d <= allowed && rest.trim() && (!best || d < best.distance)) best = { distance: d, rest };
  }
  return best;
}

export function extractFields(ocr: OcrInput, barcodes: BarcodeRead[], profile: LabelProfileConfig): Extraction {
  const lines = linesFrom(ocr).filter((l) => l.text.trim());
  const candidates: Record<string, Candidate> = {};
  const claimed = new Set<string>();
  const qrTokens: string[] = [];

  // 1) Barcodes: SPIR QR tokens; "KEY:VALUE;..." payloads; bare values assigned by barcodePattern.
  const barcodeFields: Record<string, string> = {};
  const bareFits: Record<string, Set<string>> = {};
  for (const b of barcodes ?? []) {
    const token = parseSpirQr(b.text);
    if (token) { qrTokens.push(token); continue; }
    let keyed = false;
    for (const part of b.text.split(/[;|\n]/)) {
      const kv = part.match(/^\s*([^:=]+)[:=]\s*(.+?)\s*$/);
      if (!kv) continue;
      const k = kv[1].trim().toUpperCase();
      for (const [key, fp] of Object.entries(profile.fields)) {
        if (fp.aliases.some((a) => a.toUpperCase() === k) || key.toUpperCase() === k) { barcodeFields[key] ??= kv[2]; keyed = true; }
      }
    }
    if (keyed) continue;
    const bare = b.text.trim();
    const fits = Object.entries(profile.fields).filter(([, fp]) => fp.barcodePattern && new RegExp(fp.barcodePattern, 'i').test(bare));
    if (fits.length === 1) (bareFits[fits[0][0]] ??= new Set()).add(bare); // only when the shape fits one field
  }
  // Two different bare barcodes with the same shape (e.g. PO and a receipt number) can't be told apart: skip.
  for (const [key, vals] of Object.entries(bareFits)) if (vals.size === 1) barcodeFields[key] ??= [...vals][0];

  // 2) Field labels on OCR lines (longest alias first so "HEAT NO" wins over "HEAT").
  //    A line that starts with no known label may be claimed by exactly ONE field through an
  //    OCR-tolerant match - the closest one; ties are not guessed.
  const allAliases = Object.values(profile.fields).flatMap((f) => f.aliases);
  const fuzzyOwner = new Map<OcrLine, { key: string; rest: string }>();
  for (const line of lines) {
    if (startsWithKnownLabel(line.text, allAliases)) continue;
    let best: { key: string; distance: number; rest: string } | null = null;
    let tie = false;
    for (const [key, fp] of Object.entries(profile.fields)) {
      for (const alias of fp.aliases) {
        const f = fuzzyDistance(line.text, alias);
        if (!f) continue;
        if (!best || f.distance < best.distance) { best = { key, ...f }; tie = false; }
        else if (f.distance === best.distance && best.key !== key) tie = true;
      }
    }
    if (best && !tie) fuzzyOwner.set(line, { key: best.key, rest: best.rest });
  }
  for (const [key, fp] of Object.entries(profile.fields)) {
    const aliases = [...fp.aliases].sort((a, b) => b.length - a.length);
    const found: { value: string; line: OcrLine; fuzzy: boolean }[] = [];
    for (const line of lines) {
      const exact = matchExact(line.text, aliases);
      const owner = fuzzyOwner.get(line);
      const rest = exact ?? (owner?.key === key ? owner.rest : null);
      if (rest == null) continue;
      const value = valueFrom(rest, fp);
      // An OCR-tolerant label only counts when the value follows it directly ("artNe + 1V658..."),
      // so a misread label can't grab text from further along the line.
      if (value && exact == null && !rest.replace(/^[\s:;+¢~=.#|-]+/, '').toUpperCase().startsWith(value.toUpperCase().slice(0, 3))) continue;
      if (value) found.push({ value, line, fuzzy: exact == null });
    }
    if (!found.length) continue;
    // Exact label matches beat OCR-tolerant ones.
    found.sort((a, b) => Number(a.fuzzy) - Number(b.fuzzy));
    const first = found[0];
    const distinct = [...new Set(found.filter((f) => !f.fuzzy || !found.some((x) => !x.fuzzy)).map((f) => f.value.toUpperCase()))];
    const loc = locate(first.line, first.value);
    candidates[key] = {
      attributeKey: key, raw: first.value, confidence: loc.confidence, bbox: loc.bbox,
      method: first.fuzzy ? 'FUZZY_ALIAS' : 'ALIAS_LINE', sourceLine: first.line.text,
      alternatives: distinct.length > 1 ? distinct.filter((v) => v !== first.value.toUpperCase()) : [],
      note: first.fuzzy ? 'Field label recognised despite OCR errors.' : undefined,
    };
    claimed.add(first.value.toUpperCase());
  }

  // 3) Pattern fallback for fields with no label hit (distinctive shapes: part numbers, POs, "MADE IN ...").
  for (const [key, fp] of Object.entries(profile.fields)) {
    const searchFor = fp.fallbackPattern ?? (fp.patternFallback ? fp.pattern : undefined);
    if (candidates[key] || !searchFor) continue;
    const re = new RegExp(`(?:^|[^A-Z0-9])(${searchFor})(?![A-Z0-9])`, 'i');
    for (const line of lines) {
      const m = line.text.match(re);
      if (m && !claimed.has(m[1].toUpperCase())) {
        const loc = locate(line, m[1]);
        candidates[key] = {
          attributeKey: key, raw: m[1].trim(), confidence: loc.confidence, bbox: loc.bbox,
          method: 'PATTERN', sourceLine: line.text, alternatives: [],
          note: 'Found by its format; no field label was readable.',
        };
        claimed.add(m[1].toUpperCase());
        break;
      }
    }
  }

  // 4) Merge barcodes. A barcode is machine-read, so it wins over a weak OCR read of the same field.
  //    If a CONFIDENT OCR read disagrees, both are kept and the field goes to human review.
  for (const [key, val] of Object.entries(barcodeFields)) {
    const c = candidates[key];
    const threshold = profile.fields[key]?.confidenceThreshold ?? profile.defaultConfidenceThreshold;
    const same = c?.raw && alnum(c.raw) === alnum(val);
    if (!c || same || (c.confidence ?? 0) < threshold) {
      candidates[key] = {
        attributeKey: key, raw: val, confidence: 1, bbox: same ? c!.bbox : null, method: 'BARCODE',
        sourceLine: c?.sourceLine ?? null, alternatives: [],
        note: c && !same ? `Barcode used; OCR text read "${c.raw}" with low confidence.` : same ? 'Barcode and printed text agree.' : undefined,
      };
    } else {
      c.alternatives.push(val);
      c.note = `Printed text and barcode disagree (barcode: ${val}).`;
    }
  }

  for (const key of Object.keys(profile.fields)) {
    candidates[key] ??= { attributeKey: key, raw: null, confidence: null, bbox: null, method: 'NONE', sourceLine: null, alternatives: [] };
  }

  return { candidates, qrTokens, meanConfidence: to01(ocr.confidence ?? null) };
}
