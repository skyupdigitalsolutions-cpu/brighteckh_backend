import {
  BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgService } from '../../common/database/pg.service';
import { Actor, Br10AccessService } from './br10-access.service';
import { applyMasks, MaskRule, toCsv, toPdf, toXlsx } from './br10-export';
import { runReport } from './br10-reports';
import {
  ApproveGrantDto, AuthorityDto, CreateBindingDto, CreateGrantDto, CreateSalesAssignmentDto, ExportQueryDto, ReportQueryDto,
} from './dto/br10.dto';

const CONTENT_TYPES: Record<string, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/**
 * BR-10: read-only MIS + RBAC governance.
 *   - Reports: entitlement (Br10AccessService) -> query inside PgService.readOnly()
 *     -> masking -> one br10_report_access_log row. Reports never write anything else.
 *   - Governance writes go ONLY to br10_* tables (+ the platform activity_audit_log).
 */
@Injectable()
export class Br10Service {
  constructor(private readonly pg: PgService, private readonly access: Br10AccessService) {}

  private rethrow(e: unknown): never {
    if (e instanceof HttpException) throw e;
    const m = (e as Error).message || 'request failed';
    // Authorisation failures (wrong approver, self-grant/approval) are 403, not validation errors.
    if (/requires the configured authoriser role|cannot authorise financial|only SYSTEM_ADMIN|no self-/.test(m)) throw new ForbiddenException(m);
    throw new BadRequestException(m);
  }

  private async period(actor: Actor, q: ReportQueryDto) {
    const today = (await this.pg.query(`SELECT to_char(br08_local_today($1),'YYYY-MM-DD') AS d`, [actor.companyId])).rows[0].d as string;
    const to = q.to ?? today;
    const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
    if (from > to) throw new BadRequestException('from must be on or before to');
    return { from, to };
  }

  private filters(q: ReportQueryDto, period: { from: string; to: string }) {
    return { from: period.from, to: period.to, companies: q.companies ?? null };
  }

  private async masks(reportCode: string): Promise<MaskRule[]> {
    return (await this.pg.query(`SELECT column_name, applies_to, mask_rule FROM br10_column_masks WHERE report_code=$1`, [reportCode])).rows;
  }

  // ================================================================ reports

  async view(reportCode: string, q: ReportQueryDto, actor: Actor) {
    const period = await this.period(actor, q);
    const req = { reportCode, action: 'VIEW' as const, companyIds: q.companies?.split(','), filters: this.filters(q, period) };
    const ent = await this.access.resolve(actor, req);
    const result = await this.pg.readOnly((c) => runReport(c, ent, period));
    const pii = await this.access.piiUnmasked(actor, 'VIEW', ent.companyIds);
    const rows = applyMasks(result.rows, await this.masks(reportCode), 'VIEW', pii);
    await this.access.log(actor, req, 'ALLOWED', { companyIds: ent.companyIds, rowScope: ent.rowScope.kind, rowCount: rows.length });
    return {
      report_code: ent.report.report_code, title: ent.report.title, data_class: ent.report.data_class,
      kpi_status: ent.report.kpi_status, as_of: new Date().toISOString(), period,
      scope: { company_ids: ent.companyIds, row_scope: ent.rowScope.kind, via_roles: ent.bindings, pii_unmasked: pii },
      summary: result.summary, readiness: result.readiness, formulas: result.formulas ?? {}, rows,
    };
  }

  async export(reportCode: string, q: ExportQueryDto, actor: Actor) {
    const period = await this.period(actor, q);
    const req = {
      reportCode, action: 'EXPORT' as const, companyIds: q.companies?.split(','),
      filters: this.filters(q, period), format: q.format,
    };
    const ent = await this.access.resolve(actor, req);
    const result = await this.pg.readOnly((c) => runReport(c, ent, period));
    const rows = applyMasks(result.rows, await this.masks(reportCode), 'EXPORT',
      await this.access.piiUnmasked(actor, 'EXPORT', ent.companyIds));
    const emp = (await this.pg.query(`SELECT employee_code FROM employees WHERE id=$1`, [actor.id])).rows[0];
    const meta = {
      title: ent.report.title, reportCode, generatedBy: emp?.employee_code ?? actor.id, generatedAt: new Date().toISOString(),
      companies: ent.companyIds, period: `${period.from}..${period.to}`, kpiStatus: ent.report.kpi_status,
    };
    const body = q.format === 'csv' ? toCsv(rows) : q.format === 'xlsx' ? await toXlsx(rows, meta) : await toPdf(rows, meta);
    await this.access.log(actor, req, 'ALLOWED', { companyIds: ent.companyIds, rowScope: ent.rowScope.kind, rowCount: rows.length });
    return {
      body, contentType: CONTENT_TYPES[q.format],
      filename: `${reportCode.toLowerCase()}_${period.from}_${period.to}.${q.format}`,
    };
  }

  // ================================================================ catalogue + my access

  async catalogue() {
    const [roles, matrix, reports, masks] = await Promise.all([
      this.pg.query(`SELECT * FROM br10_role_catalogue ORDER BY role_code`),
      this.pg.query(`SELECT * FROM br10_permission_matrix ORDER BY role_code, data_class`),
      this.pg.query(`SELECT * FROM br10_report_catalogue ORDER BY report_code`),
      this.pg.query(`SELECT * FROM br10_column_masks ORDER BY report_code, column_name`),
    ]);
    return { roles: roles.rows, permission_matrix: matrix.rows, reports: reports.rows, column_masks: masks.rows };
  }

  async myAccess(actor: Actor) {
    const [bindings, grants, customers] = await Promise.all([
      this.pg.query(`SELECT * FROM br10_role_bindings WHERE employee_id=$1 ORDER BY created_at`, [actor.id]),
      this.pg.query(`SELECT * FROM br10_report_grants WHERE employee_id=$1 ORDER BY report_code, action`, [actor.id]),
      this.pg.query(`SELECT * FROM br10_sales_customer_assignments WHERE employee_id=$1 ORDER BY created_at`, [actor.id]),
    ]);
    return { bindings: bindings.rows, grants: grants.rows, sales_customer_assignments: customers.rows };
  }

  // ================================================================ governance writes (br10_* only)

  private async audit(c: PoolClient, actor: Actor, table: string, id: string, action: string, before: unknown, after: unknown) {
    await c.query(
      `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [actor.companyId, actor.id, table, id, action, before ?? null, after ?? null]);
  }

  private async write<T>(fn: (c: PoolClient) => Promise<T>) {
    try { return await this.pg.tx(fn); } catch (e) { this.rethrow(e); }
  }

  private async ownedEmployee(c: PoolClient, id: string, actor: Actor) {
    const e = (await c.query(`SELECT company_id FROM employees WHERE id=$1`, [id])).rows[0];
    if (!e) throw new NotFoundException('employee not found');
    if (e.company_id !== actor.companyId) throw new ForbiddenException('employee belongs to another company');
  }

  createBinding(dto: CreateBindingDto, actor: Actor) {
    return this.write(async (c) => {
      await this.ownedEmployee(c, dto.employee_id, actor);
      const b = (await c.query(
        `INSERT INTO br10_role_bindings(company_id,employee_id,role_code,note,created_by_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [actor.companyId, dto.employee_id, dto.role_code, dto.note ?? null, actor.id])).rows[0];
      await this.audit(c, actor, 'br10_role_bindings', b.id, 'BR10_BINDING_CREATED', null, b);
      return b;
    });
  }

  setBindingStatus(id: string, status: 'ACTIVE' | 'REVOKED', actor: Actor) {
    return this.write(async (c) => {
      const before = (await c.query(`SELECT * FROM br10_role_bindings WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw new NotFoundException('binding not found');
      if (before.company_id !== actor.companyId) throw new ForbiddenException('binding belongs to another company');
      const col = status === 'ACTIVE' ? 'activated_by_id' : 'revoked_by_id';
      const after = (await c.query(`UPDATE br10_role_bindings SET status=$2, ${col}=$3 WHERE id=$1 RETURNING *`, [id, status, actor.id])).rows[0];
      await this.audit(c, actor, 'br10_role_bindings', id, `BR10_BINDING_${status}`, before, after);
      return after;
    });
  }

  createGrant(dto: CreateGrantDto, actor: Actor) {
    return this.write(async (c) => {
      await this.ownedEmployee(c, dto.employee_id, actor);
      const g = (await c.query(
        `INSERT INTO br10_report_grants(company_id,employee_id,report_code,action,target_company_id,note,created_by_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [actor.companyId, dto.employee_id, dto.report_code, dto.action, dto.target_company_id ?? actor.companyId,
          dto.note ?? null, actor.id])).rows[0];
      await this.audit(c, actor, 'br10_report_grants', g.id, 'BR10_GRANT_CREATED', null, g);
      return g;
    });
  }

  /** Approver role is enforced by the DB (STANDARD=SYSTEM_ADMIN, FINANCIAL/CROSS_COMPANY=configured authoriser). */
  approveGrant(id: string, dto: ApproveGrantDto, actor: Actor) {
    return this.write(async (c) => {
      const g = (await c.query(`SELECT * FROM br10_report_grants WHERE id=$1`, [id])).rows[0];
      if (!g) throw new NotFoundException('grant not found');
      if (actor.companyId !== g.company_id && actor.companyId !== g.target_company_id) {
        throw new ForbiddenException('grant belongs to another company');
      }
      const a = (await c.query(
        `INSERT INTO br10_grant_approvals(grant_id,approval_kind,approver_company_id,approved_by_id,approver_role_code)
         VALUES ($1,$2,$3,$4,'') RETURNING *`, [id, dto.approval_kind, actor.companyId, actor.id])).rows[0];
      const after = (await c.query(`SELECT * FROM br10_report_grants WHERE id=$1`, [id])).rows[0];
      await this.audit(c, actor, 'br10_report_grants', id, `BR10_GRANT_APPROVED_${dto.approval_kind}`, g, { grant: after, approval: a });
      return { ...after, approvals: (await c.query(`SELECT * FROM br10_grant_approvals WHERE grant_id=$1 ORDER BY approved_at`, [id])).rows };
    });
  }

  revokeGrant(id: string, actor: Actor) {
    return this.write(async (c) => {
      const before = (await c.query(`SELECT * FROM br10_report_grants WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw new NotFoundException('grant not found');
      if (actor.companyId !== before.company_id && actor.companyId !== before.target_company_id) {
        throw new ForbiddenException('grant belongs to another company');
      }
      const after = (await c.query(`UPDATE br10_report_grants SET status='REVOKED', revoked_by_id=$2 WHERE id=$1 RETURNING *`, [id, actor.id])).rows[0];
      await this.audit(c, actor, 'br10_report_grants', id, 'BR10_GRANT_REVOKED', before, after);
      return after;
    });
  }

  // ================================================================ governance reads (CLAUDE.md §4g "governance reads")

  /** Grant + grantee / data-owner names + approvals. `$1` = caller's company in every caller below. */
  private static readonly GRANT_SELECT = `
    SELECT g.*, e.employee_code, e.full_name AS employee_name, tc.entity_code AS target_company_code, rc.data_class,
           (SELECT json_agg(a ORDER BY a.approved_at) FROM br10_grant_approvals a WHERE a.grant_id=g.id) AS approvals
      FROM br10_report_grants g
      JOIN employees e              ON e.id=g.employee_id
      JOIN legal_entities tc        ON tc.id=g.target_company_id
      JOIN br10_report_catalogue rc ON rc.report_code=g.report_code
     WHERE (g.company_id=$1 OR g.target_company_id=$1)`;

  async listGrants(actor: Actor) {
    const r = await this.pg.query(`${Br10Service.GRANT_SELECT} ORDER BY g.created_at DESC LIMIT 1000`, [actor.companyId]);
    return r.rows;
  }

  /**
   * INACTIVE grants the caller can approve right now, with the approval kinds they can record. Mirrors the
   * br10_guard_approval trigger (017) clause by clause, so the list never offers an approval the DB would refuse.
   */
  async pendingMyApproval(actor: Actor) {
    const r = await this.pg.query(`
      SELECT * FROM (
        SELECT x.*, ARRAY(
          SELECT k FROM unnest(x.required_approvals) k
           WHERE NOT EXISTS (SELECT 1 FROM br10_grant_approvals a WHERE a.grant_id=x.id AND a.approval_kind=k)
             AND CASE WHEN k='STANDARD' THEN $1=x.company_id AND br10_is_admin(x.company_id, $2)
                 ELSE $1=x.target_company_id
                      AND EXISTS (SELECT 1 FROM br10_authority_config ac
                                   WHERE ac.company_id=x.target_company_id
                                     AND ac.authority_kind = CASE k WHEN 'FINANCIAL' THEN 'FINANCIAL_GRANT' ELSE 'CROSS_COMPANY_GRANT' END
                                     AND ac.approver_role_code IS NOT NULL
                                     AND br08_has_role(x.target_company_id, $2, ac.approver_role_code))
                      AND NOT (k='FINANCIAL' AND br10_is_admin(x.target_company_id, $2))
                 END
        ) AS can_approve_kinds
          FROM (${Br10Service.GRANT_SELECT}
                  AND g.status='INACTIVE' AND g.employee_id<>$2
                  AND NOT EXISTS (SELECT 1 FROM br10_grant_approvals a WHERE a.grant_id=g.id AND a.approved_by_id=$2)) x
      ) y
      WHERE cardinality(y.can_approve_kinds) > 0
      ORDER BY y.created_at, y.id`, [actor.companyId, actor.id]);
    return r.rows;
  }

  async listBindings(actor: Actor) {
    const r = await this.pg.query(`
      SELECT b.*, e.employee_code, e.full_name AS employee_name, e.role_code AS employee_role_code,
             e.is_active AS employee_is_active, cb.full_name AS created_by_name,
             ab.full_name AS activated_by_name, rb.full_name AS revoked_by_name
        FROM br10_role_bindings b
        JOIN employees e       ON e.id=b.employee_id
        JOIN employees cb      ON cb.id=b.created_by_id
        LEFT JOIN employees ab ON ab.id=b.activated_by_id
        LEFT JOIN employees rb ON rb.id=b.revoked_by_id
       WHERE b.company_id=$1
       ORDER BY CASE b.status WHEN 'INACTIVE' THEN 0 WHEN 'ACTIVE' THEN 1 ELSE 2 END, e.full_name, b.created_at DESC
       LIMIT 1000`, [actor.companyId]);
    return r.rows;
  }

  /** Active employees of the caller's company, with the R_* roles each can be bound to (maps_to_role_code = their role). */
  async listEmployees(actor: Actor) {
    const r = await this.pg.query(`
      SELECT e.id, e.employee_code, e.full_name, e.role_code,
             ARRAY(SELECT rc.role_code FROM br10_role_catalogue rc WHERE rc.maps_to_role_code=e.role_code ORDER BY rc.role_code)
               AS bindable_role_codes
        FROM employees e
       WHERE e.company_id=$1 AND e.is_active
       ORDER BY e.full_name, e.employee_code
       LIMIT 2000`, [actor.companyId]);
    return r.rows;
  }

  async listCompanies() {
    return (await this.pg.query(`SELECT id, entity_code, name FROM legal_entities WHERE is_active ORDER BY entity_code`)).rows;
  }

  createSalesAssignment(dto: CreateSalesAssignmentDto, actor: Actor) {
    return this.write(async (c) => {
      await this.ownedEmployee(c, dto.employee_id, actor);
      const a = (await c.query(
        `INSERT INTO br10_sales_customer_assignments(company_id,employee_id,customer_id,created_by_id) VALUES ($1,$2,$3,$4) RETURNING *`,
        [actor.companyId, dto.employee_id, dto.customer_id, actor.id])).rows[0];
      await this.audit(c, actor, 'br10_sales_customer_assignments', a.id, 'BR10_SALES_ASSIGNMENT_CREATED', null, a);
      return a;
    });
  }

  setSalesAssignmentStatus(id: string, status: 'ACTIVE' | 'REVOKED', actor: Actor) {
    return this.write(async (c) => {
      const before = (await c.query(`SELECT * FROM br10_sales_customer_assignments WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw new NotFoundException('assignment not found');
      if (before.company_id !== actor.companyId) throw new ForbiddenException('assignment belongs to another company');
      const col = status === 'ACTIVE' ? 'activated_by_id' : 'revoked_by_id';
      const after = (await c.query(`UPDATE br10_sales_customer_assignments SET status=$2, ${col}=$3 WHERE id=$1 RETURNING *`,
        [id, status, actor.id])).rows[0];
      await this.audit(c, actor, 'br10_sales_customer_assignments', id, `BR10_SALES_ASSIGNMENT_${status}`, before, after);
      return after;
    });
  }

  async getAuthorities(actor: Actor) {
    const rows = (await this.pg.query(`SELECT * FROM br10_authority_config WHERE company_id=$1`, [actor.companyId])).rows;
    const m = new Map(rows.map((r) => [r.authority_kind, r]));
    return ['FINANCIAL_GRANT', 'CROSS_COMPANY_GRANT'].map((k) => ({
      authority_kind: k, approver_role_code: m.get(k)?.approver_role_code ?? null,
      status: m.get(k)?.approver_role_code ? 'CONFIGURED' : 'CLIENT-UNCONFIRMED (restricted grants blocked)',
      note: m.get(k)?.note ?? null, updated_at: m.get(k)?.updated_at ?? null,
    }));
  }

  async setAuthority(dto: AuthorityDto, actor: Actor) {
    await this.write(async (c) => {
      const before = (await c.query(`SELECT * FROM br10_authority_config WHERE company_id=$1 AND authority_kind=$2`,
        [actor.companyId, dto.authority_kind])).rows[0];
      const after = (await c.query(
        `INSERT INTO br10_authority_config(company_id,authority_kind,approver_role_code,note,updated_by_id) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (company_id,authority_kind) DO UPDATE SET approver_role_code=EXCLUDED.approver_role_code,
           note=EXCLUDED.note, updated_by_id=EXCLUDED.updated_by_id, updated_at=now() RETURNING *`,
        [actor.companyId, dto.authority_kind, dto.approver_role_code ?? null, dto.note ?? null, actor.id])).rows[0];
      await this.audit(c, actor, 'br10_authority_config', actor.companyId, 'BR10_AUTHORITY_CONFIGURED', before ?? null, after);
    });
    return this.getAuthorities(actor);
  }
}
