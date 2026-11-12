-- 015_br09_after_sales.sql
--
-- BR-09 after-sales / warranty: complaint case -> (controlled original-Job match)
-- -> Purchase review -> physical repeat return via BR-02 (new JIN + Job + Rxx
-- repeat link) -> engineer technical assessment -> authorised claim decision
-- (+ separate goodwill approval) -> credit-note request fulfilled by Finance
-- through the EXISTING BR-08 credit-note logic -> Purchase case closure.
-- Plus quality analytics views (repeat failure, root cause, goodwill, feedback).
--
-- Sources: BR-09 Rev01 client decision register (30 recorded responses, SOP
-- "CLIENT REVIEW - NOT APPROVED"; found in Brightech_UI_Design_Handoff
-- BR09_Warranty_prototype.html) + decisions taken with the client in the build
-- session (5 Nov 2026). The "19 proposed BR-09 SQL tables" draft referenced by
-- that register was NOT available; this is a new schema.
--
-- Confirmed roles used: Sales registers + communicates (09A-01/06, 09C-04);
-- Purchase reviews/matches/links/closes (09A-01, 09C-06); engineer gives
-- technical findings (09B-03); Finance owns the credit note (BR-08).
-- CLIENT-UNCONFIRMED: claim-decision and goodwill approvers (09B-08, 09C-02,
-- P02/P03) -> br09_authority_config, UNSEEDED: decisions are blocked until a
-- SYSTEM_ADMIN assigns a role. Nothing here picks an approver.
--
-- Warranty status: 3 months from the original job's proof-of-delivery date
-- (same rule as BR-08 credit notes; client decision 5 Nov 2026). Advisory only
-- -- dates never approve a claim (09B-06). Conflicts with register 09A-07
-- ("per quotation/invoice, no default") -> flagged in CLAUDE.md.
--
-- BR-09 never creates Job IDs (BR-02 does, via br02_link_repeat_job below),
-- never posts inventory, never creates invoices/receipts, never closes a
-- BR-02/BR-08 job. Case closure is its own lifecycle.

-- ==============================================================================
-- BR-02 repeat links (job_repeat_links exists since 001 but had no writer).
CREATE OR REPLACE FUNCTION br02_guard_repeat_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n service_jobs%ROWTYPE; o service_jobs%ROWTYPE; v_disp timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'warranty_status') IS DISTINCT FROM (to_jsonb(OLD) - 'warranty_status') THEN
      RAISE EXCEPTION 'BR02: repeat links are immutable';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO n FROM service_jobs WHERE id=NEW.job_id;
  SELECT * INTO o FROM service_jobs WHERE id=NEW.original_job_id;
  IF n.id IS NULL OR o.id IS NULL OR n.company_id <> o.company_id THEN
    RAISE EXCEPTION 'BR02: repeat job and original job must exist in the same company';
  END IF;
  IF br08_job_customer(n.id) IS DISTINCT FROM br08_job_customer(o.id) THEN
    RAISE EXCEPTION 'BR02: a repeat return must belong to the same customer as the original job';
  END IF;
  IF EXISTS (SELECT 1 FROM job_repeat_links WHERE job_id=NEW.original_job_id) THEN
    RAISE EXCEPTION 'BR02: original_job_id must be the first job of the chain, not a repeat';
  END IF;
  SELECT b.dispatched_at INTO v_disp FROM br08_dispatch_batch_jobs bj JOIN br08_dispatch_batches b ON b.id=bj.batch_id
   WHERE bj.job_id=NEW.original_job_id AND b.batch_status='DISPATCHED';
  IF v_disp IS NULL THEN
    RAISE EXCEPTION 'BR02: the original job was never dispatched -- a repeat return needs a delivered original';
  END IF;
  IF n.created_at <= v_disp THEN
    RAISE EXCEPTION 'BR02: the repeat job must be created (new inward) after the original job was dispatched';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br02_repeat_link BEFORE INSERT OR UPDATE ON job_repeat_links
  FOR EACH ROW EXECUTE FUNCTION br02_guard_repeat_link();
CREATE TRIGGER trg_br02_repeat_link_nodelete BEFORE DELETE ON job_repeat_links
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- Link a NEW job (already created by BR-02 inward -> verify) as a repeat return.
-- p_of_job may be the original or any earlier repeat: the chain's original and
-- the latest previous repeat are resolved here, and R-number is DB-assigned.
CREATE OR REPLACE FUNCTION br02_link_repeat_job(p_job uuid, p_of_job uuid, p_actor uuid, p_reason text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_company uuid; v_original uuid; v_prev uuid; v_no integer;
BEGIN
  SELECT company_id INTO v_company FROM service_jobs WHERE id=p_job;
  IF v_company IS NULL THEN RAISE EXCEPTION 'BR02: job not found'; END IF;
  IF NOT br08_has_role(v_company, p_actor, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR02: only Purchase can link a repeat return';
  END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'BR02: return reason is required'; END IF;
  IF EXISTS (SELECT 1 FROM job_repeat_links WHERE job_id=p_job) THEN
    RAISE EXCEPTION 'BR02: job is already linked as a repeat return';
  END IF;
  SELECT original_job_id INTO v_original FROM job_repeat_links WHERE job_id=p_of_job;
  v_original := COALESCE(v_original, p_of_job);
  IF v_original = p_job THEN RAISE EXCEPTION 'BR02: a job cannot be a repeat of itself'; END IF;
  PERFORM 1 FROM service_jobs WHERE id=v_original FOR UPDATE;   -- serialise R-numbering
  SELECT job_id, repeat_number INTO v_prev, v_no FROM job_repeat_links
   WHERE original_job_id=v_original ORDER BY repeat_number DESC LIMIT 1;
  INSERT INTO job_repeat_links(job_id,original_job_id,previous_job_id,repeat_number,return_reason)
  VALUES (p_job, v_original, v_prev, COALESCE(v_no,0)+1, p_reason);
  RETURN p_job;
END $$;

-- ==============================================================================
-- Numbering: separate continuous case numbers per company (09A-03), same
-- mechanism/format family as JIN/JOB/MR/QT/PO/GRN: ASC-<CODE>-000001.
ALTER TABLE company_number_counters DROP CONSTRAINT company_number_counters_number_kind_check;
ALTER TABLE company_number_counters ADD CONSTRAINT company_number_counters_number_kind_check
  CHECK (number_kind IN ('JIN','JOB','MR','QT','PO','GRN','ASC'));

CREATE OR REPLACE FUNCTION br09_next_case_number(p_company_id uuid)
RETURNS varchar LANGUAGE plpgsql AS $$
DECLARE v_code varchar(3); v_seq bigint;
BEGIN
  SELECT entity_code INTO v_code FROM legal_entities WHERE id=p_company_id AND is_active;
  IF v_code IS NULL THEN RAISE EXCEPTION 'Company missing or inactive'; END IF;
  INSERT INTO company_number_counters(company_id,number_kind,last_value)
  VALUES(p_company_id,'ASC',1)
  ON CONFLICT(company_id,number_kind) DO UPDATE
    SET last_value=company_number_counters.last_value+1, changed_at=now()
  RETURNING last_value INTO v_seq;
  RETURN 'ASC-'||v_code||'-'||lpad(v_seq::text,6,'0');
END $$;

-- ==============================================================================
-- CLIENT-UNCONFIRMED authorities (unseeded = blocked).
CREATE TABLE br09_authority_config (
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  decision_kind varchar(20) NOT NULL CHECK (decision_kind IN ('CLAIM_DECISION','GOODWILL_APPROVAL')),
  approver_role_code varchar(40) CHECK (approver_role_code IN
    ('PURCHASE','ENGINEER','SALES','STORES_QUALITY','EXTERNAL_COORD','FINANCE','MANAGEMENT','SYSTEM_ADMIN')),
  note text,
  updated_by_id uuid REFERENCES employees(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, decision_kind)
);

CREATE OR REPLACE FUNCTION br09_assert_authority(p_company uuid, p_kind text, p_employee uuid)
RETURNS varchar LANGUAGE plpgsql STABLE AS $$
DECLARE v_role varchar;
BEGIN
  SELECT approver_role_code INTO v_role FROM br09_authority_config WHERE company_id=p_company AND decision_kind=p_kind;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'BR09: CLIENT-UNCONFIRMED -- no % approver role is configured for this company (set br09_authority_config)', p_kind;
  END IF;
  IF NOT br08_has_role(p_company, p_employee, v_role) THEN
    RAISE EXCEPTION 'BR09: % requires the configured approver role %', p_kind, v_role;
  END IF;
  RETURN v_role;
END $$;

-- SLA targets per company / priority / event, in working time (012 calendar).
-- UNSEEDED (register P05/P06 pending): due_at stays NULL until Brightech sets them.
CREATE TABLE br09_sla_targets (
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  priority varchar(12) NOT NULL CHECK (priority IN ('NORMAL','URGENT','CRITICAL')),
  event_code varchar(30) NOT NULL CHECK (event_code IN ('ACKNOWLEDGEMENT','INITIAL_ASSESSMENT','RESOLUTION')),
  target_amount integer NOT NULL CHECK (target_amount > 0),
  target_unit varchar(14) NOT NULL CHECK (target_unit IN ('WORKING_HOUR','WORKING_DAY')),
  updated_by_id uuid REFERENCES employees(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, priority, event_code)
);

CREATE OR REPLACE FUNCTION br09_sla_due(p_company uuid, p_priority varchar, p_event varchar, p_from timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE t br09_sla_targets%ROWTYPE;
BEGIN
  SELECT * INTO t FROM br09_sla_targets WHERE company_id=p_company AND priority=p_priority AND event_code=p_event;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF t.target_unit = 'WORKING_HOUR' THEN RETURN cal_add_working_minutes(p_company, p_from, t.target_amount * 60); END IF;
  RETURN cal_add_working_days(p_company, p_from, t.target_amount);
END $$;

-- ==============================================================================
-- The case.
CREATE TABLE br09_support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  case_number varchar(40) NOT NULL UNIQUE,
  customer_id uuid NOT NULL,
  complaint_type varchar(20) NOT NULL CHECK (complaint_type IN
    ('WARRANTY_ENQUIRY','REPEAT_FAILURE','SERVICE_COMPLAINT','DELIVERY_ISSUE')),
  channel varchar(16) NOT NULL CHECK (channel IN ('EMAIL','WHATSAPP','PHONE','CUSTOMER_PORTAL','WALK_IN','OTHER')),
  contact_name varchar(150) NOT NULL CHECK (NULLIF(btrim(contact_name),'') IS NOT NULL),
  contact_detail varchar(254) NOT NULL CHECK (NULLIF(btrim(contact_detail),'') IS NOT NULL),
  fault_description text NOT NULL CHECK (length(btrim(fault_description)) >= 10),
  priority varchar(12) NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','URGENT','CRITICAL')),
  customer_reference text,
  original_job_id uuid,
  original_invoice_id uuid,
  original_pod_date date,
  warranty_end_date date,
  warranty_status varchar(16) NOT NULL DEFAULT 'UNKNOWN' CHECK (warranty_status IN ('IN_WARRANTY','OUT_OF_WARRANTY','UNKNOWN')),
  matched_by_id uuid,
  matched_at timestamptz,
  case_status varchar(16) NOT NULL DEFAULT 'REGISTERED'
    CHECK (case_status IN ('REGISTERED','UNDER_REVIEW','DECIDED','CLOSED')),
  assigned_to_id uuid,
  review_started_at timestamptz,
  registered_by_id uuid NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  closed_by_id uuid,
  closed_at timestamptz,
  closure_disposition varchar(24),
  closure_reason text,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id),
  FOREIGN KEY (company_id, original_job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, original_invoice_id) REFERENCES br08_invoices(company_id, id),
  FOREIGN KEY (company_id, matched_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, assigned_to_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, registered_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, closed_by_id) REFERENCES employees(company_id, id),
  CHECK ((original_job_id IS NULL) = (matched_at IS NULL)),
  CHECK (case_status = 'REGISTERED' OR (assigned_to_id IS NOT NULL AND review_started_at IS NOT NULL)),
  CHECK ((case_status = 'CLOSED') = (closed_at IS NOT NULL AND closed_by_id IS NOT NULL
                                     AND NULLIF(btrim(closure_reason),'') IS NOT NULL AND closure_disposition IS NOT NULL))
);
CREATE INDEX idx_br09_case_status ON br09_support_cases(company_id, case_status, registered_at DESC);
CREATE INDEX idx_br09_case_original ON br09_support_cases(original_job_id);

CREATE TABLE br09_case_repeat_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  case_id uuid NOT NULL,
  repeat_job_id uuid NOT NULL UNIQUE,
  linked_by_id uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, repeat_job_id),
  FOREIGN KEY (company_id, case_id) REFERENCES br09_support_cases(company_id, id),
  FOREIGN KEY (company_id, repeat_job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, linked_by_id) REFERENCES employees(company_id, id)
);

CREATE TABLE br09_technical_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  case_id uuid NOT NULL,
  repeat_job_id uuid NOT NULL,
  outcome varchar(20) NOT NULL CHECK (outcome IN
    ('REPEAT_FAULT','DIFFERENT_FAULT','USER_DAMAGE','NFF','NOT_REPAIRABLE','EXTERNAL_EVALUATION')),
  findings text NOT NULL CHECK (NULLIF(btrim(findings),'') IS NOT NULL),
  root_cause_category varchar(60),
  root_cause text,
  assessed_by_id uuid NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, case_id) REFERENCES br09_support_cases(company_id, id),
  FOREIGN KEY (company_id, repeat_job_id) REFERENCES br09_case_repeat_jobs(company_id, repeat_job_id),
  FOREIGN KEY (company_id, assessed_by_id) REFERENCES employees(company_id, id)
);
CREATE INDEX idx_br09_assessment_case ON br09_technical_assessments(case_id);

CREATE TABLE br09_claim_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  case_id uuid NOT NULL,
  resolution varchar(20) NOT NULL CHECK (resolution IN
    ('WARRANTY_REPAIR','PAID_REPAIR','GOODWILL','REPLACEMENT','REFUND_REVIEW','REJECTED','INFORMATION_ONLY')),
  decision_reason text NOT NULL CHECK (NULLIF(btrim(decision_reason),'') IS NOT NULL),
  decided_by_id uuid NOT NULL,
  decided_role_code varchar(40) NOT NULL,
  warranty_status_at_decision varchar(16) NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, case_id) REFERENCES br09_support_cases(company_id, id),
  FOREIGN KEY (company_id, decided_by_id) REFERENCES employees(company_id, id)
);
CREATE UNIQUE INDEX br09_one_current_decision ON br09_claim_decisions(case_id) WHERE is_current;

CREATE TABLE br09_goodwill_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  decision_id uuid NOT NULL UNIQUE,
  outcome varchar(10) NOT NULL CHECK (outcome IN ('APPROVED','REJECTED')),
  note text NOT NULL CHECK (NULLIF(btrim(note),'') IS NOT NULL),
  approved_by_id uuid NOT NULL,
  approver_role_code varchar(40) NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, decision_id),
  FOREIGN KEY (company_id, decision_id) REFERENCES br09_claim_decisions(company_id, id),
  FOREIGN KEY (company_id, approved_by_id) REFERENCES employees(company_id, id)
);

CREATE TABLE br09_credit_note_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  case_id uuid NOT NULL,
  decision_id uuid NOT NULL UNIQUE,
  invoice_id uuid NOT NULL,
  failed_job_id uuid NOT NULL,
  request_status varchar(12) NOT NULL DEFAULT 'REQUESTED' CHECK (request_status IN ('REQUESTED','FULFILLED','DECLINED')),
  requested_by_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  br08_credit_note_id uuid UNIQUE REFERENCES br08_credit_notes(id),
  resolved_by_id uuid,
  resolved_at timestamptz,
  decline_reason text,
  UNIQUE (company_id, decision_id),
  FOREIGN KEY (company_id, case_id) REFERENCES br09_support_cases(company_id, id),
  FOREIGN KEY (company_id, decision_id) REFERENCES br09_claim_decisions(company_id, id),
  FOREIGN KEY (company_id, invoice_id) REFERENCES br08_invoices(company_id, id),
  FOREIGN KEY (company_id, failed_job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, requested_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, resolved_by_id) REFERENCES employees(company_id, id),
  CHECK (request_status = 'REQUESTED' OR (resolved_by_id IS NOT NULL AND resolved_at IS NOT NULL)),
  CHECK ((request_status = 'FULFILLED') = (br08_credit_note_id IS NOT NULL)),
  CHECK (request_status <> 'DECLINED' OR NULLIF(btrim(decline_reason),'') IS NOT NULL)
);

CREATE TABLE br09_customer_communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  case_id uuid NOT NULL,
  comm_type varchar(16) NOT NULL CHECK (comm_type IN ('ACKNOWLEDGEMENT','STATUS_UPDATE','DECISION','RESOLUTION')),
  channel varchar(16) NOT NULL CHECK (channel IN ('EMAIL','WHATSAPP','PHONE','CUSTOMER_PORTAL','WALK_IN','OTHER')),
  summary text NOT NULL CHECK (NULLIF(btrim(summary),'') IS NOT NULL),
  sent_by_id uuid NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, case_id) REFERENCES br09_support_cases(company_id, id),
  FOREIGN KEY (company_id, sent_by_id) REFERENCES employees(company_id, id)
);
CREATE INDEX idx_br09_comm_case ON br09_customer_communications(case_id, sent_at);

CREATE TABLE br09_case_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  case_id uuid NOT NULL UNIQUE,
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  comment text,
  recorded_by_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, case_id),
  FOREIGN KEY (company_id, case_id) REFERENCES br09_support_cases(company_id, id),
  FOREIGN KEY (company_id, recorded_by_id) REFERENCES employees(company_id, id),
  CHECK (rating IS NOT NULL OR NULLIF(btrim(comment),'') IS NOT NULL)
);

-- Case SLA clocks (own table: sla_instances requires a job/inward/assignment,
-- and an unmatched case has none).
CREATE TABLE br09_case_sla (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES br09_support_cases(id),
  event_code varchar(30) NOT NULL CHECK (event_code IN ('ACKNOWLEDGEMENT','INITIAL_ASSESSMENT','RESOLUTION')),
  started_at timestamptz NOT NULL,
  due_at timestamptz,
  completed_at timestamptz,
  state varchar(10) NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','MET','BREACHED','NO_TARGET')),
  UNIQUE (case_id, event_code),
  CHECK ((state = 'OPEN') = (completed_at IS NULL))
);

-- ==============================================================================
-- Guards
CREATE OR REPLACE FUNCTION br09_stop_sla(p_case uuid, p_event text)
RETURNS void LANGUAGE sql AS $$
  UPDATE br09_case_sla
     SET completed_at=now(),
         state=CASE WHEN due_at IS NULL THEN 'NO_TARGET' WHEN now()<=due_at THEN 'MET' ELSE 'BREACHED' END
   WHERE case_id=p_case AND event_code=p_event AND completed_at IS NULL;
$$;

-- Snapshot original invoice / POD / warranty when the original job is matched.
CREATE OR REPLACE FUNCTION br09_apply_original_job(c br09_support_cases)
RETURNS br09_support_cases LANGUAGE plpgsql STABLE AS $$
DECLARE v_pod date; v_registered date;
BEGIN
  IF br08_job_customer(c.original_job_id) IS DISTINCT FROM c.customer_id THEN
    RAISE EXCEPTION 'BR09: original job belongs to a different customer than the case';
  END IF;
  IF EXISTS (SELECT 1 FROM job_repeat_links WHERE job_id=c.original_job_id) THEN
    RAISE EXCEPTION 'BR09: match the ORIGINAL job of the chain, not a repeat job';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM br08_dispatch_batch_jobs bj JOIN br08_dispatch_batches b ON b.id=bj.batch_id
                  WHERE bj.job_id=c.original_job_id AND b.batch_status='DISPATCHED') THEN
    RAISE EXCEPTION 'BR09: original job was never dispatched (BR-08) -- an after-sales case needs a delivered job';
  END IF;
  -- Original invoice: the live one, else the most recent (e.g. cancelled by a credit note).
  SELECT ij.invoice_id INTO c.original_invoice_id
    FROM br08_invoice_jobs ij JOIN br08_invoices i ON i.id=ij.invoice_id
   WHERE ij.job_id=c.original_job_id ORDER BY ij.is_live DESC, i.issued_at DESC LIMIT 1;
  SELECT p.delivered_on INTO v_pod
    FROM br08_dispatch_batch_jobs bj JOIN br08_delivery_acknowledgements p ON p.batch_id=bj.batch_id
   WHERE bj.job_id=c.original_job_id;
  v_registered := (c.registered_at AT TIME ZONE br08_company_tz(c.company_id))::date;
  c.original_pod_date := v_pod;
  c.warranty_end_date := (v_pod + interval '3 months')::date;
  c.warranty_status := CASE WHEN v_pod IS NULL THEN 'UNKNOWN'
                            WHEN v_registered <= c.warranty_end_date THEN 'IN_WARRANTY' ELSE 'OUT_OF_WARRANTY' END;
  RETURN c;
END $$;

-- Reasons a case cannot be closed yet (NULL = closable).
CREATE OR REPLACE FUNCTION br09_closure_blocker(p_case uuid)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE c br09_support_cases%ROWTYPE; d br09_claim_decisions%ROWTYPE; v_after timestamptz; v_n integer;
BEGIN
  SELECT * INTO c FROM br09_support_cases WHERE id=p_case;
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
    IF NEW.original_job_id IS NOT NULL THEN
      NEW.matched_at := now(); NEW.matched_by_id := NEW.registered_by_id;
      NEW := br09_apply_original_job(NEW);
    ELSE
      NEW.matched_at := NULL; NEW.matched_by_id := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.case_status = 'CLOSED' THEN RAISE EXCEPTION 'BR09: a closed case is immutable'; END IF;
  IF NEW.company_id<>OLD.company_id OR NEW.case_number<>OLD.case_number OR NEW.customer_id<>OLD.customer_id
     OR NEW.complaint_type<>OLD.complaint_type OR NEW.channel<>OLD.channel OR NEW.fault_description<>OLD.fault_description
     OR NEW.contact_name<>OLD.contact_name OR NEW.contact_detail<>OLD.contact_detail
     OR NEW.registered_by_id<>OLD.registered_by_id OR NEW.registered_at<>OLD.registered_at
     OR NEW.priority<>OLD.priority THEN
    RAISE EXCEPTION 'BR09: case registration fields are immutable';
  END IF;

  -- Controlled original-job match: once, by Purchase, recomputes the snapshot.
  IF NEW.original_job_id IS DISTINCT FROM OLD.original_job_id THEN
    IF OLD.original_job_id IS NOT NULL THEN RAISE EXCEPTION 'BR09: original job already matched'; END IF;
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
        OR (OLD.review_started_at IS NOT NULL AND NEW.review_started_at IS DISTINCT FROM OLD.review_started_at) THEN
    RAISE EXCEPTION 'BR09: closure/review fields change only with the status transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br09_case_ins BEFORE INSERT ON br09_support_cases
  FOR EACH ROW EXECUTE FUNCTION br09_guard_case();
CREATE TRIGGER trg_br09_case_upd BEFORE UPDATE ON br09_support_cases
  FOR EACH ROW EXECUTE FUNCTION br09_guard_case();
CREATE TRIGGER trg_br09_case_nodelete BEFORE DELETE ON br09_support_cases
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- SLA clocks: open on registration, stop on acknowledgement / review start / closure.
CREATE OR REPLACE FUNCTION br09_case_sla_events()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO br09_case_sla(case_id,event_code,started_at,due_at)
    SELECT NEW.id, e, NEW.registered_at, br09_sla_due(NEW.company_id, NEW.priority, e, NEW.registered_at)
      FROM unnest(ARRAY['ACKNOWLEDGEMENT','INITIAL_ASSESSMENT','RESOLUTION']) e;
  ELSIF NEW.case_status <> OLD.case_status THEN
    IF NEW.case_status = 'UNDER_REVIEW' THEN PERFORM br09_stop_sla(NEW.id, 'INITIAL_ASSESSMENT'); END IF;
    IF NEW.case_status = 'CLOSED' THEN
      PERFORM br09_stop_sla(NEW.id, 'INITIAL_ASSESSMENT');
      PERFORM br09_stop_sla(NEW.id, 'ACKNOWLEDGEMENT');
      PERFORM br09_stop_sla(NEW.id, 'RESOLUTION');
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_br09_case_sla AFTER INSERT OR UPDATE ON br09_support_cases
  FOR EACH ROW EXECUTE FUNCTION br09_case_sla_events();
CREATE TRIGGER trg_br09_case_sla_nodelete BEFORE DELETE ON br09_case_sla
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br09_open_case(p_case uuid, p_company uuid)
RETURNS br09_support_cases LANGUAGE plpgsql AS $$
DECLARE c br09_support_cases%ROWTYPE;
BEGIN
  SELECT * INTO c FROM br09_support_cases WHERE id=p_case FOR UPDATE;
  IF NOT FOUND OR c.company_id <> p_company THEN RAISE EXCEPTION 'BR09: case does not belong to this company'; END IF;
  IF c.case_status = 'CLOSED' THEN RAISE EXCEPTION 'BR09: case is closed'; END IF;
  RETURN c;
END $$;

CREATE OR REPLACE FUNCTION br09_guard_repeat_job()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c br09_support_cases%ROWTYPE; v_orig uuid;
BEGIN
  c := br09_open_case(NEW.case_id, NEW.company_id);
  IF NOT br08_has_role(NEW.company_id, NEW.linked_by_id, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR09: only Purchase can link a repeat job to a case';
  END IF;
  IF c.original_job_id IS NULL THEN RAISE EXCEPTION 'BR09: match the original job before linking a repeat job'; END IF;
  SELECT original_job_id INTO v_orig FROM job_repeat_links WHERE job_id=NEW.repeat_job_id;
  IF v_orig IS NULL THEN
    RAISE EXCEPTION 'BR09: job is not a BR-02 repeat return (create a new JIN/Job and link it via BR-02 first)';
  END IF;
  IF v_orig <> c.original_job_id THEN
    RAISE EXCEPTION 'BR09: repeat job belongs to a different original job than this case';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br09_repeat_job BEFORE INSERT ON br09_case_repeat_jobs
  FOR EACH ROW EXECUTE FUNCTION br09_guard_repeat_job();
CREATE TRIGGER trg_br09_repeat_job_append_only BEFORE UPDATE OR DELETE ON br09_case_repeat_jobs
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br09_guard_assessment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM br09_open_case(NEW.case_id, NEW.company_id);
  IF NOT EXISTS (SELECT 1 FROM br09_case_repeat_jobs WHERE case_id=NEW.case_id AND repeat_job_id=NEW.repeat_job_id) THEN
    RAISE EXCEPTION 'BR09: repeat job is not linked to this case';
  END IF;
  IF NOT br03_is_current_accepted_engineer(NEW.repeat_job_id, NEW.assessed_by_id) THEN
    RAISE EXCEPTION 'BR09: technical findings come from the current accepted engineer of the repeat job';
  END IF;
  NEW.assessed_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br09_assessment BEFORE INSERT ON br09_technical_assessments
  FOR EACH ROW EXECUTE FUNCTION br09_guard_assessment();
CREATE TRIGGER trg_br09_assessment_append_only BEFORE UPDATE OR DELETE ON br09_technical_assessments
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

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
    OR EXISTS (SELECT 1 FROM br09_credit_note_requests WHERE decision_id=prev.id AND request_status='DECLINED')) THEN
    RAISE EXCEPTION 'BR09: case already has a current decision (it can be replaced only after goodwill rejection or a declined credit note)';
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

CREATE OR REPLACE FUNCTION br09_apply_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c br09_support_cases%ROWTYPE;
BEGIN
  SELECT * INTO c FROM br09_support_cases WHERE id=NEW.case_id;
  IF c.case_status <> 'DECIDED' THEN
    UPDATE br09_support_cases SET case_status='DECIDED' WHERE id=NEW.case_id;
  END IF;
  -- Trigger the BR-08 credit-note path: a request for Finance, never the CN itself.
  IF NEW.resolution = 'REFUND_REVIEW' THEN
    INSERT INTO br09_credit_note_requests(company_id,case_id,decision_id,invoice_id,failed_job_id,requested_by_id)
    VALUES (NEW.company_id, NEW.case_id, NEW.id, c.original_invoice_id, c.original_job_id, NEW.decided_by_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_br09_decision BEFORE INSERT OR UPDATE ON br09_claim_decisions
  FOR EACH ROW EXECUTE FUNCTION br09_guard_decision();
CREATE TRIGGER trg_br09_decision_apply AFTER INSERT ON br09_claim_decisions
  FOR EACH ROW EXECUTE FUNCTION br09_apply_decision();
CREATE TRIGGER trg_br09_decision_nodelete BEFORE DELETE ON br09_claim_decisions
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br09_guard_goodwill()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d br09_claim_decisions%ROWTYPE;
BEGIN
  SELECT * INTO d FROM br09_claim_decisions WHERE id=NEW.decision_id;
  IF NOT FOUND OR d.company_id <> NEW.company_id THEN RAISE EXCEPTION 'BR09: decision not found in this company'; END IF;
  PERFORM br09_open_case(d.case_id, NEW.company_id);
  IF d.resolution <> 'GOODWILL' OR NOT d.is_current THEN
    RAISE EXCEPTION 'BR09: goodwill approval applies only to the current GOODWILL decision';
  END IF;
  NEW.approver_role_code := br09_assert_authority(NEW.company_id, 'GOODWILL_APPROVAL', NEW.approved_by_id);
  NEW.approved_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br09_goodwill BEFORE INSERT ON br09_goodwill_approvals
  FOR EACH ROW EXECUTE FUNCTION br09_guard_goodwill();
CREATE TRIGGER trg_br09_goodwill_append_only BEFORE UPDATE OR DELETE ON br09_goodwill_approvals
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br09_guard_cn_request()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'BR09: credit-note requests are created only by a REFUND_REVIEW claim decision';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['request_status','br08_credit_note_id','resolved_by_id','resolved_at','decline_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['request_status','br08_credit_note_id','resolved_by_id','resolved_at','decline_reason']) THEN
    RAISE EXCEPTION 'BR09: credit-note request identity is immutable';
  END IF;
  IF OLD.request_status <> 'REQUESTED' THEN RAISE EXCEPTION 'BR09: credit-note request already %', OLD.request_status; END IF;
  IF NOT br08_has_role(NEW.company_id, NEW.resolved_by_id, 'FINANCE') THEN
    RAISE EXCEPTION 'BR09: only Finance can fulfil or decline a credit-note request';
  END IF;
  IF NEW.request_status = 'FULFILLED' AND NOT EXISTS (
       SELECT 1 FROM br08_credit_notes WHERE id=NEW.br08_credit_note_id AND invoice_id=NEW.invoice_id) THEN
    RAISE EXCEPTION 'BR09: fulfilment must reference the BR-08 credit note of the requested invoice';
  END IF;
  NEW.resolved_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br09_cn_request BEFORE INSERT OR UPDATE ON br09_credit_note_requests
  FOR EACH ROW EXECUTE FUNCTION br09_guard_cn_request();
CREATE TRIGGER trg_br09_cn_request_nodelete BEFORE DELETE ON br09_credit_note_requests
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- Finance fulfils by raising the credit note THROUGH BR-08 (its triggers do the
-- Finance check, 3-month window, cancellation and payment reversal) in the same tx.
CREATE OR REPLACE FUNCTION br09_fulfil_credit_note_request(p_request uuid, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r br09_credit_note_requests%ROWTYPE; c br09_support_cases%ROWTYPE; v_cn uuid; v_repeat uuid;
BEGIN
  SELECT * INTO r FROM br09_credit_note_requests WHERE id=p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BR09: credit-note request not found'; END IF;
  IF r.request_status <> 'REQUESTED' THEN RAISE EXCEPTION 'BR09: credit-note request already %', r.request_status; END IF;
  SELECT * INTO c FROM br09_support_cases WHERE id=r.case_id;
  SELECT rj.repeat_job_id INTO v_repeat FROM br09_case_repeat_jobs rj JOIN job_repeat_links l ON l.job_id=rj.repeat_job_id
   WHERE rj.case_id=r.case_id ORDER BY l.repeat_number DESC LIMIT 1;
  INSERT INTO br08_credit_notes
    (company_id,invoice_id,customer_id,credit_note_number,credit_note_seq,fiscal_year,credit_note_date,
     reason_code,reason,failed_job_id,warranty_return_job_id,
     sub_total_paise,cgst_paise,sgst_paise,igst_paise,total_paise,issued_by_id)
  VALUES (r.company_id, r.invoice_id, c.customer_id, 'pending', 0, '0000-00', CURRENT_DATE,
          'WARRANTY_FAILURE', 'BR-09 case ' || c.case_number || ': refund review approved', r.failed_job_id, v_repeat,
          0,0,0,0,0, p_actor)
  RETURNING id INTO v_cn;
  UPDATE br09_credit_note_requests SET request_status='FULFILLED', br08_credit_note_id=v_cn, resolved_by_id=p_actor
   WHERE id=p_request;
  RETURN v_cn;
END $$;

CREATE OR REPLACE FUNCTION br09_guard_communication()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM br09_open_case(NEW.case_id, NEW.company_id);
  IF NOT br08_has_role(NEW.company_id, NEW.sent_by_id, 'SALES') THEN
    RAISE EXCEPTION 'BR09: customer communications are sent by Sales';
  END IF;
  NEW.sent_at := now();
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION br09_apply_communication()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.comm_type = 'ACKNOWLEDGEMENT' THEN PERFORM br09_stop_sla(NEW.case_id, 'ACKNOWLEDGEMENT'); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_br09_comm BEFORE INSERT ON br09_customer_communications
  FOR EACH ROW EXECUTE FUNCTION br09_guard_communication();
CREATE TRIGGER trg_br09_comm_apply AFTER INSERT ON br09_customer_communications
  FOR EACH ROW EXECUTE FUNCTION br09_apply_communication();
CREATE TRIGGER trg_br09_comm_append_only BEFORE UPDATE OR DELETE ON br09_customer_communications
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br09_guard_feedback()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM br09_support_cases WHERE id=NEW.case_id AND company_id=NEW.company_id) THEN
    RAISE EXCEPTION 'BR09: case does not belong to this company';
  END IF;
  IF NOT br08_has_role(NEW.company_id, NEW.recorded_by_id, 'SALES') THEN
    RAISE EXCEPTION 'BR09: customer feedback is recorded by Sales';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br09_feedback BEFORE INSERT ON br09_case_feedback
  FOR EACH ROW EXECUTE FUNCTION br09_guard_feedback();
CREATE TRIGGER trg_br09_feedback_append_only BEFORE UPDATE OR DELETE ON br09_case_feedback
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- ==============================================================================
-- Quality analytics (09C-08/09). RCA escalation threshold is pending (P13), so
-- these only measure; nothing escalates automatically.
CREATE OR REPLACE VIEW br09_v_repeat_failures AS
SELECT o.company_id, o.id AS original_job_id, o.job_number AS original_job_number,
       count(l.job_id) AS repeat_count, max(l.repeat_number) AS latest_repeat_number,
       array_agg(rj.job_number ORDER BY l.repeat_number) AS repeat_job_numbers,
       (SELECT array_agg(DISTINCT a.outcome) FROM br09_technical_assessments a
          WHERE a.repeat_job_id IN (SELECT job_id FROM job_repeat_links WHERE original_job_id=o.id)) AS assessment_outcomes
  FROM job_repeat_links l
  JOIN service_jobs o ON o.id=l.original_job_id
  JOIN service_jobs rj ON rj.id=l.job_id
 GROUP BY o.company_id, o.id, o.job_number;

CREATE OR REPLACE VIEW br09_v_root_cause AS
SELECT company_id, outcome, COALESCE(root_cause_category,'(uncategorised)') AS root_cause_category,
       count(*) AS assessments, count(DISTINCT case_id) AS cases
  FROM br09_technical_assessments
 GROUP BY company_id, outcome, COALESCE(root_cause_category,'(uncategorised)');

CREATE OR REPLACE VIEW br09_v_goodwill AS
SELECT d.company_id, d.case_id, c.case_number, d.id AS decision_id, d.decided_at, d.is_current,
       c.warranty_status, g.outcome AS goodwill_outcome, g.approved_by_id, g.approved_at
  FROM br09_claim_decisions d
  JOIN br09_support_cases c ON c.id=d.case_id
  LEFT JOIN br09_goodwill_approvals g ON g.decision_id=d.id
 WHERE d.resolution='GOODWILL';

CREATE OR REPLACE VIEW br09_v_feedback AS
SELECT company_id, count(*) AS responses, count(rating) AS rated,
       round(avg(rating)::numeric, 2) AS average_rating
  FROM br09_case_feedback GROUP BY company_id;
