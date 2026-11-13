-- 024_activity_audit_read_indexes.sql
--
-- Purchase desk read pass (13 Nov 2026). ADDITIVE ONLY: three indexes, no table, column, trigger or
-- function changes. activity_audit_log (append-only, grows with every write in every module) had no
-- index besides its primary key, and two new reads query it:
--   * GET /api/overview/purchase  -> latest 10 rows of a company           (company_id, changed_at DESC)
--   * GET /api/jobs (last_activity_at) -> latest row about a job, matched by
--       entity_id = job id                                                  (entity_id, changed_at DESC)
--       or a top-level after_state.job_id = job id (the job-owning row)     partial expression index
-- Without them both are sequential scans of the whole audit log per request / per listed job.

CREATE INDEX IF NOT EXISTS activity_audit_log_company_changed_idx
  ON activity_audit_log (company_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS activity_audit_log_entity_changed_idx
  ON activity_audit_log (entity_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS activity_audit_log_after_job_idx
  ON activity_audit_log ((after_state->>'job_id'), changed_at DESC)
  WHERE after_state ? 'job_id';
