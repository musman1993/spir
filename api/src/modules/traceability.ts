// Manufacturing traceability records + technical evidence (spec 8.3, 8.5).
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { absoluteUrl, type AppEnv } from '../app.js';
import type { Db } from '../providers/db.js';
import type { Principal } from '../providers/auth.js';
import { isSupplier, principal, requireSupplierProfile } from '../lib/authz.js';
import { ApiError, invalid, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { sha256Hex } from '../lib/crypto.js';
import { userNames, versionView, versions, type VersionRow } from './versioning.js';

export async function findRecord(db: Db, code: string) {
  return db.one<{ id: string; traceability_code: string; product_id: string; external_ref: string | null; current_approved_version_id: string | null;
    supplier_id: string; category_code: string; product_code: string }>(
    `SELECT t.*, p.supplier_id, p.category_code, p.product_code
       FROM spir.traceability_record t JOIN spir.product p ON p.id = t.product_id
      WHERE t.traceability_code = $1`, [code]);
}

export async function visibleRecord(db: Db, p: Principal, code: string) {
  const rec = await findRecord(db, code);
  if (!rec) throw notFound('Traceability record');
  if (isSupplier(p) && rec.supplier_id !== p.supplierId) throw notFound('Traceability record');
  return rec;
}

export async function associations(db: Db, versionId: string) {
  const [heats, batches, serials] = await Promise.all([
    db.query<{ v: string }>('SELECT h.heat_number AS v FROM spir.traceability_version_heat x JOIN spir.heat h ON h.id = x.heat_id WHERE x.version_id = $1 ORDER BY 1', [versionId]),
    db.query<{ v: string }>('SELECT b.batch_number AS v FROM spir.traceability_version_batch x JOIN spir.batch b ON b.id = x.batch_id WHERE x.version_id = $1 ORDER BY 1', [versionId]),
    db.query<{ v: string }>('SELECT serial_number AS v FROM spir.traceability_version_serial WHERE version_id = $1 ORDER BY 1', [versionId]),
  ]);
  return { heats: heats.map((r) => r.v), batches: batches.map((r) => r.v), serials: serials.map((r) => r.v) };
}

const cleanList = (xs: string[] | undefined) => [...new Set((xs ?? []).map((s) => s.trim()).filter(Boolean))];

/** Replace the heat/batch/serial set of an (open) version. Heats/batches are namespaced by supplier. */
export async function setAssociations(db: Db, versionId: string, supplierId: string, a: { heats?: string[]; batches?: string[]; serials?: string[] }) {
  await db.query('DELETE FROM spir.traceability_version_heat WHERE version_id = $1', [versionId]);
  await db.query('DELETE FROM spir.traceability_version_batch WHERE version_id = $1', [versionId]);
  await db.query('DELETE FROM spir.traceability_version_serial WHERE version_id = $1', [versionId]);
  for (const h of cleanList(a.heats)) {
    const row = await db.one<{ id: string }>(
      `INSERT INTO spir.heat (supplier_id, heat_number) VALUES ($1, $2)
       ON CONFLICT (supplier_id, heat_number) DO UPDATE SET heat_number = EXCLUDED.heat_number RETURNING id`, [supplierId, h]);
    await db.query('INSERT INTO spir.traceability_version_heat (version_id, heat_id) VALUES ($1, $2)', [versionId, row!.id]);
  }
  for (const b of cleanList(a.batches)) {
    const row = await db.one<{ id: string }>(
      `INSERT INTO spir.batch (supplier_id, batch_number) VALUES ($1, $2)
       ON CONFLICT (supplier_id, batch_number) DO UPDATE SET batch_number = EXCLUDED.batch_number RETURNING id`, [supplierId, b]);
    await db.query('INSERT INTO spir.traceability_version_batch (version_id, batch_id) VALUES ($1, $2)', [versionId, row!.id]);
  }
  for (const s of cleanList(a.serials)) {
    await db.query('INSERT INTO spir.traceability_version_serial (version_id, serial_number) VALUES ($1, $2)', [versionId, s]);
  }
}

export async function documentsFor(db: Db, recordId: string, statuses: string[] | null) {
  return db.query(
    `SELECT d.document_code AS "code", d.doc_type AS "type", d.revision, d.file_name AS "fileName", d.media_type AS "mediaType",
            d.size_bytes::int AS "sizeBytes", d.sha256, d.created_at AS "createdAt", v.version_no AS "versionNo", v.status AS "versionStatus"
       FROM spir.document d JOIN spir.traceability_version v ON v.id = d.version_id
      WHERE d.traceability_id = $1 AND ($2::text[] IS NULL OR v.status = ANY($2))
      ORDER BY v.version_no DESC, d.doc_type, d.file_name`,
    [recordId, statuses],
  );
}

/** Full record view. `publicView` (QR scan without login) leaves out version history and uploaders. */
export async function recordDetail(db: Db, _p: Principal | null, rec: NonNullable<Awaited<ReturnType<typeof findRecord>>>, publicView = false) {
  const [all, names, product, supplier, qr] = await Promise.all([
    versions(db, 'traceability', rec.id),
    userNames(db),
    db.one(
      `SELECT p.product_code AS "code", p.category_code AS "category", v.product_name AS "name", v.version_no AS "approvedVersion", v.attributes,
              (SELECT value FROM spir.product_identifier i WHERE i.product_id = p.id AND i.id_type='COMPANY_PART_NUMBER' LIMIT 1) AS "partNumber",
              (SELECT value FROM spir.product_identifier i WHERE i.product_id = p.id AND i.id_type='SUPPLIER_PART_NUMBER' LIMIT 1) AS "supplierPartNumber"
         FROM spir.product p
         LEFT JOIN spir.product_version v ON v.id = coalesce(p.current_approved_version_id,
               (SELECT id FROM spir.product_version x WHERE x.product_id = p.id ORDER BY version_no DESC LIMIT 1))
        WHERE p.id = $1`, [rec.product_id]),
    db.one('SELECT supplier_code AS "code", legal_name AS "name", country_code AS "country" FROM spir.supplier WHERE id = $1', [rec.supplier_id]),
    db.one(`SELECT token_hint AS "hint", created_at AS "createdAt", status FROM spir.qr_token WHERE traceability_id = $1 AND status = 'ACTIVE'`, [rec.id]),
  ]);
  const visible = publicView ? all.filter((v) => v.status === 'APPROVED') : all;
  const withAssoc = async (v: VersionRow) => ({ ...versionView(v, names), ...(await associations(db, v.id)) });
  const approved = all.find((v) => v.status === 'APPROVED');
  return {
    code: rec.traceability_code,
    externalRef: rec.external_ref,
    product,
    supplier,
    approved: approved ? await withAssoc(approved) : null,
    versions: await Promise.all(visible.map(withAssoc)),
    documents: await documentsFor(db, rec.id, null),
    qr: qr ?? null,
  };
}

const ALLOWED_MEDIA: Record<string, string[]> = {
  'application/pdf': ['.pdf'], 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'text/plain': ['.txt'],
};
const DOC_TYPES = ['MTC', 'COC', 'RT_REPORT', 'INSPECTION_REPORT', 'DRAWING', 'OTHER'] as const;

/** Light content sniffing so a renamed executable can't masquerade as a PDF (FR-DOC-007). */
function sniff(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.slice(0, 8));
  if (head.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (head[0] === 0x89 && head.subarray(1, 4).toString() === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  return null;
}

export async function storeDocument(
  db: Db, storage: { put: (k: string, b: Uint8Array, t: string) => Promise<void> },
  args: { recordId: string; recordCode: string; versionId: string; docType: string; revision: string; fileName: string; mediaType: string; bytes: Uint8Array; actor: string | null },
) {
  const safeName = args.fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'file';
  const key = `documents/${args.recordCode}/${randomUUID()}/${safeName}`;
  await storage.put(key, args.bytes, args.mediaType);
  return db.one<{ document_code: string }>(
    `INSERT INTO spir.document (traceability_id, version_id, doc_type, revision, file_name, media_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING document_code`,
    [args.recordId, args.versionId, args.docType, args.revision, args.fileName, args.mediaType, args.bytes.byteLength, sha256Hex(args.bytes), key, args.actor],
  );
}

export function traceabilityRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/traceability', async (c) => {
    const p = principal(c);
    const { db } = c.get('services');
    const q = (c.req.query('q') ?? '').trim();
    const rows = await db.query(
      `SELECT t.traceability_code AS "code", p.product_code AS "productCode", coalesce(pv.product_name, '') AS "productName",
              s.legal_name AS "supplierName", av.version_no AS "approvedVersion", lv.version_no AS "latestVersion", lv.status AS "latestStatus",
              (SELECT array_agg(h.heat_number ORDER BY h.heat_number) FROM spir.traceability_version_heat vh JOIN spir.heat h ON h.id = vh.heat_id
                WHERE vh.version_id = coalesce(av.id, lv.id)) AS "heats",
              coalesce(av.attributes, lv.attributes)->>'purchase_order_number' AS "purchaseOrder",
              coalesce(av.attributes, lv.attributes)->>'po_line_number' AS "poLine",
              coalesce(av.attributes, lv.attributes)->>'quantity' AS "quantity",
              (SELECT value FROM spir.product_identifier i WHERE i.product_id = p.id AND i.id_type='COMPANY_PART_NUMBER' LIMIT 1) AS "partNumber",
              EXISTS (SELECT 1 FROM spir.qr_token qt WHERE qt.traceability_id = t.id AND qt.status = 'ACTIVE') AS "hasQr"
         FROM spir.traceability_record t
         JOIN spir.product p ON p.id = t.product_id
         JOIN spir.supplier s ON s.id = p.supplier_id
         LEFT JOIN spir.product_version pv ON pv.id = coalesce(p.current_approved_version_id,
               (SELECT id FROM spir.product_version x WHERE x.product_id = p.id ORDER BY version_no DESC LIMIT 1))
         LEFT JOIN spir.traceability_version av ON av.id = t.current_approved_version_id
         LEFT JOIN LATERAL (SELECT * FROM spir.traceability_version x WHERE x.traceability_id = t.id ORDER BY version_no DESC LIMIT 1) lv ON true
        WHERE ($1::uuid IS NULL OR p.supplier_id = $1)
          AND ($2 OR t.current_approved_version_id IS NOT NULL)
          AND ($3 = '' OR t.traceability_code ILIKE '%'||$3||'%' OR p.product_code ILIKE '%'||$3||'%' OR t.external_ref ILIKE '%'||$3||'%'
               OR coalesce(av.attributes, lv.attributes)->>'purchase_order_number' ILIKE '%'||$3||'%'
               OR EXISTS (SELECT 1 FROM spir.product_identifier i WHERE i.product_id = p.id AND i.value ILIKE '%'||$3||'%')
               OR EXISTS (SELECT 1 FROM spir.traceability_version_heat vh JOIN spir.heat h ON h.id = vh.heat_id
                           JOIN spir.traceability_version vv ON vv.id = vh.version_id
                          WHERE vv.traceability_id = t.id AND h.heat_number ILIKE '%'||$3||'%'))
        ORDER BY t.traceability_code`,
      [isSupplier(p) ? p.supplierId : null, true, q],
    );
    return c.json({ records: rows });
  });

  r.get('/traceability/:code', async (c) => {
    const p = principal(c);
    const { db } = c.get('services');
    const rec = await visibleRecord(db, p, c.req.param('code'));
    return c.json(await recordDetail(db, p, rec));
  });

  // Upload a certificate onto the record's live (current) version (multipart: file, docType, revision?).
  r.post('/traceability/:code/documents', async (c) => {
    const p = requireSupplierProfile(c);
    const { db, storage, config } = c.get('services');
    const rec = await visibleRecord(db, p, c.req.param('code'));
    const form = await c.req.formData();
    const file = form.get('file');
    const docType = String(form.get('docType') ?? 'OTHER').toUpperCase();
    const revision = String(form.get('revision') ?? 'A').trim().slice(0, 10) || 'A';
    if (!(file instanceof File)) throw invalid('Attach a file in the "file" field.');
    if (!DOC_TYPES.includes(docType as any)) throw invalid(`docType must be one of ${DOC_TYPES.join(', ')}.`);
    if (file.size > config.documentMaxBytes) throw new ApiError(413, 'FILE_TOO_LARGE', `Files must be under ${config.documentMaxBytes / 1024 / 1024} MB.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = (file.name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? '').toLowerCase();
    const declared = file.type || 'application/octet-stream';
    const sniffed = sniff(bytes) ?? (declared === 'text/plain' ? 'text/plain' : null);
    if (!sniffed || !ALLOWED_MEDIA[sniffed]?.includes(ext)) {
      throw new ApiError(415, 'UNSUPPORTED_FILE', 'Only PDF, PNG, JPEG or TXT files whose content matches their extension are accepted.');
    }
    const result = await db.tx(async (tx) => {
      const draft = await tx.one<VersionRow>(`SELECT * FROM spir.traceability_version WHERE id = $1`, [rec.current_approved_version_id]);
      if (!draft) throw new ApiError(409, 'NOT_PUBLISHED', 'Save the shipment before adding documents.');
      const doc = await storeDocument(tx, storage, {
        recordId: rec.id, recordCode: rec.traceability_code, versionId: draft.id, docType, revision,
        fileName: file.name, mediaType: sniffed, bytes, actor: p.userId,
      });
      await audit(tx, p, 'UPLOAD_DOCUMENT', 'traceability', rec.id, { documentCode: doc!.document_code, docType, fileName: file.name, versionNo: draft.version_no }, c.get('cid'));
      return doc!;
    });
    return c.json({ code: result.document_code }, 201);
  });

  // Short-lived, authorised download link (FR-DOC-005). Never a permanent public URL.
  r.get('/documents/:code/download', async (c) => {
    const p = principal(c);
    const { db, storage } = c.get('services');
    const d = await db.one<{ storage_key: string; file_name: string; traceability_code: string; version_status: string; id: string; traceability_id: string }>(
      `SELECT d.*, t.traceability_code, v.status AS version_status FROM spir.document d
         JOIN spir.traceability_record t ON t.id = d.traceability_id
         JOIN spir.traceability_version v ON v.id = d.version_id
        WHERE d.document_code = $1`, [c.req.param('code')]);
    if (!d) throw notFound('Document');
    await visibleRecord(db, p, d.traceability_code);
    const expiresIn = 300;
    const url = absoluteUrl(c, await storage.signedUrl(d.storage_key, expiresIn, d.file_name));
    await audit(db, p, 'DOWNLOAD_DOCUMENT', 'document', d.id, { documentCode: c.req.param('code'), traceabilityCode: d.traceability_code }, c.get('cid'));
    return c.json({ url, expiresIn });
  });

  return r;
}
