// Company review & publication (spec 8.6, 9.3).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import type { Db } from '../providers/db.js';
import { requireRole } from '../lib/authz.js';
import { conflict, notFound } from '../lib/errors.js';
import { approveVersion, rejectVersion, userNames, type Kind } from './versioning.js';
import { associations, documentsFor } from './traceability.js';
import { ensureActiveToken } from './qr.js';

type Change = { field: string; from: string | null; to: string | null };

function diff(before: Record<string, any> | null, after: Record<string, any>): Change[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  const out: Change[] = [];
  for (const k of [...keys].sort()) {
    const a = before?.[k] ?? null;
    const b = after[k] ?? null;
    const sa = Array.isArray(a) ? a.join(', ') : a;
    const sb = Array.isArray(b) ? b.join(', ') : b;
    if ((sa ?? '') !== (sb ?? '')) out.push({ field: k, from: sa ?? null, to: sb ?? null });
  }
  return out;
}

async function queue(db: Db) {
  const names = await userNames(db);
  const products = await db.query(
    `SELECT v.id, v.version_no, v.submitted_at, v.created_by, v.product_name, v.description, v.attributes,
            p.product_code, s.legal_name AS supplier_name, a.product_name AS a_name, a.description AS a_description, a.attributes AS a_attributes, a.version_no AS a_version, a.status AS a_status
       FROM spir.product_version v JOIN spir.product p ON p.id = v.product_id JOIN spir.supplier s ON s.id = p.supplier_id
       LEFT JOIN LATERAL (SELECT * FROM spir.product_version x WHERE x.product_id = v.product_id AND x.id <> v.id
                           AND (x.id = p.current_approved_version_id OR (p.current_approved_version_id IS NULL AND x.version_no < v.version_no))
                         ORDER BY x.version_no DESC LIMIT 1) a ON true
      WHERE v.status = 'PENDING' ORDER BY v.submitted_at`,
  );
  const records = await db.query(
    `SELECT v.id, v.version_no, v.submitted_at, v.created_by, v.attributes, t.id AS record_id, t.traceability_code, t.current_approved_version_id,
            p.product_code, p.current_approved_version_id AS product_approved, s.legal_name AS supplier_name,
            a.id AS a_id, a.attributes AS a_attributes, a.version_no AS a_version, a.status AS a_status, pv.product_name
       FROM spir.traceability_version v JOIN spir.traceability_record t ON t.id = v.traceability_id
       JOIN spir.product p ON p.id = t.product_id JOIN spir.supplier s ON s.id = p.supplier_id
       LEFT JOIN LATERAL (SELECT * FROM spir.traceability_version x WHERE x.traceability_id = v.traceability_id AND x.id <> v.id
                           AND (x.id = t.current_approved_version_id OR (t.current_approved_version_id IS NULL AND x.version_no < v.version_no))
                         ORDER BY x.version_no DESC LIMIT 1) a ON true
       LEFT JOIN spir.product_version pv ON pv.id = coalesce(p.current_approved_version_id,
            (SELECT id FROM spir.product_version x WHERE x.product_id = p.id ORDER BY version_no DESC LIMIT 1))
      WHERE v.status = 'PENDING' ORDER BY v.submitted_at`,
  );
  const items = [];
  for (const v of products) {
    items.push({
      kind: 'product' as Kind, versionId: v.id, versionNo: v.version_no, code: v.product_code, title: v.product_name,
      supplierName: v.supplier_name, submittedAt: v.submitted_at, submittedBy: names[v.created_by] ?? v.created_by,
      comparedTo: v.a_version ? { versionNo: v.a_version, status: v.a_status } : null, blockedReason: null,
      changes: diff(v.a_version ? { product_name: v.a_name, description: v.a_description, ...v.a_attributes } : null,
        { product_name: v.product_name, description: v.description, ...v.attributes }),
      documents: [],
    });
  }
  for (const v of records) {
    const [now, before] = await Promise.all([
      associations(db, v.id),
      v.a_id ? associations(db, v.a_id) : Promise.resolve(null),
    ]);
    const docs = (await documentsFor(db, v.record_id, null)).filter((d: any) => d.versionNo === v.version_no);
    items.push({
      kind: 'traceability' as Kind, versionId: v.id, versionNo: v.version_no, code: v.traceability_code,
      title: `${v.product_name ?? v.product_code} - ${now.heats.join(', ') || 'no heat'}`, productCode: v.product_code,
      supplierName: v.supplier_name, submittedAt: v.submitted_at, submittedBy: names[v.created_by] ?? v.created_by,
      comparedTo: v.a_version ? { versionNo: v.a_version, status: v.a_status } : null,
      blockedReason: v.product_approved ? null : 'The product itself is not approved yet - approve the product first.',
      changes: diff(before ? { ...v.a_attributes, heats: before.heats, batches: before.batches, serials: before.serials } : null,
        { ...v.attributes, heats: now.heats, batches: now.batches, serials: now.serials }),
      documents: docs,
    });
  }
  return items.sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
}

const decisionSchema = z.object({ comment: z.string().max(2000).optional().nullable() });

export function workflowRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/review-queue', async (c) => {
    requireRole(c, 'COMPANY_REVIEWER', 'REGISTRY_ADMIN', 'AUDITOR');
    return c.json({ items: await queue(c.get('services').db) });
  });

  r.post('/review/:kind/:versionId/:decision', async (c) => {
    const p = requireRole(c, 'COMPANY_REVIEWER');
    const { db, config } = c.get('services');
    const kind = c.req.param('kind') as Kind;
    const decision = c.req.param('decision');
    if (!['product', 'traceability'].includes(kind) || !['approve', 'reject'].includes(decision)) throw notFound('Route');
    const { comment } = decisionSchema.parse(await c.req.json().catch(() => ({})));
    const versionId = c.req.param('versionId');
    const out = await db.tx(async (tx) => {
      if (decision === 'reject') {
        const row = await rejectVersion(tx, kind, versionId, p, comment ?? '', c.get('cid'));
        return { status: row.status, versionNo: row.version_no };
      }
      if (kind === 'traceability') {
        // A manufacturing record is only published under an approved product identity.
        const prodOk = await tx.one(
          `SELECT p.current_approved_version_id FROM spir.traceability_version v JOIN spir.traceability_record t ON t.id = v.traceability_id
             JOIN spir.product p ON p.id = t.product_id WHERE v.id = $1`, [versionId]);
        if (!prodOk) throw notFound('Version');
        if (!prodOk.current_approved_version_id) throw conflict('PRODUCT_NOT_APPROVED', 'Approve the product before its traceability records.');
      }
      const { row, parentId } = await approveVersion(tx, kind, versionId, p, comment ?? null, c.get('cid'));
      let qrIssued = false;
      if (kind === 'traceability') qrIssued = (await ensureActiveToken(tx, config.qrKey, parentId, p, c.get('cid'))).issued;
      return { status: row.status, versionNo: row.version_no, qrIssued };
    });
    return c.json(out);
  });

  return r;
}
