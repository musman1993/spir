// CSV import + QR label list (open mode workflow: import CSV -> print QR labels -> scan).
import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { requireRole } from '../lib/authz.js';
import { ApiError } from '../lib/errors.js';
import { decryptToken } from '../lib/crypto.js';
import { ImportError, loadSeed } from '../seed/loadSeed.js';

export const CSV_TEMPLATE = [
  'supplier_name,supplier_country,part_number,design_revision,part_description,material,purchase_order_number,po_line_number,quantity,heat_numbers,pattern_number,radiographic_test_number,country_of_origin',
  'Example Castings Private Limited,IN,24B3170X012,C,"BODY,GLOBE ~ 2,CL300,RF,WCB",ASTM A216 WCB,7700104512,1,3,HT-77812,PT-2417-A,RT-2026-0311,IN',
].join('\n') + '\n';

export function importRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/import/template', (c) => {
    requireRole(c, 'REGISTRY_ADMIN');
    return new Response(CSV_TEMPLATE, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="spir-import-template.csv"' } });
  });

  // Upload a CSV (multipart field "file", or a text/csv body). All-or-nothing.
  r.post('/import', async (c) => {
    const p = requireRole(c, 'REGISTRY_ADMIN');
    const { db, storage, config } = c.get('services');
    let name = 'upload.csv';
    let text: string;
    if ((c.req.header('content-type') ?? '').includes('multipart/form-data')) {
      const form = await c.req.formData();
      const f = form.get('file');
      if (!(f instanceof File)) throw new ApiError(422, 'VALIDATION_FAILED', 'Attach the CSV in the "file" field.');
      if (f.size > 5 * 1024 * 1024) throw new ApiError(413, 'FILE_TOO_LARGE', 'CSV files must be under 5 MB.');
      name = f.name || name;
      text = await f.text();
    } else {
      text = await c.req.text();
    }
    try {
      const report = await loadSeed(db, storage, config.qrKey, [{ name, text }], { mode: 'import', actor: p, correlationId: c.get('cid') });
      return c.json(report);
    } catch (e) {
      if (e instanceof ImportError) throw new ApiError(422, 'IMPORT_FAILED', e.problems.length === 1 ? e.problems[0] : `${e.problems.length} problems in the CSV. Nothing was imported.`, e.problems);
      throw e;
    }
  });

  // Every published shipment record with its QR token, for printing labels.
  r.get('/qr-labels', async (c) => {
    requireRole(c, 'REGISTRY_ADMIN', 'COMPANY_REVIEWER');
    const { db, config } = c.get('services');
    const rows = await db.query(
      `SELECT t.traceability_code AS code, q.token_ciphertext, q.token_hint AS hint, q.created_at AS "issuedAt",
              (SELECT value FROM spir.product_identifier i WHERE i.product_id = p.id AND i.id_type = 'COMPANY_PART_NUMBER' LIMIT 1) AS "partNumber",
              pv.product_name AS "description", pv.attributes->>'design_revision' AS revision, s.legal_name AS supplier,
              tv.attributes->>'purchase_order_number' AS "purchaseOrder", tv.attributes->>'po_line_number' AS "poLine",
              tv.attributes->>'quantity' AS quantity, tv.attributes->>'pattern_number' AS "patternNumber",
              (SELECT array_agg(h.heat_number ORDER BY h.heat_number) FROM spir.traceability_version_heat x JOIN spir.heat h ON h.id = x.heat_id WHERE x.version_id = tv.id) AS heats,
              tv.version_no AS "versionNo"
         FROM spir.traceability_record t
         JOIN spir.qr_token q ON q.traceability_id = t.id AND q.status = 'ACTIVE'
         JOIN spir.traceability_version tv ON tv.id = t.current_approved_version_id
         JOIN spir.product p ON p.id = t.product_id
         JOIN spir.product_version pv ON pv.id = coalesce(p.current_approved_version_id,
              (SELECT id FROM spir.product_version x WHERE x.product_id = p.id ORDER BY version_no DESC LIMIT 1))
         JOIN spir.supplier s ON s.id = p.supplier_id
        ORDER BY t.traceability_code`);
    const labels = rows.map(({ token_ciphertext, ...r }: any) => {
      let token: string | null = null;
      try { token = decryptToken(config.qrKey, token_ciphertext); } catch { /* issued with another key */ }
      return { ...r, token, url: token && config.publicAppUrl ? `${config.publicAppUrl}/#/t/${token}` : null };
    });
    return c.json({ labels });
  });

  return r;
}
