// Reference data, the current user and dashboard counts.
import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { isSupplier, principal } from '../lib/authz.js';
import { loadDefinitions } from './attributes.js';

export function catalogRoutes() {
  const r = new Hono<AppEnv>();

  // Demo role switcher list. In a real deployment this route disappears with AUTH_MODE != demo.
  r.get('/demo-users', async (c) => {
    const { db, auth } = c.get('services');
    if (auth.mode !== 'demo') return c.json({ users: [] });
    const users = await db.query(
      `SELECT u.id, u.display_name AS "displayName", u.role, s.supplier_code AS "supplierCode", s.legal_name AS "supplierName"
         FROM spir.app_user u LEFT JOIN spir.supplier s ON s.id = u.supplier_id
        WHERE u.active
        ORDER BY array_position(ARRAY['COMPANY_REVIEWER','INSPECTOR','QR_USER','REGISTRY_ADMIN','AUDITOR','SUPPLIER_CONTRIBUTOR'], u.role), u.id`,
    );
    return c.json({ users });
  });

  r.get('/me', async (c) => {
    const p = principal(c);
    const { db } = c.get('services');
    const s = p.supplierId
      ? await db.one('SELECT supplier_code AS "code", legal_name AS "name" FROM spir.supplier WHERE id = $1', [p.supplierId])
      : null;
    return c.json({ ...p, supplier: s });
  });

  r.get('/suppliers', async (c) => {
    const p = principal(c);
    const { db } = c.get('services');
    const rows = await db.query(
      `SELECT s.supplier_code AS "code", s.legal_name AS "name", s.country_code AS "country", s.status,
              (SELECT count(*)::int FROM spir.product pr WHERE pr.supplier_id = s.id) AS "productCount"
         FROM spir.supplier s
        WHERE ($1::uuid IS NULL OR s.id = $1)
        ORDER BY s.legal_name`,
      [isSupplier(p) ? p.supplierId : null],
    );
    return c.json({ suppliers: rows });
  });

  r.get('/categories', async (c) => {
    principal(c);
    return c.json({ categories: await c.get('services').db.query('SELECT code, name, description FROM spir.product_category ORDER BY name') });
  });

  r.get('/attribute-definitions', async (c) => {
    principal(c);
    const defs = await loadDefinitions(c.get('services').db);
    return c.json({
      definitions: defs.map((d) => ({
        key: d.attribute_key, version: d.version, label: d.label, scope: d.scope, dataType: d.data_type,
        unit: d.unit, category: d.category_code, required: d.required, allowedValues: d.allowed_values,
        comparisonRule: d.comparison_rule, critical: d.critical, labelChecked: d.label_checked, displayOrder: d.display_order,
      })),
    });
  });

  r.get('/label-profiles', async (c) => {
    principal(c);
    const rows = await c.get('services').db.query(
      `SELECT DISTINCT ON (profile_key) profile_key AS "key", version, name, config
         FROM spir.label_profile WHERE status = 'ACTIVE' ORDER BY profile_key, version DESC`,
    );
    return c.json({ profiles: rows });
  });

  r.get('/dashboard', async (c) => {
    const p = principal(c);
    const { db } = c.get('services');
    const sid = isSupplier(p) ? p.supplierId : null;
    const one = async (sql: string) => ((await db.one<{ n: number }>(sql, [sid]))?.n ?? 0);
    const [products, records, pending, drafts, rejected, runs, openDiscrepancies] = await Promise.all([
      one(`SELECT count(*)::int n FROM spir.product WHERE ($1::uuid IS NULL OR supplier_id = $1)`),
      one(`SELECT count(*)::int n FROM spir.traceability_record t JOIN spir.product p ON p.id = t.product_id WHERE ($1::uuid IS NULL OR p.supplier_id = $1)`),
      one(`SELECT (SELECT count(*) FROM spir.product_version v JOIN spir.product p ON p.id=v.product_id WHERE v.status='PENDING' AND ($1::uuid IS NULL OR p.supplier_id=$1))
              + (SELECT count(*) FROM spir.traceability_version v JOIN spir.traceability_record t ON t.id=v.traceability_id JOIN spir.product p ON p.id=t.product_id WHERE v.status='PENDING' AND ($1::uuid IS NULL OR p.supplier_id=$1)) AS n`),
      one(`SELECT (SELECT count(*) FROM spir.product_version v JOIN spir.product p ON p.id=v.product_id WHERE v.status='DRAFT' AND ($1::uuid IS NULL OR p.supplier_id=$1))
              + (SELECT count(*) FROM spir.traceability_version v JOIN spir.traceability_record t ON t.id=v.traceability_id JOIN spir.product p ON p.id=t.product_id WHERE v.status='DRAFT' AND ($1::uuid IS NULL OR p.supplier_id=$1)) AS n`),
      one(`SELECT count(*)::int n FROM spir.traceability_version v JOIN spir.traceability_record t ON t.id=v.traceability_id JOIN spir.product p ON p.id=t.product_id
             WHERE v.status='REJECTED' AND ($1::uuid IS NULL OR p.supplier_id=$1)
               AND NOT EXISTS (SELECT 1 FROM spir.traceability_version v2 WHERE v2.traceability_id=v.traceability_id AND v2.version_no > v.version_no)`),
      sid ? Promise.resolve(0) : one(`SELECT count(*)::int n FROM spir.validation_run WHERE $1::uuid IS NULL`),
      sid ? Promise.resolve(0) : one(`SELECT count(*)::int n FROM spir.discrepancy WHERE status IN ('OPEN','IN_PROGRESS') AND $1::uuid IS NULL`),
    ]);
    return c.json({ products, records, pending: Number(pending), drafts: Number(drafts), rejected, validationRuns: runs, openDiscrepancies });
  });

  return r;
}
