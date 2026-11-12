-- BRIGHTECH | BR01 through BR05 | INTEGRATED FRESH-STAGING SQL Rev01
-- NOT APPROVED / NOT PRODUCTION READY / NOT an ALTER migration.
-- Execute ONLY on a disposable EMPTY PostgreSQL 15+ database after reviewing
-- real BR01 canonical masters, inventory ledger, named roles, and business decisions.
-- No canonical BR01 Item/Supplier Master or stock ledger is created by this script.
-- SOURCE MODULES follow in their original deployment order; the last section
-- is a newly prepared consistency overlay, NOT a retroactive change in SOP approval.


-- ======================================================================
-- COMPONENT 1: Brightech_BR02_Rev04_Consolidated_PostgreSQL_Schema.sql
-- ======================================================================

-- BRIGHTECH BR-02A/B/C | UNIFIED JOB INWARD | POSTGRESQL 15+
-- Version: REV-04-Aligned / Developer Proposal (29 Oct 2026)
-- ALL statements are proposals for review; NOT production migration.
-- Confirmed business rules and pending integration decisions documented in workbook.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ==============================================================================
-- legal_entities | BR01 integration | Two separate issuing companies with independent numbers and access. Legal names pending.
CREATE TABLE legal_entities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_code varchar(3) NOT NULL UNIQUE CHECK (entity_code SIMILAR TO '[A-Z]{3}'),
    legal_name varchar(200),
    name varchar(150) NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ==============================================================================
-- company_number_counters | Numbering | Two independent counters (JIN/JOB) for each company; never reset yearly.
CREATE TABLE company_number_counters (
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    number_kind varchar(3) NOT NULL CHECK (number_kind IN ('JIN','JOB')),
    last_value bigint NOT NULL CHECK (last_value >= 0),
    changed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(company_id,number_kind)
);

-- ==============================================================================
-- customers | BR01C integration | Lookup-only customer master. Customer must be created in master first; Pending Approval allowed.
CREATE TABLE customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    customer_code varchar(40) NOT NULL,
    customer_name varchar(200) NOT NULL,
    primary_email varchar(254),
    mobile varchar(30),
    status varchar(24) NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','APPROVED','INACTIVE','REJECTED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(company_id,id),
    UNIQUE(company_id,customer_code)
);

-- ==============================================================================
-- assemblies | BR01B integration | Assembly Master used as mandatory lookup per quantity group; manufacturer not in internal code.
CREATE TABLE assemblies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    assembly_code varchar(32) NOT NULL UNIQUE,
    assembly_name varchar(250) NOT NULL,
    status varchar(24) NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','APPROVED','INACTIVE','REJECTED')),
    repairable boolean NOT NULL DEFAULT true,
    saleable boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ==============================================================================
-- employees | BR01C integration | Employee identity, company and role for Purchase/Service ownership.
CREATE TABLE employees (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    employee_code varchar(40) NOT NULL,
    full_name varchar(150) NOT NULL,
    role_code varchar(40) NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(company_id,id),
    UNIQUE(company_id,employee_code)
);

-- ==============================================================================
-- custody_locations | BR01C integration | Physical areas/racks where customer equipment is kept.
CREATE TABLE custody_locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    location_code varchar(40) NOT NULL,
    location_name varchar(150) NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    UNIQUE(company_id,id),
    UNIQUE(company_id,location_code)
);

-- ==============================================================================
-- working_calendars | SLA | Company-specific working time and timezone; actual schedules pending.
CREATE TABLE working_calendars (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    timezone varchar(60) NOT NULL DEFAULT 'Asia/Kolkata',
    working_dow smallint[] NOT NULL,
    start_local time NOT NULL,
    end_local time NOT NULL,
    is_active boolean NOT NULL DEFAULT false,
    CHECK(start_local < end_local),
    UNIQUE(company_id,id)
);

-- ==============================================================================
-- calendar_holidays | SLA | Exceptions to company working calendars.
CREATE TABLE calendar_holidays (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    calendar_id uuid NOT NULL REFERENCES working_calendars(id),
    holiday_date date NOT NULL,
    description varchar(150),
    UNIQUE(calendar_id,holiday_date)
);

-- ==============================================================================
-- sla_policy_rules | SLA | Approved clock targets and unapproved configurable routing.
CREATE TABLE sla_policy_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    event_code varchar(50) NOT NULL,
    minutes_allowed integer NOT NULL CHECK(minutes_allowed >= 0),
    clock_basis varchar(14) NOT NULL CHECK(clock_basis IN ('WORKING','ELAPSED','IMMEDIATE')),
    is_approved boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT false,
    UNIQUE(company_id,event_code)
);

-- ==============================================================================
-- inward_receipts | BR02A | One header/JIN per physical walk-in or courier receipt, before equipment is fully verified.
CREATE TABLE inward_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    jin_number varchar(40) NOT NULL UNIQUE,
    customer_id uuid NOT NULL,
    customer_status_snapshot varchar(24) NOT NULL,
    receipt_at timestamptz NOT NULL,
    receipt_channel varchar(12) NOT NULL CHECK (receipt_channel IN ('WALK_IN','COURIER')),
    received_by_id uuid NOT NULL,
    customer_dc_number varchar(120),
    dc_date date,
    dc_exception_status varchar(18) NOT NULL DEFAULT 'NONE' CHECK (dc_exception_status IN ('NONE','PENDING','RESOLVED','REJECTED')),
    dc_exception_reason text,
    courier_name varchar(120),
    courier_awb varchar(120),
    declared_quantity integer CHECK(declared_quantity >= 0),
    priority varchar(12) NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','URGENT','CRITICAL')),
    priority_reason text,
    receipt_status varchar(24) NOT NULL DEFAULT 'REGISTERED' CHECK (receipt_status IN ('REGISTERED','VERIFYING','VERIFIED','ON_HOLD','REJECTED','CLOSED')),
    fiscal_year varchar(9),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(company_id,id),
    FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),
    FOREIGN KEY(company_id,received_by_id) REFERENCES employees(company_id,id),
    CHECK (priority='NORMAL' OR nullif(btrim(priority_reason),'') IS NOT NULL),
    CHECK (customer_dc_number IS NOT NULL OR dc_exception_status <> 'NONE')
);
CREATE INDEX idx_receipt_company_time ON inward_receipts(company_id,receipt_at DESC);
CREATE INDEX idx_receipt_customer ON inward_receipts(company_id,customer_id);

-- ==============================================================================
-- inward_documents | BR02A-B | DC scan, courier proof, and inward attachments.
CREATE TABLE inward_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    inward_id uuid NOT NULL REFERENCES inward_receipts(id),
    document_type varchar(32) NOT NULL,
    file_uri text NOT NULL,
    file_name varchar(255) NOT NULL,
    mime_type varchar(100),
    uploaded_by_id uuid NOT NULL REFERENCES employees(id),
    uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- ==============================================================================
-- inward_equipment_groups | BR02B | One Assembly Master selection and Qty Received on unified screen; expands to unit rows.
CREATE TABLE inward_equipment_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    inward_id uuid NOT NULL,
    group_number integer NOT NULL CHECK(group_number > 0),
    assembly_id uuid NOT NULL REFERENCES assemblies(id),
    assembly_status_snapshot varchar(24) NOT NULL,
    quantity_received integer NOT NULL CHECK(quantity_received > 0),
    customer_dc_line varchar(100),
    created_by_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(company_id,id),
    UNIQUE(company_id,inward_id,id),
    UNIQUE(inward_id,group_number),
    FOREIGN KEY(company_id,inward_id) REFERENCES inward_receipts(company_id,id),
    FOREIGN KEY(company_id,created_by_id) REFERENCES employees(company_id,id)
);
CREATE INDEX idx_group_inward ON inward_equipment_groups(inward_id,group_number);

-- ==============================================================================
-- inward_equipment_units | BR02B | One unit row per physical piece, including identical assemblies (unit quantity=1).
CREATE TABLE inward_equipment_units (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    inward_id uuid NOT NULL,
    group_id uuid NOT NULL,
    unit_number integer NOT NULL CHECK(unit_number > 0),
    unit_quantity smallint NOT NULL DEFAULT 1 CHECK(unit_quantity = 1),
    serial_number varchar(150),
    observed_make varchar(150),
    observed_model varchar(150),
    reported_fault text,
    physical_condition text,
    accessories text,
    verification_status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','VERIFIED','ON_HOLD','REJECTED')),
    verified_at timestamptz,
    verified_by_id uuid,
    current_location_id uuid NOT NULL,
    current_custodian_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(company_id,id),
    UNIQUE(company_id,inward_id,id),
    UNIQUE(group_id,unit_number),
    FOREIGN KEY(company_id,inward_id) REFERENCES inward_receipts(company_id,id),
    FOREIGN KEY(company_id,inward_id,group_id) REFERENCES inward_equipment_groups(company_id,inward_id,id),
    FOREIGN KEY(company_id,verified_by_id) REFERENCES employees(company_id,id),
    FOREIGN KEY(company_id,current_location_id) REFERENCES custody_locations(company_id,id),
    FOREIGN KEY(company_id,current_custodian_id) REFERENCES employees(company_id,id),
    CHECK (verification_status <> 'VERIFIED' OR (verified_at IS NOT NULL AND verified_by_id IS NOT NULL))
);
CREATE INDEX idx_units_group ON inward_equipment_units(group_id,unit_number);
CREATE INDEX idx_units_location ON inward_equipment_units(company_id,current_location_id);

-- ==============================================================================
-- equipment_photos | BR02B | Unlimited number of stored image references per independently tracked unit.
CREATE TABLE equipment_photos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id uuid NOT NULL REFERENCES inward_equipment_units(id),
    file_uri text NOT NULL,
    file_name varchar(250) NOT NULL,
    photo_category varchar(32),
    mime_type varchar(100),
    file_size_bytes bigint CHECK(file_size_bytes >= 0),
    uploaded_by_id uuid NOT NULL REFERENCES employees(id),
    uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_photos_unit ON equipment_photos(unit_id);

-- ==============================================================================
-- inward_discrepancies | BR02B | Trace DC mismatch, damage, missing accessories and Purchase Team decisions.
CREATE TABLE inward_discrepancies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    inward_id uuid NOT NULL REFERENCES inward_receipts(id),
    unit_id uuid REFERENCES inward_equipment_units(id),
    discrepancy_type varchar(40) NOT NULL,
    details text NOT NULL,
    resolution_status varchar(16) NOT NULL DEFAULT 'OPEN' CHECK (resolution_status IN ('OPEN','HOLD','CORRECTED','ACCEPTED','REJECTED')),
    resolved_by_id uuid REFERENCES employees(id),
    resolved_at timestamptz,
    resolution_notes text
);

-- ==============================================================================
-- custody_movements | BR02B-C | Immutable history of equipment transfers between location and employees.
CREATE TABLE custody_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id uuid NOT NULL REFERENCES inward_equipment_units(id),
    from_location_id uuid REFERENCES custody_locations(id),
    to_location_id uuid NOT NULL REFERENCES custody_locations(id),
    from_employee_id uuid REFERENCES employees(id),
    to_employee_id uuid NOT NULL REFERENCES employees(id),
    moved_at timestamptz NOT NULL DEFAULT now(),
    recorded_by_id uuid NOT NULL REFERENCES employees(id),
    accepted_at timestamptz,
    movement_note text
);
CREATE INDEX idx_move_unit_time ON custody_movements(unit_id,moved_at DESC);

-- ==============================================================================
-- equipment_quantity_adjustments | BR02B | History for any exceptional correction to Qty Received; cannot silently rewrite verified jobs.
CREATE TABLE equipment_quantity_adjustments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL REFERENCES inward_equipment_groups(id),
    old_quantity integer NOT NULL CHECK(old_quantity > 0),
    new_quantity integer NOT NULL CHECK(new_quantity > 0),
    reason text NOT NULL,
    requested_by_id uuid NOT NULL REFERENCES employees(id),
    requested_at timestamptz NOT NULL DEFAULT now(),
    approved_by_id uuid REFERENCES employees(id),
    approval_status varchar(12) NOT NULL DEFAULT 'PENDING' CHECK(approval_status IN ('PENDING','APPROVED','REJECTED'))
);

-- ==============================================================================
-- service_jobs | BR02C | One unique company-wise Job ID per individually verified physical unit.
CREATE TABLE service_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    inward_id uuid NOT NULL,
    unit_id uuid NOT NULL UNIQUE,
    job_number varchar(40) NOT NULL UNIQUE,
    status varchar(30) NOT NULL DEFAULT 'JOB_CREATED' CHECK(status IN ('JOB_CREATED','AWAITING_ASSIGNMENT','ASSIGNED','ACCEPTED','INSPECTION','ON_HOLD','CANCELLED','CLOSED')),
    priority varchar(12) NOT NULL DEFAULT 'NORMAL' CHECK(priority IN ('NORMAL','URGENT','CRITICAL')),
    route varchar(18) NOT NULL DEFAULT 'IN_HOUSE' CHECK(route IN ('IN_HOUSE','EXTERNAL','ONSITE_LINKED')),
    released_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    cancelled_at timestamptz,
    cancel_reason text,
    UNIQUE(company_id,id),
    FOREIGN KEY(company_id,inward_id,unit_id) REFERENCES inward_equipment_units(company_id,inward_id,id),
    CHECK (cancelled_at IS NULL OR nullif(btrim(cancel_reason),'') IS NOT NULL)
);
CREATE INDEX idx_jobs_company_status ON service_jobs(company_id,status,created_at DESC);

-- ==============================================================================
-- job_assignments | BR02C | Purchase Team directly assigns and reassigns engineers; history stays attached to Job.
CREATE TABLE job_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    job_id uuid NOT NULL,
    assigned_by_id uuid NOT NULL,
    engineer_id uuid NOT NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    is_current boolean NOT NULL DEFAULT true,
    response varchar(16) NOT NULL DEFAULT 'PENDING' CHECK(response IN ('PENDING','ACCEPTED','DECLINED','REASSIGNED')),
    responded_at timestamptz,
    response_reason text,
    reassignment_reason text,
    FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
    FOREIGN KEY(company_id,assigned_by_id) REFERENCES employees(company_id,id),
    FOREIGN KEY(company_id,engineer_id) REFERENCES employees(company_id,id),
    CHECK (response <> 'ACCEPTED' OR responded_at IS NOT NULL)
);
CREATE UNIQUE INDEX uq_job_current_assignment ON job_assignments(job_id) WHERE is_current;

-- ==============================================================================
-- job_repeat_links | BR02C | New JIN/Job ID for each physical warranty return, R01/R02 metadata linked to original.
CREATE TABLE job_repeat_links (
    job_id uuid PRIMARY KEY REFERENCES service_jobs(id),
    original_job_id uuid NOT NULL REFERENCES service_jobs(id),
    previous_job_id uuid REFERENCES service_jobs(id),
    repeat_number integer NOT NULL CHECK(repeat_number > 0),
    repeat_ref varchar(8) GENERATED ALWAYS AS ('R'||lpad(repeat_number::text,2,'0')) STORED,
    return_reason text,
    warranty_status varchar(32) NOT NULL DEFAULT 'PENDING_TECHNICAL_VERIFICATION',
    linked_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(original_job_id,repeat_number),
    CHECK(job_id <> original_job_id)
);

-- ==============================================================================
-- job_status_history | BR02C | Append-only change history for job state movement.
CREATE TABLE job_status_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL REFERENCES service_jobs(id),
    old_status varchar(30),
    new_status varchar(30) NOT NULL,
    changed_by_id uuid REFERENCES employees(id),
    changed_at timestamptz NOT NULL DEFAULT now(),
    reason text
);

-- ==============================================================================
-- job_hold_events | BR02C / SLA | Records hold reasons and proposed SLA pause decisions.
CREATE TABLE job_hold_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL REFERENCES service_jobs(id),
    hold_reason varchar(50) NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    approved_by_id uuid REFERENCES employees(id),
    pause_sla boolean NOT NULL DEFAULT false,
    hold_note text,
    CHECK(ended_at IS NULL OR ended_at >= started_at),
    CHECK(NOT pause_sla OR approved_by_id IS NOT NULL)
);

-- ==============================================================================
-- sla_instances | SLA | Per-activity stopwatch due dates, completion, breach and escalation.
CREATE TABLE sla_instances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    inward_id uuid REFERENCES inward_receipts(id),
    job_id uuid REFERENCES service_jobs(id),
    assignment_id uuid REFERENCES job_assignments(id),
    event_code varchar(50) NOT NULL,
    started_at timestamptz NOT NULL,
    due_at timestamptz,
    completed_at timestamptz,
    approved_pause_minutes integer NOT NULL DEFAULT 0 CHECK(approved_pause_minutes >= 0),
    state varchar(14) NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','MET','BREACHED','PAUSED')),
    escalated_at timestamptz,
    CHECK(inward_id IS NOT NULL OR job_id IS NOT NULL OR assignment_id IS NOT NULL)
);
CREATE INDEX idx_sla_due ON sla_instances(company_id,state,due_at);

-- ==============================================================================
-- communication_events | BR02A-B | Two customer acknowledgement stages with email automatic and WhatsApp/SMS optional.
CREATE TABLE communication_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    inward_id uuid NOT NULL,
    stage varchar(16) NOT NULL CHECK(stage IN ('RECEIPT','VERIFIED')),
    channel varchar(12) NOT NULL CHECK(channel IN ('EMAIL','SMS','WHATSAPP')),
    recipient varchar(254),
    triggered_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    send_status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK(send_status IN ('PENDING','SENT','FAILED','SKIPPED')),
    provider_reference varchar(200),
    error_detail text,
    payload_snapshot jsonb,
    idempotency_key varchar(120) NOT NULL UNIQUE,
    FOREIGN KEY(company_id,inward_id) REFERENCES inward_receipts(company_id,id)
);
CREATE INDEX idx_comms_receipt ON communication_events(inward_id,stage,channel);

-- ==============================================================================
-- job_action_requests | BR02C | Controlled cancel, reopen, correct or link sale requests; not hard-delete.
CREATE TABLE job_action_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL REFERENCES service_jobs(id),
    action_type varchar(20) NOT NULL CHECK(action_type IN ('CANCEL','REOPEN','CORRECT','SALE_LINK')),
    reason text NOT NULL,
    requested_by_id uuid NOT NULL REFERENCES employees(id),
    requested_at timestamptz NOT NULL DEFAULT now(),
    approval_status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK(approval_status IN ('PENDING','APPROVED','REJECTED')),
    approved_by_id uuid REFERENCES employees(id),
    approved_at timestamptz,
    linked_sales_reference varchar(80)
);

-- ==============================================================================
-- activity_audit_log | Controls | Append-only history for material edits, approvals, reassignment and status transitions.
CREATE TABLE activity_audit_log (
    id bigserial PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES legal_entities(id),
    actor_id uuid REFERENCES employees(id),
    entity_table varchar(60) NOT NULL,
    entity_id uuid NOT NULL,
    action varchar(70) NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    before_state jsonb,
    after_state jsonb
);


-- ============================================================================
-- INTEGRITY, NUMBERING, MASTER LOOKUP AND QUANTITY EXPANSION
-- ============================================================================
-- Runtime role-based authorisation (Purchase Team / Engineer / approvers) must
-- be enforced in the authenticated API, not by trusting employee IDs from the UI.

CREATE OR REPLACE FUNCTION br02_next_identifier(p_company_id uuid, p_kind varchar)
RETURNS varchar LANGUAGE plpgsql AS $$
DECLARE v_code varchar(3); v_seq bigint;
BEGIN
  IF p_kind NOT IN ('JIN','JOB') THEN RAISE EXCEPTION 'Invalid identifier kind: %', p_kind; END IF;
  SELECT entity_code INTO v_code FROM legal_entities WHERE id=p_company_id AND is_active;
  IF v_code IS NULL THEN RAISE EXCEPTION 'Company missing or inactive'; END IF;
  INSERT INTO company_number_counters(company_id,number_kind,last_value)
  VALUES(p_company_id,p_kind,1)
  ON CONFLICT(company_id,number_kind) DO UPDATE
    SET last_value=company_number_counters.last_value+1, changed_at=now()
  RETURNING last_value INTO v_seq;
  RETURN p_kind||'-'||v_code||'-'||lpad(v_seq::text,6,'0');
END $$;

-- Snapshot customer master status at time of JIN; no free-text customer values.
CREATE OR REPLACE FUNCTION br02_receipt_master_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status varchar(24);
BEGIN
  SELECT status INTO v_status FROM customers
  WHERE id=NEW.customer_id AND company_id=NEW.company_id;
  IF v_status IS NULL OR v_status NOT IN ('PENDING_APPROVAL','APPROVED') THEN
    RAISE EXCEPTION 'Customer Master must exist and be Pending Approval or Approved';
  END IF;
  IF TG_OP='INSERT' THEN NEW.customer_status_snapshot:=v_status; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br02_receipt_master BEFORE INSERT OR UPDATE OF customer_id,company_id
ON inward_receipts FOR EACH ROW EXECUTE FUNCTION br02_receipt_master_guard();

-- Snapshot assembly master status when Add Equipment group is saved.
CREATE OR REPLACE FUNCTION br02_group_assembly_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status varchar(24);
BEGIN
  SELECT status INTO v_status FROM assemblies WHERE id=NEW.assembly_id;
  IF v_status IS NULL OR v_status NOT IN ('PENDING_APPROVAL','APPROVED') THEN
    RAISE EXCEPTION 'Assembly Master must exist and be Pending Approval or Approved';
  END IF;
  IF TG_OP='INSERT' THEN NEW.assembly_status_snapshot:=v_status; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br02_group_assembly BEFORE INSERT OR UPDATE OF assembly_id
ON inward_equipment_groups FOR EACH ROW EXECUTE FUNCTION br02_group_assembly_guard();

-- Quantity once expanded is not editable: use reviewed adjustment workflow.
CREATE OR REPLACE FUNCTION br02_guard_group_quantity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantity_received IS DISTINCT FROM OLD.quantity_received AND
    EXISTS(SELECT 1 FROM inward_equipment_units WHERE group_id=OLD.id) THEN
    RAISE EXCEPTION 'Quantity already expanded. Use controlled adjustment workflow';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br02_group_qty BEFORE UPDATE OF quantity_received
ON inward_equipment_groups FOR EACH ROW EXECUTE FUNCTION br02_guard_group_quantity();

-- Expand selected assembly Qty N to N separate physical-unit rows.
-- Run in one transaction. The UI does not generate database IDs or Job numbers.
CREATE OR REPLACE FUNCTION br02_expand_equipment_group(
  p_group_id uuid, p_location_id uuid, p_custodian_id uuid
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE g inward_equipment_groups%ROWTYPE;
BEGIN
  SELECT * INTO g FROM inward_equipment_groups WHERE id=p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Equipment group not found'; END IF;
  IF EXISTS(SELECT 1 FROM inward_equipment_units WHERE group_id=p_group_id) THEN
    RAISE EXCEPTION 'Quantity group was already expanded';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM custody_locations WHERE id=p_location_id AND company_id=g.company_id AND is_active) THEN
    RAISE EXCEPTION 'Invalid active custody location';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM employees WHERE id=p_custodian_id AND company_id=g.company_id AND is_active) THEN
    RAISE EXCEPTION 'Invalid current custodian';
  END IF;
  INSERT INTO inward_equipment_units
    (company_id,inward_id,group_id,unit_number,unit_quantity,current_location_id,current_custodian_id)
  SELECT g.company_id,g.inward_id,g.id,gs.n,1,p_location_id,p_custodian_id
  FROM generate_series(1,g.quantity_received) gs(n);
  RETURN g.quantity_received;
END $$;

-- Verification is blocked if that exact physical unit lacks photographic proof.
CREATE OR REPLACE FUNCTION br02_guard_unit_verification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification_status='VERIFIED' AND OLD.verification_status IS DISTINCT FROM 'VERIFIED' THEN
    IF NOT EXISTS (SELECT 1 FROM equipment_photos WHERE unit_id=NEW.id) THEN
      RAISE EXCEPTION 'Upload at least one photo of the individual equipment unit before verifying';
    END IF;
    IF NEW.verified_at IS NULL OR NEW.verified_by_id IS NULL THEN
      RAISE EXCEPTION 'Verified timestamp and verifier are required';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- NOT ACTIVATED YET: the minimum photo count for verification is a proposed rule.
-- Enable after Brightech approves minimum evidence criteria:
-- CREATE TRIGGER trg_br02_unit_verification BEFORE UPDATE OF verification_status
-- ON inward_equipment_units FOR EACH ROW EXECUTE FUNCTION br02_guard_unit_verification();

-- Back-end protection: job requires verified unit and eligible live Assembly/Customer.
CREATE OR REPLACE FUNCTION br02_guard_job_creation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status varchar(16); v_assembly_status varchar(24); v_customer_status varchar(24);
BEGIN
  SELECT u.verification_status, a.status, c.status
    INTO v_status,v_assembly_status,v_customer_status
  FROM inward_equipment_units u
  JOIN inward_equipment_groups g ON g.id=u.group_id
  JOIN assemblies a ON a.id=g.assembly_id
  JOIN inward_receipts r ON r.id=u.inward_id AND r.company_id=u.company_id
  JOIN customers c ON c.id=r.customer_id AND c.company_id=r.company_id
  WHERE u.id=NEW.unit_id AND u.inward_id=NEW.inward_id AND u.company_id=NEW.company_id;
  IF NOT FOUND OR v_status<>'VERIFIED' THEN
    RAISE EXCEPTION 'Job ID requires a verified equipment unit under same company/JIN';
  END IF;
  IF v_assembly_status NOT IN ('PENDING_APPROVAL','APPROVED') OR
     v_customer_status NOT IN ('PENDING_APPROVAL','APPROVED') THEN
    RAISE EXCEPTION 'Linked Customer and Assembly must be Pending Approval or Approved';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br02_job_guard BEFORE INSERT OR UPDATE OF unit_id,inward_id,company_id
ON service_jobs FOR EACH ROW EXECUTE FUNCTION br02_guard_job_creation();

-- Stable numbers: do not overwrite JIN or Job ID after issue.
CREATE OR REPLACE FUNCTION br02_prevent_identifier_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='inward_receipts' AND NEW.jin_number IS DISTINCT FROM OLD.jin_number THEN
    RAISE EXCEPTION 'JIN is immutable';
  ELSIF TG_TABLE_NAME='service_jobs' AND NEW.job_number IS DISTINCT FROM OLD.job_number THEN
    RAISE EXCEPTION 'Job number is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br02_immutable_jin BEFORE UPDATE OF jin_number ON inward_receipts
FOR EACH ROW EXECUTE FUNCTION br02_prevent_identifier_change();
CREATE TRIGGER trg_br02_immutable_job BEFORE UPDATE OF job_number ON service_jobs
FOR EACH ROW EXECUTE FUNCTION br02_prevent_identifier_change();

-- Current assignment uniquely identified with partial unique index. On reassignment
-- the server must set old is_current=false, add new row, log reason, all atomically.
-- Validate assigned_by=active Purchase Team and engineer=active Service Engineer in API.

-- ============================================================================
-- IMPLEMENTATION CONTRACT / KNOWN OPEN POINTS
-- ============================================================================
-- 1. These BR-01 customer/assembly/employee tables are INTEGRATION STUBS. Map to
--    final existing BR-01B / BR-01C masters; do not create duplicate masters.
-- 2. Qty group is entered once; its physical units are inserted in one transaction.
--    A distinct Job ID is allocated ONLY after each unit is verified.
-- 3. Master records may be Pending Approval. Downstream restrictions for quotation,
--    procurement and invoice must be agreed in their later modules.
-- 4. Company-specific JIN/JOB counters do not reset at FY end.
-- 5. Email is automatic twice (after JIN and after verification/jobs); optional
--    SMS/WhatsApp and provider consent/configuration are separate.
-- 6. BR-02 approved targets: JIN creation target 15m; unit verification, photos,
--    Job creation <=120 working minutes; release <=240 working minutes from receipt;
--    engineer assignment <=240 working minutes from release; acceptance <=60
--    working minutes from assignment. Working calendars are still PENDING.
-- 7. Duplicate physical equipment, quantity correction after expansion, missing DC,
--    cross-company repeats and named approval authorities need final client decisions.
-- 8. API must enforce company-based authorization and all business invariants with
--    the same transaction as counter allocation, group expansion and job creation.
-- 9. Use secure object storage for photo/DC file content; store only URI and metadata.
-- 10. Use append-only audit history and no hard delete of issued jobs/JINs.

COMMIT;


-- ======================================================================
-- COMPONENT 2: Brightech_BR03_PostgreSQL_Additive_Schema_Rev01_Integrated_View_Correction.sql
-- ======================================================================

-- BRIGHTECH BR-03A/B/C | PostgreSQL 15+ | Rev01 corrected engineer-time view | Additive module proposal
-- Review build: 31-Oct-2026. Depends on BR-02 Rev04 tables being installed.
-- Rev01 corrects two missing closing parentheses in br03_v_engineer_time_totals only.
-- It does not change direct engineer-to-Purchase material submission or approvals.
-- NOT a production migration. No client approval of unresolved role/calendar details implied.
-- Item catalog is an integration bridge to BR-01B (not a second item master).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- Master integration: Read-only BR-01B Item Master lookup bridge; not a second authoritative Item Master.
CREATE TABLE br03_item_catalog_bridge (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    br01_item_id uuid UNIQUE NOT NULL,
    item_code varchar(40) UNIQUE NOT NULL,
    item_name varchar(240) NOT NULL,
    uom varchar(16) NOT NULL,
    allows_fraction boolean NOT NULL DEFAULT false,
    qty_precision smallint NOT NULL DEFAULT 0,
    approval_status varchar(20) NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    last_synced_at timestamptz NOT NULL DEFAULT now(),
CHECK (approval_status IN ('PENDING_APPROVAL','APPROVED','REJECTED','INACTIVE')),
CHECK (qty_precision BETWEEN 0 AND 6)
);

-- BR-03A: Engineer independently acknowledges physical equipment receipt against current assignment.
CREATE TABLE br03_custody_acknowledgements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    job_id uuid NOT NULL,
    assignment_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    engineer_id uuid NOT NULL,
    acknowledged_at timestamptz NOT NULL DEFAULT now(),
    condition_note text,
    FOREIGN KEY (company_id) REFERENCES legal_entities(id),
    FOREIGN KEY (job_id) REFERENCES service_jobs(id),
    FOREIGN KEY (assignment_id) REFERENCES job_assignments(id),
    FOREIGN KEY (unit_id) REFERENCES inward_equipment_units(id),
    FOREIGN KEY (engineer_id) REFERENCES employees(id),
UNIQUE(assignment_id,unit_id)
);

-- BR-03A: Start/finish and individual-engineer inspection sessions; reassignment keeps historical effort.
CREATE TABLE br03_inspection_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    job_id uuid NOT NULL,
    assignment_id uuid NOT NULL,
    engineer_id uuid NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    status varchar(16) NOT NULL DEFAULT 'ACTIVE',
    interrupted_reason text,
    FOREIGN KEY (company_id) REFERENCES legal_entities(id),
    FOREIGN KEY (job_id) REFERENCES service_jobs(id),
    FOREIGN KEY (assignment_id) REFERENCES job_assignments(id),
    FOREIGN KEY (engineer_id) REFERENCES employees(id),
CHECK(status IN ('ACTIVE','PAUSED','COMPLETED','INTERRUPTED')),
CHECK(completed_at IS NULL OR completed_at>=started_at)
);

-- BR-03A: Non-overlapping ACTIVE/PAUSED segments used for time calculation.
CREATE TABLE br03_time_segments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    segment_type varchar(12) NOT NULL,
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    pause_reason text,
    pause_category varchar(32),
    is_active_time boolean NOT NULL,
    FOREIGN KEY (session_id) REFERENCES br03_inspection_sessions(id),
CHECK(segment_type IN ('ACTIVE','PAUSED')),
CHECK(ended_at IS NULL OR ended_at >= started_at),
CHECK(segment_type <> 'PAUSED' OR NULLIF(btrim(pause_reason),'') IS NOT NULL),
CHECK(is_active_time = (segment_type='ACTIVE'))
);

-- BR-03B: Stable inspection identity per job; latest revision and routing snapshot.
CREATE TABLE br03_inspection_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    job_id uuid NOT NULL UNIQUE,
    engineer_id uuid NOT NULL,
    current_version_no integer NOT NULL DEFAULT 0,
    status varchar(24) NOT NULL DEFAULT 'DRAFT',
    latest_outcome varchar(32),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (company_id) REFERENCES legal_entities(id),
    FOREIGN KEY (job_id) REFERENCES service_jobs(id),
    FOREIGN KEY (engineer_id) REFERENCES employees(id),
CHECK(status IN ('DRAFT','SUBMITTED','RETURNED','ACCEPTED','AMENDMENT_REQUIRED')),
CHECK(latest_outcome IS NULL OR latest_outcome IN ('REPAIR_REQUIRED','NO_FAULT_FOUND','NOT_REPAIRABLE','EXTERNAL_REPAIR_REQUIRED','FURTHER_INSPECTION_REQUIRED'))
);

-- BR-03B: Preserves every submitted/resubmitted diagnosis instead of overwriting findings.
CREATE TABLE br03_inspection_report_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id uuid NOT NULL,
    version_no integer NOT NULL,
    assignment_id uuid NOT NULL,
    engineer_id uuid NOT NULL,
    inspection_description text NOT NULL,
    outcome varchar(32) NOT NULL,
    submitted_at timestamptz NOT NULL DEFAULT now(),
    amendment_reason text,
    version_status varchar(16) NOT NULL DEFAULT 'SUBMITTED',
    FOREIGN KEY (report_id) REFERENCES br03_inspection_reports(id),
    FOREIGN KEY (assignment_id) REFERENCES job_assignments(id),
    FOREIGN KEY (engineer_id) REFERENCES employees(id),
CHECK(outcome IN ('REPAIR_REQUIRED','NO_FAULT_FOUND','NOT_REPAIRABLE','EXTERNAL_REPAIR_REQUIRED','FURTHER_INSPECTION_REQUIRED')),
CHECK(NULLIF(btrim(inspection_description),'') IS NOT NULL),
CHECK(version_status IN ('SUBMITTED','ACCEPTED','RETURNED','SUPERSEDED')),
CHECK(version_no=0 OR NULLIF(btrim(amendment_reason),'') IS NOT NULL),
UNIQUE(report_id,version_no)
);

-- BR-03B: Inspection photo evidence and optional videos, per immutable report version.
CREATE TABLE br03_inspection_media (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id uuid NOT NULL,
    version_id uuid,
    job_id uuid NOT NULL,
    media_type varchar(8) NOT NULL,
    file_uri text NOT NULL,
    file_name varchar(255) NOT NULL,
    uploaded_by_id uuid NOT NULL,
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    customer_visible boolean NOT NULL DEFAULT false,
    FOREIGN KEY (report_id) REFERENCES br03_inspection_reports(id),
    FOREIGN KEY (version_id) REFERENCES br03_inspection_report_versions(id),
    FOREIGN KEY (job_id) REFERENCES service_jobs(id),
    FOREIGN KEY (uploaded_by_id) REFERENCES employees(id),
CHECK(media_type IN ('PHOTO','VIDEO'))
);

-- BR-03B: Purchase Team accept/return decisions and comments, immutable event history.
CREATE TABLE br03_inspection_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id uuid NOT NULL,
    reviewer_id uuid NOT NULL,
    review_decision varchar(10) NOT NULL,
    review_comment text,
    reviewed_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (version_id) REFERENCES br03_inspection_report_versions(id),
    FOREIGN KEY (reviewer_id) REFERENCES employees(id),
CHECK(review_decision IN ('ACCEPT','RETURN')),
CHECK(review_decision <> 'RETURN' OR NULLIF(btrim(review_comment),'') IS NOT NULL),
UNIQUE(version_id,review_decision,reviewed_at)
);

-- BR-03B-C: Recommendation only for external service; commercial approval handled by later module.
CREATE TABLE br03_external_recommendations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL,
    report_version_id uuid NOT NULL,
    recommended_by_id uuid NOT NULL,
    reason text NOT NULL,
    status varchar(18) NOT NULL DEFAULT 'PROPOSED',
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (job_id) REFERENCES service_jobs(id),
    FOREIGN KEY (report_version_id) REFERENCES br03_inspection_report_versions(id),
    FOREIGN KEY (recommended_by_id) REFERENCES employees(id),
CHECK(status IN ('PROPOSED','UNDER_REVIEW','REFERRED','DECLINED'))
);

-- BR-03C: Material request header and locked processing lifecycle.
CREATE TABLE br03_material_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    job_id uuid NOT NULL,
    inspection_version_id uuid NOT NULL,
    responsible_engineer_id uuid NOT NULL,
    request_number varchar(50) NOT NULL UNIQUE,
    status varchar(24) NOT NULL DEFAULT 'DRAFT',
    priority varchar(12) NOT NULL,
    required_by_date date,
    required_by_reason text,
    submitted_at timestamptz,
    self_edit_deadline_at timestamptz,
    purchase_processing_started_at timestamptz,
    purchase_started_by_id uuid,
    current_version_no integer NOT NULL DEFAULT 0,
    closed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (company_id) REFERENCES legal_entities(id),
    FOREIGN KEY (job_id) REFERENCES service_jobs(id),
    FOREIGN KEY (inspection_version_id) REFERENCES br03_inspection_report_versions(id),
    FOREIGN KEY (responsible_engineer_id) REFERENCES employees(id),
    FOREIGN KEY (purchase_started_by_id) REFERENCES employees(id),
CHECK(status IN ('DRAFT','SUBMITTED','PROCESSING','RETURNED','CHANGE_REQUESTED','WITHDRAWN','CLOSED')),
CHECK(priority IN ('NORMAL','URGENT','CRITICAL')),
CHECK(required_by_date IS NULL OR NULLIF(btrim(required_by_reason),'') IS NOT NULL)
);

-- BR-03C: Line quantities and manufacturer preference; UOM derives from approved Item Master.
CREATE TABLE br03_material_request_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL,
    item_bridge_id uuid NOT NULL,
    quantity numeric(16,4) NOT NULL,
    uom_snapshot varchar(16) NOT NULL,
    available_stock_snapshot numeric(16,4),
    preferred_manufacturer varchar(140),
    preferred_part_number varchar(140),
    preference_reason text,
    technical_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (request_id) REFERENCES br03_material_requests(id),
    FOREIGN KEY (item_bridge_id) REFERENCES br03_item_catalog_bridge(id),
CHECK(quantity > 0),
CHECK((preferred_manufacturer IS NULL AND preferred_part_number IS NULL) OR NULLIF(btrim(preference_reason),'') IS NOT NULL)
);

-- BR-03C: Immutable material lines snapshot for submit, revise, cancel and return.
CREATE TABLE br03_material_request_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL,
    version_no integer NOT NULL,
    change_action varchar(16) NOT NULL,
    change_reason text,
    changed_by_id uuid NOT NULL,
    lines_snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (request_id) REFERENCES br03_material_requests(id),
    FOREIGN KEY (changed_by_id) REFERENCES employees(id),
CHECK(change_action IN ('SUBMIT','REVISE','RETURN','WITHDRAW','CLOSE')),
CHECK(change_action='SUBMIT' OR NULLIF(btrim(change_reason),'') IS NOT NULL),
CHECK(jsonb_typeof(lines_snapshot)='array'),
UNIQUE(request_id,version_no)
);

-- BR-03C: After-lock request to Purchase for controlled material changes.
CREATE TABLE br03_material_change_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    material_request_id uuid NOT NULL,
    requested_by_id uuid NOT NULL,
    change_reason text NOT NULL,
    proposed_change jsonb NOT NULL,
    review_status varchar(12) NOT NULL DEFAULT 'PENDING',
    reviewed_by_id uuid,
    reviewed_at timestamptz,
    review_comment text,
    FOREIGN KEY (material_request_id) REFERENCES br03_material_requests(id),
    FOREIGN KEY (requested_by_id) REFERENCES employees(id),
    FOREIGN KEY (reviewed_by_id) REFERENCES employees(id),
CHECK(review_status IN ('PENDING','ACCEPTED','REJECTED')),
CHECK(NULLIF(btrim(change_reason),'') IS NOT NULL)
);

-- BR-03C: Optional photo/video to clarify requested component.
CREATE TABLE br03_material_media (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    material_request_id uuid NOT NULL,
    line_id uuid,
    media_type varchar(8) NOT NULL,
    file_uri text NOT NULL,
    uploaded_by_id uuid NOT NULL,
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (material_request_id) REFERENCES br03_material_requests(id),
    FOREIGN KEY (line_id) REFERENCES br03_material_request_lines(id),
    FOREIGN KEY (uploaded_by_id) REFERENCES employees(id),
CHECK(media_type IN ('PHOTO','VIDEO'))
);

-- Cross-process: Internal queue and reminders (not automatic customer disclosure).
CREATE TABLE br03_internal_notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    job_id uuid NOT NULL,
    recipient_employee_id uuid,
    notification_kind varchar(40) NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    scheduled_at timestamptz,
    sent_at timestamptz,
    status varchar(12) NOT NULL DEFAULT 'PENDING',
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (company_id) REFERENCES legal_entities(id),
    FOREIGN KEY (job_id) REFERENCES service_jobs(id),
    FOREIGN KEY (recipient_employee_id) REFERENCES employees(id),
CHECK(status IN ('PENDING','SENT','FAILED','CANCELLED'))
);

-- Partial-unique guards prevent concurrent conflicting active sessions/intervals.
CREATE UNIQUE INDEX br03_one_open_segment_per_session ON br03_time_segments(session_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX br03_one_open_session_per_job ON br03_inspection_sessions(job_id) WHERE completed_at IS NULL AND status IN ('ACTIVE','PAUSED');
CREATE INDEX br03_report_queue_idx ON br03_inspection_reports(company_id,status,updated_at DESC);
CREATE INDEX br03_material_queue_idx ON br03_material_requests(company_id,status,created_at DESC);
CREATE INDEX br03_material_job_idx ON br03_material_requests(job_id);
CREATE INDEX br03_internal_notifications_pending_idx ON br03_internal_notifications(company_id,status,scheduled_at);
CREATE INDEX br03_media_report_idx ON br03_inspection_media(report_id,media_type);

-- Only current accepted assignment may initiate engineer work actions.
-- Permission checking (engineer vs Purchase) and actor identity are enforced
-- in authenticated API transactions; never trust a supplied user ID from UI.
CREATE OR REPLACE FUNCTION br03_is_current_accepted_engineer(p_job_id uuid, p_engineer_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
      SELECT 1 FROM job_assignments a
      WHERE a.job_id=p_job_id AND a.engineer_id=p_engineer_id
        AND a.is_current=true AND a.response='ACCEPTED'
    );
$$;

-- Confirm mandatory photo availability before a diagnosis revision is submitted.
CREATE OR REPLACE FUNCTION br03_guard_inspection_submission()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_job uuid;
BEGIN
  SELECT job_id INTO v_job FROM br03_inspection_reports WHERE id=NEW.report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing inspection report'; END IF;
  IF NOT br03_is_current_accepted_engineer(v_job,NEW.engineer_id) THEN
    RAISE EXCEPTION 'Current accepted engineer required';
  END IF;
  IF NOT EXISTS (
     SELECT 1 FROM br03_inspection_media im
     WHERE im.report_id=NEW.report_id AND im.job_id=v_job AND im.media_type='PHOTO'
       AND (im.version_id IS NULL OR im.version_id=NEW.id)
  ) THEN
     RAISE EXCEPTION 'At least one inspection photograph is required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br03_inspection_submit BEFORE INSERT ON br03_inspection_report_versions
FOR EACH ROW EXECUTE FUNCTION br03_guard_inspection_submission();

-- Requirements can only begin from a Purchase-accepted inspection version.
CREATE OR REPLACE FUNCTION br03_guard_material_report()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_job uuid; v_status varchar(16);
BEGIN
  SELECT r.job_id, v.version_status INTO v_job,v_status
  FROM br03_inspection_report_versions v
  JOIN br03_inspection_reports r ON r.id=v.report_id
  WHERE v.id=NEW.inspection_version_id;
  IF v_job IS DISTINCT FROM NEW.job_id OR v_status <> 'ACCEPTED' THEN
     RAISE EXCEPTION 'Material request requires Purchase-accepted inspection report for the same job';
  END IF;
  IF NOT br03_is_current_accepted_engineer(NEW.job_id,NEW.responsible_engineer_id) THEN
     RAISE EXCEPTION 'Material request must belong to current accepted engineer';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br03_material_report BEFORE INSERT ON br03_material_requests
FOR EACH ROW EXECUTE FUNCTION br03_guard_material_report();

-- Server-enforced direct-edit window: 1 WORKING hour from submitted_at,
-- OR first Purchase processing start, whichever occurs earlier.
-- Application must derive self_edit_deadline_at from the approved company calendar.
-- If no active calendar is configured, a submitted request is not freely editable.
CREATE OR REPLACE FUNCTION br03_can_engineer_edit(p_req uuid)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE r br03_material_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM br03_material_requests WHERE id=p_req;
  IF NOT FOUND THEN RETURN false; END IF;
  IF r.status='DRAFT' THEN RETURN true; END IF;
  RETURN r.status='SUBMITTED'
    AND r.purchase_processing_started_at IS NULL
    AND r.self_edit_deadline_at IS NOT NULL
    AND now()<r.self_edit_deadline_at;
END $$;

-- BR-01B-approved item only, UOM readonly and positive quantity.
CREATE OR REPLACE FUNCTION br03_guard_material_line()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i br03_item_catalog_bridge%ROWTYPE;
BEGIN
  IF NOT br03_can_engineer_edit(NEW.request_id) THEN
    RAISE EXCEPTION 'Direct editing locked: submit controlled change request to Purchase';
  END IF;
  SELECT * INTO i FROM br03_item_catalog_bridge WHERE id=NEW.item_bridge_id;
  IF NOT FOUND OR i.approval_status<>'APPROVED' OR NOT i.is_active THEN
    RAISE EXCEPTION 'Item must be Approved and active in BR-01B Item Master';
  END IF;
  IF NEW.uom_snapshot IS DISTINCT FROM i.uom THEN
    RAISE EXCEPTION 'UOM must match approved Item Master';
  END IF;
  IF ROUND(NEW.quantity,i.qty_precision) <> NEW.quantity THEN
    RAISE EXCEPTION 'Quantity does not meet item precision';
  END IF;
  IF NOT i.allows_fraction AND NEW.quantity <> trunc(NEW.quantity) THEN
    RAISE EXCEPTION 'Whole-number quantity required for this item';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br03_material_line BEFORE INSERT OR UPDATE ON br03_material_request_lines
FOR EACH ROW EXECUTE FUNCTION br03_guard_material_line();

CREATE OR REPLACE FUNCTION br03_guard_material_line_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT br03_can_engineer_edit(OLD.request_id) THEN
    RAISE EXCEPTION 'Direct deletion locked: submit change request';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_br03_material_line_delete BEFORE DELETE ON br03_material_request_lines
FOR EACH ROW EXECUTE FUNCTION br03_guard_material_line_delete();

-- Inspection content is immutable, while Purchase may update version_status
-- through the protected review API when accepting or returning the version.
CREATE OR REPLACE FUNCTION br03_guard_inspection_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Inspection versions cannot be deleted'; END IF;
  IF (to_jsonb(NEW)-'version_status') IS DISTINCT FROM (to_jsonb(OLD)-'version_status') THEN
    RAISE EXCEPTION 'Submitted inspection content is immutable; create a new revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br03_inspection_immutable BEFORE UPDATE OR DELETE ON br03_inspection_report_versions
FOR EACH ROW EXECUTE FUNCTION br03_guard_inspection_version_mutation();
CREATE OR REPLACE FUNCTION br03_deny_immutable_edit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable material-request version cannot be edited/deleted'; END $$;
CREATE TRIGGER trg_br03_material_version_immutable BEFORE UPDATE OR DELETE ON br03_material_request_versions
FOR EACH ROW EXECUTE FUNCTION br03_deny_immutable_edit();

-- Count ACTIVE vs PAUSED actual elapsed seconds by session, then by job.
CREATE VIEW br03_v_engineer_time_totals AS
SELECT s.company_id, s.job_id, s.engineer_id,
       COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(t.ended_at,now())-t.started_at)))
         FILTER(WHERE t.segment_type='ACTIVE'),0)::bigint AS active_seconds,
       COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(t.ended_at,now())-t.started_at)))
         FILTER(WHERE t.segment_type='PAUSED'),0)::bigint AS paused_seconds,
       MIN(s.started_at) AS first_inspection_start,
       MAX(s.completed_at) AS last_inspection_finish
FROM br03_inspection_sessions s
LEFT JOIN br03_time_segments t ON t.session_id=s.id
GROUP BY s.company_id,s.job_id,s.engineer_id;

-- SLA targets accepted in BR-03B: NORMAL 2 working days, URGENT 1 working day,
-- CRITICAL 4 working hours. Convert working-day units through approved calendar;
-- DO NOT hardcode 8 hours/day without client confirmation.
-- Acceptance notices 30/45/60/90 minutes under BR-03A reuse BR-02 sla_instances.

COMMIT;


-- ======================================================================
-- COMPONENT 3: Brightech_BR04_PostgreSQL_Additive_Schema_Rev00_Developer_Proposal.sql
-- ======================================================================

-- BRIGHTECH | BR-04A/B/C | PostgreSQL 15+ | ADDITIVE DEVELOPER PROPOSAL (REV00)
-- CLIENT REVIEW / NOT APPROVED / NOT A PRODUCTION MIGRATION. 30-Oct-2026.
-- Sources: BR-04A/B/C Rev01 Client Review; 40 decisions + 14 accepted groups.
-- Depends on BR-02 Rev04 (legal_entities, service_jobs, employees), BR-03
-- (br03_material_requests, br03_material_request_lines, br03_material_request_versions,
-- br03_inspection_report_versions, br03_item_catalog_bridge).
-- Intended migration sequence: BR02 -> BR03 -> BR04 -> BR05 (BR05 quote adapter
-- br05_quote_revision_refs.source_br04_quote_id maps to br04_customer_quote_revisions.id).
-- Does NOT create another Job, Item Master, Supplier Master, Stock Ledger, PO, or Sales Master.
-- Replace external supplier and inventory references with canonical BR-01 / Inventory links
-- after the actual production schemas have been reviewed. Never infer current usable stock
-- from these snapshots for authoritative reservation. All finance settings remain pending.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One globally continuous RFQ sequence across BLR/CHN; JIN/JOB remain company-scoped.
CREATE TABLE br04_global_number_counters (
  number_kind varchar(12) PRIMARY KEY CHECK(number_kind='RFQ'),
  last_number bigint NOT NULL DEFAULT 0 CHECK(last_number>=0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO br04_global_number_counters(number_kind,last_number) VALUES ('RFQ',0)
ON CONFLICT (number_kind) DO NOTHING;

-- BR-04A: immutable observation of local store and engineer custody; not authoritative inventory.
CREATE TABLE br04_stock_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  job_id uuid NOT NULL,
  material_request_id uuid NOT NULL REFERENCES br03_material_requests(id),
  material_request_version_id uuid NOT NULL REFERENCES br03_material_request_versions(id),
  checked_by_id uuid NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  check_context varchar(24) NOT NULL DEFAULT 'MR_RECEIVED'
    CHECK(check_context IN ('MR_RECEIVED','ESTIMATE_PREPARATION','CUSTOMER_ORDER_RECHECK','ISSUE_RECHECK')),
  warehouse_source_ref varchar(120),  -- maps to actual BLR/CHN single local store
  inventory_asof_at timestamptz,
  inventory_snapshot_reference varchar(150),
  notes text,
  is_current boolean NOT NULL DEFAULT true,
  FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
  FOREIGN KEY(company_id,checked_by_id) REFERENCES employees(company_id,id),
  UNIQUE(company_id,id)
);
CREATE INDEX br04_stock_job_idx ON br04_stock_checks(company_id,job_id,checked_at DESC);
CREATE UNIQUE INDEX br04_current_stock_check_per_job ON br04_stock_checks(job_id) WHERE is_current;

CREATE TABLE br04_stock_check_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_check_id uuid NOT NULL REFERENCES br04_stock_checks(id),
  material_request_line_id uuid NOT NULL REFERENCES br03_material_request_lines(id),
  item_bridge_id uuid NOT NULL REFERENCES br03_item_catalog_bridge(id),
  uom_snapshot varchar(16) NOT NULL,
  required_quantity numeric(16,4) NOT NULL CHECK(required_quantity>0),
  store_on_hand numeric(16,4) NOT NULL CHECK(store_on_hand>=0),
  engineer_held numeric(16,4) NOT NULL CHECK(engineer_held>=0),
  store_reserved numeric(16,4) NOT NULL CHECK(store_reserved>=0),
  store_quarantined numeric(16,4) NOT NULL CHECK(store_quarantined>=0),
  store_other_holds numeric(16,4) NOT NULL DEFAULT 0 CHECK(store_other_holds>=0),
  store_unaccepted numeric(16,4) NOT NULL DEFAULT 0 CHECK(store_unaccepted>=0),
  physical_total numeric(16,4) GENERATED ALWAYS AS (store_on_hand+engineer_held) STORED,
  available_to_allocate numeric(16,4) GENERATED ALWAYS AS (
    greatest(0,store_on_hand-store_reserved-store_quarantined-store_other_holds-store_unaccepted)
  ) STORED,
  shortage_quantity numeric(16,4) GENERATED ALWAYS AS (
    greatest(0,required_quantity-greatest(0,store_on_hand-store_reserved-store_quarantined-store_other_holds-store_unaccepted))
  ) STORED,
  availability_status varchar(16) GENERATED ALWAYS AS (
    CASE WHEN greatest(0,store_on_hand-store_reserved-store_quarantined-store_other_holds-store_unaccepted)>=required_quantity THEN 'FULL_STOCK'
         WHEN greatest(0,store_on_hand-store_reserved-store_quarantined-store_other_holds-store_unaccepted)>0 THEN 'PARTIAL_STOCK'
         ELSE 'NO_STOCK' END
  ) STORED,
  wac_landed_unit_cost numeric(18,4) CHECK(wac_landed_unit_cost>=0),
  latest_purchase_unit_cost numeric(18,4) CHECK(latest_purchase_unit_cost>=0),
  inventory_valuation_ref varchar(140),
  CHECK(store_reserved+store_quarantined+store_other_holds+store_unaccepted<=store_on_hand),
  UNIQUE(stock_check_id,material_request_line_id),
  UNIQUE(stock_check_id,id)
);

-- BR-04A: formal engineer confirmation of equivalent/discontinued items.
CREATE TABLE br04_technical_substitutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  stock_check_line_id uuid NOT NULL REFERENCES br04_stock_check_lines(id),
  original_item_bridge_id uuid NOT NULL REFERENCES br03_item_catalog_bridge(id),
  substitute_item_bridge_id uuid NOT NULL REFERENCES br03_item_catalog_bridge(id),
  requested_by_id uuid NOT NULL REFERENCES employees(id),
  technical_approved_by_id uuid REFERENCES employees(id),
  technical_status varchar(16) NOT NULL DEFAULT 'PROPOSED'
    CHECK(technical_status IN ('PROPOSED','APPROVED','REJECTED','WITHDRAWN')),
  reason text NOT NULL CHECK(length(btrim(reason))>0),
  evidence_uri text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(original_item_bridge_id<>substitute_item_bridge_id),
  CHECK(technical_status<>'APPROVED' OR (technical_approved_by_id IS NOT NULL AND decided_at IS NOT NULL))
);

-- BR-04A: shortage candidates for sourcing, including one RFQ serving several Job IDs.
CREATE TABLE br04_shortage_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  job_id uuid NOT NULL,
  stock_check_line_id uuid NOT NULL REFERENCES br04_stock_check_lines(id),
  shortage_quantity numeric(16,4) NOT NULL CHECK(shortage_quantity>0),
  shortage_status varchar(20) NOT NULL DEFAULT 'OPEN'
    CHECK(shortage_status IN ('OPEN','IN_RFQ','PRICE_AVAILABLE','UNAVAILABLE','CLOSED')),
  created_by_id uuid NOT NULL REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
  UNIQUE(company_id,id)
);

-- BR-04B: global RFQ; each enquiry belongs to exactly one issuing legal entity.
CREATE TABLE br04_rfqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  rfq_seq bigint NOT NULL UNIQUE CHECK(rfq_seq>0),
  rfq_number varchar(32) GENERATED ALWAYS AS ('RFQ-' || CASE WHEN rfq_seq<1000000 THEN lpad(rfq_seq::text,6,'0') ELSE rfq_seq::text END) STORED,
  revision_no integer NOT NULL DEFAULT 1 CHECK(revision_no>=1),
  rfq_status varchar(20) NOT NULL DEFAULT 'DRAFT'
    CHECK(rfq_status IN ('DRAFT','SENT','OFFERS_RECEIVED','COMPARED','CANCELLED','EXPIRED')),
  created_by_id uuid NOT NULL REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  reason_for_change text,
  notes text,
  UNIQUE(company_id,id)
);
CREATE OR REPLACE FUNCTION br04_alloc_rfq_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rfq_seq IS NULL THEN
    UPDATE br04_global_number_counters SET last_number=last_number+1,updated_at=now()
      WHERE number_kind='RFQ' RETURNING last_number INTO NEW.rfq_seq;
  END IF;
  IF NEW.rfq_seq IS NULL THEN RAISE EXCEPTION 'BR04: missing RFQ global sequence'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER br04_rfqs_global_sequence BEFORE INSERT ON br04_rfqs
FOR EACH ROW EXECUTE FUNCTION br04_alloc_rfq_seq();

CREATE TABLE br04_rfq_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES br04_rfqs(id),
  line_no integer NOT NULL CHECK(line_no>0),
  item_bridge_id uuid NOT NULL REFERENCES br03_item_catalog_bridge(id),
  quantity numeric(16,4) NOT NULL CHECK(quantity>0),
  uom varchar(16) NOT NULL,
  technical_specification text NOT NULL CHECK(length(btrim(technical_specification))>0),
  manufacturer_preference text,
  preference_reason text,
  desired_delivery_by date,
  UNIQUE(rfq_id,line_no),
  UNIQUE(rfq_id,id),
  CHECK(manufacturer_preference IS NULL OR NULLIF(btrim(preference_reason),'') IS NOT NULL)
);

-- Explicit job-shortage split retained even when one RFQ line aggregates several jobs.
CREATE TABLE br04_rfq_line_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_line_id uuid NOT NULL REFERENCES br04_rfq_lines(id),
  shortage_source_id uuid NOT NULL REFERENCES br04_shortage_sources(id),
  demand_quantity numeric(16,4) NOT NULL CHECK(demand_quantity>0),
  UNIQUE(rfq_line_id,shortage_source_id)
);

-- Supplier identity is a reference to forthcoming BR-01C Supplier Master, not a duplicate master.
CREATE TABLE br04_rfq_supplier_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES br04_rfqs(id),
  supplier_master_id uuid,  -- connect FK once BR01C canonical supplier table is known
  supplier_name_snapshot varchar(200) NOT NULL,
  supplier_contact_snapshot varchar(254),
  invitation_status varchar(16) NOT NULL DEFAULT 'INVITED'
    CHECK(invitation_status IN ('INVITED','SENT','RESPONDED','DECLINED','NO_RESPONSE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(rfq_id,id)
);
CREATE TABLE br04_rfq_communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invite_id uuid NOT NULL REFERENCES br04_rfq_supplier_invites(id),
  rfq_revision_no integer NOT NULL CHECK(rfq_revision_no>=1),
  channel varchar(16) NOT NULL CHECK(channel IN ('EMAIL','WHATSAPP','PHONE','MANUAL','OTHER')),
  direction varchar(8) NOT NULL CHECK(direction IN ('OUT','IN')),
  evidence_uri text,
  status varchar(16) NOT NULL DEFAULT 'RECORDED',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_by_id uuid NOT NULL REFERENCES employees(id)
);

CREATE TABLE br04_supplier_offer_headers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES br04_rfqs(id),
  supplier_invite_id uuid NOT NULL REFERENCES br04_rfq_supplier_invites(id),
  supplier_quote_number varchar(100),
  currency_code char(3) NOT NULL DEFAULT 'INR',
  payment_terms text,
  validity_until date,
  quote_date date,
  attachment_uri text,
  status varchar(18) NOT NULL DEFAULT 'RECEIVED'
    CHECK(status IN ('RECEIVED','EXPIRED','REVALIDATION_REQUIRED','WITHDRAWN')),
  created_by_id uuid NOT NULL REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(rfq_id,supplier_invite_id,id)
);
CREATE TABLE br04_supplier_offer_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_header_id uuid NOT NULL REFERENCES br04_supplier_offer_headers(id),
  version_no integer NOT NULL CHECK(version_no>=1),
  supplier_revision_reference varchar(120),
  quoted_valid_until date,
  delivery_terms text,
  warranty_terms text,
  attachment_uri text,
  comments text,
  recorded_by_id uuid NOT NULL REFERENCES employees(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(offer_header_id,version_no),
  UNIQUE(offer_header_id,id)
);
CREATE TABLE br04_supplier_offer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_version_id uuid NOT NULL REFERENCES br04_supplier_offer_versions(id),
  rfq_line_id uuid NOT NULL REFERENCES br04_rfq_lines(id),
  offered_make varchar(160),
  offered_part_number varchar(160),
  product_condition varchar(18) NOT NULL DEFAULT 'NEW'
    CHECK(product_condition IN ('NEW','REFURBISHED','OTHER')),
  offered_quantity numeric(16,4) NOT NULL CHECK(offered_quantity>0),
  quoted_unit_price numeric(18,4) NOT NULL CHECK(quoted_unit_price>=0),
  quoted_discount numeric(18,2) NOT NULL DEFAULT 0 CHECK(quoted_discount>=0),
  freight_packing_nonrecoverable numeric(18,2) NOT NULL DEFAULT 0 CHECK(freight_packing_nonrecoverable>=0),
  nonrecoverable_tax numeric(18,2) NOT NULL DEFAULT 0 CHECK(nonrecoverable_tax>=0),
  recoverable_tax numeric(18,2) NOT NULL DEFAULT 0 CHECK(recoverable_tax>=0),
  delivery_days integer CHECK(delivery_days>=0),
  technical_status varchar(16) NOT NULL DEFAULT 'PENDING'
    CHECK(technical_status IN ('PENDING','COMPLIANT','NONCOMPLIANT')),
  technical_checked_by_id uuid REFERENCES employees(id),
  technical_checked_at timestamptz,
  technical_reason text,
  -- For comparison use like-for-like requested qty; partial offers require split/qualification.
  comparable_quantity numeric(16,4) CHECK(comparable_quantity>0),
  comparable_landed_cost numeric(18,2) GENERATED ALWAYS AS (
    round((coalesce(comparable_quantity,offered_quantity)*quoted_unit_price)::numeric,2)
    -quoted_discount+freight_packing_nonrecoverable+nonrecoverable_tax
  ) STORED,
  CHECK(technical_status<>'COMPLIANT' OR (technical_checked_by_id IS NOT NULL AND technical_checked_at IS NOT NULL)),
  CHECK(comparable_quantity IS NULL OR comparable_quantity<=offered_quantity),
  CHECK(round((coalesce(comparable_quantity,offered_quantity)*quoted_unit_price)::numeric,2)-quoted_discount+freight_packing_nonrecoverable+nonrecoverable_tax>=0),
  UNIQUE(offer_version_id,rfq_line_id)
);

-- Ranking snapshots; use only COMPLIANT offers for identical requested quantities/terms.
-- Server must validate same RFQ line, UOM/currency, comparable qty, validity and tax basis.
CREATE TABLE br04_comparison_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES br04_rfqs(id),
  comparison_version integer NOT NULL CHECK(comparison_version>=1),
  comparison_currency char(3) NOT NULL DEFAULT 'INR',
  comparison_basis_notes text,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  evaluated_by_id uuid NOT NULL REFERENCES employees(id),
  UNIQUE(rfq_id,comparison_version),
  UNIQUE(rfq_id,id)
);
CREATE TABLE br04_comparison_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comparison_id uuid NOT NULL REFERENCES br04_comparison_runs(id),
  rfq_line_id uuid NOT NULL REFERENCES br04_rfq_lines(id),
  offer_line_id uuid NOT NULL REFERENCES br04_supplier_offer_lines(id),
  ranked_landed_cost numeric(18,2) NOT NULL CHECK(ranked_landed_cost>=0),
  rank_no smallint CHECK(rank_no>=1),
  rank_label varchar(16) NOT NULL CHECK(rank_label IN ('SINGLE_OFFER','L1','L2','L3','L4','OTHER','NOT_ELIGIBLE')),
  eligible boolean NOT NULL,
  exclusion_reason text,
  UNIQUE(comparison_id,rfq_line_id,offer_line_id),
  CHECK(eligible OR exclusion_reason IS NOT NULL)
);
CREATE TABLE br04_source_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  comparison_row_id uuid NOT NULL REFERENCES br04_comparison_rows(id),
  recommended_by_id uuid NOT NULL REFERENCES employees(id),
  selection_reason text,
  is_non_l1 boolean NOT NULL DEFAULT false,
  md_approved_by_id uuid REFERENCES employees(id),
  md_approved_at timestamptz,
  md_approval_evidence_uri text,
  recommendation_status varchar(18) NOT NULL DEFAULT 'PROPOSED'
    CHECK(recommendation_status IN ('PROPOSED','MD_PENDING','SELECTED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(recommendation_status<>'SELECTED' OR (NOT is_non_l1 OR
    (md_approved_by_id IS NOT NULL AND md_approved_at IS NOT NULL AND md_approval_evidence_uri IS NOT NULL)))
);

-- BR-04C: internal estimate; anchored to BR-03B report version and BR-03C MR version.
CREATE TABLE br04_repair_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  job_id uuid NOT NULL,
  material_request_version_id uuid REFERENCES br03_material_request_versions(id),
  inspection_report_version_id uuid REFERENCES br03_inspection_report_versions(id),
  latest_stock_check_id uuid REFERENCES br04_stock_checks(id),
  created_by_id uuid NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'DRAFT'
    CHECK(status IN ('DRAFT','PROVISIONAL','FINALISED','SUPERSEDED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
  FOREIGN KEY(company_id,created_by_id) REFERENCES employees(company_id,id),
  UNIQUE(company_id,id)
);
CREATE TABLE br04_estimate_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id uuid NOT NULL REFERENCES br04_repair_estimates(id),
  revision_no integer NOT NULL DEFAULT 0 CHECK(revision_no>=0),
  status varchar(20) NOT NULL DEFAULT 'DRAFT'
    CHECK(status IN ('DRAFT','PROVISIONAL','FINALISED','SUPERSEDED')),
  cost_source_notes text,
  provisional_assumptions text,
  currency_code char(3) NOT NULL DEFAULT 'INR',
  internal_cost_total numeric(18,2) NOT NULL DEFAULT 0 CHECK(internal_cost_total>=0),
  quoted_pre_tax_total numeric(18,2) NOT NULL DEFAULT 0 CHECK(quoted_pre_tax_total>=0),
  target_margin_pct numeric(7,3) CHECK(target_margin_pct>=0 AND target_margin_pct<100),
  minimum_margin_pct numeric(7,3) CHECK(minimum_margin_pct>=0 AND minimum_margin_pct<100),
  minimum_margin_status varchar(18) NOT NULL DEFAULT 'UNCONFIGURED'
    CHECK(minimum_margin_status IN ('UNCONFIGURED','OK','WARNING','EXCEPTION_APPROVED')),
  priced_by_id uuid NOT NULL REFERENCES employees(id),
  priced_at timestamptz NOT NULL DEFAULT now(),
  revision_reason text,
  UNIQUE(estimate_id,revision_no),
  UNIQUE(estimate_id,id),
  CHECK(revision_no=0 OR NULLIF(btrim(revision_reason),'') IS NOT NULL),
  CHECK(status<>'PROVISIONAL' OR NULLIF(btrim(provisional_assumptions),'') IS NOT NULL)
);
CREATE TABLE br04_estimate_cost_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_revision_id uuid NOT NULL REFERENCES br04_estimate_revisions(id),
  line_no integer NOT NULL CHECK(line_no>0),
  cost_kind varchar(24) NOT NULL
    CHECK(cost_kind IN ('MATERIAL_STOCK','MATERIAL_RFQ','LABOUR','TESTING','EXTERNAL','FREIGHT','PACKING','OVERHEAD','OTHER')),
  material_request_line_id uuid REFERENCES br03_material_request_lines(id),
  stock_check_line_id uuid REFERENCES br04_stock_check_lines(id),
  supplier_offer_line_id uuid REFERENCES br04_supplier_offer_lines(id),
  qty numeric(16,4) NOT NULL DEFAULT 1 CHECK(qty>0),
  cost_uom varchar(16),
  unit_cost numeric(18,4) NOT NULL CHECK(unit_cost>=0),
  amount numeric(18,2) GENERATED ALWAYS AS (round((qty*unit_cost)::numeric,2)) STORED,
  price_basis varchar(32) NOT NULL,
  configuration_reference varchar(120),
  notes text,
  UNIQUE(estimate_revision_id,line_no)
);

-- Single authoritative BR-04 customer quote, handed to Sales; BR-05 references this.
CREATE TABLE br04_customer_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  job_id uuid NOT NULL,
  estimate_id uuid NOT NULL REFERENCES br04_repair_estimates(id),
  quote_number varchar(70) NOT NULL,
  created_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
  FOREIGN KEY(company_id,created_by_id) REFERENCES employees(company_id,id),
  UNIQUE(company_id,quote_number), UNIQUE(company_id,id)
);
CREATE TABLE br04_customer_quote_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES br04_customer_quotes(id),
  estimate_revision_id uuid NOT NULL REFERENCES br04_estimate_revisions(id),
  revision_no integer NOT NULL DEFAULT 0 CHECK(revision_no>=0),
  original_authorised_pre_tax numeric(18,2) NOT NULL CHECK(original_authorised_pre_tax>=0),
  revised_pre_tax numeric(18,2) NOT NULL CHECK(revised_pre_tax>=0),
  discount_percent numeric(7,3) GENERATED ALWAYS AS (
    CASE WHEN original_authorised_pre_tax=0 THEN 0
         ELSE round(((original_authorised_pre_tax-revised_pre_tax)*100/original_authorised_pre_tax)::numeric,3) END
  ) STORED,
  tax_total numeric(18,2) NOT NULL DEFAULT 0 CHECK(tax_total>=0),
  freight_charge numeric(18,2) NOT NULL DEFAULT 0 CHECK(freight_charge>=0),
  currency_code char(3) NOT NULL DEFAULT 'INR',
  valid_until date,
  terms_snapshot text,
  inspection_fee_pre_tax numeric(18,2) NOT NULL DEFAULT 0 CHECK(inspection_fee_pre_tax>=0),
  inspection_fee_agreement_ref varchar(180),
  quote_status varchar(20) NOT NULL DEFAULT 'DRAFT'
    CHECK(quote_status IN ('DRAFT','RELEASED_TO_SALES','SENT','ACCEPTED','REJECTED','EXPIRED','SUPERSEDED')),
  discount_requested_by_id uuid REFERENCES employees(id),
  higher_discount_approved_by_id uuid REFERENCES employees(id),
  higher_discount_approved_at timestamptz,
  higher_discount_reason text,
  created_by_id uuid NOT NULL REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revision_reason text,
  UNIQUE(quote_id,revision_no), UNIQUE(quote_id,id),
  CHECK(revision_no=0 OR NULLIF(btrim(revision_reason),'') IS NOT NULL),
  CHECK(inspection_fee_pre_tax=0 OR NULLIF(btrim(inspection_fee_agreement_ref),'') IS NOT NULL),
  CHECK(original_authorised_pre_tax=0 OR revised_pre_tax<=original_authorised_pre_tax OR revision_reason IS NOT NULL),
  CHECK(original_authorised_pre_tax=0 OR revised_pre_tax>=0),
  CHECK(original_authorised_pre_tax=0 OR revised_pre_tax>=round(original_authorised_pre_tax*0.90,2) OR
    (higher_discount_approved_by_id IS NOT NULL AND higher_discount_approved_at IS NOT NULL AND NULLIF(btrim(higher_discount_reason),'') IS NOT NULL))
);
CREATE TABLE br04_quote_sales_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_revision_id uuid NOT NULL REFERENCES br04_customer_quote_revisions(id),
  released_by_purchase_id uuid NOT NULL REFERENCES employees(id),
  assigned_sales_id uuid NOT NULL REFERENCES employees(id),
  released_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  UNIQUE(quote_revision_id)
);
CREATE TABLE br04_cost_actual_reconciliation_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  job_id uuid NOT NULL,
  estimate_revision_id uuid NOT NULL REFERENCES br04_estimate_revisions(id),
  actual_material_cost numeric(18,2),
  actual_labour_cost numeric(18,2),
  actual_external_cost numeric(18,2),
  actual_other_cost numeric(18,2),
  net_invoiced_revenue numeric(18,2),
  inventory_posting_ref varchar(160),
  labour_posting_ref varchar(160),
  invoice_source_ref varchar(160),
  calculated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
  CHECK(actual_material_cost IS NULL OR actual_material_cost>=0),
  CHECK(actual_labour_cost IS NULL OR actual_labour_cost>=0),
  CHECK(actual_external_cost IS NULL OR actual_external_cost>=0),
  CHECK(actual_other_cost IS NULL OR actual_other_cost>=0)
);

-- Business rules implemented at API/inventory integration, NOT assumed from SQL alone:
-- * Only approved item master records, correct company, current MR version; no MR approval.
-- * One warehouse at each repair centre; no cross-company stock netting/transfer.
-- * No stock reservation or issue in BR04; post-order process is BR05 + Inventory.
-- * A company RFQ cannot mix jobs from the other issuing legal company.
-- * Use one single supplier label if only one compliant bid; no fabricated L1 competition.
-- * Restrict rankings to compliant, valid, like-for-like offers; enforce MD evidence if non-L1.
-- * Supplier quote and customer quote do not authorise supplier PO creation.
-- * Only Purchase prepares estimate/quote; Sales sends, <=10% cumulative Sales discount.
-- * Multi-line sale/partial scope and customer PO/email validation belong to BR05.
-- * WAC/latest inventory costs are read from canonical stock cost service; no parallel ledger.
-- * Company calendars, named approvers, labour rates, margins, DOFA limits are not seeded.
COMMIT;


-- ======================================================================
-- COMPONENT 4: Brightech_BR05_PostgreSQL_Additive_Schema_Rev01_Integrated_BR04_Developer_Proposal.sql
-- ======================================================================

-- BRIGHTECH | BR-05A/B/C | POSTGRESQL 15+ | ADDITIVE DEVELOPER PROPOSAL Rev01
-- CLIENT REVIEW / NOT APPROVED / NOT A PRODUCTION MIGRATION
-- Supersedes BR-05 SQL Rev00 as a fresh-install proposal; NOT an ALTER migration for deployed Rev00.
-- SOURCE FILES EXAMINED: BR-02 Rev04 SQL, BR-03 Rev00 SQL, BR-04 Rev00 SQL,
-- BR-05 Rev00 SQL; BR-04/05 SOP Rev01 and accepted business decisions.
-- REQUIRED INSTALL ORDER: BR-02 -> BR-03 -> BR-04 -> this BR-05 Rev01.
-- Authoritative quote pricing/status/revisions: br04_customer_quote_revisions and
-- br04_customer_quotes; authoritative supplier offers/rankings: BR-04.
-- BR-05 owns only dispatch, responses, order authorisation, later stock rechecks,
-- release and reservation requests; no second quote/pricing or inventory master.
-- BR-04 does not yet have an authoritative customer quote LINE table. BR-05 quote_lines
-- below is a version-bound, non-authoritative ACCEPTANCE SCOPE SNAPSHOT, not a pricing master.
-- Actual physical inventory and its reservation transactions require a separate canonical ledger.
-- All pending monetary limits, named roles, calendars, partial-scope rules remain UNCONFIGURED.
-- Company is preserved on each company-owned document; Job IDs come only from BR-02.
-- WARNING: Review BR-02/03/04 proposals and cross-module triggers before ANY deployment.
-- Do not run on production or against an existing BR-05 Rev00 installation.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- BR-05A: ONE source of truth for customer quote revision data: BR-04.
-- Bridge IDs are used by BR-05 events; NO duplicated quote amount, discount, revision number,
-- expiry or quote status. The source UUID is a mandatory real FK, never an unvalidated adapter.
CREATE TABLE br05_quote_revision_refs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 source_br04_quote_id uuid NOT NULL UNIQUE REFERENCES br04_customer_quote_revisions(id),
 registered_by_id uuid NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
 FOREIGN KEY(company_id,registered_by_id) REFERENCES employees(company_id,id),
 UNIQUE(company_id,id),
 UNIQUE(company_id,job_id,id)
);
CREATE INDEX br05_quote_job_idx ON br05_quote_revision_refs(company_id,job_id,registered_at DESC);

-- BR-04 Rev00 has no customer quote-line master. These rows freeze selected customer-facing
-- scope at the time of sending/acceptance. They are NOT independently repriced; prices are
-- illustrative snapshots for partial acceptance, reconciled against BR-04 quote revision totals.
-- Actual canonical quote lines should later live in BR-04; until then do not claim line-level FK.
CREATE TABLE br05_quote_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 quote_revision_id uuid NOT NULL REFERENCES br05_quote_revision_refs(id),
 line_no integer NOT NULL CHECK(line_no>0),
 source_line_reference varchar(120), -- reserved for future approved BR-04 line model
 line_description text NOT NULL CHECK(length(btrim(line_description))>0),
 quantity numeric(16,4) NOT NULL CHECK(quantity>0),
 uom varchar(18) NOT NULL,
 unit_price_pre_tax numeric(16,2) NOT NULL CHECK(unit_price_pre_tax>=0),
 line_amount_pre_tax numeric(16,2) NOT NULL CHECK(line_amount_pre_tax>=0),
 scope_technically_indivisible boolean NOT NULL DEFAULT false,
 snapshot_created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(quote_revision_id,line_no), UNIQUE(quote_revision_id,id)
);

-- BR-04 quote metadata read model for Sales dashboards; no shadow commercial state.
CREATE VIEW br05_customer_quote_read_model AS
 SELECT b.id AS br05_quote_ref_id, b.company_id, b.job_id,
        q.id AS br04_quote_id, q.quote_number,
        r.id AS br04_quote_revision_id, r.revision_no, r.original_authorised_pre_tax,
        r.revised_pre_tax, r.discount_percent, r.tax_total, r.freight_charge,
        r.currency_code, r.valid_until, r.quote_status, r.created_at AS quote_revision_created_at
   FROM br05_quote_revision_refs b
   JOIN br04_customer_quote_revisions r ON r.id=b.source_br04_quote_id
   JOIN br04_customer_quotes q ON q.id=r.quote_id;

CREATE TABLE br05_quote_recipients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 quote_revision_id uuid NOT NULL REFERENCES br05_quote_revision_refs(id),
 contact_name varchar(180) NOT NULL,
 channel varchar(12) NOT NULL CHECK(channel IN ('EMAIL','WHATSAPP')),
 recipient_address varchar(255) NOT NULL,
 customer_contact_ref varchar(80),
 is_authorised_contact boolean,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(quote_revision_id,channel,recipient_address), UNIQUE(quote_revision_id,id)
);

CREATE TABLE br05_quote_dispatch_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 quote_revision_id uuid NOT NULL,
 recipient_id uuid NOT NULL,
 sent_by_id uuid NOT NULL REFERENCES employees(id),
 channel varchar(12) NOT NULL CHECK(channel IN ('EMAIL','WHATSAPP')),
 send_status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK(send_status IN ('DRAFT','QUEUED','SENT','FAILED','CANCELLED','MANUAL_RECORDED')),
 subject_or_summary text,
 attachment_uri text,
 provider_message_id varchar(180),
 attempted_at timestamptz,
 sent_at timestamptz,
 failure_reason text,
 idempotency_key varchar(140) NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(quote_revision_id,recipient_id) REFERENCES br05_quote_recipients(quote_revision_id,id),
 CHECK(send_status<>'SENT' OR sent_at IS NOT NULL)
);

-- Daily internal reminders; customer messages are separately sent/logged, never auto-spammed.
CREATE TABLE br05_sales_followup_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 quote_revision_id uuid NOT NULL REFERENCES br05_quote_revision_refs(id),
 assigned_sales_id uuid NOT NULL REFERENCES employees(id),
 due_at timestamptz NOT NULL,
 task_status varchar(16) NOT NULL DEFAULT 'OPEN' CHECK(task_status IN ('OPEN','COMPLETED','SKIPPED','CANCELLED')),
 task_kind varchar(20) NOT NULL DEFAULT 'DAILY_INTERNAL' CHECK(task_kind IN ('DAILY_INTERNAL','CUSTOMER_CALLBACK','MANUAL')),
 completed_at timestamptz,
 notes text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX br05_followups_due_idx ON br05_sales_followup_tasks(task_status,due_at);

CREATE TABLE br05_customer_response_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 quote_revision_id uuid NOT NULL REFERENCES br05_quote_revision_refs(id),
 response_type varchar(28) NOT NULL CHECK(response_type IN ('AWAITING_RESPONSE','ACCEPTED','COUNTER_OFFER','TECHNICAL_QUERY','PARTIAL_ACCEPTANCE','ON_HOLD','REJECTED','EXPIRED')),
 response_channel varchar(12) CHECK(response_channel IN ('EMAIL','WHATSAPP','CALL','IN_PERSON','OTHER')),
 customer_contact varchar(180),
 response_notes text,
 evidence_uri text,
 responded_at timestamptz NOT NULL DEFAULT now(),
 recorded_by_id uuid NOT NULL REFERENCES employees(id),
 UNIQUE(quote_revision_id,id)
);

CREATE TABLE br05_partial_acceptance_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 response_event_id uuid NOT NULL REFERENCES br05_customer_response_events(id),
 quote_line_id uuid NOT NULL REFERENCES br05_quote_lines(id),
 accepted_quantity numeric(16,4) NOT NULL CHECK(accepted_quantity>0),
 technical_feasibility varchar(18) NOT NULL DEFAULT 'PENDING' CHECK(technical_feasibility IN ('PENDING','FEASIBLE','NOT_FEASIBLE')),
 technical_confirmed_by_id uuid REFERENCES employees(id),
 technical_confirmed_at timestamptz,
 UNIQUE(response_event_id,quote_line_id),
 CHECK(technical_feasibility<>'FEASIBLE' OR technical_confirmed_by_id IS NOT NULL)
);

-- BR-05B: Customer PO, Job Order, or exceptional email-based authorisation.
-- Email authorisation is NEVER relabelled as a PO.
CREATE TABLE br05_customer_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 customer_id uuid NOT NULL,
 order_type varchar(20) NOT NULL CHECK(order_type IN ('CUSTOMER_PO','JOB_ORDER','EMAIL_AUTHORISATION')),
 customer_order_ref varchar(120),
 customer_email_sender varchar(254),
 customer_email_received_at timestamptz,
 received_at timestamptz NOT NULL DEFAULT now(),
 received_by_id uuid NOT NULL,
 pre_tax_total numeric(16,2) CHECK(pre_tax_total>=0),
 tax_total numeric(16,2) CHECK(tax_total>=0),
 payment_terms_snapshot text,
 order_status varchar(20) NOT NULL DEFAULT 'RECEIVED' CHECK(order_status IN ('RECEIVED','CLARIFICATION','VERIFIED','SUSPENDED','CANCELLED')),
 verified_by_id uuid,
 verified_at timestamptz,
 verification_notes text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),
 FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),
 FOREIGN KEY(company_id,received_by_id) REFERENCES employees(company_id,id),
 FOREIGN KEY(company_id,verified_by_id) REFERENCES employees(company_id,id),
 CHECK(order_type <> 'EMAIL_AUTHORISATION' OR (customer_email_sender IS NOT NULL AND customer_email_received_at IS NOT NULL)),
 CHECK(order_type = 'EMAIL_AUTHORISATION' OR nullif(btrim(customer_order_ref),'') IS NOT NULL),
 CHECK(order_status <> 'VERIFIED' OR (verified_by_id IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX br05_order_ref_unique ON br05_customer_orders(company_id,order_type,customer_order_ref) WHERE customer_order_ref IS NOT NULL;

CREATE TABLE br05_order_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES br05_customer_orders(id),
 evidence_type varchar(18) NOT NULL CHECK(evidence_type IN ('CUSTOMER_PO','JOB_ORDER','CUSTOMER_EMAIL','AMENDMENT','OTHER')),
 file_uri text NOT NULL,
 original_filename varchar(255),
 sender_or_source varchar(254),
 content_sha256 char(64),
 recorded_by_id uuid NOT NULL REFERENCES employees(id),
 recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE br05_order_amendments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES br05_customer_orders(id),
 amendment_no integer NOT NULL CHECK(amendment_no>=1),
 customer_amendment_ref varchar(100),
 changed_scope_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(changed_scope_snapshot)='object'),
 reason text NOT NULL,
 attachment_id uuid REFERENCES br05_order_documents(id),
 recorded_by_id uuid NOT NULL REFERENCES employees(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id,amendment_no)
);

-- A single customer order can cover multiple existing BR-02 Job IDs.
CREATE TABLE br05_order_job_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 order_id uuid NOT NULL,
 job_id uuid NOT NULL,
 accepted_quote_revision_id uuid NOT NULL,
 allocated_pre_tax numeric(16,2) NOT NULL CHECK(allocated_pre_tax>=0),
 approved_scope_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(approved_scope_snapshot)='array'),
 allocation_status varchar(18) NOT NULL DEFAULT 'PROPOSED' CHECK(allocation_status IN ('PROPOSED','VERIFIED','SUSPENDED','CANCELLED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,order_id) REFERENCES br05_customer_orders(company_id,id),
 FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
 FOREIGN KEY(company_id,job_id,accepted_quote_revision_id) REFERENCES br05_quote_revision_refs(company_id,job_id,id),
 UNIQUE(company_id,id), UNIQUE(order_id,job_id)
);

CREATE TABLE br05_order_discrepancies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES br05_customer_orders(id),
 job_allocation_id uuid REFERENCES br05_order_job_allocations(id),
 discrepancy_kind varchar(24) NOT NULL CHECK(discrepancy_kind IN ('VALUE','QUANTITY','MAKE','SCOPE','TAX','TERMS','ADDRESS','CONTACT','OTHER')),
 affects_release boolean NOT NULL DEFAULT true,
 discrepancy_notes text NOT NULL,
 resolution_notes text,
 discrepancy_status varchar(12) NOT NULL DEFAULT 'OPEN' CHECK(discrepancy_status IN ('OPEN','RESOLVED','WAIVED')),
 recorded_by_id uuid NOT NULL REFERENCES employees(id),
 resolved_by_id uuid REFERENCES employees(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 CHECK(discrepancy_status='OPEN' OR (resolved_by_id IS NOT NULL AND resolved_at IS NOT NULL AND nullif(btrim(resolution_notes),'') IS NOT NULL))
);

CREATE TABLE br05_order_verification_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES br05_customer_orders(id),
 verified_by_id uuid NOT NULL REFERENCES employees(id),
 decision varchar(18) NOT NULL CHECK(decision IN ('VERIFIED','CLARIFICATION','REJECTED','SUSPENDED','CANCELLED')),
 decision_reason text,
 checklist_snapshot jsonb NOT NULL CHECK(jsonb_typeof(checklist_snapshot)='object'),
 verified_at timestamptz NOT NULL DEFAULT now()
);

-- Commercial authorisation is separate from operational job release and inventory reservations.
CREATE TABLE br05_job_authorisations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 order_job_allocation_id uuid NOT NULL,
 authorised_by_id uuid NOT NULL,
 authorisation_kind varchar(20) NOT NULL CHECK(authorisation_kind IN ('CUSTOMER_PO','JOB_ORDER','EMAIL_AUTHORISATION')),
 scope_snapshot jsonb NOT NULL CHECK(jsonb_typeof(scope_snapshot)='array'),
 authorised_amount_pre_tax numeric(16,2) NOT NULL CHECK(authorised_amount_pre_tax>=0),
 authorisation_status varchar(16) NOT NULL DEFAULT 'AUTHORISED' CHECK(authorisation_status IN ('AUTHORISED','SUSPENDED','CANCELLED')),
 is_current boolean NOT NULL DEFAULT true,
 authorised_at timestamptz NOT NULL DEFAULT now(),
 ended_at timestamptz,
 FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
 FOREIGN KEY(company_id,order_job_allocation_id) REFERENCES br05_order_job_allocations(company_id,id),
 FOREIGN KEY(company_id,authorised_by_id) REFERENCES employees(company_id,id),
 UNIQUE(company_id,id)
);
CREATE UNIQUE INDEX br05_one_current_authorisation_per_job ON br05_job_authorisations(job_id) WHERE is_current;

-- BR-05C: actual stock recheck after authorisation; BR-04/Inventory remains source of truth.
CREATE TABLE br05_stock_rechecks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 job_authorisation_id uuid NOT NULL,
 checked_by_id uuid NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT now(),
 inventory_source_ref varchar(160), -- external inventory audit/version (not a new ledger)
 source_br04_stock_check_id uuid REFERENCES br04_stock_checks(id),
 is_current boolean NOT NULL DEFAULT true,
 FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
 FOREIGN KEY(company_id,job_authorisation_id) REFERENCES br05_job_authorisations(company_id,id),
 FOREIGN KEY(company_id,checked_by_id) REFERENCES employees(company_id,id),
 UNIQUE(company_id,id)
);
CREATE UNIQUE INDEX br05_one_current_stock_recheck_per_job ON br05_stock_rechecks(job_id) WHERE is_current;

CREATE TABLE br05_stock_recheck_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 stock_recheck_id uuid NOT NULL REFERENCES br05_stock_rechecks(id),
 material_request_line_id uuid NOT NULL REFERENCES br03_material_request_lines(id),
 item_bridge_id uuid NOT NULL REFERENCES br03_item_catalog_bridge(id),
 source_br04_stock_check_line_id uuid REFERENCES br04_stock_check_lines(id),
 uom varchar(18) NOT NULL,
 required_quantity numeric(16,4) NOT NULL CHECK(required_quantity>=0),
 store_physical_quantity numeric(16,4) NOT NULL CHECK(store_physical_quantity>=0),
 engineer_held_quantity numeric(16,4) NOT NULL CHECK(engineer_held_quantity>=0),
 reserved_store_quantity numeric(16,4) NOT NULL CHECK(reserved_store_quantity>=0),
 quarantined_store_quantity numeric(16,4) NOT NULL CHECK(quarantined_store_quantity>=0),
 other_holds_store_quantity numeric(16,4) NOT NULL DEFAULT 0 CHECK(other_holds_store_quantity>=0),
 unaccepted_store_quantity numeric(16,4) NOT NULL DEFAULT 0 CHECK(unaccepted_store_quantity>=0),
 physical_total_quantity numeric(16,4) GENERATED ALWAYS AS (store_physical_quantity+engineer_held_quantity) STORED,
 available_store_quantity numeric(16,4) GENERATED ALWAYS AS (
  GREATEST(0,store_physical_quantity-reserved_store_quantity-quarantined_store_quantity-other_holds_store_quantity-unaccepted_store_quantity)
 ) STORED,
 shortage_quantity numeric(16,4) GENERATED ALWAYS AS (
  GREATEST(0,required_quantity-GREATEST(0,store_physical_quantity-reserved_store_quantity-quarantined_store_quantity-other_holds_store_quantity-unaccepted_store_quantity))
 ) STORED,
 source_stock_version varchar(100),
 CHECK(reserved_store_quantity+quarantined_store_quantity+other_holds_store_quantity+unaccepted_store_quantity<=store_physical_quantity),
 UNIQUE(stock_recheck_id,material_request_line_id)
);

CREATE TABLE br05_job_releases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 job_authorisation_id uuid NOT NULL,
 stock_recheck_id uuid NOT NULL,
 released_by_id uuid NOT NULL,
 release_status varchar(18) NOT NULL DEFAULT 'RELEASED' CHECK(release_status IN ('RELEASED','ON_HOLD','CANCELLED')),
 release_notes text,
 released_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
 FOREIGN KEY(company_id,job_authorisation_id) REFERENCES br05_job_authorisations(company_id,id),
 FOREIGN KEY(company_id,stock_recheck_id) REFERENCES br05_stock_rechecks(company_id,id),
 FOREIGN KEY(company_id,released_by_id) REFERENCES employees(company_id,id),
 UNIQUE(company_id,id), UNIQUE(job_authorisation_id)
);

-- Proposed reservation -> confirmed only when authoritative inventory service posts a real reservation.
-- Neither BR-05 snapshot nor this SQL alone prevents concurrent reservations in the inventory ledger.
CREATE TABLE br05_material_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 job_release_id uuid NOT NULL,
 stock_recheck_line_id uuid NOT NULL REFERENCES br05_stock_recheck_lines(id),
 reserved_quantity numeric(16,4) NOT NULL CHECK(reserved_quantity>0),
 reservation_status varchar(18) NOT NULL DEFAULT 'PROPOSED' CHECK(reservation_status IN ('PROPOSED','COMMITTED','RELEASED','CANCELLED')),
 inventory_reservation_ref varchar(160),
 created_by_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 committed_at timestamptz,
 FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
 FOREIGN KEY(company_id,job_release_id) REFERENCES br05_job_releases(company_id,id),
 FOREIGN KEY(company_id,created_by_id) REFERENCES employees(company_id,id),
 UNIQUE(inventory_reservation_ref),
 CHECK(reservation_status <> 'COMMITTED' OR (inventory_reservation_ref IS NOT NULL AND committed_at IS NOT NULL))
);
CREATE INDEX br05_reservation_job_idx ON br05_material_reservations(job_id,reservation_status);

CREATE TABLE br05_job_holds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 hold_reason varchar(28) NOT NULL CHECK(hold_reason IN ('ORDER_DISCREPANCY','SCOPE','STOCK','SUPPLIER_REVALIDATION','TECHNICAL','CUSTOMER_REQUEST','OTHER')),
 notes text,
 is_blocking boolean NOT NULL DEFAULT true,
 started_by_id uuid NOT NULL,
 ended_by_id uuid,
 started_at timestamptz NOT NULL DEFAULT now(),
 ended_at timestamptz,
 FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
 FOREIGN KEY(company_id,started_by_id) REFERENCES employees(company_id,id),
 FOREIGN KEY(company_id,ended_by_id) REFERENCES employees(company_id,id),
 CHECK(ended_at IS NULL OR ended_by_id IS NOT NULL)
);

CREATE TABLE br05_partial_work_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 job_release_id uuid NOT NULL,
 engineer_id uuid NOT NULL,
 is_permitted boolean NOT NULL,
 permitted_scope_notes text NOT NULL,
 decided_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
 FOREIGN KEY(company_id,job_release_id) REFERENCES br05_job_releases(company_id,id),
 FOREIGN KEY(company_id,engineer_id) REFERENCES employees(company_id,id)
);

-- Supplier revalidation is line-specific, with mandatory real BR-04 offer-version and
-- offer-line FKs. The job ↔ offer connection through RFQ-shortage sources is trigger checked.
CREATE TABLE br05_supplier_revalidations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 source_br04_offer_version_id uuid NOT NULL REFERENCES br04_supplier_offer_versions(id),
 source_br04_offer_line_id uuid NOT NULL REFERENCES br04_supplier_offer_lines(id),
 supplier_quote_reference varchar(100), -- descriptive snapshot only, NOT the FK
 quoted_valid_until date,
 revalidation_status varchar(16) NOT NULL CHECK(revalidation_status IN ('VALID','EXPIRED','RECONFIRMED','CHANGED','UNAVAILABLE')),
 revised_cost numeric(16,2) CHECK(revised_cost>=0),
 verified_by_id uuid NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now(),
 evidence_uri text,
 FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
 FOREIGN KEY(company_id,verified_by_id) REFERENCES employees(company_id,id),
 UNIQUE(company_id,id)
);
CREATE INDEX br05_reval_offer_idx ON br05_supplier_revalidations(source_br04_offer_version_id,job_id);

-- Policy is intentionally UNCONFIGURED until Brightech defines monetary levels/approvers.
CREATE TABLE br05_supplier_po_authority_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES legal_entities(id),
 policy_name varchar(100) NOT NULL,
 lower_value numeric(16,2) CHECK(lower_value>=0),
 upper_value numeric(16,2) CHECK(upper_value>=0),
 approval_role varchar(80),
 designated_approver_id uuid,
 active_after_approval boolean NOT NULL DEFAULT false,
 policy_approved_at timestamptz,
 FOREIGN KEY(company_id,designated_approver_id) REFERENCES employees(company_id,id),
 CHECK(upper_value IS NULL OR lower_value IS NULL OR upper_value>=lower_value),
 CHECK(active_after_approval=false OR (approval_role IS NOT NULL AND policy_approved_at IS NOT NULL))
);

CREATE TABLE br05_supplier_po_release_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 requested_by_id uuid NOT NULL,
 source_br04_source_recommendation_id uuid REFERENCES br04_source_recommendations(id),
 source_br04_offer_line_id uuid REFERENCES br04_supplier_offer_lines(id),
 supplier_quote_reference varchar(120), -- only a display snapshot
 estimated_po_value numeric(16,2) CHECK(estimated_po_value>=0),
 selected_rank varchar(14) CHECK(selected_rank IN ('SINGLE_OFFER','L1','L2','L3','L4','OTHER')),
 -- MD approval evidence and ranking are in br04_source_recommendations (not duplicated here).
 authority_policy_id uuid REFERENCES br05_supplier_po_authority_policies(id),
 approved_by_id uuid,
 approved_at timestamptz,
 approval_reference varchar(160),
 status varchar(24) NOT NULL DEFAULT 'AWAITING_POLICY'
  CHECK(status IN ('AWAITING_POLICY','AWAITING_APPROVAL','AUTHORISED_FOR_BR06','CANCELLED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
 FOREIGN KEY(company_id,requested_by_id) REFERENCES employees(company_id,id),
 FOREIGN KEY(company_id,approved_by_id) REFERENCES employees(company_id,id),
 CHECK(status <> 'AUTHORISED_FOR_BR06' OR (
  authority_policy_id IS NOT NULL AND approved_by_id IS NOT NULL
  AND approved_at IS NOT NULL AND NULLIF(btrim(approval_reference),'') IS NOT NULL
  AND source_br04_source_recommendation_id IS NOT NULL
  AND source_br04_offer_line_id IS NOT NULL))
);

-- Payment reminders use actual invoice due dates once an invoicing master is available.
CREATE TABLE br05_payment_followup_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES legal_entities(id),
 customer_id uuid NOT NULL,
 order_id uuid REFERENCES br05_customer_orders(id),
 source_invoice_ref varchar(120),
 invoice_due_date date,
 reminder_offset_days integer NOT NULL CHECK(reminder_offset_days IN (-7,-3,0,3)),
 scheduled_at timestamptz,
 reminder_status varchar(14) NOT NULL DEFAULT 'DRAFT' CHECK(reminder_status IN ('DRAFT','SCHEDULED','SENT','CANCELLED','SKIPPED')),
 sent_at timestamptz,
 FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),
 CHECK(reminder_status <> 'SCHEDULED' OR (source_invoice_ref IS NOT NULL AND invoice_due_date IS NOT NULL AND scheduled_at IS NOT NULL))
);

-- Audit for every significant transition. No UPDATE/DELETE of previous event evidence in API.
CREATE TABLE br05_audit_events (
 id bigserial PRIMARY KEY,
 company_id uuid NOT NULL REFERENCES legal_entities(id),
 actor_id uuid REFERENCES employees(id),
 job_id uuid REFERENCES service_jobs(id),
 entity_type varchar(64) NOT NULL,
 entity_id uuid NOT NULL,
 event_code varchar(72) NOT NULL,
 before_state jsonb,
 after_state jsonb,
 occurred_at timestamptz NOT NULL DEFAULT now()
);

-- Guard A: every bridge must reference a BR-04 quote revision actually belonging to same
-- company and Job ID. Source quote line master does not exist in BR-04 Rev00.
CREATE OR REPLACE FUNCTION br05_guard_quote_bridge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_company uuid;
        v_job uuid;
BEGIN
 SELECT q.company_id,q.job_id INTO v_company,v_job
   FROM br04_customer_quote_revisions r
   JOIN br04_customer_quotes q ON q.id=r.quote_id
  WHERE r.id=NEW.source_br04_quote_id;
 IF NOT FOUND OR v_company<>NEW.company_id OR v_job<>NEW.job_id THEN
  RAISE EXCEPTION 'BR05: BR04 quotation revision does not belong to referenced job/company';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER br05_quote_bridge_gate BEFORE INSERT OR UPDATE OF source_br04_quote_id,company_id,job_id
 ON br05_quote_revision_refs FOR EACH ROW EXECUTE FUNCTION br05_guard_quote_bridge();

-- Guard B: order-job allocation must use the same customer as the original BR-02 inward.
-- Also check that order and accepted quote revisions belong to the same company + job.
CREATE OR REPLACE FUNCTION br05_guard_order_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_order br05_customer_orders%ROWTYPE;
        v_customer uuid;
        v_quote_source uuid;
BEGIN
 SELECT * INTO v_order FROM br05_customer_orders WHERE id=NEW.order_id;
 SELECT ir.customer_id INTO v_customer
   FROM service_jobs j JOIN inward_receipts ir ON ir.id=j.inward_id
  WHERE j.id=NEW.job_id AND j.company_id=NEW.company_id;
 SELECT b.source_br04_quote_id INTO v_quote_source
   FROM br05_quote_revision_refs b
  WHERE b.id=NEW.accepted_quote_revision_id AND b.company_id=NEW.company_id AND b.job_id=NEW.job_id;
 IF v_order.id IS NULL OR v_order.company_id<>NEW.company_id OR v_customer IS NULL
    OR v_order.customer_id<>v_customer OR v_quote_source IS NULL THEN
  RAISE EXCEPTION 'BR05: order/customer/quote must match BR02 job and company';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER br05_order_allocation_gate BEFORE INSERT OR UPDATE OF company_id,order_id,job_id,accepted_quote_revision_id
 ON br05_order_job_allocations FOR EACH ROW EXECUTE FUNCTION br05_guard_order_allocation();

-- Guard C: a partial acceptance must reference a scope line from the SAME quote version.
CREATE OR REPLACE FUNCTION br05_guard_partial_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_response_quote uuid;
        v_response_type varchar(28);
        v_line_quote uuid;
        v_line_qty numeric(16,4);
BEGIN
 SELECT quote_revision_id,response_type INTO v_response_quote,v_response_type
   FROM br05_customer_response_events WHERE id=NEW.response_event_id;
 SELECT quote_revision_id,quantity INTO v_line_quote,v_line_qty FROM br05_quote_lines WHERE id=NEW.quote_line_id;
 IF v_response_quote IS NULL OR v_line_quote IS NULL OR v_response_quote<>v_line_quote
    OR v_response_type<>'PARTIAL_ACCEPTANCE' OR NEW.accepted_quantity>v_line_qty THEN
  RAISE EXCEPTION 'BR05: partial acceptance line/quantity does not match response quotation';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER br05_partial_scope_gate BEFORE INSERT OR UPDATE ON br05_partial_acceptance_lines
 FOR EACH ROW EXECUTE FUNCTION br05_guard_partial_scope();

-- Guard D: authorisation requires verified customer order and allocation; BR-04 quotation
-- must be SENT or ACCEPTED (BR-04 does NOT use Rev00 BR-05 status ISSUED).
CREATE OR REPLACE FUNCTION br05_guard_job_authorisation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_allocation br05_order_job_allocations%ROWTYPE;
        v_order br05_customer_orders%ROWTYPE;
        v_quote br04_customer_quote_revisions%ROWTYPE;
        v_br04_job uuid;
        v_br04_company uuid;
BEGIN
 SELECT * INTO v_allocation FROM br05_order_job_allocations WHERE id=NEW.order_job_allocation_id;
 IF NOT FOUND OR v_allocation.company_id<>NEW.company_id OR v_allocation.job_id<>NEW.job_id
   OR v_allocation.allocation_status<>'VERIFIED' THEN
  RAISE EXCEPTION 'BR05: allocation must be verified and match job/company';
 END IF;
 SELECT * INTO v_order FROM br05_customer_orders WHERE id=v_allocation.order_id;
 IF v_order.id IS NULL OR v_order.order_status<>'VERIFIED' OR v_order.company_id<>NEW.company_id
   OR v_order.order_type<>NEW.authorisation_kind THEN
  RAISE EXCEPTION 'BR05: customer order is not verified or authorisation type mismatch';
 END IF;
 SELECT r.* INTO v_quote
   FROM br05_quote_revision_refs b
   JOIN br04_customer_quote_revisions r ON r.id=b.source_br04_quote_id
  WHERE b.id=v_allocation.accepted_quote_revision_id;
 SELECT q.company_id,q.job_id INTO v_br04_company,v_br04_job
   FROM br04_customer_quote_revisions r
   JOIN br04_customer_quotes q ON q.id=r.quote_id
  WHERE r.id=v_quote.id;
 IF v_quote.id IS NULL OR v_br04_company<>NEW.company_id OR v_br04_job<>NEW.job_id
   OR v_quote.quote_status NOT IN ('SENT','ACCEPTED')
   OR (v_quote.valid_until IS NOT NULL AND v_quote.valid_until<CURRENT_DATE) THEN
  RAISE EXCEPTION 'BR05: accepted BR04 quotation is not valid for this job';
 END IF;
 IF EXISTS (SELECT 1 FROM br05_order_discrepancies d WHERE d.order_id=v_order.id
    AND d.discrepancy_status='OPEN' AND d.affects_release
    AND (d.job_allocation_id IS NULL OR d.job_allocation_id=v_allocation.id)) THEN
  RAISE EXCEPTION 'BR05: unresolved material order discrepancy';
 END IF;
 IF EXISTS (SELECT 1 FROM br05_job_holds h WHERE h.job_id=NEW.job_id
    AND h.ended_at IS NULL AND h.is_blocking) THEN
  RAISE EXCEPTION 'BR05: blocking job hold exists';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER br05_authorise_gate BEFORE INSERT OR UPDATE OF company_id,job_id,order_job_allocation_id,authorisation_kind
 ON br05_job_authorisations FOR EACH ROW EXECUTE FUNCTION br05_guard_job_authorisation();

-- Guard E: linked BR-04 stock check is PRE-authorisation evidence; the BR-05 recheck
-- is a NEW post-authorisation inventory snapshot, never a replacement for BR-04.
CREATE OR REPLACE FUNCTION br05_guard_stock_recheck() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_auth br05_job_authorisations%ROWTYPE;
        v_prev br04_stock_checks%ROWTYPE;
BEGIN
 SELECT * INTO v_auth FROM br05_job_authorisations WHERE id=NEW.job_authorisation_id;
 IF v_auth.id IS NULL OR v_auth.company_id<>NEW.company_id OR v_auth.job_id<>NEW.job_id
   OR v_auth.authorisation_status<>'AUTHORISED' THEN
  RAISE EXCEPTION 'BR05: stock recheck requires matching job authorisation';
 END IF;
 IF NEW.source_br04_stock_check_id IS NOT NULL THEN
  SELECT * INTO v_prev FROM br04_stock_checks WHERE id=NEW.source_br04_stock_check_id;
  IF v_prev.id IS NULL OR v_prev.company_id<>NEW.company_id OR v_prev.job_id<>NEW.job_id THEN
   RAISE EXCEPTION 'BR05: prior BR04 stock check not linked to this job/company';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER br05_stock_recheck_gate BEFORE INSERT OR UPDATE OF company_id,job_id,job_authorisation_id,source_br04_stock_check_id
 ON br05_stock_rechecks FOR EACH ROW EXECUTE FUNCTION br05_guard_stock_recheck();

-- Guard F: where BR-04 item-line source is present, verify it refers to same MR line,
-- Item Master bridge, and corresponding job/company. NULL is valid for new recheck lines.
CREATE OR REPLACE FUNCTION br05_guard_stock_recheck_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_new br05_stock_rechecks%ROWTYPE;
        v_prior_record record;
        v_request_job uuid;
        v_request_company uuid;
        v_request_item uuid;
        v_request_uom varchar(16);
        v_request_qty numeric(16,4);
BEGIN
 SELECT * INTO v_new FROM br05_stock_rechecks WHERE id=NEW.stock_recheck_id;
 SELECT mr.job_id,mr.company_id,ml.item_bridge_id,ml.uom_snapshot,ml.quantity
   INTO v_request_job,v_request_company,v_request_item,v_request_uom,v_request_qty
   FROM br03_material_request_lines ml JOIN br03_material_requests mr ON mr.id=ml.request_id
  WHERE ml.id=NEW.material_request_line_id;
 IF v_new.id IS NULL OR v_request_job IS NULL OR v_request_job<>v_new.job_id
   OR v_request_company<>v_new.company_id OR v_request_item<>NEW.item_bridge_id
   OR v_request_uom<>NEW.uom OR NEW.required_quantity>v_request_qty THEN
  RAISE EXCEPTION 'BR05: recheck line must match job/company/item/UOM and authorised demand';
 END IF;
 IF NEW.source_br04_stock_check_line_id IS NOT NULL THEN
  SELECT l.material_request_line_id,l.item_bridge_id,s.job_id,s.company_id,s.id AS stock_check_id
    INTO v_prior_record
    FROM br04_stock_check_lines l JOIN br04_stock_checks s ON s.id=l.stock_check_id
   WHERE l.id=NEW.source_br04_stock_check_line_id;
  IF NOT FOUND OR v_prior_record.material_request_line_id<>NEW.material_request_line_id
    OR v_prior_record.item_bridge_id<>NEW.item_bridge_id
    OR v_prior_record.job_id<>v_new.job_id OR v_prior_record.company_id<>v_new.company_id
    OR (v_new.source_br04_stock_check_id IS NOT NULL
       AND v_prior_record.stock_check_id<>v_new.source_br04_stock_check_id) THEN
   RAISE EXCEPTION 'BR05: prior BR04 stock line must match job/material/item';
  END IF;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM br03_material_request_lines ml
    WHERE ml.id=NEW.material_request_line_id AND ml.item_bridge_id=NEW.item_bridge_id) THEN
  RAISE EXCEPTION 'BR05: recheck item mismatches material request line';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER br05_stock_recheck_line_gate BEFORE INSERT OR UPDATE ON br05_stock_recheck_lines
 FOR EACH ROW EXECUTE FUNCTION br05_guard_stock_recheck_line();

-- Guard G: job RELEASE needs active authorisation and current BR-05 stock recheck.
CREATE OR REPLACE FUNCTION br05_guard_job_release() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_auth br05_job_authorisations%ROWTYPE;
        v_check br05_stock_rechecks%ROWTYPE;
BEGIN
 SELECT * INTO v_auth FROM br05_job_authorisations WHERE id=NEW.job_authorisation_id;
 SELECT * INTO v_check FROM br05_stock_rechecks WHERE id=NEW.stock_recheck_id;
 IF v_auth.id IS NULL OR v_auth.authorisation_status<>'AUTHORISED' OR NOT v_auth.is_current
   OR v_auth.company_id<>NEW.company_id OR v_auth.job_id<>NEW.job_id THEN
  RAISE EXCEPTION 'BR05: no active valid job authorisation';
 END IF;
 IF v_check.id IS NULL OR NOT v_check.is_current OR v_check.company_id<>NEW.company_id
   OR v_check.job_id<>NEW.job_id OR v_check.job_authorisation_id<>NEW.job_authorisation_id THEN
  RAISE EXCEPTION 'BR05: job release needs current post-authorisation stock recheck';
 END IF;
 IF EXISTS (SELECT 1 FROM br05_job_holds h WHERE h.job_id=NEW.job_id AND h.is_blocking AND h.ended_at IS NULL) THEN
  RAISE EXCEPTION 'BR05: blocking job hold still open';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER br05_job_release_gate BEFORE INSERT ON br05_job_releases
 FOR EACH ROW EXECUTE FUNCTION br05_guard_job_release();

-- Guard H: BR-05 reservation proposal does NOT create an inventory-ledger reservation.
-- Row-lock serialises proposals for a single recheck line; canonical inventory must atomically
-- enforce current store balance across *all* jobs before setting COMMITTED.
CREATE OR REPLACE FUNCTION br05_guard_material_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_release br05_job_releases%ROWTYPE;
        v_line br05_stock_recheck_lines%ROWTYPE;
        v_existing numeric(16,4);
BEGIN
 SELECT * INTO v_release FROM br05_job_releases WHERE id=NEW.job_release_id;
 IF v_release.id IS NULL OR v_release.release_status<>'RELEASED'
   OR v_release.company_id<>NEW.company_id OR v_release.job_id<>NEW.job_id THEN
  RAISE EXCEPTION 'BR05: reservation requires released job';
 END IF;
 SELECT * INTO v_line FROM br05_stock_recheck_lines WHERE id=NEW.stock_recheck_line_id FOR UPDATE;
 IF NOT FOUND OR v_line.stock_recheck_id<>v_release.stock_recheck_id THEN
  RAISE EXCEPTION 'BR05: reservation line must match release stock recheck';
 END IF;
 SELECT COALESCE(sum(reserved_quantity),0) INTO v_existing FROM br05_material_reservations
  WHERE stock_recheck_line_id=NEW.stock_recheck_line_id AND reservation_status IN ('PROPOSED','COMMITTED')
    AND (TG_OP='INSERT' OR id<>NEW.id);
 IF NEW.reservation_status IN ('PROPOSED','COMMITTED') AND
    v_existing+NEW.reserved_quantity>LEAST(v_line.available_store_quantity,v_line.required_quantity) THEN
  RAISE EXCEPTION 'BR05: proposed reservation exceeds snapshot availability or requirement';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER br05_reservation_gate BEFORE INSERT OR UPDATE ON br05_material_reservations
 FOR EACH ROW EXECUTE FUNCTION br05_guard_material_reservation();

-- Guard I: supplier revalidation must resolve to a BR-04 OFFER LINE, valid for this
-- job through the original company-specific shortage and RFQ line linkage.
CREATE OR REPLACE FUNCTION br05_guard_supplier_revalidation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_version uuid;
        v_matched boolean;
BEGIN
 SELECT ol.offer_version_id INTO v_version FROM br04_supplier_offer_lines ol
  WHERE ol.id=NEW.source_br04_offer_line_id;
 IF v_version IS NULL OR v_version<>NEW.source_br04_offer_version_id THEN
  RAISE EXCEPTION 'BR05: revalidated offer line/version mismatch';
 END IF;
 SELECT EXISTS (
  SELECT 1 FROM br04_supplier_offer_lines ol
  JOIN br04_supplier_offer_versions ov ON ov.id=ol.offer_version_id
  JOIN br04_supplier_offer_headers oh ON oh.id=ov.offer_header_id
  JOIN br04_rfqs r ON r.id=oh.rfq_id
  JOIN br04_rfq_line_sources ls ON ls.rfq_line_id=ol.rfq_line_id
  JOIN br04_shortage_sources ss ON ss.id=ls.shortage_source_id
  WHERE ol.id=NEW.source_br04_offer_line_id AND r.company_id=NEW.company_id
    AND ss.company_id=NEW.company_id AND ss.job_id=NEW.job_id
 ) INTO v_matched;
 IF NOT v_matched THEN
  RAISE EXCEPTION 'BR05: revalidated supplier offer does not source this job/company';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER br05_supplier_revalidation_gate BEFORE INSERT OR UPDATE OF
 company_id,job_id,source_br04_offer_version_id,source_br04_offer_line_id
 ON br05_supplier_revalidations FOR EACH ROW EXECUTE FUNCTION br05_guard_supplier_revalidation();

-- Guard J: supplier PO request must refer to BR04 selected recommendation + matching
-- offer line, the job's shortages, and MD approval for non-L1. Plus DOFA for BR06 release.
-- It creates only authorisation eligibility for the future BR-06; no real supplier PO.
CREATE OR REPLACE FUNCTION br05_guard_po_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_policy br05_supplier_po_authority_policies%ROWTYPE;
        v_rec br04_source_recommendations%ROWTYPE;
        v_cmp br04_comparison_rows%ROWTYPE;
        v_job_match boolean;
        v_policy_actor_role varchar(40);
BEGIN
 IF NEW.source_br04_source_recommendation_id IS NOT NULL THEN
  SELECT * INTO v_rec FROM br04_source_recommendations WHERE id=NEW.source_br04_source_recommendation_id;
  IF v_rec.id IS NULL OR v_rec.company_id<>NEW.company_id THEN
   RAISE EXCEPTION 'BR05: selected BR04 supplier recommendation company mismatch';
  END IF;
  SELECT * INTO v_cmp FROM br04_comparison_rows WHERE id=v_rec.comparison_row_id;
  IF v_cmp.id IS NULL OR v_cmp.offer_line_id IS DISTINCT FROM NEW.source_br04_offer_line_id THEN
   RAISE EXCEPTION 'BR05: offer line does not match BR04 recommended comparison row';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM br04_supplier_offer_lines ol
    JOIN br04_supplier_offer_versions ov ON ov.id=ol.offer_version_id
    JOIN br04_supplier_offer_headers oh ON oh.id=ov.offer_header_id
    JOIN br04_rfqs rfq ON rfq.id=oh.rfq_id
    JOIN br04_rfq_line_sources lsrc ON lsrc.rfq_line_id=ol.rfq_line_id
    JOIN br04_shortage_sources ss ON ss.id=lsrc.shortage_source_id
   WHERE ol.id=NEW.source_br04_offer_line_id AND rfq.company_id=NEW.company_id
     AND ss.company_id=NEW.company_id AND ss.job_id=NEW.job_id
  ) INTO v_job_match;
  IF NOT v_job_match THEN
   RAISE EXCEPTION 'BR05: selected supplier offer is not linked to this job/company';
  END IF;
  IF NEW.selected_rank IS DISTINCT FROM v_cmp.rank_label THEN
   RAISE EXCEPTION 'BR05: supplier rank must match BR04 comparison ranking';
  END IF;
 END IF;
 IF NEW.status='AUTHORISED_FOR_BR06' THEN
  IF NEW.source_br04_source_recommendation_id IS NULL OR v_rec.recommendation_status<>'SELECTED'
    OR NOT v_cmp.eligible OR v_cmp.rank_label='NOT_ELIGIBLE' THEN
   RAISE EXCEPTION 'BR05: selected eligible BR04 supplier offer required';
  END IF;
  IF v_cmp.rank_label NOT IN ('L1','SINGLE_OFFER') AND
     (NOT v_rec.is_non_l1 OR v_rec.md_approved_by_id IS NULL OR v_rec.md_approved_at IS NULL
      OR NULLIF(btrim(v_rec.md_approval_evidence_uri),'') IS NULL) THEN
   RAISE EXCEPTION 'BR05: MD-approved non-L1 recommendation required';
  END IF;
  SELECT * INTO v_policy FROM br05_supplier_po_authority_policies WHERE id=NEW.authority_policy_id;
  IF v_policy.id IS NULL OR NOT v_policy.active_after_approval OR v_policy.company_id<>NEW.company_id
    OR v_policy.approval_role IS NULL OR v_policy.policy_approved_at IS NULL THEN
   RAISE EXCEPTION 'BR05: approved and active supplier PO delegation policy required';
  END IF;
  IF NEW.estimated_po_value IS NULL OR
     (v_policy.lower_value IS NOT NULL AND NEW.estimated_po_value<v_policy.lower_value)
     OR (v_policy.upper_value IS NOT NULL AND NEW.estimated_po_value>v_policy.upper_value) THEN
   RAISE EXCEPTION 'BR05: supplier PO value outside delegated policy';
  END IF;
  IF NEW.approved_by_id IS NULL OR NEW.approved_at IS NULL OR
     NULLIF(btrim(NEW.approval_reference),'') IS NULL THEN
   RAISE EXCEPTION 'BR05: transaction-specific supplier PO approval missing';
  END IF;
  IF v_policy.designated_approver_id IS NOT NULL AND
     v_policy.designated_approver_id<>NEW.approved_by_id THEN
   RAISE EXCEPTION 'BR05: approval actor differs from designated authority';
  END IF;
  SELECT role_code INTO v_policy_actor_role FROM employees
   WHERE id=NEW.approved_by_id AND company_id=NEW.company_id AND is_active;
  IF v_policy_actor_role IS NULL OR v_policy_actor_role<>v_policy.approval_role THEN
   RAISE EXCEPTION 'BR05: transaction approver does not have the configured authority role';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM br05_job_releases rel JOIN br05_job_authorisations auth
      ON auth.id=rel.job_authorisation_id
    WHERE rel.company_id=NEW.company_id AND rel.job_id=NEW.job_id
      AND rel.release_status='RELEASED' AND auth.is_current AND auth.authorisation_status='AUTHORISED'
  ) THEN
   RAISE EXCEPTION 'BR05: customer-authorised released job required before supplier PO eligibility';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER br05_po_authority_gate BEFORE INSERT OR UPDATE ON br05_supplier_po_release_intents
 FOR EACH ROW EXECUTE FUNCTION br05_guard_po_intent();

-- Developer API must additionally enforce:
-- (a) actor roles: Sales sends/records responses, Purchase verifies/release/reserves;
-- (b) derive all quote pricing, tax, status and cumulative discount from BR-04, never
--     mutate BR-05 shadows; >10% approval must be validated under BR-04C authority;
-- (c) below-minimum-margin hold once Brightech configures margin policy;
-- (d) verify accepted quotation revision, customer identity, amount/terms and
--     scope snapshots against immutable BR-04 quote and actual customer evidence;
-- (e) partial acceptance technical feasibility and new quote/version where scope changes;
-- (f) one shared PO can span multiple Job IDs, but no cross-company/customer leakage;
-- (g) expired quotes require Purchase revalidation; supplier quotes revalidated before PO;
-- (h) dispatch uses verified email/WhatsApp provider responses and idempotency;
-- (i) follow-ups are INTERNAL daily tasks; customer messages have separate permission;
-- (j) atomic inventory ledger reservations; BR-05 rechecks are NON-LEDGER snapshots;
--     before COMMITTED reservation recheck live balance for ALL jobs, not just one snapshot;
-- (k) email-value exception policy remains unapproved; log email case separately;
-- (l) 2 working h / 1 working h / 2 working h are configured via BR02 calendars;
-- (m) client has NOT approved actual money tiers, approver names, legal names or calendars;
-- (n) BR05 does not update service_jobs.status with unapproved enum values;
-- (o) quote revision changes happen only in BR-04; BR-05 response, order evidence,
--     supplier approvals and audit records are append-only with controlled amendments;
-- (p) supplier offer revalidations and selected recommendations reference BR-04 IDs;
-- (q) quote-line snapshots must be reconciled with a future BR-04 canonical quote-line
--     model before production; amount and partial scope comparisons are API validated;
-- (r) single global RFQ counter remains in BR-04, no numbering or vendor master in BR-05.
COMMIT;


-- ======================================================================
-- COMPONENT 5: Brightech_BR01_to_BR05_Cross_Module_Integrity_Overlay_Rev01.sql
-- ======================================================================

-- BRIGHTECH | BR-01 to BR-05 | CROSS-MODULE INTEGRITY OVERLAY Rev01
-- STATUS: DEVELOPER PROPOSAL / CLIENT REVIEW / NOT APPROVED
-- USE ONLY IN A NEW EMPTY POSTGRESQL 15+ STAGING DATABASE AFTER:
--   BR02 Rev04 -> BR03 Rev00 -> BR04 Rev00 -> BR05 Rev01.
-- This overlay is NOT an ALTER migration for a populated or live database.
-- Before production: implement true BR01 masters, inventory ledger, DOFA, calendars, roles.
BEGIN;

-- CM-01: BR04 owns the CANONICAL customer-facing quotation lines, one set PER revision.
-- Price semantics: net pre-tax line amount. No assumption on inspection fee/freight
-- inclusion in revised_pre_tax until Brightech confirms its pricing breakdown.
CREATE TABLE br04_customer_quote_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 quote_revision_id uuid NOT NULL REFERENCES br04_customer_quote_revisions(id),
 line_no integer NOT NULL CHECK(line_no>0),
 line_type varchar(24) NOT NULL CHECK(line_type IN
   ('REPAIR_SERVICE','MATERIAL','LABOUR','INSPECTION','TESTING','EXTERNAL','FREIGHT','OTHER')),
 line_description text NOT NULL CHECK(length(btrim(line_description))>0),
 source_estimate_cost_line_id uuid REFERENCES br04_estimate_cost_lines(id),
 quantity numeric(16,4) NOT NULL CHECK(quantity>0),
 uom varchar(18) NOT NULL,
 net_unit_price_pre_tax numeric(18,4) NOT NULL CHECK(net_unit_price_pre_tax>=0),
 net_line_pre_tax numeric(18,2) GENERATED ALWAYS AS
    (round((quantity*net_unit_price_pre_tax)::numeric,2)) STORED,
 scope_technically_indivisible boolean NOT NULL DEFAULT false,
 customer_selectable boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(quote_revision_id,line_no), UNIQUE(quote_revision_id,id)
);
CREATE INDEX br04_quote_line_rev_idx ON br04_customer_quote_lines(quote_revision_id,line_no);

-- Immutable quote lines once quotation has been released; new pricing = new revision.
CREATE OR REPLACE FUNCTION brcm_guard_quote_line_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_rev uuid;
BEGIN
 v_rev:=CASE WHEN TG_OP='DELETE' THEN OLD.quote_revision_id ELSE NEW.quote_revision_id END;
 SELECT quote_status INTO v_status FROM br04_customer_quote_revisions WHERE id=v_rev;
 IF TG_OP='UPDATE' AND NEW.quote_revision_id<>OLD.quote_revision_id THEN
   RAISE EXCEPTION 'BR04: quotation line cannot change source revision';
 END IF;
 IF v_status IS DISTINCT FROM 'DRAFT' THEN
   RAISE EXCEPTION 'BR04: released quotation line is immutable; create quotation revision';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_quote_line_immutability
 BEFORE INSERT OR UPDATE OR DELETE ON br04_customer_quote_lines
 FOR EACH ROW EXECUTE FUNCTION brcm_guard_quote_line_mutation();

-- Release requires genuine lines. Full total reconciliation awaits explicit fee/freight rules.
CREATE OR REPLACE FUNCTION brcm_guard_quote_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_quote br04_customer_quotes%ROWTYPE; v_est br04_estimate_revisions%ROWTYPE;
BEGIN
 SELECT * INTO v_quote FROM br04_customer_quotes WHERE id=NEW.quote_id;
 SELECT * INTO v_est FROM br04_estimate_revisions WHERE id=NEW.estimate_revision_id;
 IF v_quote.id IS NULL OR v_est.id IS NULL OR NOT EXISTS (
   SELECT 1 FROM br04_repair_estimates e
   WHERE e.id=v_quote.estimate_id AND e.id=v_est.estimate_id
   AND e.company_id=v_quote.company_id AND e.job_id=v_quote.job_id
 ) THEN RAISE EXCEPTION 'BR04: quotation revision, estimate and job mismatch'; END IF;
 IF TG_OP='INSERT' AND NEW.quote_status <> 'DRAFT' THEN
   RAISE EXCEPTION 'BR04: create quote revision as DRAFT, add lines, then release';
 END IF;
 IF TG_OP='UPDATE' THEN
   IF OLD.quote_status IN ('SENT','ACCEPTED','REJECTED','EXPIRED','SUPERSEDED')
     AND (to_jsonb(NEW)-'quote_status') IS DISTINCT FROM (to_jsonb(OLD)-'quote_status') THEN
     RAISE EXCEPTION 'BR04: dispatched quotation commercial content is immutable';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_quote_revision_chain
 BEFORE INSERT OR UPDATE ON br04_customer_quote_revisions
 FOR EACH ROW EXECUTE FUNCTION brcm_guard_quote_revision();
CREATE OR REPLACE FUNCTION brcm_guard_quote_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.quote_status IN ('RELEASED_TO_SALES','SENT','ACCEPTED') AND
    NOT EXISTS (SELECT 1 FROM br04_customer_quote_lines WHERE quote_revision_id=NEW.id) THEN
    RAISE EXCEPTION 'BR04: at least one canonical quotation line required before release';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_quote_release_gate
 BEFORE UPDATE OF quote_status ON br04_customer_quote_revisions
 FOR EACH ROW EXECUTE FUNCTION brcm_guard_quote_release();

-- CM-02: BR05 partial acceptance snapshots now link to canonical BR04 quotation lines.
-- For a NEW EMPTY staging install the column is NOT NULL. For a populated database,
-- backfill and reconcile historical snapshots before adding this column/constraint.
ALTER TABLE br05_quote_lines
 ADD COLUMN source_br04_quote_line_id uuid NOT NULL REFERENCES br04_customer_quote_lines(id);
ALTER TABLE br05_quote_lines ALTER COLUMN unit_price_pre_tax TYPE numeric(18,4);
CREATE UNIQUE INDEX brcm_one_br05_snapshot_per_br04_line
 ON br05_quote_lines(quote_revision_id,source_br04_quote_line_id);
CREATE OR REPLACE FUNCTION brcm_guard_br05_quote_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_canonical br04_customer_quote_lines%ROWTYPE; v_br04_rev uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BR05: accepted-scope snapshots may not be deleted'; END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'BR05: quotation snapshots immutable; create new quote revision'; END IF;
 SELECT source_br04_quote_id INTO v_br04_rev
 FROM br05_quote_revision_refs WHERE id=NEW.quote_revision_id;
 SELECT * INTO v_canonical FROM br04_customer_quote_lines
 WHERE id=NEW.source_br04_quote_line_id;
 IF v_canonical.id IS NULL OR v_br04_rev IS NULL
    OR v_canonical.quote_revision_id<>v_br04_rev THEN
   RAISE EXCEPTION 'BR05: quote line belongs to another BR04 revision';
 END IF;
 IF NEW.line_no<>v_canonical.line_no OR NEW.quantity<>v_canonical.quantity
   OR NEW.line_description<>v_canonical.line_description
   OR NEW.uom<>v_canonical.uom OR
   NEW.unit_price_pre_tax<>v_canonical.net_unit_price_pre_tax
   OR NEW.line_amount_pre_tax<>v_canonical.net_line_pre_tax
   OR NEW.scope_technically_indivisible<>v_canonical.scope_technically_indivisible THEN
   RAISE EXCEPTION 'BR05: snapshot disagrees with BR04 canonical quotation line';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_quote_line_snapshot_gate
 BEFORE INSERT OR UPDATE OR DELETE ON br05_quote_lines
 FOR EACH ROW EXECUTE FUNCTION brcm_guard_br05_quote_line();

-- CM-03: Ensure BR03 company_id is owned by the same BR02 Job ID, not merely a UUID.
CREATE OR REPLACE FUNCTION brcm_guard_br03_job_company() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM service_jobs
      WHERE id=NEW.job_id AND company_id=NEW.company_id) THEN
   RAISE EXCEPTION 'BR03: company and job reference mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_br03_custody_job_co BEFORE INSERT OR UPDATE OF company_id,job_id
 ON br03_custody_acknowledgements FOR EACH ROW EXECUTE FUNCTION brcm_guard_br03_job_company();
CREATE TRIGGER brcm_br03_session_job_co BEFORE INSERT OR UPDATE OF company_id,job_id
 ON br03_inspection_sessions FOR EACH ROW EXECUTE FUNCTION brcm_guard_br03_job_company();
CREATE TRIGGER brcm_br03_report_job_co BEFORE INSERT OR UPDATE OF company_id,job_id
 ON br03_inspection_reports FOR EACH ROW EXECUTE FUNCTION brcm_guard_br03_job_company();
CREATE TRIGGER brcm_br03_mat_job_co BEFORE INSERT OR UPDATE OF company_id,job_id
 ON br03_material_requests FOR EACH ROW EXECUTE FUNCTION brcm_guard_br03_job_company();

-- CM-04: BR04 stock records must use SAME job/company/request/version/item.
CREATE OR REPLACE FUNCTION brcm_guard_br04_stock_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_req br03_material_requests%ROWTYPE; v_vers br03_material_request_versions%ROWTYPE;
BEGIN
 SELECT * INTO v_req FROM br03_material_requests WHERE id=NEW.material_request_id;
 SELECT * INTO v_vers FROM br03_material_request_versions WHERE id=NEW.material_request_version_id;
 IF v_req.id IS NULL OR v_req.company_id<>NEW.company_id OR v_req.job_id<>NEW.job_id
   OR v_vers.id IS NULL OR v_vers.request_id<>v_req.id THEN
  RAISE EXCEPTION 'BR04: stock check must match job/company and material request version';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_br04_stock_check_gate BEFORE INSERT OR UPDATE OF
 company_id,job_id,material_request_id,material_request_version_id ON br04_stock_checks
 FOR EACH ROW EXECUTE FUNCTION brcm_guard_br04_stock_check();
CREATE OR REPLACE FUNCTION brcm_guard_br04_stock_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_check br04_stock_checks%ROWTYPE; v_line br03_material_request_lines%ROWTYPE;
BEGIN
 SELECT * INTO v_check FROM br04_stock_checks WHERE id=NEW.stock_check_id;
 SELECT * INTO v_line FROM br03_material_request_lines WHERE id=NEW.material_request_line_id;
 IF v_line.id IS NULL OR v_check.id IS NULL OR v_line.request_id<>v_check.material_request_id
   OR v_line.item_bridge_id<>NEW.item_bridge_id OR v_line.uom_snapshot<>NEW.uom_snapshot THEN
   RAISE EXCEPTION 'BR04: stock line does not match BR03 material requirement item/UOM';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_br04_stock_line_gate BEFORE INSERT OR UPDATE OF
 stock_check_id,material_request_line_id,item_bridge_id,uom_snapshot ON br04_stock_check_lines
 FOR EACH ROW EXECUTE FUNCTION brcm_guard_br04_stock_line();

-- CM-05: Single RFQ may serve multiple jobs ONLY within one company, and for the same item.
CREATE OR REPLACE FUNCTION brcm_guard_rfq_line_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_company uuid; v_rfq_item uuid; v_source_company uuid; v_source_item uuid; v_source_qty numeric;
BEGIN
 SELECT r.company_id, l.item_bridge_id INTO v_company,v_rfq_item
  FROM br04_rfq_lines l JOIN br04_rfqs r ON r.id=l.rfq_id WHERE l.id=NEW.rfq_line_id;
 SELECT s.company_id, cl.item_bridge_id, s.shortage_quantity INTO v_source_company,v_source_item,v_source_qty
  FROM br04_shortage_sources s JOIN br04_stock_check_lines cl ON cl.id=s.stock_check_line_id
  WHERE s.id=NEW.shortage_source_id;
 IF v_company IS NULL OR v_source_company IS NULL OR v_company<>v_source_company
   OR v_rfq_item<>v_source_item OR NEW.demand_quantity>v_source_qty THEN
    RAISE EXCEPTION 'BR04: RFQ source company/item or shortage quantity mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_rfq_source_gate BEFORE INSERT OR UPDATE ON br04_rfq_line_sources
 FOR EACH ROW EXECUTE FUNCTION brcm_guard_rfq_line_source();

-- Comparison row must compare SAME RFQ and SAME RFQ line as source supplier offer.
CREATE OR REPLACE FUNCTION brcm_guard_comparison_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_rfq uuid; v_source_rfq uuid; v_offer_rfq_line uuid;
BEGIN
 SELECT rfq_id INTO v_rfq FROM br04_comparison_runs WHERE id=NEW.comparison_id;
 SELECT ol.rfq_line_id,r.rfq_id INTO v_offer_rfq_line,v_source_rfq
 FROM br04_supplier_offer_lines ol
 JOIN br04_supplier_offer_versions ov ON ov.id=ol.offer_version_id
 JOIN br04_supplier_offer_headers oh ON oh.id=ov.offer_header_id
 JOIN br04_rfqs r ON r.id=oh.rfq_id
 WHERE ol.id=NEW.offer_line_id;
 IF v_rfq IS NULL OR v_source_rfq IS NULL OR v_rfq<>v_source_rfq
   OR NEW.rfq_line_id<>v_offer_rfq_line THEN
   RAISE EXCEPTION 'BR04: comparison offer line/RFQ mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_comparison_row_gate BEFORE INSERT OR UPDATE ON br04_comparison_rows
 FOR EACH ROW EXECUTE FUNCTION brcm_guard_comparison_row();

-- Check quote job/company matches the parent repair estimate on document creation.
CREATE OR REPLACE FUNCTION brcm_guard_customer_quote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_co uuid; v_job uuid;
BEGIN
 SELECT company_id,job_id INTO v_co,v_job FROM br04_repair_estimates WHERE id=NEW.estimate_id;
 IF v_co IS NULL OR v_co<>NEW.company_id OR v_job<>NEW.job_id THEN
  RAISE EXCEPTION 'BR04: customer quote, estimate and job mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_quote_job_gate BEFORE INSERT OR UPDATE OF company_id,job_id,estimate_id
 ON br04_customer_quotes FOR EACH ROW EXECUTE FUNCTION brcm_guard_customer_quote();

-- CM-06: RFQ numbers allocated only from one global atomic counter; no supplied manual RFQ sequence.
CREATE OR REPLACE FUNCTION br04_alloc_rfq_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.rfq_seq IS NOT NULL THEN
   RAISE EXCEPTION 'BR04: RFQ sequence must be system-generated, not manually supplied';
 END IF;
 UPDATE br04_global_number_counters SET last_number=last_number+1,updated_at=now()
  WHERE number_kind='RFQ' RETURNING last_number INTO NEW.rfq_seq;
 IF NEW.rfq_seq IS NULL THEN RAISE EXCEPTION 'BR04: global counter not initialised'; END IF;
 RETURN NEW;
END $$;

-- CM-07: Existing Rev01 trigger did not fire for status-only re-activation.
-- Only a return to ACTIVE AUTHORISED status is checked; suspend/cancel still works.
CREATE OR REPLACE FUNCTION brcm_guard_auth_reactivation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_allocation br05_order_job_allocations%ROWTYPE;
        v_order br05_customer_orders%ROWTYPE;
BEGIN
 IF NOT (NEW.authorisation_status='AUTHORISED' AND NEW.is_current) THEN RETURN NEW; END IF;
 SELECT * INTO v_allocation FROM br05_order_job_allocations WHERE id=NEW.order_job_allocation_id;
 SELECT * INTO v_order FROM br05_customer_orders WHERE id=v_allocation.order_id;
 IF v_allocation.id IS NULL OR v_allocation.allocation_status<>'VERIFIED'
   OR v_allocation.company_id<>NEW.company_id OR v_allocation.job_id<>NEW.job_id
   OR v_order.id IS NULL OR v_order.order_status<>'VERIFIED' THEN
   RAISE EXCEPTION 'BR05: cannot reactivate authorisation without verified customer order';
 END IF;
 IF EXISTS(SELECT 1 FROM br05_order_discrepancies d WHERE d.order_id=v_order.id
  AND d.affects_release AND d.discrepancy_status='OPEN'
  AND (d.job_allocation_id IS NULL OR d.job_allocation_id=v_allocation.id)) THEN
  RAISE EXCEPTION 'BR05: unresolved order discrepancy prevents reactivation';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_authorisation_reactivate_gate BEFORE UPDATE OF authorisation_status,is_current
 ON br05_job_authorisations FOR EACH ROW EXECUTE FUNCTION brcm_guard_auth_reactivation();

-- Release status cannot silently change from cancelled/held back to RELEASED.
CREATE OR REPLACE FUNCTION brcm_guard_release_reactivation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.release_status<>'RELEASED' THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM br05_job_authorisations a
  JOIN br05_stock_rechecks s ON s.id=NEW.stock_recheck_id
  WHERE a.id=NEW.job_authorisation_id AND a.company_id=NEW.company_id
   AND a.job_id=NEW.job_id AND a.authorisation_status='AUTHORISED' AND a.is_current
   AND s.job_authorisation_id=a.id AND s.company_id=a.company_id
   AND s.job_id=a.job_id AND s.is_current) THEN
    RAISE EXCEPTION 'BR05: cannot re-release without current authorisation and recheck';
 END IF;
 IF EXISTS(SELECT 1 FROM br05_job_holds h WHERE h.job_id=NEW.job_id
  AND h.is_blocking AND h.ended_at IS NULL) THEN
  RAISE EXCEPTION 'BR05: blocking hold prevents release';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_release_reactivate_gate BEFORE UPDATE OF release_status,stock_recheck_id,job_authorisation_id
 ON br05_job_releases FOR EACH ROW EXECUTE FUNCTION brcm_guard_release_reactivation();

-- CM-08: authorised procurement intent cannot use expired/unrevalidated supplier offer.
CREATE OR REPLACE FUNCTION brcm_guard_supplier_po_offer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_valid boolean;
BEGIN
 IF NEW.status<>'AUTHORISED_FOR_BR06' THEN RETURN NEW; END IF;
 SELECT EXISTS(SELECT 1 FROM br05_supplier_revalidations sv
  WHERE sv.company_id=NEW.company_id AND sv.job_id=NEW.job_id
    AND sv.source_br04_offer_line_id=NEW.source_br04_offer_line_id
    AND sv.revalidation_status IN ('VALID','RECONFIRMED')
    AND (sv.quoted_valid_until IS NULL OR sv.quoted_valid_until>=CURRENT_DATE)
 ) INTO v_valid;
 IF NOT v_valid THEN
  RAISE EXCEPTION 'BR05: supplier quotation must be revalidated before procurement eligibility';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brcm_po_offer_revalidation_gate BEFORE INSERT OR UPDATE OF status,source_br04_offer_line_id
 ON br05_supplier_po_release_intents FOR EACH ROW EXECUTE FUNCTION brcm_guard_supplier_po_offer();

-- CM-09: audit-only preserved RFQ versions, without destroying BR04 current header.
CREATE TABLE br04_rfq_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 rfq_id uuid NOT NULL REFERENCES br04_rfqs(id),
 version_no integer NOT NULL CHECK(version_no>=1),
 content_snapshot jsonb NOT NULL CHECK(jsonb_typeof(content_snapshot)='object'),
 revision_reason text,
 issued_at timestamptz,
 recorded_by_id uuid NOT NULL REFERENCES employees(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(rfq_id,version_no)
);
CREATE OR REPLACE FUNCTION brcm_guard_rfq_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'BR04: RFQ version history is immutable';
END $$;
CREATE TRIGGER brcm_rfq_version_no_mutation BEFORE UPDATE OR DELETE ON br04_rfq_versions
 FOR EACH ROW EXECUTE FUNCTION brcm_guard_rfq_version_immutable();

-- BUSINESS DECISIONS STILL PENDING, NOT ENFORCED AS FALSE DEFAULTS:
-- (a) BR01 canonical Item/Supplier/Customer Contacts/Manufacturer master integration;
-- (b) authoritative warehouse inventory ledger, reservation/issue/consumption posting;
-- (c) labour rates, supplier PO financial DOFA, MD role mapping, company calendars;
-- (d) quotation-line total composition incl. inspection fee and freight;
-- (e) email authorisation monetary ceiling, quotation expiry exceptions and SLA holds.
COMMIT;

