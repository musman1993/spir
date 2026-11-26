// Product registry (read only). Products are created and updated through the supplier's shipments.
import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import type { Db } from '../providers/db.js';
import type { Principal } from '../providers/auth.js';
import { isSupplier, principal } from '../lib/authz.js';
import { notFound } from '../lib/errors.js';
import { userNames, versionView, versions } from './versioning.js';

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
  return prod;
}

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
              (SELECT value FROM spir.product_identifier i WHERE i.product_id = pr.id AND i.id_type = 'COMPANY_PART_NUMBER' LIMIT 1) AS "partNumber",
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
      [isSupplier(p) ? p.supplierId : null, true, q],
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
                coalesce(av.attributes, lv.attributes)->>'purchase_order_number' AS "purchaseOrder",
                coalesce(av.attributes, lv.attributes)->>'po_line_number' AS "poLine",
                coalesce(av.attributes, lv.attributes)->>'quantity' AS "quantity"
           FROM spir.traceability_record t
           LEFT JOIN spir.traceability_version av ON av.id = t.current_approved_version_id
           LEFT JOIN spir.traceability_version ov ON ov.traceability_id = t.id AND ov.status IN ('DRAFT','PENDING')
           LEFT JOIN LATERAL (SELECT * FROM spir.traceability_version x WHERE x.traceability_id = t.id ORDER BY version_no DESC LIMIT 1) lv ON true
          WHERE t.product_id = $1 AND ($2 OR t.current_approved_version_id IS NOT NULL)
          ORDER BY t.traceability_code`,
        [prod.id, true],
      ),
    ]);
    const visible = all;
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

  return r;
}
