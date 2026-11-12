-- 013_br08_dispatch_invoicing.sql
--
-- BR-08: dispatch batch -> Delivery Challan (Job Work) -> proof of delivery ->
-- Tax Invoice -> payment receipts + allocation (partial supported) -> automatic
-- job closure on full payment; credit notes (Finance) and no-charge waivers (Sales).
--
-- No BR-08 draft schema existed in 001/003 (only br05_payment_followup_schedules,
-- which is left untouched). Rules are CLIENT-CONFIRMED from Brightech documents
-- (5 Nov 2026) plus decisions taken with the client in the build session:
--   * invoice lines = snapshot of the job's authorised BR-04 quote revision lines
--   * one invoice may cover several dispatched jobs of ONE customer
--   * dispatch batch / Delivery Challan / proof of delivery: PURCHASE
--   * credit note number CN/<PREFIX>/<seq>/<FY>; warranty window 3 months from POD date
--   * jobs close automatically when their invoice is fully paid
--   * customer without GSTIN: invoice blocked
--
-- Customer-owned equipment: dispatch posts NOTHING to the inventory ledger.
-- Money: integer paise (bigint). Quote amounts (numeric rupees, 2dp) x 100.
-- Documents (challan, invoice, credit note) are numbered by the DB, per company
-- per Indian financial year (Apr-Mar), inside the inserting transaction.

-- ==============================================================================
-- Reference: GST state codes (official list).
CREATE TABLE gst_states (
  state_code char(2) PRIMARY KEY CHECK (state_code ~ '^[0-9]{2}$'),
  state_name varchar(80) NOT NULL
);
INSERT INTO gst_states(state_code,state_name) VALUES
 ('01','Jammu and Kashmir'),('02','Himachal Pradesh'),('03','Punjab'),('04','Chandigarh'),
 ('05','Uttarakhand'),('06','Haryana'),('07','Delhi'),('08','Rajasthan'),('09','Uttar Pradesh'),
 ('10','Bihar'),('11','Sikkim'),('12','Arunachal Pradesh'),('13','Nagaland'),('14','Manipur'),
 ('15','Mizoram'),('16','Tripura'),('17','Meghalaya'),('18','Assam'),('19','West Bengal'),
 ('20','Jharkhand'),('21','Odisha'),('22','Chhattisgarh'),('23','Madhya Pradesh'),('24','Gujarat'),
 ('26','Dadra and Nagar Haveli and Daman and Diu'),('27','Maharashtra'),('29','Karnataka'),('30','Goa'),
 ('31','Lakshadweep'),('32','Kerala'),('33','Tamil Nadu'),('34','Puducherry'),
 ('35','Andaman and Nicobar Islands'),('36','Telangana'),('37','Andhra Pradesh'),('38','Ladakh'),
 ('97','Other Territory');

-- GSTIN structure: 2-digit state + 10-char PAN + entity no + 'Z' + checksum char.
CREATE OR REPLACE FUNCTION br08_gstin_ok(p_gstin text, p_state char(2))
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_gstin IS NULL OR (p_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
                             AND p_state IS NOT NULL AND left(p_gstin,2) = p_state);
$$;

-- ==============================================================================
-- Legal entity invoicing profile (config, not hardcoded).
ALTER TABLE legal_entities
  ADD COLUMN doc_prefix varchar(12) UNIQUE CHECK (doc_prefix ~ '^[A-Z0-9]{1,12}$'),
  ADD COLUMN gstin varchar(15),
  ADD COLUMN state_code char(2) REFERENCES gst_states(state_code),
  ADD COLUMN registered_address text,
  ADD COLUMN bank_account_name varchar(150),
  ADD COLUMN bank_name varchar(120),
  ADD COLUMN bank_account_no varchar(40),
  ADD COLUMN bank_ifsc varchar(11) CHECK (bank_ifsc IS NULL OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  ADD COLUMN bank_branch varchar(120),
  ADD CONSTRAINT legal_entities_gstin_check CHECK (br08_gstin_ok(gstin, state_code));

-- Client-confirmed entity names + prefixes. BLR = Karnataka (29) per client.
-- CHN state 33 (Tamil Nadu) is set from the CHN site; confirm with client.
-- GSTIN / address / bank are NOT known -> left NULL; invoicing is blocked
-- until an admin fills them (PUT /api/br08/entity-profile).
CREATE OR REPLACE FUNCTION br08_seed_entity_profile(p_company uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE legal_entities
     SET doc_prefix = COALESCE(doc_prefix, 'BIAPL'),
         legal_name = 'Brightech Industrial Automation Pvt Ltd',
         state_code = COALESCE(state_code, '29')
   WHERE id=p_company AND entity_code='BLR';
  UPDATE legal_entities
     SET doc_prefix = COALESCE(doc_prefix, 'BE'),
         legal_name = 'Brightech Engineering',
         state_code = COALESCE(state_code, '33')
   WHERE id=p_company AND entity_code='CHN';
END $$;
SELECT br08_seed_entity_profile(id) FROM legal_entities WHERE entity_code IN ('BLR','CHN');

-- Customer GST/credit fields (customer master API is a BR-01 deliverable; these
-- columns are what BR-08 needs from it). credit_days default 30 (CLAUDE.md s6).
ALTER TABLE customers
  ADD COLUMN gstin varchar(15),
  ADD COLUMN state_code char(2) REFERENCES gst_states(state_code),
  ADD COLUMN billing_address text,
  ADD COLUMN credit_days integer NOT NULL DEFAULT 30 CHECK (credit_days >= 0),
  ADD CONSTRAINT customers_gstin_check CHECK (br08_gstin_ok(gstin, state_code));

-- GST rate + HSN/SAC config. A row with quote_line_type NULL is the default;
-- a row for a specific BR-04 quote line_type overrides it. Snapshotted onto
-- each invoice line, so later edits only affect future invoices.
CREATE TABLE br08_gst_rate_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_line_type varchar(24) CHECK (quote_line_type IN
    ('REPAIR_SERVICE','MATERIAL','LABOUR','INSPECTION','TESTING','EXTERNAL','FREIGHT','OTHER')),
  hsn_sac varchar(8) NOT NULL CHECK (hsn_sac ~ '^[0-9]{4,8}$'),
  cgst_rate numeric(5,2) NOT NULL CHECK (cgst_rate >= 0),
  sgst_rate numeric(5,2) NOT NULL CHECK (sgst_rate >= 0),
  igst_rate numeric(5,2) NOT NULL CHECK (igst_rate >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cgst_rate + sgst_rate = igst_rate)
);
CREATE UNIQUE INDEX uq_br08_gst_rate_active ON br08_gst_rate_config(COALESCE(quote_line_type,'*')) WHERE is_active;
INSERT INTO br08_gst_rate_config(quote_line_type,hsn_sac,cgst_rate,sgst_rate,igst_rate)
VALUES (NULL,'998732',9,9,18);

-- ==============================================================================
-- Helpers
CREATE OR REPLACE FUNCTION br08_has_role(p_company uuid, p_employee uuid, p_role text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM employees
                  WHERE id=p_employee AND company_id=p_company AND is_active AND role_code=p_role);
$$;

CREATE OR REPLACE FUNCTION br08_company_tz(p_company uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT timezone FROM working_calendars WHERE company_id=p_company AND is_active), 'Asia/Kolkata');
$$;

CREATE OR REPLACE FUNCTION br08_local_today(p_company uuid)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE br08_company_tz(p_company))::date;
$$;

-- Indian financial year, Apr-Mar: 2026-11-05 -> '2026-27'.
CREATE OR REPLACE FUNCTION br08_fiscal_year(p_date date)
RETURNS char(7) LANGUAGE sql IMMUTABLE AS $$
  SELECT y::text || '-' || lpad(((y + 1) % 100)::text, 2, '0')
    FROM (SELECT CASE WHEN EXTRACT(MONTH FROM p_date) >= 4 THEN EXTRACT(YEAR FROM p_date)::int
                      ELSE EXTRACT(YEAR FROM p_date)::int - 1 END AS y) s;
$$;

CREATE OR REPLACE FUNCTION br08_job_customer(p_job uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT r.customer_id FROM service_jobs j JOIN inward_receipts r ON r.id=j.inward_id WHERE j.id=p_job;
$$;

-- Per-company, per-FY document counters (same atomic upsert as
-- company_number_counters, plus the FY key -- those never reset; these do).
CREATE TABLE br08_fy_counters (
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  doc_kind varchar(3) NOT NULL CHECK (doc_kind IN ('INV','DC','CN')),
  fiscal_year char(7) NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}-[0-9]{2}$'),
  last_value bigint NOT NULL CHECK (last_value >= 0),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, doc_kind, fiscal_year)
);

-- Formats (client documents):
--   INV  <PREFIX>/<seq>/<YY-YY>          BIAPL/496/26-27
--   DC   <seq>/<PREFIX>/NA/<YYYY-YY>     417/BIAPL/NA/2026-27
--   CN   CN/<PREFIX>/<seq>/<YY-YY>       CN/BIAPL/12/26-27
CREATE OR REPLACE FUNCTION br08_next_doc_number(p_company uuid, p_kind varchar, p_date date,
  OUT seq bigint, OUT fiscal_year char(7), OUT doc_number varchar)
LANGUAGE plpgsql AS $$
DECLARE v_prefix varchar; v_short text; v_fy char(7);
BEGIN
  IF p_kind NOT IN ('INV','DC','CN') THEN RAISE EXCEPTION 'BR08: invalid document kind %', p_kind; END IF;
  SELECT doc_prefix INTO v_prefix FROM legal_entities WHERE id=p_company AND is_active;
  IF v_prefix IS NULL THEN RAISE EXCEPTION 'BR08: company has no document prefix configured'; END IF;
  v_fy := br08_fiscal_year(p_date);
  INSERT INTO br08_fy_counters AS ctr (company_id,doc_kind,fiscal_year,last_value)
  VALUES (p_company,p_kind,v_fy,1)
  ON CONFLICT ON CONSTRAINT br08_fy_counters_pkey DO UPDATE
    SET last_value=ctr.last_value+1, changed_at=now()
  RETURNING ctr.last_value INTO seq;
  fiscal_year := v_fy;
  v_short := substr(v_fy,3,2) || '-' || substr(v_fy,6,2);
  doc_number := CASE p_kind
    WHEN 'INV' THEN v_prefix || '/' || seq || '/' || v_short
    WHEN 'DC'  THEN seq || '/' || v_prefix || '/NA/' || fiscal_year
    ELSE 'CN/' || v_prefix || '/' || seq || '/' || v_short END;
END $$;

-- Indian-system amount in words: 106200 paise -> 'Rupees One Thousand Sixty Two Only'.
CREATE OR REPLACE FUNCTION br08_words_below_1000(n integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  ones text[] := ARRAY['One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve',
                       'Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  tens text[] := ARRAY['','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  out text := ''; r integer := n;
BEGIN
  IF r >= 100 THEN out := ones[r / 100] || ' Hundred'; r := r % 100; END IF;
  IF r >= 20 THEN
    out := trim(out || ' ' || tens[r / 10]); r := r % 10;
  END IF;
  IF r > 0 THEN out := trim(out || ' ' || ones[r]); END IF;
  RETURN out;
END $$;

-- Integer in Indian-system words (Crore / Lakh / Thousand / Hundred).
CREATE OR REPLACE FUNCTION br08_int_in_words(p_n bigint)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE n bigint := p_n; parts text[] := '{}'; v bigint;
BEGIN
  IF n = 0 THEN RETURN 'Zero'; END IF;
  v := n / 10000000; IF v > 0 THEN parts := parts || (br08_int_in_words(v) || ' Crore'); END IF;
  n := n % 10000000;
  v := n / 100000; IF v > 0 THEN parts := parts || (br08_words_below_1000(v::int) || ' Lakh'); END IF;
  n := n % 100000;
  v := n / 1000; IF v > 0 THEN parts := parts || (br08_words_below_1000(v::int) || ' Thousand'); END IF;
  n := n % 1000;
  IF n > 0 THEN parts := parts || br08_words_below_1000(n::int); END IF;
  RETURN array_to_string(parts, ' ');
END $$;

CREATE OR REPLACE FUNCTION br08_amount_in_words(p_paise bigint)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_paise < 0 THEN RAISE EXCEPTION 'BR08: negative amount'; END IF;
  RETURN 'Rupees ' || br08_int_in_words(p_paise / 100)
         || CASE WHEN p_paise % 100 > 0 THEN ' and ' || br08_words_below_1000((p_paise % 100)::int) || ' Paise' ELSE '' END
         || ' Only';
END $$;

-- ==============================================================================
-- Dispatch batch (PURCHASE). DRAFT -> DISPATCHED (DC issued in the same tx).
CREATE TABLE br08_dispatch_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  customer_id uuid NOT NULL,
  batch_status varchar(12) NOT NULL DEFAULT 'DRAFT' CHECK (batch_status IN ('DRAFT','DISPATCHED')),
  carrier_name varchar(120) NOT NULL CHECK (NULLIF(btrim(carrier_name),'') IS NOT NULL),
  carrier_reference varchar(120),
  destination_address text NOT NULL CHECK (NULLIF(btrim(destination_address),'') IS NOT NULL),
  created_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatch_date date,
  dispatched_by_id uuid,
  dispatched_at timestamptz,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id),
  FOREIGN KEY (company_id, created_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, dispatched_by_id) REFERENCES employees(company_id, id),
  CHECK ((batch_status = 'DISPATCHED') = (dispatch_date IS NOT NULL AND dispatched_by_id IS NOT NULL AND dispatched_at IS NOT NULL))
);
CREATE INDEX idx_br08_batch_customer ON br08_dispatch_batches(company_id, customer_id, batch_status);

CREATE TABLE br08_dispatch_batch_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  batch_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE,
  dispatch_release_id uuid NOT NULL UNIQUE REFERENCES br07_dispatch_releases(id),
  added_by_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, job_id),
  FOREIGN KEY (company_id, batch_id) REFERENCES br08_dispatch_batches(company_id, id),
  FOREIGN KEY (company_id, job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, added_by_id) REFERENCES employees(company_id, id)
);
CREATE INDEX idx_br08_batch_jobs_batch ON br08_dispatch_batch_jobs(batch_id);

CREATE TABLE br08_delivery_challans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  batch_id uuid NOT NULL UNIQUE,
  challan_number varchar(60) NOT NULL UNIQUE,
  challan_seq bigint NOT NULL,
  fiscal_year char(7) NOT NULL,
  challan_type varchar(20) NOT NULL DEFAULT 'JOB_WORK' CHECK (challan_type = 'JOB_WORK'),
  challan_date date NOT NULL,
  consignor_snapshot jsonb NOT NULL CHECK (jsonb_typeof(consignor_snapshot)='object'),
  consignee_snapshot jsonb NOT NULL CHECK (jsonb_typeof(consignee_snapshot)='object'),
  carrier_snapshot jsonb NOT NULL CHECK (jsonb_typeof(carrier_snapshot)='object'),
  lines_snapshot jsonb NOT NULL CHECK (jsonb_typeof(lines_snapshot)='array' AND jsonb_array_length(lines_snapshot) > 0),
  issued_by_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, batch_id),
  UNIQUE (company_id, fiscal_year, challan_seq),
  FOREIGN KEY (company_id, batch_id) REFERENCES br08_dispatch_batches(company_id, id),
  FOREIGN KEY (company_id, issued_by_id) REFERENCES employees(company_id, id)
);

CREATE TABLE br08_delivery_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  batch_id uuid NOT NULL UNIQUE,
  received_by_name varchar(150) NOT NULL CHECK (NULLIF(btrim(received_by_name),'') IS NOT NULL),
  received_at timestamptz NOT NULL,
  delivered_on date NOT NULL,
  pod_document_uri text,
  remarks text,
  recorded_by_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, batch_id),
  FOREIGN KEY (company_id, batch_id) REFERENCES br08_dispatch_batches(company_id, id),
  FOREIGN KEY (company_id, recorded_by_id) REFERENCES employees(company_id, id)
);

CREATE OR REPLACE FUNCTION br08_guard_batch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.created_by_id, 'PURCHASE') THEN
      RAISE EXCEPTION 'BR08: only Purchase can create a dispatch batch';
    END IF;
    IF NEW.batch_status <> 'DRAFT' THEN RAISE EXCEPTION 'BR08: a dispatch batch starts as DRAFT'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_id<>OLD.company_id OR NEW.customer_id<>OLD.customer_id
     OR NEW.created_by_id<>OLD.created_by_id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'BR08: dispatch batch identity fields are immutable';
  END IF;
  IF OLD.batch_status = 'DISPATCHED' THEN
    RAISE EXCEPTION 'BR08: a dispatched batch is immutable';
  END IF;
  IF NEW.batch_status = 'DISPATCHED' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.dispatched_by_id, 'PURCHASE') THEN
      RAISE EXCEPTION 'BR08: only Purchase can dispatch a batch';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM br08_dispatch_batch_jobs WHERE batch_id=NEW.id) THEN
      RAISE EXCEPTION 'BR08: a dispatch batch needs at least one job';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM br08_delivery_challans WHERE batch_id=NEW.id AND challan_date=NEW.dispatch_date) THEN
      RAISE EXCEPTION 'BR08: the Delivery Challan must be issued at dispatch (same date)';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_batch_ins BEFORE INSERT ON br08_dispatch_batches
  FOR EACH ROW EXECUTE FUNCTION br08_guard_batch();
CREATE TRIGGER trg_br08_batch_upd BEFORE UPDATE ON br08_dispatch_batches
  FOR EACH ROW EXECUTE FUNCTION br08_guard_batch();
CREATE TRIGGER trg_br08_batch_nodelete BEFORE DELETE ON br08_dispatch_batches
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br08_guard_batch_job()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b br08_dispatch_batches%ROWTYPE; rel br07_dispatch_releases%ROWTYPE; v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO b FROM br08_dispatch_batches WHERE id=OLD.batch_id;
    IF b.batch_status <> 'DRAFT' THEN RAISE EXCEPTION 'BR08: jobs cannot be removed from a dispatched batch'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'BR08: dispatch batch job rows are immutable'; END IF;

  SELECT * INTO b FROM br08_dispatch_batches WHERE id=NEW.batch_id FOR UPDATE;
  IF NOT FOUND OR b.company_id<>NEW.company_id THEN RAISE EXCEPTION 'BR08: batch does not belong to this company'; END IF;
  IF b.batch_status <> 'DRAFT' THEN RAISE EXCEPTION 'BR08: jobs can only be added to a DRAFT batch'; END IF;
  IF NOT br08_has_role(NEW.company_id, NEW.added_by_id, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR08: only Purchase can add jobs to a dispatch batch';
  END IF;
  SELECT * INTO rel FROM br07_dispatch_releases WHERE job_id=NEW.job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'BR08: job has no BR-07 dispatch release'; END IF;
  IF rel.id <> NEW.dispatch_release_id OR rel.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'BR08: dispatch release does not match this job/company';
  END IF;
  SELECT status INTO v_status FROM service_jobs WHERE id=NEW.job_id;
  IF v_status = 'CANCELLED' THEN RAISE EXCEPTION 'BR08: a cancelled job cannot be dispatched'; END IF;
  IF br08_job_customer(NEW.job_id) IS DISTINCT FROM b.customer_id THEN
    RAISE EXCEPTION 'BR08: job belongs to a different customer than the dispatch batch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_batch_job BEFORE INSERT OR UPDATE OR DELETE ON br08_dispatch_batch_jobs
  FOR EACH ROW EXECUTE FUNCTION br08_guard_batch_job();

-- DB owns challan numbering; caller-supplied number/seq/FY/date are overwritten.
CREATE OR REPLACE FUNCTION br08_guard_challan()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b br08_dispatch_batches%ROWTYPE; n record;
BEGIN
  IF NOT br08_has_role(NEW.company_id, NEW.issued_by_id, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR08: only Purchase can issue a Delivery Challan';
  END IF;
  SELECT * INTO b FROM br08_dispatch_batches WHERE id=NEW.batch_id FOR UPDATE;
  IF NOT FOUND OR b.company_id<>NEW.company_id THEN RAISE EXCEPTION 'BR08: batch does not belong to this company'; END IF;
  IF b.batch_status <> 'DRAFT' THEN RAISE EXCEPTION 'BR08: batch already dispatched'; END IF;
  NEW.challan_date := br08_local_today(NEW.company_id);
  SELECT * INTO n FROM br08_next_doc_number(NEW.company_id, 'DC', NEW.challan_date);
  NEW.challan_seq := n.seq; NEW.fiscal_year := n.fiscal_year; NEW.challan_number := n.doc_number;
  NEW.challan_type := 'JOB_WORK';
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_challan BEFORE INSERT ON br08_delivery_challans
  FOR EACH ROW EXECUTE FUNCTION br08_guard_challan();
CREATE TRIGGER trg_br08_challan_append_only BEFORE UPDATE OR DELETE ON br08_delivery_challans
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br08_guard_pod()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b br08_dispatch_batches%ROWTYPE;
BEGIN
  IF NOT br08_has_role(NEW.company_id, NEW.recorded_by_id, 'PURCHASE') THEN
    RAISE EXCEPTION 'BR08: only Purchase can record proof of delivery';
  END IF;
  SELECT * INTO b FROM br08_dispatch_batches WHERE id=NEW.batch_id;
  IF NOT FOUND OR b.company_id<>NEW.company_id THEN RAISE EXCEPTION 'BR08: batch does not belong to this company'; END IF;
  IF b.batch_status <> 'DISPATCHED' THEN RAISE EXCEPTION 'BR08: proof of delivery needs a dispatched batch'; END IF;
  IF NEW.received_at > now() THEN RAISE EXCEPTION 'BR08: delivery time cannot be in the future'; END IF;
  IF NEW.received_at < b.dispatched_at THEN RAISE EXCEPTION 'BR08: delivery time is before the dispatch time'; END IF;
  NEW.delivered_on := (NEW.received_at AT TIME ZONE br08_company_tz(NEW.company_id))::date;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_pod BEFORE INSERT ON br08_delivery_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION br08_guard_pod();
CREATE TRIGGER trg_br08_pod_append_only BEFORE UPDATE OR DELETE ON br08_delivery_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- Dispatch: issue DC + mark batch DISPATCHED atomically. Returns the challan id.
CREATE OR REPLACE FUNCTION br08_dispatch_batch(p_batch uuid, p_actor uuid, p_carrier_reference varchar)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE b br08_dispatch_batches%ROWTYPE; v_dc uuid; v_date date;
BEGIN
  SELECT * INTO b FROM br08_dispatch_batches WHERE id=p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BR08: dispatch batch not found'; END IF;
  IF b.batch_status <> 'DRAFT' THEN RAISE EXCEPTION 'BR08: batch already dispatched'; END IF;
  IF NOT EXISTS (SELECT 1 FROM br08_dispatch_batch_jobs WHERE batch_id=p_batch) THEN
    RAISE EXCEPTION 'BR08: a dispatch batch needs at least one job';
  END IF;
  IF p_carrier_reference IS NOT NULL THEN
    UPDATE br08_dispatch_batches SET carrier_reference=p_carrier_reference WHERE id=p_batch;
    SELECT * INTO b FROM br08_dispatch_batches WHERE id=p_batch;
  END IF;

  INSERT INTO br08_delivery_challans
    (company_id,batch_id,challan_number,challan_seq,fiscal_year,challan_date,
     consignor_snapshot,consignee_snapshot,carrier_snapshot,lines_snapshot,issued_by_id)
  SELECT b.company_id, b.id, 'pending', 0, '0000-00', CURRENT_DATE,
         jsonb_build_object('legal_name', COALESCE(le.legal_name, le.name), 'gstin', le.gstin,
                            'state_code', le.state_code, 'state_name', gs.state_name, 'address', le.registered_address),
         jsonb_build_object('customer_id', c.id, 'customer_code', c.customer_code, 'name', c.customer_name,
                            'gstin', c.gstin, 'state_code', c.state_code, 'address', b.destination_address),
         jsonb_build_object('carrier_name', b.carrier_name, 'carrier_reference', b.carrier_reference),
         (SELECT jsonb_agg(jsonb_build_object(
                    'line_no', x.rn, 'job_id', x.job_id, 'job_number', x.job_number,
                    'assembly_code', x.assembly_code, 'assembly_name', x.assembly_name,
                    'serial_number', x.serial_number, 'quantity', 1, 'uom', 'NOS',
                    'nature', 'Customer-owned equipment returned after job work') ORDER BY x.rn)
            FROM (SELECT row_number() OVER (ORDER BY sj.job_number) AS rn, sj.id AS job_id, sj.job_number,
                         a.assembly_code, a.assembly_name, u.serial_number
                    FROM br08_dispatch_batch_jobs bj
                    JOIN service_jobs sj ON sj.id=bj.job_id
                    JOIN inward_equipment_units u ON u.id=sj.unit_id
                    JOIN inward_equipment_groups g ON g.id=u.group_id
                    JOIN assemblies a ON a.id=g.assembly_id
                   WHERE bj.batch_id=b.id) x),
         p_actor
    FROM legal_entities le
    JOIN customers c ON c.id=b.customer_id
    LEFT JOIN gst_states gs ON gs.state_code=le.state_code
   WHERE le.id=b.company_id
  RETURNING id, challan_date INTO v_dc, v_date;

  UPDATE br08_dispatch_batches
     SET batch_status='DISPATCHED', dispatch_date=v_date, dispatched_by_id=p_actor, dispatched_at=now()
   WHERE id=p_batch;
  RETURN v_dc;
END $$;

-- ==============================================================================
-- No-charge waiver (SALES). Closes the job without an invoice.
CREATE TABLE br08_job_waivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  job_id uuid NOT NULL UNIQUE,
  reason text NOT NULL CHECK (NULLIF(btrim(reason),'') IS NOT NULL),
  waived_by_id uuid NOT NULL,
  waived_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, job_id),
  FOREIGN KEY (company_id, job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, waived_by_id) REFERENCES employees(company_id, id)
);

-- ==============================================================================
-- Tax invoice (FINANCE). Immutable once issued: only the payment/cancellation
-- bookkeeping columns move, and only via the allocation / credit-note triggers.
CREATE TABLE br08_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  customer_id uuid NOT NULL,
  invoice_number varchar(60) NOT NULL UNIQUE,
  invoice_seq bigint NOT NULL,
  fiscal_year char(7) NOT NULL,
  invoice_date date NOT NULL,
  credit_days integer NOT NULL CHECK (credit_days >= 0),
  due_date date NOT NULL,
  supplier_legal_name varchar(200) NOT NULL,
  supplier_gstin varchar(15) NOT NULL,
  supplier_state_code char(2) NOT NULL REFERENCES gst_states(state_code),
  supplier_state_name varchar(80) NOT NULL,
  supplier_address text NOT NULL,
  customer_name varchar(200) NOT NULL,
  customer_gstin varchar(15) NOT NULL,
  customer_state_code char(2) NOT NULL REFERENCES gst_states(state_code),
  customer_address text,
  place_of_supply_state_code char(2) NOT NULL REFERENCES gst_states(state_code),
  place_of_supply_state_name varchar(80) NOT NULL,
  tax_regime varchar(12) NOT NULL CHECK (tax_regime IN ('INTRA_STATE','INTER_STATE')),
  sub_total_paise bigint NOT NULL CHECK (sub_total_paise >= 0),
  cgst_paise bigint NOT NULL CHECK (cgst_paise >= 0),
  sgst_paise bigint NOT NULL CHECK (sgst_paise >= 0),
  igst_paise bigint NOT NULL CHECK (igst_paise >= 0),
  total_paise bigint NOT NULL CHECK (total_paise >= 0),
  total_in_words text NOT NULL,
  bank_snapshot jsonb NOT NULL CHECK (jsonb_typeof(bank_snapshot)='object'),
  customer_order_refs jsonb NOT NULL CHECK (jsonb_typeof(customer_order_refs)='array'),
  amount_paid_paise bigint NOT NULL DEFAULT 0,
  invoice_status varchar(16) NOT NULL DEFAULT 'ISSUED'
    CHECK (invoice_status IN ('ISSUED','PARTIALLY_PAID','PAID','CANCELLED')),
  issued_by_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancelled_by_credit_note_id uuid,
  UNIQUE (company_id, id),
  UNIQUE (company_id, fiscal_year, invoice_seq),
  FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id),
  FOREIGN KEY (company_id, issued_by_id) REFERENCES employees(company_id, id),
  CHECK (due_date = invoice_date + credit_days),
  CHECK (total_paise = sub_total_paise + cgst_paise + sgst_paise + igst_paise),
  CHECK ((tax_regime = 'INTRA_STATE') = (place_of_supply_state_code = supplier_state_code)),
  CHECK ((tax_regime = 'INTRA_STATE' AND igst_paise = 0) OR (tax_regime = 'INTER_STATE' AND cgst_paise = 0 AND sgst_paise = 0)),
  CHECK (amount_paid_paise >= 0 AND amount_paid_paise <= total_paise),
  CHECK ((invoice_status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by_credit_note_id IS NOT NULL)),
  CHECK (invoice_status = 'CANCELLED'
         OR (invoice_status = 'ISSUED' AND amount_paid_paise = 0)
         OR (invoice_status = 'PARTIALLY_PAID' AND amount_paid_paise > 0 AND amount_paid_paise < total_paise)
         OR (invoice_status = 'PAID' AND amount_paid_paise = total_paise))
);
CREATE INDEX idx_br08_invoice_customer ON br08_invoices(company_id, customer_id, invoice_status);

CREATE TABLE br08_invoice_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  invoice_id uuid NOT NULL,
  job_id uuid NOT NULL,
  dispatch_batch_id uuid NOT NULL,
  job_authorisation_id uuid NOT NULL REFERENCES br05_job_authorisations(id),
  br04_quote_revision_id uuid NOT NULL REFERENCES br04_customer_quote_revisions(id),
  is_live boolean NOT NULL DEFAULT true,
  UNIQUE (invoice_id, job_id),
  FOREIGN KEY (company_id, invoice_id) REFERENCES br08_invoices(company_id, id),
  FOREIGN KEY (company_id, job_id) REFERENCES service_jobs(company_id, id),
  FOREIGN KEY (company_id, dispatch_batch_id) REFERENCES br08_dispatch_batches(company_id, id)
);
CREATE UNIQUE INDEX br08_one_live_invoice_per_job ON br08_invoice_jobs(job_id) WHERE is_live;

CREATE TABLE br08_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES br08_invoices(id),
  line_no integer NOT NULL CHECK (line_no > 0),
  job_id uuid NOT NULL REFERENCES service_jobs(id),
  source_quote_line_id uuid NOT NULL REFERENCES br04_customer_quote_lines(id),
  line_type varchar(24) NOT NULL,
  description text NOT NULL,
  hsn_sac varchar(8) NOT NULL,
  quantity numeric(16,4) NOT NULL CHECK (quantity > 0),
  uom varchar(18) NOT NULL,
  unit_price numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  taxable_paise bigint NOT NULL CHECK (taxable_paise >= 0),
  cgst_rate numeric(5,2) NOT NULL,
  sgst_rate numeric(5,2) NOT NULL,
  igst_rate numeric(5,2) NOT NULL,
  cgst_paise bigint NOT NULL CHECK (cgst_paise >= 0),
  sgst_paise bigint NOT NULL CHECK (sgst_paise >= 0),
  igst_paise bigint NOT NULL CHECK (igst_paise >= 0),
  line_total_paise bigint NOT NULL,
  UNIQUE (invoice_id, line_no),
  CHECK (line_total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise)
);

-- Invoice-level guard. DB owns numbering and the dates; issuer must be FINANCE.
CREATE OR REPLACE FUNCTION br08_guard_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.issued_by_id, 'FINANCE') THEN
      RAISE EXCEPTION 'BR08: only Finance can issue a tax invoice';
    END IF;
    IF NEW.invoice_status <> 'ISSUED' OR NEW.amount_paid_paise <> 0 OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'BR08: an invoice starts ISSUED and unpaid';
    END IF;
    NEW.invoice_date := br08_local_today(NEW.company_id);
    NEW.due_date := NEW.invoice_date + NEW.credit_days;
    SELECT * INTO n FROM br08_next_doc_number(NEW.company_id, 'INV', NEW.invoice_date);
    NEW.invoice_seq := n.seq; NEW.fiscal_year := n.fiscal_year; NEW.invoice_number := n.doc_number;
    NEW.issued_at := now();
    RETURN NEW;
  END IF;
  -- UPDATE: everything frozen except payment/cancellation bookkeeping, which
  -- only the allocation / credit-note triggers (nested) may change.
  IF (to_jsonb(NEW) - ARRAY['amount_paid_paise','invoice_status','cancelled_at','cancelled_by_credit_note_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['amount_paid_paise','invoice_status','cancelled_at','cancelled_by_credit_note_id']) THEN
    RAISE EXCEPTION 'BR08: an issued invoice is immutable -- corrections go through a credit note';
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'BR08: invoice payment/cancellation state is maintained only by payment allocations and credit notes';
  END IF;
  IF OLD.invoice_status = 'CANCELLED' AND (NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.cancelled_by_credit_note_id IS DISTINCT FROM OLD.cancelled_by_credit_note_id
       OR NEW.invoice_status <> 'CANCELLED') THEN
    RAISE EXCEPTION 'BR08: a cancelled invoice stays cancelled';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_invoice_ins BEFORE INSERT ON br08_invoices
  FOR EACH ROW EXECUTE FUNCTION br08_guard_invoice();
CREATE TRIGGER trg_br08_invoice_upd BEFORE UPDATE ON br08_invoices
  FOR EACH ROW EXECUTE FUNCTION br08_guard_invoice();
CREATE TRIGGER trg_br08_invoice_nodelete BEFORE DELETE ON br08_invoices
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- Child rows may only be written in the SAME transaction that created the
-- invoice (xmin check) -- after commit the invoice's content is sealed.
CREATE OR REPLACE FUNCTION br08_invoice_open_in_this_tx(p_invoice uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM br08_invoices WHERE id=p_invoice AND xmin::text = (pg_current_xact_id()::xid)::text);
$$;

CREATE OR REPLACE FUNCTION br08_guard_invoice_job()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv br08_invoices%ROWTYPE; v_cust_status text; v_asm_status text; v_job_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'is_live') IS DISTINCT FROM (to_jsonb(OLD) - 'is_live')
       OR NOT (OLD.is_live AND NOT NEW.is_live) OR pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'BR08: invoice job rows are immutable (only a credit note releases them)';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO inv FROM br08_invoices WHERE id=NEW.invoice_id;
  IF NOT FOUND OR inv.company_id<>NEW.company_id THEN RAISE EXCEPTION 'BR08: invoice does not belong to this company'; END IF;
  IF NOT br08_invoice_open_in_this_tx(NEW.invoice_id) THEN
    RAISE EXCEPTION 'BR08: an issued invoice is immutable -- jobs cannot be added after issue';
  END IF;
  IF NOT NEW.is_live THEN RAISE EXCEPTION 'BR08: invoice job starts live'; END IF;
  IF br08_job_customer(NEW.job_id) IS DISTINCT FROM inv.customer_id THEN
    RAISE EXCEPTION 'BR08: all jobs on an invoice must belong to the invoice customer';
  END IF;
  SELECT status INTO v_job_status FROM service_jobs WHERE id=NEW.job_id;
  IF v_job_status = 'CANCELLED' THEN RAISE EXCEPTION 'BR08: a cancelled job cannot be invoiced'; END IF;
  IF EXISTS (SELECT 1 FROM br08_job_waivers WHERE job_id=NEW.job_id) THEN
    RAISE EXCEPTION 'BR08: job was closed as no-charge (waiver) and cannot be invoiced';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM br08_dispatch_batch_jobs bj JOIN br08_dispatch_batches b ON b.id=bj.batch_id
                  WHERE bj.job_id=NEW.job_id AND b.id=NEW.dispatch_batch_id AND b.batch_status='DISPATCHED') THEN
    RAISE EXCEPTION 'BR08: a tax invoice is raised at-or-after dispatch -- job is not in a dispatched batch';
  END IF;
  -- D6: invoice blocked until customer AND assembly are both APPROVED.
  SELECT c.status INTO v_cust_status FROM customers c WHERE c.id=inv.customer_id;
  SELECT a.status INTO v_asm_status
    FROM service_jobs j JOIN inward_equipment_units u ON u.id=j.unit_id
    JOIN inward_equipment_groups g ON g.id=u.group_id JOIN assemblies a ON a.id=g.assembly_id
   WHERE j.id=NEW.job_id;
  IF v_cust_status IS DISTINCT FROM 'APPROVED' OR v_asm_status IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'BR08: invoice blocked until customer and assembly are both APPROVED (D6) -- customer %, assembly %',
      v_cust_status, v_asm_status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM br05_job_authorisations WHERE id=NEW.job_authorisation_id AND job_id=NEW.job_id
                    AND is_current AND authorisation_status='AUTHORISED') THEN
    RAISE EXCEPTION 'BR08: job has no current AUTHORISED BR-05 authorisation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_invoice_job BEFORE INSERT OR UPDATE ON br08_invoice_jobs
  FOR EACH ROW EXECUTE FUNCTION br08_guard_invoice_job();
CREATE TRIGGER trg_br08_invoice_job_nodelete BEFORE DELETE ON br08_invoice_jobs
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br08_guard_invoice_line()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT br08_invoice_open_in_this_tx(NEW.invoice_id) THEN
    RAISE EXCEPTION 'BR08: an issued invoice is immutable -- lines cannot be added after issue';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM br08_invoice_jobs WHERE invoice_id=NEW.invoice_id AND job_id=NEW.job_id) THEN
    RAISE EXCEPTION 'BR08: invoice line job is not on this invoice';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_invoice_line BEFORE INSERT ON br08_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION br08_guard_invoice_line();
CREATE TRIGGER trg_br08_invoice_line_append_only BEFORE UPDATE OR DELETE ON br08_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- At COMMIT: header totals must equal the lines, and there is >=1 job and line.
CREATE OR REPLACE FUNCTION br08_check_invoice_totals()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  SELECT count(*) AS n, COALESCE(sum(taxable_paise),0) AS sub, COALESCE(sum(cgst_paise),0) AS cg,
         COALESCE(sum(sgst_paise),0) AS sg, COALESCE(sum(igst_paise),0) AS ig
    INTO s FROM br08_invoice_lines WHERE invoice_id=NEW.id;
  IF s.n = 0 OR NOT EXISTS (SELECT 1 FROM br08_invoice_jobs WHERE invoice_id=NEW.id) THEN
    RAISE EXCEPTION 'BR08: an invoice needs at least one job and one line';
  END IF;
  IF s.sub <> NEW.sub_total_paise OR s.cg <> NEW.cgst_paise OR s.sg <> NEW.sgst_paise OR s.ig <> NEW.igst_paise THEN
    RAISE EXCEPTION 'BR08: invoice header totals do not match its lines';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_br08_invoice_totals AFTER INSERT ON br08_invoices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION br08_check_invoice_totals();

-- ------------------------------------------------------------------------------
-- Build (compute, no writes) the invoice for a set of jobs. Raises on every
-- blocker. Used for preview and by br08_issue_invoice.
CREATE OR REPLACE FUNCTION br08_build_invoice(p_company uuid, p_job_ids uuid[], p_credit_days integer)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  le legal_entities%ROWTYPE; c customers%ROWTYPE; v_pos_name text; v_sup_state_name text;
  v_customer uuid; v_job uuid; v_regime text; v_today date; v_credit integer;
  j record; q record; l record; rate br08_gst_rate_config%ROWTYPE;
  v_jobs jsonb := '[]'; v_lines jsonb := '[]'; v_refs jsonb := '[]';
  v_line_no integer := 0; v_taxable bigint; v_cg bigint; v_sg bigint; v_ig bigint;
  v_sub bigint := 0; v_cgt bigint := 0; v_sgt bigint := 0; v_igt bigint := 0; v_qsum numeric;
BEGIN
  IF p_job_ids IS NULL OR cardinality(p_job_ids) = 0 THEN RAISE EXCEPTION 'BR08: at least one job is required'; END IF;
  IF cardinality(p_job_ids) <> (SELECT count(DISTINCT x) FROM unnest(p_job_ids) x) THEN
    RAISE EXCEPTION 'BR08: duplicate job in invoice request';
  END IF;

  SELECT * INTO le FROM legal_entities WHERE id=p_company;
  IF le.doc_prefix IS NULL OR le.gstin IS NULL OR le.state_code IS NULL OR le.registered_address IS NULL
     OR le.bank_name IS NULL OR le.bank_account_no IS NULL OR le.bank_ifsc IS NULL THEN
    RAISE EXCEPTION 'BR08: company invoicing profile incomplete (prefix, GSTIN, state, address, bank name/account/IFSC required)';
  END IF;
  SELECT state_name INTO v_sup_state_name FROM gst_states WHERE state_code=le.state_code;

  FOREACH v_job IN ARRAY p_job_ids LOOP
    SELECT sj.id, sj.company_id, sj.job_number, sj.status, br08_job_customer(sj.id) AS customer_id,
           bj.batch_id, b.batch_status, dc.challan_number
      INTO j
      FROM service_jobs sj
      LEFT JOIN br08_dispatch_batch_jobs bj ON bj.job_id=sj.id
      LEFT JOIN br08_dispatch_batches b ON b.id=bj.batch_id
      LEFT JOIN br08_delivery_challans dc ON dc.batch_id=b.id
     WHERE sj.id=v_job;
    IF NOT FOUND OR j.company_id <> p_company THEN RAISE EXCEPTION 'BR08: job % not found in this company', v_job; END IF;
    IF v_customer IS NULL THEN v_customer := j.customer_id;
    ELSIF v_customer <> j.customer_id THEN RAISE EXCEPTION 'BR08: all jobs on an invoice must belong to one customer'; END IF;
    IF j.status = 'CANCELLED' THEN RAISE EXCEPTION 'BR08: job % is cancelled', j.job_number; END IF;
    IF EXISTS (SELECT 1 FROM br08_job_waivers WHERE job_id=v_job) THEN
      RAISE EXCEPTION 'BR08: job % was closed as no-charge (waiver) and cannot be invoiced', j.job_number;
    END IF;
    IF j.batch_id IS NULL OR j.batch_status <> 'DISPATCHED' THEN
      RAISE EXCEPTION 'BR08: a tax invoice is raised at-or-after dispatch -- job % is not in a dispatched batch', j.job_number;
    END IF;
    IF EXISTS (SELECT 1 FROM br08_invoice_jobs WHERE job_id=v_job AND is_live) THEN
      RAISE EXCEPTION 'BR08: job % is already on a live invoice', j.job_number;
    END IF;

    SELECT ja.id AS authorisation_id, ja.authorised_amount_pre_tax, a.order_id, r.id AS revision_id,
           r.freight_charge, r.inspection_fee_pre_tax, a2.assembly_status
      INTO q
      FROM br05_job_authorisations ja
      JOIN br05_order_job_allocations a ON a.id=ja.order_job_allocation_id
      JOIN br05_quote_revision_refs rr ON rr.id=a.accepted_quote_revision_id
      JOIN br04_customer_quote_revisions r ON r.id=rr.source_br04_quote_id
      CROSS JOIN LATERAL (SELECT asm.status AS assembly_status FROM service_jobs sj
                            JOIN inward_equipment_units u ON u.id=sj.unit_id
                            JOIN inward_equipment_groups g ON g.id=u.group_id
                            JOIN assemblies asm ON asm.id=g.assembly_id WHERE sj.id=v_job) a2
     WHERE ja.job_id=v_job AND ja.is_current AND ja.authorisation_status='AUTHORISED';
    IF NOT FOUND THEN RAISE EXCEPTION 'BR08: job % has no current AUTHORISED BR-05 authorisation', j.job_number; END IF;
    IF q.assembly_status <> 'APPROVED' THEN
      RAISE EXCEPTION 'BR08: invoice blocked until customer and assembly are both APPROVED (D6) -- assembly for job % is %',
        j.job_number, q.assembly_status;
    END IF;
    IF q.freight_charge <> 0 OR q.inspection_fee_pre_tax <> 0 THEN
      RAISE EXCEPTION 'BR08: job % quote has a revision-level freight/inspection fee -- quote total composition is pending client sign-off (CLAUDE.md s5); cannot invoice', j.job_number;
    END IF;
    SELECT COALESCE(sum(net_line_pre_tax),0) INTO v_qsum FROM br04_customer_quote_lines WHERE quote_revision_id=q.revision_id;
    IF v_qsum = 0 AND NOT EXISTS (SELECT 1 FROM br04_customer_quote_lines WHERE quote_revision_id=q.revision_id) THEN
      RAISE EXCEPTION 'BR08: job % authorised quote revision has no lines', j.job_number;
    END IF;
    IF v_qsum <> q.authorised_amount_pre_tax THEN
      RAISE EXCEPTION 'BR08: job % authorised amount (%) differs from the quote lines total (%) -- partial-acceptance invoicing is not defined',
        j.job_number, q.authorised_amount_pre_tax, v_qsum;
    END IF;

    v_jobs := v_jobs || jsonb_build_object('job_id', v_job, 'job_number', j.job_number, 'dispatch_batch_id', j.batch_id,
                 'challan_number', j.challan_number, 'job_authorisation_id', q.authorisation_id,
                 'br04_quote_revision_id', q.revision_id);
    v_refs := v_refs || COALESCE((SELECT jsonb_build_object('job_number', j.job_number, 'order_type', o.order_type,
                 'customer_order_ref', o.customer_order_ref, 'received_at', o.received_at,
                 'customer_email_sender', o.customer_email_sender)
                 FROM br05_customer_orders o WHERE o.id=q.order_id), '{}'::jsonb);

    FOR l IN SELECT * FROM br04_customer_quote_lines WHERE quote_revision_id=q.revision_id ORDER BY line_no LOOP
      SELECT * INTO rate FROM br08_gst_rate_config WHERE is_active AND quote_line_type=l.line_type;
      IF NOT FOUND THEN
        SELECT * INTO rate FROM br08_gst_rate_config WHERE is_active AND quote_line_type IS NULL;
      END IF;
      IF NOT FOUND THEN RAISE EXCEPTION 'BR08: no active GST rate config (default row missing)'; END IF;
      v_line_no := v_line_no + 1;
      v_taxable := round(l.net_line_pre_tax * 100)::bigint;
      v_lines := v_lines || jsonb_build_object(
        'line_no', v_line_no, 'job_id', v_job, 'source_quote_line_id', l.id, 'line_type', l.line_type,
        'description', l.line_description, 'hsn_sac', rate.hsn_sac, 'quantity', l.quantity, 'uom', l.uom,
        'unit_price', l.net_unit_price_pre_tax, 'taxable_paise', v_taxable,
        'cgst_rate', rate.cgst_rate, 'sgst_rate', rate.sgst_rate, 'igst_rate', rate.igst_rate);
    END LOOP;
  END LOOP;

  SELECT * INTO c FROM customers WHERE id=v_customer;
  IF c.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'BR08: invoice blocked until customer and assembly are both APPROVED (D6) -- customer is %', c.status;
  END IF;
  IF c.gstin IS NULL OR c.state_code IS NULL THEN
    RAISE EXCEPTION 'BR08: customer GSTIN and state are required to issue a tax invoice (unregistered customers: open decision)';
  END IF;
  SELECT state_name INTO v_pos_name FROM gst_states WHERE state_code=c.state_code;

  -- Place of supply = customer state. Same state as the issuing entity ->
  -- CGST+SGST; otherwise IGST. Never caller-supplied.
  v_regime := CASE WHEN c.state_code = le.state_code THEN 'INTRA_STATE' ELSE 'INTER_STATE' END;

  -- Tax per line, rounded half-up to the paisa; header = sum of lines.
  SELECT jsonb_agg(x.line ORDER BY (x.line->>'line_no')::int) INTO v_lines FROM (
    SELECT e || jsonb_build_object(
             'cgst_rate', CASE WHEN v_regime='INTRA_STATE' THEN (e->>'cgst_rate')::numeric ELSE 0 END,
             'sgst_rate', CASE WHEN v_regime='INTRA_STATE' THEN (e->>'sgst_rate')::numeric ELSE 0 END,
             'igst_rate', CASE WHEN v_regime='INTER_STATE' THEN (e->>'igst_rate')::numeric ELSE 0 END,
             'cgst_paise', CASE WHEN v_regime='INTRA_STATE' THEN round((e->>'taxable_paise')::numeric * (e->>'cgst_rate')::numeric / 100)::bigint ELSE 0 END,
             'sgst_paise', CASE WHEN v_regime='INTRA_STATE' THEN round((e->>'taxable_paise')::numeric * (e->>'sgst_rate')::numeric / 100)::bigint ELSE 0 END,
             'igst_paise', CASE WHEN v_regime='INTER_STATE' THEN round((e->>'taxable_paise')::numeric * (e->>'igst_rate')::numeric / 100)::bigint ELSE 0 END
           ) AS line
      FROM jsonb_array_elements(v_lines) e) x;
  SELECT jsonb_agg(e || jsonb_build_object('line_total_paise',
           (e->>'taxable_paise')::bigint + (e->>'cgst_paise')::bigint + (e->>'sgst_paise')::bigint + (e->>'igst_paise')::bigint)
           ORDER BY (e->>'line_no')::int),
         sum((e->>'taxable_paise')::bigint), sum((e->>'cgst_paise')::bigint),
         sum((e->>'sgst_paise')::bigint), sum((e->>'igst_paise')::bigint)
    INTO v_lines, v_sub, v_cgt, v_sgt, v_igt
    FROM jsonb_array_elements(v_lines) e;

  v_today := br08_local_today(p_company);
  v_credit := COALESCE(p_credit_days, c.credit_days);
  IF v_credit < 0 THEN RAISE EXCEPTION 'BR08: credit days must be >= 0'; END IF;

  RETURN jsonb_build_object(
    'company_id', p_company, 'customer_id', c.id,
    'invoice_date', v_today, 'credit_days', v_credit, 'due_date', v_today + v_credit,
    'supplier', jsonb_build_object('legal_name', COALESCE(le.legal_name, le.name), 'gstin', le.gstin,
                  'state_code', le.state_code, 'state_name', v_sup_state_name, 'address', le.registered_address),
    'customer', jsonb_build_object('name', c.customer_name, 'gstin', c.gstin, 'state_code', c.state_code,
                  'state_name', v_pos_name, 'address', c.billing_address),
    'place_of_supply', jsonb_build_object('state_code', c.state_code, 'state_name', v_pos_name),
    'tax_regime', v_regime,
    'bank', jsonb_build_object('account_name', COALESCE(le.bank_account_name, le.legal_name, le.name), 'bank_name', le.bank_name,
              'account_no', le.bank_account_no, 'ifsc', le.bank_ifsc, 'branch', le.bank_branch),
    'customer_order_refs', v_refs, 'jobs', v_jobs, 'lines', v_lines,
    'sub_total_paise', v_sub, 'cgst_paise', v_cgt, 'sgst_paise', v_sgt, 'igst_paise', v_igt,
    'total_paise', v_sub + v_cgt + v_sgt + v_igt,
    'total_in_words', br08_amount_in_words(v_sub + v_cgt + v_sgt + v_igt));
END $$;

CREATE OR REPLACE FUNCTION br08_issue_invoice(p_company uuid, p_actor uuid, p_job_ids uuid[], p_credit_days integer)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE d jsonb; v_id uuid; e jsonb;
BEGIN
  -- Serialise per job so two concurrent issues cannot both pass the live check.
  PERFORM 1 FROM service_jobs WHERE id = ANY(p_job_ids) ORDER BY id FOR UPDATE;
  d := br08_build_invoice(p_company, p_job_ids, p_credit_days);
  INSERT INTO br08_invoices
    (company_id,customer_id,invoice_number,invoice_seq,fiscal_year,invoice_date,credit_days,due_date,
     supplier_legal_name,supplier_gstin,supplier_state_code,supplier_state_name,supplier_address,
     customer_name,customer_gstin,customer_state_code,customer_address,
     place_of_supply_state_code,place_of_supply_state_name,tax_regime,
     sub_total_paise,cgst_paise,sgst_paise,igst_paise,total_paise,total_in_words,
     bank_snapshot,customer_order_refs,issued_by_id)
  VALUES (p_company, (d->>'customer_id')::uuid, 'pending', 0, '0000-00', CURRENT_DATE, (d->>'credit_days')::int,
     CURRENT_DATE + (d->>'credit_days')::int,
     d->'supplier'->>'legal_name', d->'supplier'->>'gstin', d->'supplier'->>'state_code', d->'supplier'->>'state_name',
     d->'supplier'->>'address',
     d->'customer'->>'name', d->'customer'->>'gstin', d->'customer'->>'state_code', d->'customer'->>'address',
     d->'place_of_supply'->>'state_code', d->'place_of_supply'->>'state_name', d->>'tax_regime',
     (d->>'sub_total_paise')::bigint, (d->>'cgst_paise')::bigint, (d->>'sgst_paise')::bigint,
     (d->>'igst_paise')::bigint, (d->>'total_paise')::bigint, d->>'total_in_words',
     d->'bank', d->'customer_order_refs', p_actor)
  RETURNING id INTO v_id;

  FOR e IN SELECT * FROM jsonb_array_elements(d->'jobs') LOOP
    INSERT INTO br08_invoice_jobs(company_id,invoice_id,job_id,dispatch_batch_id,job_authorisation_id,br04_quote_revision_id)
    VALUES (p_company, v_id, (e->>'job_id')::uuid, (e->>'dispatch_batch_id')::uuid,
            (e->>'job_authorisation_id')::uuid, (e->>'br04_quote_revision_id')::uuid);
  END LOOP;
  FOR e IN SELECT * FROM jsonb_array_elements(d->'lines') LOOP
    INSERT INTO br08_invoice_lines(invoice_id,line_no,job_id,source_quote_line_id,line_type,description,hsn_sac,
       quantity,uom,unit_price,taxable_paise,cgst_rate,sgst_rate,igst_rate,cgst_paise,sgst_paise,igst_paise,line_total_paise)
    VALUES (v_id, (e->>'line_no')::int, (e->>'job_id')::uuid, (e->>'source_quote_line_id')::uuid, e->>'line_type',
       e->>'description', e->>'hsn_sac', (e->>'quantity')::numeric, e->>'uom', (e->>'unit_price')::numeric,
       (e->>'taxable_paise')::bigint, (e->>'cgst_rate')::numeric, (e->>'sgst_rate')::numeric, (e->>'igst_rate')::numeric,
       (e->>'cgst_paise')::bigint, (e->>'sgst_paise')::bigint, (e->>'igst_paise')::bigint, (e->>'line_total_paise')::bigint);
  END LOOP;
  RETURN v_id;
END $$;

-- ==============================================================================
-- Payments (FINANCE): receipts + allocations. Partial payments accumulate on
-- the invoice; when an invoice reaches PAID its live jobs close (same tx).
CREATE TABLE br08_payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  customer_id uuid NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  received_on date NOT NULL,
  payment_mode varchar(30) NOT NULL CHECK (NULLIF(btrim(payment_mode),'') IS NOT NULL),
  payment_reference varchar(120),
  remarks text,
  allocated_paise bigint NOT NULL DEFAULT 0,
  recorded_by_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id),
  FOREIGN KEY (company_id, recorded_by_id) REFERENCES employees(company_id, id),
  CHECK (allocated_paise >= 0 AND allocated_paise <= amount_paise)
);
CREATE INDEX idx_br08_receipt_customer ON br08_payment_receipts(company_id, customer_id);

CREATE TABLE br08_credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  invoice_id uuid NOT NULL UNIQUE,
  customer_id uuid NOT NULL,
  credit_note_number varchar(60) NOT NULL UNIQUE,
  credit_note_seq bigint NOT NULL,
  fiscal_year char(7) NOT NULL,
  credit_note_date date NOT NULL,
  reason_code varchar(20) NOT NULL CHECK (reason_code IN ('WARRANTY_FAILURE','INVOICE_CORRECTION')),
  reason text NOT NULL CHECK (NULLIF(btrim(reason),'') IS NOT NULL),
  failed_job_id uuid REFERENCES service_jobs(id),
  warranty_start_date date,
  warranty_end_date date,
  warranty_return_job_id uuid REFERENCES service_jobs(id),
  sub_total_paise bigint NOT NULL,
  cgst_paise bigint NOT NULL,
  sgst_paise bigint NOT NULL,
  igst_paise bigint NOT NULL,
  total_paise bigint NOT NULL,
  payments_reversed_paise bigint NOT NULL DEFAULT 0 CHECK (payments_reversed_paise >= 0),
  issued_by_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, invoice_id),
  UNIQUE (company_id, fiscal_year, credit_note_seq),
  FOREIGN KEY (company_id, invoice_id) REFERENCES br08_invoices(company_id, id),
  FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id),
  FOREIGN KEY (company_id, issued_by_id) REFERENCES employees(company_id, id),
  CHECK (total_paise = sub_total_paise + cgst_paise + sgst_paise + igst_paise),
  CHECK ((reason_code = 'WARRANTY_FAILURE') = (failed_job_id IS NOT NULL)),
  CHECK (reason_code <> 'WARRANTY_FAILURE' OR (warranty_start_date IS NOT NULL AND warranty_end_date IS NOT NULL
                                               AND credit_note_date <= warranty_end_date)),
  CHECK (warranty_return_job_id IS NULL OR reason_code = 'WARRANTY_FAILURE')
);
ALTER TABLE br08_invoices ADD CONSTRAINT br08_invoices_cancelled_by_cn_fk
  FOREIGN KEY (cancelled_by_credit_note_id) REFERENCES br08_credit_notes(id);

CREATE TABLE br08_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  receipt_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise <> 0),
  allocation_kind varchar(24) NOT NULL DEFAULT 'ALLOCATION' CHECK (allocation_kind IN ('ALLOCATION','CREDIT_NOTE_REVERSAL')),
  credit_note_id uuid REFERENCES br08_credit_notes(id),
  allocated_by_id uuid NOT NULL,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, receipt_id) REFERENCES br08_payment_receipts(company_id, id),
  FOREIGN KEY (company_id, invoice_id) REFERENCES br08_invoices(company_id, id),
  FOREIGN KEY (company_id, allocated_by_id) REFERENCES employees(company_id, id),
  CHECK ((allocation_kind = 'ALLOCATION' AND amount_paise > 0 AND credit_note_id IS NULL)
      OR (allocation_kind = 'CREDIT_NOTE_REVERSAL' AND amount_paise < 0 AND credit_note_id IS NOT NULL))
);
CREATE INDEX idx_br08_alloc_invoice ON br08_payment_allocations(invoice_id);
CREATE INDEX idx_br08_alloc_receipt ON br08_payment_allocations(receipt_id);

CREATE OR REPLACE FUNCTION br08_guard_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.recorded_by_id, 'FINANCE') THEN
      RAISE EXCEPTION 'BR08: only Finance can record a payment receipt';
    END IF;
    IF NEW.received_on > br08_local_today(NEW.company_id) THEN
      RAISE EXCEPTION 'BR08: payment received date cannot be in the future';
    END IF;
    IF NEW.allocated_paise <> 0 THEN RAISE EXCEPTION 'BR08: a receipt starts unallocated'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'allocated_paise') IS DISTINCT FROM (to_jsonb(OLD) - 'allocated_paise') THEN
    RAISE EXCEPTION 'BR08: a payment receipt is immutable';
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'BR08: receipt allocated amount is maintained only by payment allocations';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_receipt_ins BEFORE INSERT ON br08_payment_receipts
  FOR EACH ROW EXECUTE FUNCTION br08_guard_receipt();
CREATE TRIGGER trg_br08_receipt_upd BEFORE UPDATE ON br08_payment_receipts
  FOR EACH ROW EXECUTE FUNCTION br08_guard_receipt();
CREATE TRIGGER trg_br08_receipt_nodelete BEFORE DELETE ON br08_payment_receipts
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br08_guard_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rc br08_payment_receipts%ROWTYPE; inv br08_invoices%ROWTYPE; v_paid bigint; v_status text; jb record;
BEGIN
  SELECT * INTO rc FROM br08_payment_receipts WHERE id=NEW.receipt_id FOR UPDATE;
  SELECT * INTO inv FROM br08_invoices WHERE id=NEW.invoice_id FOR UPDATE;
  IF rc.id IS NULL OR inv.id IS NULL OR rc.company_id<>NEW.company_id OR inv.company_id<>NEW.company_id THEN
    RAISE EXCEPTION 'BR08: receipt/invoice do not belong to this company';
  END IF;
  IF rc.customer_id <> inv.customer_id THEN
    RAISE EXCEPTION 'BR08: a receipt can only be allocated to invoices of the same customer';
  END IF;

  IF NEW.allocation_kind = 'ALLOCATION' THEN
    IF NOT br08_has_role(NEW.company_id, NEW.allocated_by_id, 'FINANCE') THEN
      RAISE EXCEPTION 'BR08: only Finance can allocate a payment';
    END IF;
    IF inv.invoice_status = 'CANCELLED' THEN RAISE EXCEPTION 'BR08: cannot allocate a payment to a cancelled invoice'; END IF;
    IF rc.allocated_paise + NEW.amount_paise > rc.amount_paise THEN
      RAISE EXCEPTION 'BR08: allocation exceeds the receipt''s unallocated amount (% paise left)', rc.amount_paise - rc.allocated_paise;
    END IF;
    IF inv.amount_paid_paise + NEW.amount_paise > inv.total_paise THEN
      RAISE EXCEPTION 'BR08: allocation exceeds the invoice balance (% paise outstanding)', inv.total_paise - inv.amount_paid_paise;
    END IF;
  ELSE
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'BR08: payment reversals are created only by a credit note';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM br08_credit_notes WHERE id=NEW.credit_note_id AND invoice_id=NEW.invoice_id) THEN
      RAISE EXCEPTION 'BR08: reversal credit note does not match the invoice';
    END IF;
  END IF;

  UPDATE br08_payment_receipts SET allocated_paise = allocated_paise + NEW.amount_paise WHERE id=rc.id;
  v_paid := inv.amount_paid_paise + NEW.amount_paise;
  v_status := CASE WHEN inv.invoice_status='CANCELLED' THEN 'CANCELLED'
                   WHEN v_paid = inv.total_paise THEN 'PAID'
                   WHEN v_paid > 0 THEN 'PARTIALLY_PAID' ELSE 'ISSUED' END;
  UPDATE br08_invoices SET amount_paid_paise=v_paid, invoice_status=v_status WHERE id=inv.id;

  -- Job closure after confirmed full payment (client decision: automatic).
  IF v_status = 'PAID' AND inv.invoice_status <> 'PAID' THEN
    FOR jb IN SELECT sj.id, sj.status FROM br08_invoice_jobs ij JOIN service_jobs sj ON sj.id=ij.job_id
               WHERE ij.invoice_id=inv.id AND ij.is_live AND sj.status NOT IN ('CLOSED','CANCELLED')
               FOR UPDATE OF sj LOOP
      UPDATE service_jobs SET status='CLOSED', closed_at=now() WHERE id=jb.id;
      INSERT INTO job_status_history(job_id,old_status,new_status,changed_by_id,reason)
      VALUES (jb.id, jb.status, 'CLOSED', NEW.allocated_by_id, 'BR08: invoice ' || inv.invoice_number || ' fully paid');
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_allocation BEFORE INSERT ON br08_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION br08_guard_allocation();
CREATE TRIGGER trg_br08_allocation_append_only BEFORE UPDATE OR DELETE ON br08_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- ------------------------------------------------------------------------------
-- Credit note (FINANCE raises + approves). Full cancellation of one invoice.
-- WARRANTY_FAILURE: the failed job must be on the invoice and the credit note
-- date within 3 months of that job's proof-of-delivery date.
-- warranty_return_job_id is the BR-09 hook: the NEW Job of the warranty return
-- (BR-02 repeat link to the failed job), optional until BR-09 lands.
CREATE OR REPLACE FUNCTION br08_guard_credit_note()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv br08_invoices%ROWTYPE; n record; v_pod date;
BEGIN
  IF NOT br08_has_role(NEW.company_id, NEW.issued_by_id, 'FINANCE') THEN
    RAISE EXCEPTION 'BR08: only Finance can raise a credit note';
  END IF;
  SELECT * INTO inv FROM br08_invoices WHERE id=NEW.invoice_id FOR UPDATE;
  IF NOT FOUND OR inv.company_id<>NEW.company_id THEN RAISE EXCEPTION 'BR08: invoice does not belong to this company'; END IF;
  IF inv.invoice_status = 'CANCELLED' THEN RAISE EXCEPTION 'BR08: invoice is already cancelled'; END IF;

  NEW.customer_id := inv.customer_id;
  NEW.sub_total_paise := inv.sub_total_paise; NEW.cgst_paise := inv.cgst_paise;
  NEW.sgst_paise := inv.sgst_paise; NEW.igst_paise := inv.igst_paise; NEW.total_paise := inv.total_paise;
  NEW.payments_reversed_paise := inv.amount_paid_paise;
  NEW.credit_note_date := br08_local_today(NEW.company_id);
  NEW.issued_at := now();

  IF NEW.reason_code = 'WARRANTY_FAILURE' THEN
    IF NOT EXISTS (SELECT 1 FROM br08_invoice_jobs WHERE invoice_id=inv.id AND job_id=NEW.failed_job_id AND is_live) THEN
      RAISE EXCEPTION 'BR08: the failed job is not on this invoice';
    END IF;
    SELECT p.delivered_on INTO v_pod
      FROM br08_invoice_jobs ij JOIN br08_delivery_acknowledgements p ON p.batch_id=ij.dispatch_batch_id
     WHERE ij.invoice_id=inv.id AND ij.job_id=NEW.failed_job_id;
    IF v_pod IS NULL THEN
      RAISE EXCEPTION 'BR08: no proof of delivery recorded for the failed job -- the 3-month warranty has not started';
    END IF;
    NEW.warranty_start_date := v_pod;
    NEW.warranty_end_date := (v_pod + interval '3 months')::date;
    IF NEW.credit_note_date > NEW.warranty_end_date THEN
      RAISE EXCEPTION 'BR08: outside the 3-month warranty (delivered %, warranty ended %)', v_pod, NEW.warranty_end_date;
    END IF;
    IF NEW.warranty_return_job_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM job_repeat_links l JOIN service_jobs sj ON sj.id=l.job_id
          WHERE l.job_id=NEW.warranty_return_job_id AND sj.company_id=NEW.company_id
            AND (l.original_job_id=NEW.failed_job_id OR l.previous_job_id=NEW.failed_job_id)) THEN
      RAISE EXCEPTION 'BR08: warranty return job is not a BR-02 repeat of the failed job';
    END IF;
  ELSE
    NEW.failed_job_id := NULL; NEW.warranty_start_date := NULL; NEW.warranty_end_date := NULL;
    NEW.warranty_return_job_id := NULL;
  END IF;

  SELECT * INTO n FROM br08_next_doc_number(NEW.company_id, 'CN', NEW.credit_note_date);
  NEW.credit_note_seq := n.seq; NEW.fiscal_year := n.fiscal_year; NEW.credit_note_number := n.doc_number;
  RETURN NEW;
END $$;

-- After insert: cancel the invoice, release its jobs, and return every rupee
-- already allocated to it back to the originating receipts (customer credit).
CREATE OR REPLACE FUNCTION br08_apply_credit_note()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  UPDATE br08_invoices SET invoice_status='CANCELLED', cancelled_at=now(), cancelled_by_credit_note_id=NEW.id
   WHERE id=NEW.invoice_id;
  UPDATE br08_invoice_jobs SET is_live=false WHERE invoice_id=NEW.invoice_id AND is_live;
  FOR a IN SELECT receipt_id, sum(amount_paise) AS net FROM br08_payment_allocations
            WHERE invoice_id=NEW.invoice_id GROUP BY receipt_id HAVING sum(amount_paise) > 0 LOOP
    INSERT INTO br08_payment_allocations(company_id,receipt_id,invoice_id,amount_paise,allocation_kind,credit_note_id,allocated_by_id)
    VALUES (NEW.company_id, a.receipt_id, NEW.invoice_id, -a.net, 'CREDIT_NOTE_REVERSAL', NEW.id, NEW.issued_by_id);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_br08_credit_note BEFORE INSERT ON br08_credit_notes
  FOR EACH ROW EXECUTE FUNCTION br08_guard_credit_note();
CREATE TRIGGER trg_br08_credit_note_apply AFTER INSERT ON br08_credit_notes
  FOR EACH ROW EXECUTE FUNCTION br08_apply_credit_note();
CREATE TRIGGER trg_br08_credit_note_append_only BEFORE UPDATE OR DELETE ON br08_credit_notes
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- ------------------------------------------------------------------------------
-- Waiver guard (SALES) + closure.
CREATE OR REPLACE FUNCTION br08_guard_waiver()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF NOT br08_has_role(NEW.company_id, NEW.waived_by_id, 'SALES') THEN
    RAISE EXCEPTION 'BR08: only Sales can close a job as no-charge (waiver)';
  END IF;
  SELECT status INTO v_status FROM service_jobs WHERE id=NEW.job_id AND company_id=NEW.company_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'BR08: job not found in this company'; END IF;
  IF v_status IN ('CLOSED','CANCELLED') THEN RAISE EXCEPTION 'BR08: job is already %', v_status; END IF;
  IF EXISTS (SELECT 1 FROM br08_invoice_jobs WHERE job_id=NEW.job_id AND is_live) THEN
    RAISE EXCEPTION 'BR08: job is on a live invoice -- cancel it via a credit note before waiving';
  END IF;
  NEW.waived_at := now();
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION br08_apply_waiver()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_old text;
BEGIN
  SELECT status INTO v_old FROM service_jobs WHERE id=NEW.job_id;
  UPDATE service_jobs SET status='CLOSED', closed_at=now() WHERE id=NEW.job_id;
  INSERT INTO job_status_history(job_id,old_status,new_status,changed_by_id,reason)
  VALUES (NEW.job_id, v_old, 'CLOSED', NEW.waived_by_id, 'BR08: no-charge waiver -- ' || NEW.reason);
  RETURN NULL;
END $$;
CREATE TRIGGER trg_br08_waiver BEFORE INSERT ON br08_job_waivers
  FOR EACH ROW EXECUTE FUNCTION br08_guard_waiver();
CREATE TRIGGER trg_br08_waiver_apply AFTER INSERT ON br08_job_waivers
  FOR EACH ROW EXECUTE FUNCTION br08_apply_waiver();
CREATE TRIGGER trg_br08_waiver_append_only BEFORE UPDATE OR DELETE ON br08_job_waivers
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- ------------------------------------------------------------------------------
-- Entity profile: prefix / state / GSTIN are frozen once any BR-08 document
-- exists for the company (they are part of issued document numbers / tax basis).
CREATE OR REPLACE FUNCTION br08_guard_entity_profile()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.doc_prefix IS DISTINCT FROM OLD.doc_prefix OR NEW.state_code IS DISTINCT FROM OLD.state_code
      OR NEW.gstin IS DISTINCT FROM OLD.gstin)
     AND EXISTS (SELECT 1 FROM br08_fy_counters WHERE company_id=OLD.id AND last_value > 0) THEN
    RAISE EXCEPTION 'BR08: document prefix, state and GSTIN are frozen once BR-08 documents have been issued';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br08_entity_profile BEFORE UPDATE ON legal_entities
  FOR EACH ROW EXECUTE FUNCTION br08_guard_entity_profile();

-- ------------------------------------------------------------------------------
-- Read model: per-job billing state.
CREATE OR REPLACE VIEW br08_v_job_billing AS
SELECT sj.company_id, sj.id AS job_id, sj.job_number, sj.status AS job_status, sj.closed_at,
       bj.batch_id AS dispatch_batch_id, b.batch_status, dc.challan_number, b.dispatch_date,
       pod.delivered_on,
       ij.invoice_id, inv.invoice_number, inv.invoice_status, inv.total_paise, inv.amount_paid_paise,
       (inv.total_paise - inv.amount_paid_paise) AS balance_paise, inv.due_date,
       w.id AS waiver_id
  FROM service_jobs sj
  LEFT JOIN br08_dispatch_batch_jobs bj ON bj.job_id=sj.id
  LEFT JOIN br08_dispatch_batches b ON b.id=bj.batch_id
  LEFT JOIN br08_delivery_challans dc ON dc.batch_id=b.id
  LEFT JOIN br08_delivery_acknowledgements pod ON pod.batch_id=b.id
  LEFT JOIN br08_invoice_jobs ij ON ij.job_id=sj.id AND ij.is_live
  LEFT JOIN br08_invoices inv ON inv.id=ij.invoice_id
  LEFT JOIN br08_job_waivers w ON w.job_id=sj.id;
