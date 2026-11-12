-- 021_br10_pii_customer_masking.sql
--
-- Closes BR-10 gap 1 from the official BR-10 Rev01 reconciliation (12 Nov 2026):
-- customer name / GSTIN were masked only on EXPORT. ALTER-only on 017; the official
-- package SQL is NOT applied.
--   * New data class PII_CUSTOMER (official M:384).
--   * PII_CUSTOMER is a named-employee ENTITLEMENT, not a runnable report: a row in
--     br10_report_catalogue so the existing br10_report_grants / br10_grant_approvals
--     machinery applies unchanged (starts INACTIVE, SYSTEM_ADMIN creates, no self-grant,
--     no self-approval, independent approvers, cross-company approval by the data owner).
--     VIEW grant = unmasked on screen; EXPORT grant = unmasked in exports (VIEW != EXPORT).
--   * New mask scope applies_to='PII': masked on VIEW AND EXPORT unless the viewer holds
--     an ACTIVE PII_CUSTOMER grant for that action on EVERY company in the request.
--   * Existing customer_name / customer_gstin masks move from EXPORT to PII.
-- Approval for a PII grant: STANDARD (SYSTEM_ADMIN of the grantee company) + CROSS_COMPANY
-- for another company. Who should authorise PII access is CLIENT-UNCONFIRMED (flagged).

ALTER TABLE br10_permission_matrix DROP CONSTRAINT br10_permission_matrix_data_class_check;
ALTER TABLE br10_permission_matrix ADD CONSTRAINT br10_permission_matrix_data_class_check
  CHECK (data_class IN ('OPERATIONS','PROCUREMENT','MARGIN_PROFIT','RECEIVABLES','RECEIVABLE_STATUS',
                        'ENGINEER_PERFORMANCE','AUDIT','CONFIG','PII_CUSTOMER'));
ALTER TABLE br10_report_catalogue DROP CONSTRAINT br10_report_catalogue_data_class_check;
ALTER TABLE br10_report_catalogue ADD CONSTRAINT br10_report_catalogue_data_class_check
  CHECK (data_class IN ('OPERATIONS','PROCUREMENT','MARGIN_PROFIT','RECEIVABLES','RECEIVABLE_STATUS',
                        'ENGINEER_PERFORMANCE','AUDIT','CONFIG','PII_CUSTOMER'));

INSERT INTO br10_report_catalogue(report_code,title,data_class,description) VALUES
 ('PII_CUSTOMER','Customer PII (entitlement)','PII_CUSTOMER',
  'Not a report. A named grant on this code unmasks customer name / GSTIN in BR-10 reports: VIEW = on screen, EXPORT = in exports, per company.');

ALTER TABLE br10_column_masks DROP CONSTRAINT br10_column_masks_applies_to_check;
ALTER TABLE br10_column_masks ADD CONSTRAINT br10_column_masks_applies_to_check
  CHECK (applies_to IN ('EXPORT','ALWAYS','PII'));
UPDATE br10_column_masks SET applies_to='PII', note='Customer PII: masked on screen and export unless a PII_CUSTOMER grant'
 WHERE column_name IN ('customer_name','customer_gstin');

-- Grant guard: 017 verbatim + the PII_CUSTOMER branch (no permission-matrix row exists for
-- PII; the grantee must hold an ACTIVE, role-mapped BR-10 binding instead).
CREATE OR REPLACE FUNCTION br10_guard_grant()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_class text; v_type text; v_cross boolean; v_req text[] := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br10_is_admin(NEW.company_id, NEW.created_by_id) THEN RAISE EXCEPTION 'BR10: only SYSTEM_ADMIN can create a report grant'; END IF;
    IF NEW.status <> 'INACTIVE' THEN RAISE EXCEPTION 'BR10: every grant starts INACTIVE (explicit activation required)'; END IF;
    IF NEW.created_by_id = NEW.employee_id THEN RAISE EXCEPTION 'BR10: no self-grant'; END IF;
    SELECT data_class INTO v_class FROM br10_report_catalogue WHERE report_code=NEW.report_code;
    v_cross := NEW.target_company_id <> NEW.company_id;
    IF v_class = 'PII_CUSTOMER' THEN  -- [021]
      IF NOT EXISTS (SELECT 1 FROM br10_role_bindings b JOIN employees e ON e.id=b.employee_id AND e.is_active
                       JOIN br10_role_catalogue rc ON rc.role_code=b.role_code AND rc.maps_to_role_code=e.role_code
                      WHERE b.employee_id=NEW.employee_id AND b.status='ACTIVE') THEN
        RAISE EXCEPTION 'BR10: a PII_CUSTOMER grant needs an ACTIVE BR-10 role binding for the employee';
      END IF;
    ELSE
      v_type := br10_matrix_allows(NEW.employee_id, v_class, NEW.action, v_cross);
      IF v_type IS NULL THEN
        RAISE EXCEPTION 'BR10: no ACTIVE role binding of this employee permits % on % (%)%', NEW.action, NEW.report_code, v_class,
          CASE WHEN v_cross THEN ' for another company' ELSE '' END;
      END IF;
    END IF;
    IF br10_is_financial_class(v_class) THEN v_req := v_req || 'FINANCIAL'::text; END IF;
    IF v_cross THEN v_req := v_req || 'CROSS_COMPANY'::text; END IF;
    IF cardinality(v_req) = 0 THEN v_req := ARRAY['STANDARD']; END IF;
    NEW.required_approvals := v_req;
    NEW.created_at := now(); NEW.activated_at := NULL; NEW.revoked_at := NULL; NEW.revoked_by_id := NULL;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','activated_at','revoked_by_id','revoked_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','activated_at','revoked_by_id','revoked_at']) THEN
    RAISE EXCEPTION 'BR10: grant identity is immutable';
  END IF;
  IF OLD.status = 'REVOKED' THEN RAISE EXCEPTION 'BR10: a revoked grant stays revoked'; END IF;
  IF NEW.status = 'ACTIVE' AND OLD.status = 'INACTIVE' THEN
    IF pg_trigger_depth() < 2 THEN RAISE EXCEPTION 'BR10: a grant becomes ACTIVE only when its required approvals are recorded'; END IF;
    NEW.activated_at := now();
  ELSIF NEW.status = 'REVOKED' THEN
    IF NOT (br10_is_admin(NEW.company_id, NEW.revoked_by_id) OR br10_is_admin(NEW.target_company_id, NEW.revoked_by_id)) THEN
      RAISE EXCEPTION 'BR10: only SYSTEM_ADMIN (grantee or data-owner company) revokes a grant';
    END IF;
    NEW.revoked_at := now();
  ELSIF NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'BR10: illegal grant transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

-- True only if the employee (still active, still bound) holds an ACTIVE PII_CUSTOMER grant
-- for this action on every requested company. Evaluated at every report call.
CREATE OR REPLACE FUNCTION br10_pii_unmasked(p_employee uuid, p_action text, p_companies uuid[])
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT cardinality(p_companies) > 0
     AND EXISTS (SELECT 1 FROM br10_role_bindings b JOIN employees e ON e.id=b.employee_id AND e.is_active
                   JOIN br10_role_catalogue rc ON rc.role_code=b.role_code AND rc.maps_to_role_code=e.role_code
                  WHERE b.employee_id=p_employee AND b.status='ACTIVE')
     AND NOT EXISTS (SELECT 1 FROM unnest(p_companies) co
                      WHERE NOT EXISTS (SELECT 1 FROM br10_report_grants g
                                         WHERE g.employee_id=p_employee AND g.report_code='PII_CUSTOMER'
                                           AND g.action=p_action AND g.target_company_id=co AND g.status='ACTIVE'));
$$;
