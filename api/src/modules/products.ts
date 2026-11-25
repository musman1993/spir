// Product registry (spec 8.2). A product is a stable identity; its descriptive data is versioned.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import type { Db } from '../providers/db.js';
import type { Principal } from '../providers/auth.js';
import { assertSupplierScope, isSupplier, principal, requireRole, seesUnpublished } from '../lib/authz.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { normIdentifier } from '../domain/normalize.js';
import { loadDefinitions, validateAttributes } from './attributes.js';
import { submitDraft, upsertDraft, userNames, versionView, versions } from './versioning.js';

export async function findProduct(db: Db, code: string) {
  return db.one<{ id: string; product_code: string; supplier_id: string; category_code: string; current_approved_version_id: string | null }>(
    'SELECT * FROM spir.product WHERE product_code = $1', [code],
  );
}

/** Loads a product the caller may see, or 404s (we don't reveal existence to the wrong supplier). */
export async function visibleProduct(db: Db, p: Principal, code: string) {
  const prod = await findProduct(db, code);
  if (!prod) throw notFound('Product');
  if (isSupplier(p) && prod.supplier_id !== p.supplierId) throw notFound('Product');
  if (!isSupplier(p) && !seesUnpublished(p) && !prod.current_approved_version_id) throw notFound('Product');
  return prod;
}

const createSchema = z.object({
  categoryCode: z.string().min(1),
  productName: z.string().trim().min(2).max(200),
  description: z.string().max(2000).optional().nullable(),
  supplierPartNumber: z.string().trim().min(2).max(80),
  manufacturerPartNumber: z.string().trim().max(80).optional().nullable(),
  attributes: z.record(z.any()).default({}),
});
const draftSchema = createSchema.pick({ productName: true, description: true, attributes: true });

export function productRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/products', async (c) => {
    const p = principal(c);
    const { db } = c.get('services');
    const q = (c.req.query('q') ?? '').trim();
    const rows = await db.query(
      `SELECT pr.product_code AS "code", s.supplier_code AS "supplierCode", s.legal_name AS "supplierName",
              pr.category_code AS "category",
              coalesce(av.product_name, lv.product_name) AS "name",
              av.version_no AS "approvedVersion",
              ov.version_no AS "openVersion", ov.status AS "openStatus",
              lv.status AS "latestStatus",
              (SELECT value FROM spir.product_identifier i WHERE i.product_id = pr.id AND i.id_type = 'SUPPLIER_PART_NUMBER' LIMIT 1) AS "supplierPartNumber",
              av.attributes AS "attributes",
              (SELECT count(*)::int FROM spir.traceability_record t WHERE t.product_id = pr.id
                  AND ($2 OR t.current_approved_version_id IS NOT NULL)) AS "traceabilityCount"
         FROM spir.product pr
         JOIN spir.supplier s ON s.id = pr.supplier_id
         LEFT JOIN spir.product_version av ON av.id = pr.current_approved_version_id
         LEFT JOIN spir.product_version ov ON ov.product_id = pr.id AND ov.status IN ('DRAFT','PENDING')
         LEFT JOIN LATERAL (SELECT * FROM spir.product_version x WHERE x.product_id = pr.id ORDER BY version_no DESC LIMIT 1) lv ON true
        WHERE ($1::uuid IS NULL OR pr.supplier_id = $1)
          AND ($2 OR pr.current_approved_version_id IS NOT NULL)
          AND ($3 = '' OR pr.product_code ILIKE '%'||$3||'%' OR coalesce(av.product_name, lv.product_name) ILIKE '%'||$3||'%'
               OR EXISTS (SELECT 1 FROM spir.product_identifier i WHERE i.product_id = pr.id AND i.value ILIKE '%'||$3||'%'))
        ORDER BY s.legal_name, pr.product_code`,
      [isSupplier(p) ? p.supplierId : null, isSupplier(p) || seesUnpublished(p), q],
    );
    return c.json({ products: rows });
  });

  r.get('/products/:code', async (c) => {
    const p = principal(c);
    const { db } = c.get('services');
    const prod = await visibleProduct(db, p, c.req.param('code'));
    const [supplier, identifiers, all, names, records] = await Promise.all([
      db.one('SELECT supplier_code AS "code", legal_name AS "name", country_code AS "country" FROM spir.supplier WHERE id = $1', [prod.supplier_id]),
      db.query('SELECT id_type AS "type", issuer, value FROM spir.product_identifier WHERE product_id = $1 ORDER BY id_type', [prod.id]),
      versions(db, 'product', prod.id),
      userNames(db),
      db.query(
        `SELECT t.traceability_code AS "code", t.external_ref AS "externalRef",
                av.version_no AS "approvedVersion", ov.version_no AS "openVersion", ov.status AS "openStatus",
                lv.status AS "latestStatus",
                (SELECT array_agg(h.heat_number ORDER BY h.heat_number) FROM spir.traceability_version_heat vh JOIN spir.heat h ON h.id = vh.heat_id
                  WHERE vh.version_id = coalesce(av.id, lv.id)) AS "heats",
                coalesce(av.attributes, lv.attributes)->>'manufacturing_date' AS "manufacturingDate"
           FROM spir.traceability_record t
           LEFT JOIN spir.traceability_version av ON av.id = t.current_approved_version_id
           LEFT JOIN spir.traceability_version ov ON ov.traceability_id = t.id AND ov.status IN ('DRAFT','PENDING')
           LEFT JOIN LATERAL (SELECT * FROM spir.traceability_version x WHERE x.traceability_id = t.id ORDER BY version_no DESC LIMIT 1) lv ON true
          WHERE t.product_id = $1 AND ($2 OR t.current_approved_version_id IS NOT NULL)
          ORDER BY t.traceability_code`,
        [prod.id, isSupplier(p) || seesUnpublished(p)],
      ),
    ]);
    const visible = isSupplier(p) || seesUnpublished(p) ? all : all.filter((v) => v.status === 'APPROVED');
    const approved = all.find((v) => v.status === 'APPROVED');
    return c.json({
      code: prod.product_code,
      category: prod.category_code,
      supplier,
      identifiers,
      approved: approved ? { ...versionView(approved, names), productName: approved.product_name, description: approved.description } : null,
      versions: visible.map((v) => ({ ...versionView(v, names), productName: v.product_name, description: v.description })),
      traceability: records,
    });
  });

  // Supplier registers a new product: creates the stable Product ID + DRAFT v1.
  r.post('/products', async (c) => {
    const p = requireRole(c, 'SUPPLIER_CONTRIBUTOR');
    const { db } = c.get('services');
    const body = createSchema.parse(await c.req.json());
    const defs = await loadDefinitions(db);
    const { clean, errors } = validateAttributes(defs, 'PRODUCT', body.categoryCode, body.attributes, false);
    if (errors.length) throw invalid('Some attributes are not valid.', errors);
    const result = await db.tx(async (tx) => {
      const cat = await tx.one('SELECT code FROM spir.product_category WHERE code = $1', [body.categoryCode]);
      if (!cat) throw invalid(`Unknown category ${body.categoryCode}.`);
      const supplier = (await tx.one<{ supplier_code: string }>('SELECT supplier_code FROM spir.supplier WHERE id = $1', [p.supplierId]))!;
      // Duplicate control (FR-PRD-006): the supplier part number identifies the product within the supplier's namespace.
      const dup = await tx.one<{ product_code: string }>(
        `SELECT pr.product_code FROM spir.product_identifier i JOIN spir.product pr ON pr.id = i.product_id
          WHERE i.issuer = $1 AND i.id_type = 'SUPPLIER_PART_NUMBER' AND upper(i.value) = $2`,
        [supplier.supplier_code, normIdentifier(body.supplierPartNumber)],
      );
      if (dup) throw conflict('DUPLICATE_PRODUCT', `Part number already registered as ${dup.product_code}. Update that product instead.`, { productCode: dup.product_code });
      const prod = (await tx.one<{ id: string; product_code: string }>(
        'INSERT INTO spir.product (supplier_id, category_code) VALUES ($1, $2) RETURNING id, product_code', [p.supplierId, body.categoryCode],
      ))!;
      await tx.query(`INSERT INTO spir.product_identifier (product_id, id_type, issuer, value) VALUES ($1, 'SUPPLIER_PART_NUMBER', $2, $3)`,
        [prod.id, supplier.supplier_code, body.supplierPartNumber.trim()]);
      if (body.manufacturerPartNumber?.trim()) {
        await tx.query(`INSERT INTO spir.product_identifier (product_id, id_type, issuer, value) VALUES ($1, 'MANUFACTURER_PART_NUMBER', $2, $3)`,
          [prod.id, supplier.supplier_code, body.manufacturerPartNumber.trim()]);
      }
      const v = await upsertDraft(tx, 'product', prod.id, { product_name: body.productName, description: body.description ?? null, attributes: clean }, p);
      await audit(tx, p, 'CREATE', 'product', prod.id, { productCode: prod.product_code, versionNo: v.version_no }, c.get('cid'));
      return { code: prod.product_code, versionNo: v.version_no, status: v.status };
    });
    return c.json(result, 201);
  });

  // Create/update the open draft (a new version if the latest is approved or rejected).
  r.put('/products/:code/draft', async (c) => {
    const p = requireRole(c, 'SUPPLIER_CONTRIBUTOR');
    const { db } = c.get('services');
    const body = draftSchema.parse(await c.req.json());
    const prod = await visibleProduct(db, p, c.req.param('code'));
    assertSupplierScope(p, prod.supplier_id);
    const defs = await loadDefinitions(db);
    const { clean, errors } = validateAttributes(defs, 'PRODUCT', prod.category_code, body.attributes, false);
    if (errors.length) throw invalid('Some attributes are not valid.', errors);
    const v = await db.tx(async (tx) => {
      const row = await upsertDraft(tx, 'product', prod.id, { product_name: body.productName, description: body.description ?? null, attributes: clean }, p);
      await audit(tx, p, 'SAVE_DRAFT', 'product', prod.id, { versionNo: row.version_no }, c.get('cid'));
      return row;
    });
    return c.json({ code: prod.product_code, version: versionView(v) });
  });

  r.post('/products/:code/submit', async (c) => {
    const p = requireRole(c, 'SUPPLIER_CONTRIBUTOR');
    const { db } = c.get('services');
    const prod = await visibleProduct(db, p, c.req.param('code'));
    if (prod.supplier_id !== p.supplierId) throw forbidden();
    const defs = await loadDefinitions(db);
    const v = await db.tx(async (tx) => {
      const open = await tx.one<{ attributes: Record<string, string> }>(
        `SELECT attributes FROM spir.product_version WHERE product_id = $1 AND status = 'DRAFT'`, [prod.id]);
      if (open) {
        const { errors } = validateAttributes(defs, 'PRODUCT', prod.category_code, open.attributes, true);
        if (errors.length) throw invalid('The draft is incomplete.', errors);
      }
      return submitDraft(tx, 'product', prod.id, p, c.get('cid'));
    });
    return c.json({ code: prod.product_code, version: versionView(v) });
  });

  return r;
}
