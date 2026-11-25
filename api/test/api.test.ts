import { beforeAll, describe, expect, it } from 'vitest';
import { ocr, setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
const codeOf = async (externalRef: string) =>
  (await t.db.one<{ traceability_code: string }>('SELECT traceability_code FROM spir.traceability_record WHERE external_ref = $1', [externalRef]))!.traceability_code;
const tokenFor = async (trc: string) => (await t.call('reviewer', 'GET', `/api/v1/traceability/${trc}/qr`)).body.token as string;

beforeAll(async () => { t = await setup(); }, 60_000);

describe('seed import from the flat CSV', () => {
  it('creates suppliers, products, versioned records, documents and QR tokens', () => {
    expect(t.report).toMatchObject({ suppliers: 3, products: 6, records: 11, versions: 12, qrTokens: 8 });
    expect(t.report!.documents).toBeGreaterThan(15);
  });
  it('a repeated traceability_ref becomes a pending version on top of the approved one', async () => {
    const r = await t.call('reviewer', 'GET', `/api/v1/traceability/${await codeOf('FCF-T-003')}`);
    expect(r.body.versions.map((v: any) => [v.versionNo, v.status])).toEqual([[2, 'PENDING'], [1, 'APPROVED']]);
    expect(r.body.approved.serials).toEqual(['SN-10041']);
  });
});

describe('authentication and supplier isolation', () => {
  it('requires a user', async () => {
    expect((await t.call(null, 'GET', '/api/v1/products')).status).toBe(401);
  });
  it('suppliers only see their own organisation', async () => {
    const r = await t.call('supplier-fcf', 'GET', '/api/v1/products');
    expect(r.body.products.length).toBe(2);
    expect(new Set(r.body.products.map((p: any) => p.supplierName))).toEqual(new Set(['Falcon Crest Foundry LLC']));
    const nhg = (await t.call('reviewer', 'GET', '/api/v1/products?q=NHG-KV')).body.products[0].code;
    expect((await t.call('supplier-fcf', 'GET', `/api/v1/products/${nhg}`)).status).toBe(404);
  });
  it('QR users never see unapproved records', async () => {
    const all = (await t.call('reviewer', 'GET', '/api/v1/traceability')).body.records.length;
    const pub = (await t.call('qr-user', 'GET', '/api/v1/traceability')).body.records;
    expect(all).toBe(11);
    expect(pub.length).toBe(8);
    expect((await t.call('qr-user', 'GET', `/api/v1/traceability/${await codeOf('DAC-T-002')}`)).status).toBe(404);
  });
});

describe('QR resolution', () => {
  it('returns only the latest approved version, never the pending update', async () => {
    const trc = await codeOf('FCF-T-003');
    const r = await t.call('qr-user', 'GET', `/api/v1/qr/${await tokenFor(trc)}`);
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(trc);
    expect(r.body.approved.serials).toEqual(['SN-10041']);
    expect(r.body.versions).toBeUndefined();
    expect(r.body.documents.every((d: any) => d.versionStatus === 'APPROVED')).toBe(true);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
  it('token is a locator, not a credential', async () => {
    const tok = await tokenFor(await codeOf('FCF-T-001'));
    expect((await t.call(null, 'GET', `/api/v1/qr/${tok}`)).status).toBe(401);
    expect((await t.call('supplier-fcf', 'GET', `/api/v1/qr/${tok}`)).status).toBe(403);
    expect((await t.call('qr-user', 'GET', `/api/v1/qr/${'x'.repeat(43)}`)).status).toBe(404);
  });
  it('revoked tokens return 410 and rotation keeps the Traceability ID', async () => {
    const trc = await codeOf('NHG-T-002');
    const old = await tokenFor(trc);
    expect((await t.call('reviewer', 'POST', `/api/v1/traceability/${trc}/qr/rotate`, { reason: 'Label damaged' })).status).toBe(200);
    expect((await t.call('qr-user', 'GET', `/api/v1/qr/${old}`)).status).toBe(410);
    const fresh = await tokenFor(trc);
    expect(fresh).not.toBe(old);
    expect((await t.call('qr-user', 'GET', `/api/v1/qr/${fresh}`)).body.code).toBe(trc);
  });
  it('documents download through short-lived signed links', async () => {
    const trc = await codeOf('FCF-T-001');
    const doc = (await t.call('qr-user', 'GET', `/api/v1/traceability/${trc}`)).body.documents[0];
    const link = await t.call('qr-user', 'GET', `/api/v1/documents/${doc.code}/download`);
    expect(link.body.expiresIn).toBe(300);
    const file = await t.app.request(link.body.url);
    expect(file.status).toBe(200);
    expect((await file.text()).startsWith('%PDF-')).toBe(true);
    const tampered = await t.app.request(link.body.url.replace(/sig=[^&]+/, 'sig=forged'));
    expect(tampered.status).toBe(403);
  });
});

describe('supplier submission -> company approval workflow', () => {
  let productCode = '';
  let trc = '';
  it('supplier registers a product and a traceability draft with a document', async () => {
    const p = await t.call('supplier-fcf', 'POST', '/api/v1/products', {
      categoryCode: 'VALVE_BODY_CAST', productName: 'Globe valve body 3in Class 600', supplierPartNumber: 'FCF-GB-0300-600',
      attributes: { body_material_grade: 'A216-WCB', pressure_class: 'CL600', nominal_size: '3IN' },
    });
    expect(p.status).toBe(201);
    productCode = p.body.code;
    expect(productCode).toMatch(/^PRD-\d{7}$/);
    const dup = await t.call('supplier-fcf', 'POST', '/api/v1/products', {
      categoryCode: 'VALVE_BODY_CAST', productName: 'dup', supplierPartNumber: 'fcf-gb-0300-600', attributes: {},
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_PRODUCT');

    const bad = await t.call('supplier-fcf', 'POST', '/api/v1/traceability', { productCode, heats: ['HT-90001'], attributes: { manufacturing_date: '14/11/2026' } });
    expect(bad.status).toBe(422);
    const r = await t.call('supplier-fcf', 'POST', '/api/v1/traceability', {
      productCode, externalRef: 'FCF-T-100', heats: ['HT-90001', 'HT-90002'], batches: ['BT-2026-200'], serials: ['SN-30001'],
      attributes: { manufacturing_date: '2026-11-14', country_of_origin: 'AE' },
    });
    expect(r.status).toBe(201);
    trc = r.body.code;

    const form = new FormData();
    form.set('docType', 'MTC');
    form.set('file', new File([new TextEncoder().encode('%PDF-1.4 demo')], 'mtc.pdf', { type: 'application/pdf' }));
    expect((await t.call('supplier-fcf', 'POST', `/api/v1/traceability/${trc}/documents`, form)).status).toBe(201);
    const exe = new FormData();
    exe.set('docType', 'MTC');
    exe.set('file', new File([new Uint8Array([0x4d, 0x5a, 0x90, 0])], 'evil.pdf', { type: 'application/pdf' }));
    expect((await t.call('supplier-fcf', 'POST', `/api/v1/traceability/${trc}/documents`, exe)).status).toBe(415);
  });

  it('other suppliers and QR users cannot see the draft', async () => {
    expect((await t.call('supplier-nhg', 'GET', `/api/v1/traceability/${trc}`)).status).toBe(404);
    expect((await t.call('qr-user', 'GET', `/api/v1/traceability/${trc}`)).status).toBe(404);
  });

  it('submit, reject with reason, correct, resubmit, approve', async () => {
    expect((await t.call('supplier-fcf', 'POST', `/api/v1/products/${productCode}/submit`)).status).toBe(200);
    expect((await t.call('supplier-fcf', 'POST', `/api/v1/traceability/${trc}/submit`)).status).toBe(200);
    // Pending versions are locked.
    expect((await t.call('supplier-fcf', 'PUT', `/api/v1/traceability/${trc}/draft`, { heats: ['X'] })).status).toBe(409);

    const queue = (await t.call('reviewer', 'GET', '/api/v1/review-queue')).body.items;
    const tItem = queue.find((i: any) => i.code === trc);
    const pItem = queue.find((i: any) => i.code === productCode);
    expect(tItem.blockedReason).toMatch(/product/i);
    expect(tItem.documents.length).toBe(1);

    expect((await t.call('supplier-fcf', 'POST', `/api/v1/review/traceability/${tItem.versionId}/approve`, {})).status).toBe(403);
    const early = await t.call('reviewer', 'POST', `/api/v1/review/traceability/${tItem.versionId}/approve`, {});
    expect(early.body.error.code).toBe('PRODUCT_NOT_APPROVED');
    expect((await t.call('reviewer', 'POST', `/api/v1/review/traceability/${tItem.versionId}/reject`, {})).status).toBe(422);
    expect((await t.call('reviewer', 'POST', `/api/v1/review/traceability/${tItem.versionId}/reject`, { comment: 'Batch number missing on MTC' })).status).toBe(200);

    const fixed = await t.call('supplier-fcf', 'PUT', `/api/v1/traceability/${trc}/draft`, {
      heats: ['HT-90001', 'HT-90002'], batches: ['BT-2026-201'], serials: ['SN-30001'],
      attributes: { manufacturing_date: '2026-11-14', country_of_origin: 'AE' },
    });
    expect(fixed.body.versions.map((v: any) => [v.versionNo, v.status])).toEqual([[2, 'DRAFT'], [1, 'REJECTED']]);
    await t.call('supplier-fcf', 'POST', `/api/v1/traceability/${trc}/submit`);

    expect((await t.call('reviewer', 'POST', `/api/v1/review/product/${pItem.versionId}/approve`, { comment: 'ok' })).status).toBe(200);
    const v2 = (await t.call('reviewer', 'GET', '/api/v1/review-queue')).body.items.find((i: any) => i.code === trc);
    expect(v2.changes).toContainEqual({ field: 'batches', from: 'BT-2026-200', to: 'BT-2026-201' });
    const ok = await t.call('reviewer', 'POST', `/api/v1/review/traceability/${v2.versionId}/approve`, {});
    expect(ok.body).toMatchObject({ status: 'APPROVED', versionNo: 2, qrIssued: true });
    expect((await t.call('qr-user', 'GET', `/api/v1/traceability/${trc}`)).body.approved.batches).toEqual(['BT-2026-201']);
  });

  it('approving an update supersedes the previous approved version', async () => {
    const trc3 = await codeOf('FCF-T-003');
    const item = (await t.call('reviewer', 'GET', '/api/v1/review-queue')).body.items.find((i: any) => i.code === trc3);
    await t.call('reviewer', 'POST', `/api/v1/review/traceability/${item.versionId}/approve`, {});
    const d = (await t.call('reviewer', 'GET', `/api/v1/traceability/${trc3}`)).body;
    expect(d.versions.map((v: any) => v.status)).toEqual(['APPROVED', 'SUPERSEDED']);
    expect(d.approved.serials).toEqual(['SN-10041', 'SN-10042']);
  });

  it('approved history is immutable and the audit trail is append-only', async () => {
    await expect(t.db.query(`UPDATE spir.traceability_version SET attributes = '{}' WHERE status = 'APPROVED'`)).rejects.toThrow(/immutable/);
    await expect(t.db.query(`DELETE FROM spir.audit_event`)).rejects.toThrow(/append-only/);
    const events = (await t.call('auditor', 'GET', `/api/v1/audit?code=${trc}`)).body.events.map((e: any) => e.action);
    expect(events).toEqual(expect.arrayContaining(['CREATE', 'UPLOAD_DOCUMENT', 'SUBMIT', 'REJECT', 'APPROVE', 'QR_ISSUE']));
  });
});

describe('label OCR validation matrix', () => {
  const goodLabel = [
    'FALCON CREST FOUNDRY LLC',
    'PART NO: FCF-GB-0200-300',
    'MATERIAL: ASTM A216 WCB    CLASS 300',
    'SIZE: 2"',
    'HEAT NO: HT-77812',
    'S/N: SN-10022',
    'MFG DATE: 14/10/2026',
    'MADE IN UAE',
  ];
  const run = (body: any) => t.call('inspector', 'POST', '/api/v1/validations', body);
  const field = (r: any, k: string) => r.body.fields.find((f: any) => f.attributeKey === k);

  it('a correct sticker resolves by identifiers and passes', async () => {
    const r = await run({ ocr: ocr(goodLabel) });
    expect(r.status).toBe(201);
    expect(r.body.resolution).toMatchObject({ method: 'IDENTIFIERS', status: 'RESOLVED' });
    expect(r.body.record.traceabilityCode).toBe(await codeOf('FCF-T-001'));
    expect(field(r, 'body_material_grade')).toMatchObject({ result: 'MATCH', observedNormalized: 'A216-WCB' });
    expect(field(r, 'pressure_class').result).toBe('MATCH');
    expect(field(r, 'manufacturing_date')).toMatchObject({ result: 'MATCH', observedNormalized: '2026-10-14' });
    expect(field(r, 'country_of_origin').result).toBe('MATCH');
    expect(field(r, 'batch_number').result).toBe('MISSING_ON_LABEL');
    expect(r.body.overallStatus).toBe('NEEDS_REVIEW'); // batch is critical and absent
    const na = await t.call('inspector', 'POST', `/api/v1/validations/${r.body.code}/fields/batch_number/review`, { action: 'NOT_APPLICABLE', note: 'Batch not printed on this sticker type' });
    expect(na.body.overallStatus).toBe('PASS'); // profile v2 does not look for the manufacturer part number
    expect(field(na, 'manufacturer_part_number').result).toBe('NOT_CHECKED');
    expect(field(na, 'nominal_size').result).toBe('MATCH'); // 2" alias
  });

  it('an OCR misread is flagged, corrected by the operator, raw evidence kept', async () => {
    const label = goodLabel.map((l) => l.replace('HT-77812', 'HT-778I2')).concat('BATCH: BT-2026-104');
    const r = await run({ ocr: ocr(label) });
    expect(field(r, 'heat_number')).toMatchObject({ result: 'REVIEW_REQUIRED', observedRaw: 'HT-778I2' });
    expect(r.body.overallStatus).toBe('NEEDS_REVIEW');
    const c = await t.call('inspector', 'POST', `/api/v1/validations/${r.body.code}/fields/heat_number/review`, { action: 'CORRECT', value: 'HT-77812', note: 'Image shows a 1' });
    expect(field(c, 'heat_number')).toMatchObject({ result: 'REVIEW_REQUIRED', effectiveResult: 'MATCH', observedRaw: 'HT-778I2' });
    expect(field(c, 'heat_number').review).toMatchObject({ disposition: 'CORRECTED', correctedValue: 'HT-77812' });
  });

  it('a genuine heat mismatch fails and can raise a discrepancy; registry data is untouched', async () => {
    const label = goodLabel.map((l) => l.replace('HT-77812', 'HT-99999')).concat('BATCH: BT-2026-104');
    const r = await run({ ocr: ocr(label) });
    expect(field(r, 'heat_number').result).toBe('MISMATCH');
    expect(r.body.overallStatus).toBe('FAIL');
    const d = await t.call('inspector', 'POST', `/api/v1/validations/${r.body.code}/discrepancies`, {
      attributeKey: 'heat_number', severity: 'CRITICAL', classification: 'MISLABELLED_PRODUCT', description: 'Sticker heat differs from MTC',
    });
    expect(d.status).toBe(201);
    expect(d.body.discrepancies[0].code).toMatch(/^DSC-/);
    const rec = (await t.call('qr-user', 'GET', `/api/v1/traceability/${await codeOf('FCF-T-001')}`)).body;
    expect(rec.approved.heats).toEqual(['HT-77812']);
    const fin = await t.call('inspector', 'POST', `/api/v1/validations/${r.body.code}/finalize`);
    expect(fin.body.finalizedAt).toBeTruthy();
    expect((await t.call('inspector', 'POST', `/api/v1/validations/${r.body.code}/fields/heat_number/review`, { action: 'ACCEPT' })).status).toBe(409);
  });

  it('low-confidence reads are never treated as matches', async () => {
    const r = await run({ ocr: ocr(goodLabel, 40) });
    expect(field(r, 'heat_number').result).toBe('LOW_CONFIDENCE');
    expect(r.body.overallStatus).toBe('NEEDS_REVIEW');
  });

  it('a SPIR QR on the label resolves directly; an image is stored as evidence', async () => {
    const trc = await codeOf('NHG-T-001');
    const form = new FormData();
    form.set('payload', JSON.stringify({ ocr: ocr(['NORDHAVEN GUSSWERK', 'SCHMELZE: S-24419', 'WERKSTOFF: A351 CF8M']), barcodes: [{ format: 'QR_CODE', text: `https://example.test/spir/#/t/${await tokenFor(trc)}` }] }));
    form.set('image', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'label.jpg', { type: 'image/jpeg' }));
    const r = await t.call('inspector', 'POST', '/api/v1/validations', form);
    expect(r.body.resolution.method).toBe('QR_TOKEN');
    expect(r.body.record.traceabilityCode).toBe(trc);
    expect(field(r, 'heat_number').result).toBe('MATCH');
    expect(field(r, 'body_material_grade').result).toBe('MATCH');
    expect(r.body.image.sha256).toHaveLength(64);
  });

  it('ambiguous identifiers require the operator to choose the record', async () => {
    const r = await run({ ocr: ocr(['PART NO: FCF-GB-0200-300', 'CLASS 300']) });
    expect(r.body.overallStatus).toBe('UNRESOLVED');
    expect(r.body.resolution.status).toBe('AMBIGUOUS');
    expect(r.body.resolution.candidates.length).toBe(3);
    const pick = r.body.resolution.candidates[0].code;
    const res = await t.call('inspector', 'POST', `/api/v1/validations/${r.body.code}/resolve`, { traceabilityCode: pick });
    expect(res.body.resolution.method).toBe('MANUAL_SELECTION');
    expect(res.body.record.pinnedTraceabilityVersion).toBeGreaterThan(0);
  });

  it('only inspection roles can run validations', async () => {
    expect((await t.call('qr-user', 'POST', '/api/v1/validations', { ocr: ocr(goodLabel) })).status).toBe(403);
    expect((await t.call('supplier-fcf', 'POST', '/api/v1/validations', { ocr: ocr(goodLabel) })).status).toBe(403);
  });
});

describe('golden corpus: real Tesseract.js output for seed/labels/*.png', () => {
  // Captured by running Tesseract.js 7 (eng, best_int) over the demo label photos.
  // Re-capture when the label profile or OCR engine changes; add real supplier photos here.
  const expected: Record<string, { status: string; record: string; fields: Record<string, string> }> = {
    'fcf-trc1-correct.png': { status: 'PASS', record: 'FCF-T-001', fields: { heat_number: 'MATCH', serial_number: 'MATCH', manufacturing_date: 'MATCH' } },
    'fcf-trc1-wrong-heat.png': { status: 'FAIL', record: 'FCF-T-001', fields: { heat_number: 'MISMATCH' } },
    'fcf-trc3-serial-only-in-pending-version.png': { status: 'FAIL', record: 'FCF-T-003', fields: { serial_number: 'MISMATCH' } },
    'nhg-trc1-german-tag.png': { status: 'NEEDS_REVIEW', record: 'NHG-T-001', fields: { heat_number: 'LOW_CONFIDENCE', manufacturing_date: 'MATCH', body_material_grade: 'MATCH' } },
    'dac-trc1-angled-blurry.png': { status: 'NEEDS_REVIEW', record: 'DAC-T-001', fields: { pressure_class: 'MATCH', serial_number: 'MATCH' } },
  };
  it.each(Object.keys(expected))('%s', async (file) => {
    const corpus = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/tesseract-labels.json', import.meta.url), 'utf8'));
    const t2 = await setup();
    const r = await t2.call('inspector', 'POST', '/api/v1/validations', { ocr: corpus[file] });
    const want = expected[file];
    const rec = (await t2.db.one<{ traceability_code: string }>('SELECT traceability_code FROM spir.traceability_record WHERE external_ref = $1', [want.record]))!;
    expect(r.body.record.traceabilityCode).toBe(rec.traceability_code);
    expect(r.body.overallStatus).toBe(want.status);
    for (const [k, v] of Object.entries(want.fields)) expect(r.body.fields.find((f: any) => f.attributeKey === k).result).toBe(v);
  }, 30_000);
});
