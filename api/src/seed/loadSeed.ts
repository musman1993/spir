// Loads the editable demo CSV (seed/spir_seed.csv) into SPIR through the same rules the app uses.
//
// CSV conventions (one row = one version of one traceability record):
//   * supplier_ref / product_ref / traceability_ref are YOUR keys for linking rows.
//     SPIR generates its own official IDs (SUP-..., PRD-..., TRC-...).
//   * Repeat a traceability_ref on a later row to create a newer version of that record
//     (e.g. an APPROVED row followed by a PENDING row = a pending update on a published record).
//   * heat_numbers, batch_numbers, serial_numbers, documents are pipe-separated: A|B|C.
//   * documents entries are TYPE:filename (TYPE = MTC, COC, INSPECTION_REPORT, DRAWING, OTHER).
//     If seed/documents/<filename> exists it is uploaded; otherwise a demo PDF is generated.
//   * Any column that is not a core column becomes an attribute. If no attribute definition exists
//     for it yet, a TRACEABILITY-scope TEXT attribute is registered automatically.
import { parse } from 'csv-parse/sync';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../providers/db.js';
import type { FileStorage } from '../providers/storage.js';
import { audit } from '../lib/audit.js';
import { loadDefinitions } from '../modules/attributes.js';
import { setAssociations, storeDocument } from '../modules/traceability.js';
import { issueToken } from '../modules/qr.js';
import { simplePdf } from './pdf.js';

const CORE = new Set([
  'supplier_ref', 'supplier_name', 'supplier_country', 'product_ref', 'part_number', 'part_description', 'category', 'product_status',
  'supplier_part_number', 'traceability_ref', 'approval_status',
  'heat_numbers', 'batch_numbers', 'serial_numbers', 'documents', 'review_comment',
]);
const STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED'] as const;
type Status = (typeof STATUSES)[number];

const split = (s: string | undefined) => (s ?? '').split('|').map((x) => x.trim()).filter(Boolean);
const status = (s: string | undefined, row: string): Status => {
  const v = (s || 'APPROVED').trim().toUpperCase() as Status;
  if (!STATUSES.includes(v)) throw new Error(`${row}: status "${s}" must be one of ${STATUSES.join(', ')}`);
  return v;
};

export const DEMO_COMPANY_USERS = [
  { id: 'reviewer', name: 'Aisha Rahman', role: 'COMPANY_REVIEWER', email: 'reviewer@spir.example' },
  { id: 'admin', name: 'Omar Haddad', role: 'REGISTRY_ADMIN', email: 'admin@spir.example' },
  { id: 'qr-user', name: 'Daniel Mensah', role: 'QR_USER', email: 'qr@spir.example' },
  { id: 'inspector', name: 'Priya Nair', role: 'INSPECTOR', email: 'inspector@spir.example' },
  { id: 'auditor', name: 'Lena Fischer', role: 'AUDITOR', email: 'auditor@spir.example' },
] as const;

export interface SeedReport { suppliers: number; products: number; records: number; versions: number; documents: number; qrTokens: number; newAttributes: string[] }

export interface SeedFile { name: string; text: string }

export async function loadSeed(
  db: Db, storage: FileStorage, qrKey: Buffer, csv: string | SeedFile[], opts: { documentsDir?: string; log?: (m: string) => void } = {},
): Promise<SeedReport> {
  const log = opts.log ?? (() => {});
  const files: SeedFile[] = typeof csv === 'string' ? [{ name: 'seed.csv', text: csv }] : csv;
  // Rows from several files are loaded as one data set (e.g. public demo + private seed/local/*.csv).
  const rows: (Record<string, string> & { __file?: string; __line?: string })[] = files.flatMap((f) =>
    (parse(f.text, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[])
      .map((r, i) => ({ ...r, __file: f.name, __line: String(i + 2) })));
  if (!rows.length) throw new Error('Seed CSV has no rows.');
  const report: SeedReport = { suppliers: 0, products: 0, records: 0, versions: 0, documents: 0, qrTokens: 0, newAttributes: [] };

  return db.tx(async (tx) => {
    const existing = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM spir.supplier');
    if (existing!.n > 0) throw new Error('Database already contains suppliers. Run `npm run db:reset` to wipe and reseed.');

    // Register any new CSV columns as governed attributes (spec 7.1: attributes are metadata, not code).
    let defs = await loadDefinitions(tx);
    const known = new Set(defs.map((d) => d.attribute_key));
    const retired = new Set((await tx.query<{ attribute_key: string }>(
      `SELECT attribute_key FROM spir.attribute_definition GROUP BY attribute_key HAVING bool_and(status = 'DEPRECATED')`)).map((r) => r.attribute_key));
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !c.startsWith('__'));
    for (const col of columns) {
      if (retired.has(col)) throw new Error(`Column "${col}" is a retired attribute. Remove it from the CSV (see seed/README.md for the current columns).`);
      if (CORE.has(col) || known.has(col)) continue;
      await tx.query(
        `INSERT INTO spir.attribute_definition (attribute_key, version, label, scope, data_type, label_checked, display_order, description)
         VALUES ($1, 1, $2, 'TRACEABILITY', 'TEXT', false, 200, 'Registered automatically from the seed CSV')`,
        [col, col.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())]);
      report.newAttributes.push(col);
    }
    if (report.newAttributes.length) defs = await loadDefinitions(tx);
    const scopeOf = new Map(defs.filter((d) => (d.comparison_rule.source ?? 'attr') === 'attr').map((d) => [d.attribute_key, d.scope]));

    for (const u of DEMO_COMPANY_USERS) {
      await tx.query('INSERT INTO spir.app_user (id, display_name, role, email) VALUES ($1,$2,$3,$4)', [u.id, u.name, u.role, u.email]);
    }

    const suppliers = new Map<string, { id: string; code: string; userId: string }>();
    const products = new Map<string, { id: string; code: string; category: string; supplierId: string }>();
    const records = new Map<string, { id: string; code: string; versionNo: number; supplierId: string }>();
    const reviewer = { userId: 'reviewer', displayName: 'Aisha Rahman', role: 'COMPANY_REVIEWER' as const, supplierId: null };

    for (const row of rows) {
      const line = `${row.__file} row ${row.__line}`;
      for (const req of ['supplier_ref', 'supplier_name', 'product_ref', 'part_number', 'part_description', 'category', 'traceability_ref']) {
        if (!row[req]) throw new Error(`${line}: column "${req}" is required.`);
      }

      // Supplier + one demo contributor login per supplier.
      let sup = suppliers.get(row.supplier_ref);
      if (!sup) {
        const s = (await tx.one<{ id: string; supplier_code: string }>(
          'INSERT INTO spir.supplier (external_ref, legal_name, country_code) VALUES ($1,$2,$3) RETURNING id, supplier_code',
          [row.supplier_ref, row.supplier_name, (row.supplier_country || '').toUpperCase().slice(0, 2) || null]))!;
        const userId = `supplier-${row.supplier_ref.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        await tx.query(`INSERT INTO spir.app_user (id, display_name, role, supplier_id, email) VALUES ($1,$2,'SUPPLIER_CONTRIBUTOR',$3,$4)`,
          [userId, `${row.supplier_name} contributor`, s.id, `${userId}@supplier.example`]);
        sup = { id: s.id, code: s.supplier_code, userId };
        suppliers.set(row.supplier_ref, sup);
        report.suppliers++;
        log(`supplier ${s.supplier_code}  ${row.supplier_name}`);
      }

      const attrsFor = (scope: 'PRODUCT' | 'TRACEABILITY') => Object.fromEntries(
        Object.entries(row).filter(([k, v]) => !CORE.has(k) && !k.startsWith('__') && v !== '' && scopeOf.get(k) === scope));

      // Product (first row for a product_ref defines it).
      let prod = products.get(row.product_ref);
      if (!prod) {
        const cat = await tx.one('SELECT code FROM spir.product_category WHERE code = $1', [row.category]);
        if (!cat) throw new Error(`${line}: unknown category "${row.category}". Add it in a migration first.`);
        const p = (await tx.one<{ id: string; product_code: string }>(
          'INSERT INTO spir.product (supplier_id, category_code) VALUES ($1,$2) RETURNING id, product_code', [sup.id, row.category]))!;
        await tx.query(`INSERT INTO spir.product_identifier (product_id, id_type, issuer, value) VALUES ($1,'COMPANY_PART_NUMBER',$2,$3)`,
          [p.id, sup.code, row.part_number]);
        if (row.supplier_part_number) {
          await tx.query(`INSERT INTO spir.product_identifier (product_id, id_type, issuer, value) VALUES ($1,'SUPPLIER_PART_NUMBER',$2,$3)`,
            [p.id, sup.code, row.supplier_part_number]);
        }
        const ps = status(row.product_status, line);
        const v = (await tx.one<{ id: string }>(
          `INSERT INTO spir.product_version (product_id, version_no, status, product_name, description, attributes, source, created_by,
                                             submitted_at, reviewed_by, reviewed_at)
           VALUES ($1, 1, $2, $3, $4, $5, 'SEED', $6, CASE WHEN $2 <> 'DRAFT' THEN now() END,
                   CASE WHEN $2 IN ('APPROVED','REJECTED') THEN 'reviewer' END, CASE WHEN $2 IN ('APPROVED','REJECTED') THEN now() END)
           RETURNING id`,
          [p.id, ps, row.part_description, null, JSON.stringify(attrsFor('PRODUCT')), sup.userId]))!;
        if (ps === 'APPROVED') await tx.query('UPDATE spir.product SET current_approved_version_id = $2 WHERE id = $1', [p.id, v.id]);
        prod = { id: p.id, code: p.product_code, category: row.category, supplierId: sup.id };
        products.set(row.product_ref, prod);
        report.products++;
        log(`  product ${p.product_code}  ${row.part_number} ${row.part_description} [${ps}]`);
      }

      // Traceability record; repeated refs become later versions.
      let rec = records.get(row.traceability_ref);
      if (!rec) {
        const t = (await tx.one<{ id: string; traceability_code: string }>(
          'INSERT INTO spir.traceability_record (product_id, external_ref) VALUES ($1,$2) RETURNING id, traceability_code',
          [prod.id, row.traceability_ref]))!;
        rec = { id: t.id, code: t.traceability_code, versionNo: 0, supplierId: sup.id };
        records.set(row.traceability_ref, rec);
        report.records++;
      }
      const st = status(row.approval_status, line);
      const versionNo = ++rec.versionNo;
      if (st === 'APPROVED') {
        await tx.query(`UPDATE spir.traceability_version SET status = 'SUPERSEDED' WHERE traceability_id = $1 AND status = 'APPROVED'`, [rec.id]);
      }
      const tv = (await tx.one<{ id: string }>(
        `INSERT INTO spir.traceability_version (traceability_id, version_no, status, attributes, source, created_by,
                                                submitted_at, reviewed_by, reviewed_at, review_comment)
         VALUES ($1,$2,$3,$4,'SEED',$5, CASE WHEN $3 <> 'DRAFT' THEN now() END,
                 CASE WHEN $3 IN ('APPROVED','REJECTED') THEN 'reviewer' END, CASE WHEN $3 IN ('APPROVED','REJECTED') THEN now() END, $6)
         RETURNING id`,
        [rec.id, versionNo, st, JSON.stringify(attrsFor('TRACEABILITY')), sup.userId, row.review_comment || null]))!;
      await setAssociations(tx, tv.id, sup.id, { heats: split(row.heat_numbers), batches: split(row.batch_numbers), serials: split(row.serial_numbers) });
      if (st === 'APPROVED') await tx.query('UPDATE spir.traceability_record SET current_approved_version_id = $2 WHERE id = $1', [rec.id, tv.id]);
      report.versions++;

      for (const entry of split(row.documents)) {
        const [rawType, ...rest] = entry.split(':');
        const fileName = rest.join(':').trim();
        const docType = rawType.trim().toUpperCase();
        if (!fileName) throw new Error(`${line}: document "${entry}" must look like TYPE:filename.pdf`);
        const local = opts.documentsDir ? path.join(opts.documentsDir, fileName) : '';
        const bytes = local && existsSync(local)
          ? new Uint8Array(readFileSync(local))
          : simplePdf(`${docType} - ${fileName}`, [
            `Supplier: ${row.supplier_name}`,
            `Part number: ${row.part_number}${row.design_revision ? ` Rev ${row.design_revision}` : ''}   ${row.part_description}`,
            `Material: ${row.material || '-'}`,
            `PO ${row.purchase_order_number ?? '-'} line ${row.po_line_number ?? '-'}   Quantity ${row.quantity ?? '-'}`,
            `Heat(s): ${split(row.heat_numbers).join(', ')}   Pattern: ${row.pattern_number ?? '-'}   RT: ${row.radiographic_test_number || '-'}`,
            `Supplier record: ${row.traceability_ref}   SPIR record: ${rec.code} v${versionNo}`,
          ]);
        const media = fileName.toLowerCase().endsWith('.png') ? 'image/png' : fileName.toLowerCase().match(/\.jpe?g$/) ? 'image/jpeg' : 'application/pdf';
        const revision = /rev([A-Z])\./i.exec(fileName)?.[1]?.toUpperCase() ?? 'A';
        await storeDocument(tx, storage, { recordId: rec.id, recordCode: rec.code, versionId: tv.id, docType, revision, fileName, mediaType: media, bytes, actor: sup.userId });
        report.documents++;
      }
      log(`    record ${rec.code} v${versionNo} [${st}] heats=${row.heat_numbers}`);
    }

    // Every published record gets an active QR token.
    for (const rec of records.values()) {
      const pub = await tx.one('SELECT current_approved_version_id FROM spir.traceability_record WHERE id = $1', [rec.id]);
      if (pub?.current_approved_version_id) { await issueToken(tx, qrKey, rec.id, reviewer, 'Seed import'); report.qrTokens++; }
    }
    await audit(tx, null, 'SEED_IMPORT', 'system', null, { ...report });
    return report;
  });
}
