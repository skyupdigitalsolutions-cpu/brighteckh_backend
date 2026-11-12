-- 020_br09_evidence_refund_review_hold_cancel.sql
--
-- Closes three BR-09 gaps found when the official BR-09 Rev01 SQL arrived
-- (reconciliation 12 Nov 2026). ALTER-only / additive on 015/016; the official
-- package SQL is NOT applied (it targets tables this database does not have).
--   1. br09_case_evidence        -- photo / video / email / invoice / POD / test record,
--                                   linked to the case and optionally a claim decision.
--   2. REFUND_REPLACEMENT_REVIEW -- separate CLIENT-UNCONFIRMED authority (unseeded = blocked,
--                                   same pattern as CLAIM_DECISION / GOODWILL_APPROVAL). A
--                                   REPLACEMENT or REFUND_REVIEW decision now needs an APPROVED
--                                   review before it can proceed: the Finance credit-note request
--                                   is raised on approval (no longer on the decision), and closure
--                                   is blocked until approved.
--   3. ON_HOLD / CANCELLED        -- Purchase only, and only while NO claim decision and NO
--                                   credit-note request exists. CANCELLED is terminal; ON_HOLD
--                                   resumes to the status it was held from.
-- All 015/016 guards are preserved: function bodies below are 016/015 verbatim plus the
-- marked additions.

-- =============================================================================
-- 2. Authority kind (decision_kind was varchar(20); the new kind is 25 chars: widen only)
ALTER TABLE br09_authority_config DROP CONSTRAINT br09_authority_config_decision_kind_check;
ALTER TABLE br09_authority_config ALTER COLUMN decision_kind TYPE varchar(30);
ALTER TABLE br09_authority_config ADD CONSTRAINT br09_authority_config_decision_kind_check
  CHECK (decision_kind IN ('CLAIM_DECISION','GOODWILL_APPROVAL','REFUND_REPLACEMENT_REVIEW'));

CREATE TABLE br09_refund_replacement_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  decision_id uuid NOT NULL UNIQUE,
  outcome varchar(10) NOT NULL CHECK (outcome IN ('APPROVED','REJECTED')),
  note text NOT NULL CHECK (NULLIF(btrim(note),'') IS NOT NULL),
  reviewed_by_id uuid NOT NULL,
  reviewer_role_code varchar(40) NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, decision_id),
  FOREIGN KEY (company_id, decision_id) REFERENCES br09_claim_decisions(company_id, id),
  FOREIGN KEY (company_id, reviewed_by_id) REFERENCES employees(company_id, id)
);

-- =============================================================================
-- 3. Case statuses + hold / cancel fields
ALTER TABLE br09_support_cases DROP CONSTRAINT br09_support_cases_case_status_check;
ALTER TABLE br09_support_cases ADD CONSTRAINT br09_support_cases_case_status_check
  CHECK (case_status IN ('REGISTERED','UNDER_REVIEW','DECIDED','CLOSED','ON_HOLD','CANCELLED'));
-- was: case_status = 'REGISTERED' OR (assigned_to_id AND review_started_at)
ALTER TABLE br09_support_cases DROP CONSTRAINT br09_support_cases_check1;
ALTER TABLE br09_support_cases ADD CONSTRAINT br09_support_cases_review_assigned_check
  CHECK (case_status NOT IN ('UNDER_REVIEW','DECIDED','CLOSED') OR (assigned_to_id IS NOT NULL AND review_started_at IS NOT NULL));
ALTER TABLE br09_support_cases
  ADD COLUMN hold_from_status varchar(16) CHECK (hold_from_status IN ('REGISTERED','UNDER_REVIEW')),
  ADD COLUMN hold_reason text,
  ADD COLUMN held_by_id uuid,
  ADD COLUMN held_at timestamptz,
  ADD COLUMN last_resumed_by_id uuid,
  ADD COLUMN last_resumed_at timestamptz,
  ADD COLUMN cancelled_by_id uuid,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancel_reason text;
ALTER TABLE br09_support_cases
  ADD CONSTRAINT br09_support_cases_held_by_fk FOREIGN KEY (company_id, held_by_id) REFERENCES employees(company_id, id),
  ADD CONSTRAINT br09_support_cases_resumed_by_fk FOREIGN KEY (company_id, last_resumed_by_id) REFERENCES employees(company_id, id),
  ADD CONSTRAINT br09_support_cases_cancelled_by_fk FOREIGN KEY (company_id, cancelled_by_id) REFERENCES employees(company_id, id),
  ADD CONSTRAINT br09_support_cases_hold_check CHECK ((case_status = 'ON_HOLD') = (hold_from_status IS NOT NULL
      AND held_by_id IS NOT NULL AND held_at IS NOT NULL AND NULLIF(btrim(hold_reason),'') IS NOT NULL)),
  ADD CONSTRAINT br09_support_cases_cancel_check CHECK ((case_status = 'CANCELLED') = (cancelled_at IS NOT NULL
      AND cancelled_by_id IS NOT NULL AND NULLIF(btrim(cancel_reason),'') IS NOT NULL));

-- A cancelled case is as closed as a CLOSED one for every child record (+ CANCELLED).
CREATE OR REPLACE FUNCTION br09_open_case(p_case uuid, p_company uuid)
RETURNS br09_support_cases LANGUAGE plpgsql AS $$
DECLARE c br09_support_cases%ROWTYPE;
BEGIN
  SELECT * INTO c FROM br09_support_cases WHERE id=p_case FOR UPDATE;
  IF NOT FOUND OR c.company_id <> p_company THEN RAISE EXCEPTION 'BR09: case does not belong to this company'; END IF;
  IF c.case_status = 'CLOSED' THEN RAISE EXCEPTION 'BR09: case is closed'; END IF;
  IF c.case_status = 'CANCELLED' THEN RAISE EXCEPTION 'BR09: case is cancelled'; END IF;
  RETURN c;
END $$;

-- Hold / cancel are allowed only before any claim outcome exists.
CREATE OR REPLACE FUNCTION br09_hold_cancel_blocker(p_case uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM br09_claim_decisions WHERE case_id=p_case) THEN 'a claim decision exists'
    WHEN EXISTS (SELECT 1 FROM br09_credit_note_requests WHERE case_id=p_case) THEN 'a credit-note request exists'
  END;
$$;

CREATE OR REPLACE FUNCTION br09_guard_case()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_block text; d br09_claim_decisions%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.registered_by_id, 'SALES') THEN
      RAISE EXCEPTION 'BR09: only Sales can register an after-sales case';
    END IF;
    NEW.case_number := br09_next_case_number(NEW.company_id);
    NEW.case_status := 'REGISTERED'; NEW.registered_at := now();
    NEW.assigned_to_id := NULL; NEW.review_started_at := NULL;
    NEW.closed_at := NULL; NEW.closed_by_id := NULL; NEW.closure_reason := NULL; NEW.closure_disposition := NULL;
    NEW.original_invoice_id := NULL; NEW.original_pod_date := NULL; NEW.warranty_end_date := NULL;
    NEW.warranty_status := 'UNKNOWN';
    -- [020] hold / cancel fields start empty
    NEW.hold_from_status := NULL; NEW.hold_reason := NULL; NEW.held_by_id := NULL; NEW.held_at := NULL;
    NEW.last_resumed_by_id := NULL; NEW.last_resumed_at := NULL;
    NEW.cancelled_by_id := NULL; NEW.cancelled_at := NULL; NEW.cancel_reason := NULL;
    IF NEW.original_job_id IS NOT NULL THEN
      NEW.matched_at := now(); NEW.matched_by_id := NEW.registered_by_id;
      NEW := br09_apply_original_job(NEW);
    ELSE
      NEW.matched_at := NULL; NEW.matched_by_id := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.case_status = 'CLOSED' THEN RAISE EXCEPTION 'BR09: a closed case is immutable'; END IF;
  IF OLD.case_status = 'CANCELLED' THEN RAISE EXCEPTION 'BR09: a cancelled case is immutable'; END IF;  -- [020]
  IF NEW.company_id<>OLD.company_id OR NEW.case_number<>OLD.case_number OR NEW.customer_id<>OLD.customer_id
     OR NEW.complaint_type<>OLD.complaint_type OR NEW.channel<>OLD.channel OR NEW.fault_description<>OLD.fault_description
     OR NEW.contact_name<>OLD.contact_name OR NEW.contact_detail<>OLD.contact_detail
     OR NEW.registered_by_id<>OLD.registered_by_id OR NEW.registered_at<>OLD.registered_at
     OR NEW.priority<>OLD.priority THEN
    RAISE EXCEPTION 'BR09: case registration fields are immutable';
  END IF;

  -- Controlled original-job match: exactly once, by Purchase; recomputes the snapshot.
  IF OLD.original_job_id IS NOT NULL AND (NEW.original_job_id IS DISTINCT FROM OLD.original_job_id
                                          OR NEW.matched_by_id IS DISTINCT FROM OLD.matched_by_id
                                          OR NEW.matched_at IS DISTINCT FROM OLD.matched_at) THEN
    RAISE EXCEPTION 'BR09: original job already matched';
  END IF;
  IF OLD.original_job_id IS NULL AND NEW.original_job_id IS NOT NULL THEN
    IF NOT br08_has_role(NEW.company_id, NEW.matched_by_id, 'PURCHASE') THEN
      RAISE EXCEPTION 'BR09: only Purchase can match an unlocated original job';
    END IF;
    NEW.matched_at := now();
    NEW := br09_apply_original_job(NEW);
  ELSIF NEW.original_invoice_id IS DISTINCT FROM OLD.original_invoice_id
        OR NEW.original_pod_date IS DISTINCT FROM OLD.original_pod_date
        OR NEW.warranty_status IS DISTINCT FROM OLD.warranty_status
        OR NEW.warranty_end_date IS DISTINCT FROM OLD.warranty_end_date
        OR NEW.matched_at IS DISTINCT FROM OLD.matched_at OR NEW.matched_by_id IS DISTINCT FROM OLD.matched_by_id THEN
    RAISE EXCEPTION 'BR09: warranty/invoice snapshot is derived from the matched original job';
  END IF;

  IF NEW.case_status <> OLD.case_status THEN
    IF OLD.case_status = 'REGISTERED' AND NEW.case_status = 'UNDER_REVIEW' THEN
      IF NOT br08_has_role(NEW.company_id, NEW.assigned_to_id, 'PURCHASE') THEN
        RAISE EXCEPTION 'BR09: a case is reviewed by (assigned to) Purchase';
      END IF;
      NEW.review_started_at := now();
    -- [020] hold: Purchase, from REGISTERED / UNDER_REVIEW, before any decision / credit-note request
    ELSIF NEW.case_status = 'ON_HOLD' THEN
      IF OLD.case_status NOT IN ('REGISTERED','UNDER_REVIEW') THEN
        RAISE EXCEPTION 'BR09: only a REGISTERED or UNDER_REVIEW case can be put on hold (case is %)', OLD.case_status;
      END IF;
      IF NOT br08_has_role(NEW.company_id, NEW.held_by_id, 'PURCHASE') THEN
        RAISE EXCEPTION 'BR09: only Purchase can put a case on hold';
      END IF;
      v_block := br09_hold_cancel_blocker(NEW.id);
      IF v_block IS NOT NULL THEN RAISE EXCEPTION 'BR09: cannot hold the case -- %', v_block; END IF;
      NEW.hold_from_status := OLD.case_status; NEW.held_at := now();
    -- [020] resume: back to the status it was held from, by Purchase
    ELSIF OLD.case_status = 'ON_HOLD' AND NEW.case_status <> 'CANCELLED' THEN
      IF NEW.case_status IS DISTINCT FROM OLD.hold_from_status THEN
        RAISE EXCEPTION 'BR09: an ON_HOLD case resumes to % (the status it was held from)', OLD.hold_from_status;
      END IF;
      IF NOT br08_has_role(NEW.company_id, NEW.last_resumed_by_id, 'PURCHASE') THEN
        RAISE EXCEPTION 'BR09: only Purchase can resume a case';
      END IF;
      NEW.last_resumed_at := now();
      NEW.hold_from_status := NULL; NEW.hold_reason := NULL; NEW.held_by_id := NULL; NEW.held_at := NULL;
    -- [020] cancel: Purchase, before any decision / credit-note request / returned unit; terminal
    ELSIF NEW.case_status = 'CANCELLED' THEN
      IF OLD.case_status NOT IN ('REGISTERED','UNDER_REVIEW','ON_HOLD') THEN
        RAISE EXCEPTION 'BR09: a % case cannot be cancelled', OLD.case_status;
      END IF;
      IF NOT br08_has_role(NEW.company_id, NEW.cancelled_by_id, 'PURCHASE') THEN
        RAISE EXCEPTION 'BR09: only Purchase can cancel a case';
      END IF;
      v_block := br09_hold_cancel_blocker(NEW.id);
      IF v_block IS NOT NULL THEN RAISE EXCEPTION 'BR09: cannot cancel the case -- %', v_block; END IF;
      IF EXISTS (SELECT 1 FROM br09_case_repeat_jobs WHERE case_id=NEW.id) THEN
        RAISE EXCEPTION 'BR09: cannot cancel the case -- a returned unit (repeat job) is linked; record a decision and close instead';
      END IF;
      NEW.cancelled_at := now();
      NEW.hold_from_status := NULL; NEW.hold_reason := NULL; NEW.held_by_id := NULL; NEW.held_at := NULL;
    ELSIF NEW.case_status = 'DECIDED' THEN
      IF pg_trigger_depth() < 2 THEN RAISE EXCEPTION 'BR09: DECIDED is set only by recording a claim decision'; END IF;
    ELSIF NEW.case_status = 'CLOSED' THEN
      IF NOT br08_has_role(NEW.company_id, NEW.closed_by_id, 'PURCHASE') THEN
        RAISE EXCEPTION 'BR09: only Purchase can close an after-sales case';
      END IF;
      v_block := br09_closure_blocker(NEW.id);
      IF v_block IS NOT NULL THEN RAISE EXCEPTION 'BR09: cannot close case -- %', v_block; END IF;
      SELECT * INTO d FROM br09_claim_decisions WHERE case_id=NEW.id AND is_current;
      NEW.closure_disposition := COALESCE(d.resolution, 'NO_RETURN_CLOSED');
      NEW.closed_at := now();
    ELSE
      RAISE EXCEPTION 'BR09: illegal case status transition % -> %', OLD.case_status, NEW.case_status;
    END IF;
  ELSIF NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.closure_disposition IS DISTINCT FROM OLD.closure_disposition
        OR (OLD.review_started_at IS NOT NULL AND NEW.review_started_at IS DISTINCT FROM OLD.review_started_at)
        -- [020] hold / resume / cancel fields move only with their transition
        OR NEW.hold_from_status IS DISTINCT FROM OLD.hold_from_status OR NEW.hold_reason IS DISTINCT FROM OLD.hold_reason
        OR NEW.held_by_id IS DISTINCT FROM OLD.held_by_id OR NEW.held_at IS DISTINCT FROM OLD.held_at
        OR NEW.last_resumed_by_id IS DISTINCT FROM OLD.last_resumed_by_id OR NEW.last_resumed_at IS DISTINCT FROM OLD.last_resumed_at
        OR NEW.cancelled_by_id IS DISTINCT FROM OLD.cancelled_by_id OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
        OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason THEN
    RAISE EXCEPTION 'BR09: closure/review/hold/cancel fields change only with the status transition';
  END IF;
  RETURN NEW;
END $$;

-- SLA clocks: CANCELLED stops every clock like CLOSED. ON_HOLD does NOT pause them
-- (no pause rule is defined -- flagged).
CREATE OR REPLACE FUNCTION br09_case_sla_events()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO br09_case_sla(case_id,event_code,started_at,due_at)
    SELECT NEW.id, e, NEW.registered_at, br09_sla_due(NEW.company_id, NEW.priority, e, NEW.registered_at)
      FROM unnest(ARRAY['ACKNOWLEDGEMENT','INITIAL_ASSESSMENT','RESOLUTION']) e;
  ELSIF NEW.case_status <> OLD.case_status THEN
    IF NEW.case_status = 'UNDER_REVIEW' THEN PERFORM br09_stop_sla(NEW.id, 'INITIAL_ASSESSMENT'); END IF;
    IF NEW.case_status IN ('CLOSED','CANCELLED') THEN
      PERFORM br09_stop_sla(NEW.id, 'INITIAL_ASSESSMENT');
      PERFORM br09_stop_sla(NEW.id, 'ACKNOWLEDGEMENT');
      PERFORM br09_stop_sla(NEW.id, 'RESOLUTION');
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- =============================================================================
-- 2 (cont.). Decision guard: 015 verbatim + a decision may also be replaced after a
-- REJECTED refund/replacement review.
CREATE OR REPLACE FUNCTION br09_guard_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c br09_support_cases%ROWTYPE; prev br09_claim_decisions%ROWTYPE; v_inv_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'is_current') IS DISTINCT FROM (to_jsonb(OLD) - 'is_current')
       OR NOT (OLD.is_current AND NOT NEW.is_current) OR pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'BR09: claim decisions are immutable';
    END IF;
    RETURN NEW;
  END IF;

  c := br09_open_case(NEW.case_id, NEW.company_id);
  NEW.decided_role_code := br09_assert_authority(NEW.company_id, 'CLAIM_DECISION', NEW.decided_by_id);
  IF c.case_status NOT IN ('UNDER_REVIEW','DECIDED') THEN
    RAISE EXCEPTION 'BR09: a case must be under Purchase review before a claim decision';
  END IF;
  -- A decision may be replaced only when the current one cannot proceed.
  SELECT * INTO prev FROM br09_claim_decisions WHERE case_id=NEW.case_id AND is_current;
  IF prev.id IS NOT NULL AND NOT (
       EXISTS (SELECT 1 FROM br09_goodwill_approvals WHERE decision_id=prev.id AND outcome='REJECTED')
    OR EXISTS (SELECT 1 FROM br09_credit_note_requests WHERE decision_id=prev.id AND request_status='DECLINED')
    OR EXISTS (SELECT 1 FROM br09_refund_replacement_reviews WHERE decision_id=prev.id AND outcome='REJECTED')) THEN  -- [020]
    RAISE EXCEPTION 'BR09: case already has a current decision (it can be replaced only after goodwill rejection, a rejected refund/replacement review or a declined credit note)';
  END IF;
  IF NEW.resolution <> 'INFORMATION_ONLY' AND c.original_job_id IS NULL THEN
    RAISE EXCEPTION 'BR09: match the original job before deciding the claim';
  END IF;
  -- 09B-06: dates never approve a claim -- coverage outcomes need technical evidence.
  IF NEW.resolution IN ('WARRANTY_REPAIR','GOODWILL','REPLACEMENT','REFUND_REVIEW')
     AND NOT EXISTS (SELECT 1 FROM br09_technical_assessments WHERE case_id=NEW.case_id) THEN
    RAISE EXCEPTION 'BR09: % needs an engineer technical assessment of the returned unit (09B-06)', NEW.resolution;
  END IF;
  IF NEW.resolution = 'WARRANTY_REPAIR' AND c.warranty_status <> 'IN_WARRANTY' THEN
    RAISE EXCEPTION 'BR09: unit is % -- free repair outside warranty is GOODWILL (separate approval) or PAID_REPAIR', c.warranty_status;
  END IF;
  IF NEW.resolution = 'REFUND_REVIEW' THEN
    SELECT invoice_status INTO v_inv_status FROM br08_invoices WHERE id=c.original_invoice_id;
    IF v_inv_status IS NULL OR v_inv_status = 'CANCELLED' THEN
      RAISE EXCEPTION 'BR09: REFUND_REVIEW needs a live original invoice to credit';
    END IF;
  END IF;
  NEW.warranty_status_at_decision := c.warranty_status;
  NEW.decided_at := now(); NEW.is_current := true;
  IF prev.id IS NOT NULL THEN UPDATE br09_claim_decisions SET is_current=false WHERE id=prev.id; END IF;
  RETURN NEW;
END $$;

-- [020] The decision no longer raises the credit-note request itself: REFUND_REVIEW
-- first needs the separate refund/replacement review (below).
CREATE OR REPLACE FUNCTION br09_apply_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c br09_support_cases%ROWTYPE;
BEGIN
  SELECT * INTO c FROM br09_support_cases WHERE id=NEW.case_id;
  IF c.case_status <> 'DECIDED' THEN
    UPDATE br09_support_cases SET case_status='DECIDED' WHERE id=NEW.case_id;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION br09_guard_refund_replacement_review()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d br09_claim_decisions%ROWTYPE;
BEGIN
  SELECT * INTO d FROM br09_claim_decisions WHERE id=NEW.decision_id;
  IF NOT FOUND OR d.company_id <> NEW.company_id THEN RAISE EXCEPTION 'BR09: decision not found in this company'; END IF;
  PERFORM br09_open_case(d.case_id, NEW.company_id);
  IF d.resolution NOT IN ('REPLACEMENT','REFUND_REVIEW') OR NOT d.is_current THEN
    RAISE EXCEPTION 'BR09: refund/replacement review applies only to the current REPLACEMENT or REFUND_REVIEW decision';
  END IF;
  NEW.reviewer_role_code := br09_assert_authority(NEW.company_id, 'REFUND_REPLACEMENT_REVIEW', NEW.reviewed_by_id);
  NEW.reviewed_at := now();
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION br09_apply_refund_replacement_review()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d br09_claim_decisions%ROWTYPE; c br09_support_cases%ROWTYPE;
BEGIN
  SELECT * INTO d FROM br09_claim_decisions WHERE id=NEW.decision_id;
  -- Approved refund -> the BR-08 credit-note path: a request for Finance, never the CN itself.
  IF NEW.outcome = 'APPROVED' AND d.resolution = 'REFUND_REVIEW' THEN
    SELECT * INTO c FROM br09_support_cases WHERE id=d.case_id;
    INSERT INTO br09_credit_note_requests(company_id,case_id,decision_id,invoice_id,failed_job_id,requested_by_id)
    VALUES (d.company_id, d.case_id, d.id, c.original_invoice_id, c.original_job_id, NEW.reviewed_by_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_br09_rr_review BEFORE INSERT ON br09_refund_replacement_reviews
  FOR EACH ROW EXECUTE FUNCTION br09_guard_refund_replacement_review();
CREATE TRIGGER trg_br09_rr_review_apply AFTER INSERT ON br09_refund_replacement_reviews
  FOR EACH ROW EXECUTE FUNCTION br09_apply_refund_replacement_review();
CREATE TRIGGER trg_br09_rr_review_append_only BEFORE UPDATE OR DELETE ON br09_refund_replacement_reviews
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- Closure blocker: 015 verbatim + REPLACEMENT / REFUND_REVIEW need an APPROVED review.
CREATE OR REPLACE FUNCTION br09_closure_blocker(p_case uuid)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE c br09_support_cases%ROWTYPE; d br09_claim_decisions%ROWTYPE; v_after timestamptz; v_n integer;
BEGIN
  SELECT * INTO c FROM br09_support_cases WHERE id=p_case;
  IF c.case_status = 'ON_HOLD' THEN RETURN 'case is ON_HOLD -- resume it first'; END IF;  -- [020]
  SELECT * INTO d FROM br09_claim_decisions WHERE case_id=p_case AND is_current;
  IF d.id IS NULL THEN
    -- 09A-10: closure without a claim decision only when nothing was physically returned.
    IF EXISTS (SELECT 1 FROM br09_case_repeat_jobs WHERE case_id=p_case) THEN
      RETURN 'a repeat job is linked -- record an authorised claim decision before closing';
    END IF;
    v_after := c.registered_at;
  ELSE
    IF d.resolution = 'GOODWILL' AND NOT EXISTS (
         SELECT 1 FROM br09_goodwill_approvals WHERE decision_id=d.id AND outcome='APPROVED') THEN
      RETURN 'goodwill decision is not approved by the goodwill authority';
    END IF;
    IF d.resolution IN ('REPLACEMENT','REFUND_REVIEW') AND NOT EXISTS (  -- [020]
         SELECT 1 FROM br09_refund_replacement_reviews WHERE decision_id=d.id AND outcome='APPROVED') THEN
      RETURN 'refund/replacement decision is not approved by the refund/replacement review authority';
    END IF;
    IF d.resolution = 'REFUND_REVIEW' AND EXISTS (
         SELECT 1 FROM br09_credit_note_requests WHERE decision_id=d.id AND request_status='REQUESTED') THEN
      RETURN 'credit-note request is still pending with Finance';
    END IF;
    IF d.resolution IN ('WARRANTY_REPAIR','PAID_REPAIR','GOODWILL') THEN
      SELECT count(*) INTO v_n FROM br09_case_repeat_jobs WHERE case_id=p_case;
      IF v_n = 0 THEN RETURN 'a repair resolution needs the returned unit''s repeat job'; END IF;
      IF EXISTS (SELECT 1 FROM br09_case_repeat_jobs rj
                  WHERE rj.case_id=p_case AND NOT EXISTS (
                    SELECT 1 FROM br08_dispatch_batch_jobs bj JOIN br08_dispatch_batches b ON b.id=bj.batch_id
                     WHERE bj.job_id=rj.repeat_job_id AND b.batch_status='DISPATCHED')) THEN
        RETURN 'resolution not completed: repeat job not yet dispatched back to the customer (BR-08)';
      END IF;
    END IF;
    v_after := d.decided_at;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM br09_customer_communications
                  WHERE case_id=p_case AND comm_type='RESOLUTION' AND sent_at >= v_after) THEN
    RETURN 'no RESOLUTION communication sent to the customer (Sales) after the outcome';
  END IF;
  RETURN NULL;
END $$;

-- =============================================================================
-- 1. Case evidence (append-only; Sales or Purchase record it; open cases only, incl. ON_HOLD)
CREATE TABLE br09_case_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  case_id uuid NOT NULL,
  claim_decision_id uuid,
  evidence_type varchar(16) NOT NULL CHECK (evidence_type IN
    ('CUSTOMER_PHOTO','CUSTOMER_VIDEO','CUSTOMER_EMAIL','ORIGINAL_INVOICE','DELIVERY_POD','TEST_RECORD')),
  file_uri text NOT NULL CHECK (NULLIF(btrim(file_uri),'') IS NOT NULL),
  file_name varchar(255) NOT NULL CHECK (NULLIF(btrim(file_name),'') IS NOT NULL),
  description text,
  submitted_by_kind varchar(8) NOT NULL CHECK (submitted_by_kind IN ('CUSTOMER','STAFF')),
  received_at timestamptz NOT NULL,
  recorded_by_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, case_id) REFERENCES br09_support_cases(company_id, id),
  FOREIGN KEY (company_id, claim_decision_id) REFERENCES br09_claim_decisions(company_id, id),
  FOREIGN KEY (company_id, recorded_by_id) REFERENCES employees(company_id, id)
);
CREATE INDEX idx_br09_evidence_case ON br09_case_evidence(case_id, recorded_at);

CREATE OR REPLACE FUNCTION br09_guard_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM br09_open_case(NEW.case_id, NEW.company_id);
  IF NOT (br08_has_role(NEW.company_id, NEW.recorded_by_id, 'SALES') OR br08_has_role(NEW.company_id, NEW.recorded_by_id, 'PURCHASE')) THEN
    RAISE EXCEPTION 'BR09: case evidence is recorded by Sales or Purchase';
  END IF;
  IF NEW.claim_decision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM br09_claim_decisions WHERE id=NEW.claim_decision_id AND case_id=NEW.case_id) THEN
    RAISE EXCEPTION 'BR09: the claim decision belongs to a different case';
  END IF;
  IF NEW.received_at > now() THEN RAISE EXCEPTION 'BR09: evidence received time cannot be in the future'; END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br09_evidence BEFORE INSERT ON br09_case_evidence
  FOR EACH ROW EXECUTE FUNCTION br09_guard_evidence();
CREATE TRIGGER trg_br09_evidence_append_only BEFORE UPDATE OR DELETE ON br09_case_evidence
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();
