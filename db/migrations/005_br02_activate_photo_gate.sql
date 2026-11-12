-- 005_br02_activate_photo_gate.sql
--
-- Activates the photo-before-verify gate confirmed in CLAUDE.md section 3:
-- "a unit cannot be verified without its inspection photo."
--
-- The guard function br02_guard_unit_verification() was already shipped in
-- migration 001 but its trigger was deliberately left uncreated, pending a
-- decision on a *minimum photo count*. That is a different, broader question
-- than the one CLAUDE.md already confirms: the function only checks that AT
-- LEAST ONE photo row exists for the unit, which is exactly the confirmed
-- rule. No change to the function; this migration only wires up the trigger.

CREATE TRIGGER trg_br02_unit_verification BEFORE UPDATE OF verification_status
ON inward_equipment_units FOR EACH ROW EXECUTE FUNCTION br02_guard_unit_verification();
