// Read-only audit trail (spec 14.7). Suppliers see only events about their own records.
import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { requireRole } from '../lib/authz.js';

export function auditRoutes() {
  const r = new Hono<AppEnv>();
  r.get('/audit', async (c) => {
    requireRole(c, 'COMPANY');
    const { db } = c.get('services');
    const entityType = c.req.query('entityType') ?? null;
    const code = c.req.query('code') ?? null;   // traceability / product code convenience filter
    const limit = Math.min(Number(c.req.query('limit') ?? 200) || 200, 1000);
    let entityId: string | null = c.req.query('entityId') ?? null;
    if (code) {
      const row = await db.one<{ id: string }>(
        `SELECT id::text FROM spir.traceability_record WHERE traceability_code = $1
         UNION ALL SELECT id::text FROM spir.product WHERE product_code = $1
         UNION ALL SELECT id::text FROM spir.validation_run WHERE run_code = $1 LIMIT 1`, [code]);
      entityId = row?.id ?? '00000000-0000-0000-0000-000000000000';
    }
    const rows = await db.query(
      `SELECT a.id, a.occurred_at AS "at", a.actor_id AS "actorId", u.display_name AS "actor", a.actor_role AS "role", a.action,
              a.entity_type AS "entityType", a.entity_id AS "entityId", a.details, a.correlation_id AS "correlationId",
              coalesce(t.traceability_code, p.product_code, v.run_code) AS "entityCode"
         FROM spir.audit_event a
         LEFT JOIN spir.app_user u ON u.id = a.actor_id
         LEFT JOIN spir.traceability_record t ON a.entity_type = 'traceability' AND t.id::text = a.entity_id
         LEFT JOIN spir.product p ON a.entity_type = 'product' AND p.id::text = a.entity_id
         LEFT JOIN spir.validation_run v ON a.entity_type = 'validation_run' AND v.id::text = a.entity_id
        WHERE ($1::text IS NULL OR a.entity_type = $1) AND ($2::text IS NULL OR a.entity_id = $2)
        ORDER BY a.id DESC LIMIT $3`,
      [entityType, entityId, limit],
    );
    return c.json({ events: rows });
  });
  return r;
}
