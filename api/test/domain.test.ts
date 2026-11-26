import { describe, expect, it } from 'vitest';
import { compareField, overallStatus, type FieldDefinition } from '../src/domain/compare.js';
import { extractFields, parseSpirQr, type LabelProfileConfig } from '../src/domain/extract.js';
import { normalize, parseDate } from '../src/domain/normalize.js';

const dateFormats = ['YYYY-MM-DD', 'DD/MM/YYYY', 'DD.MM.YYYY'];
const opts = { threshold: 0.8, dateFormats };
const ident = (key: string, critical = true): FieldDefinition => ({
  attributeKey: key, label: key, version: 1, critical, rule: { method: 'identifier' },
});
const cand = (raw: string | null, confidence: number | null = 0.99) => ({
  raw, confidence, method: 'ALIAS_LINE' as const, bbox: null, alternatives: [],
});

describe('normalization', () => {
  it('keeps meaningful identifier punctuation and leading zeros', () => {
    expect(normalize('  sup-pn-0088 ', { method: 'identifier' }, [])).toEqual({ ok: true, value: 'SUP-PN-0088' });
    expect(normalize('SUPPN0088', { method: 'identifier' }, [])).not.toEqual({ ok: true, value: 'SUP-PN-0088' });
  });
  it('parses dates only with configured formats', () => {
    expect(parseDate('14/10/2026', dateFormats)).toBe('2026-10-14');
    expect(parseDate('14.10.2026', dateFormats)).toBe('2026-10-14');
    expect(parseDate('10/14/2026', dateFormats)).toBeNull(); // month 14 is invalid, no guessing
    expect(parseDate('31/02/2026', dateFormats)).toBeNull();
  });
  it('maps governed code aliases', () => {
    const rule = { method: 'code' as const, aliases: { 'ASTM A216 WCB': 'A216-WCB', WCB: 'A216-WCB' } };
    expect(normalize('astm a216 wcb', rule, [])).toEqual({ ok: true, value: 'A216-WCB' });
    expect(normalize('WCC', rule, [])).toEqual({ ok: true, value: 'WCC' });
  });
});

describe('field comparison (spec 11A.16 illustrative matrix)', () => {
  it('exact identifier match', () => {
    expect(compareField(ident('spn'), 'SUP-PN-8842', cand('SUP-PN-8842', 0.99), opts).result).toBe('MATCH');
  });
  it('8/B confusion is flagged for review, never matched', () => {
    const r = compareField(ident('heat'), ['HEAT-778', 'HEAT-779'], cand('HEAT-77B', 0.82), opts);
    expect(r.result).toBe('REVIEW_REQUIRED');
    expect(r.note).toMatch(/confusion/);
  });
  it('genuine mismatch', () => {
    expect(compareField(ident('heat'), 'HT-77812', cand('HT-99999', 0.97), opts).result).toBe('MISMATCH');
  });
  it('low confidence: unequal or short values never match; an exact long identifier does (compare-v2)', () => {
    expect(compareField(ident('serial'), 'SN-10022', cand('SN-10028', 0.58), opts).result).toBe('LOW_CONFIDENCE');
    expect(compareField(ident('rev'), 'C', cand('C', 0.30), opts).result).toBe('LOW_CONFIDENCE');
    const exact = compareField(ident('heat'), 'HT-77812', cand('HT-77812', 0.36), opts);
    expect(exact.result).toBe('MATCH');
    expect(exact.note).toMatch(/only 36%/);
  });
  it('junk characters or a cut-off read go to review, not mismatch', () => {
    expect(compareField(ident('heat'), 'DH-5590', cand('DH-55%0', 0.9), opts).result).toBe('REVIEW_REQUIRED');
    expect(compareField(ident('heat'), 'DH-5590', cand('DH-55', 0.9), opts).result).toBe('REVIEW_REQUIRED');
    expect(compareField(ident('heat'), 'DH-5590', cand('DH-6601', 0.9), opts).result).toBe('MISMATCH');
  });
  it('date parsed using the label profile locale', () => {
    const d: FieldDefinition = { ...ident('mfg', false), rule: { method: 'date' } };
    expect(compareField(d, '2026-10-14', cand('14/10/2026', 0.97), opts).result).toBe('MATCH');
    expect(compareField(d, '2026-10-14', cand('14/13/2026', 0.97), opts).result).toBe('UNREADABLE');
  });
  it('missing on label / missing in registry / not applicable', () => {
    expect(compareField(ident('x'), 'A', cand(null), opts).result).toBe('MISSING_ON_LABEL');
    expect(compareField(ident('x'), null, cand('A'), opts).result).toBe('MISSING_IN_REGISTRY');
    expect(compareField(ident('x'), null, cand(null), opts).result).toBe('NOT_APPLICABLE');
  });
  it('decimal tolerance only when configured', () => {
    const d: FieldDefinition = { ...ident('ts', false), rule: { method: 'decimal', tolerance: 5 } };
    expect(compareField(d, '495', cand('498 MPa'), opts).result).toBe('MATCH');
    expect(compareField(d, '495', cand('501'), opts).result).toBe('MISMATCH');
  });
});

describe('overall status policy', () => {
  it('a critical exception is not hidden by many matches', () => {
    const rows = [
      { critical: true, result: 'MATCH' as const }, { critical: true, result: 'MATCH' as const },
      { critical: true, result: 'REVIEW_REQUIRED' as const }, { critical: false, result: 'MATCH' as const },
    ];
    expect(overallStatus(rows, true)).toBe('NEEDS_REVIEW');
    expect(overallStatus([...rows, { critical: true, result: 'MISMATCH' }], true)).toBe('FAIL');
  });
  it('warnings and pass', () => {
    expect(overallStatus([{ critical: true, result: 'MATCH' }, { critical: false, result: 'MISMATCH' }], true)).toBe('PASS_WITH_WARNINGS');
    expect(overallStatus([{ critical: true, result: 'MATCH' }, { critical: false, result: 'NOT_APPLICABLE' }], true)).toBe('PASS');
    expect(overallStatus([{ critical: true, result: 'MATCH' }, { critical: false, result: 'MISSING_ON_LABEL' }], true)).toBe('PASS');
    expect(overallStatus([{ critical: true, result: 'MISSING_ON_LABEL' }], true)).toBe('NEEDS_REVIEW');
    expect(overallStatus([{ critical: true, result: 'MATCH' }], false)).toBe('UNRESOLVED');
  });
});

describe('receiving-label methods', () => {
  it('quantity: "02/02" is piece 2 of a quantity of 2', () => {
    expect(normalize("02/02 No's", { method: 'quantity' }, [])).toEqual({ ok: true, value: '2' });
    expect(normalize('09/10 Nos', { method: 'quantity' }, [])).toEqual({ ok: true, value: '10' });
    expect(normalize('10 EA', { method: 'quantity' }, [])).toEqual({ ok: true, value: '10' });
  });
  it('quantity with a lost slash ("1212" for "12/12") goes to review', () => {
    const q: FieldDefinition = { ...ident('qty'), rule: { method: 'quantity' } };
    expect(compareField(q, '12', cand('1212'), opts).result).toBe('REVIEW_REQUIRED');
    expect(compareField(q, '12', cand('13'), opts).result).toBe('MISMATCH');
  });
  it('PO line accepts "LINE 4", "#04", "4"', () => {
    for (const v of ['LINE 4', '#04', '4', 'Line # 4']) expect(normalize(v, { method: 'integer' }, [])).toEqual({ ok: true, value: '4' });
  });
  it('company names ignore legal forms and OCR damage at the end', () => {
    const d: FieldDefinition = { ...ident('supplier'), rule: { method: 'name' } };
    expect(compareField(d, 'Harbour Valve Works Private Limited', cand('HARBOUR VALVE WORKS PVT. LTD.'), opts).result).toBe('MATCH');
    expect(compareField(d, 'Harbour Valve Works Private Limited', cand('Harbour Valve Works Private Limits)'), opts).result).toBe('MATCH');
    expect(compareField(d, 'Deccan Alloy Castings Private Limited', cand('Deccan Alloy Castings Pvt. Lud'), opts).result).toBe('MATCH');
    expect(compareField(d, 'Harbour Valve Works Private Limited', cand('Falcon Crest Foundry LLC'), opts).result).toBe('MISMATCH');
  });
  it('descriptions: truncation on the label still agrees', () => {
    const d: FieldDefinition = { ...ident('desc', false), rule: { method: 'text' } };
    expect(compareField(d, 'CAGE,EQUAL PERCENT ~ 2,CL1500,1 7/8PORT,1 1/2TR,CTD BORE', cand('CAGE,EQUAL PERCENT ~ 2,CL1500,1 7/8PORT'), opts).result).toBe('MATCH');
    expect(compareField(d, 'CAGE,EQUAL PERCENT ~ 2,CL1500', cand('PLUG,BAL ~ 7 ORF'), opts).result).toBe('MISMATCH');
  });
  it('dates like 23-NOV-2026', () => {
    expect(parseDate('23-NOV-2026', ['DD-MMM-YYYY'])).toBe('2026-11-23');
  });
});

describe('extraction from OCR text', () => {
  const profile: LabelProfileConfig = {
    dateFormats, defaultConfidenceThreshold: 0.8,
    fields: {
      supplier_part_number: { aliases: ['PART NO', 'P/N'], pattern: '[A-Z]{2,4}-[A-Z]{2}-[0-9]{3,4}-[0-9]{3}', patternFallback: true },
      heat_number: { aliases: ['HEAT NO', 'HEAT', 'HT NO'] },
      serial_number: { aliases: ['S/N', 'SERIAL NO'] },
      manufacturing_date: { aliases: ['MFG DATE', 'DATE'], pattern: '[0-9]{2,4}[-/.][0-9]{2}[-/.][0-9]{2,4}', patternFallback: true },
      country_of_origin: { aliases: ['ORIGIN'], pattern: 'MADE IN [A-Z ]+', patternFallback: true },
    },
  };
  it('reads alias:value lines, longest alias first, and pattern fallbacks', () => {
    const text = 'FALCON CREST FOUNDRY\nPART NO: FCF-GB-0200-300\nHEAT NO. HT-77812   S/N SN-10022\nMFG DATE 14/10/2026\nMADE IN UAE';
    const ex = extractFields({ text, confidence: 91 }, [], profile);
    expect(ex.candidates.supplier_part_number.raw).toBe('FCF-GB-0200-300');
    expect(ex.candidates.heat_number.raw).toBe('HT-77812');
    expect(ex.candidates.serial_number.raw).toBe('SN-10022');
    expect(ex.candidates.manufacturing_date.raw).toBe('14/10/2026');
    expect(ex.candidates.country_of_origin.raw).toBe('MADE IN UAE');
    expect(ex.candidates.country_of_origin.method).toBe('PATTERN');
    expect(ex.candidates.heat_number.confidence).toBeCloseTo(0.91);
  });
  it('uses word confidences and flags conflicting values', () => {
    const ex = extractFields({
      text: '', lines: [
        { text: 'HEAT NO: HT-77B12', confidence: 90, words: [{ text: 'HEAT', confidence: 95 }, { text: 'NO:', confidence: 95 }, { text: 'HT-77B12', confidence: 62 }] },
        { text: 'HEAT HT-77812', confidence: 92 },
      ],
    }, [], profile);
    expect(ex.candidates.heat_number.confidence).toBeCloseTo(0.62);
    expect(ex.candidates.heat_number.alternatives).toEqual(['HT-77812']);
  });
  it('decodes SPIR QR tokens and KEY:VALUE barcodes', () => {
    const tok = 'a'.repeat(43);
    expect(parseSpirQr(`https://x.github.io/spir/#/t/${tok}`)).toBe(tok);
    const ex = extractFields({ text: '' }, [{ format: 'QR_CODE', text: `https://x/#/t/${tok}` }, { format: 'CODE_128', text: 'P/N:FCF-GB-0200-300;HT NO:HT-77812' }], profile);
    expect(ex.qrTokens).toEqual([tok]);
    expect(ex.candidates.supplier_part_number).toMatchObject({ raw: 'FCF-GB-0200-300', method: 'BARCODE', confidence: 1 });
    expect(ex.candidates.heat_number.raw).toBe('HT-77812');
  });
});
