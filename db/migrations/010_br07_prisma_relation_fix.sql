-- 010_br07_prisma_relation_fix.sql
--
-- Purely technical, additive fix for Prisma Client codegen -- same pattern as
-- 004. Both FKs below are already functionally one-to-one because job_id is
-- already UNIQUE on its own:
--
--   - br07_repair_reports.job_id      (one repair report identity per job)
--   - br07_dispatch_releases.job_id   (one dispatch release per job)
--
-- The composite unique indexes add no new constraint semantics. No business
-- rule is introduced here.

ALTER TABLE br07_repair_reports
  ADD CONSTRAINT br07_repair_reports_company_job_uniq UNIQUE (company_id, job_id);

ALTER TABLE br07_dispatch_releases
  ADD CONSTRAINT br07_dispatch_releases_company_job_uniq UNIQUE (company_id, job_id);
