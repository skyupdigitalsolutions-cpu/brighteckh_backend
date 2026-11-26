-- =============================================================================
-- 026 -- Client-confirmed configuration (Brightech answers, 26 Nov 2026)
--
-- Additive. Values are NOT inserted here (they are per company and need an actor):
-- `npm run seed:client-config` loads them. This migration adds the stores and gates
-- that did not exist yet, and changes the rules the client has now decided:
--
--   1. company_policy_config (one row per company, SYSTEM_ADMIN via PUT /company-config).
--      ENFORCED: max_discount_percent (BR-04 quote revisions, replaces the 10% CHECK).
--      STORED ONLY (no workflow consumes them yet): customer / supplier return windows,
--      return freight payer, quote follow-up days, RMA turnaround target, and the approver
--      roles for customer return (RMA), supplier refund / AP and management KPI sign-off.
--   2. BR-04 discount gate: br04_customer_quote_revisions_check4 (hard-coded 10%, migration 001
--      draft) is replaced by a trigger that reads company_policy_config.max_discount_percent
--      (unset = 10%, the old behaviour). Existing rows are not re-checked.
--   3. BR-09: new authority kind REPLACEMENT_APPROVAL. A REPLACEMENT decision's refund/replacement
--      review uses it when configured; otherwise (and always for REFUND_REVIEW) the existing
--      REFUND_REPLACEMENT_REVIEW authority applies (unchanged behaviour when unset).
--   4. BR-11: br11_company_policies.advance_policy. NONE = an order with no recorded payment terms
--      needs no advance (reservation / sourcing are not blocked). Terms recorded on an order still
--      apply. NULL / PER_ORDER = the 018 behaviour (terms must be recorded first).
--   5. BR-08 product GST: the PRODUCT_SALE rate row may leave hsn_sac NULL (HSN is per item, from
--      fdn_item_master.hsn_tax). A product line whose item has no valid HSN is then refused.
--      br08_build_sales_invoice = 018 verbatim + that check ([026] marker).
--   6. BR-08: one invoice per dispatch -- every job on a repair invoice must come from ONE
--      dispatch batch (was: several dispatched jobs of one customer).
-- =============================================================================

-- 1 ---------------------------------------------------------------------------
CREATE TABLE company_policy_config (
  company_id uuid PRIMARY KEY REFERENCES legal_entities(id),
  max_discount_percent numeric(5,2) CHECK (max_discount_percent >= 0 AND max_discount_percent <= 100),
  customer_return_window_days integer CHECK (customer_return_window_days > 0),
  supplier_return_window_min_days integer CHECK (supplier_return_window_min_days > 0),
  supplier_return_window_max_days integer CHECK (supplier_return_window_max_days > 0),
  return_freight_payer varchar(10) CHECK (return_freight_payer IN ('CUSTOMER','COMPANY')),
  quote_followup_days integer CHECK (quote_followup_days > 0),
  rma_turnaround_target_working_days integer CHECK (rma_turnaround_target_working_days > 0),
  customer_return_authority_role varchar(40) CHECK (customer_return_authority_role IN
    ('PURCHASE','ENGINEER','SALES','STORES_QUALITY','EXTERNAL_COORD','FINANCE','MANAGEMENT','SYSTEM_ADMIN')),
  supplier_refund_authority_role varchar(40) CHECK (supplier_refund_authority_role IN
    ('PURCHASE','ENGINEER','SALES','STORES_QUALITY','EXTERNAL_COORD','FINANCE','MANAGEMENT','SYSTEM_ADMIN')),
  kpi_signoff_authority_role varchar(40) CHECK (kpi_signoff_authority_role IN
    ('PURCHASE','ENGINEER','SALES','STORES_QUALITY','EXTERNAL_COORD','FINANCE','MANAGEMENT','SYSTEM_ADMIN')),
  note text,
  updated_by_id uuid REFERENCES employees(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (supplier_return_window_min_days IS NULL OR supplier_return_window_max_days IS NULL
         OR supplier_return_window_min_days <= supplier_return_window_max_days)
);

-- 2 ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION br04_max_discount_percent(p_company uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT max_discount_percent FROM company_policy_config WHERE company_id=p_company), 10);
$$;

CREATE OR REPLACE FUNCTION br04_guard_discount_threshold()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_company uuid; v_max numeric;
BEGIN
  IF NEW.original_authorised_pre_tax = 0 THEN RETURN NEW; END IF;
  IF NEW.higher_discount_approved_by_id IS NOT NULL AND NEW.higher_discount_approved_at IS NOT NULL
     AND NULLIF(btrim(NEW.higher_discount_reason),'') IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT company_id INTO v_company FROM br04_customer_quotes WHERE id=NEW.quote_id;
  v_max := br04_max_discount_percent(v_company);
  IF NEW.revised_pre_tax < round(NEW.original_authorised_pre_tax * (1 - v_max/100), 2) THEN
    RAISE EXCEPTION 'BR04: revision is more than % below the originally authorised price; needs explicit higher-discount approval + reason',
      trim_scale(v_max)::text || '%';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE br04_customer_quote_revisions DROP CONSTRAINT br04_customer_quote_revisions_check4;
CREATE TRIGGER trg_br04_discount_threshold
  BEFORE INSERT OR UPDATE OF original_authorised_pre_tax, revised_pre_tax, higher_discount_approved_by_id,
    higher_discount_approved_at, higher_discount_reason ON br04_customer_quote_revisions
  FOR EACH ROW EXECUTE FUNCTION br04_guard_discount_threshold();

-- 3 ---------------------------------------------------------------------------
ALTER TABLE br09_authority_config DROP CONSTRAINT br09_authority_config_decision_kind_check;
ALTER TABLE br09_authority_config ADD CONSTRAINT br09_authority_config_decision_kind_check
  CHECK (decision_kind IN ('CLAIM_DECISION','GOODWILL_APPROVAL','REFUND_REPLACEMENT_REVIEW','REPLACEMENT_APPROVAL'));

-- 020 verbatim except the authority kind ([026]).
CREATE OR REPLACE FUNCTION br09_guard_refund_replacement_review()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d br09_claim_decisions%ROWTYPE; v_kind text := 'REFUND_REPLACEMENT_REVIEW';
BEGIN
  SELECT * INTO d FROM br09_claim_decisions WHERE id=NEW.decision_id;
  IF NOT FOUND OR d.company_id <> NEW.company_id THEN RAISE EXCEPTION 'BR09: decision not found in this company'; END IF;
  PERFORM br09_open_case(d.case_id, NEW.company_id);
  IF d.resolution NOT IN ('REPLACEMENT','REFUND_REVIEW') OR NOT d.is_current THEN
    RAISE EXCEPTION 'BR09: refund/replacement review applies only to the current REPLACEMENT or REFUND_REVIEW decision';
  END IF;
  -- [026] replacement has its own approver when configured
  IF d.resolution = 'REPLACEMENT' AND EXISTS (
       SELECT 1 FROM br09_authority_config
        WHERE company_id=NEW.company_id AND decision_kind='REPLACEMENT_APPROVAL' AND approver_role_code IS NOT NULL) THEN
    v_kind := 'REPLACEMENT_APPROVAL';
  END IF;
  NEW.reviewer_role_code := br09_assert_authority(NEW.company_id, v_kind, NEW.reviewed_by_id);
  NEW.reviewed_at := now();
  RETURN NEW;
END $$;

-- 4 ---------------------------------------------------------------------------
ALTER TABLE br11_company_policies
  ADD COLUMN advance_policy varchar(10) CHECK (advance_policy IN ('NONE','PER_ORDER'));

CREATE OR REPLACE FUNCTION br11_assert_advance_cleared(p_order uuid)
RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE pc br11_order_payment_conditions%ROWTYPE;
BEGIN
  SELECT * INTO pc FROM br11_order_payment_conditions WHERE sales_order_id=p_order;
  IF NOT FOUND THEN
    -- [026] company advance policy NONE: no recorded terms = no advance required
    IF (SELECT p.advance_policy FROM br11_company_policies p JOIN br11_sales_orders o ON o.company_id=p.company_id
         WHERE o.id=p_order) = 'NONE' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'BR11: the customer-agreed payment terms for this order are not recorded (11B-02: no blanket advance rule; capture the accepted terms first)';
  END IF;
  IF pc.advance_kind <> 'NOT_REQUIRED' AND pc.finance_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'BR11: the accepted terms require an advance (%) -- Finance must confirm the BR-08 receipt first', pc.advance_kind;
  END IF;
END $$;

-- 5 ---------------------------------------------------------------------------
ALTER TABLE br08_gst_rate_config ALTER COLUMN hsn_sac DROP NOT NULL;
ALTER TABLE br08_gst_rate_config ADD CONSTRAINT br08_gst_rate_config_hsn_required
  CHECK (hsn_sac IS NOT NULL OR quote_line_type = 'PRODUCT_SALE');

-- 018 br08_build_sales_invoice verbatim + the [026] per-item HSN check.
CREATE OR REPLACE FUNCTION br08_build_sales_invoice(p_company uuid, p_sales_order uuid, p_lines jsonb, p_credit_days integer)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  le legal_entities%ROWTYPE; c customers%ROWTYPE; so br11_sales_orders%ROWTYPE; rate br08_gst_rate_config%ROWTYPE;
  v_trigger text; v_pos_name text; v_sup_state_name text; v_regime text; v_today date; v_credit integer;
  ol record; v_req jsonb; v_qty numeric; v_ceiling numeric; v_done numeric; v_hsn text;
  v_lines jsonb := '[]'; v_refs jsonb; v_line_no integer := 0; v_taxable bigint;
  v_sub bigint; v_cgt bigint; v_sgt bigint; v_igt bigint;
BEGIN
  SELECT * INTO le FROM legal_entities WHERE id=p_company;
  IF le.doc_prefix IS NULL OR le.gstin IS NULL OR le.state_code IS NULL OR le.registered_address IS NULL
     OR le.bank_name IS NULL OR le.bank_account_no IS NULL OR le.bank_ifsc IS NULL THEN
    RAISE EXCEPTION 'BR08: company invoicing profile incomplete (prefix, GSTIN, state, address, bank name/account/IFSC required)';
  END IF;
  SELECT state_name INTO v_sup_state_name FROM gst_states WHERE state_code=le.state_code;

  SELECT * INTO so FROM br11_sales_orders WHERE id=p_sales_order AND company_id=p_company;
  IF NOT FOUND THEN RAISE EXCEPTION 'BR08: Sales Order not found in this company'; END IF;
  IF so.status NOT IN ('VERIFIED','PART_DELIVERED','DELIVERED') THEN
    RAISE EXCEPTION 'BR08: a product-sales invoice needs a verified, open Sales Order (order is %)', so.status;
  END IF;

  SELECT invoice_trigger INTO v_trigger FROM br11_company_policies WHERE company_id=p_company;
  IF v_trigger IS NULL THEN
    RAISE EXCEPTION 'BR08: CLIENT-UNCONFIRMED -- product-sales invoice trigger (11C-07) is not configured for this company';
  END IF;
  IF v_trigger = 'MILESTONE' THEN
    RAISE EXCEPTION 'BR08: MILESTONE invoicing has no milestone schedule (11C-07) -- not modelled';
  END IF;
  SELECT * INTO rate FROM br08_gst_rate_config WHERE is_active AND quote_line_type='PRODUCT_SALE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BR08: CLIENT-UNCONFIRMED -- no active PRODUCT_SALE GST rate/HSN in br08_gst_rate_config (P-12); the repair SAC default is not used for goods';
  END IF;

  SELECT * INTO c FROM customers WHERE id=so.customer_id;
  IF c.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'BR08: invoice blocked until the customer is APPROVED (D6) -- customer is %', c.status;
  END IF;
  IF c.gstin IS NULL OR c.state_code IS NULL THEN
    RAISE EXCEPTION 'BR08: customer GSTIN and state are required to issue a tax invoice (unregistered customers: open decision)';
  END IF;
  SELECT state_name INTO v_pos_name FROM gst_states WHERE state_code=c.state_code;
  v_regime := CASE WHEN c.state_code = le.state_code THEN 'INTRA_STATE' ELSE 'INTER_STATE' END;

  IF p_lines IS NOT NULL AND (jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0) THEN
    RAISE EXCEPTION 'BR08: lines must be a non-empty array (or omitted)';
  END IF;
  IF p_lines IS NOT NULL AND jsonb_array_length(p_lines) <> (SELECT count(DISTINCT e->>'sales_order_line_id') FROM jsonb_array_elements(p_lines) e) THEN
    RAISE EXCEPTION 'BR08: duplicate Sales Order line in invoice request';
  END IF;
  IF p_lines IS NOT NULL AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_lines) e
        WHERE NOT EXISTS (SELECT 1 FROM br11_sales_order_lines l WHERE l.sales_order_id=so.id AND l.id::text = e->>'sales_order_line_id')) THEN
    RAISE EXCEPTION 'BR08: a requested line is not on this Sales Order';
  END IF;

  FOR ol IN SELECT l.*, i.status AS item_status, i.hsn_tax FROM br11_sales_order_lines l JOIN fdn_item_master i ON i.id=l.item_id
             WHERE l.sales_order_id=so.id AND l.line_status<>'CANCELLED' ORDER BY l.line_no LOOP
    v_ceiling := br11_line_invoiceable_qty(ol.id);
    v_done := br11_line_invoiced_qty(ol.id);
    IF p_lines IS NULL THEN
      v_qty := v_ceiling - v_done;
      IF v_qty <= 0 THEN CONTINUE; END IF;
    ELSE
      v_req := NULL;
      SELECT e INTO v_req FROM jsonb_array_elements(p_lines) e WHERE e->>'sales_order_line_id' = ol.id::text;
      IF v_req IS NULL THEN CONTINUE; END IF;
      v_qty := (v_req->>'quantity')::numeric;
      IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'BR08: line % quantity must be > 0', ol.line_no; END IF;
      IF v_done + v_qty > v_ceiling THEN
        RAISE EXCEPTION 'BR08: line % invoice quantity (% already + %) exceeds the invoiceable quantity % under the % trigger',
          ol.line_no, v_done, v_qty, v_ceiling, v_trigger;
      END IF;
    END IF;
    IF ol.item_status NOT IN ('APPROVED','ACTIVE') THEN
      RAISE EXCEPTION 'BR08: invoice blocked -- item on line % is % in the Item Master', ol.line_no, ol.item_status;
    END IF;
    v_hsn := CASE WHEN ol.hsn_tax ~ '^[0-9]{4,8}$' THEN ol.hsn_tax ELSE rate.hsn_sac END;
    -- [026] product HSN is per item: no valid item HSN and no rate-level HSN = refused
    IF v_hsn IS NULL THEN
      RAISE EXCEPTION 'BR08: invoice blocked -- item on line % has no valid HSN code in the Item Master (hsn_tax); product HSN is per item', ol.line_no;
    END IF;
    v_line_no := v_line_no + 1;
    v_taxable := round(v_qty * ol.unit_price_paise)::bigint;
    v_lines := v_lines || jsonb_build_object(
      'line_no', v_line_no, 'sales_order_line_id', ol.id, 'item_id', ol.item_id, 'description', ol.description_snapshot,
      'hsn_sac', v_hsn, 'quantity', v_qty, 'uom', ol.uom, 'unit_price_paise', ol.unit_price_paise, 'taxable_paise', v_taxable,
      'cgst_rate', CASE WHEN v_regime='INTRA_STATE' THEN rate.cgst_rate ELSE 0 END,
      'sgst_rate', CASE WHEN v_regime='INTRA_STATE' THEN rate.sgst_rate ELSE 0 END,
      'igst_rate', CASE WHEN v_regime='INTER_STATE' THEN rate.igst_rate ELSE 0 END,
      'cgst_paise', CASE WHEN v_regime='INTRA_STATE' THEN round(v_taxable::numeric * rate.cgst_rate / 100)::bigint ELSE 0 END,
      'sgst_paise', CASE WHEN v_regime='INTRA_STATE' THEN round(v_taxable::numeric * rate.sgst_rate / 100)::bigint ELSE 0 END,
      'igst_paise', CASE WHEN v_regime='INTER_STATE' THEN round(v_taxable::numeric * rate.igst_rate / 100)::bigint ELSE 0 END);
  END LOOP;
  IF v_line_no = 0 THEN
    RAISE EXCEPTION 'BR08: nothing to invoice on this Sales Order under the % trigger', v_trigger;
  END IF;

  SELECT jsonb_agg(e || jsonb_build_object('line_total_paise',
           (e->>'taxable_paise')::bigint + (e->>'cgst_paise')::bigint + (e->>'sgst_paise')::bigint + (e->>'igst_paise')::bigint)
           ORDER BY (e->>'line_no')::int),
         sum((e->>'taxable_paise')::bigint), sum((e->>'cgst_paise')::bigint),
         sum((e->>'sgst_paise')::bigint), sum((e->>'igst_paise')::bigint)
    INTO v_lines, v_sub, v_cgt, v_sgt, v_igt
    FROM jsonb_array_elements(v_lines) e;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('sales_order_number', so.sales_order_number, 'order_type', a.source_kind,
           'customer_order_ref', a.source_reference, 'received_at', a.received_at, 'customer_email_sender', a.customer_email_sender)), '[]')
    INTO v_refs FROM br11_order_authorisation_events a WHERE a.sales_order_id=so.id AND a.verified_status='VERIFIED';

  v_today := br08_local_today(p_company);
  v_credit := COALESCE(p_credit_days, c.credit_days);
  IF v_credit < 0 THEN RAISE EXCEPTION 'BR08: credit days must be >= 0'; END IF;

  RETURN jsonb_build_object(
    'invoice_type', 'PRODUCT_SALES', 'invoice_trigger', v_trigger,
    'company_id', p_company, 'customer_id', c.id, 'sales_order_id', so.id, 'sales_order_number', so.sales_order_number,
    'invoice_date', v_today, 'credit_days', v_credit, 'due_date', v_today + v_credit,
    'supplier', jsonb_build_object('legal_name', COALESCE(le.legal_name, le.name), 'gstin', le.gstin,
                  'state_code', le.state_code, 'state_name', v_sup_state_name, 'address', le.registered_address),
    'customer', jsonb_build_object('name', c.customer_name, 'gstin', c.gstin, 'state_code', c.state_code,
                  'state_name', v_pos_name, 'address', c.billing_address),
    'place_of_supply', jsonb_build_object('state_code', c.state_code, 'state_name', v_pos_name),
    'tax_regime', v_regime,
    'bank', jsonb_build_object('account_name', COALESCE(le.bank_account_name, le.legal_name, le.name), 'bank_name', le.bank_name,
              'account_no', le.bank_account_no, 'ifsc', le.bank_ifsc, 'branch', le.bank_branch),
    'customer_order_refs', v_refs, 'lines', v_lines,
    'sub_total_paise', v_sub, 'cgst_paise', v_cgt, 'sgst_paise', v_sgt, 'igst_paise', v_igt,
    'total_paise', v_sub + v_cgt + v_sgt + v_igt,
    'total_in_words', br08_amount_in_words(v_sub + v_cgt + v_sgt + v_igt));
END $$;

-- 6 ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION br08_assert_single_dispatch(p_job_ids uuid[])
RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF (SELECT count(DISTINCT bj.batch_id) FROM br08_dispatch_batch_jobs bj WHERE bj.job_id = ANY(p_job_ids)) > 1 THEN
    RAISE EXCEPTION 'BR08: one invoice per dispatch -- all jobs on an invoice must come from the same dispatch batch';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION br08_guard_invoice_single_dispatch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM br08_invoice_jobs
              WHERE invoice_id=NEW.invoice_id AND dispatch_batch_id <> NEW.dispatch_batch_id) THEN
    RAISE EXCEPTION 'BR08: one invoice per dispatch -- all jobs on an invoice must come from the same dispatch batch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_invoice_single_dispatch BEFORE INSERT ON br08_invoice_jobs
  FOR EACH ROW EXECUTE FUNCTION br08_guard_invoice_single_dispatch();
