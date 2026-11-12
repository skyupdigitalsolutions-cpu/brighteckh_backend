-- ============================================================================
-- Brightech JMS — FOUNDATION (F1 Masters + F2 Inventory Ledger)
-- Additive migration. Depends on 001 (legal_entities, employees).
-- Built to BR-01B Master Data Fields workbook + Foundation Build Contract Rev00.
-- Fresh EMPTY staging only. SQL owns schema + triggers; Prisma is client-only.
-- ============================================================================

-- ---------- shared helper: block UPDATE/DELETE (append-only) ----------------
CREATE OR REPLACE FUNCTION fdn_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append_only: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fdn_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- ============================================================================
-- F1. CODE DICTIONARY (BR-01A: validate CC/SS/TT against ACTIVE approved rows)
-- One table, scoped by level. kind = ITEM (CC 01-17) or ASSEMBLY (CC 50-62).
-- ============================================================================
CREATE TABLE fdn_code_dictionary (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         varchar(10) NOT NULL CHECK (kind IN ('ITEM','ASSEMBLY')),
  cc           char(2) NOT NULL CHECK (cc ~ '^[0-9]{2}$'),
  ss           char(2) NOT NULL CHECK (ss ~ '^[0-9]{2}$'),
  tt           char(2) NOT NULL CHECK (tt ~ '^[0-9]{2}$'),
  label        varchar(200) NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, cc, ss, tt)
);
-- A row with ss='00' tt='00' defines the CC level; ss/tt='00' the SS level, etc.

CREATE OR REPLACE FUNCTION fdn_assert_code_class(p_kind varchar, p_cc char, p_ss char, p_tt char)
RETURNS void AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fdn_code_dictionary
    WHERE kind = p_kind AND cc = p_cc AND ss = p_ss AND tt = p_tt AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_or_inactive_code_class: % %/%/%', p_kind, p_cc, p_ss, p_tt
      USING ERRCODE = 'foreign_key_violation';
  END IF;
END; $$ LANGUAGE plpgsql;

-- ============================================================================
-- F1. MANUFACTURERS + MPN (IM-027) — manufacturer identity kept OUT of code
-- ============================================================================
CREATE TABLE fdn_manufacturers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(200) NOT NULL UNIQUE,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- F1. SUPPLIER MASTER (legal party; supplier may also be customer)
-- status DRAFT/PENDING/ACTIVE/SUSPENDED. Bank changes = restricted (app policy).
-- ============================================================================
CREATE TABLE fdn_suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_code   varchar(20) NOT NULL UNIQUE,
  legal_name      varchar(200) NOT NULL,
  display_name    varchar(150),
  supplier_role   varchar(20) NOT NULL DEFAULT 'SUPPLIER'
                    CHECK (supplier_role IN ('SUPPLIER','SUPPLIER_CUSTOMER')),
  gstin           varchar(15) CHECK (gstin IS NULL OR gstin ~ '^[0-9A-Z]{15}$'),
  pan             varchar(10),
  payment_terms   varchar(60),
  status          varchar(12) NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','PENDING','ACTIVE','SUSPENDED')),
  approved_by_id  uuid REFERENCES employees(id),
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_fdn_suppliers_touch BEFORE UPDATE ON fdn_suppliers
  FOR EACH ROW EXECUTE FUNCTION fdn_touch_updated_at();

-- ============================================================================
-- F1. ITEM MASTER — BR-01B IM-001..IM-036
-- Code is GLOBALLY unique (BR-01A), manufacturer-independent. Code + CC/SS/TT
-- immutable after insert (Change policy = Never).
-- ============================================================================
CREATE TABLE fdn_item_master (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code                char(12) NOT NULL UNIQUE CHECK (item_code ~ '^[0-9]{12}$'),  -- IM-001
  record_type              varchar(12) NOT NULL CHECK (record_type IN ('ITEM','COMPONENT','CONSUMABLE')), -- IM-002
  standard_name            varchar(300) NOT NULL,          -- IM-003
  short_description        varchar(120),                   -- IM-004
  cc                       char(2) NOT NULL,               -- IM-005
  ss                       char(2) NOT NULL,               -- IM-006
  tt                       char(2) NOT NULL,               -- IM-007
  detailed_spec            jsonb NOT NULL DEFAULT '{}',    -- IM-008 structured family template
  base_uom                 varchar(12) NOT NULL,           -- IM-009
  use_case                 varchar(200) NOT NULL,          -- IM-010
  criticality              varchar(20),                    -- IM-012
  equivalence_rule         text,                           -- IM-013
  package_footprint        varchar(60),                    -- IM-014
  dimensions               jsonb,                          -- IM-015
  electrical_ratings       jsonb,                          -- IM-016
  operating_conditions     jsonb,                          -- IM-017
  material_grade           varchar(120),                   -- IM-018
  reorder_min_qty          numeric(18,4),                  -- IM-019
  stock_flag               varchar(12) NOT NULL DEFAULT 'STOCK'
                            CHECK (stock_flag IN ('STOCK','NON_STOCK','CONSUMABLE')), -- IM-020
  batch_tracking           boolean NOT NULL DEFAULT false, -- IM-021
  serial_tracking          boolean NOT NULL DEFAULT false, -- IM-022
  storage_instructions     text,                           -- IM-023
  inspection_criteria      text,                           -- IM-024
  lead_time_days           integer,                        -- IM-025
  hsn_tax                  varchar(20),                    -- IM-026
  status                   varchar(14) NOT NULL DEFAULT 'DRAFT'  -- IM-031
                            CHECK (status IN ('DRAFT','UNDER_REVIEW','APPROVED','ACTIVE','ON_HOLD','INACTIVE','SUPERSEDED')),
  duplicate_review_note    text NOT NULL,                  -- IM-030 (mandatory)
  created_by_id            uuid NOT NULL REFERENCES employees(id),   -- IM-032
  created_at               timestamptz NOT NULL DEFAULT now(),
  tech_approved_by_id      uuid REFERENCES employees(id),  -- IM-033
  tech_approved_at         timestamptz,
  released_by_id           uuid REFERENCES employees(id),  -- IM-034
  released_at              timestamptz,
  effective_revision       integer NOT NULL DEFAULT 0,     -- IM-035
  superseded_by_id         uuid REFERENCES fdn_item_master(id), -- IM-036
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fdn_item_status ON fdn_item_master(status);
CREATE INDEX idx_fdn_item_class  ON fdn_item_master(cc,ss,tt);

-- validate class against active dictionary on insert
CREATE OR REPLACE FUNCTION fdn_item_validate() RETURNS trigger AS $$
BEGIN
  PERFORM fdn_assert_code_class('ITEM', NEW.cc, NEW.ss, NEW.tt);
  -- item_code prefix must match class
  IF left(NEW.item_code,6) <> (NEW.cc||NEW.ss||NEW.tt) THEN
    RAISE EXCEPTION 'item_code prefix % must equal class %', left(NEW.item_code,6), NEW.cc||NEW.ss||NEW.tt;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_fdn_item_validate BEFORE INSERT ON fdn_item_master
  FOR EACH ROW EXECUTE FUNCTION fdn_item_validate();

-- immutability: code + class never change (IM Change policy = Never)
CREATE OR REPLACE FUNCTION fdn_item_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.item_code <> OLD.item_code OR NEW.cc<>OLD.cc OR NEW.ss<>OLD.ss OR NEW.tt<>OLD.tt
     OR NEW.created_by_id<>OLD.created_by_id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'immutable_field: item_code/class/created audit cannot change';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_fdn_item_immutable BEFORE UPDATE ON fdn_item_master
  FOR EACH ROW EXECUTE FUNCTION fdn_item_immutable();

-- item <-> approved manufacturer part (IM-027): one code -> many approved MPNs
CREATE TABLE fdn_item_manufacturer_parts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id           uuid NOT NULL REFERENCES fdn_item_master(id),
  manufacturer_id   uuid NOT NULL REFERENCES fdn_manufacturers(id),
  mpn               varchar(120) NOT NULL,
  mpn_revision      varchar(40),
  approved_by_id    uuid REFERENCES employees(id),
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manufacturer_id, mpn, mpn_revision)
);

-- item aliases / legacy codes (IM-029)
CREATE TABLE fdn_item_aliases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid NOT NULL REFERENCES fdn_item_master(id),
  alias      varchar(120) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alias)
);

-- ============================================================================
-- F1. ASSEMBLY MASTER — BR-01B AM-001..AM-027
-- ============================================================================
CREATE TABLE fdn_assembly_master (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assembly_code           char(12) NOT NULL UNIQUE CHECK (assembly_code ~ '^[0-9]{12}$'), -- AM-001
  standard_name           varchar(300) NOT NULL,          -- AM-002
  cc                      char(2) NOT NULL,               -- AM-003
  ss                      char(2) NOT NULL,
  tt                      char(2) NOT NULL,
  assembly_type           varchar(30) NOT NULL CHECK (assembly_type IN
                            ('ELECTRONIC_CARD','MOTOR','DRIVE','MODULE','INSTRUMENT','OTHER')), -- AM-004
  core_function           varchar(300) NOT NULL,          -- AM-005
  specifications          jsonb NOT NULL DEFAULT '{}',    -- AM-006
  variant_interface       varchar(300),                   -- AM-007
  oem_compatibility       text,                           -- AM-008
  hardware_revision       varchar(40),                    -- AM-009
  firmware_compat         varchar(120),                   -- AM-010
  connector_pinout        text,                           -- AM-012
  mounting_dimensions     jsonb,                           -- AM-013
  environmental_rating    jsonb,                           -- AM-014
  bom_status              varchar(14) NOT NULL DEFAULT 'UNKNOWN'
                            CHECK (bom_status IN ('KNOWN','PARTIAL','UNKNOWN','NOT_APPLICABLE')), -- AM-015
  repairable              boolean NOT NULL,               -- AM-017 (independent)
  saleable                boolean NOT NULL,               -- AM-018 (independent)
  test_criteria           text,                           -- AM-021
  duplicate_review_note   text NOT NULL,                  -- AM-024 (mandatory)
  status                  varchar(14) NOT NULL DEFAULT 'DRAFT'  -- AM-025
                            CHECK (status IN ('DRAFT','UNDER_REVIEW','APPROVED','ACTIVE','ON_HOLD','INACTIVE','SUPERSEDED')),
  created_by_id           uuid NOT NULL REFERENCES employees(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  tech_approved_by_id     uuid REFERENCES employees(id),
  tech_approved_at        timestamptz,
  released_by_id          uuid REFERENCES employees(id),
  released_at             timestamptz,
  effective_revision      integer NOT NULL DEFAULT 0,     -- AM-026
  superseded_by_id        uuid REFERENCES fdn_assembly_master(id), -- AM-027
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fdn_assembly_status ON fdn_assembly_master(status);

CREATE OR REPLACE FUNCTION fdn_assembly_validate() RETURNS trigger AS $$
BEGIN
  PERFORM fdn_assert_code_class('ASSEMBLY', NEW.cc, NEW.ss, NEW.tt);
  IF left(NEW.assembly_code,6) <> (NEW.cc||NEW.ss||NEW.tt) THEN
    RAISE EXCEPTION 'assembly_code prefix % must equal class %', left(NEW.assembly_code,6), NEW.cc||NEW.ss||NEW.tt;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_fdn_assembly_validate BEFORE INSERT ON fdn_assembly_master
  FOR EACH ROW EXECUTE FUNCTION fdn_assembly_validate();

CREATE OR REPLACE FUNCTION fdn_assembly_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.assembly_code<>OLD.assembly_code OR NEW.cc<>OLD.cc OR NEW.ss<>OLD.ss OR NEW.tt<>OLD.tt
     OR NEW.created_by_id<>OLD.created_by_id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'immutable_field: assembly_code/class/created audit cannot change';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_fdn_assembly_immutable BEFORE UPDATE ON fdn_assembly_master
  FOR EACH ROW EXECUTE FUNCTION fdn_assembly_immutable();

-- Assembly BOM (AM-016): versioned links to Item Master + qty
CREATE TABLE fdn_assembly_bom (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assembly_id   uuid NOT NULL REFERENCES fdn_assembly_master(id),
  bom_revision  integer NOT NULL DEFAULT 0,
  item_id       uuid NOT NULL REFERENCES fdn_item_master(id),
  qty_per       numeric(18,4) NOT NULL CHECK (qty_per > 0),
  uom           varchar(12) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assembly_id, bom_revision, item_id)
);

CREATE TABLE fdn_assembly_aliases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assembly_id uuid NOT NULL REFERENCES fdn_assembly_master(id),
  alias       varchar(120) NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- F2. INVENTORY LEDGER — single-writer, append-only journal + materialised bal.
-- Company-scoped. BR-04/05/06/07 are CONSUMERS; only fdn_post_movement writes.
-- ============================================================================
CREATE TABLE fdn_inventory_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES legal_entities(id),
  code        varchar(40) NOT NULL,
  role        varchar(20) NOT NULL CHECK (role IN
               ('MAIN_STORE','QUARANTINE','ENGINEER_HELD','IN_TRANSIT','RETURNED','CONSUMED','SUPPLIER_RETURN')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)           -- for composite company-scoped FKs
);

-- Materialised balances (written ONLY by fdn_post_movement, under row lock)
CREATE TABLE fdn_inventory_balances (
  company_id   uuid NOT NULL REFERENCES legal_entities(id),
  item_id      uuid NOT NULL REFERENCES fdn_item_master(id),
  location_id  uuid NOT NULL REFERENCES fdn_inventory_locations(id),
  qty_on_hand  numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),  -- no negative usable stock
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, item_id, location_id)
);

-- Append-only journal
CREATE TABLE fdn_inventory_journal (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES legal_entities(id),
  item_id          uuid NOT NULL REFERENCES fdn_item_master(id),
  uom              varchar(12) NOT NULL,
  qty              numeric(18,4) NOT NULL CHECK (qty > 0),
  from_location_id uuid REFERENCES fdn_inventory_locations(id),
  to_location_id   uuid REFERENCES fdn_inventory_locations(id),
  movement_type    varchar(16) NOT NULL CHECK (movement_type IN
                    ('RECEIPT','ISSUE','CONSUME','RETURN','SUPPLIER_RETURN','TRANSFER','ADJUST')),
  reference_kind   varchar(40) NOT NULL,     -- e.g. BR06_GRN_LINE, BR07_ISSUE, BR05_RESERVATION
  reference_id     uuid,
  idempotency_key  varchar(120) NOT NULL UNIQUE,   -- dedupe / retry safety
  status           varchar(12) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
  actor_id         uuid REFERENCES employees(id),
  posted_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL)
);
CREATE INDEX idx_fdn_journal_item ON fdn_inventory_journal(company_id,item_id);
CREATE INDEX idx_fdn_journal_ref  ON fdn_inventory_journal(reference_kind,reference_id);
-- append-only: no UPDATE/DELETE
CREATE TRIGGER trg_fdn_journal_append_only BEFORE UPDATE OR DELETE ON fdn_inventory_journal
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- Reservations (BR-05). ACTIVE reservations reduce allocatable, not on_hand.
CREATE TABLE fdn_inventory_reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES legal_entities(id),
  item_id       uuid NOT NULL REFERENCES fdn_item_master(id),
  qty           numeric(18,4) NOT NULL CHECK (qty > 0),
  reference_kind varchar(40) NOT NULL,     -- e.g. BR05_JOB_RESERVATION
  reference_id  uuid,
  idempotency_key varchar(120) NOT NULL UNIQUE,
  status        varchar(12) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED','CONSUMED','EXPIRED')),
  expires_at    timestamptz,
  created_by_id uuid REFERENCES employees(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fdn_resv_item ON fdn_inventory_reservations(company_id,item_id,status);
CREATE TRIGGER trg_fdn_resv_touch BEFORE UPDATE ON fdn_inventory_reservations
  FOR EACH ROW EXECUTE FUNCTION fdn_touch_updated_at();

-- ---------- allocatable availability (one authoritative computation) --------
-- allocatable = MAIN_STORE on_hand - ACTIVE reservations. Engineer/quarantine excluded.
CREATE OR REPLACE FUNCTION fdn_allocatable(p_company uuid, p_item uuid)
RETURNS numeric AS $$
DECLARE v_main numeric; v_resv numeric;
BEGIN
  SELECT COALESCE(SUM(b.qty_on_hand),0) INTO v_main
    FROM fdn_inventory_balances b
    JOIN fdn_inventory_locations l ON l.id=b.location_id
   WHERE b.company_id=p_company AND b.item_id=p_item AND l.role='MAIN_STORE';
  SELECT COALESCE(SUM(qty),0) INTO v_resv
    FROM fdn_inventory_reservations
   WHERE company_id=p_company AND item_id=p_item AND status='ACTIVE';
  RETURN v_main - v_resv;
END; $$ LANGUAGE plpgsql;

-- ---------- THE SINGLE WRITER: post a stock movement, idempotent -----------
CREATE OR REPLACE FUNCTION fdn_post_movement(
  p_company uuid, p_item uuid, p_uom varchar, p_qty numeric,
  p_from uuid, p_to uuid, p_type varchar,
  p_ref_kind varchar, p_ref_id uuid, p_idem varchar, p_actor uuid
) RETURNS uuid AS $$
DECLARE v_existing uuid; v_from_co uuid; v_to_co uuid; v_bal numeric; v_jid uuid;
BEGIN
  -- idempotency: same key -> same outcome
  SELECT id INTO v_existing FROM fdn_inventory_journal WHERE idempotency_key=p_idem;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'INVALID_QTY' USING ERRCODE='check_violation'; END IF;

  -- item must be APPROVED or ACTIVE
  IF NOT EXISTS (SELECT 1 FROM fdn_item_master WHERE id=p_item AND status IN ('APPROVED','ACTIVE')) THEN
    RAISE EXCEPTION 'MISSING_ITEM_APPROVAL' USING ERRCODE='foreign_key_violation'; END IF;

  -- locations must belong to the company
  IF p_from IS NOT NULL THEN
    SELECT company_id INTO v_from_co FROM fdn_inventory_locations WHERE id=p_from;
    IF v_from_co IS NULL OR v_from_co<>p_company THEN RAISE EXCEPTION 'COMPANY_MISMATCH_FROM'; END IF;
  END IF;
  IF p_to IS NOT NULL THEN
    SELECT company_id INTO v_to_co FROM fdn_inventory_locations WHERE id=p_to;
    IF v_to_co IS NULL OR v_to_co<>p_company THEN RAISE EXCEPTION 'COMPANY_MISMATCH_TO'; END IF;
  END IF;

  -- debit source under row lock (prevents negative + races)
  IF p_from IS NOT NULL THEN
    INSERT INTO fdn_inventory_balances(company_id,item_id,location_id,qty_on_hand)
      VALUES (p_company,p_item,p_from,0)
      ON CONFLICT (company_id,item_id,location_id) DO NOTHING;
    SELECT qty_on_hand INTO v_bal FROM fdn_inventory_balances
      WHERE company_id=p_company AND item_id=p_item AND location_id=p_from FOR UPDATE;
    IF v_bal < p_qty THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK' USING ERRCODE='check_violation'; END IF;
    UPDATE fdn_inventory_balances SET qty_on_hand=qty_on_hand-p_qty, updated_at=now()
      WHERE company_id=p_company AND item_id=p_item AND location_id=p_from;
  END IF;

  -- credit destination under row lock
  IF p_to IS NOT NULL THEN
    INSERT INTO fdn_inventory_balances(company_id,item_id,location_id,qty_on_hand)
      VALUES (p_company,p_item,p_to,0)
      ON CONFLICT (company_id,item_id,location_id) DO NOTHING;
    PERFORM 1 FROM fdn_inventory_balances
      WHERE company_id=p_company AND item_id=p_item AND location_id=p_to FOR UPDATE;
    UPDATE fdn_inventory_balances SET qty_on_hand=qty_on_hand+p_qty, updated_at=now()
      WHERE company_id=p_company AND item_id=p_item AND location_id=p_to;
  END IF;

  INSERT INTO fdn_inventory_journal(company_id,item_id,uom,qty,from_location_id,to_location_id,
      movement_type,reference_kind,reference_id,idempotency_key,actor_id)
    VALUES (p_company,p_item,p_uom,p_qty,p_from,p_to,p_type,p_ref_kind,p_ref_id,p_idem,p_actor)
    RETURNING id INTO v_jid;
  RETURN v_jid;
END; $$ LANGUAGE plpgsql;

-- ---------- reserve / release (BR-05) --------------------------------------
CREATE OR REPLACE FUNCTION fdn_reserve(
  p_company uuid, p_item uuid, p_qty numeric, p_ref_kind varchar, p_ref_id uuid,
  p_idem varchar, p_actor uuid, p_expires timestamptz
) RETURNS uuid AS $$
DECLARE v_existing uuid; v_alloc numeric; v_rid uuid;
BEGIN
  SELECT id INTO v_existing FROM fdn_inventory_reservations WHERE idempotency_key=p_idem;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  -- lock item balances to serialise allocatable check
  PERFORM 1 FROM fdn_inventory_balances WHERE company_id=p_company AND item_id=p_item FOR UPDATE;
  v_alloc := fdn_allocatable(p_company,p_item);
  IF v_alloc < p_qty THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK' USING ERRCODE='check_violation'; END IF;
  INSERT INTO fdn_inventory_reservations(company_id,item_id,qty,reference_kind,reference_id,idempotency_key,created_by_id,expires_at)
    VALUES (p_company,p_item,p_qty,p_ref_kind,p_ref_id,p_idem,p_actor,p_expires)
    RETURNING id INTO v_rid;
  RETURN v_rid;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fdn_release_reservation(p_id uuid, p_status varchar DEFAULT 'RELEASED')
RETURNS void AS $$
BEGIN
  UPDATE fdn_inventory_reservations SET status=p_status
    WHERE id=p_id AND status='ACTIVE';
END; $$ LANGUAGE plpgsql;
