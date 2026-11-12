-- 004_prisma_relation_fix.sql
--
-- Purely technical, additive fix for Prisma Client codegen (`prisma generate`).
-- Prisma's relation engine requires a composite unique index that exactly
-- matches a multi-column FK's fields before it will treat the relation as
-- one-to-one. Both FKs below are already functionally one-to-one because the
-- single non-tenant column in the FK is already globally UNIQUE:
--
--   - br05_job_releases.job_authorisation_id  (@unique)
--   - service_jobs.unit_id                    (@unique — "one Job ID per
--     physical unit", CLAUDE.md section 3)
--
-- These composite indexes add no new constraint semantics: they are implied
-- by the existing single-column UNIQUE constraints. No business rule is
-- being introduced here.

ALTER TABLE br05_job_releases
  ADD CONSTRAINT br05_job_releases_company_job_authorisation_uniq
  UNIQUE (company_id, job_authorisation_id);

ALTER TABLE service_jobs
  ADD CONSTRAINT service_jobs_company_inward_unit_uniq
  UNIQUE (company_id, inward_id, unit_id);
