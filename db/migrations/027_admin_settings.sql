-- =============================================================================
-- 027 -- Admin Settings panel (Figma AST-D 293:59592, 27 Nov 2026)
--
-- Additive. Supports the SYSTEM_ADMIN Settings screens:
--   1. legal_entities.udyam_number (Company & tax). Stored only; nothing consumes it yet.
--   2. company_policy_config.supplier_return_authority_role (Authorisers). Stored only, like the
--      other 026 authority roles (no supplier-return workflow).
--   3. Cross-company administration: one SYSTEM_ADMIN maintains every company's settings (the
--      Settings company switcher, product-owner decision 27 Nov 2026). br11_company_policies is the
--      only settings table that tied its updater to the SAME company (composite FK, migration 018);
--      it now references the employee alone, like company_policy_config / br09 / br10 authority
--      config already do. Every change is still audited with the acting employee and the target
--      company (activity_audit_log).
-- =============================================================================

-- 1 ---------------------------------------------------------------------------
ALTER TABLE legal_entities ADD COLUMN udyam_number varchar(19)
  CHECK (udyam_number IS NULL OR udyam_number ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$');

-- 2 ---------------------------------------------------------------------------
ALTER TABLE company_policy_config ADD COLUMN supplier_return_authority_role varchar(40)
  CHECK (supplier_return_authority_role IN
    ('PURCHASE','ENGINEER','SALES','STORES_QUALITY','EXTERNAL_COORD','FINANCE','MANAGEMENT','SYSTEM_ADMIN'));

-- 3 ---------------------------------------------------------------------------
DO $$
DECLARE v_name text;
BEGIN
  SELECT con.conname INTO v_name
    FROM pg_constraint con
   WHERE con.conrelid = 'br11_company_policies'::regclass AND con.contype = 'f'
     AND con.confrelid = 'employees'::regclass AND array_length(con.conkey, 1) = 2;
  IF v_name IS NULL THEN RAISE EXCEPTION '027: composite updater FK on br11_company_policies not found'; END IF;
  EXECUTE format('ALTER TABLE br11_company_policies DROP CONSTRAINT %I', v_name);
END $$;
ALTER TABLE br11_company_policies
  ADD CONSTRAINT br11_company_policies_updated_by_fkey FOREIGN KEY (updated_by_id) REFERENCES employees(id);
