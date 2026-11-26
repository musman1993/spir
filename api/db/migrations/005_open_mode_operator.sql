-- Open mode (no sign-in): every request acts as one generic "operator" user, so foreign keys such as
-- created_by / operator_id still point at a real user and the audit trail stays meaningful.
-- Supplier contributors, reviewers and the other roles remain for when sign-in returns (AUTH_MODE=demo/oidc).
SET LOCAL search_path TO spir, public;

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_role_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_role_check CHECK (role IN (
  'OPERATOR','SUPPLIER_CONTRIBUTOR','COMPANY_REVIEWER','REGISTRY_ADMIN','QR_USER','INSPECTOR','AUDITOR'));

INSERT INTO app_user (id, display_name, role, email) VALUES ('operator', 'Operator', 'OPERATOR', NULL)
ON CONFLICT (id) DO NOTHING;
