-- Two portals, two accounts (RBAC comes later).
--   supplier-admin  signs in to the supplier portal; belongs to ONE supplier (set in its profile).
--   company-admin   signs in to the company portal; sees every supplier's shipments.
-- The older roles (operator, supplier contributors, reviewer, inspector, ...) are switched off. Their rows
-- stay, inactive, because historical versions, documents and audit events still point at them.
-- The previous design is kept on the git branch archive/roles-and-review.
SET LOCAL search_path TO spir, public;

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_check;
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_role_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_role_check CHECK (role IN (
  'SUPPLIER','COMPANY',
  -- legacy, inactive:
  'OPERATOR','SUPPLIER_CONTRIBUTOR','COMPANY_REVIEWER','REGISTRY_ADMIN','QR_USER','INSPECTOR','AUDITOR'));

UPDATE app_user SET active = false WHERE role NOT IN ('SUPPLIER','COMPANY');

INSERT INTO app_user (id, display_name, role, supplier_id, active) VALUES
  ('supplier-admin', 'Supplier admin', 'SUPPLIER', NULL, true),
  ('company-admin',  'Company admin',  'COMPANY',  NULL, true)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, active = true;

-- Supplier profile details, edited in the supplier portal.
ALTER TABLE supplier ADD COLUMN IF NOT EXISTS contact_name  text;
ALTER TABLE supplier ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE supplier ADD COLUMN IF NOT EXISTS contact_phone text;
ALTER TABLE supplier ADD COLUMN IF NOT EXISTS address       text;

-- If a database already has suppliers (demo seed), the supplier account takes the first one.
UPDATE app_user SET supplier_id = (SELECT id FROM supplier ORDER BY supplier_code LIMIT 1)
 WHERE id = 'supplier-admin' AND supplier_id IS NULL;
