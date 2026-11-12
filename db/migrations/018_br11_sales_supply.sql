-- 018_br11_sales_supply.sql
--
-- BR-11 Sales & Supply (product enquiry -> quote -> Sales Order -> outward ->
-- delivery proof -> billing -> closure), plus the BR-06 SALES_ORDER purchase
-- purpose and the BR-08 PRODUCT_SALES invoice type it needs.
--
-- Source: BR-11 Rev01 package (10 Nov 2026, CLIENT REVIEW / NOT APPROVED:
-- 29 accepted recommendations + 11B-02 "Suggest"). The package's SQL files were
-- NOT applied: they target the official doc schemas, which differ from what was
-- actually built. Reconciled against the LIVE schema (pg_constraint inspected):
--
--   doc assumes                                 | this database (what we build to)
--   --------------------------------------------+-------------------------------------------------
--   br06_supplier_purchase_orders.purchase_     | NO purpose column at all. PO header has
--     purpose + CHECK ..._purchase_purpose_check|   job_id / source_br05_job_release_id /
--     (CUSTOMER_JOB/INTERNAL_USE/STORE_REPL.)   |   supplier_invite_id NOT NULL (repair-only).
--                                               |   -> ADD purchase_purpose (CUSTOMER_JOB default,
--                                               |   SALES_ORDER) + CHECK br06_po_purchase_purpose_check;
--                                               |   relax the 3 NOT NULLs to a purpose-conditional CHECK.
--   br06_supplier_po_lines + exclusive-source   | br06_po_lines; source_br04_offer_line_id NOT NULL,
--     CHECK (offer XOR internal requisition)    |   no requisition source exists. -> relax to
--                                               |   offer XOR sales-sourcing authorisation.
--   br08_invoice_drafts.invoice_type CHECK,     | br08_invoices (atomic issue, DB-numbered, no draft,
--     br08_invoice_accounting_posts 'POSTED'    |   no invoice_type, no posting table). -> ADD
--                                               |   invoice_type (REPAIR default, PRODUCT_SALES).
--   br08_customer_payment_receipts.status       | br08_payment_receipts (Finance-recorded = confirmed;
--     ='CONFIRMED', ..._allocation_reversals    |   reversals are negative br08_payment_allocations).
--   br11_company_document_counters (own table)  | shared company_number_counters (SE/SQ/SO/SOUT added)
--   br11_inventory_reservation_requests with    | real ledger fdn_inventory_reservations: CONFIRMED is
--     free-text external refs                   |   verified against the actual ledger row.
--   br11_billing_handoffs / br11_sales_procure- | not built: BR-08 / BR-06 rows reference the sale
--     ment_links (duplicate linking registries) |   directly (single source of truth, no duplication).
--   br11_audit_events                           | existing activity_audit_log (written by the API).
--
-- Source-of-truth rule: BR-11 owns ONLY product sale orders + fulfilment
-- records. Stock -> fdn_* ledger (fdn_reserve / fdn_post_movement via the
-- inventory API). Supplier PO/GRN -> BR-06 tables. Invoice / receipt / credit
-- note -> BR-08 tables (same INV series, GST maths, immutability, allocations).
-- BR-11 never creates a service_jobs row (11C-01): a sold unit that comes back
-- for repair is a NEW BR-02 JIN/Job.
--
-- CLIENT-UNCONFIRMED (hook built, unconfigured = BLOCKED, never defaulted):
--   11C-07 product invoice trigger      -> br11_company_policies.invoice_trigger
--   11C-09 payment required for closure -> br11_company_policies.requires_full_payment_for_closure
--   P-12   product GST rate / HSN       -> br08_gst_rate_config row quote_line_type='PRODUCT_SALE'
--   11B-02 advance                      -> per-order br11_order_payment_conditions (NO blanket rule)
--   11A-05 discount / margin bands      -> not enforced (no threshold exists; BR-04 10% NOT applied)

-- =============================================================================
-- Numbering: separate continuous company-wise sequences (11A-08, 11C-05), no FY
-- reset, in the SAME shared counter table as JIN/JOB/MR/QT/PO/GRN/ASC.
-- number_kind was varchar(3); SOUT needs 4 (widening only).
ALTER TABLE company_number_counters ALTER COLUMN number_kind TYPE varchar(6);
ALTER TABLE company_number_counters DROP CONSTRAINT company_number_counters_number_kind_check;
ALTER TABLE company_number_counters ADD CONSTRAINT company_number_counters_number_kind_check
  CHECK (number_kind IN ('JIN','JOB','MR','QT','PO','GRN','ASC','SE','SQ','SO','SOUT'));

CREATE OR REPLACE FUNCTION br11_next_number(p_company uuid, p_kind varchar)
RETURNS varchar LANGUAGE plpgsql AS $$
DECLARE v_code varchar(3); v_seq bigint;
BEGIN
  IF p_kind NOT IN ('SE','SQ','SO','SOUT') THEN RAISE EXCEPTION 'BR11: invalid document kind %', p_kind; END IF;
  SELECT entity_code INTO v_code FROM legal_entities WHERE id=p_company AND is_active;
  IF v_code IS NULL THEN RAISE EXCEPTION 'Company missing or inactive'; END IF;
  INSERT INTO company_number_counters(company_id,number_kind,last_value)
  VALUES (p_company,p_kind,1)
  ON CONFLICT (company_id,number_kind) DO UPDATE
    SET last_value=company_number_counters.last_value+1, changed_at=now()
  RETURNING last_value INTO v_seq;
  RETURN p_kind||'-'||v_code||'-'||lpad(v_seq::text,6,'0');
END $$;

CREATE OR REPLACE FUNCTION br11_has_any_role(p_company uuid, p_employee uuid, p_roles text[])
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM employees WHERE id=p_employee AND company_id=p_company AND is_active
                    AND role_code = ANY(p_roles));
$$;

-- =============================================================================
-- CLIENT-UNCONFIRMED company policy (one row per company, SYSTEM_ADMIN via API).
-- No row / NULL column = that step is BLOCKED.
CREATE TABLE br11_company_policies (
  company_id uuid PRIMARY KEY REFERENCES legal_entities(id),
  invoice_trigger varchar(12) CHECK (invoice_trigger IN ('ADVANCE','DISPATCH','DELIVERY','MILESTONE')),
  requires_full_payment_for_closure boolean,
  note text,
  updated_by_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, updated_by_id) REFERENCES employees(company_id, id)
);

-- =============================================================================
-- 11A: enquiry (SALES registers; 11A-01/02)
CREATE TABLE br11_sales_enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  enquiry_number varchar(30) NOT NULL UNIQUE,
  customer_id uuid NOT NULL,
  enquiry_channel varchar(16) NOT NULL CHECK (enquiry_channel IN
    ('EMAIL','WHATSAPP','PHONE','WEBSITE','WALK_IN','REFERRAL','OTHER')),
  enquiry_details text NOT NULL CHECK (NULLIF(btrim(enquiry_details),'') IS NOT NULL),
  source_evidence_uri text,
  status varchar(12) NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','QUOTED','CANCELLED')),
  sales_owner_id uuid NOT NULL,
  cancelled_by_id uuid,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, customer_id, id),
  FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id),
  FOREIGN KEY (company_id, sales_owner_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, cancelled_by_id) REFERENCES employees(company_id, id),
  CHECK (status <> 'CANCELLED' OR (cancelled_by_id IS NOT NULL AND NULLIF(btrim(cancel_reason),'') IS NOT NULL))
);
CREATE INDEX idx_br11_enquiries_customer ON br11_sales_enquiries(company_id, customer_id, status);

CREATE TABLE br11_enquiry_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  enquiry_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  product_description text NOT NULL CHECK (NULLIF(btrim(product_description),'') IS NOT NULL),
  item_id uuid REFERENCES fdn_item_master(id),
  requested_qty numeric(16,4) NOT NULL CHECK (requested_qty > 0),
  uom varchar(16) NOT NULL,
  desired_condition varchar(12) CHECK (desired_condition IN ('NEW','REFURBISHED','REPAIRED','OTHER')),
  notes text,
  UNIQUE (enquiry_id, line_no),
  FOREIGN KEY (company_id, enquiry_id) REFERENCES br11_sales_enquiries(company_id, id)
);

-- =============================================================================
-- 11A: quotation. PURCHASE creates + releases every priced revision; SALES sends
-- (11A-09). Issued revisions + their lines are immutable. Separate SQ series.
CREATE TABLE br11_sale_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  quote_number varchar(30) NOT NULL UNIQUE,
  customer_id uuid NOT NULL,
  enquiry_id uuid NOT NULL,
  created_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, customer_id, id),
  FOREIGN KEY (company_id, customer_id, enquiry_id) REFERENCES br11_sales_enquiries(company_id, customer_id, id),
  FOREIGN KEY (company_id, created_by_id) REFERENCES employees(company_id, id)
);

CREATE TABLE br11_quote_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no >= 0),
  revision_status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (revision_status IN ('DRAFT','ISSUED','CANCELLED')),
  currency_code char(3) NOT NULL DEFAULT 'INR',
  validity_until date NOT NULL,
  payment_terms_snapshot text,
  delivery_terms_snapshot text,
  warranty_terms_snapshot text,
  tax_terms_snapshot text,
  revision_reason text,
  created_by_id uuid NOT NULL,
  released_by_id uuid,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, quote_id, id),
  UNIQUE (quote_id, revision_no),
  FOREIGN KEY (company_id, quote_id) REFERENCES br11_sale_quotations(company_id, id),
  FOREIGN KEY (company_id, created_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, released_by_id) REFERENCES employees(company_id, id),
  CHECK (revision_no = 0 OR NULLIF(btrim(revision_reason),'') IS NOT NULL),
  CHECK (revision_status <> 'ISSUED' OR (released_by_id IS NOT NULL AND released_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_br11_one_draft_revision ON br11_quote_revisions(quote_id) WHERE revision_status='DRAFT';

-- Prices: integer paise, PRE-TAX. unit_price_paise is the final customer price
-- Purchase types (CLAUDE.md s6); list_unit_price_paise is optional, for showing a
-- discount. No discount/margin band is enforced (11A-05 pending; BR-04's 10% rule
-- does NOT transfer). No supplier cost is stored on a customer quote.
CREATE TABLE br11_quote_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id uuid NOT NULL REFERENCES fdn_item_master(id),
  description_snapshot varchar(300) NOT NULL,
  manufacturer_snapshot varchar(140),
  part_number_snapshot varchar(140),
  specification_snapshot text,
  product_condition varchar(12) NOT NULL CHECK (product_condition IN ('NEW','REFURBISHED','REPAIRED','OTHER')),
  warranty_snapshot text,
  alternative_label varchar(80),
  qty numeric(16,4) NOT NULL CHECK (qty > 0),
  uom varchar(16) NOT NULL,
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0),
  list_unit_price_paise bigint CHECK (list_unit_price_paise IS NULL OR list_unit_price_paise >= unit_price_paise),
  line_total_paise bigint GENERATED ALWAYS AS (round(qty * unit_price_paise)::bigint) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, revision_id, id),
  UNIQUE (revision_id, line_no),
  FOREIGN KEY (company_id, revision_id) REFERENCES br11_quote_revisions(company_id, id)
);

CREATE TABLE br11_quote_dispatch_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  channel varchar(12) NOT NULL CHECK (channel IN ('EMAIL','WHATSAPP','PDF_PRINT','OTHER')),
  recipient_snapshot text NOT NULL CHECK (NULLIF(btrim(recipient_snapshot),'') IS NOT NULL),
  document_evidence_uri text,
  sent_by_id uuid NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, revision_id) REFERENCES br11_quote_revisions(company_id, id),
  FOREIGN KEY (company_id, sent_by_id) REFERENCES employees(company_id, id)
);

CREATE TABLE br11_customer_quote_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  response_kind varchar(14) NOT NULL CHECK (response_kind IN
    ('ENQUIRY','NEGOTIATING','ACCEPTED','PART_ACCEPTED','REJECTED','NO_RESPONSE')),
  notes text,
  response_evidence_uri text,
  recorded_by_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, revision_id) REFERENCES br11_quote_revisions(company_id, id),
  FOREIGN KEY (company_id, recorded_by_id) REFERENCES employees(company_id, id)
);

-- =============================================================================
-- 11B: Sales Order (separate SO ID, never a Job ID: 11C-01). Lines = only the
-- accepted quote lines/quantities (11B-03, 11A-10). Purchase verifies the customer
-- PO / order confirmation / qualifying email (11B-01). SO number assigned at
-- verification.
CREATE TABLE br11_sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  sales_order_number varchar(30) UNIQUE,
  customer_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  quote_revision_id uuid NOT NULL,
  customer_order_reference varchar(160),
  payment_terms_snapshot text,
  delivery_terms_snapshot text,
  status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN
    ('DRAFT','VERIFIED','PART_DELIVERED','DELIVERED','CANCELLED','CLOSED')),
  created_by_id uuid NOT NULL,
  verified_by_id uuid,
  verified_at timestamptz,
  cancelled_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, id, quote_revision_id),
  FOREIGN KEY (company_id, customer_id, quote_id) REFERENCES br11_sale_quotations(company_id, customer_id, id),
  FOREIGN KEY (company_id, quote_id, quote_revision_id) REFERENCES br11_quote_revisions(company_id, quote_id, id),
  FOREIGN KEY (company_id, created_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, verified_by_id) REFERENCES employees(company_id, id),
  CHECK (status IN ('DRAFT','CANCELLED') OR
         (sales_order_number IS NOT NULL AND verified_by_id IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE INDEX idx_br11_orders_status ON br11_sales_orders(company_id, status);

CREATE TABLE br11_sales_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  quote_revision_id uuid NOT NULL,
  quote_line_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id uuid NOT NULL REFERENCES fdn_item_master(id),
  description_snapshot varchar(300) NOT NULL,
  uom varchar(16) NOT NULL,
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0),
  accepted_qty numeric(16,4) NOT NULL CHECK (accepted_qty > 0),
  line_status varchar(16) NOT NULL DEFAULT 'OPEN' CHECK (line_status IN ('OPEN','PART_DELIVERED','DELIVERED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, sales_order_id, id),
  UNIQUE (sales_order_id, line_no),
  UNIQUE (sales_order_id, quote_line_id),
  FOREIGN KEY (company_id, sales_order_id, quote_revision_id)
    REFERENCES br11_sales_orders(company_id, id, quote_revision_id),
  FOREIGN KEY (company_id, quote_revision_id, quote_line_id)
    REFERENCES br11_quote_lines(company_id, revision_id, id)
);
CREATE INDEX idx_br11_order_lines_order ON br11_sales_order_lines(company_id, sales_order_id);

CREATE TABLE br11_order_authorisation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  source_kind varchar(20) NOT NULL CHECK (source_kind IN ('CUSTOMER_PO','ORDER_CONFIRMATION','EMAIL_AUTHORISATION')),
  source_reference varchar(160),
  customer_email_sender varchar(254),
  received_at timestamptz NOT NULL,
  evidence_uri text NOT NULL CHECK (NULLIF(btrim(evidence_uri),'') IS NOT NULL),
  verified_status varchar(10) NOT NULL DEFAULT 'PENDING' CHECK (verified_status IN ('PENDING','VERIFIED','REJECTED')),
  recorded_by_id uuid NOT NULL,
  verified_by_id uuid,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, sales_order_id) REFERENCES br11_sales_orders(company_id, id),
  FOREIGN KEY (company_id, recorded_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, verified_by_id) REFERENCES employees(company_id, id),
  CHECK (source_kind <> 'CUSTOMER_PO' OR NULLIF(btrim(source_reference),'') IS NOT NULL),
  CHECK (source_kind <> 'EMAIL_AUTHORISATION' OR NULLIF(btrim(customer_email_sender),'') IS NOT NULL),
  CHECK (verified_status = 'PENDING' OR (verified_by_id IS NOT NULL AND verified_at IS NOT NULL))
);

-- 11B-02 (SUGGEST, NOT APPROVED): NO blanket advance. Each order's accepted terms
-- say NOT_REQUIRED / FIXED_AMOUNT / PERCENTAGE / FULL. No row = terms not captured
-- = reservation + sales sourcing stay blocked. required_amount_paise is entered by
-- Purchase FROM the accepted terms (the system does not compute a % basis).
-- When an advance is required, FINANCE links the confirmed BR-08 receipt.
CREATE TABLE br11_order_payment_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  sales_order_id uuid NOT NULL UNIQUE,
  advance_kind varchar(14) NOT NULL CHECK (advance_kind IN ('NOT_REQUIRED','FIXED_AMOUNT','PERCENTAGE','FULL')),
  required_amount_paise bigint CHECK (required_amount_paise IS NULL OR required_amount_paise > 0),
  required_percent numeric(7,4) CHECK (required_percent IS NULL OR (required_percent > 0 AND required_percent <= 100)),
  accepted_terms_evidence_uri text NOT NULL CHECK (NULLIF(btrim(accepted_terms_evidence_uri),'') IS NOT NULL),
  recorded_by_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  br08_receipt_id uuid,
  finance_confirmation_reference text,
  finance_confirmed_by_id uuid,
  finance_confirmed_at timestamptz,
  UNIQUE (company_id, id),
  UNIQUE (company_id, sales_order_id),
  FOREIGN KEY (company_id, sales_order_id) REFERENCES br11_sales_orders(company_id, id),
  FOREIGN KEY (company_id, recorded_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, br08_receipt_id) REFERENCES br08_payment_receipts(company_id, id),
  FOREIGN KEY (company_id, finance_confirmed_by_id) REFERENCES employees(company_id, id),
  CHECK ((advance_kind = 'NOT_REQUIRED') = (required_amount_paise IS NULL)),
  CHECK ((advance_kind = 'PERCENTAGE') = (required_percent IS NOT NULL)),
  CHECK ((finance_confirmed_at IS NULL) = (br08_receipt_id IS NULL)),
  CHECK (finance_confirmed_at IS NULL OR (finance_confirmed_by_id IS NOT NULL
         AND NULLIF(btrim(finance_confirmation_reference),'') IS NOT NULL AND advance_kind <> 'NOT_REQUIRED'))
);

-- =============================================================================
-- 11B-04: reservation = request + confirmation by the REAL ledger. CONFIRMED is
-- accepted only if ledger_reservation_id points at an ACTIVE fdn_inventory_reservations
-- row for this request (same company / item / qty / reference). Each request is
-- later converted WHOLE by one outward line (the ledger cannot partially
-- decrement a reservation -- same rule as BR-07).
CREATE TABLE br11_inventory_reservation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  sales_order_line_id uuid NOT NULL,
  requested_qty numeric(16,4) NOT NULL CHECK (requested_qty > 0),
  client_idempotency_key varchar(160) NOT NULL,
  ledger_reservation_id uuid UNIQUE REFERENCES fdn_inventory_reservations(id),
  state varchar(10) NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','CONFIRMED','FAILED','RELEASED','CONSUMED')),
  error_message text,
  requested_by_id uuid NOT NULL,
  confirmed_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, client_idempotency_key),
  FOREIGN KEY (company_id, sales_order_line_id) REFERENCES br11_sales_order_lines(company_id, id),
  FOREIGN KEY (company_id, requested_by_id) REFERENCES employees(company_id, id),
  CHECK (state NOT IN ('CONFIRMED','RELEASED','CONSUMED') OR (ledger_reservation_id IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (state <> 'FAILED' OR NULLIF(btrim(error_message),'') IS NOT NULL)
);
CREATE INDEX idx_br11_resv_line ON br11_inventory_reservation_requests(company_id, sales_order_line_id, state);

-- =============================================================================
-- 11C: outward (separate SOUT series), packing photo per line (11C-02), modes
-- (11C-03), custody leaves at dispatch through a ledger ISSUE (MAIN_STORE -> out),
-- delivery confirmed only by line-specific POD (11C-04).
CREATE TABLE br11_outward_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  outward_number varchar(30) UNIQUE,
  customer_id uuid NOT NULL,
  dispatch_mode varchar(16) NOT NULL CHECK (dispatch_mode IN ('COURIER','CUSTOMER_PICKUP','OWN_TRANSPORT','OTHER')),
  dispatch_mode_note text,
  recipient_name varchar(150) NOT NULL,
  destination_address text NOT NULL,
  carrier_name varchar(180),
  tracking_reference varchar(180),
  status varchar(12) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','DISPATCHED','CANCELLED')),
  created_by_id uuid NOT NULL,
  dispatched_by_id uuid,
  dispatched_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id),
  FOREIGN KEY (company_id, created_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, dispatched_by_id) REFERENCES employees(company_id, id),
  CHECK (dispatch_mode <> 'OTHER' OR NULLIF(btrim(dispatch_mode_note),'') IS NOT NULL),
  CHECK (dispatch_mode <> 'COURIER' OR NULLIF(btrim(carrier_name),'') IS NOT NULL),
  CHECK (status <> 'DISPATCHED' OR (outward_number IS NOT NULL AND dispatched_by_id IS NOT NULL AND dispatched_at IS NOT NULL))
);

CREATE TABLE br11_outward_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  outward_batch_id uuid NOT NULL,
  sales_order_line_id uuid NOT NULL,
  reservation_request_id uuid NOT NULL,
  item_id uuid NOT NULL REFERENCES fdn_item_master(id),
  uom varchar(16) NOT NULL,
  outward_qty numeric(16,4) NOT NULL CHECK (outward_qty > 0),
  status varchar(12) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PICKED','DISPATCHED','DELIVERED')),
  verification_note text,
  serial_numbers text[],
  pick_confirmed_by_id uuid,
  pick_confirmed_at timestamptz,
  inventory_issue_ref uuid REFERENCES fdn_inventory_journal(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, outward_batch_id) REFERENCES br11_outward_batches(company_id, id),
  FOREIGN KEY (company_id, sales_order_line_id) REFERENCES br11_sales_order_lines(company_id, id),
  FOREIGN KEY (company_id, reservation_request_id) REFERENCES br11_inventory_reservation_requests(company_id, id),
  FOREIGN KEY (company_id, pick_confirmed_by_id) REFERENCES employees(company_id, id),
  CHECK (status = 'DRAFT' OR (pick_confirmed_by_id IS NOT NULL AND pick_confirmed_at IS NOT NULL
                              AND NULLIF(btrim(verification_note),'') IS NOT NULL)),
  CHECK (status NOT IN ('DISPATCHED','DELIVERED') OR inventory_issue_ref IS NOT NULL)
);
CREATE INDEX idx_br11_outward_line_sol ON br11_outward_lines(company_id, sales_order_line_id);

CREATE TABLE br11_packing_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  outward_line_id uuid NOT NULL,
  evidence_kind varchar(14) NOT NULL CHECK (evidence_kind IN ('PHOTO','VIDEO','PACKING_LIST','SERIAL_LABEL','OTHER')),
  file_uri text NOT NULL CHECK (NULLIF(btrim(file_uri),'') IS NOT NULL),
  file_name varchar(255) NOT NULL,
  captured_by_id uuid NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, outward_line_id) REFERENCES br11_outward_lines(company_id, id),
  FOREIGN KEY (company_id, captured_by_id) REFERENCES employees(company_id, id)
);

CREATE TABLE br11_carrier_tracking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  outward_batch_id uuid NOT NULL,
  status_note text NOT NULL CHECK (NULLIF(btrim(status_note),'') IS NOT NULL),
  provider_event_ref varchar(160),
  occurred_at timestamptz NOT NULL,
  recorded_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, outward_batch_id) REFERENCES br11_outward_batches(company_id, id),
  FOREIGN KEY (company_id, recorded_by_id) REFERENCES employees(company_id, id)
);

CREATE TABLE br11_delivery_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  outward_line_id uuid NOT NULL,
  delivery_status varchar(10) NOT NULL CHECK (delivery_status IN ('DELIVERED','FAILED','DAMAGED')),
  delivered_qty numeric(16,4) NOT NULL DEFAULT 0 CHECK (delivered_qty >= 0),
  received_by_name varchar(150),
  delivered_at timestamptz,
  pod_uri text,
  remarks text,
  recorded_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, outward_line_id) REFERENCES br11_outward_lines(company_id, id),
  FOREIGN KEY (company_id, recorded_by_id) REFERENCES employees(company_id, id),
  CHECK (delivery_status <> 'DELIVERED' OR (delivered_qty > 0 AND NULLIF(btrim(pod_uri),'') IS NOT NULL
         AND delivered_at IS NOT NULL AND NULLIF(btrim(received_by_name),'') IS NOT NULL)),
  CHECK (delivery_status = 'DELIVERED' OR (delivered_qty = 0 AND NULLIF(btrim(remarks),'') IS NOT NULL))
);
CREATE UNIQUE INDEX uq_br11_one_pod_per_outward_line ON br11_delivery_evidence(outward_line_id)
  WHERE delivery_status='DELIVERED';

-- 11B-09/10: change requests. PURCHASE decides. Only an APPROVED CANCELLATION
-- changes data (line or whole order); other kinds are recorded decisions -- a price,
-- quantity or substitution change needs a new quote revision + order (11B-03).
CREATE TABLE br11_sales_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  sales_order_line_id uuid,
  change_kind varchar(18) NOT NULL CHECK (change_kind IN
    ('PRICE','QTY','CANCELLATION','SUBSTITUTION','BACKORDER_REMOVAL','DELIVERY_DATE','OTHER')),
  reason text NOT NULL CHECK (NULLIF(btrim(reason),'') IS NOT NULL),
  customer_evidence_uri text,
  technical_approval_evidence_uri text,
  financial_impact_description text,
  decision varchar(10) NOT NULL DEFAULT 'PENDING' CHECK (decision IN ('PENDING','APPROVED','REJECTED')),
  decision_note text,
  requested_by_id uuid NOT NULL,
  decided_by_id uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, sales_order_id) REFERENCES br11_sales_orders(company_id, id),
  FOREIGN KEY (company_id, sales_order_id, sales_order_line_id) REFERENCES br11_sales_order_lines(company_id, sales_order_id, id),
  FOREIGN KEY (company_id, requested_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, decided_by_id) REFERENCES employees(company_id, id),
  CHECK (decision = 'PENDING' OR (decided_by_id IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (change_kind <> 'SUBSTITUTION' OR decision <> 'APPROVED'
         OR (technical_approval_evidence_uri IS NOT NULL AND customer_evidence_uri IS NOT NULL))
);

-- 11C-09: closure review. Inserted only as an APPROVED review by PURCHASE; the DB
-- computes every verification flag itself (never caller-attested).
CREATE TABLE br11_sales_order_closure_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  sales_order_id uuid NOT NULL UNIQUE,
  closure_reason text NOT NULL CHECK (NULLIF(btrim(closure_reason),'') IS NOT NULL),
  delivery_verified boolean NOT NULL,
  billing_verified boolean NOT NULL,
  payment_required boolean NOT NULL,
  payment_verified boolean NOT NULL,
  finance_evidence jsonb NOT NULL CHECK (jsonb_typeof(finance_evidence)='array'),
  reviewed_by_id uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sales_order_id),
  FOREIGN KEY (company_id, sales_order_id) REFERENCES br11_sales_orders(company_id, id),
  FOREIGN KEY (company_id, reviewed_by_id) REFERENCES employees(company_id, id),
  CHECK (delivery_verified AND billing_verified AND (NOT payment_required OR payment_verified))
);

-- =============================================================================
-- BR-06 extension: SALES_ORDER purchase purpose (11B-06). Repair (CUSTOMER_JOB)
-- path is unchanged: its three source columns stay mandatory for CUSTOMER_JOB.
ALTER TABLE br06_supplier_purchase_orders
  ADD COLUMN purchase_purpose varchar(16) NOT NULL DEFAULT 'CUSTOMER_JOB',
  ADD COLUMN sales_order_id uuid,
  ADD COLUMN supplier_id uuid REFERENCES fdn_suppliers(id);
ALTER TABLE br06_supplier_purchase_orders
  ADD CONSTRAINT br06_po_purchase_purpose_check CHECK (purchase_purpose IN ('CUSTOMER_JOB','SALES_ORDER'));
ALTER TABLE br06_supplier_purchase_orders
  ALTER COLUMN job_id DROP NOT NULL,
  ALTER COLUMN source_br05_job_release_id DROP NOT NULL,
  ALTER COLUMN supplier_invite_id DROP NOT NULL;
ALTER TABLE br06_supplier_purchase_orders
  ADD CONSTRAINT br06_po_purpose_source_check CHECK (
    (purchase_purpose = 'CUSTOMER_JOB' AND job_id IS NOT NULL AND source_br05_job_release_id IS NOT NULL
       AND supplier_invite_id IS NOT NULL AND sales_order_id IS NULL)
    OR (purchase_purpose = 'SALES_ORDER' AND job_id IS NULL AND source_br05_job_release_id IS NULL
       AND supplier_invite_id IS NULL AND sales_order_id IS NOT NULL)),
  ADD CONSTRAINT br06_po_sales_order_fk FOREIGN KEY (company_id, sales_order_id)
    REFERENCES br11_sales_orders(company_id, id);

-- Supplier sourcing authorisation for ONE exact sale line (BR-06 owned). Purchase
-- authorises (normal unlimited PO authority -- DOFA still unset); a non-L1 supplier
-- (selected_rank > 1) needs MD approval evidence, same evidence shape as BR-04.
-- supplier_id is optional: the canonical supplier master has no approval flow yet
-- (same as the repair PO, which only snapshots the supplier name).
CREATE TABLE br06_sales_sourcing_authorisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  sales_order_line_id uuid NOT NULL,
  quantity numeric(16,4) NOT NULL CHECK (quantity > 0),
  supplier_id uuid REFERENCES fdn_suppliers(id),
  supplier_name_snapshot varchar(200) NOT NULL CHECK (NULLIF(btrim(supplier_name_snapshot),'') IS NOT NULL),
  supplier_unit_price numeric(18,4) NOT NULL CHECK (supplier_unit_price >= 0),
  supplier_offer_evidence_uri text NOT NULL CHECK (NULLIF(btrim(supplier_offer_evidence_uri),'') IS NOT NULL),
  comparison_evidence_uri text NOT NULL CHECK (NULLIF(btrim(comparison_evidence_uri),'') IS NOT NULL),
  selected_rank integer NOT NULL CHECK (selected_rank > 0),
  md_approved_by_id uuid,
  md_approved_at timestamptz,
  md_approval_evidence_uri text,
  authorisation_status varchar(10) NOT NULL DEFAULT 'APPROVED' CHECK (authorisation_status IN ('APPROVED','CANCELLED')),
  authorised_by_id uuid NOT NULL,
  authorised_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, sales_order_line_id) REFERENCES br11_sales_order_lines(company_id, id),
  FOREIGN KEY (company_id, md_approved_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, authorised_by_id) REFERENCES employees(company_id, id),
  CHECK (selected_rank = 1 OR (md_approved_by_id IS NOT NULL AND md_approved_at IS NOT NULL
         AND NULLIF(btrim(md_approval_evidence_uri),'') IS NOT NULL))
);

ALTER TABLE br06_po_lines
  ALTER COLUMN source_br04_offer_line_id DROP NOT NULL,
  ADD COLUMN sales_sourcing_authorisation_id uuid UNIQUE REFERENCES br06_sales_sourcing_authorisations(id);
ALTER TABLE br06_po_lines
  ADD CONSTRAINT br06_po_line_source_check
  CHECK ((source_br04_offer_line_id IS NULL) <> (sales_sourcing_authorisation_id IS NULL));

-- =============================================================================
-- BR-08 extension: PRODUCT_SALES invoice type under the SAME br08_invoices
-- (same INV series via br08_next_doc_number, same Finance-only issue, same
-- immutability, same receipts/allocations/credit notes). Product lines live in
-- br08_invoice_sales_lines -- never a fabricated repair Job ID.
ALTER TABLE br08_invoices ADD COLUMN invoice_type varchar(14) NOT NULL DEFAULT 'REPAIR';
ALTER TABLE br08_invoices ADD CONSTRAINT br08_invoices_invoice_type_check
  CHECK (invoice_type IN ('REPAIR','PRODUCT_SALES'));

-- Product GST rate/HSN is CLIENT-UNCONFIRMED (P-12): add the config key only.
-- No PRODUCT_SALE row is seeded and there is NO fallback to the repair default
-- SAC 998732, so product invoicing stays blocked until Finance configures it.
ALTER TABLE br08_gst_rate_config DROP CONSTRAINT br08_gst_rate_config_quote_line_type_check;
ALTER TABLE br08_gst_rate_config ADD CONSTRAINT br08_gst_rate_config_quote_line_type_check
  CHECK (quote_line_type IN ('REPAIR_SERVICE','MATERIAL','LABOUR','INSPECTION','TESTING','EXTERNAL','FREIGHT','OTHER',
                             'PRODUCT_SALE'));

CREATE TABLE br08_sales_invoice_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  invoice_id uuid NOT NULL UNIQUE,
  sales_order_id uuid NOT NULL,
  invoice_trigger_snapshot varchar(12) NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, invoice_id),
  UNIQUE (company_id, idempotency_key),
  FOREIGN KEY (company_id, invoice_id) REFERENCES br08_invoices(company_id, id),
  FOREIGN KEY (company_id, sales_order_id) REFERENCES br11_sales_orders(company_id, id)
);

CREATE TABLE br08_invoice_sales_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  sales_order_line_id uuid NOT NULL,
  item_id uuid NOT NULL REFERENCES fdn_item_master(id),
  description text NOT NULL,
  hsn_sac varchar(8) NOT NULL,
  quantity numeric(16,4) NOT NULL CHECK (quantity > 0),
  uom varchar(16) NOT NULL,
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0),
  taxable_paise bigint NOT NULL CHECK (taxable_paise >= 0),
  cgst_rate numeric(5,2) NOT NULL,
  sgst_rate numeric(5,2) NOT NULL,
  igst_rate numeric(5,2) NOT NULL,
  cgst_paise bigint NOT NULL CHECK (cgst_paise >= 0),
  sgst_paise bigint NOT NULL CHECK (sgst_paise >= 0),
  igst_paise bigint NOT NULL CHECK (igst_paise >= 0),
  line_total_paise bigint NOT NULL,
  UNIQUE (invoice_id, line_no),
  FOREIGN KEY (company_id, invoice_id) REFERENCES br08_invoices(company_id, id),
  FOREIGN KEY (company_id, sales_order_line_id) REFERENCES br11_sales_order_lines(company_id, id),
  CHECK (line_total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise)
);
CREATE INDEX idx_br08_sales_lines_sol ON br08_invoice_sales_lines(sales_order_line_id);

-- =============================================================================
-- Derived quantities (one authoritative computation each)
CREATE OR REPLACE FUNCTION br11_line_delivered_qty(p_line uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(de.delivered_qty),0) FROM br11_delivery_evidence de
    JOIN br11_outward_lines ol ON ol.id=de.outward_line_id
   WHERE ol.sales_order_line_id=p_line AND de.delivery_status='DELIVERED';
$$;

CREATE OR REPLACE FUNCTION br11_line_shipped_qty(p_line uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(ol.outward_qty),0) FROM br11_outward_lines ol
    JOIN br11_outward_batches b ON b.id=ol.outward_batch_id
   WHERE ol.sales_order_line_id=p_line AND b.status='DISPATCHED';
$$;

-- Live = on an invoice that is not CANCELLED (a credit note releases the quantity).
CREATE OR REPLACE FUNCTION br11_line_invoiced_qty(p_line uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(sl.quantity),0) FROM br08_invoice_sales_lines sl
    JOIN br08_invoices i ON i.id=sl.invoice_id
   WHERE sl.sales_order_line_id=p_line AND i.invoice_status<>'CANCELLED';
$$;

-- Invoiceable ceiling per line under the company's CLIENT-UNCONFIRMED trigger (11C-07).
CREATE OR REPLACE FUNCTION br11_line_invoiceable_qty(p_line uuid)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE l br11_sales_order_lines%ROWTYPE; v_trigger text;
BEGIN
  SELECT * INTO l FROM br11_sales_order_lines WHERE id=p_line;
  IF NOT FOUND THEN RAISE EXCEPTION 'BR11: sales order line not found'; END IF;
  IF l.line_status = 'CANCELLED' THEN RETURN 0; END IF;
  SELECT invoice_trigger INTO v_trigger FROM br11_company_policies WHERE company_id=l.company_id;
  IF v_trigger IS NULL THEN
    RAISE EXCEPTION 'BR11: CLIENT-UNCONFIRMED -- product-sales invoice trigger (11C-07) is not configured for this company';
  END IF;
  RETURN CASE v_trigger
    WHEN 'ADVANCE'  THEN l.accepted_qty
    WHEN 'DISPATCH' THEN br11_line_shipped_qty(p_line)
    WHEN 'DELIVERY' THEN br11_line_delivered_qty(p_line)
    ELSE NULL END;
  -- MILESTONE: no milestone schedule exists in any accepted document.
END $$;

-- Advance gate (11B-02 hook): terms must be captured; if they require an advance,
-- Finance must have confirmed a BR-08 receipt against it.
CREATE OR REPLACE FUNCTION br11_assert_advance_cleared(p_order uuid)
RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE pc br11_order_payment_conditions%ROWTYPE;
BEGIN
  SELECT * INTO pc FROM br11_order_payment_conditions WHERE sales_order_id=p_order;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BR11: the customer-agreed payment terms for this order are not recorded (11B-02: no blanket advance rule; capture the accepted terms first)';
  END IF;
  IF pc.advance_kind <> 'NOT_REQUIRED' AND pc.finance_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'BR11: the accepted terms require an advance (%) -- Finance must confirm the BR-08 receipt first', pc.advance_kind;
  END IF;
END $$;

-- =============================================================================
-- Guards: enquiry
CREATE OR REPLACE FUNCTION br11_guard_enquiry()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.sales_owner_id, 'SALES') THEN
      RAISE EXCEPTION 'BR11: only Sales registers a product-sales enquiry';
    END IF;
    IF NEW.status <> 'RECEIVED' THEN RAISE EXCEPTION 'BR11: an enquiry starts RECEIVED'; END IF;
    NEW.enquiry_number := br11_next_number(NEW.company_id, 'SE');
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','cancelled_by_id','cancel_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','cancelled_by_id','cancel_reason']) THEN
    RAISE EXCEPTION 'BR11: an enquiry is immutable once registered';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.cancelled_by_id IS DISTINCT FROM OLD.cancelled_by_id OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason THEN
      RAISE EXCEPTION 'BR11: an enquiry is immutable once registered';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'RECEIVED' AND NEW.status = 'QUOTED' AND pg_trigger_depth() >= 2 THEN RETURN NEW; END IF;
  IF OLD.status IN ('RECEIVED','QUOTED') AND NEW.status = 'CANCELLED' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.cancelled_by_id, 'SALES') THEN
      RAISE EXCEPTION 'BR11: only Sales cancels an enquiry';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'BR11: enquiry status % -> % is not allowed', OLD.status, NEW.status;
END $$;
CREATE TRIGGER trg_br11_enquiry BEFORE INSERT OR UPDATE ON br11_sales_enquiries
  FOR EACH ROW EXECUTE FUNCTION br11_guard_enquiry();
CREATE TRIGGER trg_br11_enquiry_nodelete BEFORE DELETE ON br11_sales_enquiries
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br11_guard_enquiry_line()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- lines are written only in the transaction that registers the enquiry
  IF NOT EXISTS (SELECT 1 FROM br11_sales_enquiries WHERE id=NEW.enquiry_id AND company_id=NEW.company_id
                    AND xmin::text = (pg_current_xact_id()::xid)::text) THEN
    RAISE EXCEPTION 'BR11: enquiry lines are recorded with the enquiry and are immutable afterwards';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br11_enquiry_line BEFORE INSERT ON br11_enquiry_lines
  FOR EACH ROW EXECUTE FUNCTION br11_guard_enquiry_line();
CREATE TRIGGER trg_br11_enquiry_line_append_only BEFORE UPDATE OR DELETE ON br11_enquiry_lines
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- Guards: quotation header
CREATE OR REPLACE FUNCTION br11_guard_quote()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_enq_status text;
BEGIN
  IF NOT br08_has_role(NEW.company_id, NEW.created_by_id, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR11: only Purchase prepares a priced sales quotation (11A-01/11A-09)';
  END IF;
  SELECT status INTO v_enq_status FROM br11_sales_enquiries WHERE id=NEW.enquiry_id FOR UPDATE;
  IF v_enq_status = 'CANCELLED' THEN RAISE EXCEPTION 'BR11: the enquiry is cancelled'; END IF;
  NEW.quote_number := br11_next_number(NEW.company_id, 'SQ');
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION br11_apply_quote()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE br11_sales_enquiries SET status='QUOTED' WHERE id=NEW.enquiry_id AND status='RECEIVED';
  RETURN NULL;
END $$;
CREATE TRIGGER trg_br11_quote BEFORE INSERT ON br11_sale_quotations
  FOR EACH ROW EXECUTE FUNCTION br11_guard_quote();
CREATE TRIGGER trg_br11_quote_apply AFTER INSERT ON br11_sale_quotations
  FOR EACH ROW EXECUTE FUNCTION br11_apply_quote();
CREATE TRIGGER trg_br11_quote_append_only BEFORE UPDATE OR DELETE ON br11_sale_quotations
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- Guards: quote revision (11A-03 customer approval + 11A-04 approved item at ISSUE)
CREATE OR REPLACE FUNCTION br11_guard_quote_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_cust text; v_bad integer; v_n integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.created_by_id, 'PURCHASE') THEN
      RAISE EXCEPTION 'BR11: only Purchase creates a priced quote revision';
    END IF;
    IF NEW.revision_status <> 'DRAFT' OR NEW.released_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'BR11: a quote revision starts DRAFT';
    END IF;
    PERFORM 1 FROM br11_sale_quotations WHERE id=NEW.quote_id FOR UPDATE;
    SELECT COALESCE(max(revision_no)+1, 0) INTO NEW.revision_no FROM br11_quote_revisions WHERE quote_id=NEW.quote_id;
    IF NEW.revision_no > 0 AND NULLIF(btrim(NEW.revision_reason),'') IS NULL THEN
      RAISE EXCEPTION 'BR11: a quote revision after the first needs a revision reason';
    END IF;
    NEW.created_at := now(); NEW.released_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.revision_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'BR11: an % quote revision is immutable -- create a new revision', OLD.revision_status;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['revision_status','released_by_id','released_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revision_status','released_by_id','released_at']) THEN
    RAISE EXCEPTION 'BR11: quote revision terms are fixed at creation -- create a new revision';
  END IF;
  IF NEW.revision_status = 'ISSUED' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.released_by_id, 'PURCHASE') THEN
      RAISE EXCEPTION 'BR11: only Purchase releases a priced quote revision (11A-09)';
    END IF;
    SELECT c.status INTO v_cust FROM br11_sale_quotations q JOIN customers c ON c.id=q.customer_id WHERE q.id=NEW.quote_id;
    IF v_cust IS DISTINCT FROM 'APPROVED' THEN
      RAISE EXCEPTION 'BR11: quotation issue is blocked until the customer is APPROVED (11A-03) -- customer is %', v_cust;
    END IF;
    SELECT count(*), count(*) FILTER (WHERE i.status NOT IN ('APPROVED','ACTIVE')) INTO v_n, v_bad
      FROM br11_quote_lines l JOIN fdn_item_master i ON i.id=l.item_id WHERE l.revision_id=NEW.id;
    IF v_n = 0 THEN RAISE EXCEPTION 'BR11: a quote revision needs at least one line before issue'; END IF;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'BR11: quotation issue requires every line item to be APPROVED/ACTIVE in the Item Master (11A-04) -- % line(s) are not', v_bad;
    END IF;
    IF NEW.validity_until < br08_local_today(NEW.company_id) THEN
      RAISE EXCEPTION 'BR11: validity date is already in the past';
    END IF;
    NEW.released_at := now();
    RETURN NEW;
  ELSIF NEW.revision_status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'BR11: no change to a DRAFT revision other than issue or cancel';
END $$;
CREATE TRIGGER trg_br11_quote_revision BEFORE INSERT OR UPDATE ON br11_quote_revisions
  FOR EACH ROW EXECUTE FUNCTION br11_guard_quote_revision();
CREATE TRIGGER trg_br11_quote_revision_nodelete BEFORE DELETE ON br11_quote_revisions
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br11_guard_quote_line()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_rev uuid; v_company uuid; it fdn_item_master%ROWTYPE;
BEGIN
  v_rev := CASE WHEN TG_OP='DELETE' THEN OLD.revision_id ELSE NEW.revision_id END;
  v_company := CASE WHEN TG_OP='DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  SELECT revision_status INTO v_status FROM br11_quote_revisions WHERE id=v_rev AND company_id=v_company FOR UPDATE;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'BR11: an issued/cancelled sales quote line is immutable -- create a new revision';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'BR11: quote lines are not edited in place -- cancel the revision and create a new one'; END IF;
  SELECT * INTO it FROM fdn_item_master WHERE id=NEW.item_id;
  NEW.uom := it.base_uom;
  SELECT COALESCE(max(line_no)+1, 1) INTO NEW.line_no FROM br11_quote_lines WHERE revision_id=NEW.revision_id;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br11_quote_line BEFORE INSERT OR UPDATE OR DELETE ON br11_quote_lines
  FOR EACH ROW EXECUTE FUNCTION br11_guard_quote_line();

CREATE OR REPLACE FUNCTION br11_guard_quote_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_actor uuid;
BEGIN
  SELECT revision_status INTO v_status FROM br11_quote_revisions WHERE id=NEW.revision_id AND company_id=NEW.company_id;
  IF v_status IS DISTINCT FROM 'ISSUED' THEN RAISE EXCEPTION 'BR11: the quote revision has not been issued by Purchase'; END IF;
  -- separate statements: plpgsql plans each lazily, and only one table has each column
  IF TG_TABLE_NAME = 'br11_quote_dispatch_events' THEN v_actor := NEW.sent_by_id;
  ELSE v_actor := NEW.recorded_by_id; END IF;
  IF NOT br08_has_role(NEW.company_id, v_actor, 'SALES') THEN
    RAISE EXCEPTION 'BR11: customer communication on a quotation is a Sales action';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br11_quote_dispatch BEFORE INSERT ON br11_quote_dispatch_events
  FOR EACH ROW EXECUTE FUNCTION br11_guard_quote_event();
CREATE TRIGGER trg_br11_quote_dispatch_append_only BEFORE UPDATE OR DELETE ON br11_quote_dispatch_events
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();
CREATE TRIGGER trg_br11_quote_response BEFORE INSERT ON br11_customer_quote_responses
  FOR EACH ROW EXECUTE FUNCTION br11_guard_quote_event();
CREATE TRIGGER trg_br11_quote_response_append_only BEFORE UPDATE OR DELETE ON br11_customer_quote_responses
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- =============================================================================
-- Guards: Sales Order
CREATE OR REPLACE FUNCTION br11_assert_orderable_revision(p_company uuid, p_quote uuid, p_revision uuid)
RETURNS br11_quote_revisions LANGUAGE plpgsql STABLE AS $$
DECLARE rv br11_quote_revisions%ROWTYPE;
BEGIN
  SELECT * INTO rv FROM br11_quote_revisions WHERE id=p_revision AND quote_id=p_quote AND company_id=p_company;
  IF NOT FOUND OR rv.revision_status <> 'ISSUED' THEN
    RAISE EXCEPTION 'BR11: a Sales Order must be against an ISSUED quote revision';
  END IF;
  IF EXISTS (SELECT 1 FROM br11_quote_revisions WHERE quote_id=p_quote AND revision_status='ISSUED' AND revision_no > rv.revision_no) THEN
    RAISE EXCEPTION 'BR11: quote revision % has been superseded by a later issued revision', rv.revision_no;
  END IF;
  IF rv.validity_until < br08_local_today(p_company) THEN
    RAISE EXCEPTION 'BR11: quote revision % expired on %', rv.revision_no, rv.validity_until;
  END IF;
  RETURN rv;
END $$;

CREATE OR REPLACE FUNCTION br11_guard_sales_order()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rv br11_quote_revisions%ROWTYPE;
        frozen text[] := ARRAY['status','sales_order_number','verified_by_id','verified_at','cancelled_at','closed_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br11_has_any_role(NEW.company_id, NEW.created_by_id, ARRAY['SALES','PURCHASE']) THEN
      RAISE EXCEPTION 'BR11: only Sales or Purchase drafts a Sales Order';
    END IF;
    IF NEW.status <> 'DRAFT' OR NEW.sales_order_number IS NOT NULL OR NEW.verified_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'BR11: a Sales Order starts DRAFT and unnumbered (the number is assigned at verification)';
    END IF;
    rv := br11_assert_orderable_revision(NEW.company_id, NEW.quote_id, NEW.quote_revision_id);
    NEW.payment_terms_snapshot := rv.payment_terms_snapshot;
    NEW.delivery_terms_snapshot := rv.delivery_terms_snapshot;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - frozen) IS DISTINCT FROM (to_jsonb(OLD) - frozen) THEN
    RAISE EXCEPTION 'BR11: Sales Order header is immutable (changes go through a change request / new quote revision)';
  END IF;
  IF OLD.status IN ('CLOSED','CANCELLED') THEN
    RAISE EXCEPTION 'BR11: a % Sales Order cannot change (no direct status rollback)', OLD.status;
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.sales_order_number IS DISTINCT FROM OLD.sales_order_number OR NEW.verified_by_id IS DISTINCT FROM OLD.verified_by_id
       OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
      RAISE EXCEPTION 'BR11: Sales Order verification fields are immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'VERIFIED' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.verified_by_id, 'PURCHASE') THEN
      RAISE EXCEPTION 'BR11: only Purchase verifies a Sales Order (11B-01)';
    END IF;
    PERFORM br11_assert_orderable_revision(NEW.company_id, NEW.quote_id, NEW.quote_revision_id);
    IF NOT EXISTS (SELECT 1 FROM br11_sales_order_lines WHERE sales_order_id=NEW.id) THEN
      RAISE EXCEPTION 'BR11: a Sales Order needs at least one accepted line';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM br11_order_authorisation_events WHERE sales_order_id=NEW.id AND verified_status='VERIFIED') THEN
      RAISE EXCEPTION 'BR11: verified customer authorisation (PO / order confirmation / qualifying email) is missing (11B-01)';
    END IF;
    NEW.sales_order_number := br11_next_number(NEW.company_id, 'SO');
    NEW.verified_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'CANCELLED' THEN
    NEW.cancelled_at := now();
    RETURN NEW;
  END IF;
  -- Fulfilment states and post-verification cancellation are derived by the DB
  -- (delivery evidence / approved change request), never set directly.
  IF OLD.status IN ('VERIFIED','PART_DELIVERED','DELIVERED') AND NEW.status IN ('VERIFIED','PART_DELIVERED','DELIVERED','CANCELLED')
     AND pg_trigger_depth() >= 2 THEN
    IF NEW.status = 'CANCELLED' THEN NEW.cancelled_at := now(); END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'DELIVERED' AND NEW.status = 'CLOSED' AND pg_trigger_depth() >= 2
     AND EXISTS (SELECT 1 FROM br11_sales_order_closure_reviews WHERE sales_order_id=NEW.id) THEN
    NEW.closed_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'BR11: Sales Order status % -> % is not allowed directly', OLD.status, NEW.status;
END $$;
CREATE TRIGGER trg_br11_sales_order BEFORE INSERT OR UPDATE ON br11_sales_orders
  FOR EACH ROW EXECUTE FUNCTION br11_guard_sales_order();
CREATE TRIGGER trg_br11_sales_order_nodelete BEFORE DELETE ON br11_sales_orders
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br11_guard_sales_order_line()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; ql br11_quote_lines%ROWTYPE;
BEGIN
  SELECT status INTO v_status FROM br11_sales_orders
   WHERE id = CASE WHEN TG_OP='DELETE' THEN OLD.sales_order_id ELSE NEW.sales_order_id END FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    IF v_status <> 'DRAFT' THEN RAISE EXCEPTION 'BR11: lines can only be added to a DRAFT Sales Order'; END IF;
    SELECT * INTO ql FROM br11_quote_lines WHERE id=NEW.quote_line_id AND revision_id=NEW.quote_revision_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'BR11: the quote line is not on the order''s quote revision'; END IF;
    IF NEW.accepted_qty > ql.qty THEN
      RAISE EXCEPTION 'BR11: accepted quantity % exceeds the quoted quantity % (11B-03)', NEW.accepted_qty, ql.qty;
    END IF;
    -- price/product are snapshots of the issued quote line (Sales cannot set them).
    NEW.item_id := ql.item_id; NEW.description_snapshot := ql.description_snapshot;
    NEW.uom := ql.uom; NEW.unit_price_paise := ql.unit_price_paise;
    NEW.line_status := 'OPEN';
    SELECT COALESCE(max(line_no)+1, 1) INTO NEW.line_no FROM br11_sales_order_lines WHERE sales_order_id=NEW.sales_order_id;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF v_status <> 'DRAFT' THEN RAISE EXCEPTION 'BR11: a verified Sales Order line is immutable'; END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'line_status') IS DISTINCT FROM (to_jsonb(OLD) - 'line_status') THEN
    RAISE EXCEPTION 'BR11: a Sales Order line is immutable (use a change request)';
  END IF;
  IF NEW.line_status IS DISTINCT FROM OLD.line_status AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'BR11: line status is derived from delivery evidence / approved change requests';
  END IF;
  IF OLD.line_status = 'CANCELLED' AND NEW.line_status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'BR11: a cancelled line stays cancelled';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br11_sales_order_line BEFORE INSERT OR UPDATE OR DELETE ON br11_sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION br11_guard_sales_order_line();

CREATE OR REPLACE FUNCTION br11_guard_order_authorisation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM br11_sales_orders WHERE id=NEW.sales_order_id AND company_id=NEW.company_id;
  IF TG_OP = 'INSERT' THEN
    IF v_status <> 'DRAFT' THEN RAISE EXCEPTION 'BR11: customer authorisation evidence is attached to a DRAFT Sales Order'; END IF;
    IF NOT br11_has_any_role(NEW.company_id, NEW.recorded_by_id, ARRAY['SALES','PURCHASE']) THEN
      RAISE EXCEPTION 'BR11: only Sales or Purchase records customer authorisation evidence';
    END IF;
    IF NEW.verified_status <> 'PENDING' OR NEW.verified_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'BR11: authorisation evidence starts PENDING';
    END IF;
    IF NEW.received_at > now() THEN RAISE EXCEPTION 'BR11: received time cannot be in the future'; END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['verified_status','verified_by_id','verified_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['verified_status','verified_by_id','verified_at'])
     OR OLD.verified_status <> 'PENDING' OR NEW.verified_status = 'PENDING' THEN
    RAISE EXCEPTION 'BR11: authorisation evidence is immutable once verified/rejected';
  END IF;
  IF v_status <> 'DRAFT' THEN RAISE EXCEPTION 'BR11: the Sales Order is no longer DRAFT'; END IF;
  IF NOT br08_has_role(NEW.company_id, NEW.verified_by_id, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR11: only Purchase verifies customer authorisation (11B-01)';
  END IF;
  NEW.verified_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br11_order_authorisation BEFORE INSERT OR UPDATE ON br11_order_authorisation_events
  FOR EACH ROW EXECUTE FUNCTION br11_guard_order_authorisation();
CREATE TRIGGER trg_br11_order_authorisation_nodelete BEFORE DELETE ON br11_order_authorisation_events
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br11_guard_payment_condition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE so br11_sales_orders%ROWTYPE; rc br08_payment_receipts%ROWTYPE; v_used bigint;
BEGIN
  SELECT * INTO so FROM br11_sales_orders WHERE id=NEW.sales_order_id AND company_id=NEW.company_id;
  IF so.status IN ('CANCELLED','CLOSED') THEN RAISE EXCEPTION 'BR11: the Sales Order is %', so.status; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.recorded_by_id, 'PURCHASE') THEN
      RAISE EXCEPTION 'BR11: only Purchase records the accepted order payment terms';
    END IF;
    IF NEW.br08_receipt_id IS NOT NULL OR NEW.finance_confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'BR11: an advance receipt is confirmed by Finance separately';
    END IF;
    NEW.recorded_at := now();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['br08_receipt_id','finance_confirmation_reference','finance_confirmed_by_id','finance_confirmed_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['br08_receipt_id','finance_confirmation_reference','finance_confirmed_by_id','finance_confirmed_at'])
     OR OLD.finance_confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'BR11: recorded payment terms / a confirmed advance are immutable';
  END IF;
  IF NOT br08_has_role(NEW.company_id, NEW.finance_confirmed_by_id, 'FINANCE') THEN
    RAISE EXCEPTION 'BR11: only Finance confirms an advance receipt';
  END IF;
  IF NEW.advance_kind = 'NOT_REQUIRED' THEN RAISE EXCEPTION 'BR11: these terms require no advance'; END IF;
  SELECT * INTO rc FROM br08_payment_receipts WHERE id=NEW.br08_receipt_id FOR UPDATE;
  IF rc.company_id <> NEW.company_id OR rc.customer_id <> so.customer_id THEN
    RAISE EXCEPTION 'BR11: the BR-08 receipt must belong to the order''s customer in this company';
  END IF;
  SELECT COALESCE(sum(required_amount_paise),0) INTO v_used FROM br11_order_payment_conditions
   WHERE br08_receipt_id=rc.id AND id<>NEW.id;
  IF rc.amount_paise - v_used < NEW.required_amount_paise THEN
    RAISE EXCEPTION 'BR11: the receipt (% paise, % already counted as other advances) does not cover the required advance (% paise)',
      rc.amount_paise, v_used, NEW.required_amount_paise;
  END IF;
  NEW.finance_confirmed_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br11_payment_condition BEFORE INSERT OR UPDATE ON br11_order_payment_conditions
  FOR EACH ROW EXECUTE FUNCTION br11_guard_payment_condition();
CREATE TRIGGER trg_br11_payment_condition_nodelete BEFORE DELETE ON br11_order_payment_conditions
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- =============================================================================
-- Guards: reservation requests (verified against the real ledger row)
CREATE OR REPLACE FUNCTION br11_guard_reservation_request()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ol br11_sales_order_lines%ROWTYPE; v_order_status text; v_other numeric; lr fdn_inventory_reservations%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO ol FROM br11_sales_order_lines WHERE id=NEW.sales_order_line_id AND company_id=NEW.company_id FOR UPDATE;
    SELECT status INTO v_order_status FROM br11_sales_orders WHERE id=ol.sales_order_id;
    IF v_order_status NOT IN ('VERIFIED','PART_DELIVERED') THEN
      RAISE EXCEPTION 'BR11: stock is reserved only for a verified Sales Order (11B-04) -- order is %', v_order_status;
    END IF;
    IF ol.line_status = 'CANCELLED' THEN RAISE EXCEPTION 'BR11: the order line is cancelled'; END IF;
    IF NOT br08_has_role(NEW.company_id, NEW.requested_by_id, 'PURCHASE') THEN
      RAISE EXCEPTION 'BR11: only Purchase requests a sales reservation';
    END IF;
    PERFORM br11_assert_advance_cleared(ol.sales_order_id);
    IF NEW.state <> 'REQUESTED' OR NEW.ledger_reservation_id IS NOT NULL THEN
      RAISE EXCEPTION 'BR11: a reservation request starts REQUESTED; the ledger confirms it';
    END IF;
    SELECT COALESCE(sum(requested_qty),0) INTO v_other FROM br11_inventory_reservation_requests
     WHERE sales_order_line_id=NEW.sales_order_line_id AND state IN ('REQUESTED','CONFIRMED','CONSUMED');
    IF v_other + NEW.requested_qty > ol.accepted_qty THEN
      RAISE EXCEPTION 'BR11: cumulative reservation requests (% + %) exceed the accepted quantity %',
        v_other, NEW.requested_qty, ol.accepted_qty;
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - ARRAY['state','ledger_reservation_id','error_message','confirmed_at','closed_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','ledger_reservation_id','error_message','confirmed_at','closed_at']) THEN
    RAISE EXCEPTION 'BR11: a reservation request is immutable';
  END IF;
  IF NEW.state = OLD.state THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'BR11: a reservation request is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.ledger_reservation_id IS NOT NULL THEN
    SELECT * INTO lr FROM fdn_inventory_reservations WHERE id=NEW.ledger_reservation_id;
  END IF;
  IF OLD.state = 'REQUESTED' AND NEW.state = 'CONFIRMED' THEN
    SELECT * INTO ol FROM br11_sales_order_lines WHERE id=NEW.sales_order_line_id;
    IF lr.id IS NULL OR lr.status <> 'ACTIVE' OR lr.company_id <> NEW.company_id OR lr.item_id <> ol.item_id
       OR lr.qty <> NEW.requested_qty OR lr.reference_kind <> 'BR11_SALES_RESERVATION' OR lr.reference_id <> NEW.id THEN
      RAISE EXCEPTION 'BR11: CONFIRMED requires a matching ACTIVE reservation in the inventory ledger';
    END IF;
    NEW.confirmed_at := now();
    RETURN NEW;
  END IF;
  IF OLD.state = 'REQUESTED' AND NEW.state = 'FAILED' AND NEW.ledger_reservation_id IS NULL THEN
    NEW.closed_at := now();
    RETURN NEW;
  END IF;
  IF OLD.state = 'CONFIRMED' AND NEW.state IN ('RELEASED','CONSUMED')
     AND NEW.ledger_reservation_id = OLD.ledger_reservation_id AND lr.status = NEW.state THEN
    IF NEW.state = 'RELEASED' AND EXISTS (
         SELECT 1 FROM br11_outward_lines l JOIN br11_outward_batches b ON b.id=l.outward_batch_id
          WHERE l.reservation_request_id=NEW.id AND b.status<>'CANCELLED') THEN
      RAISE EXCEPTION 'BR11: the reservation is on an outward line -- cancel that outward batch first';
    END IF;
    NEW.closed_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'BR11: reservation request % -> % is not allowed (ledger reservation must be in the matching state)',
    OLD.state, NEW.state;
END $$;
CREATE TRIGGER trg_br11_reservation_request BEFORE INSERT OR UPDATE ON br11_inventory_reservation_requests
  FOR EACH ROW EXECUTE FUNCTION br11_guard_reservation_request();
CREATE TRIGGER trg_br11_reservation_request_nodelete BEFORE DELETE ON br11_inventory_reservation_requests
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- =============================================================================
-- Guards: outward
CREATE OR REPLACE FUNCTION br11_guard_outward_batch()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_bad integer; v_n integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.created_by_id, 'PURCHASE') THEN
      RAISE EXCEPTION 'BR11: only Purchase prepares a product outward';
    END IF;
    IF NEW.status <> 'DRAFT' OR NEW.outward_number IS NOT NULL THEN RAISE EXCEPTION 'BR11: an outward batch starts DRAFT, unnumbered'; END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','outward_number','dispatched_by_id','dispatched_at','cancelled_at','tracking_reference'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','outward_number','dispatched_by_id','dispatched_at','cancelled_at','tracking_reference'])
     OR OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'BR11: an outward batch is immutable once dispatched/cancelled';
  END IF;
  IF NEW.status = 'DISPATCHED' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.dispatched_by_id, 'PURCHASE') THEN
      RAISE EXCEPTION 'BR11: only Purchase dispatches a product outward';
    END IF;
    SELECT count(*),
           count(*) FILTER (WHERE l.status <> 'PICKED' OR l.inventory_issue_ref IS NULL
             OR NOT EXISTS (SELECT 1 FROM br11_packing_evidence p WHERE p.outward_line_id=l.id AND p.evidence_kind='PHOTO')
             OR NOT EXISTS (SELECT 1 FROM br11_inventory_reservation_requests r WHERE r.id=l.reservation_request_id AND r.state='CONSUMED')
             OR NOT EXISTS (SELECT 1 FROM fdn_inventory_journal j WHERE j.id=l.inventory_issue_ref AND j.company_id=l.company_id
                              AND j.item_id=l.item_id AND j.qty=l.outward_qty AND j.movement_type='ISSUE'
                              AND j.reference_kind='BR11_SALE_ISSUE' AND j.reference_id=l.id AND j.status='POSTED'))
      INTO v_n, v_bad
      FROM br11_outward_lines l WHERE l.outward_batch_id=NEW.id;
    IF v_n = 0 THEN RAISE EXCEPTION 'BR11: an outward batch needs at least one line'; END IF;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'BR11: physical outward requires, on every line: pick verification, a packing PHOTO, a consumed ledger reservation and a posted ledger ISSUE (% line(s) incomplete)', v_bad;
    END IF;
    NEW.outward_number := br11_next_number(NEW.company_id, 'SOUT');
    NEW.dispatched_at := now();
    RETURN NEW;
  END IF;
  IF NEW.status = 'CANCELLED' THEN
    IF EXISTS (SELECT 1 FROM br11_outward_lines WHERE outward_batch_id=NEW.id AND inventory_issue_ref IS NOT NULL) THEN
      RAISE EXCEPTION 'BR11: stock has already been issued from the ledger for this batch -- it cannot be cancelled';
    END IF;
    NEW.cancelled_at := now();
    RETURN NEW;
  END IF;
  IF NEW.status = 'DRAFT' AND NEW.outward_number IS NULL AND NEW.dispatched_at IS NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'BR11: outward batch change not allowed';
END $$;
CREATE OR REPLACE FUNCTION br11_apply_outward_batch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'DISPATCHED' AND OLD.status = 'DRAFT' THEN
    UPDATE br11_outward_lines SET status='DISPATCHED' WHERE outward_batch_id=NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_br11_outward_batch BEFORE INSERT OR UPDATE ON br11_outward_batches
  FOR EACH ROW EXECUTE FUNCTION br11_guard_outward_batch();
CREATE TRIGGER trg_br11_outward_batch_apply AFTER UPDATE ON br11_outward_batches
  FOR EACH ROW EXECUTE FUNCTION br11_apply_outward_batch();
CREATE TRIGGER trg_br11_outward_batch_nodelete BEFORE DELETE ON br11_outward_batches
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br11_guard_outward_line()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b br11_outward_batches%ROWTYPE; ol br11_sales_order_lines%ROWTYPE; so br11_sales_orders%ROWTYPE;
        rr br11_inventory_reservation_requests%ROWTYPE; v_sent numeric; it fdn_item_master%ROWTYPE;
BEGIN
  SELECT * INTO b FROM br11_outward_batches WHERE id=NEW.outward_batch_id AND company_id=NEW.company_id;
  IF TG_OP = 'INSERT' THEN
    IF b.status <> 'DRAFT' THEN RAISE EXCEPTION 'BR11: lines are added to a DRAFT outward batch only'; END IF;
    SELECT * INTO ol FROM br11_sales_order_lines WHERE id=NEW.sales_order_line_id FOR UPDATE;
    SELECT * INTO so FROM br11_sales_orders WHERE id=ol.sales_order_id;
    IF so.status NOT IN ('VERIFIED','PART_DELIVERED') THEN RAISE EXCEPTION 'BR11: the Sales Order is %', so.status; END IF;
    IF ol.line_status = 'CANCELLED' THEN RAISE EXCEPTION 'BR11: the order line is cancelled'; END IF;
    IF so.customer_id <> b.customer_id THEN RAISE EXCEPTION 'BR11: sales outward customer mismatch'; END IF;
    SELECT * INTO rr FROM br11_inventory_reservation_requests WHERE id=NEW.reservation_request_id;
    IF rr.sales_order_line_id IS DISTINCT FROM NEW.sales_order_line_id OR rr.state IS DISTINCT FROM 'CONFIRMED' THEN
      RAISE EXCEPTION 'BR11: outward must use a ledger-CONFIRMED reservation of the same order line';
    END IF;
    IF EXISTS (SELECT 1 FROM br11_outward_lines l JOIN br11_outward_batches x ON x.id=l.outward_batch_id
                WHERE l.reservation_request_id=rr.id AND x.status<>'CANCELLED') THEN
      RAISE EXCEPTION 'BR11: this reservation is already on an outward line';
    END IF;
    -- the ledger cannot partially decrement a reservation: one line ships one whole reservation
    NEW.outward_qty := rr.requested_qty;
    NEW.item_id := ol.item_id; NEW.uom := ol.uom;
    SELECT COALESCE(sum(l.outward_qty),0) INTO v_sent FROM br11_outward_lines l
      JOIN br11_outward_batches x ON x.id=l.outward_batch_id
     WHERE l.sales_order_line_id=NEW.sales_order_line_id AND x.status<>'CANCELLED';
    IF v_sent + NEW.outward_qty > ol.accepted_qty THEN
      RAISE EXCEPTION 'BR11: total outward quantity (% + %) exceeds the accepted order quantity %', v_sent, NEW.outward_qty, ol.accepted_qty;
    END IF;
    IF NEW.status <> 'DRAFT' OR NEW.inventory_issue_ref IS NOT NULL OR NEW.pick_confirmed_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'BR11: an outward line starts DRAFT';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - ARRAY['status','verification_note','serial_numbers','pick_confirmed_by_id','pick_confirmed_at','inventory_issue_ref'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','verification_note','serial_numbers','pick_confirmed_by_id','pick_confirmed_at','inventory_issue_ref']) THEN
    RAISE EXCEPTION 'BR11: outward line quantity / source are immutable';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'PICKED' THEN
    IF b.status <> 'DRAFT' THEN RAISE EXCEPTION 'BR11: batch is not DRAFT'; END IF;
    IF NOT br08_has_role(NEW.company_id, NEW.pick_confirmed_by_id, 'PURCHASE') THEN
      RAISE EXCEPTION 'BR11: only Purchase confirms the pick';
    END IF;
    SELECT * INTO it FROM fdn_item_master WHERE id=NEW.item_id;
    IF it.serial_tracking AND COALESCE(cardinality(NEW.serial_numbers),0) <> NEW.outward_qty THEN
      RAISE EXCEPTION 'BR11: serial-tracked item -- record exactly % serial number(s) (11C-02)', NEW.outward_qty;
    END IF;
    NEW.pick_confirmed_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'PICKED' AND NEW.status = 'PICKED' THEN
    -- only the ledger issue reference may be recorded, once, while the batch is DRAFT
    IF b.status <> 'DRAFT' OR OLD.inventory_issue_ref IS NOT NULL OR NEW.inventory_issue_ref IS NULL
       OR NEW.verification_note IS DISTINCT FROM OLD.verification_note OR NEW.serial_numbers IS DISTINCT FROM OLD.serial_numbers
       OR NEW.pick_confirmed_by_id IS DISTINCT FROM OLD.pick_confirmed_by_id OR NEW.pick_confirmed_at IS DISTINCT FROM OLD.pick_confirmed_at THEN
      RAISE EXCEPTION 'BR11: picked outward line is immutable (ledger issue reference is recorded once)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM fdn_inventory_journal j WHERE j.id=NEW.inventory_issue_ref AND j.reference_id=NEW.id
                      AND j.reference_kind='BR11_SALE_ISSUE' AND j.movement_type='ISSUE') THEN
      RAISE EXCEPTION 'BR11: inventory issue reference is not a ledger ISSUE for this outward line';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.status = 'PICKED' AND NEW.status = 'DISPATCHED') OR (OLD.status = 'DISPATCHED' AND NEW.status = 'DELIVERED') THEN
    IF pg_trigger_depth() < 2 OR (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'BR11: outward line status is derived from batch dispatch / delivery evidence';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'BR11: outward line % -> % is not allowed', OLD.status, NEW.status;
END $$;
CREATE TRIGGER trg_br11_outward_line BEFORE INSERT OR UPDATE ON br11_outward_lines
  FOR EACH ROW EXECUTE FUNCTION br11_guard_outward_line();
CREATE TRIGGER trg_br11_outward_line_nodelete BEFORE DELETE ON br11_outward_lines
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br11_guard_packing_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM br11_outward_lines l JOIN br11_outward_batches b ON b.id=l.outward_batch_id
                  WHERE l.id=NEW.outward_line_id AND l.company_id=NEW.company_id AND b.status='DRAFT') THEN
    RAISE EXCEPTION 'BR11: packing evidence is captured before dispatch (batch must be DRAFT)';
  END IF;
  IF NOT br08_has_role(NEW.company_id, NEW.captured_by_id, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR11: only Purchase records packing evidence';
  END IF;
  NEW.captured_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br11_packing_evidence BEFORE INSERT ON br11_packing_evidence
  FOR EACH ROW EXECUTE FUNCTION br11_guard_packing_evidence();
CREATE TRIGGER trg_br11_packing_evidence_append_only BEFORE UPDATE OR DELETE ON br11_packing_evidence
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br11_guard_tracking_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM br11_outward_batches WHERE id=NEW.outward_batch_id AND company_id=NEW.company_id AND status='DISPATCHED') THEN
    RAISE EXCEPTION 'BR11: tracking events follow a dispatched outward';
  END IF;
  IF NOT br08_has_role(NEW.company_id, NEW.recorded_by_id, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR11: only Purchase records carrier tracking';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br11_tracking_event BEFORE INSERT ON br11_carrier_tracking_events
  FOR EACH ROW EXECUTE FUNCTION br11_guard_tracking_event();
CREATE TRIGGER trg_br11_tracking_event_append_only BEFORE UPDATE OR DELETE ON br11_carrier_tracking_events
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- Recompute line + order fulfilment state from delivery evidence / cancellations.
CREATE OR REPLACE FUNCTION br11_refresh_order(p_order uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE l record; v_del numeric; v_new text; v_status text; v_active integer; v_done integer; v_any integer;
BEGIN
  SELECT status INTO v_status FROM br11_sales_orders WHERE id=p_order FOR UPDATE;
  FOR l IN SELECT * FROM br11_sales_order_lines WHERE sales_order_id=p_order AND line_status<>'CANCELLED' FOR UPDATE LOOP
    v_del := br11_line_delivered_qty(l.id);
    v_new := CASE WHEN v_del >= l.accepted_qty THEN 'DELIVERED' WHEN v_del > 0 THEN 'PART_DELIVERED' ELSE 'OPEN' END;
    IF v_new <> l.line_status THEN UPDATE br11_sales_order_lines SET line_status=v_new WHERE id=l.id; END IF;
  END LOOP;
  IF v_status NOT IN ('VERIFIED','PART_DELIVERED','DELIVERED') THEN RETURN; END IF;
  SELECT count(*) FILTER (WHERE line_status<>'CANCELLED'),
         count(*) FILTER (WHERE line_status='DELIVERED'),
         count(*) FILTER (WHERE line_status IN ('DELIVERED','PART_DELIVERED'))
    INTO v_active, v_done, v_any FROM br11_sales_order_lines WHERE sales_order_id=p_order;
  v_new := CASE WHEN v_active = 0 THEN 'CANCELLED' WHEN v_done = v_active THEN 'DELIVERED'
                WHEN v_any > 0 THEN 'PART_DELIVERED' ELSE 'VERIFIED' END;
  IF v_new <> v_status THEN UPDATE br11_sales_orders SET status=v_new WHERE id=p_order; END IF;
END $$;

CREATE OR REPLACE FUNCTION br11_guard_delivery()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l br11_outward_lines%ROWTYPE; b br11_outward_batches%ROWTYPE;
BEGIN
  SELECT * INTO l FROM br11_outward_lines WHERE id=NEW.outward_line_id AND company_id=NEW.company_id FOR UPDATE;
  SELECT * INTO b FROM br11_outward_batches WHERE id=l.outward_batch_id;
  IF b.status IS DISTINCT FROM 'DISPATCHED' THEN RAISE EXCEPTION 'BR11: physical outward must be dispatched before delivery evidence'; END IF;
  IF NOT br08_has_role(NEW.company_id, NEW.recorded_by_id, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR11: only Purchase records proof of delivery';
  END IF;
  IF NEW.delivery_status = 'DELIVERED' THEN
    IF NEW.delivered_qty > l.outward_qty THEN
      RAISE EXCEPTION 'BR11: POD quantity % exceeds the shipped quantity %', NEW.delivered_qty, l.outward_qty;
    END IF;
    IF NEW.delivered_at < b.dispatched_at OR NEW.delivered_at > now() THEN
      RAISE EXCEPTION 'BR11: delivery time must be between dispatch and now';
    END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION br11_apply_delivery()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_order uuid;
BEGIN
  IF NEW.delivery_status = 'DELIVERED' THEN
    UPDATE br11_outward_lines SET status='DELIVERED' WHERE id=NEW.outward_line_id;
    SELECT ol.sales_order_id INTO v_order FROM br11_outward_lines x JOIN br11_sales_order_lines ol ON ol.id=x.sales_order_line_id
     WHERE x.id=NEW.outward_line_id;
    PERFORM br11_refresh_order(v_order);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_br11_delivery BEFORE INSERT ON br11_delivery_evidence
  FOR EACH ROW EXECUTE FUNCTION br11_guard_delivery();
CREATE TRIGGER trg_br11_delivery_apply AFTER INSERT ON br11_delivery_evidence
  FOR EACH ROW EXECUTE FUNCTION br11_apply_delivery();
CREATE TRIGGER trg_br11_delivery_append_only BEFORE UPDATE OR DELETE ON br11_delivery_evidence
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- =============================================================================
-- Guards: change requests
CREATE OR REPLACE FUNCTION br11_assert_line_cancellable(p_line uuid)
RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM br11_outward_lines l JOIN br11_outward_batches b ON b.id=l.outward_batch_id
              WHERE l.sales_order_line_id=p_line AND b.status<>'CANCELLED') THEN
    RAISE EXCEPTION 'BR11: the line has outward stock -- cancellation after shipment needs a sales-return path (not defined)';
  END IF;
  IF br11_line_invoiced_qty(p_line) > 0 THEN
    RAISE EXCEPTION 'BR11: the line is on a live BR-08 invoice -- cancel that invoice with a credit note first';
  END IF;
  IF EXISTS (SELECT 1 FROM br11_inventory_reservation_requests WHERE sales_order_line_id=p_line AND state IN ('REQUESTED','CONFIRMED')) THEN
    RAISE EXCEPTION 'BR11: release the line''s stock reservations first';
  END IF;
  IF EXISTS (SELECT 1 FROM br06_sales_sourcing_authorisations a JOIN br06_po_lines pl ON pl.sales_sourcing_authorisation_id=a.id
               JOIN br06_supplier_purchase_orders po ON po.id=pl.po_id
              WHERE a.sales_order_line_id=p_line AND po.po_status<>'CANCELLED') THEN
    RAISE EXCEPTION 'BR11: a supplier PO exists for this line -- cancellation with supplier commitments is pending client thresholds (P-05)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION br11_guard_change_request()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; l record;
BEGIN
  SELECT status INTO v_status FROM br11_sales_orders WHERE id=NEW.sales_order_id AND company_id=NEW.company_id FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    IF v_status NOT IN ('VERIFIED','PART_DELIVERED','DELIVERED') THEN
      RAISE EXCEPTION 'BR11: change requests apply to a verified, open Sales Order (order is %)', v_status;
    END IF;
    IF NOT br11_has_any_role(NEW.company_id, NEW.requested_by_id, ARRAY['SALES','PURCHASE']) THEN
      RAISE EXCEPTION 'BR11: only Sales or Purchase raises a sales change request';
    END IF;
    IF NEW.decision <> 'PENDING' OR NEW.decided_by_id IS NOT NULL THEN RAISE EXCEPTION 'BR11: a change request starts PENDING'; END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['decision','decision_note','decided_by_id','decided_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['decision','decision_note','decided_by_id','decided_at'])
     OR OLD.decision <> 'PENDING' OR NEW.decision = 'PENDING' THEN
    RAISE EXCEPTION 'BR11: a decided change request is immutable';
  END IF;
  IF NOT br08_has_role(NEW.company_id, NEW.decided_by_id, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR11: only Purchase decides sales change requests (11B-10)';
  END IF;
  IF NEW.decision = 'APPROVED' AND NEW.change_kind = 'CANCELLATION' THEN
    IF v_status NOT IN ('VERIFIED','PART_DELIVERED','DELIVERED') THEN RAISE EXCEPTION 'BR11: the order is %', v_status; END IF;
    FOR l IN SELECT id FROM br11_sales_order_lines WHERE sales_order_id=NEW.sales_order_id AND line_status<>'CANCELLED'
               AND (NEW.sales_order_line_id IS NULL OR id=NEW.sales_order_line_id) LOOP
      PERFORM br11_assert_line_cancellable(l.id);
    END LOOP;
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION br11_apply_change_request()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision = 'APPROVED' AND OLD.decision = 'PENDING' AND NEW.change_kind = 'CANCELLATION' THEN
    UPDATE br11_sales_order_lines SET line_status='CANCELLED'
     WHERE sales_order_id=NEW.sales_order_id AND line_status<>'CANCELLED'
       AND (NEW.sales_order_line_id IS NULL OR id=NEW.sales_order_line_id);
    PERFORM br11_refresh_order(NEW.sales_order_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_br11_change_request BEFORE INSERT OR UPDATE ON br11_sales_change_requests
  FOR EACH ROW EXECUTE FUNCTION br11_guard_change_request();
CREATE TRIGGER trg_br11_change_request_apply AFTER UPDATE ON br11_sales_change_requests
  FOR EACH ROW EXECUTE FUNCTION br11_apply_change_request();
CREATE TRIGGER trg_br11_change_request_nodelete BEFORE DELETE ON br11_sales_change_requests
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- =============================================================================
-- Guards: closure review (11C-09). All flags computed here; the policy for
-- payment-before-closure is CLIENT-UNCONFIRMED (no row/NULL = blocked).
CREATE OR REPLACE FUNCTION br11_guard_closure_review()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE so br11_sales_orders%ROWTYPE; v_pay boolean; v_bad integer; v_unpaid integer; v_inv jsonb;
BEGIN
  IF NOT br08_has_role(NEW.company_id, NEW.reviewed_by_id, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR11: only Purchase approves Sales Order closure (11C-09 proposal)';
  END IF;
  SELECT * INTO so FROM br11_sales_orders WHERE id=NEW.sales_order_id AND company_id=NEW.company_id FOR UPDATE;
  SELECT requires_full_payment_for_closure INTO v_pay FROM br11_company_policies WHERE company_id=NEW.company_id;
  IF v_pay IS NULL THEN
    RAISE EXCEPTION 'BR11: CLIENT-UNCONFIRMED -- whether full payment is required before Sales Order closure (11C-09) is not configured for this company';
  END IF;
  IF so.status <> 'DELIVERED' THEN
    RAISE EXCEPTION 'BR11: closure needs every open line fully POD-delivered (order is %)', so.status;
  END IF;
  SELECT count(*) INTO v_bad FROM br11_sales_order_lines l
   WHERE l.sales_order_id=so.id AND l.line_status<>'CANCELLED'
     AND (br11_line_delivered_qty(l.id) < l.accepted_qty OR br11_line_invoiced_qty(l.id) <> l.accepted_qty);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'BR11: closure needs ordered, delivered and invoiced quantities reconciled on every line (% line(s) are not)', v_bad;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number,
           'invoice_status', i.invoice_status, 'total_paise', i.total_paise, 'amount_paid_paise', i.amount_paid_paise)
           ORDER BY i.invoice_number), '[]'::jsonb),
         count(*) FILTER (WHERE i.invoice_status <> 'PAID')
    INTO v_inv, v_unpaid
    FROM br08_sales_invoice_sources s JOIN br08_invoices i ON i.id=s.invoice_id
   WHERE s.sales_order_id=so.id AND i.invoice_status<>'CANCELLED';
  IF jsonb_array_length(v_inv) = 0 THEN RAISE EXCEPTION 'BR11: closure needs a live BR-08 product-sales invoice'; END IF;
  NEW.delivery_verified := true;
  NEW.billing_verified := true;
  NEW.payment_required := v_pay;
  NEW.payment_verified := (v_unpaid = 0);
  NEW.finance_evidence := v_inv;
  IF v_pay AND v_unpaid > 0 THEN
    RAISE EXCEPTION 'BR11: company policy requires full payment before closure -- % invoice(s) not PAID in BR-08', v_unpaid;
  END IF;
  NEW.reviewed_at := now();
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION br11_apply_closure_review()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE br11_sales_orders SET status='CLOSED' WHERE id=NEW.sales_order_id;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_br11_closure_review BEFORE INSERT ON br11_sales_order_closure_reviews
  FOR EACH ROW EXECUTE FUNCTION br11_guard_closure_review();
CREATE TRIGGER trg_br11_closure_review_apply AFTER INSERT ON br11_sales_order_closure_reviews
  FOR EACH ROW EXECUTE FUNCTION br11_apply_closure_review();
CREATE TRIGGER trg_br11_closure_review_append_only BEFORE UPDATE OR DELETE ON br11_sales_order_closure_reviews
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- =============================================================================
-- BR-06 guards for the SALES_ORDER purpose (CUSTOMER_JOB rows are untouched)
CREATE OR REPLACE FUNCTION br06_guard_sales_sourcing()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ol br11_sales_order_lines%ROWTYPE; v_status text; v_other numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'authorisation_status') IS DISTINCT FROM (to_jsonb(OLD) - 'authorisation_status')
       OR OLD.authorisation_status <> 'APPROVED' OR NEW.authorisation_status <> 'CANCELLED' THEN
      RAISE EXCEPTION 'BR06: a sales sourcing authorisation is immutable (it can only be cancelled)';
    END IF;
    IF EXISTS (SELECT 1 FROM br06_po_lines pl JOIN br06_supplier_purchase_orders po ON po.id=pl.po_id
                WHERE pl.sales_sourcing_authorisation_id=NEW.id AND po.po_status<>'CANCELLED') THEN
      RAISE EXCEPTION 'BR06: the authorisation is on a supplier PO';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT br08_has_role(NEW.company_id, NEW.authorised_by_id, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR06: only Purchase authorises sales-order sourcing';
  END IF;
  IF NEW.authorisation_status <> 'APPROVED' THEN RAISE EXCEPTION 'BR06: a sourcing authorisation is created APPROVED'; END IF;
  SELECT * INTO ol FROM br11_sales_order_lines WHERE id=NEW.sales_order_line_id AND company_id=NEW.company_id FOR UPDATE;
  SELECT status INTO v_status FROM br11_sales_orders WHERE id=ol.sales_order_id;
  IF v_status NOT IN ('VERIFIED','PART_DELIVERED') THEN
    RAISE EXCEPTION 'BR06: SALES_ORDER sourcing needs a verified Sales Order (order is %)', v_status;
  END IF;
  IF ol.line_status = 'CANCELLED' THEN RAISE EXCEPTION 'BR06: the order line is cancelled'; END IF;
  PERFORM br11_assert_advance_cleared(ol.sales_order_id);
  SELECT COALESCE(sum(quantity),0) INTO v_other FROM br06_sales_sourcing_authorisations
   WHERE sales_order_line_id=NEW.sales_order_line_id AND authorisation_status='APPROVED';
  IF v_other + NEW.quantity > ol.accepted_qty THEN
    RAISE EXCEPTION 'BR06: sourcing quantity (% + %) exceeds the accepted order quantity %', v_other, NEW.quantity, ol.accepted_qty;
  END IF;
  NEW.authorised_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br06_sales_sourcing BEFORE INSERT OR UPDATE ON br06_sales_sourcing_authorisations
  FOR EACH ROW EXECUTE FUNCTION br06_guard_sales_sourcing();
CREATE TRIGGER trg_br06_sales_sourcing_nodelete BEFORE DELETE ON br06_sales_sourcing_authorisations
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br06_guard_po_purpose()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.purchase_purpose IS DISTINCT FROM OLD.purchase_purpose
       OR NEW.sales_order_id IS DISTINCT FROM OLD.sales_order_id OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id) THEN
    RAISE EXCEPTION 'BR06: PO purpose / sales order / supplier are immutable';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.purchase_purpose = 'SALES_ORDER' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.created_by_id, 'PURCHASE') THEN
      RAISE EXCEPTION 'BR06: only Purchase raises a supplier PO';
    END IF;
    SELECT status INTO v_status FROM br11_sales_orders WHERE id=NEW.sales_order_id AND company_id=NEW.company_id;
    IF v_status NOT IN ('VERIFIED','PART_DELIVERED') THEN
      RAISE EXCEPTION 'BR06: a SALES_ORDER PO needs a verified Sales Order (order is %)', v_status;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br06_po_purpose BEFORE INSERT OR UPDATE ON br06_supplier_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION br06_guard_po_purpose();

CREATE OR REPLACE FUNCTION br06_guard_po_line_source()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE po br06_supplier_purchase_orders%ROWTYPE; a br06_sales_sourcing_authorisations%ROWTYPE;
        ol br11_sales_order_lines%ROWTYPE; br br03_item_catalog_bridge%ROWTYPE;
BEGIN
  SELECT * INTO po FROM br06_supplier_purchase_orders WHERE id=NEW.po_id;
  IF po.purchase_purpose = 'CUSTOMER_JOB' THEN
    IF NEW.sales_sourcing_authorisation_id IS NOT NULL THEN
      RAISE EXCEPTION 'BR06: a sales sourcing authorisation cannot be used on a customer-job PO';
    END IF;
    RETURN NEW;
  END IF;
  -- SALES_ORDER
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'BR06: SALES_ORDER PO lines are immutable'; END IF;
  IF po.po_status <> 'DRAFT' THEN RAISE EXCEPTION 'BR06: lines are added to a DRAFT PO only'; END IF;
  IF NEW.sales_sourcing_authorisation_id IS NULL OR NEW.source_br04_offer_line_id IS NOT NULL THEN
    RAISE EXCEPTION 'BR06: a SALES_ORDER PO line is sourced only from a sales sourcing authorisation (never a repair Job ID)';
  END IF;
  SELECT * INTO a FROM br06_sales_sourcing_authorisations WHERE id=NEW.sales_sourcing_authorisation_id;
  IF a.company_id <> po.company_id OR a.authorisation_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'BR06: sourcing authorisation is not APPROVED in this company';
  END IF;
  SELECT * INTO ol FROM br11_sales_order_lines WHERE id=a.sales_order_line_id;
  IF ol.sales_order_id <> po.sales_order_id THEN
    RAISE EXCEPTION 'BR06: the sourcing authorisation belongs to a different Sales Order';
  END IF;
  SELECT * INTO br FROM br03_item_catalog_bridge WHERE id=NEW.item_bridge_id;
  IF br.br01_item_id IS DISTINCT FROM ol.item_id OR br.approval_status <> 'APPROVED' OR NOT br.is_active THEN
    RAISE EXCEPTION 'BR06: PO line item must be the Sales Order line item (approved catalogue entry)';
  END IF;
  IF NEW.quantity <> a.quantity OR NEW.unit_price <> a.supplier_unit_price THEN
    RAISE EXCEPTION 'BR06: PO line quantity/price must equal the sourcing authorisation';
  END IF;
  IF a.supplier_name_snapshot <> po.supplier_name_snapshot OR a.supplier_id IS DISTINCT FROM po.supplier_id THEN
    RAISE EXCEPTION 'BR06: every line on one PO must be authorised for the PO supplier';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br06_po_line_source BEFORE INSERT OR UPDATE ON br06_po_lines
  FOR EACH ROW EXECUTE FUNCTION br06_guard_po_line_source();

-- =============================================================================
-- BR-08 guards for PRODUCT_SALES
CREATE OR REPLACE FUNCTION br08_guard_repair_child_on_product_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM br08_invoices WHERE id=NEW.invoice_id AND invoice_type='PRODUCT_SALES') THEN
    RAISE EXCEPTION 'BR08: a PRODUCT_SALES invoice carries no repair Job ID / repair quote line';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_invoice_job_type BEFORE INSERT ON br08_invoice_jobs
  FOR EACH ROW EXECUTE FUNCTION br08_guard_repair_child_on_product_invoice();
CREATE TRIGGER trg_br08_invoice_line_type BEFORE INSERT ON br08_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION br08_guard_repair_child_on_product_invoice();

CREATE OR REPLACE FUNCTION br08_guard_sales_invoice_child()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv br08_invoices%ROWTYPE; v_so uuid; ol br11_sales_order_lines%ROWTYPE; v_ceiling numeric; v_done numeric;
BEGIN
  SELECT * INTO inv FROM br08_invoices WHERE id=NEW.invoice_id;
  IF inv.company_id <> NEW.company_id OR inv.invoice_type <> 'PRODUCT_SALES' THEN
    RAISE EXCEPTION 'BR08: sales source/lines belong only to a PRODUCT_SALES invoice of this company';
  END IF;
  IF NOT br08_invoice_open_in_this_tx(NEW.invoice_id) THEN
    RAISE EXCEPTION 'BR08: an issued invoice is immutable -- sales lines cannot be added after issue';
  END IF;
  IF TG_TABLE_NAME = 'br08_sales_invoice_sources' THEN
    SELECT customer_id INTO v_so FROM br11_sales_orders WHERE id=NEW.sales_order_id;
    IF v_so IS DISTINCT FROM inv.customer_id THEN RAISE EXCEPTION 'BR08: invoice customer must be the Sales Order customer'; END IF;
    RETURN NEW;
  END IF;
  SELECT sales_order_id INTO v_so FROM br08_sales_invoice_sources WHERE invoice_id=NEW.invoice_id;
  SELECT * INTO ol FROM br11_sales_order_lines WHERE id=NEW.sales_order_line_id FOR UPDATE;
  IF ol.sales_order_id IS DISTINCT FROM v_so THEN RAISE EXCEPTION 'BR08: the invoice line must belong to the invoiced Sales Order'; END IF;
  v_ceiling := br11_line_invoiceable_qty(ol.id);
  IF v_ceiling IS NULL THEN RAISE EXCEPTION 'BR08: MILESTONE invoicing has no milestone schedule (11C-07) -- not modelled'; END IF;
  v_done := br11_line_invoiced_qty(ol.id);
  IF v_done + NEW.quantity > v_ceiling THEN
    RAISE EXCEPTION 'BR08: line % invoice quantity (% already + %) exceeds the invoiceable quantity % under the configured trigger',
      ol.line_no, v_done, NEW.quantity, v_ceiling;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_sales_invoice_source BEFORE INSERT ON br08_sales_invoice_sources
  FOR EACH ROW EXECUTE FUNCTION br08_guard_sales_invoice_child();
CREATE TRIGGER trg_br08_sales_invoice_source_append_only BEFORE UPDATE OR DELETE ON br08_sales_invoice_sources
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();
CREATE TRIGGER trg_br08_sales_invoice_line BEFORE INSERT ON br08_invoice_sales_lines
  FOR EACH ROW EXECUTE FUNCTION br08_guard_sales_invoice_child();
CREATE TRIGGER trg_br08_sales_invoice_line_append_only BEFORE UPDATE OR DELETE ON br08_invoice_sales_lines
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- Commit-time totals: REPAIR branch is the migration-013 logic unchanged;
-- PRODUCT_SALES sums br08_invoice_sales_lines and must have no repair jobs.
CREATE OR REPLACE FUNCTION br08_check_invoice_totals()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  IF NEW.invoice_type = 'PRODUCT_SALES' THEN
    SELECT count(*) AS n, COALESCE(sum(taxable_paise),0) AS sub, COALESCE(sum(cgst_paise),0) AS cg,
           COALESCE(sum(sgst_paise),0) AS sg, COALESCE(sum(igst_paise),0) AS ig
      INTO s FROM br08_invoice_sales_lines WHERE invoice_id=NEW.id;
    IF s.n = 0 OR NOT EXISTS (SELECT 1 FROM br08_sales_invoice_sources WHERE invoice_id=NEW.id)
       OR EXISTS (SELECT 1 FROM br08_invoice_jobs WHERE invoice_id=NEW.id)
       OR EXISTS (SELECT 1 FROM br08_invoice_lines WHERE invoice_id=NEW.id) THEN
      RAISE EXCEPTION 'BR08: a product-sales invoice needs one Sales Order source and at least one sales line (and no repair jobs)';
    END IF;
  ELSE
    SELECT count(*) AS n, COALESCE(sum(taxable_paise),0) AS sub, COALESCE(sum(cgst_paise),0) AS cg,
           COALESCE(sum(sgst_paise),0) AS sg, COALESCE(sum(igst_paise),0) AS ig
      INTO s FROM br08_invoice_lines WHERE invoice_id=NEW.id;
    IF s.n = 0 OR NOT EXISTS (SELECT 1 FROM br08_invoice_jobs WHERE invoice_id=NEW.id) THEN
      RAISE EXCEPTION 'BR08: an invoice needs at least one job and one line';
    END IF;
  END IF;
  IF s.sub <> NEW.sub_total_paise OR s.cg <> NEW.cgst_paise OR s.sg <> NEW.sgst_paise OR s.ig <> NEW.igst_paise THEN
    RAISE EXCEPTION 'BR08: invoice header totals do not match its lines';
  END IF;
  RETURN NULL;
END $$;

-- Build (compute, no writes) a PRODUCT_SALES invoice for one Sales Order.
-- p_lines: [{sales_order_line_id, quantity}] or NULL = every line's remaining
-- invoiceable quantity. Same GST maths as br08_build_invoice (place of supply =
-- customer state; tax per line, half-up to the paisa; header = sum of lines).
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

-- Issue: same br08_invoices INSERT (Finance-only + INV numbering by the existing
-- br08_guard_invoice trigger), then the source + sales lines in the same tx.
-- Idempotent on (company, key): a retry returns the original invoice.
CREATE OR REPLACE FUNCTION br08_issue_sales_invoice(p_company uuid, p_actor uuid, p_sales_order uuid, p_lines jsonb,
                                                    p_credit_days integer, p_idem varchar)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE d jsonb; v_id uuid; e jsonb;
BEGIN
  IF NULLIF(btrim(p_idem),'') IS NULL THEN RAISE EXCEPTION 'BR08: Idempotency-Key required for a product-sales invoice'; END IF;
  SELECT invoice_id INTO v_id FROM br08_sales_invoice_sources WHERE company_id=p_company AND idempotency_key=p_idem;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  -- serialise per order so two concurrent issues cannot both pass the quantity check
  PERFORM 1 FROM br11_sales_orders WHERE id=p_sales_order FOR UPDATE;
  PERFORM 1 FROM br11_sales_order_lines WHERE sales_order_id=p_sales_order ORDER BY id FOR UPDATE;
  d := br08_build_sales_invoice(p_company, p_sales_order, p_lines, p_credit_days);
  INSERT INTO br08_invoices
    (company_id,customer_id,invoice_number,invoice_seq,fiscal_year,invoice_date,credit_days,due_date,
     supplier_legal_name,supplier_gstin,supplier_state_code,supplier_state_name,supplier_address,
     customer_name,customer_gstin,customer_state_code,customer_address,
     place_of_supply_state_code,place_of_supply_state_name,tax_regime,
     sub_total_paise,cgst_paise,sgst_paise,igst_paise,total_paise,total_in_words,
     bank_snapshot,customer_order_refs,issued_by_id,invoice_type)
  VALUES (p_company, (d->>'customer_id')::uuid, 'pending', 0, '0000-00', CURRENT_DATE, (d->>'credit_days')::int,
     CURRENT_DATE + (d->>'credit_days')::int,
     d->'supplier'->>'legal_name', d->'supplier'->>'gstin', d->'supplier'->>'state_code', d->'supplier'->>'state_name',
     d->'supplier'->>'address',
     d->'customer'->>'name', d->'customer'->>'gstin', d->'customer'->>'state_code', d->'customer'->>'address',
     d->'place_of_supply'->>'state_code', d->'place_of_supply'->>'state_name', d->>'tax_regime',
     (d->>'sub_total_paise')::bigint, (d->>'cgst_paise')::bigint, (d->>'sgst_paise')::bigint,
     (d->>'igst_paise')::bigint, (d->>'total_paise')::bigint, d->>'total_in_words',
     d->'bank', d->'customer_order_refs', p_actor, 'PRODUCT_SALES')
  RETURNING id INTO v_id;
  INSERT INTO br08_sales_invoice_sources(company_id,invoice_id,sales_order_id,invoice_trigger_snapshot,idempotency_key)
  VALUES (p_company, v_id, p_sales_order, d->>'invoice_trigger', p_idem);
  FOR e IN SELECT * FROM jsonb_array_elements(d->'lines') LOOP
    INSERT INTO br08_invoice_sales_lines(company_id,invoice_id,line_no,sales_order_line_id,item_id,description,hsn_sac,
       quantity,uom,unit_price_paise,taxable_paise,cgst_rate,sgst_rate,igst_rate,cgst_paise,sgst_paise,igst_paise,line_total_paise)
    VALUES (p_company, v_id, (e->>'line_no')::int, (e->>'sales_order_line_id')::uuid, (e->>'item_id')::uuid,
       e->>'description', e->>'hsn_sac', (e->>'quantity')::numeric, e->>'uom', (e->>'unit_price_paise')::bigint,
       (e->>'taxable_paise')::bigint, (e->>'cgst_rate')::numeric, (e->>'sgst_rate')::numeric, (e->>'igst_rate')::numeric,
       (e->>'cgst_paise')::bigint, (e->>'sgst_paise')::bigint, (e->>'igst_paise')::bigint, (e->>'line_total_paise')::bigint);
  END LOOP;
  RETURN v_id;
END $$;

-- =============================================================================
-- Read model: one row per Sales Order line with every derived quantity.
-- Customer-facing figures only (no supplier cost).
CREATE OR REPLACE VIEW br11_v_sales_order_lines AS
SELECT l.company_id, l.sales_order_id, so.sales_order_number, so.status AS order_status,
       l.id AS sales_order_line_id, l.line_no, l.item_id, l.description_snapshot, l.uom,
       l.accepted_qty, l.unit_price_paise, l.line_status,
       COALESCE((SELECT sum(requested_qty) FROM br11_inventory_reservation_requests r
                  WHERE r.sales_order_line_id=l.id AND r.state='REQUESTED'),0) AS reservation_pending_qty,
       COALESCE((SELECT sum(requested_qty) FROM br11_inventory_reservation_requests r
                  WHERE r.sales_order_line_id=l.id AND r.state='CONFIRMED'),0) AS reserved_qty,
       COALESCE((SELECT sum(quantity) FROM br06_sales_sourcing_authorisations a
                  WHERE a.sales_order_line_id=l.id AND a.authorisation_status='APPROVED'),0) AS sourcing_authorised_qty,
       br11_line_shipped_qty(l.id) AS shipped_qty,
       br11_line_delivered_qty(l.id) AS delivered_qty,
       br11_line_invoiced_qty(l.id) AS invoiced_qty,
       l.accepted_qty - br11_line_delivered_qty(l.id) AS outstanding_delivery_qty
  FROM br11_sales_order_lines l JOIN br11_sales_orders so ON so.id=l.sales_order_id;
