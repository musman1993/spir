-- SPIR initial schema (PoC).
-- Spec references: section 6 (domain model), 7 (attributes), 9 (lifecycle),
-- 11A.11 (validation evidence), 13 (data architecture), 14.4 (QR tokens), 14.7 (audit).
--
-- Design rules applied here:
--   * Identity, ownership, lifecycle and relationships are relational columns + FKs.
--   * Category-specific attribute VALUES live in JSONB, governed by attribute_definition.
--   * Approved versions are never updated in place; changes create a new version row.
--   * Heat/batch links are many-to-many and belong to a specific traceability version.
--   * QR tokens are random, stored as a SHA-256 hash (lookup) + AES-GCM ciphertext (re-print).
--   * audit_event is append-only (UPDATE/DELETE blocked by trigger).

CREATE SCHEMA IF NOT EXISTS spir;
SET LOCAL search_path TO spir, public;

-- ---------- Readable business identifiers (SUP-000001, PRD-0000001, ...) ----------
CREATE SEQUENCE supplier_code_seq;
CREATE SEQUENCE product_code_seq;
CREATE SEQUENCE traceability_code_seq;
CREATE SEQUENCE document_code_seq;
CREATE SEQUENCE validation_code_seq;
CREATE SEQUENCE discrepancy_code_seq;

-- ---------- Suppliers and users ----------
CREATE TABLE supplier (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_code text NOT NULL UNIQUE DEFAULT 'SUP-' || lpad(nextval('spir.supplier_code_seq')::text, 6, '0'),
  external_ref  text UNIQUE,                       -- the code used in the seed CSV / supplier's own code
  legal_name    text NOT NULL,
  country_code  char(2),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','INACTIVE')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id           text PRIMARY KEY,                    -- demo login handle, e.g. 'reviewer'
  display_name text NOT NULL,
  email        text,
  role         text NOT NULL CHECK (role IN (
                 'SUPPLIER_CONTRIBUTOR','COMPANY_REVIEWER','REGISTRY_ADMIN',
                 'QR_USER','INSPECTOR','AUDITOR')),
  supplier_id  uuid REFERENCES supplier(id),
  active       boolean NOT NULL DEFAULT true,
  CHECK ((role = 'SUPPLIER_CONTRIBUTOR') = (supplier_id IS NOT NULL))
);

-- ---------- Categories and governed attribute metadata (section 7.2) ----------
CREATE TABLE product_category (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text
);

CREATE TABLE attribute_definition (
  attribute_key   text NOT NULL,                    -- stable key, never the display label
  version         int  NOT NULL DEFAULT 1,
  label           text NOT NULL,
  description     text,
  scope           text NOT NULL CHECK (scope IN ('PRODUCT','TRACEABILITY')),
  data_type       text NOT NULL CHECK (data_type IN ('TEXT','IDENTIFIER','CODE','DATE','DECIMAL','INTEGER','COUNTRY')),
  unit            text,
  category_code   text REFERENCES product_category(code),   -- NULL = applies to all categories
  required        boolean NOT NULL DEFAULT false,
  allowed_values  jsonb,                                    -- for CODE types
  comparison_rule jsonb NOT NULL DEFAULT '{"method":"exact"}', -- used by label validation
  critical        boolean NOT NULL DEFAULT false,           -- critical fields drive FAIL / NEEDS_REVIEW
  label_checked   boolean NOT NULL DEFAULT true,            -- included in sticker validation
  display_order   int NOT NULL DEFAULT 100,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DEPRECATED')),
  effective_from  date NOT NULL DEFAULT current_date,
  PRIMARY KEY (attribute_key, version)
);

-- ---------- Products ----------
CREATE TABLE product (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code  text NOT NULL UNIQUE DEFAULT 'PRD-' || lpad(nextval('spir.product_code_seq')::text, 7, '0'),
  supplier_id   uuid NOT NULL REFERENCES supplier(id),
  category_code text NOT NULL REFERENCES product_category(code),
  current_approved_version_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Supplier / manufacturer part numbers. Scoped by issuer so values never collide across suppliers.
CREATE TABLE product_identifier (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES product(id),
  id_type    text NOT NULL CHECK (id_type IN ('SUPPLIER_PART_NUMBER','MANUFACTURER_PART_NUMBER','OTHER')),
  issuer     text NOT NULL,           -- e.g. the supplier code
  value      text NOT NULL,           -- original value, punctuation and leading zeros preserved
  UNIQUE (issuer, id_type, value)
);

CREATE TABLE product_version (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       uuid NOT NULL REFERENCES product(id),
  version_no       int  NOT NULL,
  status           text NOT NULL CHECK (status IN ('DRAFT','PENDING','APPROVED','REJECTED','SUPERSEDED','WITHDRAWN')),
  product_name     text NOT NULL,
  description      text,
  attributes       jsonb NOT NULL DEFAULT '{}',
  attribute_schema_version int NOT NULL DEFAULT 1,
  source           text NOT NULL DEFAULT 'PORTAL' CHECK (source IN ('PORTAL','SEED','EDI')),
  created_by       text REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  submitted_at     timestamptz,
  reviewed_by      text REFERENCES app_user(id),
  reviewed_at      timestamptz,
  review_comment   text,
  UNIQUE (product_id, version_no)
);
ALTER TABLE product ADD CONSTRAINT product_current_version_fk
  FOREIGN KEY (current_approved_version_id) REFERENCES product_version(id);
-- At most one APPROVED and one open (DRAFT/PENDING) version per product.
CREATE UNIQUE INDEX product_one_approved ON product_version(product_id) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX product_one_open     ON product_version(product_id) WHERE status IN ('DRAFT','PENDING');
CREATE INDEX product_version_attrs_gin ON product_version USING gin (attributes);

-- ---------- Manufacturing traceability ----------
CREATE TABLE heat (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES supplier(id),
  heat_number text NOT NULL,
  UNIQUE (supplier_id, heat_number)        -- uniqueness scope = supplier (spec 6.2)
);

CREATE TABLE batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id  uuid NOT NULL REFERENCES supplier(id),
  batch_number text NOT NULL,
  UNIQUE (supplier_id, batch_number)
);

-- Which heats fed which batches (spec 6.4). Optional; recorded when the supplier provides it.
CREATE TABLE batch_heat (
  batch_id uuid NOT NULL REFERENCES batch(id),
  heat_id  uuid NOT NULL REFERENCES heat(id),
  provenance text NOT NULL DEFAULT 'SUPPLIER_ASSERTED',
  PRIMARY KEY (batch_id, heat_id)
);

CREATE TABLE traceability_record (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  traceability_code text NOT NULL UNIQUE DEFAULT 'TRC-' || lpad(nextval('spir.traceability_code_seq')::text, 7, '0'),
  product_id        uuid NOT NULL REFERENCES product(id),   -- exactly one product (FR-TRC-002)
  external_ref      text,                                     -- supplier's own record code
  current_approved_version_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE traceability_version (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  traceability_id  uuid NOT NULL REFERENCES traceability_record(id),
  version_no       int  NOT NULL,
  status           text NOT NULL CHECK (status IN ('DRAFT','PENDING','APPROVED','REJECTED','SUPERSEDED','WITHDRAWN')),
  attributes       jsonb NOT NULL DEFAULT '{}',
  attribute_schema_version int NOT NULL DEFAULT 1,
  source           text NOT NULL DEFAULT 'PORTAL' CHECK (source IN ('PORTAL','SEED','EDI')),
  created_by       text REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  submitted_at     timestamptz,
  reviewed_by      text REFERENCES app_user(id),
  reviewed_at      timestamptz,
  review_comment   text,
  UNIQUE (traceability_id, version_no)
);
ALTER TABLE traceability_record ADD CONSTRAINT trc_current_version_fk
  FOREIGN KEY (current_approved_version_id) REFERENCES traceability_version(id);
CREATE UNIQUE INDEX trc_one_approved ON traceability_version(traceability_id) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX trc_one_open     ON traceability_version(traceability_id) WHERE status IN ('DRAFT','PENDING');
CREATE INDEX trc_version_attrs_gin ON traceability_version USING gin (attributes);

-- Associations are versioned: each traceability version carries its own heat/batch/serial set.
CREATE TABLE traceability_version_heat (
  version_id uuid NOT NULL REFERENCES traceability_version(id),
  heat_id    uuid NOT NULL REFERENCES heat(id),
  PRIMARY KEY (version_id, heat_id)
);
CREATE TABLE traceability_version_batch (
  version_id uuid NOT NULL REFERENCES traceability_version(id),
  batch_id   uuid NOT NULL REFERENCES batch(id),
  PRIMARY KEY (version_id, batch_id)
);
CREATE TABLE traceability_version_serial (
  version_id    uuid NOT NULL REFERENCES traceability_version(id),
  serial_number text NOT NULL,
  PRIMARY KEY (version_id, serial_number)
);

-- ---------- Technical evidence (section 8.5) ----------
CREATE TABLE document (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_code   text NOT NULL UNIQUE DEFAULT 'DOC-' || lpad(nextval('spir.document_code_seq')::text, 6, '0'),
  traceability_id uuid NOT NULL REFERENCES traceability_record(id),
  version_id      uuid NOT NULL REFERENCES traceability_version(id),  -- the submission that supplied it
  doc_type        text NOT NULL CHECK (doc_type IN ('MTC','COC','INSPECTION_REPORT','DRAWING','OTHER')),
  revision        text NOT NULL DEFAULT 'A',
  file_name       text NOT NULL,
  media_type      text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          text NOT NULL,
  storage_key     text NOT NULL UNIQUE,
  uploaded_by     text REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- QR tokens (section 14.4) ----------
CREATE TABLE qr_token (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  traceability_id  uuid NOT NULL REFERENCES traceability_record(id),
  token_hash       text NOT NULL UNIQUE,     -- sha256(token) hex, used for lookup
  token_ciphertext text NOT NULL,            -- AES-256-GCM(token), only for authorised label printing
  token_hint       text NOT NULL,            -- last 4 chars, for humans
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_by       text REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_by       text REFERENCES app_user(id),
  revoked_at       timestamptz,
  revoke_reason    text
);
CREATE UNIQUE INDEX qr_one_active ON qr_token(traceability_id) WHERE status = 'ACTIVE';

-- ---------- Label profiles, OCR evidence and validation matrix (section 11A) ----------
CREATE TABLE label_profile (
  profile_key text NOT NULL,
  version     int  NOT NULL DEFAULT 1,
  name        text NOT NULL,
  supplier_id uuid REFERENCES supplier(id),   -- NULL = generic profile
  config      jsonb NOT NULL,                  -- field aliases, value patterns, date formats, thresholds
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DEPRECATED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_key, version)
);

CREATE TABLE validation_run (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_code              text NOT NULL UNIQUE DEFAULT 'VAL-' || lpad(nextval('spir.validation_code_seq')::text, 6, '0'),
  traceability_id       uuid REFERENCES traceability_record(id),        -- NULL when unresolved
  pinned_product_version_id      uuid REFERENCES product_version(id),
  pinned_traceability_version_id uuid REFERENCES traceability_version(id),
  resolution_method     text,       -- QR_TOKEN | IDENTIFIERS | MANUAL_SELECTION | NONE
  resolution_detail     jsonb,
  label_profile_key     text,
  label_profile_version int,
  ocr_engine            text,
  ocr_engine_version    text,
  rule_version          text NOT NULL,
  image_storage_key     text,
  image_sha256          text,
  raw_ocr_text          text,
  extraction            jsonb NOT NULL DEFAULT '{}',   -- field candidates from the label profile
  ocr_mean_confidence   numeric,
  barcodes              jsonb NOT NULL DEFAULT '[]',
  device_info           jsonb NOT NULL DEFAULT '{}',
  overall_status        text NOT NULL CHECK (overall_status IN
                          ('PASS','FAIL','PASS_WITH_WARNINGS','NEEDS_REVIEW','UNRESOLVED','PENDING_SYNCHRONIZATION')),
  operator_id           text NOT NULL REFERENCES app_user(id),
  correlation_id        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  finalized_at          timestamptz,
  finalized_by          text REFERENCES app_user(id)
);

CREATE TABLE validation_field_result (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES validation_run(id),
  attribute_key       text NOT NULL,
  attribute_label     text NOT NULL,
  attribute_version   int,
  critical            boolean NOT NULL DEFAULT false,
  approved_value      text,
  observed_raw        text,          -- immutable raw OCR / barcode read
  observed_normalized text,
  confidence          numeric,       -- 0..1, NULL = engine did not provide one
  extraction_method   text,          -- ALIAS_LINE | PATTERN | BARCODE | NONE
  bbox                jsonb,
  result              text NOT NULL CHECK (result IN ('MATCH','MISMATCH','LOW_CONFIDENCE','UNREADABLE',
                        'MISSING_ON_LABEL','MISSING_IN_REGISTRY','NOT_APPLICABLE','NOT_CHECKED','REVIEW_REQUIRED')),
  rule                jsonb NOT NULL,
  note                text,
  -- operator review (kept separate from raw OCR evidence, FR-OCR-012)
  corrected_value     text,
  corrected_result    text,
  disposition         text CHECK (disposition IN ('ACCEPTED','CORRECTED','UNREADABLE','NOT_APPLICABLE','DISCREPANCY_RAISED','AWAITING_REVIEW')),
  disposition_note    text,
  reviewed_by         text REFERENCES app_user(id),
  reviewed_at         timestamptz,
  UNIQUE (run_id, attribute_key)
);

CREATE TABLE discrepancy (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discrepancy_code text NOT NULL UNIQUE DEFAULT 'DSC-' || lpad(nextval('spir.discrepancy_code_seq')::text, 6, '0'),
  run_id          uuid NOT NULL REFERENCES validation_run(id),
  attribute_key   text,
  severity        text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  classification  text CHECK (classification IN ('MISLABELLED_PRODUCT','REGISTRY_ERROR','WRONG_RECORD','OCR_ERROR','PROCESS_EXCEPTION','UNKNOWN')),
  description     text NOT NULL,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
  assigned_to     text REFERENCES app_user(id),
  created_by      text NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- Append-only audit (section 14.7) ----------
CREATE TABLE audit_event (
  id             bigserial PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_id       text,
  actor_role     text,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  details        jsonb NOT NULL DEFAULT '{}',
  correlation_id text
);
CREATE INDEX audit_entity_idx ON audit_event(entity_type, entity_id);
CREATE INDEX audit_time_idx ON audit_event(occurred_at DESC);

CREATE FUNCTION audit_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only';
END $$;
CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();

-- Approved versions are immutable business history: block edits to their content.
CREATE FUNCTION approved_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('APPROVED','SUPERSEDED') AND (NEW.attributes IS DISTINCT FROM OLD.attributes) THEN
    RAISE EXCEPTION 'approved versions are immutable; create a new version instead';
  END IF;
  IF OLD.status = 'SUPERSEDED' AND NEW.status <> 'SUPERSEDED' THEN
    RAISE EXCEPTION 'superseded versions are terminal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_version_immutable BEFORE UPDATE ON product_version
  FOR EACH ROW EXECUTE FUNCTION approved_version_immutable();
CREATE TRIGGER trc_version_immutable BEFORE UPDATE ON traceability_version
  FOR EACH ROW EXECUTE FUNCTION approved_version_immutable();
