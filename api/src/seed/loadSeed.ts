// Loads product/shipment CSV files into SPIR. Two modes, one set of rules:
//   seed   - demo data into an empty database (npm run db:seed / dev:memory). Missing certificate
//            files get a generated "DEMO DOCUMENT" PDF.
//   import - the CSV upload in the web app, on a database that already has data. New rows create
//            records (and QR codes); a changed row adds a NEW VERSION to the existing record, so its
//            printed QR label keeps working and shows the latest data. Identical rows are skipped.
//            Mandatory fields are checked first; nothing is written if any row has an error.
//            Missing certificate files are skipped (never faked).
//
// CSV conventions (one row = one shipment of one part against one PO line):
//   * Mandatory: supplier_name, part_number, part_description, purchase_order_number, po_line_number,
//     quantity, heat_numbers, pattern_number.
//   * Optional keys: supplier_ref, product_ref, traceability_ref. Without them a supplier is identified
//     by its name, a product by supplier + part number, and a shipment by product + PO + line.
//   * heat_numbers, batch_numbers, serial_numbers, documents are pipe-separated: A|B|C.
//   * documents entries are TYPE:filename (MTC, COC, RT_REPORT, INSPECTION_REPORT, DRAWING, OTHER),
//     uploaded from seed/documents/<filename> when present.
//   * Any other column becomes an attribute (new ones are registered automatically).
import { parse } from 'csv-parse/sync';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../providers/db.js';
import type { FileStorage } from '../providers/storage.js';
import type { Principal } from '../providers/auth.js';
import { audit } from '../lib/audit.js';
import { normIdentifier } from '../domain/normalize.js';
import { loadDefinitions } from '../modules/attributes.js';
import { associations, setAssociations, storeDocument } from '../modules/traceability.js';
import { ensureActiveToken } from '../modules/qr.js';
import { simplePdf } from './pdf.js';

const CORE = new Set([
  'supplier_ref', 'supplier_name', 'supplier_country', 'product_ref', 'part_number', 'part_description', 'category', 'product_status',
  'supplier_part_number', 'traceability_ref', 'approval_status',
  'heat_numbers', 'batch_numbers', 'serial_numbers', 'documents', 'review_comment',
]);
const STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED'] as const;
type Status = (typeof STATUSES)[number];
const MANDATORY = ['supplier_name', 'part_number', 'part_description', 'purchase_order_number', 'po_line_number', 'quantity', 'heat_numbers', 'pattern_number'];

const split = (s: string | undefined) => (s ?? '').split('|').map((x) => x.trim()).filter(Boolean);
const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const status = (s: string | undefined, row: string): Status => {
  const v = (s || 'APPROVED').trim().toUpperCase() as Status;
  if (!STATUSES.includes(v)) throw new ImportError([`${row}: status "${s}" must be one of ${STATUSES.join(', ')}`]);
  return v;
};
const sameMap = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? '') === (b[k] ?? ''));
};
const sameList = (a: string[], b: string[]) => [...a].sort().join('|') === [...b].sort().join('|');

export class ImportError extends Error {
  constructor(public problems: string[]) {
    super(problems.length === 1 ? problems[0] : `${problems.length} problems in the CSV:\n${problems.slice(0, 50).join('\n')}`);
  }
}

export const DEMO_COMPANY_USERS = [
  { id: 'reviewer', name: 'Aisha Rahman', role: 'COMPANY_REVIEWER', email: 'reviewer@spir.example' },
  { id: 'admin', name: 'Omar Haddad', role: 'REGISTRY_ADMIN', email: 'admin@spir.example' },
  { id: 'qr-user', name: 'Daniel Mensah', role: 'QR_USER', email: 'qr@spir.example' },
  { id: 'inspector', name: 'Priya Nair', role: 'INSPECTOR', email: 'inspector@spir.example' },
  { id: 'auditor', name: 'Lena Fischer', role: 'AUDITOR', email: 'auditor@spir.example' },
] as const;

export interface SeedReport {
  suppliers: number; products: number; records: number; versions: number; documents: number; qrTokens: number;
  newAttributes: string[];
  updatedRecords: string[]; unchangedRecords: string[]; createdRecords: string[]; updatedProducts: string[];
  skippedDocuments: string[];
}
export interface SeedFile { name: string; text: string }
export interface LoadOptions { documentsDir?: string; log?: (m: string) => void; mode?: 'seed' | 'import'; actor?: Principal; correlationId?: string }

type Row = Record<string, string> & { __file: string; __line: string };

/** Mandatory fields and value types (import mode). Returns readable problems; empty = fine. */
export function checkRows(rows: Row[]): string[] {
  const problems: string[] = [];
  for (const r of rows) {
    const at = `${r.__file} row ${r.__line}`;
    const missing = MANDATORY.filter((k) => !r[k]?.trim());
    if (missing.length) problems.push(`${at}: missing ${missing.join(', ')}`);
    if (r.quantity?.trim() && !/^\d{1,6}$/.test(r.quantity.trim())) problems.push(`${at}: quantity "${r.quantity}" must be a whole number`);
    if (r.po_line_number?.trim() && !/^\d{1,4}$/.test(r.po_line_number.trim())) problems.push(`${at}: po_line_number "${r.po_line_number}" must be a whole number`);
    if (r.country_of_origin?.trim() && !/^[A-Za-z]{2}$/.test(r.country_of_origin.trim())) problems.push(`${at}: country_of_origin "${r.country_of_origin}" must be a 2-letter code (IN, AE, DE...)`);
  }
  return problems;
}

export async function loadSeed(db: Db, storage: FileStorage, qrKey: Buffer, csv: string | SeedFile[], opts: LoadOptions = {}): Promise<SeedReport> {
  const log = opts.log ?? (() => {});
  const mode = opts.mode ?? 'seed';
  const files: SeedFile[] = typeof csv === 'string' ? [{ name: 'seed.csv', text: csv }] : csv;
  let rows: Row[];
  try {
    rows = files.flatMap((f) =>
      (parse(f.text, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[])
        .map((r, i) => ({ ...r, __file: f.name, __line: String(i + 2) })));
  } catch (e: any) {
    throw new ImportError([`The file is not valid CSV: ${e.message}`]);
  }
  if (!rows.length) throw new ImportError(['The CSV has no data rows.']);
  if (mode === 'import') {
    const problems = checkRows(rows);
    if (problems.length) throw new ImportError(problems);
  }
  const report: SeedReport = {
    suppliers: 0, products: 0, records: 0, versions: 0, documents: 0, qrTokens: 0, newAttributes: [],
    updatedRecords: [], unchangedRecords: [], createdRecords: [], updatedProducts: [], skippedDocuments: [],
  };

  return db.tx(async (tx) => {
    if (mode === 'seed') {
      const existing = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM spir.supplier');
      if (existing!.n > 0) throw new ImportError(['Database already contains suppliers. Run `npm run db:reset` to wipe and reseed, or use Import CSV in the app.']);
    }

    // Register any new CSV columns as governed attributes (spec 7.1: attributes are metadata, not code).
    let defs = await loadDefinitions(tx);
    const known = new Set(defs.map((d) => d.attribute_key));
    const retired = new Set((await tx.query<{ attribute_key: string }>(
      `SELECT attribute_key FROM spir.attribute_definition GROUP BY attribute_key HAVING bool_and(status = 'DEPRECATED')`)).map((r) => r.attribute_key));
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !c.startsWith('__'));
    for (const col of columns) {
      if (retired.has(col)) throw new ImportError([`Column "${col}" is a retired attribute. Remove it from the CSV (see seed/README.md for the current columns).`]);
      if (CORE.has(col) || known.has(col)) continue;
      await tx.query(
        `INSERT INTO spir.attribute_definition (attribute_key, version, label, scope, data_type, label_checked, display_order, description)
         VALUES ($1, 1, $2, 'TRACEABILITY', 'TEXT', false, 200, 'Registered automatically from a CSV import')`,
        [col, col.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())]);
      report.newAttributes.push(col);
    }
    if (report.newAttributes.length) defs = await loadDefinitions(tx);
    const scopeOf = new Map(defs.filter((d) => (d.comparison_rule.source ?? 'attr') === 'attr').map((d) => [d.attribute_key, d.scope]));

    for (const u of DEMO_COMPANY_USERS) {
      await tx.query('INSERT INTO spir.app_user (id, display_name, role, email) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', [u.id, u.name, u.role, u.email]);
    }
    const approver = opts.actor?.userId ?? 'reviewer';
    const actor: Principal = opts.actor ?? { userId: 'reviewer', displayName: 'Aisha Rahman', role: 'COMPANY_REVIEWER', supplierId: null };

    const touchedRecords = new Set<string>();

    for (const row of rows) {
      const line = `${row.__file} row ${row.__line}`;
      for (const req of ['supplier_name', 'part_number', 'part_description']) {
        if (!row[req]) throw new ImportError([`${line}: column "${req}" is required.`]);
      }
      const supplierRef = row.supplier_ref?.trim() || slug(row.supplier_name);
      const attrsFor = (scope: 'PRODUCT' | 'TRACEABILITY') => Object.fromEntries(
        Object.entries(row).filter(([k, v]) => !CORE.has(k) && !k.startsWith('__') && v !== '' && scopeOf.get(k) === scope)) as Record<string, string>;

      // ---------- Supplier (found by its key, else created with a contributor login for later) ----------
      let sup = await tx.one<{ id: string; supplier_code: string; legal_name: string }>(
        'SELECT id, supplier_code, legal_name FROM spir.supplier WHERE external_ref = $1', [supplierRef]);
      const userId = `supplier-${supplierRef.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 60);
      if (!sup) {
        sup = (await tx.one<{ id: string; supplier_code: string; legal_name: string }>(
          'INSERT INTO spir.supplier (external_ref, legal_name, country_code) VALUES ($1,$2,$3) RETURNING id, supplier_code, legal_name',
          [supplierRef, row.supplier_name, (row.supplier_country || '').toUpperCase().slice(0, 2) || null]))!;
        await tx.query(`INSERT INTO spir.app_user (id, display_name, role, supplier_id, email) VALUES ($1,$2,'SUPPLIER_CONTRIBUTOR',$3,$4) ON CONFLICT (id) DO NOTHING`,
          [userId, `${row.supplier_name} contributor`, sup.id, `${userId}@supplier.example`]);
        report.suppliers++;
        log(`supplier ${sup.supplier_code}  ${row.supplier_name}`);
      } else if (sup.legal_name !== row.supplier_name) {
        await tx.query('UPDATE spir.supplier SET legal_name = $2 WHERE id = $1', [sup.id, row.supplier_name]);
        await audit(tx, actor, 'UPDATE_SUPPLIER_NAME', 'supplier', sup.id, { from: sup.legal_name, to: row.supplier_name }, opts.correlationId);
        sup.legal_name = row.supplier_name;
      }
      const createdBy = (await tx.one('SELECT 1 FROM spir.app_user WHERE id = $1', [userId])) ? userId : approver;

      // ---------- Product (supplier + company part number) ----------
      const category = row.category?.trim() || 'VALVE_COMPONENT';
      const cat = await tx.one('SELECT code FROM spir.product_category WHERE code = $1', [category]);
      if (!cat) throw new ImportError([`${line}: unknown category "${category}".`]);
      let prod = await tx.one<{ id: string; product_code: string }>(
        `SELECT p.id, p.product_code FROM spir.product p JOIN spir.product_identifier i ON i.product_id = p.id
          WHERE p.supplier_id = $1 AND i.id_type = 'COMPANY_PART_NUMBER' AND upper(i.value) = $2`, [sup.id, normIdentifier(row.part_number)]);
      const prodAttrs = attrsFor('PRODUCT');
      const ps = status(row.product_status, line);
      if (!prod) {
        prod = (await tx.one<{ id: string; product_code: string }>(
          'INSERT INTO spir.product (supplier_id, category_code) VALUES ($1,$2) RETURNING id, product_code', [sup.id, category]))!;
        await tx.query(`INSERT INTO spir.product_identifier (product_id, id_type, issuer, value) VALUES ($1,'COMPANY_PART_NUMBER',$2,$3)`,
          [prod.id, sup.supplier_code, row.part_number.trim()]);
        if (row.supplier_part_number) {
          await tx.query(`INSERT INTO spir.product_identifier (product_id, id_type, issuer, value) VALUES ($1,'SUPPLIER_PART_NUMBER',$2,$3)
                          ON CONFLICT DO NOTHING`, [prod.id, sup.supplier_code, row.supplier_part_number]);
        }
        await addProductVersion(tx, prod.id, ps, row.part_description, prodAttrs, createdBy, approver);
        report.products++;
        log(`  product ${prod.product_code}  ${row.part_number} ${row.part_description} [${ps}]`);
      } else {
        const latest = await tx.one<{ product_name: string; attributes: Record<string, string> }>(
          'SELECT product_name, attributes FROM spir.product_version WHERE product_id = $1 ORDER BY version_no DESC LIMIT 1', [prod.id]);
        if (!latest || latest.product_name !== row.part_description || !sameMap(latest.attributes ?? {}, prodAttrs)) {
          await addProductVersion(tx, prod.id, ps, row.part_description, prodAttrs, createdBy, approver);
          if (!report.updatedProducts.includes(prod.product_code)) report.updatedProducts.push(prod.product_code);
          await audit(tx, actor, 'IMPORT_UPDATE', 'product', prod.id, { source: line }, opts.correlationId);
        }
      }

      // ---------- Shipment record (product + key, default PO + line) ----------
      const ref = row.traceability_ref?.trim()
        || (row.purchase_order_number && row.po_line_number ? `${row.purchase_order_number.trim()}-L${Number(row.po_line_number)}` : '');
      if (!ref) throw new ImportError([`${line}: needs purchase_order_number and po_line_number (or a traceability_ref).`]);
      const st = status(row.approval_status, line);
      const trcAttrs = attrsFor('TRACEABILITY');
      const assoc = { heats: split(row.heat_numbers), batches: split(row.batch_numbers), serials: split(row.serial_numbers) };
      let rec = await tx.one<{ id: string; traceability_code: string }>(
        'SELECT id, traceability_code FROM spir.traceability_record WHERE product_id = $1 AND external_ref = $2', [prod.id, ref]);
      let versionId: string | null = null;
      let versionNo = 1;
      if (!rec) {
        rec = (await tx.one<{ id: string; traceability_code: string }>(
          'INSERT INTO spir.traceability_record (product_id, external_ref) VALUES ($1,$2) RETURNING id, traceability_code', [prod.id, ref]))!;
        versionId = await addRecordVersion(tx, rec.id, st, trcAttrs, assoc, sup.id, createdBy, approver, row.review_comment);
        report.records++;
        report.createdRecords.push(rec.traceability_code);
        if (mode === 'import') await audit(tx, actor, 'IMPORT_CREATE', 'traceability', rec.id, { source: line }, opts.correlationId);
      } else {
        const latest = await tx.one<{ id: string; version_no: number; attributes: Record<string, string> }>(
          'SELECT id, version_no, attributes FROM spir.traceability_version WHERE traceability_id = $1 ORDER BY version_no DESC LIMIT 1', [rec.id]);
        const cur = latest ? await associations(tx, latest.id) : null;
        const docsChanged = split(row.documents).length > 0 && !touchedRecords.has(rec.id) && mode === 'seed';
        const changed = !latest || !cur || !sameMap(latest.attributes ?? {}, trcAttrs) || !sameList(cur.heats, assoc.heats)
          || !sameList(cur.batches, assoc.batches) || !sameList(cur.serials, assoc.serials) || docsChanged
          // In the demo seed a repeated row with a status is always a new version; an import only reacts to real changes.
          || (mode === 'seed' && !!row.approval_status);
        if (changed) {
          versionId = await addRecordVersion(tx, rec.id, st, trcAttrs, assoc, sup.id, createdBy, approver, row.review_comment);
          versionNo = latest!.version_no + 1;
          if (!report.updatedRecords.includes(rec.traceability_code)) report.updatedRecords.push(rec.traceability_code);
          await audit(tx, actor, 'IMPORT_UPDATE', 'traceability', rec.id, { source: line, versionNo }, opts.correlationId);
        } else if (!report.unchangedRecords.includes(rec.traceability_code)) {
          report.unchangedRecords.push(rec.traceability_code);
        }
      }
      touchedRecords.add(rec.id);
      if (versionId) {
        report.versions++;
        versionNo = (await tx.one<{ version_no: number }>('SELECT version_no FROM spir.traceability_version WHERE id = $1', [versionId]))!.version_no;
        for (const entry of split(row.documents)) {
          const [rawType, ...rest] = entry.split(':');
          const fileName = rest.join(':').trim();
          const docType = rawType.trim().toUpperCase();
          if (!fileName) throw new ImportError([`${line}: document "${entry}" must look like TYPE:filename.pdf`]);
          const local = opts.documentsDir ? path.join(opts.documentsDir, fileName) : '';
          let bytes: Uint8Array;
          if (local && existsSync(local)) bytes = new Uint8Array(readFileSync(local));
          else if (mode === 'seed') {
            bytes = simplePdf(`${docType} - ${fileName}`, [
              `Supplier: ${row.supplier_name}`,
              `Part number: ${row.part_number}${row.design_revision ? ` Rev ${row.design_revision}` : ''}   ${row.part_description}`,
              `Material: ${row.material || '-'}`,
              `PO ${row.purchase_order_number ?? '-'} line ${row.po_line_number ?? '-'}   Quantity ${row.quantity ?? '-'}`,
              `Heat(s): ${split(row.heat_numbers).join(', ')}   Pattern: ${row.pattern_number ?? '-'}   RT: ${row.radiographic_test_number || '-'}`,
              `SPIR record: ${rec.traceability_code} v${versionNo}`,
            ]);
          } else {
            report.skippedDocuments.push(`${line}: ${fileName} (file not found - upload it on the record page)`);
            continue;
          }
          const media = fileName.toLowerCase().endsWith('.png') ? 'image/png' : fileName.toLowerCase().match(/\.jpe?g$/) ? 'image/jpeg' : 'application/pdf';
          const revision = /rev([A-Z])\./i.exec(fileName)?.[1]?.toUpperCase() ?? 'A';
          await storeDocument(tx, storage, { recordId: rec.id, recordCode: rec.traceability_code, versionId, docType, revision, fileName, mediaType: media, bytes, actor: createdBy });
          report.documents++;
        }
        log(`    record ${rec.traceability_code} v${versionNo} [${st}] PO ${row.purchase_order_number}/${row.po_line_number} heats=${row.heat_numbers}`);
      }
    }

    // Every published record has an active QR label; existing labels are never replaced by an import.
    for (const id of touchedRecords) {
      const pub = await tx.one('SELECT current_approved_version_id FROM spir.traceability_record WHERE id = $1', [id]);
      if (pub?.current_approved_version_id && (await ensureActiveToken(tx, qrKey, id, actor, opts.correlationId)).issued) report.qrTokens++;
    }
    await audit(tx, opts.actor ?? null, mode === 'import' ? 'CSV_IMPORT' : 'SEED_IMPORT', 'system', null,
      { files: files.map((f) => f.name), rows: rows.length, ...report }, opts.correlationId);
    return report;
  });
}

async function addProductVersion(tx: Db, productId: string, st: Status, name: string, attrs: Record<string, string>, createdBy: string, approver: string) {
  if (st === 'APPROVED') await tx.query(`UPDATE spir.product_version SET status = 'SUPERSEDED' WHERE product_id = $1 AND status = 'APPROVED'`, [productId]);
  if (st === 'DRAFT' || st === 'PENDING') await tx.query(`UPDATE spir.product_version SET status = 'WITHDRAWN' WHERE product_id = $1 AND status IN ('DRAFT','PENDING')`, [productId]);
  const v = (await tx.one<{ id: string }>(
    `INSERT INTO spir.product_version (product_id, version_no, status, product_name, attributes, source, created_by, submitted_at, reviewed_by, reviewed_at)
     VALUES ($1, (SELECT coalesce(max(version_no),0)+1 FROM spir.product_version WHERE product_id = $1), $2, $3, $4, 'SEED', $5,
             CASE WHEN $2 <> 'DRAFT' THEN now() END,
             CASE WHEN $2 IN ('APPROVED','REJECTED') THEN $6 END, CASE WHEN $2 IN ('APPROVED','REJECTED') THEN now() END)
     RETURNING id`, [productId, st, name, JSON.stringify(attrs), createdBy, approver]))!;
  if (st === 'APPROVED') await tx.query('UPDATE spir.product SET current_approved_version_id = $2 WHERE id = $1', [productId, v.id]);
}

async function addRecordVersion(
  tx: Db, recordId: string, st: Status, attrs: Record<string, string>, assoc: { heats: string[]; batches: string[]; serials: string[] },
  supplierId: string, createdBy: string, approver: string, comment?: string,
): Promise<string> {
  if (st === 'APPROVED') await tx.query(`UPDATE spir.traceability_version SET status = 'SUPERSEDED' WHERE traceability_id = $1 AND status = 'APPROVED'`, [recordId]);
  if (st === 'DRAFT' || st === 'PENDING') await tx.query(`UPDATE spir.traceability_version SET status = 'WITHDRAWN' WHERE traceability_id = $1 AND status IN ('DRAFT','PENDING')`, [recordId]);
  const v = (await tx.one<{ id: string }>(
    `INSERT INTO spir.traceability_version (traceability_id, version_no, status, attributes, source, created_by, submitted_at, reviewed_by, reviewed_at, review_comment)
     VALUES ($1, (SELECT coalesce(max(version_no),0)+1 FROM spir.traceability_version WHERE traceability_id = $1), $2, $3, 'SEED', $4,
             CASE WHEN $2 <> 'DRAFT' THEN now() END,
             CASE WHEN $2 IN ('APPROVED','REJECTED') THEN $5 END, CASE WHEN $2 IN ('APPROVED','REJECTED') THEN now() END, $6)
     RETURNING id`, [recordId, st, JSON.stringify(attrs), createdBy, approver, comment || null]))!;
  await setAssociations(tx, v.id, supplierId, assoc);
  if (st === 'APPROVED') await tx.query('UPDATE spir.traceability_record SET current_approved_version_id = $2 WHERE id = $1', [recordId, v.id]);
  return v.id;
}
