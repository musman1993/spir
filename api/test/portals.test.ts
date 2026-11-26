// Two portals: supplier (profile, shipment form, CSV import, QR labels) and company (search, label check).
// QR scans are open to anyone. Both portals sign in with admin / admin for now.
import { beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

const HEADER = 'part_number,design_revision,part_description,material,purchase_order_number,po_line_number,quantity,heat_numbers,pattern_number,radiographic_test_number,country_of_origin';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');
const ROW_A = '1V9990001,E,"PLUG,BAL ~ 7 ORF",ASTM A479 316,7700200001,4,2,HV-1001,HP-17,,IN';
const ROW_B = '32B9990002,,"CAGE,EQUAL PERCENT ~ 2,CL1500",,7700200002,2,10,HV-2002|HV-2003,HP-22,RT-77,IN';

let t: Awaited<ReturnType<typeof setup>>;
const upload = (text: string, as: 'supplier' | 'company' = 'supplier') => {
  const form = new FormData();
  form.set('file', new File([text], 'products.csv', { type: 'text/csv' }));
  return t.call(as, 'POST', '/api/v1/import', form);
};
beforeAll(async () => { t = await setup(false); }, 60_000);

describe('sign-in', () => {
  const login = (portal: string, username: string, password: string) =>
    t.app.request('http://test/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portal, username, password }) });

  it('admin / admin signs in to each portal; anything else is refused', async () => {
    const ok = await login('supplier', 'admin', 'admin');
    expect(ok.status).toBe(200);
    const { token } = await ok.json();
    const me = await (await t.app.request('http://test/api/v1/me', { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(me).toMatchObject({ userId: 'supplier-admin', role: 'SUPPLIER', portal: 'supplier', supplier: null });
    expect((await login('company', 'admin', 'nope')).status).toBe(401);
    expect((await login('company', 'root', 'admin')).status).toBe(401);
    expect((await t.call('company', 'GET', '/api/v1/me')).body).toMatchObject({ userId: 'company-admin', role: 'COMPANY' });
  });

  it('a tampered session token is rejected', async () => {
    const { token } = await (await login('company', 'admin', 'admin')).json();
    const [payload] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ u: 'supplier-admin', exp: Date.now() + 1e7 })).toString('base64url')}.${token.split('.')[1]}`;
    expect(payload).toBeTruthy();
    expect((await t.app.request('http://test/api/v1/me', { headers: { Authorization: `Bearer ${forged}` } })).status).toBe(401);
  });

  it('each portal is kept to its own pages', async () => {
    expect((await upload(csv(ROW_A), 'company')).status).toBe(403);
    expect((await t.call('company', 'GET', '/api/v1/qr-labels')).status).toBe(403);
    expect((await t.call('supplier', 'GET', '/api/v1/validations')).status).toBe(403);
    expect((await t.call('supplier', 'GET', '/api/v1/suppliers')).status).toBe(403);
  });
});

describe('supplier profile', () => {
  it('must be set up before adding shipments', async () => {
    const r = await upload(csv(ROW_A));
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/profile/i);
  });
  it('creates the supplier; every shipment then carries its name', async () => {
    expect((await t.call('supplier', 'PUT', '/api/v1/supplier/profile', { name: 'Harbour Valve Works Private Limited', country: 'in', contactEmail: 'qa@harbour.example' })).status).toBe(200);
    const p = (await t.call('supplier', 'GET', '/api/v1/supplier/profile')).body.profile;
    expect(p).toMatchObject({ name: 'Harbour Valve Works Private Limited', country: 'IN', contactEmail: 'qa@harbour.example' });
    expect(p.code).toMatch(/^SUP-/);
    expect((await t.call('supplier', 'PUT', '/api/v1/supplier/profile', { name: 'X', contactEmail: 'not-an-email' })).status).toBe(422);
  });
});

describe('CSV import -> QR labels -> anyone scans', () => {
  let tokenA = '';
  let codeA = '';
  it('a CSV creates records and one QR code per shipment, all under the profile supplier', async () => {
    // A supplier_name column, if present, is ignored: rows always belong to the signed-in supplier.
    const withName = ['supplier_name,' + HEADER, 'Somebody Else Ltd,' + ROW_A, 'Somebody Else Ltd,' + ROW_B].join('\n');
    const r = await upload(withName);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ suppliers: 0, products: 2, records: 2, qrTokens: 2 });
    const labels = (await t.call('supplier', 'GET', '/api/v1/qr-labels')).body.labels;
    expect(labels).toHaveLength(2);
    const a = labels.find((l: any) => l.partNumber === '1V9990001');
    expect(a).toMatchObject({ purchaseOrder: '7700200001', poLine: '4', quantity: '2', heats: ['HV-1001'], patternNumber: 'HP-17', supplier: 'Harbour Valve Works Private Limited' });
    expect(a.token).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(a.url).toBe(`https://example.test/spir/#/t/${a.token}`);
    tokenA = a.token; codeA = a.code;
  });

  it('scanning the QR shows the shipment to anyone, no sign-in', async () => {
    const r = await t.call(null, 'GET', `/api/v1/qr/${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(codeA);
    expect(r.body.product).toMatchObject({ partNumber: '1V9990001', name: 'PLUG,BAL ~ 7 ORF' });
    expect(r.body.supplier.name).toBe('Harbour Valve Works Private Limited');
  });

  it('a changed row is live at once, behind the SAME QR code', async () => {
    const r = await upload(csv(ROW_A.replace(',2,HV-1001,', ',3,HV-1001,'), ROW_B));
    expect(r.body).toMatchObject({ records: 0, qrTokens: 0, updatedRecords: [codeA] });
    const scan = await t.call(null, 'GET', `/api/v1/qr/${tokenA}`);
    expect(scan.body.approved).toMatchObject({ versionNo: 2 });
    expect(scan.body.approved.attributes.quantity).toBe('3');
  });

  it('a CSV with problems is rejected as a whole, with every problem listed', async () => {
    const r = await upload(csv(ROW_A.replace('HP-17', ''), ROW_B.replace(',10,', ',ten,')));
    expect(r.status).toBe(422);
    expect(r.body.error.details).toEqual(['products.csv row 2: missing pattern_number', 'products.csv row 3: quantity "ten" must be a whole number']);
  });

  it('the template has no supplier columns', async () => {
    const res = await t.app.request('http://test/api/v1/import/template', { headers: { Authorization: `Bearer ${(await t.services.auth.login('supplier', 'admin', 'admin'))!.token}` } });
    expect((await res.text()).split('\n')[0]).toBe(HEADER);
  });
});

describe('shipment form', () => {
  const form = {
    partNumber: '24C1110X001', designRevision: 'B', partDescription: 'SEAT RING 3 in, CL600', material: 'A351 CF8M',
    purchaseOrder: '7700300001', poLine: '1', quantity: '4', heatNumbers: ['HW-501', ' '], patternNumber: 'HP-30',
    radiographicTestNumber: '', countryOfOrigin: 'IN',
  };
  let code = '';
  it('adds one shipment with its QR code', async () => {
    const r = await t.call('supplier', 'POST', '/api/v1/supplier/shipments', form);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: true, changed: true });
    code = r.body.code;
    const d = (await t.call('supplier', 'GET', `/api/v1/traceability/${code}`)).body;
    expect(d.approved).toMatchObject({ heats: ['HW-501'] });
    expect(d.qr.status).toBe('ACTIVE');
  });
  it('explains what is missing', async () => {
    const r = await t.call('supplier', 'POST', '/api/v1/supplier/shipments', { ...form, heatNumbers: [], quantity: 'four' });
    expect(r.status).toBe(422);
    expect(r.body.error.details.map((d: any) => d.message)).toEqual(expect.arrayContaining(['Quantity must be a whole number', 'Add at least one heat number']));
  });
  it('editing makes a new live version; part, PO and line stay fixed', async () => {
    const r = await t.call('supplier', 'PUT', `/api/v1/supplier/shipments/${code}`, { ...form, quantity: '5', partNumber: 'CHANGED', poLine: '9' });
    expect(r.body).toMatchObject({ code, created: false, changed: true });
    const d = (await t.call('company', 'GET', `/api/v1/traceability/${code}`)).body;
    expect(d.versions.map((v: any) => [v.versionNo, v.status])).toEqual([[2, 'APPROVED'], [1, 'SUPERSEDED']]);
    expect(d.approved.attributes).toMatchObject({ quantity: '5', po_line_number: '1' });
    expect(d.product.partNumber).toBe('24C1110X001');
    const same = await t.call('supplier', 'PUT', `/api/v1/supplier/shipments/${code}`, { ...form, quantity: '5' });
    expect(same.body.changed).toBe(false);
  });
  it('certificates attach to the live version and show on a scan', async () => {
    const f = new FormData();
    f.set('file', new File([new TextEncoder().encode('%PDF-1.4 test')], 'mtc-HW-501.pdf', { type: 'application/pdf' }));
    f.set('docType', 'MTC');
    expect((await t.call('supplier', 'POST', `/api/v1/traceability/${code}/documents`, f)).status).toBe(201);
    const token = (await t.call('supplier', 'GET', `/api/v1/traceability/${code}/qr`)).body.token;
    const scan = (await t.call(null, 'GET', `/api/v1/qr/${token}`)).body;
    expect(scan.documents.map((d: any) => d.fileName)).toEqual(['mtc-HW-501.pdf']);
  });
  it('the company portal finds it by heat number', async () => {
    const r = (await t.call('company', 'GET', '/api/v1/traceability?q=HW-501')).body.records;
    expect(r.map((x: any) => x.code)).toEqual([code]);
  });
});
