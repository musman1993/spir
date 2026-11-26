import { beforeAll, describe, expect, it } from 'vitest';
import { ocr, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
const codeOf = async (externalRef: string) =>
  (await t.db.one<{ traceability_code: string }>('SELECT traceability_code FROM spir.traceability_record WHERE external_ref = $1', [externalRef]))!.traceability_code;
// Any record's QR token, read straight from the database (label printing is supplier-only and supplier-scoped).
const tokenFor = async (trc: string) => {
  const { decryptToken } = await import('../src/lib/crypto.js');
  const row = await t.db.one<{ token_ciphertext: string }>(
    `SELECT q.token_ciphertext FROM spir.qr_token q JOIN spir.traceability_record r ON r.id = q.traceability_id
      WHERE r.traceability_code = $1 AND q.status = 'ACTIVE'`, [trc]);
  return decryptToken(t.services.config.qrKey, row!.token_ciphertext);
};

beforeAll(async () => { t = await setup(); }, 60_000);

describe('seed import from the flat CSV', () => {
  it('creates suppliers, products, versioned records, documents and QR tokens', () => {
    expect(t.report).toMatchObject({ suppliers: 3, products: 6, records: 11, versions: 12, qrTokens: 11, newAttributes: [] });
    expect(t.report!.documents).toBeGreaterThan(15);
  });
  it('a repeated traceability_ref becomes a new live version; the previous one is superseded', async () => {
    const r = await t.call('company', 'GET', `/api/v1/traceability/${await codeOf('FCF-T-003')}`);
    expect(r.body.versions.map((v: any) => [v.versionNo, v.status])).toEqual([[2, 'APPROVED'], [1, 'SUPERSEDED']]);
    expect(r.body.approved.attributes).toMatchObject({ purchase_order_number: '7700104890', po_line_number: '1', quantity: '3', pattern_number: 'PT-2417-B' });
    expect(r.body.product).toMatchObject({ partNumber: '24B3170X012', name: 'BODY,GLOBE ~ 2,CL300,RF,WCB' });
  });
  it('retired columns are rejected with a clear message', async () => {
    const { loadSeed } = await import('../src/seed/loadSeed.js');
    const t2 = await setup(false);
    await expect(loadSeed(t2.db, t2.storage, t2.services.config.qrKey,
      'supplier_ref,supplier_name,product_ref,part_number,part_description,category,traceability_ref,body_material_grade\nX,X,P,1A2345678,D,VALVE_COMPONENT,T,WCB'))
      .rejects.toThrow(/retired attribute/);
  });
});

describe('authentication and supplier isolation', () => {
  it('requires a sign-in, except for QR scans', async () => {
    expect((await t.call(null, 'GET', '/api/v1/products')).status).toBe(401);
    expect((await t.call(null, 'GET', '/api/v1/traceability')).status).toBe(401);
  });
  it('the supplier portal only sees its own supplier (the demo seed links it to Falcon Crest)', async () => {
    const r = await t.call('supplier', 'GET', '/api/v1/products');
    expect(r.body.products.length).toBe(2);
    expect(new Set(r.body.products.map((p: any) => p.supplierName))).toEqual(new Set(['Falcon Crest Foundry LLC']));
    const nhg = (await t.call('company', 'GET', '/api/v1/products?q=32C5018X044')).body.products[0].code;
    expect((await t.call('supplier', 'GET', `/api/v1/products/${nhg}`)).status).toBe(404);
    expect((await t.call('supplier', 'GET', `/api/v1/traceability/${await codeOf('NHG-T-001')}`)).status).toBe(404);
  });
  it('the company portal sees every supplier; records are searchable by PO', async () => {
    expect((await t.call('company', 'GET', '/api/v1/traceability')).body.records.length).toBe(11);
    const byPo = (await t.call('company', 'GET', '/api/v1/traceability?q=7700104512')).body.records;
    expect(byPo.map((r: any) => r.poLine).sort()).toEqual(['1', '2']);
  });
});

describe('QR resolution (open to anyone)', () => {
  it('a scan without sign-in shows the live version, without history', async () => {
    const trc = await codeOf('FCF-T-003');
    const r = await t.call(null, 'GET', `/api/v1/qr/${await tokenFor(trc)}`);
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(trc);
    expect(r.body.approved.attributes.quantity).toBe('3');
    expect(r.body.versions).toBeUndefined();
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect((await t.call(null, 'GET', `/api/v1/qr/${'x'.repeat(43)}`)).status).toBe(404);
  });
  it('the supplier replaces a label: the old one stops working, the record keeps its ID', async () => {
    const trc = await codeOf('FCF-T-002');
    const old = await tokenFor(trc);
    expect((await t.call('company', 'POST', `/api/v1/traceability/${trc}/qr/rotate`, { reason: 'Label damaged' })).status).toBe(403);
    expect((await t.call('supplier', 'POST', `/api/v1/traceability/${trc}/qr/rotate`, { reason: 'Label damaged' })).status).toBe(200);
    expect((await t.call(null, 'GET', `/api/v1/qr/${old}`)).status).toBe(410);
    const fresh = (await t.call('supplier', 'GET', `/api/v1/traceability/${trc}/qr`)).body.token;
    expect(fresh).not.toBe(old);
    expect((await t.call(null, 'GET', `/api/v1/qr/${fresh}`)).body.code).toBe(trc);
  });
  it('certificates download through short-lived signed links (signed-in or via the scanned label)', async () => {
    const trc = await codeOf('FCF-T-001');
    const docs = (await t.call('company', 'GET', `/api/v1/traceability/${trc}`)).body.documents;
    expect(docs.map((d: any) => d.type).sort()).toEqual(['COC', 'MTC', 'RT_REPORT']);
    const link = await t.call('company', 'GET', `/api/v1/documents/${docs[0].code}/download`);
    expect(link.body.expiresIn).toBe(300);
    const file = await t.app.request(link.body.url);
    expect(file.status).toBe(200);
    expect((await file.text()).startsWith('%PDF-')).toBe(true);
    expect((await t.app.request(link.body.url.replace(/sig=[^&]+/, 'sig=forged'))).status).toBe(403);
    const tok = await tokenFor(trc);
    const pub = await t.call(null, 'GET', `/api/v1/qr/${tok}/documents/${docs[0].code}`);
    expect(pub.status).toBe(200);
    expect((await t.app.request(pub.body.url)).status).toBe(200);
    // A label only opens its own record's certificates.
    const other = (await t.call('company', 'GET', `/api/v1/traceability/${await codeOf('NHG-T-001')}`)).body.documents[0].code;
    expect((await t.call(null, 'GET', `/api/v1/qr/${tok}/documents/${other}`)).status).toBe(404);
  });
});

describe('history and audit', () => {
  it('approved history is immutable and the audit trail is append-only', async () => {
    await expect(t.db.query(`UPDATE spir.traceability_version SET attributes = '{}' WHERE status = 'APPROVED'`)).rejects.toThrow(/immutable/);
    await expect(t.db.query(`DELETE FROM spir.audit_event`)).rejects.toThrow(/append-only/);
    const events = (await t.call('company', 'GET', `/api/v1/audit?code=${await codeOf('NHG-T-002')}`)).body.events.map((e: any) => e.action);
    expect(events).toEqual(expect.arrayContaining(['QR_ISSUE']));
  });
});

describe('label OCR validation matrix', () => {
  // A supplier shipping label in the same layout as the real ones (fictional data for FCF-T-001).
  const supplierLabel = [
    'Name of the Customer : SPIR DEMO ASSEMBLY',
    'Name of the Supplier : Falcon Crest Foundry L.L.C.',
    'Part Description : BODY,GLOBE ~ 2,CL300,RF,WCB',
    'Part No : 24B3170X012 Rev:C',
    'PO No : 7700104512 LINE 1',
    "QTY : 01/03 No's",
    'Heat No : HT-77812',
    'Country of Origin : UAE',
    'Visual Acceptance : OK',
  ];
  const run = (body: any) => t.call('company', 'POST', '/api/v1/validations', body);
  const field = (r: any, k: string) => r.body.fields.find((f: any) => f.attributeKey === k);

  it('a correct supplier label resolves by part number + PO and passes', async () => {
    const r = await run({ ocr: ocr(supplierLabel) });
    expect(r.status).toBe(201);
    expect(r.body.resolution).toMatchObject({ method: 'IDENTIFIERS', status: 'RESOLVED' });
    expect(r.body.record.traceabilityCode).toBe(await codeOf('FCF-T-001'));
    for (const k of ['part_number', 'supplier_name', 'purchase_order_number', 'po_line_number', 'quantity', 'heat_number', 'design_revision', 'part_description', 'country_of_origin']) {
      expect([k, field(r, k).result]).toEqual([k, 'MATCH']);
    }
    expect(field(r, 'quantity')).toMatchObject({ observedRaw: '01/03', observedNormalized: '3' });
    expect(field(r, 'pattern_number').result).toBe('MISSING_ON_LABEL');   // mandatory in the registry, rarely printed
    expect(r.body.overallStatus).toBe('PASS');
  });

  it('the company receiving label resolves too, but cannot confirm supplier or heat', async () => {
    const r = await run({ ocr: ocr(['Item 24B3170X012', 'Purchase Order #: 7700104512', 'Line # 1', 'Qty 3', 'Current Description : BODY,GLOBE ~ 2,CL300', 'CoO AE']) });
    expect(r.body.record.traceabilityCode).toBe(await codeOf('FCF-T-001'));
    expect(field(r, 'part_number').result).toBe('MATCH');
    expect(field(r, 'po_line_number').result).toBe('MATCH');
    expect(field(r, 'quantity').result).toBe('MATCH');
    expect(field(r, 'supplier_name').result).toBe('MISSING_ON_LABEL');
    expect(r.body.overallStatus).toBe('NEEDS_REVIEW');
  });

  it('OCR-damaged field labels and a bare PO barcode still work', async () => {
    const r = await run({
      ocr: ocr(['artNe + 24B3170X012 Rev:C', 'PONe oa ¢ 7700104512 LINEA', 'Heat No . HT-77812,', 'QTY 01/03']),
      barcodes: [{ format: 'CODE_128', text: '7700104512' }],
    });
    expect(field(r, 'part_number')).toMatchObject({ result: 'MATCH', observedRaw: '24B3170X012' });
    expect(field(r, 'purchase_order_number')).toMatchObject({ result: 'MATCH', extractionMethod: 'BARCODE' });
    expect(field(r, 'heat_number')).toMatchObject({ result: 'MATCH', observedNormalized: 'HT-77812' });
    expect(field(r, 'po_line_number').result).toBe('MISSING_ON_LABEL'); // "LINEA" is not trusted as line 4
  });

  it('an OCR misread is flagged, corrected by the operator, raw evidence kept', async () => {
    const r = await run({ ocr: ocr(supplierLabel.map((l) => l.replace('HT-77812', 'HT-778I2'))) });
    expect(field(r, 'heat_number')).toMatchObject({ result: 'REVIEW_REQUIRED', observedRaw: 'HT-778I2' });
    expect(r.body.overallStatus).toBe('NEEDS_REVIEW');
    const c = await t.call('company', 'POST', `/api/v1/validations/${r.body.code}/fields/heat_number/review`, { action: 'CORRECT', value: 'HT-77812', note: 'Image shows a 1' });
    expect(field(c, 'heat_number')).toMatchObject({ result: 'REVIEW_REQUIRED', effectiveResult: 'MATCH', observedRaw: 'HT-778I2' });
    expect(field(c, 'heat_number').review).toMatchObject({ disposition: 'CORRECTED', correctedValue: 'HT-77812' });
    expect(c.body.overallStatus).toBe('PASS');
  });

  it('wrong heat or wrong quantity fails; a discrepancy never touches registry data', async () => {
    const q = await run({ ocr: ocr(supplierLabel.map((l) => l.replace('01/03', '01/05'))) });
    expect(field(q, 'quantity')).toMatchObject({ result: 'MISMATCH', observedNormalized: '5', approvedValue: '3' });
    expect(q.body.overallStatus).toBe('FAIL');
    const r = await run({ ocr: ocr(supplierLabel.map((l) => l.replace('HT-77812', 'HT-99999'))) });
    expect(field(r, 'heat_number').result).toBe('MISMATCH');
    expect(r.body.overallStatus).toBe('FAIL');
    const d = await t.call('company', 'POST', `/api/v1/validations/${r.body.code}/discrepancies`, {
      attributeKey: 'heat_number', severity: 'CRITICAL', classification: 'MISLABELLED_PRODUCT', description: 'Label heat differs from MTC',
    });
    expect(d.status).toBe(201);
    expect((await t.call('company', 'GET', `/api/v1/traceability/${await codeOf('FCF-T-001')}`)).body.approved.heats).toEqual(['HT-77812']);
    const fin = await t.call('company', 'POST', `/api/v1/validations/${r.body.code}/finalize`);
    expect(fin.body.finalizedAt).toBeTruthy();
    expect((await t.call('company', 'POST', `/api/v1/validations/${r.body.code}/fields/heat_number/review`, { action: 'ACCEPT' })).status).toBe(409);
  });

  it('low confidence: long exact identifiers match, short values still need a human', async () => {
    const r = await run({ ocr: ocr(supplierLabel, 40) });
    expect(field(r, 'heat_number').result).toBe('MATCH');          // "HT-77812" read exactly
    expect(field(r, 'po_line_number').result).toBe('LOW_CONFIDENCE'); // "1" could be a coincidence
    expect(r.body.overallStatus).toBe('NEEDS_REVIEW');
  });

  it('a SPIR QR on the label resolves directly; an image is stored as evidence', async () => {
    const trc = await codeOf('NHG-T-001');
    const form = new FormData();
    form.set('payload', JSON.stringify({ ocr: ocr(['Name of the Supplier : Nordhaven Gusswerk GmbH', 'Heat No : S-24419', "QTY : 10/10 No's"]), barcodes: [{ format: 'QR_CODE', text: `https://example.test/spir/#/t/${await tokenFor(trc)}` }] }));
    form.set('image', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'label.jpg', { type: 'image/jpeg' }));
    const r = await t.call('company', 'POST', '/api/v1/validations', form);
    expect(r.body.resolution.method).toBe('QR_TOKEN');
    expect(r.body.record.traceabilityCode).toBe(trc);
    expect(field(r, 'heat_number').result).toBe('MATCH');
    expect(field(r, 'supplier_name').result).toBe('MATCH');
    expect(field(r, 'quantity').result).toBe('MATCH');
    expect(r.body.image.sha256).toHaveLength(64);
  });

  it('a part number alone is ambiguous; the PO line picks between lines of one PO', async () => {
    const r = await run({ ocr: ocr(['Part No : 24B3170X012']) });
    expect(r.body.overallStatus).toBe('UNRESOLVED');
    expect(r.body.resolution.status).toBe('AMBIGUOUS');
    expect(r.body.resolution.candidates.length).toBe(3);
    const res = await t.call('company', 'POST', `/api/v1/validations/${r.body.code}/resolve`, { traceabilityCode: r.body.resolution.candidates[0].code });
    expect(res.body.resolution.method).toBe('MANUAL_SELECTION');
    const line2 = await run({ ocr: ocr(['Part No : 24B3170X012', 'PO No : 7700104512 LINE 2']) });
    expect(line2.body.record.traceabilityCode).toBe(await codeOf('FCF-T-002'));
    // PO + line alone identify an order line (e.g. part number unreadable, PO from a barcode).
    const poLine = await run({ ocr: ocr(['xx 1V0000 LINE 2']), barcodes: [{ format: 'CODE_128', text: '7700104512' }] });
    expect(poLine.body.record.traceabilityCode).toBe(await codeOf('FCF-T-002'));
  });

  it('only the company portal can run label checks', async () => {
    expect((await t.call(null, 'POST', '/api/v1/validations', { ocr: ocr(supplierLabel) })).status).toBe(401);
    expect((await t.call('supplier', 'POST', '/api/v1/validations', { ocr: ocr(supplierLabel) })).status).toBe(403);
  });
});

describe('golden corpus: real Tesseract.js + ZXing output for seed/labels/*.png', () => {
  // Captured by running Tesseract.js 7 (eng, best_int) and ZXing (whole image + strips) over the demo
  // photos. Re-capture when the label profile or OCR engine changes. Real supplier photos belong in
  // test/fixtures/local/ (git-ignored) - see the "private corpus" test below.
  const expected: Record<string, { status: string; record: string; fields: Record<string, string> }> = {
    'supplier-label-fcf-t001-correct.png': { status: 'PASS', record: 'FCF-T-001', fields: { part_number: 'MATCH', purchase_order_number: 'MATCH', po_line_number: 'MATCH', quantity: 'MATCH', heat_number: 'MATCH', supplier_name: 'MATCH' } },
    'supplier-label-fcf-t001-wrong-quantity.png': { status: 'FAIL', record: 'FCF-T-001', fields: { quantity: 'MISMATCH' } },
    // This photo showed the quantity of a pending update. Updates are now live at once, so the label matches.
    'supplier-label-fcf-t003-quantity-only-in-pending-version.png': { status: 'PASS', record: 'FCF-T-003', fields: { quantity: 'MATCH', heat_number: 'MATCH' } },
    'receiving-label-fcf-t002.png': { status: 'NEEDS_REVIEW', record: 'FCF-T-002', fields: { part_number: 'MATCH', purchase_order_number: 'MATCH', po_line_number: 'MATCH', quantity: 'MATCH', supplier_name: 'MISSING_ON_LABEL' } },
    'supplier-label-dac-t001-angled-blurry.png': { status: 'NEEDS_REVIEW', record: 'DAC-T-001', fields: { heat_number: 'REVIEW_REQUIRED', quantity: 'REVIEW_REQUIRED', supplier_name: 'MATCH' } },
    'supplier-label-nhg-t001-with-rt-and-pattern.png': { status: 'PASS_WITH_WARNINGS', record: 'NHG-T-001', fields: { pattern_number: 'MATCH', radiographic_test_number: 'MATCH', heat_number: 'MATCH' } },
  };
  let g: Awaited<ReturnType<typeof setup>>;
  let corpus: Record<string, any>;
  beforeAll(async () => {
    corpus = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/tesseract-labels.json', import.meta.url), 'utf8'));
    g = await setup();
  }, 60_000);
  it.each(Object.keys(expected))('%s', async (file) => {
    const r = await g.call('company', 'POST', '/api/v1/validations', corpus[file]);
    const want = expected[file];
    const rec = (await g.db.one<{ traceability_code: string }>('SELECT traceability_code FROM spir.traceability_record WHERE external_ref = $1', [want.record]))!;
    expect(r.body.record?.traceabilityCode).toBe(rec.traceability_code);
    expect(r.body.overallStatus).toBe(want.status);
    for (const [k, v] of Object.entries(want.fields)) expect([k, r.body.fields.find((f: any) => f.attributeKey === k).result]).toEqual([k, v]);
  });
});
