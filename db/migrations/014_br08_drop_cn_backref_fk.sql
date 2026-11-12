-- 014_br08_drop_cn_backref_fk.sql
--
-- Purely technical fix to 013 (already applied, so corrected here, not edited).
-- br08_invoices.cancelled_by_credit_note_id -> br08_credit_notes(id) together with
-- br08_credit_notes.invoice_id -> br08_invoices(id) formed a two-table FK cycle,
-- which scripts/test-clean.js (FK-ordered staging cleanup) cannot order.
--
-- The back-reference FK adds no protection the triggers do not already give:
--   * the column is written ONLY by br08_apply_credit_note() (AFTER INSERT on
--     br08_credit_notes), with that credit note's own NEW.id;
--   * br08_guard_invoice() rejects any change to it outside a nested trigger and
--     freezes it once the invoice is CANCELLED;
--   * br08_credit_notes.invoice_id (UNIQUE, FK) remains the authoritative link.
-- No business rule changes.

ALTER TABLE br08_invoices DROP CONSTRAINT br08_invoices_cancelled_by_cn_fk;
