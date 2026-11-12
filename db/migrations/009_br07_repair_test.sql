-- 009_br07_repair_test.sql
--
-- BR-07 (material issue -> engineer material custody ack -> time-tracked repair
-- session -> versioned repair report -> test runs + test-start SLA -> two-fail
-- Purchase review -> technical handoff -> Purchase dispatch release; plus
-- consumption and unused-material return) has NO draft schema in 001 or 003 --
-- confirmed by grep before writing this file. Like 008, this is a NEW schema
-- designed against CLAUDE.md + the BR-07 operator brief only. Nothing here is
-- client-approved; it follows the reviewed modules' conventions (company
-- scoping via composite FKs, append-only history, DB-enforced ownership,
-- single-writer inventory posting).
--
-- Single-writer rule: this migration writes NO inventory balances. Physical
-- movements (ISSUE / CONSUME / RETURN) are posted by the API through
-- InventoryService -> fdn_post_movement. The *_movement_ref columns only record
-- the journal id the ledger returned.
--
-- Test-start SLA: targets (NORMAL 1 working day / URGENT 4 working hours /
-- CRITICAL 2 working hours) are stored as data in br07_test_sla_targets. Working
-- calendars are an UNCONFIRMED CLAUDE.md section 5 blocker, so NO due date is
-- computed anywhere: sla_instances.due_at is left NULL (same honest handling as
-- the BR-03 edit-lock). A follow-up migration must add the working-time
-- arithmetic once a calendar is approved.
--
-- Deliberately NOT touched: service_jobs.status. Its CHECK enum has no approved
-- repair/test/dispatch values (same reasoning as BR-05's release).

-- ==============================================================================
-- Shared helpers
CREATE OR REPLACE FUNCTION br07_is_purchase(p_company uuid, p_employee uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM employees
                  WHERE id=p_employee AND company_id=p_company AND is_active AND role_code='PURCHASE');
$$;

-- ==============================================================================
-- br07_material_issues | MAIN_STORE -> ENGINEER_HELD against exactly one
-- COMMITTED BR-05 reservation of a RELEASED job. One issue per reservation; the
-- issue converts the whole reservation (the ledger cannot partially decrement a
-- reservation). Running counters are maintained ONLY by the consumption/return
-- triggers below, under row lock, and capped by a CHECK.
CREATE TABLE br07_material_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  job_id uuid NOT NULL,
  br05_job_release_id uuid NOT NULL,
  br05_material_reservation_id uuid NOT NULL UNIQUE REFERENCES br05_material_reservations(id),
  inventory_reservation_id uuid NOT NULL UNIQUE REFERENCES fdn_inventory_reservations(id),
  item_bridge_id uuid NOT NULL REFERENCES br03_item_catalog_bridge(id),
  item_id uuid NOT NULL REFERENCES fdn_item_master(id),
  uom varchar(16) NOT NULL,
  issued_quantity numeric(16,4) NOT NULL CHECK (issued_quantity > 0),
  consumed_quantity numeric(16,4) NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0),
  returned_quantity numeric(16,4) NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  return_pending_quantity numeric(16,4) NOT NULL DEFAULT 0 CHECK (return_pending_quantity >= 0),
  issued_to_engineer_id uuid NOT NULL,
  assignment_id uuid NOT NULL REFERENCES job_assignments(id),
  from_location_id uuid NOT NULL,
  to_location_id uuid NOT NULL,
  issue_status varchar(16) NOT NULL DEFAULT 'PENDING_POST'
    CHECK (issue_status IN ('PENDING_POST','ISSUED','ACKNOWLEDGED')),
  issue_movement_ref uuid REFERENCES fdn_inventory_journal(id),
  issued_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  acknowledged_by_id uuid,
  acknowledged_at timestamptz,
  acknowledgement_note text,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, br05_job_release_id) REFERENCES br05_job_releases(company_id, id),
  FOREIGN KEY (company_id, issued_to_engineer_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, issued_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, acknowledged_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, from_location_id) REFERENCES fdn_inventory_locations(company_id, id),
  FOREIGN KEY (company_id, to_location_id) REFERENCES fdn_inventory_locations(company_id, id),
  CHECK (consumed_quantity + returned_quantity + return_pending_quantity <= issued_quantity),
  CHECK (issue_status = 'PENDING_POST' OR (issue_movement_ref IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (issue_status <> 'ACKNOWLEDGED' OR (acknowledged_at IS NOT NULL AND acknowledged_by_id IS NOT NULL)),
  CHECK (acknowledged_by_id IS NULL OR acknowledged_by_id = issued_to_engineer_id)
);
CREATE INDEX idx_br07_issue_job ON br07_material_issues(job_id, issue_status);

CREATE OR REPLACE FUNCTION br07_guard_material_issue()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r br05_material_reservations%ROWTYPE;
        rel br05_job_releases%ROWTYPE;
        fr fdn_inventory_reservations%ROWTYPE;
        v_line_bridge uuid; v_bridge_item uuid; v_from_role text; v_to_role text;
BEGIN
  SELECT * INTO r FROM br05_material_reservations WHERE id=NEW.br05_material_reservation_id FOR UPDATE;
  IF NOT FOUND OR r.company_id<>NEW.company_id OR r.job_id<>NEW.job_id THEN
    RAISE EXCEPTION 'BR07: reservation does not belong to this job/company';
  END IF;
  IF r.reservation_status<>'COMMITTED' THEN
    RAISE EXCEPTION 'BR07: material issue requires a COMMITTED BR-05 reservation (this one is %)', r.reservation_status;
  END IF;
  SELECT * INTO rel FROM br05_job_releases WHERE id=r.job_release_id;
  IF NOT FOUND OR rel.release_status<>'RELEASED' THEN
    RAISE EXCEPTION 'BR07: material issue requires a RELEASED BR-05 job release';
  END IF;
  IF NEW.br05_job_release_id<>r.job_release_id THEN
    RAISE EXCEPTION 'BR07: issue job release does not match the reservation''s job release';
  END IF;

  SELECT * INTO fr FROM fdn_inventory_reservations WHERE id=r.inventory_reservation_ref::uuid FOR UPDATE;
  IF NOT FOUND OR fr.id<>NEW.inventory_reservation_id OR fr.company_id<>NEW.company_id THEN
    RAISE EXCEPTION 'BR07: ledger reservation missing or mismatched for this BR-05 reservation';
  END IF;
  IF fr.status<>'ACTIVE' THEN
    RAISE EXCEPTION 'BR07: ledger reservation is % (must be ACTIVE to issue)', fr.status;
  END IF;
  IF fr.item_id<>NEW.item_id THEN RAISE EXCEPTION 'BR07: ledger reservation item mismatch'; END IF;
  IF NEW.issued_quantity<>r.reserved_quantity OR NEW.issued_quantity<>fr.qty THEN
    RAISE EXCEPTION 'BR07: issue quantity must equal the committed reservation quantity (%)', r.reserved_quantity;
  END IF;

  SELECT item_bridge_id INTO v_line_bridge FROM br05_stock_recheck_lines WHERE id=r.stock_recheck_line_id;
  IF v_line_bridge IS DISTINCT FROM NEW.item_bridge_id THEN RAISE EXCEPTION 'BR07: item bridge mismatch'; END IF;
  SELECT br01_item_id INTO v_bridge_item FROM br03_item_catalog_bridge WHERE id=NEW.item_bridge_id;
  IF v_bridge_item IS DISTINCT FROM NEW.item_id THEN RAISE EXCEPTION 'BR07: item bridge does not map to this item'; END IF;

  IF NOT br03_is_current_accepted_engineer(NEW.job_id, NEW.issued_to_engineer_id) THEN
    RAISE EXCEPTION 'BR07: material can only be issued to the current accepted engineer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM job_assignments WHERE id=NEW.assignment_id AND job_id=NEW.job_id
                    AND engineer_id=NEW.issued_to_engineer_id AND is_current AND response='ACCEPTED') THEN
    RAISE EXCEPTION 'BR07: assignment is not the current accepted assignment';
  END IF;

  SELECT role INTO v_from_role FROM fdn_inventory_locations WHERE id=NEW.from_location_id;
  SELECT role INTO v_to_role FROM fdn_inventory_locations WHERE id=NEW.to_location_id;
  IF v_from_role<>'MAIN_STORE' OR v_to_role<>'ENGINEER_HELD' THEN
    RAISE EXCEPTION 'BR07: material issue must move MAIN_STORE -> ENGINEER_HELD';
  END IF;
  IF EXISTS (SELECT 1 FROM br07_dispatch_releases WHERE job_id=NEW.job_id) THEN
    RAISE EXCEPTION 'BR07: job already dispatch-released';
  END IF;
  RETURN NEW;
END $$;

-- Identity fields frozen; status only moves forward; counters may only be
-- changed by the consumption/return triggers (they run as nested UPDATEs and
-- are covered by the CHECK cap).
CREATE OR REPLACE FUNCTION br07_issue_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id<>OLD.company_id OR NEW.job_id<>OLD.job_id
     OR NEW.br05_material_reservation_id<>OLD.br05_material_reservation_id
     OR NEW.inventory_reservation_id<>OLD.inventory_reservation_id
     OR NEW.item_id<>OLD.item_id OR NEW.item_bridge_id<>OLD.item_bridge_id
     OR NEW.issued_quantity<>OLD.issued_quantity OR NEW.uom<>OLD.uom
     OR NEW.issued_to_engineer_id<>OLD.issued_to_engineer_id OR NEW.assignment_id<>OLD.assignment_id
     OR NEW.from_location_id<>OLD.from_location_id OR NEW.to_location_id<>OLD.to_location_id
     OR NEW.issued_by_id<>OLD.issued_by_id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'BR07: material issue identity fields are immutable';
  END IF;
  IF (NEW.consumed_quantity<>OLD.consumed_quantity OR NEW.returned_quantity<>OLD.returned_quantity
      OR NEW.return_pending_quantity<>OLD.return_pending_quantity) AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'BR07: issue quantity counters are maintained only by consumption/return records';
  END IF;
  IF OLD.issue_movement_ref IS NOT NULL AND NEW.issue_movement_ref IS DISTINCT FROM OLD.issue_movement_ref THEN
    RAISE EXCEPTION 'BR07: issue movement reference is immutable once posted';
  END IF;
  IF NEW.issue_status<>OLD.issue_status AND NOT (
       (OLD.issue_status='PENDING_POST' AND NEW.issue_status='ISSUED')
    OR (OLD.issue_status='ISSUED' AND NEW.issue_status='ACKNOWLEDGED')) THEN
    RAISE EXCEPTION 'BR07: illegal issue status transition % -> %', OLD.issue_status, NEW.issue_status;
  END IF;
  RETURN NEW;
END $$;

-- ==============================================================================
-- Repair sessions + time segments (mirrors BR-03 inspection sessions)
CREATE TABLE br07_repair_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  job_id uuid NOT NULL,
  assignment_id uuid NOT NULL REFERENCES job_assignments(id),
  engineer_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status varchar(12) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','COMPLETED')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, engineer_id) REFERENCES employees(company_id, id),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX br07_one_open_repair_session_per_job ON br07_repair_sessions(job_id)
  WHERE status IN ('ACTIVE','PAUSED');

CREATE TABLE br07_repair_time_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES br07_repair_sessions(id),
  segment_type varchar(12) NOT NULL CHECK (segment_type IN ('ACTIVE','PAUSED')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  pause_reason text,
  pause_category varchar(32),
  is_active_time boolean NOT NULL,
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (segment_type <> 'PAUSED' OR NULLIF(btrim(pause_reason),'') IS NOT NULL),
  CHECK (is_active_time = (segment_type = 'ACTIVE'))
);
CREATE UNIQUE INDEX br07_one_open_repair_segment ON br07_repair_time_segments(session_id) WHERE ended_at IS NULL;

CREATE OR REPLACE VIEW br07_v_repair_time_totals AS
SELECT s.job_id, s.engineer_id, s.id AS session_id, s.status,
       COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(t.ended_at, now()) - t.started_at)))
                FILTER (WHERE t.is_active_time), 0)::bigint AS active_seconds,
       COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(t.ended_at, now()) - t.started_at)))
                FILTER (WHERE NOT t.is_active_time), 0)::bigint AS paused_seconds
  FROM br07_repair_sessions s
  LEFT JOIN br07_repair_time_segments t ON t.session_id = s.id
 GROUP BY s.job_id, s.engineer_id, s.id, s.status;

-- ==============================================================================
-- Consumption: ENGINEER_HELD -> CONSUMED, by the engineer the material was
-- issued to, against an ACKNOWLEDGED issue. The trigger takes the quantity
-- headroom on the issue row (row-locked) before the ledger post.
CREATE TABLE br07_material_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  job_id uuid NOT NULL,
  issue_id uuid NOT NULL REFERENCES br07_material_issues(id),
  repair_session_id uuid REFERENCES br07_repair_sessions(id),
  quantity numeric(16,4) NOT NULL CHECK (quantity > 0),
  consumed_by_id uuid NOT NULL,
  note text,
  consumption_status varchar(14) NOT NULL DEFAULT 'PENDING_POST'
    CHECK (consumption_status IN ('PENDING_POST','POSTED')),
  movement_ref uuid REFERENCES fdn_inventory_journal(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  FOREIGN KEY (company_id, job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, consumed_by_id) REFERENCES employees(company_id, id),
  CHECK (consumption_status = 'PENDING_POST' OR (movement_ref IS NOT NULL AND posted_at IS NOT NULL))
);
CREATE INDEX idx_br07_consumption_issue ON br07_material_consumptions(issue_id);

CREATE OR REPLACE FUNCTION br07_guard_consumption()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i br07_material_issues%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO i FROM br07_material_issues WHERE id=NEW.issue_id FOR UPDATE;
    IF NOT FOUND OR i.company_id<>NEW.company_id OR i.job_id<>NEW.job_id THEN
      RAISE EXCEPTION 'BR07: consumption issue does not belong to this job/company';
    END IF;
    IF i.issue_status<>'ACKNOWLEDGED' THEN
      RAISE EXCEPTION 'BR07: engineer must acknowledge custody of issued material before consuming it';
    END IF;
    IF NEW.consumed_by_id<>i.issued_to_engineer_id
       OR NOT br03_is_current_accepted_engineer(NEW.job_id, NEW.consumed_by_id) THEN
      RAISE EXCEPTION 'BR07: only the current accepted engineer holding this material can consume it';
    END IF;
    IF NEW.repair_session_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM br07_repair_sessions WHERE id=NEW.repair_session_id AND job_id=NEW.job_id) THEN
      RAISE EXCEPTION 'BR07: repair session does not belong to this job';
    END IF;
    IF i.consumed_quantity + i.returned_quantity + i.return_pending_quantity + NEW.quantity > i.issued_quantity THEN
      RAISE EXCEPTION 'BR07: consumption exceeds engineer-held quantity remaining on this issue (% left)',
        i.issued_quantity - i.consumed_quantity - i.returned_quantity - i.return_pending_quantity;
    END IF;
    UPDATE br07_material_issues SET consumed_quantity = consumed_quantity + NEW.quantity WHERE id=i.id;
    RETURN NEW;
  END IF;
  -- UPDATE: only PENDING_POST -> POSTED with movement ref; nothing else changes
  IF NEW.issue_id<>OLD.issue_id OR NEW.quantity<>OLD.quantity OR NEW.consumed_by_id<>OLD.consumed_by_id
     OR NEW.job_id<>OLD.job_id OR NEW.company_id<>OLD.company_id THEN
    RAISE EXCEPTION 'BR07: consumption identity fields are immutable';
  END IF;
  IF OLD.consumption_status='POSTED' AND (NEW.consumption_status<>'POSTED' OR NEW.movement_ref IS DISTINCT FROM OLD.movement_ref) THEN
    RAISE EXCEPTION 'BR07: a posted consumption is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br07_consumption_ins BEFORE INSERT ON br07_material_consumptions
  FOR EACH ROW EXECUTE FUNCTION br07_guard_consumption();
CREATE TRIGGER trg_br07_consumption_upd BEFORE UPDATE ON br07_material_consumptions
  FOR EACH ROW EXECUTE FUNCTION br07_guard_consumption();
CREATE TRIGGER trg_br07_consumption_nodelete BEFORE DELETE ON br07_material_consumptions
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- ==============================================================================
-- Unused return: engineer requests (REQUESTED holds the quantity as
-- return_pending), Purchase verifies (VERIFIED -> ledger RETURN
-- ENGINEER_HELD -> MAIN_STORE) or rejects (headroom released, stays held).
CREATE TABLE br07_material_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  job_id uuid NOT NULL,
  issue_id uuid NOT NULL REFERENCES br07_material_issues(id),
  quantity numeric(16,4) NOT NULL CHECK (quantity > 0),
  return_reason text,
  requested_by_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  return_status varchar(12) NOT NULL DEFAULT 'REQUESTED'
    CHECK (return_status IN ('REQUESTED','VERIFIED','REJECTED')),
  verified_by_id uuid,
  verified_at timestamptz,
  verification_note text,
  movement_ref uuid REFERENCES fdn_inventory_journal(id),
  posted_at timestamptz,
  FOREIGN KEY (company_id, job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, requested_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, verified_by_id) REFERENCES employees(company_id, id),
  CHECK (return_status = 'REQUESTED' OR (verified_by_id IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK (movement_ref IS NULL OR (return_status = 'VERIFIED' AND posted_at IS NOT NULL)),
  CHECK (verified_by_id IS NULL OR verified_by_id <> requested_by_id)
);
CREATE INDEX idx_br07_return_issue ON br07_material_returns(issue_id, return_status);

CREATE OR REPLACE FUNCTION br07_guard_return()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i br07_material_issues%ROWTYPE;
BEGIN
  SELECT * INTO i FROM br07_material_issues WHERE id=NEW.issue_id FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    IF NOT FOUND OR i.company_id<>NEW.company_id OR i.job_id<>NEW.job_id THEN
      RAISE EXCEPTION 'BR07: return issue does not belong to this job/company';
    END IF;
    IF i.issue_status<>'ACKNOWLEDGED' THEN
      RAISE EXCEPTION 'BR07: engineer must acknowledge custody of issued material before returning it';
    END IF;
    IF NEW.requested_by_id<>i.issued_to_engineer_id THEN
      RAISE EXCEPTION 'BR07: only the engineer holding this material can request its return';
    END IF;
    IF NEW.return_status<>'REQUESTED' THEN RAISE EXCEPTION 'BR07: a return starts as REQUESTED'; END IF;
    IF i.consumed_quantity + i.returned_quantity + i.return_pending_quantity + NEW.quantity > i.issued_quantity THEN
      RAISE EXCEPTION 'BR07: return exceeds engineer-held quantity remaining on this issue (% left)',
        i.issued_quantity - i.consumed_quantity - i.returned_quantity - i.return_pending_quantity;
    END IF;
    UPDATE br07_material_issues SET return_pending_quantity = return_pending_quantity + NEW.quantity WHERE id=i.id;
    RETURN NEW;
  END IF;

  IF NEW.issue_id<>OLD.issue_id OR NEW.quantity<>OLD.quantity OR NEW.requested_by_id<>OLD.requested_by_id
     OR NEW.job_id<>OLD.job_id OR NEW.company_id<>OLD.company_id THEN
    RAISE EXCEPTION 'BR07: return identity fields are immutable';
  END IF;
  IF NEW.return_status<>OLD.return_status THEN
    IF OLD.return_status<>'REQUESTED' THEN
      RAISE EXCEPTION 'BR07: return already %', OLD.return_status;
    END IF;
    IF NOT br07_is_purchase(NEW.company_id, NEW.verified_by_id) THEN
      RAISE EXCEPTION 'BR07: only Purchase can verify or reject an unused-material return';
    END IF;
    IF NEW.return_status='VERIFIED' THEN
      UPDATE br07_material_issues
         SET return_pending_quantity = return_pending_quantity - NEW.quantity,
             returned_quantity = returned_quantity + NEW.quantity
       WHERE id=i.id;
    ELSE
      UPDATE br07_material_issues SET return_pending_quantity = return_pending_quantity - NEW.quantity WHERE id=i.id;
    END IF;
  END IF;
  IF OLD.movement_ref IS NOT NULL AND NEW.movement_ref IS DISTINCT FROM OLD.movement_ref THEN
    RAISE EXCEPTION 'BR07: return movement reference is immutable once posted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br07_return_ins BEFORE INSERT ON br07_material_returns
  FOR EACH ROW EXECUTE FUNCTION br07_guard_return();
CREATE TRIGGER trg_br07_return_upd BEFORE UPDATE ON br07_material_returns
  FOR EACH ROW EXECUTE FUNCTION br07_guard_return();
CREATE TRIGGER trg_br07_return_nodelete BEFORE DELETE ON br07_material_returns
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- ==============================================================================
-- Repair report: stable identity per job + append-only versions.
CREATE TABLE br07_repair_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  job_id uuid NOT NULL UNIQUE,
  engineer_id uuid NOT NULL,
  current_version_no integer NOT NULL DEFAULT 0 CHECK (current_version_no >= 0),
  status varchar(12) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, engineer_id) REFERENCES employees(company_id, id)
);

CREATE TABLE br07_repair_report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES br07_repair_reports(id),
  version_no integer NOT NULL CHECK (version_no >= 1),
  engineer_id uuid NOT NULL REFERENCES employees(id),
  assignment_id uuid NOT NULL REFERENCES job_assignments(id),
  work_performed text NOT NULL CHECK (NULLIF(btrim(work_performed),'') IS NOT NULL),
  root_cause text,
  parts_replaced_summary text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, version_no)
);

CREATE OR REPLACE FUNCTION br07_guard_repair_report_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rep br07_repair_reports%ROWTYPE;
BEGIN
  SELECT * INTO rep FROM br07_repair_reports WHERE id=NEW.report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BR07: missing repair report'; END IF;
  IF NOT br03_is_current_accepted_engineer(rep.job_id, NEW.engineer_id) THEN
    RAISE EXCEPTION 'BR07: current accepted engineer required';
  END IF;
  IF NEW.version_no <> rep.current_version_no + 1 THEN
    RAISE EXCEPTION 'BR07: repair report version must be %', rep.current_version_no + 1;
  END IF;
  IF EXISTS (SELECT 1 FROM br07_repair_sessions WHERE job_id=rep.job_id AND status IN ('ACTIVE','PAUSED')) THEN
    RAISE EXCEPTION 'BR07: stop the open repair session before submitting the repair report';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM br07_repair_sessions WHERE job_id=rep.job_id AND engineer_id=NEW.engineer_id
                    AND status='COMPLETED') THEN
    RAISE EXCEPTION 'BR07: a completed repair session by this engineer is required before a repair report';
  END IF;
  IF EXISTS (SELECT 1 FROM br07_test_runs WHERE job_id=rep.job_id AND result IS NULL) THEN
    RAISE EXCEPTION 'BR07: record the open test run result before submitting a new repair report version';
  END IF;
  IF EXISTS (SELECT 1 FROM br07_dispatch_releases WHERE job_id=rep.job_id) THEN
    RAISE EXCEPTION 'BR07: job already dispatch-released';
  END IF;
  RETURN NEW;
END $$;

-- ==============================================================================
-- Test-start SLA targets: the stated rules, as data. Deliberately NOT expressed
-- as minutes: a "working day" has no minute value until the working calendar
-- (start/end hours) is approved.
CREATE TABLE br07_test_sla_targets (
  priority varchar(12) PRIMARY KEY CHECK (priority IN ('NORMAL','URGENT','CRITICAL')),
  target_amount integer NOT NULL CHECK (target_amount > 0),
  target_unit varchar(14) NOT NULL CHECK (target_unit IN ('WORKING_DAY','WORKING_HOUR')),
  event_code varchar(50) NOT NULL DEFAULT 'BR07_TEST_START'
);
INSERT INTO br07_test_sla_targets(priority, target_amount, target_unit) VALUES
  ('NORMAL', 1, 'WORKING_DAY'),
  ('URGENT', 4, 'WORKING_HOUR'),
  ('CRITICAL', 2, 'WORKING_HOUR');

-- ==============================================================================
-- Test runs: one cycle per row, numbered by the DB. A recorded result is
-- immutable -- nobody (engineer included) can turn a FAIL into a PASS.
CREATE TABLE br07_test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  job_id uuid NOT NULL,
  repair_report_version_id uuid NOT NULL REFERENCES br07_repair_report_versions(id),
  cycle_no integer NOT NULL CHECK (cycle_no > 0),
  engineer_id uuid NOT NULL,
  assignment_id uuid NOT NULL REFERENCES job_assignments(id),
  test_procedure text NOT NULL CHECK (NULLIF(btrim(test_procedure),'') IS NOT NULL),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  result varchar(4) CHECK (result IN ('PASS','FAIL')),
  observations text,
  result_recorded_by_id uuid,
  sla_instance_id uuid REFERENCES sla_instances(id),
  UNIQUE (company_id, id),
  UNIQUE (job_id, cycle_no),
  FOREIGN KEY (company_id, job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, engineer_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, result_recorded_by_id) REFERENCES employees(company_id, id),
  CHECK ((result IS NULL) = (completed_at IS NULL)),
  CHECK ((result IS NULL) = (result_recorded_by_id IS NULL)),
  CHECK (result_recorded_by_id IS NULL OR result_recorded_by_id = engineer_id),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);
CREATE UNIQUE INDEX br07_one_open_test_run_per_job ON br07_test_runs(job_id) WHERE result IS NULL;

-- Purchase failure reviews (two-fail rule). One per reviewed FAIL run.
CREATE TABLE br07_test_failure_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  job_id uuid NOT NULL,
  reviewed_test_run_id uuid NOT NULL UNIQUE REFERENCES br07_test_runs(id),
  failed_cycles_at_review integer NOT NULL CHECK (failed_cycles_at_review >= 2),
  decision varchar(10) NOT NULL CHECK (decision IN ('CONTINUE','STOP')),
  review_comment text NOT NULL CHECK (NULLIF(btrim(review_comment),'') IS NOT NULL),
  reviewed_by_id uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, reviewed_by_id) REFERENCES employees(company_id, id)
);

-- TRUE when the job has >=2 failed cycles, the latest completed cycle is a
-- FAIL, and no Purchase review covers that latest FAIL yet.
CREATE OR REPLACE FUNCTION br07_failure_review_pending(p_job uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH last AS (
    SELECT id, result FROM br07_test_runs
     WHERE job_id=p_job AND result IS NOT NULL ORDER BY cycle_no DESC LIMIT 1)
  SELECT COALESCE((SELECT result='FAIL' FROM last), false)
     AND (SELECT count(*) FROM br07_test_runs WHERE job_id=p_job AND result='FAIL') >= 2
     AND NOT EXISTS (SELECT 1 FROM br07_test_failure_reviews r JOIN last ON r.reviewed_test_run_id=last.id);
$$;

CREATE OR REPLACE FUNCTION br07_testing_stopped(p_job uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM br07_test_failure_reviews WHERE job_id=p_job AND decision='STOP');
$$;

CREATE OR REPLACE FUNCTION br07_guard_test_run()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_report_job uuid; v_current_no integer; v_version_no integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br03_is_current_accepted_engineer(NEW.job_id, NEW.engineer_id) THEN
      RAISE EXCEPTION 'BR07: current accepted engineer required to start a test run';
    END IF;
    SELECT r.job_id, r.current_version_no, v.version_no INTO v_report_job, v_current_no, v_version_no
      FROM br07_repair_report_versions v JOIN br07_repair_reports r ON r.id=v.report_id
     WHERE v.id=NEW.repair_report_version_id;
    IF v_report_job IS DISTINCT FROM NEW.job_id THEN
      RAISE EXCEPTION 'BR07: repair report version does not belong to this job';
    END IF;
    IF v_version_no<>v_current_no THEN
      RAISE EXCEPTION 'BR07: test runs must be against the latest repair report version (v%)', v_current_no;
    END IF;
    IF EXISTS (SELECT 1 FROM br07_repair_sessions WHERE job_id=NEW.job_id AND status IN ('ACTIVE','PAUSED')) THEN
      RAISE EXCEPTION 'BR07: stop the open repair session before testing';
    END IF;
    IF br07_testing_stopped(NEW.job_id) THEN
      RAISE EXCEPTION 'BR07: Purchase review decided STOP; no further test cycles allowed';
    END IF;
    IF br07_failure_review_pending(NEW.job_id) THEN
      RAISE EXCEPTION 'BR07: 2+ failed test cycles -- a recorded Purchase review of the latest failure is required before another test cycle';
    END IF;
    IF EXISTS (SELECT 1 FROM br07_dispatch_releases WHERE job_id=NEW.job_id) THEN
      RAISE EXCEPTION 'BR07: job already dispatch-released';
    END IF;
    -- DB owns cycle numbering; caller-supplied values are overwritten.
    PERFORM 1 FROM service_jobs WHERE id=NEW.job_id FOR UPDATE;
    SELECT COALESCE(max(cycle_no),0)+1 INTO NEW.cycle_no FROM br07_test_runs WHERE job_id=NEW.job_id;
    IF NEW.result IS NOT NULL THEN RAISE EXCEPTION 'BR07: a test run starts without a result'; END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.company_id<>OLD.company_id OR NEW.job_id<>OLD.job_id OR NEW.cycle_no<>OLD.cycle_no
     OR NEW.repair_report_version_id<>OLD.repair_report_version_id OR NEW.engineer_id<>OLD.engineer_id
     OR NEW.assignment_id<>OLD.assignment_id OR NEW.test_procedure<>OLD.test_procedure
     OR NEW.started_at<>OLD.started_at OR NEW.sla_instance_id IS DISTINCT FROM OLD.sla_instance_id THEN
    RAISE EXCEPTION 'BR07: test run identity fields are immutable';
  END IF;
  IF OLD.result IS NOT NULL THEN
    RAISE EXCEPTION 'BR07: a recorded test result is immutable (a % cannot be changed)', OLD.result;
  END IF;
  IF NEW.result IS NOT NULL AND NOT br03_is_current_accepted_engineer(NEW.job_id, NEW.result_recorded_by_id) THEN
    RAISE EXCEPTION 'BR07: only the current accepted engineer can record the test result';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br07_test_run_ins BEFORE INSERT ON br07_test_runs
  FOR EACH ROW EXECUTE FUNCTION br07_guard_test_run();
CREATE TRIGGER trg_br07_test_run_upd BEFORE UPDATE ON br07_test_runs
  FOR EACH ROW EXECUTE FUNCTION br07_guard_test_run();
CREATE TRIGGER trg_br07_test_run_nodelete BEFORE DELETE ON br07_test_runs
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br07_guard_failure_review()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t br07_test_runs%ROWTYPE; v_last uuid; v_fails integer;
BEGIN
  IF NOT br07_is_purchase(NEW.company_id, NEW.reviewed_by_id) THEN
    RAISE EXCEPTION 'BR07: only Purchase can record a test-failure review';
  END IF;
  SELECT * INTO t FROM br07_test_runs WHERE id=NEW.reviewed_test_run_id;
  IF NOT FOUND OR t.job_id<>NEW.job_id OR t.company_id<>NEW.company_id THEN
    RAISE EXCEPTION 'BR07: reviewed test run does not belong to this job/company';
  END IF;
  IF t.result IS DISTINCT FROM 'FAIL' THEN RAISE EXCEPTION 'BR07: only a FAILED test cycle can be reviewed'; END IF;
  SELECT id INTO v_last FROM br07_test_runs WHERE job_id=NEW.job_id AND result IS NOT NULL
   ORDER BY cycle_no DESC LIMIT 1;
  IF v_last<>t.id THEN RAISE EXCEPTION 'BR07: only the latest completed test cycle can be reviewed'; END IF;
  SELECT count(*) INTO v_fails FROM br07_test_runs WHERE job_id=NEW.job_id AND result='FAIL';
  IF v_fails < 2 THEN RAISE EXCEPTION 'BR07: Purchase review applies after 2 failed test cycles (job has %)', v_fails; END IF;
  NEW.failed_cycles_at_review := v_fails;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br07_failure_review BEFORE INSERT ON br07_test_failure_reviews
  FOR EACH ROW EXECUTE FUNCTION br07_guard_failure_review();
CREATE TRIGGER trg_br07_failure_review_append_only BEFORE UPDATE OR DELETE ON br07_test_failure_reviews
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- ==============================================================================
-- Technical handoff (engineer) -> dispatch release (Purchase).
CREATE TABLE br07_technical_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  job_id uuid NOT NULL,
  test_run_id uuid NOT NULL UNIQUE REFERENCES br07_test_runs(id),
  engineer_id uuid NOT NULL,
  handoff_note text,
  outstanding_engineer_held_qty numeric(16,4) NOT NULL DEFAULT 0,
  handed_off_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, engineer_id) REFERENCES employees(company_id, id)
);

CREATE TABLE br07_dispatch_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  job_id uuid NOT NULL UNIQUE,
  handoff_id uuid NOT NULL UNIQUE REFERENCES br07_technical_handoffs(id),
  released_by_id uuid NOT NULL,
  release_note text,
  released_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, released_by_id) REFERENCES employees(company_id, id)
);

-- Shared: is this test run a PASS and still the job's latest cycle, with
-- nothing open and no STOP decision?
CREATE OR REPLACE FUNCTION br07_assert_pass_is_current(p_job uuid, p_test_run uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE t br07_test_runs%ROWTYPE; v_last uuid;
BEGIN
  SELECT * INTO t FROM br07_test_runs WHERE id=p_test_run;
  IF NOT FOUND OR t.job_id<>p_job THEN RAISE EXCEPTION 'BR07: test run does not belong to this job'; END IF;
  IF t.result IS DISTINCT FROM 'PASS' THEN
    RAISE EXCEPTION 'BR07: requires a PASSED test cycle (this cycle is %)', COALESCE(t.result,'not yet recorded');
  END IF;
  SELECT id INTO v_last FROM br07_test_runs WHERE job_id=p_job ORDER BY cycle_no DESC LIMIT 1;
  IF v_last<>t.id THEN RAISE EXCEPTION 'BR07: a later test cycle exists; the PASS is no longer current'; END IF;
  IF br07_testing_stopped(p_job) THEN RAISE EXCEPTION 'BR07: Purchase review decided STOP for this job'; END IF;
  IF EXISTS (SELECT 1 FROM br07_repair_sessions WHERE job_id=p_job AND status IN ('ACTIVE','PAUSED')) THEN
    RAISE EXCEPTION 'BR07: a repair session is still open';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION br07_guard_handoff()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT br03_is_current_accepted_engineer(NEW.job_id, NEW.engineer_id) THEN
    RAISE EXCEPTION 'BR07: current accepted engineer required for technical handoff';
  END IF;
  PERFORM br07_assert_pass_is_current(NEW.job_id, NEW.test_run_id);
  IF EXISTS (SELECT 1 FROM br07_dispatch_releases WHERE job_id=NEW.job_id) THEN
    RAISE EXCEPTION 'BR07: job already dispatch-released';
  END IF;
  SELECT COALESCE(sum(issued_quantity - consumed_quantity - returned_quantity),0)
    INTO NEW.outstanding_engineer_held_qty
    FROM br07_material_issues WHERE job_id=NEW.job_id AND issue_status<>'PENDING_POST';
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br07_handoff BEFORE INSERT ON br07_technical_handoffs
  FOR EACH ROW EXECUTE FUNCTION br07_guard_handoff();
CREATE TRIGGER trg_br07_handoff_append_only BEFORE UPDATE OR DELETE ON br07_technical_handoffs
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br07_guard_dispatch_release()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h br07_technical_handoffs%ROWTYPE;
BEGIN
  IF NOT br07_is_purchase(NEW.company_id, NEW.released_by_id) THEN
    RAISE EXCEPTION 'BR07: only Purchase can authorise dispatch release';
  END IF;
  SELECT * INTO h FROM br07_technical_handoffs WHERE id=NEW.handoff_id;
  IF NOT FOUND OR h.job_id<>NEW.job_id OR h.company_id<>NEW.company_id THEN
    RAISE EXCEPTION 'BR07: handoff does not belong to this job/company';
  END IF;
  PERFORM br07_assert_pass_is_current(NEW.job_id, h.test_run_id);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br07_dispatch_release BEFORE INSERT ON br07_dispatch_releases
  FOR EACH ROW EXECUTE FUNCTION br07_guard_dispatch_release();
CREATE TRIGGER trg_br07_dispatch_release_append_only BEFORE UPDATE OR DELETE ON br07_dispatch_releases
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- ==============================================================================
-- Triggers declared after all referenced tables exist.
CREATE TRIGGER trg_br07_issue_guard BEFORE INSERT ON br07_material_issues
  FOR EACH ROW EXECUTE FUNCTION br07_guard_material_issue();
CREATE TRIGGER trg_br07_issue_immutable BEFORE UPDATE ON br07_material_issues
  FOR EACH ROW EXECUTE FUNCTION br07_issue_immutable();
CREATE TRIGGER trg_br07_issue_nodelete BEFORE DELETE ON br07_material_issues
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br07_guard_repair_session()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT br03_is_current_accepted_engineer(NEW.job_id, NEW.engineer_id) THEN
    RAISE EXCEPTION 'BR07: current accepted engineer required to start a repair session';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM br07_material_issues WHERE job_id=NEW.job_id
                    AND issued_to_engineer_id=NEW.engineer_id AND issue_status='ACKNOWLEDGED') THEN
    RAISE EXCEPTION 'BR07: repair requires issued material whose custody this engineer has acknowledged';
  END IF;
  IF EXISTS (SELECT 1 FROM br07_test_runs WHERE job_id=NEW.job_id AND result IS NULL) THEN
    RAISE EXCEPTION 'BR07: record the open test run result before starting another repair session';
  END IF;
  IF br07_testing_stopped(NEW.job_id) THEN
    RAISE EXCEPTION 'BR07: Purchase review decided STOP for this job';
  END IF;
  IF EXISTS (SELECT 1 FROM br07_dispatch_releases WHERE job_id=NEW.job_id) THEN
    RAISE EXCEPTION 'BR07: job already dispatch-released';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br07_repair_session BEFORE INSERT ON br07_repair_sessions
  FOR EACH ROW EXECUTE FUNCTION br07_guard_repair_session();

CREATE TRIGGER trg_br07_repair_report_version BEFORE INSERT ON br07_repair_report_versions
  FOR EACH ROW EXECUTE FUNCTION br07_guard_repair_report_version();
CREATE TRIGGER trg_br07_repair_report_version_append_only BEFORE UPDATE OR DELETE ON br07_repair_report_versions
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();
