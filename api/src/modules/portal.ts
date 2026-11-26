// Portals: sign-in, the supplier profile and the one-shipment form.
// The form goes through the same engine as the CSV import (loadSeed in import mode), so a form entry and
// a CSV row follow exactly the same rules: new shipment -> record + QR code; changed shipment -> new
// version under the same QR code; identical -> nothing changes.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import type { Portal } from '../providers/auth.js';
import { principal, requireRole, requireSupplierProfile } from '../lib/authz.js';
import { ApiError, invalid, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { ImportError, loadSeed } from '../seed/loadSeed.js';
import { forcedSupplier } from './importer.js';
import { findRecord, visibleRecord } from './traceability.js';

const loginSchema = z.object({
  portal: z.enum(['supplier', 'company']),
  username: z.string().max(100),
  password: z.string().max(200),
});

const profileSchema = z.object({
  name: z.string().trim().min(2, 'Enter the supplier name').max(200),
  country: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/, 'Use a 2-letter country code, e.g. IN or AE').optional().default(''),
  contactName: z.string().trim().max(120).optional().default(''),
  contactEmail: z.union([z.literal(''), z.string().trim().email('Enter a valid email address').max(200)]).optional().default(''),
  contactPhone: z.string().trim().max(60).optional().default(''),
  address: z.string().trim().max(500).optional().default(''),
});

const req = (label: string, max = 80) => z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`).max(max);
const shipmentSchema = z.object({
  partNumber: req('Part number'),
  partDescription: req('Part description', 200),
  purchaseOrder: req('PO number'),
  poLine: z.string().trim().regex(/^\d{1,4}$/, 'PO line must be a whole number'),
  quantity: z.string().trim().regex(/^\d{1,6}$/, 'Quantity must be a whole number'),
  heatNumbers: z.array(z.string().trim().max(60)).transform((a) => a.filter(Boolean)).refine((a) => a.length > 0, 'Add at least one heat number'),
  patternNumber: req('Pattern number'),
  designRevision: z.string().trim().max(20).optional().default(''),
  material: z.string().trim().max(120).optional().default(''),
  supplierPartNumber: z.string().trim().max(80).optional().default(''),
  radiographicTestNumber: z.string().trim().max(80).optional().default(''),
  countryOfOrigin: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/, 'Use a 2-letter country code').optional().default(''),
});
type Shipment = z.infer<typeof shipmentSchema>;

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;
function toCsv(s: Shipment, traceabilityRef?: string | null) {
  const row: Record<string, string> = {
    part_number: s.partNumber, part_description: s.partDescription, design_revision: s.designRevision, material: s.material,
    supplier_part_number: s.supplierPartNumber, purchase_order_number: s.purchaseOrder, po_line_number: String(Number(s.poLine)),
    quantity: String(Number(s.quantity)), heat_numbers: s.heatNumbers.join('|'), pattern_number: s.patternNumber,
    radiographic_test_number: s.radiographicTestNumber, country_of_origin: s.countryOfOrigin,
  };
  if (traceabilityRef) row.traceability_ref = traceabilityRef;
  const keys = Object.keys(row);
  return `${keys.join(',')}\n${keys.map((k) => csvCell(row[k])).join(',')}\n`;
}

export function portalRoutes() {
  const r = new Hono<AppEnv>();

  r.post('/auth/login', async (c) => {
    const body = loginSchema.parse(await c.req.json());
    const { auth, db } = c.get('services');
    const out = await auth.login(body.portal as Portal, body.username, body.password);
    if (!out) {
      await new Promise((res) => setTimeout(res, 400)); // slow down guessing a little
      throw new ApiError(401, 'BAD_CREDENTIALS', 'Wrong username or password.');
    }
    await audit(db, out.principal, 'SIGN_IN', 'portal', null, { portal: body.portal }, c.get('cid'));
    return c.json({ token: out.token, expiresAt: out.expiresAt });
  });

  r.get('/me', async (c) => {
    const p = principal(c);
    const { db } = c.get('services');
    const supplier = p.supplierId
      ? await db.one('SELECT supplier_code AS "code", legal_name AS "name" FROM spir.supplier WHERE id = $1', [p.supplierId])
      : null;
    return c.json({ ...p, portal: p.role === 'SUPPLIER' ? 'supplier' : 'company', supplier });
  });

  // ---------- Supplier profile ----------
  r.get('/supplier/profile', async (c) => {
    const p = requireRole(c, 'SUPPLIER');
    const { db } = c.get('services');
    if (!p.supplierId) return c.json({ profile: null });
    const profile = await db.one(
      `SELECT supplier_code AS "code", legal_name AS "name", coalesce(country_code, '') AS "country", coalesce(contact_name, '') AS "contactName",
              coalesce(contact_email, '') AS "contactEmail", coalesce(contact_phone, '') AS "contactPhone", coalesce(address, '') AS "address"
         FROM spir.supplier WHERE id = $1`, [p.supplierId]);
    return c.json({ profile });
  });

  r.put('/supplier/profile', async (c) => {
    const p = requireRole(c, 'SUPPLIER');
    const body = profileSchema.parse(await c.req.json());
    const { db } = c.get('services');
    await db.tx(async (tx) => {
      const vals = [body.name, body.country || null, body.contactName || null, body.contactEmail || null, body.contactPhone || null, body.address || null];
      if (p.supplierId) {
        const before = await tx.one<{ legal_name: string }>('SELECT legal_name FROM spir.supplier WHERE id = $1', [p.supplierId]);
        await tx.query(
          `UPDATE spir.supplier SET legal_name = $2, country_code = $3, contact_name = $4, contact_email = $5, contact_phone = $6, address = $7,
                  external_ref = coalesce(external_ref, supplier_code) WHERE id = $1`, [p.supplierId, ...vals]);
        await audit(tx, p, 'UPDATE_SUPPLIER_PROFILE', 'supplier', p.supplierId, { from: before?.legal_name, to: body.name }, c.get('cid'));
      } else {
        const sup = (await tx.one<{ id: string }>(
          `INSERT INTO spir.supplier (legal_name, country_code, contact_name, contact_email, contact_phone, address)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, vals))!;
        await tx.query('UPDATE spir.supplier SET external_ref = supplier_code WHERE id = $1', [sup.id]);
        await tx.query('UPDATE spir.app_user SET supplier_id = $2 WHERE id = $1', [p.userId, sup.id]);
        await audit(tx, p, 'CREATE_SUPPLIER_PROFILE', 'supplier', sup.id, { name: body.name }, c.get('cid'));
      }
    });
    return c.json({ ok: true });
  });

  // ---------- One shipment at a time ----------
  async function save(c: any, s: Shipment, traceabilityRef: string | null) {
    const p = requireSupplierProfile(c);
    const { db, storage, config } = c.get('services');
    try {
      const report = await loadSeed(db, storage, config.qrKey, [{ name: 'form', text: toCsv(s, traceabilityRef) }], {
        mode: 'import', actor: p, correlationId: c.get('cid'), supplier: await forcedSupplier(db, p.supplierId),
      });
      const code = report.createdRecords[0] ?? report.updatedRecords[0] ?? report.unchangedRecords[0];
      return { code, created: report.createdRecords.length > 0, changed: report.createdRecords.length + report.updatedRecords.length > 0 };
    } catch (e) {
      if (e instanceof ImportError) throw invalid(e.problems.map((m) => m.replace(/^form row \d+: /, '')).join('; '));
      throw e;
    }
  }

  r.post('/supplier/shipments', async (c) => {
    const s = shipmentSchema.parse(await c.req.json());
    return c.json(await save(c, s, null), 201);
  });

  // Edit: part number, PO and line identify the shipment and its QR code, so they stay as they are.
  r.put('/supplier/shipments/:code', async (c) => {
    const p = requireSupplierProfile(c);
    const { db } = c.get('services');
    const rec = await visibleRecord(db, p, c.req.param('code'));
    const cur = await db.one<{ part: string; po: string | null; line: string | null }>(
      `SELECT (SELECT value FROM spir.product_identifier i WHERE i.product_id = t.product_id AND i.id_type = 'COMPANY_PART_NUMBER' LIMIT 1) AS part,
              v.attributes->>'purchase_order_number' AS po, v.attributes->>'po_line_number' AS line
         FROM spir.traceability_record t JOIN spir.traceability_version v ON v.id = t.current_approved_version_id
        WHERE t.id = $1`, [rec.id]);
    if (!cur) throw notFound('Shipment');
    const body = await c.req.json();
    const s = shipmentSchema.parse({ ...body, partNumber: cur.part, purchaseOrder: cur.po ?? body.purchaseOrder, poLine: cur.line ?? body.poLine });
    const out = await save(c, s, (await findRecord(db, rec.traceability_code))!.external_ref);
    return c.json(out);
  });

  return r;
}
