import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgService } from '../../common/database/pg.service';
import { Br08Service } from '../br08/br08.service';
import { Br09Service } from '../br09/br09.service';
import { Br10Service } from '../br10/br10.service';
import { Br11Service } from '../br11/br11.service';
import { CalendarService } from '../calendar/calendar.service';
import { CompanyConfigService } from '../company-config/company-config.service';
import { CompanyPolicyDto } from '../company-config/company-config.dto';
import {
  AdminAuthorisersDto, AdminHolidayDto, AdminPoliciesDto, AdminProfileDto, GstRateDto, SETTINGS_TABS, TestSlaTargetDto,
  WorkingHoursDto,
} from './admin-settings.dto';

interface Actor { id: string; role: string; companyId: string }
type Tab = typeof SETTINGS_TABS[number];

const FIXED_SERIES: Array<[string, string]> = [
  ['JIN', 'Job inward'], ['JOB', 'Job'], ['MR', 'Material request'], ['QT', 'Customer quotation'],
  ['PO', 'Supplier purchase order'], ['GRN', 'Goods receipt'], ['ASC', 'After-sales case'],
  ['SE', 'Sales enquiry'], ['SQ', 'Sales quotation'], ['SO', 'Sales order'], ['SOUT', 'Sales outward'],
];

/**
 * SYSTEM_ADMIN Settings panel (Figma AST-D 293:59592). One admin maintains EVERY company's settings
 * (company switcher): each write re-uses the owning module's own setter with the actor's company swapped
 * for the target company, so validation, DB rules and audit rows are exactly those of the per-company
 * endpoints; the audit row carries the target company and the acting admin.
 * GST rates and the BR-07 test-start SLA are GLOBAL tables -- one value for all companies.
 */
@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly pg: PgService,
    private readonly br08: Br08Service,
    private readonly br09: Br09Service,
    private readonly br10: Br10Service,
    private readonly br11: Br11Service,
    private readonly calendar: CalendarService,
    private readonly companyConfig: CompanyConfigService,
  ) {}

  private rethrow(e: unknown): never {
    if (e instanceof HttpException) throw e;
    throw new BadRequestException((e as Error).message || 'request failed');
  }

  private async company(companyId: string) {
    const r = await this.pg.query(
      `SELECT id, entity_code, name, legal_name, is_active FROM legal_entities WHERE id=$1`, [companyId]);
    if (!r.rows[0]) throw new NotFoundException('company not found');
    return r.rows[0];
  }

  /** The admin acting on the target company. */
  private async as(actor: Actor, companyId: string): Promise<Actor> {
    const c = await this.company(companyId);
    if (!c.is_active) throw new BadRequestException('company is inactive');
    return { ...actor, companyId };
  }

  private async stamp(actor: Actor, tab: Tab, detail: Record<string, unknown>) {
    await this.pg.query(
      `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
       VALUES ($1,$2,'admin_settings',$1,'ADMIN_SETTINGS_SAVED',NULL,$3)`,
      [actor.companyId, actor.id, { tab, ...detail }]);
  }

  // ================================================================ reads

  listCompanies() {
    return this.pg.query(
      `SELECT id, entity_code, name, legal_name, is_active FROM legal_entities ORDER BY entity_code`).then((r) => r.rows);
  }

  async get(companyId: string, actor: Actor) {
    const company = await this.company(companyId);
    const a = { ...actor, companyId };
    const [profile, companyConfig, salesConfig, supportConfig, misAuthorities, calendar, gst, sla, saved] = await Promise.all([
      this.br08.getEntityProfile(a),
      this.companyConfig.get(a),
      this.br11.getConfig(a),
      this.br09.getConfig(a),
      this.br10.getAuthorities(a),
      this.calendar.current(a).catch((e) => { if (e instanceof NotFoundException) return null; throw e; }),
      this.pg.query(`SELECT * FROM br08_gst_rate_config WHERE is_active ORDER BY quote_line_type NULLS FIRST`),
      this.pg.query(`SELECT priority, target_amount, target_unit, event_code FROM br07_test_sla_targets
                      ORDER BY array_position(ARRAY['NORMAL','URGENT','CRITICAL']::varchar[], priority)`),
      this.pg.query(
        `SELECT DISTINCT ON (l.after_state->>'tab') l.after_state->>'tab' AS tab, l.changed_at AS at,
                l.actor_id AS by_id, e.full_name AS by_name
           FROM activity_audit_log l JOIN employees e ON e.id=l.actor_id
          WHERE l.company_id=$1 AND l.entity_table='admin_settings' AND l.action='ADMIN_SETTINGS_SAVED'
          ORDER BY l.after_state->>'tab', l.changed_at DESC, l.id DESC`, [companyId]),
    ]);
    const last = Object.fromEntries(SETTINGS_TABS.map((t) => [t, null])) as Record<string, unknown>;
    for (const r of saved.rows) last[r.tab] = { at: r.at, by_id: r.by_id, by_name: r.by_name };
    return {
      company, profile, company_config: companyConfig, sales_config: salesConfig, support_config: supportConfig,
      mis_authorities: misAuthorities, calendar, gst_rates: gst.rows, test_sla_targets: sla.rows, last_saved: last,
    };
  }

  async numbering(companyId: string) {
    const company = await this.company(companyId);
    const [fy, prefix, fyCtr, ctr, rfq] = await Promise.all([
      this.pg.query(`SELECT br08_fiscal_year((now() AT TIME ZONE 'Asia/Kolkata')::date) AS fy`),
      this.pg.query(`SELECT doc_prefix FROM legal_entities WHERE id=$1`, [companyId]),
      this.pg.query(`SELECT doc_kind, last_value::int AS n, changed_at FROM br08_fy_counters
                      WHERE company_id=$1 AND fiscal_year=br08_fiscal_year((now() AT TIME ZONE 'Asia/Kolkata')::date)`, [companyId]),
      this.pg.query(`SELECT number_kind, last_value::int AS n, changed_at FROM company_number_counters WHERE company_id=$1`, [companyId]),
      this.pg.query(`SELECT last_number::int AS n, updated_at FROM br04_global_number_counters WHERE number_kind='RFQ'`),
    ]);
    const fiscalYear: string = fy.rows[0].fy;
    const short = `${fiscalYear.slice(2, 4)}-${fiscalYear.slice(5, 7)}`;
    const p: string | null = prefix.rows[0]?.doc_prefix ?? null;
    const fyMap = new Map(fyCtr.rows.map((r) => [r.doc_kind, r]));
    const coMap = new Map(ctr.rows.map((r) => [r.number_kind, r]));
    // Same formats as br08_next_doc_number (013) and the <KIND>-<CO>-<seq:6> generators (001/006/007/008/015/018).
    const fyFmt: Record<string, [string, string, (n: number) => string]> = {
      INV: ['Tax invoice', '<PREFIX>/<n>/<YY-YY>', (n) => `${p}/${n}/${short}`],
      DC: ['Delivery challan', '<n>/<PREFIX>/NA/<YYYY-YY>', (n) => `${n}/${p}/NA/${fiscalYear}`],
      CN: ['Credit note', 'CN/<PREFIX>/<n>/<YY-YY>', (n) => `CN/${p}/${n}/${short}`],
    };
    const pad = (n: number) => String(n).padStart(6, '0');
    const series = [
      ...Object.entries(fyFmt).map(([kind, [label, format, f]]) => {
        const c = fyMap.get(kind);
        return {
          kind, label, scope: 'FISCAL_YEAR', format,
          latest_number: c && p ? f(c.n) : null, next_number: p ? f((c?.n ?? 0) + 1) : null,
          last_issued_at: c?.changed_at ?? null,
        };
      }),
      ...FIXED_SERIES.map(([kind, label]) => {
        const c = coMap.get(kind);
        const f = (n: number) => `${kind}-${company.entity_code}-${pad(n)}`;
        return {
          kind, label, scope: 'COMPANY', format: `${kind}-<CO>-<nnnnnn>`,
          latest_number: c ? f(c.n) : null, next_number: f((c?.n ?? 0) + 1), last_issued_at: c?.changed_at ?? null,
        };
      }),
      {
        kind: 'RFQ', label: 'Supplier RFQ', scope: 'GLOBAL', format: 'RFQ-<nnnnnn>',
        latest_number: rfq.rows[0]?.n ? `RFQ-${pad(rfq.rows[0].n)}` : null,
        next_number: `RFQ-${pad((rfq.rows[0]?.n ?? 0) + 1)}`,
        last_issued_at: rfq.rows[0]?.n ? rfq.rows[0].updated_at : null,
      },
    ];
    return { company, fiscal_year: fiscalYear, doc_prefix: p, series };
  }

  // ================================================================ per-company writes

  async setProfile(companyId: string, dto: AdminProfileDto, actor: Actor) {
    const a = await this.as(actor, companyId);
    await this.br08.updateEntityProfile(dto, a);
    await this.stamp(a, 'COMPANY_TAX', { fields: Object.keys(dto) });
    return this.get(companyId, actor);
  }

  async setAuthorisers(companyId: string, dto: AdminAuthorisersDto, actor: Actor) {
    const a = await this.as(actor, companyId);
    const kinds = (dto.support ?? []).map((s) => s.decision_kind);
    const misKinds = (dto.mis ?? []).map((m) => m.authority_kind);
    if (new Set(kinds).size !== kinds.length || new Set(misKinds).size !== misKinds.length) {
      throw new BadRequestException('each authority may appear only once');
    }
    if (!kinds.length && !misKinds.length && !dto.roles) throw new BadRequestException('nothing to update');
    for (const s of dto.support ?? []) await this.br09.setAuthority(s, a);
    for (const m of dto.mis ?? []) await this.br10.setAuthority(m, a);
    if (dto.roles && Object.keys(dto.roles).length) await this.companyConfig.set(dto.roles as CompanyPolicyDto, a);
    await this.stamp(a, 'AUTHORISERS', { support: kinds, mis: misKinds, roles: Object.keys(dto.roles ?? {}) });
    return this.get(companyId, actor);
  }

  async setPolicies(companyId: string, dto: AdminPoliciesDto, actor: Actor) {
    const a = await this.as(actor, companyId);
    if (!dto.company && !dto.sales) throw new BadRequestException('nothing to update');
    if (dto.company) await this.companyConfig.set(dto.company, a);
    if (dto.sales) await this.br11.setPolicy(dto.sales, a);
    await this.stamp(a, 'POLICIES', { company: Object.keys(dto.company ?? {}), sales: Object.keys(dto.sales ?? {}) });
    return this.get(companyId, actor);
  }

  async setWorkingHours(companyId: string, dto: WorkingHoursDto, actor: Actor) {
    const a = await this.as(actor, companyId);
    const dows = dto.days.map((d) => d.iso_dow);
    if (new Set(dows).size !== dows.length) throw new BadRequestException('each weekday may appear only once');
    for (const d of dto.days) {
      if ((d.break_start_local == null) !== (d.break_end_local == null)) {
        throw new BadRequestException(`weekday ${d.iso_dow}: give both break start and break end, or neither`);
      }
    }
    try {
      await this.pg.tx(async (c: PoolClient) => {
        const cal = (await c.query(
          `SELECT id FROM working_calendars WHERE company_id=$1 AND is_active FOR UPDATE`, [companyId])).rows[0];
        if (!cal) throw new NotFoundException('no active working calendar for this company');
        const before = (await c.query(
          `SELECT * FROM working_calendar_day_rules WHERE calendar_id=$1 ORDER BY iso_dow`, [cal.id])).rows;
        await c.query(`DELETE FROM working_calendar_day_rules WHERE calendar_id=$1`, [cal.id]);
        for (const d of dto.days) {
          await c.query(
            `INSERT INTO working_calendar_day_rules(calendar_id,iso_dow,start_local,end_local,break_start_local,break_end_local)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [cal.id, d.iso_dow, d.start_local, d.end_local, d.break_start_local ?? null, d.break_end_local ?? null]);
        }
        // working_dow / start_local / end_local are the 001 summary envelope (012): keep them in step.
        await c.query(
          `UPDATE working_calendars w SET working_dow=s.dows, start_local=s.st, end_local=s.en
             FROM (SELECT array_agg(iso_dow ORDER BY iso_dow) dows, min(start_local) st, max(end_local) en
                     FROM working_calendar_day_rules WHERE calendar_id=$1) s
            WHERE w.id=$1`, [cal.id]);
        const after = (await c.query(
          `SELECT * FROM working_calendar_day_rules WHERE calendar_id=$1 ORDER BY iso_dow`, [cal.id])).rows;
        await c.query(
          `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
           VALUES ($1,$2,'working_calendars',$3,'CAL_WORKING_HOURS_SET',$4,$5)`,
          [companyId, actor.id, cal.id, JSON.stringify(before), JSON.stringify(after)]);
      });
    } catch (e) { this.rethrow(e); }
    await this.stamp(a, 'CALENDAR', { working_days: dows });
    return this.get(companyId, actor);
  }

  async addHoliday(companyId: string, dto: AdminHolidayDto, actor: Actor) {
    const a = await this.as(actor, companyId);
    await this.calendar.addHoliday(dto, a);
    await this.stamp(a, 'CALENDAR', { holiday_added: dto.holiday_date });
    return this.get(companyId, actor);
  }

  async removeHoliday(companyId: string, holidayId: string, actor: Actor) {
    const a = await this.as(actor, companyId);
    await this.calendar.removeHoliday(holidayId, a);
    await this.stamp(a, 'CALENDAR', { holiday_removed: holidayId });
    return this.get(companyId, actor);
  }

  // ================================================================ global writes

  async setGstRate(dto: GstRateDto, actor: Actor) {
    const cents = Math.round(dto.igst_rate * 100);
    if (cents % 2 !== 0) throw new BadRequestException('IGST rate must split evenly into CGST + SGST (2 decimals each)');
    const half = (cents / 2 / 100).toFixed(2);
    try {
      await this.pg.tx(async (c: PoolClient) => {
        const before = (await c.query(
          `SELECT * FROM br08_gst_rate_config WHERE is_active AND COALESCE(quote_line_type,'*')=COALESCE($1::varchar,'*') FOR UPDATE`,
          [dto.quote_line_type])).rows[0];
        const hsn = dto.hsn_sac !== undefined ? dto.hsn_sac : (before?.hsn_sac ?? null);
        if (before) await c.query(`UPDATE br08_gst_rate_config SET is_active=false WHERE id=$1`, [before.id]);
        const after = (await c.query(
          `INSERT INTO br08_gst_rate_config(quote_line_type,hsn_sac,cgst_rate,sgst_rate,igst_rate,is_active)
           VALUES ($1,$2,$3,$3,$4,true) RETURNING *`,
          [dto.quote_line_type, hsn, half, dto.igst_rate.toFixed(2)])).rows[0];
        await c.query(
          `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
           VALUES ($1,$2,'br08_gst_rate_config',$3,'BR08_GST_RATE_SET',$4,$5)`,
          [actor.companyId, actor.id, after.id, before ?? null, after]);
      });
    } catch (e) { this.rethrow(e); }
    return (await this.pg.query(`SELECT * FROM br08_gst_rate_config WHERE is_active ORDER BY quote_line_type NULLS FIRST`)).rows;
  }

  async setTestSlaTarget(dto: TestSlaTargetDto, actor: Actor) {
    try {
      await this.pg.tx(async (c: PoolClient) => {
        const before = (await c.query(
          `SELECT * FROM br07_test_sla_targets WHERE priority=$1 FOR UPDATE`, [dto.priority])).rows[0];
        if (!before) throw new NotFoundException(`no test SLA row for ${dto.priority}`);
        const after = (await c.query(
          `UPDATE br07_test_sla_targets SET target_amount=$2, target_unit=$3 WHERE priority=$1 RETURNING *`,
          [dto.priority, dto.target_amount, dto.target_unit])).rows[0];
        await c.query(
          `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
           VALUES ($1,$2,'br07_test_sla_targets',$1,'BR07_TEST_SLA_TARGET_SET',$3,$4)`,
          [actor.companyId, actor.id, before, after]);
      });
    } catch (e) { this.rethrow(e); }
    return (await this.pg.query(
      `SELECT priority, target_amount, target_unit, event_code FROM br07_test_sla_targets
        ORDER BY array_position(ARRAY['NORMAL','URGENT','CRITICAL']::varchar[], priority)`)).rows;
  }
}
