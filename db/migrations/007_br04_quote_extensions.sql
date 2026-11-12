-- 007_br04_quote_extensions.sql
--
-- br04_customer_quote_lines already exists (added by the cross-module
-- integrity overlay later in 001) as the canonical customer-facing quote
-- line table, with its own immutability trigger (locked once the revision
-- leaves DRAFT) and release gate (requires >=1 line). No changes needed
-- there -- it already implements "quotation revisions immutable" and
-- "never expose supplier cost" (it has no cost/supplier column at all).
--
-- Two real gaps remain against the confirmed CLAUDE.md section 6 rule:
-- "Purchase picks any supplier quote as reference ... Store reference +
-- procurement offer; hide supplier cost from customer." Neither column
-- exists anywhere. This migration adds just those, plus quote numbering
-- (same per-company counter mechanism as JIN/JOB/MR) and a header-level
-- Item/Assembled flag for API/UI convenience -- additive only, nothing
-- here contradicts or replaces the existing canonical tables/triggers.

ALTER TABLE company_number_counters DROP CONSTRAINT company_number_counters_number_kind_check;
ALTER TABLE company_number_counters ADD CONSTRAINT company_number_counters_number_kind_check
  CHECK (number_kind IN ('JIN','JOB','MR','QT'));

CREATE OR REPLACE FUNCTION br04_next_quote_number(p_company_id uuid)
RETURNS varchar LANGUAGE plpgsql AS $$
DECLARE v_code varchar(3); v_seq bigint;
BEGIN
  SELECT entity_code INTO v_code FROM legal_entities WHERE id=p_company_id AND is_active;
  IF v_code IS NULL THEN RAISE EXCEPTION 'Company missing or inactive'; END IF;
  INSERT INTO company_number_counters(company_id,number_kind,last_value)
  VALUES(p_company_id,'QT',1)
  ON CONFLICT(company_id,number_kind) DO UPDATE
    SET last_value=company_number_counters.last_value+1, changed_at=now()
  RETURNING last_value INTO v_seq;
  RETURN 'QT-'||v_code||'-'||lpad(v_seq::text,6,'0');
END $$;

ALTER TABLE br04_customer_quotes
  ADD COLUMN quote_type varchar(12) NOT NULL DEFAULT 'ITEM' CHECK (quote_type IN ('ITEM','ASSEMBLED'));

ALTER TABLE br04_customer_quote_revisions
  ADD COLUMN reference_offer_line_id uuid REFERENCES br04_supplier_offer_lines(id),
  ADD COLUMN procurement_offer_line_id uuid REFERENCES br04_supplier_offer_lines(id);
