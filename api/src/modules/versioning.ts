// Shared lifecycle engine for product and traceability versions (spec 9).
//   DRAFT -> PENDING -> APPROVED | REJECTED ; APPROVED -> SUPERSEDED when a newer version is approved.
// A pending/draft change never alters the approved version (FR-WF-007): edits always create or
// modify a separate open version row.
import type { Db } from '../providers/db.js';
import type { Principal } from '../providers/auth.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

export type Kind = 'product' | 'traceability';

export const KIND = {
  product: { versionTable: 'spir.product_version', parentTable: 'spir.product', fk: 'product_id', codeCol: 'product_code' },
  traceability: { versionTable: 'spir.traceability_version', parentTable: 'spir.traceability_record', fk: 'traceability_id', codeCol: 'traceability_code' },
} as const;

export interface VersionRow {
  id: string;
  version_no: number;
  status: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED' | 'WITHDRAWN';
  attributes: Record<string, string>;
  created_by: string | null;
  created_at: string;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  source: string;
  [k: string]: any;
}

export async function versions(db: Db, kind: Kind, parentId: string): Promise<VersionRow[]> {
  const k = KIND[kind];
  return db.query<VersionRow>(`SELECT * FROM ${k.versionTable} WHERE ${k.fk} = $1 ORDER BY version_no DESC`, [parentId]);
}

export async function openVersion(db: Db, kind: Kind, parentId: string) {
  const k = KIND[kind];
  return db.one<VersionRow>(
    `SELECT * FROM ${k.versionTable} WHERE ${k.fk} = $1 AND status IN ('DRAFT','PENDING') FOR UPDATE`,
    [parentId],
  );
}

/**
 * Create or update the open DRAFT for a record. If only approved/rejected versions exist a new
 * version number is allocated. A PENDING version blocks edits until it is reviewed.
 */
export async function upsertDraft(
  db: Db, kind: Kind, parentId: string, fields: Record<string, unknown>, actor: Principal,
): Promise<VersionRow> {
  const k = KIND[kind];
  // Serialise concurrent edits on the same record.
  await db.query(`SELECT id FROM ${k.parentTable} WHERE id = $1 FOR UPDATE`, [parentId]);
  const open = await openVersion(db, kind, parentId);
  if (open?.status === 'PENDING') {
    throw conflict('VERSION_PENDING_REVIEW', `Version ${open.version_no} is waiting for company review and cannot be edited.`);
  }
  const cols = Object.keys(fields);
  const vals = cols.map((c) => (c === 'attributes' ? JSON.stringify(fields[c]) : fields[c]));
  if (open) {
    const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const row = (await db.one<VersionRow>(`UPDATE ${k.versionTable} SET ${set} WHERE id = $1 RETURNING *`, [open.id, ...vals]))!;
    return row;
  }
  const next = await db.one<{ n: number }>(`SELECT coalesce(max(version_no), 0) + 1 AS n FROM ${k.versionTable} WHERE ${k.fk} = $1`, [parentId]);
  const allCols = [k.fk, 'version_no', 'status', 'created_by', ...cols];
  const placeholders = allCols.map((_, i) => `$${i + 1}`).join(', ');
  return (await db.one<VersionRow>(
    `INSERT INTO ${k.versionTable} (${allCols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    [parentId, next!.n, 'DRAFT', actor.userId, ...vals],
  ))!;
}

export async function submitDraft(db: Db, kind: Kind, parentId: string, actor: Principal, cid?: string) {
  const k = KIND[kind];
  const open = await openVersion(db, kind, parentId);
  if (!open) throw notFound('Open draft');
  if (open.status !== 'DRAFT') throw conflict('NOT_A_DRAFT', `Version ${open.version_no} is already ${open.status}.`);
  const row = (await db.one<VersionRow>(
    `UPDATE ${k.versionTable} SET status = 'PENDING', submitted_at = now() WHERE id = $1 RETURNING *`, [open.id],
  ))!;
  await audit(db, actor, 'SUBMIT', kind, parentId, { versionId: row.id, versionNo: row.version_no }, cid);
  return row;
}

export async function approveVersion(db: Db, kind: Kind, versionId: string, actor: Principal, comment: string | null, cid?: string) {
  const k = KIND[kind];
  const v = await db.one<VersionRow>(`SELECT * FROM ${k.versionTable} WHERE id = $1 FOR UPDATE`, [versionId]);
  if (!v) throw notFound('Version');
  if (v.status !== 'PENDING') throw conflict('NOT_PENDING', `Only PENDING versions can be approved (this one is ${v.status}).`);
  const parentId = v[k.fk] as string;
  const prev = await db.one<VersionRow>(`SELECT * FROM ${k.versionTable} WHERE ${k.fk} = $1 AND status = 'APPROVED'`, [parentId]);
  if (prev) await db.query(`UPDATE ${k.versionTable} SET status = 'SUPERSEDED' WHERE id = $1`, [prev.id]);
  const row = (await db.one<VersionRow>(
    `UPDATE ${k.versionTable} SET status = 'APPROVED', reviewed_by = $2, reviewed_at = now(), review_comment = $3 WHERE id = $1 RETURNING *`,
    [versionId, actor.userId, comment],
  ))!;
  await db.query(`UPDATE ${k.parentTable} SET current_approved_version_id = $2 WHERE id = $1`, [parentId, versionId]);
  await audit(db, actor, 'APPROVE', kind, parentId, { versionId, versionNo: row.version_no, supersededVersionId: prev?.id ?? null, comment }, cid);
  return { row, parentId, superseded: prev };
}

export async function rejectVersion(db: Db, kind: Kind, versionId: string, actor: Principal, comment: string, cid?: string) {
  if (!comment?.trim()) throw invalid('A rejection needs a reason the supplier can act on (FR-WF-005).');
  const k = KIND[kind];
  const v = await db.one<VersionRow>(`SELECT * FROM ${k.versionTable} WHERE id = $1 FOR UPDATE`, [versionId]);
  if (!v) throw notFound('Version');
  if (v.status !== 'PENDING') throw conflict('NOT_PENDING', `Only PENDING versions can be rejected (this one is ${v.status}).`);
  const row = (await db.one<VersionRow>(
    `UPDATE ${k.versionTable} SET status = 'REJECTED', reviewed_by = $2, reviewed_at = now(), review_comment = $3 WHERE id = $1 RETURNING *`,
    [versionId, actor.userId, comment.trim()],
  ))!;
  await audit(db, actor, 'REJECT', kind, v[k.fk], { versionId, versionNo: row.version_no, comment }, cid);
  return row;
}

export function versionView(v: VersionRow, names: Record<string, string> = {}) {
  return {
    id: v.id,
    versionNo: v.version_no,
    status: v.status,
    attributes: v.attributes ?? {},
    source: v.source,
    createdBy: v.created_by,
    createdAt: v.created_at,
    submittedAt: v.submitted_at,
    reviewedBy: v.reviewed_by ? names[v.reviewed_by] ?? v.reviewed_by : null,
    reviewedAt: v.reviewed_at,
    reviewComment: v.review_comment,
  };
}

export async function userNames(db: Db): Promise<Record<string, string>> {
  const rows = await db.query<{ id: string; display_name: string }>('SELECT id, display_name FROM spir.app_user');
  return Object.fromEntries(rows.map((r) => [r.id, r.display_name]));
}
