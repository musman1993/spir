// Label capture, OCR-assisted validation matrix, human review and discrepancies (spec 11A).
// OCR output is untrusted evidence: nothing in this module ever writes to product or
// traceability master data (FR-OCR-013).
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { absoluteUrl, type AppEnv } from '../app.js';
import type { Db } from '../providers/db.js';
import type { Principal } from '../providers/auth.js';
import { principal, requireRole } from '../lib/authz.js';
import { ApiError, conflict, invalid, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { sha256Hex } from '../lib/crypto.js';
import { extractFields, type Candidate, type Extraction, type LabelProfileConfig } from '../domain/extract.js';
import { COMPARE_RULE_VERSION, OVERALL_POLICY_VERSION, compareField, overallStatus, type FieldDefinition, type FieldResult, type MatrixRow } from '../domain/compare.js';
import { normalize } from '../domain/normalize.js';
import { loadDefinitions, type AttributeDefinition } from './attributes.js';
import { associations } from './traceability.js';

export const RESOLVER_VERSION = 'resolver-v2';
export const RULE_VERSION = `${COMPARE_RULE_VERSION}/${OVERALL_POLICY_VERSION}/${RESOLVER_VERSION}`;
const VALIDATION_ROLES = ['INSPECTOR', 'COMPANY_REVIEWER', 'REGISTRY_ADMIN'] as const;

const payloadSchema = z.object({
  labelProfileKey: z.string().default('RECEIVING_LABELS'),
  traceabilityCode: z.string().optional().nullable(),
  ocr: z.object({
    engine: z.string().optional(), engineVersion: z.string().optional(),
    text: z.string().max(20000).default(''), confidence: z.number().optional().nullable(),
    lines: z.array(z.object({
      text: z.string(), confidence: z.number().optional(),
      bbox: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional(),
      words: z.array(z.object({ text: z.string(), confidence: z.number().optional(),
        bbox: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional() })).optional(),
    })).max(500).optional(),
  }).default({ text: '' }),
  barcodes: z.array(z.object({ format: z.string(), text: z.string().max(2000) })).max(20).default([]),
  device: z.record(z.any()).default({}),
});

async function loadProfile(db: Db, key: string) {
  const row = await db.one<{ profile_key: string; version: number; config: LabelProfileConfig }>(
    `SELECT profile_key, version, config FROM spir.label_profile WHERE profile_key = $1 AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1`, [key]);
  if (!row) throw invalid(`Unknown label profile ${key}.`);
  return row;
}

interface ResolveCandidate { traceabilityId: string; code: string; productCode: string; productName: string; matchedOn: string[] }
interface Resolution {
  status: 'RESOLVED' | 'AMBIGUOUS' | 'UNRESOLVED';
  method: 'QR_TOKEN' | 'IDENTIFIERS' | 'MANUAL_SELECTION' | 'NONE';
  traceabilityId: string | null;
  candidates: ResolveCandidate[];
  note: string;
}

/**
 * resolver-v2: deterministic identifiers only - never names or descriptions (FR-OCR-008).
 *   1. A decoded SPIR QR token wins.
 *   2. Otherwise a record is RESOLVED when exactly one approved record matches
 *      part number AND (PO or heat), or PO AND (heat or PO line). The PO line also breaks ties.
 *   3. Anything weaker or tied is AMBIGUOUS and the operator must choose.
 */
async function resolveRecord(db: Db, ex: Extraction, manualCode?: string | null): Promise<Resolution> {
  if (manualCode) {
    const r = await db.one<{ id: string }>(
      `SELECT id FROM spir.traceability_record WHERE traceability_code = $1 AND current_approved_version_id IS NOT NULL`, [manualCode]);
    if (!r) throw invalid(`${manualCode} is not a published traceability record.`);
    return { status: 'RESOLVED', method: 'MANUAL_SELECTION', traceabilityId: r.id, candidates: [], note: 'Selected by operator.' };
  }
  for (const token of ex.qrTokens) {
    const r = await db.one<{ traceability_id: string; status: string }>(
      `SELECT q.traceability_id, q.status FROM spir.qr_token q JOIN spir.traceability_record t ON t.id = q.traceability_id
        WHERE q.token_hash = $1 AND t.current_approved_version_id IS NOT NULL`, [sha256Hex(token)]);
    if (r?.status === 'ACTIVE') return { status: 'RESOLVED', method: 'QR_TOKEN', traceabilityId: r.traceability_id, candidates: [], note: 'Resolved from the SPIR QR code on the label.' };
  }
  const read = (k: string, method: 'identifier' | 'integer') => {
    const raw = ex.candidates[k]?.raw;
    if (!raw) return null;
    const n = normalize(raw, { method }, []);
    return n.ok ? n.value : null;
  };
  const part = read('part_number', 'identifier');
  const po = read('purchase_order_number', 'identifier');
  const line = read('po_line_number', 'integer');
  const heat = read('heat_number', 'identifier');
  if (!part && !po && !heat) {
    return { status: 'UNRESOLVED', method: 'NONE', traceabilityId: null, candidates: [], note: 'No part number, PO or heat number could be read from the label.' };
  }
  const rows = await db.query<{ id: string; code: string; product_code: string; product_name: string; part: string | null; po: string | null; line: string | null; heats: string[] }>(
    `SELECT t.id, t.traceability_code AS code, p.product_code, pv.product_name,
            (SELECT upper(value) FROM spir.product_identifier i WHERE i.product_id = p.id AND i.id_type = 'COMPANY_PART_NUMBER' LIMIT 1) AS part,
            upper(tv.attributes->>'purchase_order_number') AS po,
            tv.attributes->>'po_line_number' AS line,
            coalesce((SELECT array_agg(upper(h.heat_number)) FROM spir.traceability_version_heat x JOIN spir.heat h ON h.id = x.heat_id WHERE x.version_id = tv.id), '{}') AS heats
       FROM spir.traceability_record t
       JOIN spir.traceability_version tv ON tv.id = t.current_approved_version_id
       JOIN spir.product p ON p.id = t.product_id
       JOIN spir.product_version pv ON pv.id = p.current_approved_version_id`,
  );
  const scored = rows.map((r) => {
    const matchedOn: string[] = [];
    if (part && r.part === part) matchedOn.push('part_number');
    if (po && r.po === po) matchedOn.push('purchase_order_number');
    if (po && r.po === po && line && r.line != null && String(Number(r.line)) === line) matchedOn.push('po_line_number');
    if (heat && r.heats.includes(heat)) matchedOn.push('heat_number');
    const has = (k: string) => matchedOn.includes(k);
    const strong = (has('part_number') && (has('purchase_order_number') || has('heat_number')))
      || (has('purchase_order_number') && (has('heat_number') || has('po_line_number')));
    return { r, matchedOn, strong };
  }).filter((s) => s.matchedOn.length);
  const toCand = (s: (typeof scored)[number]): ResolveCandidate => ({
    traceabilityId: s.r.id, code: s.r.code, productCode: s.r.product_code, productName: s.r.product_name, matchedOn: s.matchedOn,
  });
  let strong = scored.filter((s) => s.strong);
  if (strong.length > 1 && strong.some((s) => s.matchedOn.includes('po_line_number'))) strong = strong.filter((s) => s.matchedOn.includes('po_line_number'));
  if (strong.length > 1) {
    const best = Math.max(...strong.map((s) => s.matchedOn.length));
    if (strong.filter((s) => s.matchedOn.length === best).length === 1) strong = strong.filter((s) => s.matchedOn.length === best);
  }
  if (strong.length === 1) {
    return { status: 'RESOLVED', method: 'IDENTIFIERS', traceabilityId: strong[0].r.id, candidates: [toCand(strong[0])], note: `Matched on ${strong[0].matchedOn.map((m) => m.replace(/_/g, ' ')).join(' + ')}.` };
  }
  const list = (strong.length ? strong : scored).sort((a, b) => b.matchedOn.length - a.matchedOn.length).slice(0, 20).map(toCand);
  if (!list.length) return { status: 'UNRESOLVED', method: 'NONE', traceabilityId: null, candidates: [], note: 'No published record matches the part number, PO or heat read from the label.' };
  return {
    status: 'AMBIGUOUS', method: 'NONE', traceabilityId: null, candidates: list,
    note: strong.length > 1 ? 'More than one record matches - choose the correct one.' : 'Only a partial match was found - confirm the record.',
  };
}

const toFieldDef = (d: AttributeDefinition): FieldDefinition => ({
  attributeKey: d.attribute_key, label: d.label, version: d.version, critical: d.critical, rule: d.comparison_rule,
});

/** Pins the current approved product + traceability versions and returns the expected values. */
async function approvedValues(db: Db, traceabilityId: string, defs: AttributeDefinition[]) {
  const t = (await db.one<{ trc_version: string; product_version: string; product_id: string; supplier_name: string }>(
    `SELECT t.current_approved_version_id AS trc_version, p.current_approved_version_id AS product_version, p.id AS product_id, s.legal_name AS supplier_name
       FROM spir.traceability_record t JOIN spir.product p ON p.id = t.product_id JOIN spir.supplier s ON s.id = p.supplier_id
      WHERE t.id = $1`, [traceabilityId]))!;
  const [pv, tv, ids, assoc] = await Promise.all([
    db.one<{ attributes: Record<string, string>; product_name: string }>('SELECT attributes, product_name FROM spir.product_version WHERE id = $1', [t.product_version]),
    db.one<{ attributes: Record<string, string> }>('SELECT attributes FROM spir.traceability_version WHERE id = $1', [t.trc_version]),
    db.query<{ id_type: string; value: string }>('SELECT id_type, value FROM spir.product_identifier WHERE product_id = $1', [t.product_id]),
    associations(db, t.trc_version),
  ]);
  const values: Record<string, string | string[] | null> = {};
  for (const d of defs) {
    const src = d.comparison_rule.source ?? 'attr';
    if (src.startsWith('identifier:')) values[d.attribute_key] = ids.filter((i) => i.id_type === src.slice(11)).map((i) => i.value);
    else if (src === 'heats') values[d.attribute_key] = assoc.heats;
    else if (src === 'batches') values[d.attribute_key] = assoc.batches;
    else if (src === 'serials') values[d.attribute_key] = assoc.serials;
    else if (src === 'supplier') values[d.attribute_key] = t.supplier_name;
    else if (src === 'product_name') values[d.attribute_key] = pv?.product_name ?? null;
    else values[d.attribute_key] = (d.scope === 'PRODUCT' ? pv?.attributes : tv?.attributes)?.[d.attribute_key] ?? null;
  }
  return { values, productVersionId: t.product_version, traceabilityVersionId: t.trc_version };
}

function buildMatrix(defs: AttributeDefinition[], profile: LabelProfileConfig, ex: Extraction, values: Record<string, any>): MatrixRow[] {
  return defs.filter((d) => d.label_checked).map((d) => {
    const fp = profile.fields[d.attribute_key];
    const threshold = fp?.confidenceThreshold ?? profile.defaultConfidenceThreshold;
    if (!fp) {
      return {
        attributeKey: d.attribute_key, attributeLabel: d.label, attributeVersion: d.version, critical: d.critical,
        approvedValue: Array.isArray(values[d.attribute_key]) ? values[d.attribute_key].join(', ') : values[d.attribute_key] ?? null,
        observedRaw: null, observedNormalized: null, confidence: null, threshold, extractionMethod: 'NONE', bbox: null,
        result: 'NOT_CHECKED' as FieldResult, rule: { ...d.comparison_rule, version: COMPARE_RULE_VERSION, threshold },
        note: 'Field is not configured on this label profile.',
      };
    }
    return compareField(toFieldDef(d), values[d.attribute_key], ex.candidates[d.attribute_key], { threshold, dateFormats: profile.dateFormats });
  });
}

async function writeRows(db: Db, runId: string, rows: MatrixRow[]) {
  await db.query('DELETE FROM spir.validation_field_result WHERE run_id = $1', [runId]);
  for (const r of rows) {
    await db.query(
      `INSERT INTO spir.validation_field_result
         (run_id, attribute_key, attribute_label, attribute_version, critical, approved_value, observed_raw, observed_normalized,
          confidence, extraction_method, bbox, result, rule, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [runId, r.attributeKey, r.attributeLabel, r.attributeVersion, r.critical, r.approvedValue, r.observedRaw, r.observedNormalized,
        r.confidence, r.extractionMethod, r.bbox ? JSON.stringify(r.bbox) : null, r.result, JSON.stringify(r.rule), r.note],
    );
  }
}

async function recomputeOverall(db: Db, runId: string) {
  const run = (await db.one<{ traceability_id: string | null }>('SELECT traceability_id FROM spir.validation_run WHERE id = $1', [runId]))!;
  const rows = await db.query<{ critical: boolean; result: FieldResult; corrected_result: FieldResult | null }>(
    'SELECT critical, result, corrected_result FROM spir.validation_field_result WHERE run_id = $1', [runId]);
  const status = overallStatus(rows.map((r) => ({ critical: r.critical, result: r.corrected_result ?? r.result })), !!run.traceability_id);
  await db.query('UPDATE spir.validation_run SET overall_status = $2 WHERE id = $1', [runId, status]);
  return status;
}

async function runDetail(db: Db, storage: any, c: any, code: string) {
  const run = await db.one(
    `SELECT r.*, t.traceability_code, p.product_code, pv.product_name, pv.version_no AS product_version_no, tv.version_no AS traceability_version_no,
            u.display_name AS operator_name
       FROM spir.validation_run r
       LEFT JOIN spir.traceability_record t ON t.id = r.traceability_id
       LEFT JOIN spir.product p ON p.id = t.product_id
       LEFT JOIN spir.product_version pv ON pv.id = r.pinned_product_version_id
       LEFT JOIN spir.traceability_version tv ON tv.id = r.pinned_traceability_version_id
       LEFT JOIN spir.app_user u ON u.id = r.operator_id
      WHERE r.run_code = $1`, [code]);
  if (!run) throw notFound('Validation run');
  const [rows, discrepancies] = await Promise.all([
    db.query(`SELECT f.*, u.display_name AS reviewer_name FROM spir.validation_field_result f LEFT JOIN spir.app_user u ON u.id = f.reviewed_by
               WHERE f.run_id = $1 ORDER BY f.critical DESC, f.attribute_key`, [run.id]),
    db.query(`SELECT discrepancy_code AS "code", attribute_key AS "attributeKey", severity, classification, description, status, created_by AS "createdBy", created_at AS "createdAt"
                FROM spir.discrepancy WHERE run_id = $1 ORDER BY created_at`, [run.id]),
  ]);
  const imageUrl = run.image_storage_key ? absoluteUrl(c, await storage.signedUrl(run.image_storage_key, 600)) : null;
  return {
    code: run.run_code,
    overallStatus: run.overall_status,
    createdAt: run.created_at,
    finalizedAt: run.finalized_at,
    operator: run.operator_name,
    record: run.traceability_code ? {
      traceabilityCode: run.traceability_code, productCode: run.product_code, productName: run.product_name,
      pinnedProductVersion: run.product_version_no, pinnedTraceabilityVersion: run.traceability_version_no,
    } : null,
    resolution: { method: run.resolution_method, ...(run.resolution_detail ?? {}) },
    labelProfile: { key: run.label_profile_key, version: run.label_profile_version },
    ocr: { engine: run.ocr_engine, engineVersion: run.ocr_engine_version, meanConfidence: run.ocr_mean_confidence != null ? Number(run.ocr_mean_confidence) : null, text: run.raw_ocr_text },
    barcodes: run.barcodes,
    device: run.device_info,
    ruleVersion: run.rule_version,
    image: imageUrl ? { url: imageUrl, sha256: run.image_sha256 } : null,
    extraction: run.extraction,
    fields: rows.map((f: any) => ({
      attributeKey: f.attribute_key, label: f.attribute_label, attributeVersion: f.attribute_version, critical: f.critical,
      approvedValue: f.approved_value, observedRaw: f.observed_raw, observedNormalized: f.observed_normalized,
      confidence: f.confidence != null ? Number(f.confidence) : null, extractionMethod: f.extraction_method, bbox: f.bbox,
      result: f.result, effectiveResult: f.corrected_result ?? f.result, rule: f.rule, note: f.note,
      review: f.disposition ? { disposition: f.disposition, correctedValue: f.corrected_value, correctedResult: f.corrected_result,
        note: f.disposition_note, reviewer: f.reviewer_name, at: f.reviewed_at } : null,
    })),
    discrepancies,
  };
}

async function evaluateRun(db: Db, runId: string, resolution: Resolution, ex: Extraction, profile: LabelProfileConfig, actor: Principal, cid: string) {
  await db.query(
    `UPDATE spir.validation_run SET traceability_id = $2, resolution_method = $3, resolution_detail = $4 WHERE id = $1`,
    [runId, resolution.traceabilityId, resolution.method, JSON.stringify({ status: resolution.status, note: resolution.note, candidates: resolution.candidates })]);
  if (resolution.traceabilityId) {
    const defs = await loadDefinitions(db);
    const { values, productVersionId, traceabilityVersionId } = await approvedValues(db, resolution.traceabilityId, defs);
    await db.query('UPDATE spir.validation_run SET pinned_product_version_id = $2, pinned_traceability_version_id = $3 WHERE id = $1',
      [runId, productVersionId, traceabilityVersionId]);
    await writeRows(db, runId, buildMatrix(defs, profile, ex, values));
  }
  const status = await recomputeOverall(db, runId);
  await audit(db, actor, 'VALIDATION_EVALUATED', 'validation_run', runId,
    { resolution: resolution.status, method: resolution.method, overallStatus: status }, cid);
  return status;
}

const reviewSchema = z.object({
  action: z.enum(['ACCEPT', 'CORRECT', 'UNREADABLE', 'NOT_APPLICABLE']),
  value: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
});
const discrepancySchema = z.object({
  attributeKey: z.string().optional().nullable(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  classification: z.enum(['MISLABELLED_PRODUCT', 'REGISTRY_ERROR', 'WRONG_RECORD', 'OCR_ERROR', 'PROCESS_EXCEPTION', 'UNKNOWN']).default('UNKNOWN'),
  description: z.string().trim().min(3).max(2000),
});

export function validationRoutes() {
  const r = new Hono<AppEnv>();

  // Create a validation run from a captured label (multipart: image?, payload=JSON) or plain JSON.
  r.post('/validations', async (c) => {
    const p = requireRole(c, ...VALIDATION_ROLES);
    const { db, storage, config } = c.get('services');
    let raw: unknown;
    let image: File | null = null;
    if ((c.req.header('content-type') ?? '').includes('multipart/form-data')) {
      const form = await c.req.formData();
      raw = JSON.parse(String(form.get('payload') ?? '{}'));
      const f = form.get('image');
      image = f instanceof File ? f : null;
    } else {
      raw = await c.req.json();
    }
    const payload = payloadSchema.parse(raw);
    if (image && image.size > config.imageMaxBytes) throw new ApiError(413, 'FILE_TOO_LARGE', 'Label image is too large.');
    if (image && !['image/png', 'image/jpeg', 'image/webp'].includes(image.type)) throw new ApiError(415, 'UNSUPPORTED_FILE', 'Label image must be PNG, JPEG or WebP.');
    const profile = await loadProfile(db, payload.labelProfileKey);
    const ex = extractFields(payload.ocr, payload.barcodes, profile.config);

    // Evidence first: the original image is kept exactly as captured (spec 11A.13).
    let imageKey: string | null = null;
    let imageSha: string | null = null;
    if (image) {
      const bytes = new Uint8Array(await image.arrayBuffer());
      imageSha = sha256Hex(bytes);
      imageKey = `label-captures/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${image.type.split('/')[1]}`;
      await storage.put(imageKey, bytes, image.type);
    }
    const code = await db.tx(async (tx) => {
      const run = (await tx.one<{ id: string; run_code: string }>(
        `INSERT INTO spir.validation_run (label_profile_key, label_profile_version, ocr_engine, ocr_engine_version, rule_version,
            image_storage_key, image_sha256, raw_ocr_text, extraction, ocr_mean_confidence, barcodes, device_info, overall_status, operator_id, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'UNRESOLVED',$13,$14) RETURNING id, run_code`,
        [profile.profile_key, profile.version, payload.ocr.engine ?? 'unknown', payload.ocr.engineVersion ?? null, RULE_VERSION,
          imageKey, imageSha, payload.ocr.text, JSON.stringify(ex), ex.meanConfidence, JSON.stringify(payload.barcodes),
          JSON.stringify({ ...payload.device, userAgent: c.req.header('user-agent') ?? null }), p.userId, c.get('cid')]))!;
      await audit(tx, p, 'LABEL_CAPTURED', 'validation_run', run.id, { runCode: run.run_code, hasImage: !!imageKey, barcodes: payload.barcodes.length }, c.get('cid'));
      const resolution = await resolveRecord(tx, ex, payload.traceabilityCode);
      await evaluateRun(tx, run.id, resolution, ex, profile.config, p, c.get('cid'));
      return run.run_code;
    });
    return c.json(await runDetail(db, storage, c, code), 201);
  });

  r.get('/validations', async (c) => {
    requireRole(c, ...VALIDATION_ROLES, 'AUDITOR');
    const { db } = c.get('services');
    const rows = await db.query(
      `SELECT r.run_code AS "code", r.overall_status AS "overallStatus", r.created_at AS "createdAt", r.finalized_at AS "finalizedAt",
              t.traceability_code AS "traceabilityCode", p.product_code AS "productCode", u.display_name AS "operator",
              r.resolution_method AS "resolutionMethod",
              (SELECT count(*)::int FROM spir.discrepancy d WHERE d.run_id = r.id) AS "discrepancies"
         FROM spir.validation_run r
         LEFT JOIN spir.traceability_record t ON t.id = r.traceability_id
         LEFT JOIN spir.product p ON p.id = t.product_id
         LEFT JOIN spir.app_user u ON u.id = r.operator_id
        ORDER BY r.created_at DESC LIMIT 200`);
    return c.json({ runs: rows });
  });

  r.get('/validations/:code', async (c) => {
    requireRole(c, ...VALIDATION_ROLES, 'AUDITOR');
    const { db, storage } = c.get('services');
    return c.json(await runDetail(db, storage, c, c.req.param('code')));
  });

  const openRun = async (db: Db, code: string) => {
    const run = await db.one<{ id: string; finalized_at: string | null; traceability_id: string | null; extraction: Extraction; label_profile_key: string; label_profile_version: number }>(
      'SELECT * FROM spir.validation_run WHERE run_code = $1 FOR UPDATE', [code]);
    if (!run) throw notFound('Validation run');
    if (run.finalized_at) throw conflict('RUN_FINALIZED', 'This validation run is finalised and can no longer be changed.');
    return run;
  };

  // Operator picks the record when resolution was ambiguous / unresolved.
  r.post('/validations/:code/resolve', async (c) => {
    const p = requireRole(c, ...VALIDATION_ROLES);
    const { db, storage } = c.get('services');
    const { traceabilityCode } = z.object({ traceabilityCode: z.string().min(1) }).parse(await c.req.json());
    await db.tx(async (tx) => {
      const run = await openRun(tx, c.req.param('code'));
      if (run.traceability_id) throw conflict('ALREADY_RESOLVED', 'This run is already linked to a record. Start a new capture to validate against another record.');
      const profile = (await tx.one<{ config: LabelProfileConfig }>('SELECT config FROM spir.label_profile WHERE profile_key = $1 AND version = $2',
        [run.label_profile_key, run.label_profile_version]))!;
      const resolution = await resolveRecord(tx, run.extraction, traceabilityCode);
      await evaluateRun(tx, run.id, resolution, run.extraction, profile.config, p, c.get('cid'));
    });
    return c.json(await runDetail(db, storage, c, c.req.param('code')));
  });

  // Human review of one field. Raw OCR evidence is never overwritten (FR-OCR-012).
  r.post('/validations/:code/fields/:key/review', async (c) => {
    const p = requireRole(c, ...VALIDATION_ROLES);
    const { db, storage } = c.get('services');
    const body = reviewSchema.parse(await c.req.json());
    await db.tx(async (tx) => {
      const run = await openRun(tx, c.req.param('code'));
      if (!run.traceability_id) throw conflict('UNRESOLVED', 'Select the traceability record before reviewing fields.');
      const key = c.req.param('key');
      const f = await tx.one<any>('SELECT * FROM spir.validation_field_result WHERE run_id = $1 AND attribute_key = $2 FOR UPDATE', [run.id, key]);
      if (!f) throw notFound('Field');
      const profile = (await tx.one<{ config: LabelProfileConfig }>('SELECT config FROM spir.label_profile WHERE profile_key = $1 AND version = $2',
        [run.label_profile_key, run.label_profile_version]))!.config;
      let correctedValue: string | null = null;
      let correctedResult: FieldResult;
      let disposition: string;
      if (body.action === 'ACCEPT' || body.action === 'CORRECT') {
        if (body.action === 'CORRECT' && !body.value) throw invalid('Enter the value you can read on the label.');
        const reading = body.action === 'CORRECT' ? body.value! : f.observed_raw;
        if (!reading) throw invalid('Nothing was read for this field; use CORRECT with the value, or mark it UNREADABLE / NOT_APPLICABLE.');
        const defs = await loadDefinitions(tx);
        const d = defs.find((x) => x.attribute_key === key)!;
        const { values } = await approvedValues(tx, run.traceability_id, defs);
        const fp = profile.fields[key];
        const cand: Pick<Candidate, 'raw' | 'confidence' | 'method' | 'bbox' | 'alternatives'> = { raw: reading, confidence: 1, method: 'ALIAS_LINE', bbox: null, alternatives: [] };
        const row = compareField(toFieldDef(d), values[key], cand, {
          threshold: fp?.confidenceThreshold ?? profile.defaultConfidenceThreshold, dateFormats: profile.dateFormats, humanConfirmed: true,
        });
        correctedResult = row.result;
        correctedValue = body.action === 'CORRECT' ? body.value! : null;
        disposition = body.action === 'CORRECT' ? 'CORRECTED' : 'ACCEPTED';
      } else {
        if (body.action === 'NOT_APPLICABLE' && !body.note) throw invalid('Say why this field does not apply to this label.');
        correctedResult = body.action;
        disposition = body.action;
      }
      await tx.query(
        `UPDATE spir.validation_field_result SET corrected_value = $3, corrected_result = $4, disposition = $5, disposition_note = $6,
                reviewed_by = $7, reviewed_at = now() WHERE run_id = $1 AND attribute_key = $2`,
        [run.id, key, correctedValue, correctedResult, disposition, body.note ?? null, p.userId]);
      const status = await recomputeOverall(tx, run.id);
      await audit(tx, p, 'VALIDATION_FIELD_REVIEW', 'validation_run', run.id,
        { attributeKey: key, action: body.action, rawValue: f.observed_raw, correctedValue, from: f.corrected_result ?? f.result, to: correctedResult, overallStatus: status }, c.get('cid'));
    });
    return c.json(await runDetail(db, storage, c, c.req.param('code')));
  });

  r.post('/validations/:code/discrepancies', async (c) => {
    const p = requireRole(c, ...VALIDATION_ROLES);
    const { db, storage } = c.get('services');
    const body = discrepancySchema.parse(await c.req.json());
    await db.tx(async (tx) => {
      const run = await tx.one<{ id: string }>('SELECT id FROM spir.validation_run WHERE run_code = $1', [c.req.param('code')]);
      if (!run) throw notFound('Validation run');
      const d = await tx.one<{ discrepancy_code: string }>(
        `INSERT INTO spir.discrepancy (run_id, attribute_key, severity, classification, description, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING discrepancy_code`,
        [run.id, body.attributeKey ?? null, body.severity, body.classification, body.description, p.userId]);
      if (body.attributeKey) {
        await tx.query(`UPDATE spir.validation_field_result SET disposition = 'DISCREPANCY_RAISED', disposition_note = coalesce(disposition_note, $3),
                          reviewed_by = $4, reviewed_at = now() WHERE run_id = $1 AND attribute_key = $2`,
          [run.id, body.attributeKey, body.description, p.userId]);
      }
      await audit(tx, p, 'DISCREPANCY_RAISED', 'validation_run', run.id, { discrepancyCode: d!.discrepancy_code, ...body }, c.get('cid'));
    });
    return c.json(await runDetail(db, storage, c, c.req.param('code')), 201);
  });

  r.post('/validations/:code/finalize', async (c) => {
    const p = requireRole(c, ...VALIDATION_ROLES);
    const { db, storage } = c.get('services');
    await db.tx(async (tx) => {
      const run = await openRun(tx, c.req.param('code'));
      await tx.query('UPDATE spir.validation_run SET finalized_at = now(), finalized_by = $2 WHERE id = $1', [run.id, p.userId]);
      const status = (await tx.one<{ overall_status: string }>('SELECT overall_status FROM spir.validation_run WHERE id = $1', [run.id]))!.overall_status;
      await audit(tx, p, 'VALIDATION_FINALIZED', 'validation_run', run.id, { overallStatus: status }, c.get('cid'));
    });
    return c.json(await runDetail(db, storage, c, c.req.param('code')));
  });

  r.get('/discrepancies', async (c) => {
    principal(c);
    requireRole(c, ...VALIDATION_ROLES, 'AUDITOR');
    const rows = await c.get('services').db.query(
      `SELECT d.discrepancy_code AS "code", r.run_code AS "runCode", t.traceability_code AS "traceabilityCode", d.attribute_key AS "attributeKey",
              d.severity, d.classification, d.description, d.status, u.display_name AS "createdBy", d.created_at AS "createdAt"
         FROM spir.discrepancy d JOIN spir.validation_run r ON r.id = d.run_id
         LEFT JOIN spir.traceability_record t ON t.id = r.traceability_id
         LEFT JOIN spir.app_user u ON u.id = d.created_by
        ORDER BY d.created_at DESC`);
    return c.json({ discrepancies: rows });
  });

  return r;
}
