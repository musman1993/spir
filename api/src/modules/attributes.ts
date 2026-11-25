// Attribute registry access + submission validation (spec 7, FR-ATR-*).
import type { Db } from '../providers/db.js';
import { parseDate } from '../domain/normalize.js';
import type { ComparisonRule } from '../domain/normalize.js';

export interface AttributeDefinition {
  attribute_key: string;
  version: number;
  label: string;
  description: string | null;
  scope: 'PRODUCT' | 'TRACEABILITY';
  data_type: 'TEXT' | 'IDENTIFIER' | 'CODE' | 'DATE' | 'DECIMAL' | 'INTEGER' | 'COUNTRY';
  unit: string | null;
  category_code: string | null;
  required: boolean;
  allowed_values: string[] | null;
  comparison_rule: ComparisonRule;
  critical: boolean;
  label_checked: boolean;
  display_order: number;
  status: string;
}

/** Latest ACTIVE version of each attribute definition. */
export async function loadDefinitions(db: Db): Promise<AttributeDefinition[]> {
  return db.query<AttributeDefinition>(
    `SELECT DISTINCT ON (attribute_key) *
       FROM spir.attribute_definition
      WHERE status = 'ACTIVE'
      ORDER BY attribute_key, version DESC`,
  ).then((rows) => rows.sort((a, b) => a.display_order - b.display_order));
}

/** Attributes stored in JSONB (identifier / heat / batch / serial definitions live in their own tables). */
export function isJsonAttribute(d: AttributeDefinition) {
  const src = d.comparison_rule?.source ?? 'attr';
  return src === 'attr';
}

export function applicable(defs: AttributeDefinition[], scope: 'PRODUCT' | 'TRACEABILITY', category: string) {
  return defs.filter((d) => d.scope === scope && (!d.category_code || d.category_code === category) && isJsonAttribute(d));
}

export interface FieldError { field: string; message: string }

/**
 * Validates attribute values. Drafts may be incomplete (forSubmit=false); submission enforces
 * requiredness. Unknown keys are rejected so free-form data can't bypass governance.
 */
export function validateAttributes(
  defs: AttributeDefinition[],
  scope: 'PRODUCT' | 'TRACEABILITY',
  category: string,
  attrs: Record<string, unknown>,
  forSubmit: boolean,
): { clean: Record<string, string>; errors: FieldError[] } {
  const appl = applicable(defs, scope, category);
  const byKey = new Map(appl.map((d) => [d.attribute_key, d]));
  const errors: FieldError[] = [];
  const clean: Record<string, string> = {};

  for (const [k, v] of Object.entries(attrs ?? {})) {
    const d = byKey.get(k);
    if (!d) { errors.push({ field: k, message: `Unknown ${scope.toLowerCase()} attribute "${k}".` }); continue; }
    if (v == null || String(v).trim() === '') continue;
    const s = String(v).trim();
    switch (d.data_type) {
      case 'DATE':
        if (!parseDate(s, ['YYYY-MM-DD'])) errors.push({ field: k, message: `${d.label} must be a date (YYYY-MM-DD).` });
        break;
      case 'DECIMAL':
        if (!Number.isFinite(Number(s))) errors.push({ field: k, message: `${d.label} must be a number${d.unit ? ` in ${d.unit}` : ''}.` });
        break;
      case 'INTEGER':
        if (!/^-?\d+$/.test(s)) errors.push({ field: k, message: `${d.label} must be a whole number.` });
        break;
      case 'COUNTRY':
        if (!/^[A-Z]{2}$/.test(s)) errors.push({ field: k, message: `${d.label} must be a 2-letter ISO country code (e.g. AE).` });
        break;
      case 'CODE':
        if (d.allowed_values && !d.allowed_values.includes(s)) {
          errors.push({ field: k, message: `${d.label} must be one of: ${d.allowed_values.join(', ')}.` });
        }
        break;
    }
    clean[k] = s;
  }
  if (forSubmit) {
    for (const d of appl) {
      if (d.required && !clean[d.attribute_key]) errors.push({ field: d.attribute_key, message: `${d.label} is required.` });
    }
  }
  return { clean, errors };
}
