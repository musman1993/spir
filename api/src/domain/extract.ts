// Label field extraction (spec 11A.6): turns raw OCR output + decoded barcodes into
// field candidates using a versioned label profile. Raw text, confidence, bounding box and
// method are kept for every candidate (FR-OCR-006).

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
  method: 'ALIAS_LINE' | 'PATTERN' | 'BARCODE' | 'NONE';
  sourceLine: string | null;
  alternatives: string[];      // other distinct values seen for this field (ambiguity)
}

export interface Extraction {
  candidates: Record<string, Candidate>;
  qrTokens: string[];          // SPIR QR tokens decoded from barcodes
  meanConfidence: number | null;
}

const to01 = (c: number | undefined | null): number | null =>
  c == null || Number.isNaN(c) ? null : c > 1 ? Math.max(0, Math.min(1, c / 100)) : Math.max(0, c);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function unionBox(boxes: (BBox | undefined)[]): BBox | null {
  const b = boxes.filter(Boolean) as BBox[];
  if (!b.length) return null;
  return {
    x0: Math.min(...b.map((x) => x.x0)), y0: Math.min(...b.map((x) => x.y0)),
    x1: Math.max(...b.map((x) => x.x1)), y1: Math.max(...b.map((x) => x.y1)),
  };
}

/** Confidence/bbox for a value: average over the OCR words that make up the value. */
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
  const m = t.match(/\/t\/([A-Za-z0-9_-]{32,})\/?$/) ?? t.match(/^spir:([A-Za-z0-9_-]{32,})$/i);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
}

export function linesFrom(ocr: OcrInput): OcrLine[] {
  if (ocr.lines?.length) return ocr.lines;
  return (ocr.text ?? '').split(/\r?\n/).map((text) => ({ text, confidence: ocr.confidence ?? undefined }));
}

export function extractFields(ocr: OcrInput, barcodes: BarcodeRead[], profile: LabelProfileConfig): Extraction {
  const lines = linesFrom(ocr).filter((l) => l.text.trim());
  const candidates: Record<string, Candidate> = {};
  const claimed = new Set<string>();
  const qrTokens: string[] = [];

  // 1) Barcodes: SPIR QR tokens, or simple "KEY:VALUE;KEY:VALUE" payloads from supplier barcodes.
  const barcodeFields: Record<string, string> = {};
  for (const b of barcodes ?? []) {
    const token = parseSpirQr(b.text);
    if (token) { qrTokens.push(token); continue; }
    for (const part of b.text.split(/[;|\n]/)) {
      const kv = part.match(/^\s*([^:=]+)[:=]\s*(.+?)\s*$/);
      if (!kv) continue;
      const k = kv[1].trim().toUpperCase();
      for (const [key, fp] of Object.entries(profile.fields)) {
        if (fp.aliases.some((a) => a.toUpperCase() === k) || key.toUpperCase() === k) barcodeFields[key] ??= kv[2];
      }
    }
  }

  // Longest aliases first so "HEAT NO" wins over "HEAT".
  for (const [key, fp] of Object.entries(profile.fields)) {
    const pattern = fp.pattern ? new RegExp(`(?:^|[^A-Z0-9])(${fp.pattern})(?![A-Z0-9])`, 'i') : null;
    const aliases = [...fp.aliases].sort((a, b) => b.length - a.length);
    const found: { value: string; line: OcrLine }[] = [];

    for (const line of lines) {
      const upper = line.text.toUpperCase();
      for (const alias of aliases) {
        const re = new RegExp(`(?:^|[^A-Z0-9])${escapeRe(alias.toUpperCase())}\\.?\\s*[:#=\\-.]?\\s*(.+)$`);
        const m = upper.match(re);
        if (!m) continue;
        // Keep original casing/punctuation from the source line for the raw value.
        const restStart = line.text.length - m[1].length;
        const rest = line.text.slice(restStart).trim();
        let value: string | null = null;
        if (pattern) {
          const pm = (' ' + rest).match(pattern);
          if (pm && (' ' + rest).indexOf(pm[1]) <= 3) value = pm[1];
        }
        if (!value) value = rest.split(/\s{2,}|\s+\|\s+|\t/)[0].split(/\s+(?=[A-Z][A-Z /]{1,20}[:#])/)[0].trim();
        value = value.replace(/[;,]+$/, '').trim();
        if (value) found.push({ value, line });
        break; // one alias match per line
      }
    }

    if (found.length) {
      const distinct = [...new Set(found.map((f) => f.value.toUpperCase()))];
      const first = found[0];
      const loc = locate(first.line, first.value);
      candidates[key] = {
        attributeKey: key, raw: first.value, confidence: loc.confidence, bbox: loc.bbox,
        method: 'ALIAS_LINE', sourceLine: first.line.text,
        alternatives: distinct.length > 1 ? found.slice(1).map((f) => f.value).filter((v) => v.toUpperCase() !== first.value.toUpperCase()) : [],
      };
      claimed.add(first.value.toUpperCase());
    } else if (barcodeFields[key]) {
      candidates[key] = {
        attributeKey: key, raw: barcodeFields[key], confidence: 1, bbox: null,
        method: 'BARCODE', sourceLine: null, alternatives: [],
      };
    }
  }

  // 2) Pattern fallback for fields with no alias hit (e.g. "MADE IN GERMANY", a bare date).
  for (const [key, fp] of Object.entries(profile.fields)) {
    if (candidates[key] || !fp.patternFallback || !fp.pattern) continue;
    const re = new RegExp(`(?:^|[^A-Z0-9])(${fp.pattern})(?![A-Z0-9])`, 'i');
    for (const line of lines) {
      const m = line.text.match(re);
      if (m && !claimed.has(m[1].toUpperCase())) {
        const loc = locate(line, m[1]);
        candidates[key] = {
          attributeKey: key, raw: m[1].trim(), confidence: loc.confidence, bbox: loc.bbox,
          method: 'PATTERN', sourceLine: line.text, alternatives: [],
        };
        claimed.add(m[1].toUpperCase());
        break;
      }
    }
  }

  // Barcode values are machine-read: if both OCR and barcode exist and agree, keep OCR evidence
  // but note it; if they disagree, surface the barcode value as an alternative (ambiguity).
  for (const [key, val] of Object.entries(barcodeFields)) {
    const c = candidates[key];
    if (c && c.method !== 'BARCODE' && c.raw && c.raw.toUpperCase() !== val.toUpperCase()) c.alternatives.push(val);
  }

  for (const key of Object.keys(profile.fields)) {
    candidates[key] ??= { attributeKey: key, raw: null, confidence: null, bbox: null, method: 'NONE', sourceLine: null, alternatives: [] };
  }

  return { candidates, qrTokens, meanConfidence: to01(ocr.confidence ?? null) };
}
