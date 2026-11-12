-- 019_br11_prisma_relation_fix.sql
--
-- Purely technical, additive fix for Prisma Client codegen -- same pattern as
-- 004 / 010. br11_company_policies.company_id is the PRIMARY KEY, so the
-- composite FK (company_id, updated_by_id) -> employees is already functionally
-- one-to-one; Prisma needs a unique index matching the FK fields exactly.
-- Implied by the PK; no new constraint semantics, no business rule.
ALTER TABLE br11_company_policies
  ADD CONSTRAINT br11_company_policies_company_updated_by_uniq UNIQUE (company_id, updated_by_id);
