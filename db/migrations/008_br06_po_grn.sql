-- 008_br06_po_grn.sql
--
-- BR-06 (Supplier PO -> acknowledgement -> shipment -> GRN -> supplier return)
-- has NO draft schema anywhere in 001 or 003 -- confirmed by grep before writing
-- this file. Unlike 005/006/007 (which filled small gaps in an existing
-- client-reviewed draft), this migration is a NEW schema designed from scratch
-- against CLAUDE.md's stated chain and explicit operator rules only. Nothing
-- here should be read as client-approved; it follows the same conventions
-- (company scoping, snapshot/versioning, append-only audit, single-writer
-- inventory posting) as the reviewed 001/003 modules.
--
-- DOFA (supplier PO financial authority) is an UNCONFIRMED CLAUDE.md section 5
-- blocker, same as in BR-05. Per instruction, this migration does NOT invent an
-- authority/approval-tier rule: br06_supplier_purchase_orders.po_status moves
-- DRAFT -> RELEASED with no value-tiered approval gate at all (see the API-layer
-- comment on the release action). This is the flagged stop, not a silent gap.
--
-- Photo-before-post is a hard DB gate (mirrors br02_guard_unit_verification):
-- a GRN line cannot be posted (accepted/rejected/held recorded) without at
-- least one photo for that line.

ALTER TABLE company_number_counters DROP CONSTRAINT company_number_counters_number_kind_check;
ALTER TABLE company_number_counters ADD CONSTRAINT company_number_counters_number_kind_check
  CHECK (number_kind IN ('JIN','JOB','MR','QT','PO','GRN'));

CREATE OR REPLACE FUNCTION br06_next_po_number(p_company_id uuid)
RETURNS varchar LANGUAGE plpgsql AS $$
DECLARE v_code varchar(3); v_seq bigint;
BEGIN
  SELECT entity_code INTO v_code FROM legal_entities WHERE id=p_company_id AND is_active;
  IF v_code IS NULL THEN RAISE EXCEPTION 'Company missing or inactive'; END IF;
  INSERT INTO company_number_counters(company_id,number_kind,last_value)
  VALUES(p_company_id,'PO',1)
  ON CONFLICT(company_id,number_kind) DO UPDATE
    SET last_value=company_number_counters.last_value+1, changed_at=now()
  RETURNING last_value INTO v_seq;
  RETURN 'PO-'||v_code||'-'||lpad(v_seq::text,6,'0');
END $$;

CREATE OR REPLACE FUNCTION br06_next_grn_number(p_company_id uuid)
RETURNS varchar LANGUAGE plpgsql AS $$
DECLARE v_code varchar(3); v_seq bigint;
BEGIN
  SELECT entity_code INTO v_code FROM legal_entities WHERE id=p_company_id AND is_active;
  IF v_code IS NULL THEN RAISE EXCEPTION 'Company missing or inactive'; END IF;
  INSERT INTO company_number_counters(company_id,number_kind,last_value)
  VALUES(p_company_id,'GRN',1)
  ON CONFLICT(company_id,number_kind) DO UPDATE
    SET last_value=company_number_counters.last_value+1, changed_at=now()
  RETURNING last_value INTO v_seq;
  RETURN 'GRN-'||v_code||'-'||lpad(v_seq::text,6,'0');
END $$;

-- ==============================================================================
-- br06_supplier_purchase_orders | Header. Sources a BR-04 selected procurement
-- offer against a BR-05 released job. po_status reaches RELEASED with no DOFA
-- gate -- see migration header note.
CREATE TABLE br06_supplier_purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  job_id uuid NOT NULL,
  po_number varchar(40) NOT NULL UNIQUE,
  source_br05_job_release_id uuid NOT NULL REFERENCES br05_job_releases(id),
  supplier_invite_id uuid NOT NULL REFERENCES br04_rfq_supplier_invites(id),
  supplier_name_snapshot varchar(200) NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'INR',
  payment_terms text,
  po_status varchar(20) NOT NULL DEFAULT 'DRAFT'
    CHECK (po_status IN ('DRAFT','RELEASED','ACKNOWLEDGED','SHIPPED','RECEIVED','CLOSED','CANCELLED')),
  created_by_id uuid NOT NULL,
  released_by_id uuid,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
  FOREIGN KEY(company_id,created_by_id) REFERENCES employees(company_id,id),
  FOREIGN KEY(company_id,released_by_id) REFERENCES employees(company_id,id),
  CHECK (po_status='DRAFT' OR (released_by_id IS NOT NULL AND released_at IS NOT NULL))
);
CREATE INDEX idx_br06_po_company_status ON br06_supplier_purchase_orders(company_id,po_status,created_at DESC);

-- br06_po_lines | Snapshot of quantity/price from the chosen BR-04 offer line
-- at PO-creation time. Immutable once the PO leaves DRAFT.
CREATE TABLE br06_po_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES br06_supplier_purchase_orders(id),
  line_no integer NOT NULL CHECK(line_no>0),
  source_br04_offer_line_id uuid NOT NULL REFERENCES br04_supplier_offer_lines(id),
  item_bridge_id uuid NOT NULL REFERENCES br03_item_catalog_bridge(id),
  quantity numeric(16,4) NOT NULL CHECK(quantity>0),
  uom varchar(16) NOT NULL,
  unit_price numeric(18,4) NOT NULL CHECK(unit_price>=0),
  UNIQUE(po_id,line_no)
);

CREATE TABLE br06_po_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL UNIQUE REFERENCES br06_supplier_purchase_orders(id),
  supplier_reference varchar(120),
  expected_delivery_date date,
  notes text,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  recorded_by_id uuid NOT NULL REFERENCES employees(id)
);

CREATE TABLE br06_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES br06_supplier_purchase_orders(id),
  carrier varchar(120),
  awb_or_lr_number varchar(120),
  expected_arrival_date date,
  notes text,
  shipped_at timestamptz NOT NULL DEFAULT now(),
  recorded_by_id uuid NOT NULL REFERENCES employees(id)
);

-- br06_grns | Goods Receipt Note header.
CREATE TABLE br06_grns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  po_id uuid NOT NULL REFERENCES br06_supplier_purchase_orders(id),
  grn_number varchar(40) NOT NULL UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  received_by_id uuid NOT NULL,
  notes text,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,received_by_id) REFERENCES employees(company_id,id)
);

-- br06_grn_lines | Disposition per PO line: accepted/rejected/held must not
-- exceed what was physically received. posted_at marks the moment inventory
-- postings for this line were made (gated by the photo trigger below).
CREATE TABLE br06_grn_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_id uuid NOT NULL REFERENCES br06_grns(id),
  po_line_id uuid NOT NULL REFERENCES br06_po_lines(id),
  item_bridge_id uuid NOT NULL REFERENCES br03_item_catalog_bridge(id),
  uom varchar(16) NOT NULL,
  ordered_quantity numeric(16,4) NOT NULL CHECK(ordered_quantity>0),
  received_quantity numeric(16,4) NOT NULL CHECK(received_quantity>=0),
  accepted_quantity numeric(16,4) NOT NULL DEFAULT 0 CHECK(accepted_quantity>=0),
  rejected_quantity numeric(16,4) NOT NULL DEFAULT 0 CHECK(rejected_quantity>=0),
  held_quantity numeric(16,4) NOT NULL DEFAULT 0 CHECK(held_quantity>=0),
  returned_quantity numeric(16,4) NOT NULL DEFAULT 0 CHECK(returned_quantity>=0),
  posted_at timestamptz,
  main_store_movement_ref uuid,
  quarantine_movement_ref uuid,
  return_movement_ref uuid,
  CHECK(accepted_quantity+rejected_quantity+held_quantity<=received_quantity),
  CHECK(returned_quantity<=rejected_quantity+held_quantity),
  UNIQUE(grn_id,po_line_id)
);

CREATE TABLE br06_grn_line_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_line_id uuid NOT NULL REFERENCES br06_grn_lines(id),
  file_uri text NOT NULL,
  file_name varchar(255) NOT NULL,
  uploaded_by_id uuid NOT NULL REFERENCES employees(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_br06_grn_media_line ON br06_grn_line_media(grn_line_id);

-- Photo-before-post gate: mirrors br02_guard_unit_verification exactly.
CREATE OR REPLACE FUNCTION br06_guard_grn_line_post()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.posted_at IS NOT NULL AND OLD.posted_at IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM br06_grn_line_media WHERE grn_line_id=NEW.id) THEN
      RAISE EXCEPTION 'Upload at least one photo for this GRN line before posting';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br06_grn_line_post BEFORE UPDATE OF posted_at
ON br06_grn_lines FOR EACH ROW EXECUTE FUNCTION br06_guard_grn_line_post();
