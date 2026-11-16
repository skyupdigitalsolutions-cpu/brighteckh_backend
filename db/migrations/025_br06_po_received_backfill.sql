-- 025_br06_po_received_backfill.sql
--
-- Frontend-gap backend pass (14 Nov 2026). DATA ONLY: no table, column, trigger or function change.
--
-- Rule confirmed by the product owner (14 Nov 2026, "all qty posted"): a supplier PO is RECEIVED once EVERY line
-- has POSTED GRN quantity (accepted + rejected + held, summed over all its GRNs) >= the ordered quantity.
-- From this release Br06Service.postGrnLine applies it on every post (advancePoIfFullyReceived). Before it, nothing
-- ever set RECEIVED, so POs that were already fully posted stayed ACKNOWLEDGED / SHIPPED. This migration applies the
-- same rule once to those rows. Idempotent (only touches ACKNOWLEDGED / SHIPPED POs that now satisfy the rule).
--
-- Audit: one activity_audit_log row per PO moved, action BR06_PO_RECEIVED_BACKFILL, actor_id NULL (system — no
-- person performed it), before/after = the PO row.

WITH eligible AS (
  SELECT p.id
    FROM br06_supplier_purchase_orders p
   WHERE p.po_status IN ('ACKNOWLEDGED', 'SHIPPED')
     AND EXISTS (SELECT 1 FROM br06_po_lines pl WHERE pl.po_id = p.id)
     AND NOT EXISTS (
       SELECT 1
         FROM br06_po_lines pl
        WHERE pl.po_id = p.id
          AND COALESCE((SELECT SUM(gl.accepted_quantity + gl.rejected_quantity + gl.held_quantity)
                          FROM br06_grn_lines gl
                         WHERE gl.po_line_id = pl.id AND gl.posted_at IS NOT NULL), 0) < pl.quantity
     )
   FOR UPDATE OF p
),
before AS (
  SELECT p.* FROM br06_supplier_purchase_orders p JOIN eligible e ON e.id = p.id
),
moved AS (
  UPDATE br06_supplier_purchase_orders p
     SET po_status = 'RECEIVED'
    FROM eligible e
   WHERE p.id = e.id
  RETURNING p.*
)
INSERT INTO activity_audit_log (company_id, actor_id, entity_table, entity_id, action, before_state, after_state)
SELECT m.company_id, NULL, 'br06_supplier_purchase_orders', m.id, 'BR06_PO_RECEIVED_BACKFILL',
       to_jsonb(b), to_jsonb(m)
  FROM moved m
  JOIN before b ON b.id = m.id;
