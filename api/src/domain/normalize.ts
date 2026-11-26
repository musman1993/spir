// Attribute-specific normalization (spec 11A.9).
// Rules never remove meaningful distinctions: identifiers keep hyphens, slashes and leading zeros;
// only surrounding whitespace, letter case and runs of inner whitespace are normalised.

export type ComparisonRule = {
  method: 'identifier' | 'code' | 'date' | 'decimal' | 'country' | 'integer' | 'quantity' | 'name' | 'text';
  source?: string;
  aliases?: Record<string, string>;
  tolerance?: number;
  unit?: string;
};

export type NormalizeResult = { ok: true; value: string } | { ok: false; reason: string };

export function normIdentifier(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, ' ');
}

function aliasLookup(value: string, aliases: Record<string, string> | undefined): string {
  const key = normIdentifier(value);
  if (!aliases) return key;
  // Alias keys are compared in the same normalised form.
  for (const [k, v] of Object.entries(aliases)) {
    if (normIdentifier(k) === key) return normIdentifier(v);
  }
  return key;
}

const FORMAT_REGEX: Record<string, { re: RegExp; order: ('Y' | 'M' | 'D')[] }> = {
  'YYYY-MM-DD': { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, order: ['Y', 'M', 'D'] },
  'YYYY/MM/DD': { re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, order: ['Y', 'M', 'D'] },
  'DD/MM/YYYY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ['D', 'M', 'Y'] },
  'MM/DD/YYYY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ['M', 'D', 'Y'] },
  'DD.MM.YYYY': { re: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, order: ['D', 'M', 'Y'] },
  'DD-MM-YYYY': { re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: ['D', 'M', 'Y'] },
  'DD-MMM-YYYY': { re: /^(\d{1,2})[- ]([A-Z]{3})[- ](\d{4})$/i, order: ['D', 'M', 'Y'] },
};
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Parse a date using ONLY the formats configured on the label profile (no guessing). */
export function parseDate(raw: string, formats: string[]): string | null {
  const s = raw.trim();
  for (const f of formats) {
    const spec = FORMAT_REGEX[f];
    if (!spec) continue;
    const m = s.match(spec.re);
    if (!m) continue;
    const parts: Record<string, number> = {};
    spec.order.forEach((k, i) => (parts[k] = /^[A-Z]+$/i.test(m[i + 1]) ? MONTHS.indexOf(m[i + 1].toUpperCase()) + 1 : Number(m[i + 1])));
    const { Y, M, D } = parts as { Y: number; M: number; D: number };
    const d = new Date(Date.UTC(Y, M - 1, D));
    if (d.getUTCFullYear() !== Y || d.getUTCMonth() !== M - 1 || d.getUTCDate() !== D) continue;
    return `${String(Y).padStart(4, '0')}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
  }
  return null;
}

export function normalize(raw: string, rule: ComparisonRule, dateFormats: string[]): NormalizeResult {
  if (raw == null || String(raw).trim() === '') return { ok: false, reason: 'empty' };
  const s = String(raw);
  switch (rule.method) {
    case 'identifier': {
      // OCR often glues punctuation to the ends of a value ("HT-77812,"); inner characters are kept.
      const v = normIdentifier(s).replace(/^[.,;:'"|]+|[.,;:'"|]+$/g, '');
      return v ? { ok: true, value: v } : { ok: false, reason: 'empty' };
    }
    case 'integer': {
      const m = s.toUpperCase().replace(/^\s*(LINE|LN|NO|#)\.?\s*[:#]?\s*/, '').match(/^\s*0*(\d{1,9})\b/);
      return m ? { ok: true, value: String(Number(m[1])) } : { ok: false, reason: 'not a whole number' };
    }
    case 'quantity': {
      // "02/02 No's" = piece 2 of a quantity of 2: the quantity is the SECOND number.
      const frac = s.match(/(\d{1,6})\s*\/\s*(\d{1,6})/);
      if (frac) return { ok: true, value: String(Number(frac[2])) };
      const m = s.match(/\d{1,6}/);
      return m ? { ok: true, value: String(Number(m[0])) } : { ok: false, reason: 'no quantity found' };
    }
    case 'name':
      return { ok: true, value: normName(s) };
    case 'text':
      return { ok: true, value: normText(s) };
    case 'code':
    case 'country': {
      // Strip trailing punctuation OCR often attaches, e.g. "CL300," but keep inner characters.
      const cleaned = s.trim().replace(/[.,;:]+$/, '');
      return { ok: true, value: aliasLookup(cleaned, rule.aliases) };
    }
    case 'date': {
      const iso = parseDate(s, dateFormats.length ? dateFormats : ['YYYY-MM-DD']);
      return iso ? { ok: true, value: iso } : { ok: false, reason: `not a date in formats ${dateFormats.join(', ')}` };
    }
    case 'decimal': {
      const n = Number(s.trim().replace(/\s*(MPA|HB|HBW|PSI|KSI)$/i, '').replace(',', '.'));
      return Number.isFinite(n) ? { ok: true, value: String(n) } : { ok: false, reason: 'not a number' };
    }
    default:
      return { ok: true, value: normIdentifier(s) };
  }
}

/** Approved registry values are trusted, so they only need the same canonical form. */
export function normalizeApproved(value: string, rule: ComparisonRule): string {
  if (rule.method === 'date') return parseDate(value, ['YYYY-MM-DD']) ?? value;
  if (rule.method === 'decimal') return String(Number(value));
  if (rule.method === 'integer' || rule.method === 'quantity') return String(Number(String(value).trim()));
  if (rule.method === 'name') return normName(value);
  if (rule.method === 'text') return normText(value);
  return normIdentifier(value);
}

export function valuesEqual(a: string, b: string, rule: ComparisonRule): boolean {
  if (rule.method === 'decimal') {
    const tol = rule.tolerance ?? 0;
    return Math.abs(Number(a) - Number(b)) <= tol;
  }
  if (rule.method === 'name') return a === b || (Math.min(a.length, b.length) >= 6 && dice(a, b) >= 0.9);
  if (rule.method === 'text') {
    // Labels truncate long descriptions: one being a prefix of the other (8+ chars) counts as agreement.
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    return a === b || (s.length >= 8 && l.startsWith(s)) || dice(a, b) >= 0.85;
  }
  return a === b;
}

/** Free text: case, punctuation and spacing are not meaningful. */
export function normText(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9/]+/g, ' ').trim();
}

// Legal-form words differ between documents ("Private Limited" vs "Pvt Ltd") and are often mangled
// by OCR at the end of a line, so they are dropped from the end of company names before comparing.
const LEGAL = new Set(['LTD', 'PVT', 'LLC', 'INC', 'GMBH', 'CO', 'CORP', 'AG', 'SA', 'SPA', 'BV', 'FZE', 'FZCO', 'FZ', 'LLP', 'PLC', 'PTE', 'SRL', 'KG']);
const LEGAL_PREFIXES = ['PRIV', 'LIMI', 'CORP', 'COMP', 'INCO'];
const STRONG_LEGAL = new Set(['PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLC', 'GMBH', 'INC', 'LLP', 'PLC', 'FZE', 'FZCO', 'SPA', 'SRL', 'PTE']);
export function normName(s: string): string {
  const raw = s.toUpperCase().replace(/^\s*M\/S\.?\s*/, '')
    .replace(/\b(?:[A-Z]\.\s?){2,}/g, (m) => m.replace(/[.\s]/g, '') + ' ')   // "L.L.C." -> "LLC"
    .replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  // Everything from the first unmistakable legal-form word on is dropped ("Pvt. Lud" -> OCR noise after PVT).
  const cut = raw.findIndex((t, i) => i > 0 && STRONG_LEGAL.has(t));
  const tokens = cut > 0 ? raw.slice(0, cut) : raw;
  while (tokens.length > 1) {
    const t = tokens[tokens.length - 1];
    if (LEGAL.has(t) || (t.length >= 4 && LEGAL_PREFIXES.includes(t.slice(0, 4)))) tokens.pop();
    else break;
  }
  return tokens.join(' ');
}

/** Sorensen-Dice similarity on character bigrams (0..1). */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (x: string) => { const m = new Map<string, number>(); for (let i = 0; i < x.length - 1; i++) { const g = x.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const ga = grams(a); const gb = grams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

/** Edit distance, used for OCR-tolerant matching of field labels (never of values). */
export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// Characters OCR engines commonly confuse. Used ONLY to flag "possible misread - review",
// never to turn a mismatch into a match (FR-OCR-017, spec 11A.9).
const CONFUSABLE: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
export function ocrSkeleton(s: string): string {
  return s.toUpperCase().replace(/[OQDILZSBG]/g, (c) => CONFUSABLE[c]);
}
