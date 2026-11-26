// Reference data and dashboard counts.
import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { isSupplier, principal, requireRole } from '../lib/authz.js';
import { loadDefinitions } from './attributes.js';

export function catalogRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/suppliers', async (c) => {
    requireRole(c, 'COMPANY');
    const { db } = c.get('services');
    const rows = await db.query(
      `SELECT s.supplier_code AS "code", s.legal_name AS "name", s.country_code AS "country", s.status,
              (SELECT count(*)::int FROM spir.product pr WHERE pr.supplier_id = s.id) AS "productCount"
         FROM spir.supplier s ORDER BY s.legal_name`);
    return c.json({ suppliers: rows });
  });

  r.get('/categories', async (c) => {
    principal(c);
    return c.json({ categories: await c.get('services').db.query('SELECT code, name, description FROM spir.product_category ORDER BY name') });
  });

  // Field names and labels only (no business data): public, so the QR scan page can label the fields.
  r.get('/attribute-definitions', async (c) => {
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
    if (isSupplier(p) && !sid) return c.json({ products: 0, records: 0, qrLabels: 0, suppliers: 0, validationRuns: 0 });
    const one = async (sql: string) => ((await db.one<{ n: number }>(sql, [sid]))?.n ?? 0);
    const [products, records, qrLabels, suppliers, runs] = await Promise.all([
      one(`SELECT count(*)::int n FROM spir.product WHERE ($1::uuid IS NULL OR supplier_id = $1)`),
      one(`SELECT count(*)::int n FROM spir.traceability_record t JOIN spir.product p ON p.id = t.product_id WHERE ($1::uuid IS NULL OR p.supplier_id = $1)`),
      one(`SELECT count(*)::int n FROM spir.qr_token q JOIN spir.traceability_record t ON t.id = q.traceability_id JOIN spir.product p ON p.id = t.product_id
            WHERE q.status = 'ACTIVE' AND ($1::uuid IS NULL OR p.supplier_id = $1)`),
      one(`SELECT count(*)::int n FROM spir.supplier WHERE $1::uuid IS NULL`),
      sid ? Promise.resolve(0) : one(`SELECT count(*)::int n FROM spir.validation_run WHERE $1::uuid IS NULL`),
    ]);
    return c.json({ products, records, qrLabels, suppliers, validationRuns: runs });
  });

  return r;
}
