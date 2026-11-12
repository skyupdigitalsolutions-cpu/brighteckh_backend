-- 012_working_calendar.sql
--
-- Activates the working calendar (CLAUDE.md section 5 blocker, now
-- CLIENT-CONFIRMED, 5 Nov 2026):
--   Both companies (BLR + CHN): Mon-Sat working.
--   Mon-Fri 09:30-18:30, Saturday 09:30-16:00.
--   Lunch 13:30-14:15 excluded from working time (every working day).
--   ~12 government holidays/year -- NOT preset: admins add dates as they occur.
--
-- 001 already shipped working_calendars (one start/end pair for every day, no
-- break) + calendar_holidays. Neither can express "Saturday ends earlier" or a
-- lunch break, so this migration is ADDITIVE:
--   * working_calendar_day_rules: per-ISO-weekday hours + optional break. These
--     rows are AUTHORITATIVE for working-time math. working_calendars.working_dow /
--     start_local / end_local are kept as a summary envelope (they are NOT NULL
--     in 001) and are not read by any function here.
--   * one active calendar per company (partial unique index).
--   * calendar_holidays gets who/when columns; removal limited to future dates.
--
-- Working-time semantics (decided with the client 5 Nov 2026):
--   * WORKING_HOUR / minute targets: count forward through working segments only
--     (lunch, non-working days and holidays contribute zero minutes).
--   * WORKING_DAY targets: "same local clock time on the Nth next working day".
--     The start is first normalised to the next working instant (a clock started
--     on Sunday or after hours effectively starts at the next opening). If that
--     clock time is past the target day's close (e.g. Fri 17:00 -> Saturday, which
--     closes at 16:00) the due time is clamped to the target day's close.
--
-- Functions return NULL when the company has no active calendar, so callers keep
-- their existing "not computable" handling for any company not yet configured.

-- ==============================================================================
ALTER TABLE working_calendars
  ADD COLUMN calendar_name varchar(80),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX uq_working_calendar_one_active ON working_calendars(company_id) WHERE is_active;

CREATE TABLE working_calendar_day_rules (
  calendar_id uuid NOT NULL REFERENCES working_calendars(id),
  iso_dow smallint NOT NULL CHECK (iso_dow BETWEEN 1 AND 7),
  start_local time NOT NULL,
  end_local time NOT NULL,
  break_start_local time,
  break_end_local time,
  PRIMARY KEY (calendar_id, iso_dow),
  CHECK (start_local < end_local),
  CHECK ((break_start_local IS NULL) = (break_end_local IS NULL)),
  CHECK (break_start_local IS NULL OR
         (start_local <= break_start_local AND break_start_local < break_end_local AND break_end_local <= end_local))
);

ALTER TABLE calendar_holidays
  ADD COLUMN created_by_id uuid REFERENCES employees(id),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- Removing a holiday that has already passed would silently change the meaning
-- of deadlines computed across it; only future holidays may be removed.
CREATE OR REPLACE FUNCTION cal_guard_holiday_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tz text;
BEGIN
  SELECT timezone INTO v_tz FROM working_calendars WHERE id=OLD.calendar_id;
  IF OLD.holiday_date <= (now() AT TIME ZONE COALESCE(v_tz,'Asia/Kolkata'))::date THEN
    RAISE EXCEPTION 'CAL: only future holidays can be removed (% has started or passed)', OLD.holiday_date;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_cal_holiday_delete BEFORE DELETE ON calendar_holidays
  FOR EACH ROW EXECUTE FUNCTION cal_guard_holiday_delete();
CREATE TRIGGER trg_cal_holiday_noupdate BEFORE UPDATE ON calendar_holidays
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- ==============================================================================
-- Is local date d a working day for this calendar? (has a rule, not a holiday)
CREATE OR REPLACE FUNCTION cal_is_working_date(p_calendar uuid, p_date date)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM working_calendar_day_rules
                  WHERE calendar_id=p_calendar AND iso_dow=EXTRACT(ISODOW FROM p_date)::smallint)
     AND NOT EXISTS (SELECT 1 FROM calendar_holidays WHERE calendar_id=p_calendar AND holiday_date=p_date);
$$;

-- p_from + p_minutes of WORKING time. p_minutes = 0 returns the first working
-- instant at-or-after p_from. NULL when the company has no active calendar.
CREATE OR REPLACE FUNCTION cal_add_working_minutes(p_company uuid, p_from timestamptz, p_minutes numeric)
RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_cal uuid; v_tz text;
  v_cursor timestamp;          -- local wall-clock position
  v_date date;
  v_remaining numeric := p_minutes;
  r working_calendar_day_rules%ROWTYPE;
  v_seg_s timestamp; v_seg_e timestamp; v_avail numeric;
  v_guard integer := 0; k integer;
BEGIN
  IF p_from IS NULL OR p_minutes IS NULL THEN RETURN NULL; END IF;
  IF p_minutes < 0 THEN RAISE EXCEPTION 'CAL: working minutes must be >= 0'; END IF;
  SELECT id, timezone INTO v_cal, v_tz FROM working_calendars WHERE company_id=p_company AND is_active;
  IF v_cal IS NULL THEN RETURN NULL; END IF;

  v_cursor := p_from AT TIME ZONE v_tz;
  v_date := v_cursor::date;
  LOOP
    v_guard := v_guard + 1;
    IF v_guard > 3700 THEN RAISE EXCEPTION 'CAL: no working time found within 10 years (calendar has no working days?)'; END IF;
    IF cal_is_working_date(v_cal, v_date) THEN
      SELECT * INTO r FROM working_calendar_day_rules WHERE calendar_id=v_cal AND iso_dow=EXTRACT(ISODOW FROM v_date)::smallint;
      FOR k IN 1..2 LOOP
        IF k = 1 THEN
          v_seg_s := v_date + r.start_local;
          v_seg_e := v_date + COALESCE(r.break_start_local, r.end_local);
        ELSE
          EXIT WHEN r.break_start_local IS NULL;
          v_seg_s := v_date + r.break_end_local;
          v_seg_e := v_date + r.end_local;
        END IF;
        IF v_seg_e > v_cursor THEN
          v_seg_s := GREATEST(v_seg_s, v_cursor);
          v_avail := EXTRACT(EPOCH FROM (v_seg_e - v_seg_s)) / 60.0;
          IF v_remaining <= v_avail THEN
            RETURN (v_seg_s + make_interval(secs => v_remaining * 60)) AT TIME ZONE v_tz;
          END IF;
          v_remaining := v_remaining - v_avail;
          v_cursor := v_seg_e;
        END IF;
      END LOOP;
    END IF;
    v_date := v_date + 1;
    v_cursor := GREATEST(v_cursor, v_date::timestamp);
  END LOOP;
END $$;

-- Same local clock time on the p_days-th next working day (see header).
CREATE OR REPLACE FUNCTION cal_add_working_days(p_company uuid, p_from timestamptz, p_days integer)
RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_cal uuid; v_tz text; v_start timestamptz; v_local timestamp; v_tod time; v_date date;
  r working_calendar_day_rules%ROWTYPE; v_n integer := 0; v_guard integer := 0;
BEGIN
  IF p_from IS NULL OR p_days IS NULL THEN RETURN NULL; END IF;
  IF p_days < 0 THEN RAISE EXCEPTION 'CAL: working days must be >= 0'; END IF;
  SELECT id, timezone INTO v_cal, v_tz FROM working_calendars WHERE company_id=p_company AND is_active;
  IF v_cal IS NULL THEN RETURN NULL; END IF;

  v_start := cal_add_working_minutes(p_company, p_from, 0);   -- normalise to a working instant
  v_local := v_start AT TIME ZONE v_tz;
  v_tod := v_local::time;
  v_date := v_local::date;
  WHILE v_n < p_days LOOP
    v_guard := v_guard + 1;
    IF v_guard > 3700 THEN RAISE EXCEPTION 'CAL: no working day found within 10 years'; END IF;
    v_date := v_date + 1;
    IF cal_is_working_date(v_cal, v_date) THEN v_n := v_n + 1; END IF;
  END LOOP;
  SELECT * INTO r FROM working_calendar_day_rules WHERE calendar_id=v_cal AND iso_dow=EXTRACT(ISODOW FROM v_date)::smallint;
  IF v_tod > r.end_local THEN v_tod := r.end_local; END IF;
  IF v_tod < r.start_local THEN v_tod := r.start_local; END IF;
  RETURN (v_date + v_tod) AT TIME ZONE v_tz;
END $$;

-- ==============================================================================
-- Client-confirmed schedule (both companies). Idempotent: does nothing if the
-- company already has an active calendar. Called below for existing BLR/CHN rows
-- and by the dev seed for companies created later.
CREATE OR REPLACE FUNCTION cal_seed_client_calendar(p_company uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; d smallint;
BEGIN
  SELECT id INTO v_id FROM working_calendars WHERE company_id=p_company AND is_active;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO working_calendars(company_id,timezone,working_dow,start_local,end_local,is_active,calendar_name)
  VALUES (p_company,'Asia/Kolkata','{1,2,3,4,5,6}','09:30','18:30',true,'Brightech standard (client-confirmed 2026-11-05)')
  RETURNING id INTO v_id;
  FOR d IN 1..5 LOOP
    INSERT INTO working_calendar_day_rules(calendar_id,iso_dow,start_local,end_local,break_start_local,break_end_local)
    VALUES (v_id,d,'09:30','18:30','13:30','14:15');
  END LOOP;
  INSERT INTO working_calendar_day_rules(calendar_id,iso_dow,start_local,end_local,break_start_local,break_end_local)
  VALUES (v_id,6,'09:30','16:00','13:30','14:15');
  RETURN v_id;
END $$;

SELECT cal_seed_client_calendar(id) FROM legal_entities WHERE entity_code IN ('BLR','CHN');

-- ==============================================================================
-- BR-07 test-start SLA due time from br07_test_sla_targets (data, unchanged).
CREATE OR REPLACE FUNCTION br07_test_sla_due(p_company uuid, p_priority varchar, p_from timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE t br07_test_sla_targets%ROWTYPE;
BEGIN
  SELECT * INTO t FROM br07_test_sla_targets WHERE priority=p_priority;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF t.target_unit = 'WORKING_HOUR' THEN
    RETURN cal_add_working_minutes(p_company, p_from, t.target_amount * 60);
  END IF;
  RETURN cal_add_working_days(p_company, p_from, t.target_amount);
END $$;

-- BR-03 engineer self-edit deadline: 1 WORKING hour after submit (the other
-- half of the rule -- "or the moment Purchase starts processing" -- is already
-- enforced by br03_can_engineer_edit()).
CREATE OR REPLACE FUNCTION br03_self_edit_deadline(p_company uuid, p_submitted_at timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT cal_add_working_minutes(p_company, p_submitted_at, 60);
$$;
