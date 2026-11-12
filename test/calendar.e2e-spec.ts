import { Client } from 'pg';
import { api, db, Fixtures, fails, ok, RUN, setupFixtures } from './helpers';

/**
 * Working calendar (migration 012), client-confirmed for BLR + CHN:
 *   Mon-Fri 09:30-18:30, Sat 09:30-16:00, lunch 13:30-14:15 excluded, Sunday off,
 *   holidays configurable (no preset list).
 * Reference week: Fri 2026-11-06, Sat 07, Sun 08, Mon 09, Tue 10, Wed 11 (IST).
 */
describe('Working calendar', () => {
  let c: Client;
  let f: Fixtures;
  beforeAll(async () => { c = await db(); f = await setupFixtures(c); });
  afterAll(() => c?.end());

  const due = async (from: string, q: { minutes?: number; days?: number }) => {
    const qs = new URLSearchParams({ from, ...(q.minutes !== undefined ? { minutes: String(q.minutes) } : { days: String(q.days) }) });
    return ok(await api('get', `/calendars/working-time?${qs}`, f.purchase)).due_at as string;
  };
  const same = (a: string, b: string) => expect(new Date(a).getTime()).toBe(new Date(b).getTime());

  it('BLR calendar: Mon-Sat, Saturday closes 16:00, lunch 13:30-14:15 every working day', async () => {
    const cal = ok(await api('get', '/calendars/current', f.engineer));
    expect(cal.is_active).toBe(true);
    expect(cal.timezone).toBe('Asia/Kolkata');
    expect(cal.day_rules.map((r: any) => r.iso_dow)).toEqual([1, 2, 3, 4, 5, 6]); // no Sunday
    for (const r of cal.day_rules) {
      expect(r.start_local).toBe('09:30:00');
      expect(r.end_local).toBe(r.iso_dow === 6 ? '16:00:00' : '18:30:00');
      expect([r.break_start_local, r.break_end_local]).toEqual(['13:30:00', '14:15:00']);
    }
  });

  it('working minutes skip lunch, close of day, Sunday', async () => {
    same(await due('2026-11-06T17:00:00+05:30', { minutes: 120 }), '2026-11-07T10:00:00+05:30'); // Fri 90m + Sat 30m
    same(await due('2026-11-09T13:00:00+05:30', { minutes: 60 }), '2026-11-09T14:45:00+05:30');  // 30m, lunch, 30m
    same(await due('2026-11-07T15:30:00+05:30', { minutes: 60 }), '2026-11-09T10:00:00+05:30');  // Sat close 16:00, Sun off
    same(await due('2026-11-09T20:00:00+05:30', { minutes: 60 }), '2026-11-10T10:30:00+05:30');  // after hours -> next opening
    same(await due('2026-11-09T13:45:00+05:30', { minutes: 0 }), '2026-11-09T14:15:00+05:30');   // inside lunch -> lunch end
  });

  it('working days = same clock time on the next working day (clamped to that day\'s close)', async () => {
    same(await due('2026-11-10T11:00:00+05:30', { days: 1 }), '2026-11-11T11:00:00+05:30'); // Tue -> Wed
    same(await due('2026-11-07T10:00:00+05:30', { days: 1 }), '2026-11-09T10:00:00+05:30'); // Sat -> Mon
    same(await due('2026-11-06T17:00:00+05:30', { days: 1 }), '2026-11-07T16:00:00+05:30'); // Fri 17:00 -> Sat close
    same(await due('2026-11-08T12:00:00+05:30', { days: 1 }), '2026-11-10T09:30:00+05:30'); // Sun -> Mon 09:30 -> Tue
  });

  it('holidays are excluded from working time (DB function; rolled back)', async () => {
    await c.query('BEGIN');
    try {
      await c.query(
        `INSERT INTO calendar_holidays(calendar_id,holiday_date,description)
         SELECT id,'2026-11-09','IT holiday probe' FROM working_calendars WHERE company_id=$1 AND is_active`, [f.companyId]);
      const r = (await c.query(
        `SELECT cal_add_working_minutes($1,'2026-11-07T15:30:00+05:30',60) AS m,
                cal_add_working_days($1,'2026-11-07T10:00:00+05:30',1) AS d`, [f.companyId])).rows[0];
      same(r.m.toISOString(), '2026-11-10T10:00:00+05:30'); // Mon is a holiday -> Tue
      same(r.d.toISOString(), '2026-11-10T10:00:00+05:30');
    } finally {
      await c.query('ROLLBACK');
    }
  });

  it('holidays: SYSTEM_ADMIN adds/removes (others 403); past holidays cannot be removed', async () => {
    // A far-future date unique to this run (removed again below).
    const n = parseInt(RUN.slice(-4), 36) % 3000;
    const date = new Date(Date.UTC(2090, 0, 1) + n * 86400000).toISOString().slice(0, 10);
    fails(await api('post', '/calendars/holidays', f.purchase, { holiday_date: date, description: 'x' }), 403);
    fails(await api('post', '/calendars/holidays', f.finance, { holiday_date: date, description: 'x' }), 403);
    const h = ok(await api('post', '/calendars/holidays', f.admin, { holiday_date: date, description: `IT holiday ${RUN}` }));
    fails(await api('post', '/calendars/holidays', f.admin, { holiday_date: date, description: 'dup' }), 400, /already a holiday/);
    const cal = ok(await api('get', '/calendars/current', f.admin));
    expect(cal.holidays.map((x: any) => x.id)).toContain(h.id);
    fails(await api('post', `/calendars/holidays/${h.id}/remove`, f.purchase), 403);
    expect(ok(await api('post', `/calendars/holidays/${h.id}/remove`, f.admin)).removed).toBe(true);

    // DB trigger: a past holiday cannot be removed (insert + delete in one rolled-back tx).
    await c.query('BEGIN');
    try {
      const id = (await c.query(
        `INSERT INTO calendar_holidays(calendar_id,holiday_date,description)
         SELECT id,'2020-01-26','past' FROM working_calendars WHERE company_id=$1 AND is_active RETURNING id`,
        [f.companyId])).rows[0].id;
      await expect(c.query(`DELETE FROM calendar_holidays WHERE id=$1`, [id])).rejects.toThrow(/only future holidays/);
    } finally {
      await c.query('ROLLBACK');
    }
  });
});
