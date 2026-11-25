// Validation matrix (spec 11A.8): compare each extracted candidate with the pinned approved value.
// Pure function: no database, fully unit-tested. Versioned so stored runs remain interpretable.
import type { Candidate } from './extract.js';
import { type ComparisonRule, normalize, normalizeApproved, ocrSkeleton, valuesEqual } from './normalize.js';

export const COMPARE_RULE_VERSION = 'compare-v1';
export const OVERALL_POLICY_VERSION = 'overall-v1';

export type FieldResult =
  | 'MATCH' | 'MISMATCH' | 'LOW_CONFIDENCE' | 'UNREADABLE' | 'MISSING_ON_LABEL'
  | 'MISSING_IN_REGISTRY' | 'NOT_APPLICABLE' | 'NOT_CHECKED' | 'REVIEW_REQUIRED';

export type OverallStatus = 'PASS' | 'FAIL' | 'PASS_WITH_WARNINGS' | 'NEEDS_REVIEW' | 'UNRESOLVED' | 'PENDING_SYNCHRONIZATION';

export interface FieldDefinition {
  attributeKey: string;
  label: string;
  version: number;
  critical: boolean;
  rule: ComparisonRule;
}

export interface MatrixRow {
  attributeKey: string;
  attributeLabel: string;
  attributeVersion: number;
  critical: boolean;
  approvedValue: string | null;      // display form (multi-values joined with ", ")
  observedRaw: string | null;
  observedNormalized: string | null;
  confidence: number | null;
  threshold: number;
  extractionMethod: Candidate['method'];
  bbox: Candidate['bbox'];
  result: FieldResult;
  rule: ComparisonRule & { version: string; threshold: number };
  note: string;
}

export type ApprovedValue = string | string[] | null | undefined;

export function compareField(
  def: FieldDefinition,
  approved: ApprovedValue,
  cand: Pick<Candidate, 'raw' | 'confidence' | 'method' | 'bbox' | 'alternatives'>,
  opts: { threshold: number; dateFormats: string[]; humanConfirmed?: boolean },
): MatrixRow {
  const approvedList = (Array.isArray(approved) ? approved : approved != null && approved !== '' ? [approved] : [])
    .map(String).filter((v) => v.trim() !== '');
  const approvedNorm = approvedList.map((v) => normalizeApproved(v, def.rule));
  const base = {
    attributeKey: def.attributeKey,
    attributeLabel: def.label,
    attributeVersion: def.version,
    critical: def.critical,
    approvedValue: approvedList.length ? approvedList.join(', ') : null,
    observedRaw: cand.raw,
    observedNormalized: null as string | null,
    confidence: cand.confidence,
    threshold: opts.threshold,
    extractionMethod: cand.method,
    bbox: cand.bbox,
    rule: { ...def.rule, version: COMPARE_RULE_VERSION, threshold: opts.threshold },
  };
  const row = (result: FieldResult, note: string, observedNormalized: string | null = null): MatrixRow => ({
    ...base, observedNormalized, result, note,
  });

  const hasObserved = cand.raw != null && cand.raw.trim() !== '';
  if (!approvedList.length) {
    return hasObserved
      ? row('MISSING_IN_REGISTRY', 'Value read from label but the approved record has no value for this field.')
      : row('NOT_APPLICABLE', 'No approved value and nothing read from label.');
  }
  if (!hasObserved) return row('MISSING_ON_LABEL', 'Expected field was not found on the label.');

  const n = normalize(cand.raw!, def.rule, opts.dateFormats);
  if (!n.ok) return row('UNREADABLE', `Could not interpret the label value (${n.reason}).`);
  const observed = n.value;

  if (cand.alternatives?.length && !opts.humanConfirmed) {
    return row('REVIEW_REQUIRED', `Label shows more than one value for this field (${[cand.raw, ...cand.alternatives].join(' / ')}).`, observed);
  }

  const equal = approvedNorm.some((a) => valuesEqual(observed, a, def.rule));
  const lowConfidence = !opts.humanConfirmed && cand.confidence != null && cand.confidence < opts.threshold;
  const pct = cand.confidence != null ? `${Math.round(cand.confidence * 100)}%` : 'n/a';

  if (equal && !lowConfidence) {
    return row('MATCH', approvedList.length > 1 ? 'Matches one of the approved values.' : 'Matches the approved value.', observed);
  }
  if (equal && lowConfidence) {
    return row('LOW_CONFIDENCE', `Value agrees but OCR confidence ${pct} is below the ${Math.round(opts.threshold * 100)}% threshold; confirm against the image.`, observed);
  }
  // Not equal. Is it plausibly an OCR misread (8/B, 0/O, 1/I, 5/S ...)? Flag for review - never auto-match.
  if (!opts.humanConfirmed && (def.rule.method === 'identifier' || def.rule.method === 'code')) {
    const confusable = approvedNorm.find((a) => a !== observed && a.length === observed.length && ocrSkeleton(a) === ocrSkeleton(observed));
    if (confusable) {
      return row('REVIEW_REQUIRED', `Possible OCR character confusion: read "${observed}", approved "${confusable}". Inspect the image region before disposition.`, observed);
    }
  }
  if (lowConfidence) {
    return row('LOW_CONFIDENCE', `Read "${observed}" with low confidence (${pct}); does not match approved value. Manual review required.`, observed);
  }
  return row('MISMATCH', `${opts.humanConfirmed ? 'Operator-confirmed label value' : 'Label value'} "${observed}" does not match approved value${approvedList.length > 1 ? 's' : ''}.`, observed);
}

const NEEDS_REVIEW_RESULTS: FieldResult[] = ['LOW_CONFIDENCE', 'UNREADABLE', 'REVIEW_REQUIRED', 'MISSING_ON_LABEL'];

/**
 * overall-v1 (to be approved by quality owners, spec 11A.8):
 *  - any MISMATCH on a critical field          -> FAIL
 *  - any critical field LOW_CONFIDENCE / UNREADABLE / REVIEW_REQUIRED / MISSING_ON_LABEL -> NEEDS_REVIEW
 *  - no critical field actually MATCHed         -> NEEDS_REVIEW (nothing important was verified)
 *  - any non-critical field not MATCH (excluding NOT_APPLICABLE / NOT_CHECKED) -> PASS_WITH_WARNINGS
 *  - otherwise                                  -> PASS
 * A pile of passing fields can never hide a critical exception.
 */
export function overallStatus(rows: { critical: boolean; result: FieldResult }[], resolved: boolean): OverallStatus {
  if (!resolved) return 'UNRESOLVED';
  const critical = rows.filter((r) => r.critical);
  if (critical.some((r) => r.result === 'MISMATCH')) return 'FAIL';
  if (critical.some((r) => NEEDS_REVIEW_RESULTS.includes(r.result))) return 'NEEDS_REVIEW';
  if (!critical.some((r) => r.result === 'MATCH')) return 'NEEDS_REVIEW';
  const nonCritical = rows.filter((r) => !r.critical);
  if (nonCritical.some((r) => !['MATCH', 'NOT_APPLICABLE', 'NOT_CHECKED'].includes(r.result))) return 'PASS_WITH_WARNINGS';
  return 'PASS';
}
