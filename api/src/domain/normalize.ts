// Attribute-specific normalization (spec 11A.9).
// Rules never remove meaningful distinctions: identifiers keep hyphens, slashes and leading zeros;
// only surrounding whitespace, letter case and runs of inner whitespace are normalised.

export type ComparisonRule = {
  method: 'identifier' | 'code' | 'date' | 'decimal' | 'country';
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
};

/** Parse a date using ONLY the formats configured on the label profile (no guessing). */
export function parseDate(raw: string, formats: string[]): string | null {
  const s = raw.trim();
  for (const f of formats) {
    const spec = FORMAT_REGEX[f];
    if (!spec) continue;
    const m = s.match(spec.re);
    if (!m) continue;
    const parts: Record<string, number> = {};
    spec.order.forEach((k, i) => (parts[k] = Number(m[i + 1])));
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
    case 'identifier':
      return { ok: true, value: normIdentifier(s) };
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
  return normIdentifier(value);
}

export function valuesEqual(a: string, b: string, rule: ComparisonRule): boolean {
  if (rule.method === 'decimal') {
    const tol = rule.tolerance ?? 0;
    return Math.abs(Number(a) - Number(b)) <= tol;
  }
  return a === b;
}

// Characters OCR engines commonly confuse. Used ONLY to flag "possible misread - review",
// never to turn a mismatch into a match (FR-OCR-017, spec 11A.9).
const CONFUSABLE: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
export function ocrSkeleton(s: string): string {
  return s.toUpperCase().replace(/[OQDILZSBG]/g, (c) => CONFUSABLE[c]);
}
