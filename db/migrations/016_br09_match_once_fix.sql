-- 016_br09_match_once_fix.sql
--
-- Correction to 015 (already applied): br09_guard_case() only rejected a
-- re-match when original_job_id CHANGED, so re-sending the same job id was a
-- silent no-op instead of an error. The match is "once": any attempt to set
-- matched_by_id on an already-matched case is now rejected too.
-- Replaces only the guard function body; triggers are unchanged.

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
