// Open mode workflow: no sign-in -> import CSV -> QR labels -> scan. Re-importing keeps the same QR.
import { beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

const HEADER = 'supplier_name,supplier_country,part_number,design_revision,part_description,material,purchase_order_number,po_line_number,quantity,heat_numbers,pattern_number,radiographic_test_number,country_of_origin';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');
const ROW_A = 'Harbour Valve Works Private Limited,IN,1V9990001,E,"PLUG,BAL ~ 7 ORF",ASTM A479 316,7700200001,4,2,HV-1001,HP-17,,IN';
const ROW_B = 'Harbour Valve Works Private Limited,IN,32B9990002,,"CAGE,EQUAL PERCENT ~ 2,CL1500",,7700200002,2,10,HV-2002|HV-2003,HP-22,RT-77,IN';
const upload = (t: any, text: string) => {
  const form = new FormData();
  form.set('file', new File([text], 'products.csv', { type: 'text/csv' }));
  return t.call(null, 'POST', '/api/v1/import', form);
};

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(false, 'open'); }, 60_000);

describe('open mode: no actors', () => {
  it('works without any sign-in, as the generic operator', async () => {
    const me = await t.call(null, 'GET', '/api/v1/me');
    expect(me.body).toMatchObject({ userId: 'operator', role: 'OPERATOR' });
    expect((await t.call(null, 'GET', '/api/v1/demo-users')).body).toEqual({ users: [], mode: 'open' });
  });
});

describe('import CSV -> QR labels -> scan', () => {
  let tokenA = '';
  let codeA = '';
  it('a new CSV creates records and one QR code per shipment', async () => {
    const r = await upload(t, csv(ROW_A, ROW_B));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ suppliers: 1, products: 2, records: 2, qrTokens: 2 });
    const labels = (await t.call(null, 'GET', '/api/v1/qr-labels')).body.labels;
    expect(labels).toHaveLength(2);
    const a = labels.find((l: any) => l.partNumber === '1V9990001');
    expect(a).toMatchObject({ purchaseOrder: '7700200001', poLine: '4', quantity: '2', heats: ['HV-1001'], patternNumber: 'HP-17', supplier: 'Harbour Valve Works Private Limited' });
    expect(a.token).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(a.url).toBe(`https://example.test/spir/#/t/${a.token}`);
    tokenA = a.token; codeA = a.code;
  });

  it('scanning the QR shows the shipment, with no sign-in', async () => {
    const r = await t.call(null, 'GET', `/api/v1/qr/${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(codeA);
    expect(r.body.product).toMatchObject({ partNumber: '1V9990001', name: 'PLUG,BAL ~ 7 ORF' });
    expect(r.body.approved.attributes).toMatchObject({ purchase_order_number: '7700200001', po_line_number: '4', quantity: '2', pattern_number: 'HP-17' });
  });

  it('re-importing a changed row updates the data behind the SAME QR code', async () => {
    const changed = ROW_A.replace(',2,HV-1001,', ',3,HV-1001,');
    const r = await upload(t, csv(changed, ROW_B));
    expect(r.body).toMatchObject({ records: 0, qrTokens: 0, updatedRecords: [codeA] });
    expect(r.body.unchangedRecords).toHaveLength(1);
    const scan = await t.call(null, 'GET', `/api/v1/qr/${tokenA}`);
    expect(scan.body.approved).toMatchObject({ versionNo: 2 });
    expect(scan.body.approved.attributes.quantity).toBe('3');
    const history = (await t.call(null, 'GET', `/api/v1/traceability/${codeA}`)).body.versions.map((v: any) => [v.versionNo, v.status]);
    expect(history).toEqual([[2, 'APPROVED'], [1, 'SUPERSEDED']]);
  });

  it('re-importing an identical file changes nothing', async () => {
    const r = await upload(t, csv(ROW_A.replace(',2,HV-1001,', ',3,HV-1001,'), ROW_B));
    expect(r.body).toMatchObject({ records: 0, versions: 0, updatedRecords: [], qrTokens: 0 });
    expect(r.body.unchangedRecords).toHaveLength(2);
  });

  it('a CSV with problems is rejected as a whole, with every problem listed', async () => {
    const bad = csv(ROW_A.replace('HP-17', ''), ROW_B.replace(',10,', ',ten,'), 'Harbour Valve Works Private Limited,IN,9Z0000001,,"NEW PART",,7700200009,1,1,HV-9,HP-9,,IN');
    const r = await upload(t, bad);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('IMPORT_FAILED');
    expect(r.body.error.details).toEqual(['products.csv row 2: missing pattern_number', 'products.csv row 3: quantity "ten" must be a whole number']);
    expect((await t.call(null, 'GET', '/api/v1/qr-labels')).body.labels).toHaveLength(2); // the valid new row was not imported either
  });

  it('a template CSV is available to start from', async () => {
    const res = await t.app.request('http://test/api/v1/import/template');
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    const text = await res.text();
    expect(text.split('\n')[0]).toBe(HEADER);
  });
});
