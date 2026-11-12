import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { AddHolidayDto, WorkingTimeQueryDto } from './dto/calendar.dto';

interface Actor { id: string; role: string; companyId: string }

/**
 * Working calendar (migration 012). The working-time math lives in the DB
 * (cal_add_working_minutes / cal_add_working_days) -- this service only reads
 * config and lets SYSTEM_ADMIN add/remove holidays for the actor's own company.
 */
@Injectable()
export class CalendarService {
  constructor(private readonly pg: PgService) {}

  private rethrow(e: unknown): never {
    if (e instanceof HttpException) throw e;
    throw new BadRequestException((e as Error).message || 'request failed');
  }

  private async activeCalendar(companyId: string) {
    const r = await this.pg.query(`SELECT * FROM working_calendars WHERE company_id=$1 AND is_active`, [companyId]);
    if (!r.rows[0]) throw new NotFoundException('no active working calendar for this company');
    return r.rows[0];
  }

  async current(actor: Actor) {
    const cal = await this.activeCalendar(actor.companyId);
    const [rules, holidays] = await Promise.all([
      this.pg.query(`SELECT * FROM working_calendar_day_rules WHERE calendar_id=$1 ORDER BY iso_dow`, [cal.id]),
      this.pg.query(`SELECT * FROM calendar_holidays WHERE calendar_id=$1 ORDER BY holiday_date`, [cal.id]),
    ]);
    return { ...cal, day_rules: rules.rows, holidays: holidays.rows };
  }

  async addHoliday(dto: AddHolidayDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const cal = (await client.query(
          `SELECT id FROM working_calendars WHERE company_id=$1 AND is_active FOR UPDATE`, [actor.companyId],
        )).rows[0];
        if (!cal) throw new NotFoundException('no active working calendar for this company');
        const dup = await client.query(
          `SELECT 1 FROM calendar_holidays WHERE calendar_id=$1 AND holiday_date=$2`, [cal.id, dto.holiday_date],
        );
        if (dup.rowCount) throw new BadRequestException(`${dto.holiday_date} is already a holiday`);
        const h = (await client.query(
          `INSERT INTO calendar_holidays(calendar_id,holiday_date,description,created_by_id)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [cal.id, dto.holiday_date, dto.description, actor.id],
        )).rows[0];
        await this.audit(client, actor, h.id, 'CAL_HOLIDAY_ADDED', null, h);
        return h;
      });
    } catch (e) { this.rethrow(e); }
  }

  async removeHoliday(holidayId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const h = (await client.query(
          `SELECT h.* FROM calendar_holidays h JOIN working_calendars c ON c.id=h.calendar_id
            WHERE h.id=$1 AND c.company_id=$2 FOR UPDATE OF h`, [holidayId, actor.companyId],
        )).rows[0];
        if (!h) throw new NotFoundException('holiday not found for this company');
        await client.query(`DELETE FROM calendar_holidays WHERE id=$1`, [holidayId]); // trigger: future dates only
        await this.audit(client, actor, h.id, 'CAL_HOLIDAY_REMOVED', h, null);
        return { removed: true, holiday: h };
      });
    } catch (e) { this.rethrow(e); }
  }

  async workingTime(q: WorkingTimeQueryDto, actor: Actor) {
    if ((q.minutes === undefined) === (q.days === undefined)) {
      throw new BadRequestException('give exactly one of minutes or days');
    }
    try {
      const r = q.minutes !== undefined
        ? await this.pg.query(`SELECT cal_add_working_minutes($1,$2::timestamptz,$3) AS due_at`, [actor.companyId, q.from, q.minutes])
        : await this.pg.query(`SELECT cal_add_working_days($1,$2::timestamptz,$3) AS due_at`, [actor.companyId, q.from, q.days]);
      return { from: q.from, minutes: q.minutes ?? null, days: q.days ?? null, due_at: r.rows[0].due_at };
    } catch (e) { this.rethrow(e); }
  }

  private async audit(client: { query: PgService['query'] }, actor: Actor, id: string, action: string, before: unknown, after: unknown) {
    await client.query(
      `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
       VALUES ($1,$2,'calendar_holidays',$3,$4,$5,$6)`,
      [actor.companyId, actor.id, id, action, before ?? null, after ?? null],
    );
  }
}
