import { createHash } from 'crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';

export interface Actor { id: string; role: string; companyId: string }

export type RowScope =
  | { kind: 'COMPANY' }
  | { kind: 'CUSTOMERS'; customerIds: string[] }
  | { kind: 'JOBS'; engineerId: string }
  | { kind: 'SELF'; employeeId: string };

export interface Entitlement {
  report: { report_code: string; title: string; data_class: string; kpi_status: string };
  action: 'VIEW' | 'EXPORT';
  companyIds: string[];
  rowScope: RowScope;
  bindings: string[];
}

export interface AccessRequest {
  reportCode: string;
  action: 'VIEW' | 'EXPORT';
  companyIds?: string[];
  filters: Record<string, unknown>;
  format?: string;
}

/**
 * Server-side entitlement for every BR-10 report call. Nothing comes from the
 * request except WHICH report / action / companies are asked for; every answer is
 * derived from the DB at call time (so a revoked binding or deactivated employee
 * is denied on the very next call -- T18):
 *   1. employee is active; its CURRENT role_code is read from `employees`
 *   2. >=1 ACTIVE br10_role_binding whose R_* code maps to that role_code (T07)
 *   3. for each requested company: a permission-matrix row of a bound role allows
 *      (data_class, action); another company additionally needs GRANTED_COMPANIES scope
 *   4. for each requested company: an ACTIVE named-employee grant for
 *      (report, action, company) -- VIEW and EXPORT are separate grants (T28)
 *   5. row scope = union of the permitting rows' scopes (T27)
 * Every denial is written to br10_report_access_log (T01) before the 403.
 */
@Injectable()
export class Br10AccessService {
  constructor(private readonly pg: PgService) {}

  static checksum(filters: Record<string, unknown>): string {
    const sorted = Object.keys(filters).sort().reduce((o, k) => ({ ...o, [k]: filters[k] }), {});
    return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  }

  async log(actor: Actor, req: AccessRequest, outcome: 'ALLOWED' | 'DENIED',
    extra: { companyIds?: string[]; rowScope?: string; rowCount?: number; reason?: string } = {}) {
    await this.pg.query(
      `INSERT INTO br10_report_access_log
         (company_id,employee_id,report_code,action,outcome,export_format,scope_company_ids,row_scope,filters,filter_checksum,row_count,denial_reason)
       VALUES ($1,$2,(SELECT report_code FROM br10_report_catalogue WHERE report_code=$3),$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [actor.companyId, actor.id, req.reportCode, req.action, outcome, req.format ?? null,
        extra.companyIds ?? req.companyIds ?? [actor.companyId], extra.rowScope ?? null, req.filters,
        Br10AccessService.checksum(req.filters), extra.rowCount ?? null, extra.reason ?? null],
    );
  }

  private async deny(actor: Actor, req: AccessRequest, reason: string): Promise<never> {
    await this.log(actor, req, 'DENIED', { reason });
    throw new ForbiddenException(`BR10: ${reason}`);
  }

  async resolve(actor: Actor, req: AccessRequest): Promise<Entitlement> {
    const report = (await this.pg.query(
      `SELECT report_code, title, data_class, kpi_status FROM br10_report_catalogue WHERE report_code=$1`, [req.reportCode],
    )).rows[0];
    if (!report) throw new NotFoundException('unknown report');
    if (report.data_class === 'PII_CUSTOMER') {
      throw new BadRequestException('PII_CUSTOMER is an entitlement (unmasks customer fields in other reports), not a runnable report');
    }

    const companyIds = [...new Set((req.companyIds?.length ? req.companyIds : [actor.companyId]).map((x) => x.toLowerCase()))];
    const emp = (await this.pg.query(
      `SELECT role_code FROM employees WHERE id=$1 AND company_id=$2 AND is_active`, [actor.id, actor.companyId],
    )).rows[0];
    if (!emp) return this.deny(actor, req, 'employee inactive or unknown');

    const bindings = (await this.pg.query(
      `SELECT b.role_code FROM br10_role_bindings b JOIN br10_role_catalogue rc ON rc.role_code=b.role_code
        WHERE b.employee_id=$1 AND b.company_id=$2 AND b.status='ACTIVE' AND rc.maps_to_role_code=$3`,
      [actor.id, actor.companyId, emp.role_code],
    )).rows.map((r) => r.role_code as string);
    if (bindings.length === 0) return this.deny(actor, req, 'no ACTIVE BR-10 role binding for this employee');

    const scopes = new Set<string>();
    for (const company of companyIds) {
      const cross = company !== actor.companyId.toLowerCase();
      const rows = (await this.pg.query(
        `SELECT row_scope FROM br10_permission_matrix
          WHERE role_code = ANY($1) AND data_class=$2 AND grant_type<>'DENIED' AND $3 = ANY(allowed_actions)
            AND ($4 = false OR row_scope='GRANTED_COMPANIES')`,
        [bindings, report.data_class, req.action, cross],
      )).rows;
      if (rows.length === 0) {
        return this.deny(actor, req, `role(s) ${bindings.join(',')} do not permit ${req.action} on ${report.data_class}`
          + (cross ? ' for another company' : ''));
      }
      const grant = await this.pg.query(
        `SELECT 1 FROM br10_report_grants WHERE employee_id=$1 AND report_code=$2 AND action=$3
            AND target_company_id=$4 AND status='ACTIVE'`,
        [actor.id, report.report_code, req.action, company],
      );
      if (!grant.rowCount) {
        return this.deny(actor, req, `no ACTIVE ${req.action} grant for ${report.report_code}`
          + (cross ? ` on company ${company}` : ''));
      }
      rows.forEach((r) => scopes.add(r.row_scope));
    }

    let rowScope: RowScope;
    if (scopes.has('COMPANY') || scopes.has('GRANTED_COMPANIES')) rowScope = { kind: 'COMPANY' };
    else if (scopes.has('ASSIGNED_OR_CUSTOMER') || scopes.has('ASSIGNED_CUSTOMER')) {
      const ids = (await this.pg.query(
        `SELECT customer_id FROM br10_sales_customer_assignments WHERE employee_id=$1 AND status='ACTIVE'`, [actor.id],
      )).rows.map((r) => r.customer_id as string);
      rowScope = { kind: 'CUSTOMERS', customerIds: ids };
    } else if (scopes.has('ASSIGNED_JOBS')) rowScope = { kind: 'JOBS', engineerId: actor.id };
    else if (scopes.has('SELF')) rowScope = { kind: 'SELF', employeeId: actor.id };
    else return this.deny(actor, req, 'no usable row scope');

    return { report, action: req.action, companyIds, rowScope, bindings };
  }

  /** Customer PII unmasked only with an ACTIVE PII_CUSTOMER grant for this action on every company (DB function, per call). */
  async piiUnmasked(actor: Actor, action: 'VIEW' | 'EXPORT', companyIds: string[]): Promise<boolean> {
    const r = await this.pg.query(`SELECT br10_pii_unmasked($1,$2,$3::uuid[]) AS ok`, [actor.id, action, companyIds]);
    return r.rows[0].ok === true;
  }
}
