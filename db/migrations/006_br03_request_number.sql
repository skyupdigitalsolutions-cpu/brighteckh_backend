-- 006_br03_request_number.sql
--
-- br03_material_requests.request_number is NOT NULL UNIQUE but migration 001
-- never shipped a generator for it (br02_next_identifier is hardcoded to
-- 'JIN'/'JOB' only). This extends the same per-company counter mechanism
-- with a third kind, 'MR', rather than inventing a new numbering scheme.
--
-- No change to edit-lock timing: br03_can_engineer_edit() already documents
-- that a submitted request with self_edit_deadline_at left NULL (no working
-- calendar configured yet, per CLAUDE.md section 5) is simply not freely
-- editable. The API leaves that column NULL on submit; this migration does
-- not touch that logic.

ALTER TABLE company_number_counters DROP CONSTRAINT company_number_counters_number_kind_check;
ALTER TABLE company_number_counters ADD CONSTRAINT company_number_counters_number_kind_check
  CHECK (number_kind IN ('JIN','JOB','MR'));

CREATE OR REPLACE FUNCTION br03_next_request_number(p_company_id uuid)
RETURNS varchar LANGUAGE plpgsql AS $$
DECLARE v_code varchar(3); v_seq bigint;
BEGIN
  SELECT entity_code INTO v_code FROM legal_entities WHERE id=p_company_id AND is_active;
  IF v_code IS NULL THEN RAISE EXCEPTION 'Company missing or inactive'; END IF;
  INSERT INTO company_number_counters(company_id,number_kind,last_value)
  VALUES(p_company_id,'MR',1)
  ON CONFLICT(company_id,number_kind) DO UPDATE
    SET last_value=company_number_counters.last_value+1, changed_at=now()
  RETURNING last_value INTO v_seq;
  RETURN 'MR-'||v_code||'-'||lpad(v_seq::text,6,'0');
END $$;
