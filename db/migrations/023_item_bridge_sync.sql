-- 023_item_bridge_sync.sql
--
-- Keeps br03_item_catalog_bridge (the BR-03 "status cache" every material line points at) in step with
-- fdn_item_master (the Item Master Purchase creates/approves via /api/masters/items). Before this, nothing
-- wrote the bridge, so no real item could ever be put on a material request (see CLAUDE.md §4i/§4j).
--
-- CLIENT-UNCONFIRMED RULES (built with the developer-recommended defaults, 12 Nov 2026; Brightech must confirm):
--   R1 status mapping (mirrors the inventory ledger's APPROVED/ACTIVE rule):
--        Item Master APPROVED | ACTIVE                -> bridge APPROVED,          is_active = true  (requestable)
--        Item Master DRAFT | UNDER_REVIEW             -> bridge PENDING_APPROVAL,  is_active = true  (not yet)
--        Item Master ON_HOLD | INACTIVE | SUPERSEDED  -> bridge INACTIVE,          is_active = false (not requestable)
--      Bridge status REJECTED is never produced (Item Master has no rejected state).
--   R2 quantities: whole numbers only. A synced row is created with allows_fraction=false, qty_precision=0.
--      Item Master has no fraction/precision field; adding one needs BR-01B owner sign-off. The sync never
--      overwrites these two columns on an existing row.
--   R3 uncatalogued parts: no "request new item" workflow. Purchase adds the item to the Item Master and it
--      syncs here on insert/approval.
--
-- ADDITIVE: new function + trigger on fdn_item_master, a backfill, and an FK the bridge always should have
-- had. No existing column, trigger or function is changed. Bridge rows are never deleted (material lines,
-- quote/reservation/PO/GRN/issue/sales lines reference them); a de-listed item's row turns INACTIVE.

-- Fail loudly (never silently delete) if the bridge holds rows the FK or the sync cannot reconcile.
DO $$
DECLARE n_orphan int; n_clash int;
BEGIN
  SELECT count(*) INTO n_orphan FROM br03_item_catalog_bridge b
   WHERE NOT EXISTS (SELECT 1 FROM fdn_item_master m WHERE m.id = b.br01_item_id);
  IF n_orphan > 0 THEN
    RAISE EXCEPTION '023: % bridge row(s) point at no fdn_item_master row; resolve them before adding the FK', n_orphan;
  END IF;
  SELECT count(*) INTO n_clash FROM br03_item_catalog_bridge b
    JOIN fdn_item_master m ON m.item_code = b.item_code AND m.id <> b.br01_item_id;
  IF n_clash > 0 THEN
    RAISE EXCEPTION '023: % bridge row(s) use an item_code that belongs to a different Item Master item', n_clash;
  END IF;
END $$;

ALTER TABLE br03_item_catalog_bridge
  ADD CONSTRAINT br03_item_catalog_bridge_item_fk FOREIGN KEY (br01_item_id) REFERENCES fdn_item_master(id);

-- R1 as data-free SQL so the trigger and the backfill share one definition.
CREATE OR REPLACE FUNCTION br03_bridge_status_for(p_status text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_status IN ('APPROVED','ACTIVE')             THEN 'APPROVED'
    WHEN p_status IN ('DRAFT','UNDER_REVIEW')          THEN 'PENDING_APPROVAL'
    ELSE 'INACTIVE'                                    -- ON_HOLD / INACTIVE / SUPERSEDED
  END
$$;

CREATE OR REPLACE FUNCTION br03_sync_item_bridge() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text := br03_bridge_status_for(NEW.status);
BEGIN
  INSERT INTO br03_item_catalog_bridge
    (br01_item_id, item_code, item_name, uom, allows_fraction, qty_precision, approval_status, is_active, last_synced_at)
  VALUES
    (NEW.id, NEW.item_code, left(NEW.standard_name, 240), NEW.base_uom, false, 0,   -- R2: whole numbers
     v_status, v_status <> 'INACTIVE', now())
  ON CONFLICT (br01_item_id) DO UPDATE
     SET item_code       = EXCLUDED.item_code,
         item_name       = EXCLUDED.item_name,
         uom             = EXCLUDED.uom,
         approval_status = EXCLUDED.approval_status,
         is_active       = EXCLUDED.is_active,
         last_synced_at  = now();
  RETURN NULL;
END $$;

CREATE TRIGGER trg_br03_sync_item_bridge
  AFTER INSERT OR UPDATE OF status, standard_name, base_uom ON fdn_item_master
  FOR EACH ROW EXECUTE FUNCTION br03_sync_item_bridge();

-- Backfill: every existing Item Master row gets (or refreshes) its bridge row.
INSERT INTO br03_item_catalog_bridge
  (br01_item_id, item_code, item_name, uom, allows_fraction, qty_precision, approval_status, is_active, last_synced_at)
SELECT m.id, m.item_code, left(m.standard_name, 240), m.base_uom, false, 0,
       br03_bridge_status_for(m.status), br03_bridge_status_for(m.status) <> 'INACTIVE', now()
  FROM fdn_item_master m
ON CONFLICT (br01_item_id) DO UPDATE
   SET item_code       = EXCLUDED.item_code,
       item_name       = EXCLUDED.item_name,
       uom             = EXCLUDED.uom,
       approval_status = EXCLUDED.approval_status,
       is_active       = EXCLUDED.is_active,
       last_synced_at  = now();

COMMENT ON TABLE br03_item_catalog_bridge IS
  'BR-03 item status cache, written ONLY by trg_br03_sync_item_bridge from fdn_item_master (023). Status mapping and whole-number quantities are CLIENT-UNCONFIRMED.';
