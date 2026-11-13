import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import {
  AssemblyLookupQueryDto, CustomerLookupQueryDto, EmployeeLookupQueryDto, JobListQueryDto, LookupQueryDto,
  PageQueryDto, QuoteListQueryDto, ReceiptListQueryDto, RfqListQueryDto, UNIT_EDITABLE_FIELDS, UpdateEquipmentUnitDto,
} from './dto/purchase-desk.dto';

export interface Actor { id: string; role: string; companyId: string }

/** `%term%` for ILIKE with \ % _ escaped (same as the BR-03 catalogue), or null when no search. */
export function likeTerm(search?: string): string | null {
  const s = search?.trim();
  return s ? `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
}

export function paging(q: PageQueryDto) {
  const page = q.page ?? 1;
  const pageSize = q.page_size ?? 25;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

const arr = (v?: string[]) => (v && v.length ? v : null);

/** Company timezone: the active working calendar's (migration 012), else Asia/Kolkata. */
export async function companyTimezone(pg: PgService, companyId: string): Promise<string> {
  const r = await pg.query<{ tz: string }>(
    `SELECT COALESCE((SELECT timezone FROM working_calendars WHERE company_id=$1 AND is_active
                       ORDER BY created_at DESC LIMIT 1), 'Asia/Kolkata') AS tz`, [companyId],
  );
  return r.rows[0].tz;
}

/**
 * Purchase desk reads (G14-G21, B-1..B-3, C2-1): company-scoped lists, picker lookups and the
 * unit-detail edit. Every query is filtered by the token's company; nothing here trusts a
 * company id from the request. Read-only except updateUnit (one row + one audit row, in a tx).
 */
@Injectable()
export class PurchaseDeskService {
  constructor(private readonly pg: PgService) {}

  /** Run a COUNT and a page query that share the same FROM/WHERE. */
  private async page(fromWhere: string, params: unknown[], select: string, orderBy: string, q: PageQueryDto, wrap?: (inner: string) => string) {
    const { page, pageSize, offset } = paging(q);
    const n = params.length;
    const inner = `SELECT ${select} ${fromWhere} ORDER BY ${orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`;
    const [count, rows] = await Promise.all([
      this.pg.query<{ n: number }>(`SELECT count(*)::int AS n ${fromWhere}`, params),
      this.pg.query(wrap ? wrap(inner) : inner, [...params, pageSize, offset]),
    ]);
    return { rows: rows.rows, total: count.rows[0].n, page, page_size: pageSize };
  }

  // ================================================================ G14 inward register

  async listReceipts(q: ReceiptListQueryDto, actor: Actor) {
    const tz = await companyTimezone(this.pg, actor.companyId);
    const fromWhere = `
      FROM inward_receipts r
      JOIN customers c ON c.id = r.customer_id AND c.company_id = r.company_id
     WHERE r.company_id = $1
       AND ($2::text[] IS NULL OR r.receipt_status = ANY($2))
       AND ($3::text[] IS NULL OR r.priority = ANY($3))
       AND ($4::text IS NULL OR to_char(r.receipt_at AT TIME ZONE $5, 'YYYY-MM') = $4)
       AND ($6::text IS NULL OR r.jin_number ILIKE $6 OR c.customer_name ILIKE $6 OR c.customer_code ILIKE $6
            OR r.customer_dc_number ILIKE $6)`;
    const params = [actor.companyId, arr(q.status), arr(q.priority), q.month ?? null, tz, likeTerm(q.search)];
    return this.page(fromWhere, params, 'r.*, c.customer_code, c.customer_name', 'r.receipt_at DESC, r.id', q,
      (inner) => `
        SELECT p.*,
               (SELECT count(*)::int FROM inward_equipment_groups g WHERE g.inward_id = p.id) AS groups_count,
               (SELECT COALESCE(sum(g.quantity_received), 0)::int FROM inward_equipment_groups g WHERE g.inward_id = p.id) AS units_received,
               (SELECT count(*)::int FROM inward_equipment_units u WHERE u.company_id = p.company_id AND u.inward_id = p.id) AS units_total,
               (SELECT count(*)::int FROM inward_equipment_units u
                 WHERE u.company_id = p.company_id AND u.inward_id = p.id AND u.verification_status = 'VERIFIED') AS units_verified
          FROM (${inner}) p
         ORDER BY p.receipt_at DESC, p.id`);
  }

  // ================================================================ G15 jobs

  async listJobs(q: JobListQueryDto, actor: Actor) {
    const eng = q.engineer_id?.toLowerCase() ?? null;
    const fromWhere = `
      FROM service_jobs j
      JOIN inward_receipts r          ON r.id = j.inward_id
      JOIN customers c                ON c.id = r.customer_id AND c.company_id = r.company_id
      JOIN inward_equipment_units u   ON u.id = j.unit_id
      JOIN inward_equipment_groups g  ON g.id = u.group_id
      JOIN assemblies asm             ON asm.id = g.assembly_id
      LEFT JOIN job_assignments a     ON a.job_id = j.id AND a.is_current
      LEFT JOIN employees e           ON e.id = a.engineer_id
     WHERE j.company_id = $1
       AND ($2::text[] IS NULL OR j.status = ANY($2))
       AND ($3::text[] IS NULL OR j.priority = ANY($3))
       AND ($4::text IS NULL OR ($4 = 'unassigned' AND a.id IS NULL) OR a.engineer_id::text = $4)
       AND ($5::text IS NULL OR j.job_number ILIKE $5 OR r.jin_number ILIKE $5 OR u.serial_number ILIKE $5
            OR u.observed_make ILIKE $5 OR u.observed_model ILIKE $5 OR asm.assembly_code ILIKE $5
            OR asm.assembly_name ILIKE $5 OR c.customer_name ILIKE $5 OR c.customer_code ILIKE $5)`;
    const params = [actor.companyId, arr(q.status), arr(q.priority), eng, likeTerm(q.search)];
    const select = `j.*, r.jin_number, r.receipt_at, u.unit_number,
      (SELECT count(*)::int FROM inward_equipment_units u2 WHERE u2.group_id = u.group_id) AS units_in_group,
      u.serial_number, u.observed_make, u.observed_model,
      g.assembly_id, asm.assembly_code, asm.assembly_name,
      r.customer_id, c.customer_code, c.customer_name,
      a.id AS current_assignment_id, a.engineer_id AS current_engineer_id, e.full_name AS current_engineer_name,
      a.response AS assignment_response, a.assigned_at, a.responded_at AS __responded_at`;
    const res = await this.page(fromWhere, params, select, 'j.created_at DESC, j.id', q, (inner) => `
      SELECT p.*,
             GREATEST(p.created_at, p.closed_at, p.cancelled_at, p.assigned_at, p.__responded_at,
                      (SELECT max(l.changed_at) FROM activity_audit_log l WHERE l.entity_id = p.id),
                      (SELECT max(l.changed_at) FROM activity_audit_log l
                        WHERE l.after_state ? 'job_id' AND l.after_state->>'job_id' = p.id::text)) AS last_activity_at
        FROM (${inner}) p
       ORDER BY p.created_at DESC, p.id`);
    res.rows = res.rows.map(({ __responded_at, ...row }) => row);
    return res;
  }

  // ================================================================ G20 RFQs

  async listRfqs(q: RfqListQueryDto, actor: Actor) {
    // RFQs are per job (BR-04 createRfq rejects mixed jobs), so the first source's job is THE job.
    const fromWhere = `
      FROM br04_rfqs r
      LEFT JOIN LATERAL (
        SELECT sh.job_id FROM br04_rfq_lines l
          JOIN br04_rfq_line_sources s ON s.rfq_line_id = l.id
          JOIN br04_shortage_sources sh ON sh.id = s.shortage_source_id
         WHERE l.rfq_id = r.id LIMIT 1) jl ON true
      LEFT JOIN service_jobs j     ON j.id = jl.job_id
      LEFT JOIN inward_receipts ir ON ir.id = j.inward_id
      LEFT JOIN customers c        ON c.id = ir.customer_id AND c.company_id = ir.company_id
     WHERE r.company_id = $1
       AND ($2::text[] IS NULL OR r.rfq_status = ANY($2))
       AND ($3::uuid IS NULL OR jl.job_id = $3)
       AND ($4::text IS NULL OR r.rfq_number ILIKE $4 OR j.job_number ILIKE $4 OR c.customer_name ILIKE $4
            OR EXISTS (SELECT 1 FROM br04_rfq_supplier_invites i WHERE i.rfq_id = r.id AND i.supplier_name_snapshot ILIKE $4))`;
    const params = [actor.companyId, arr(q.status), q.job_id ?? null, likeTerm(q.search)];
    return this.page(fromWhere, params,
      `r.*, jl.job_id, j.job_number, c.customer_name,
       (SELECT count(*)::int FROM br04_rfq_lines l WHERE l.rfq_id = r.id) AS lines_count,
       (SELECT count(*)::int FROM br04_rfq_supplier_invites i WHERE i.rfq_id = r.id) AS invites_count,
       (SELECT count(*)::int FROM br04_supplier_offer_headers h WHERE h.rfq_id = r.id) AS offers_count`,
      'r.created_at DESC, r.id', q);
  }

  // ================================================================ G21 quotes

  async listQuotes(q: QuoteListQueryDto, actor: Actor) {
    // Only customer-facing revision fields; reference/procurement offer ids (supplier pricing) are never selected.
    const fromWhere = `
      FROM br04_customer_quotes q
      JOIN service_jobs j     ON j.id = q.job_id
      JOIN inward_receipts ir ON ir.id = j.inward_id
      JOIN customers c        ON c.id = ir.customer_id AND c.company_id = ir.company_id
      JOIN LATERAL (
        SELECT id, revision_no, quote_status, revised_pre_tax, tax_total, freight_charge, currency_code, valid_until, created_at
          FROM br04_customer_quote_revisions WHERE quote_id = q.id ORDER BY revision_no DESC LIMIT 1) lr ON true
     WHERE q.company_id = $1
       AND ($2::text[] IS NULL OR lr.quote_status = ANY($2))
       AND ($3::uuid IS NULL OR q.job_id = $3)
       AND ($4::text IS NULL OR q.quote_number ILIKE $4 OR j.job_number ILIKE $4 OR c.customer_name ILIKE $4
            OR c.customer_code ILIKE $4)`;
    const params = [actor.companyId, arr(q.status), q.job_id ?? null, likeTerm(q.search)];
    return this.page(fromWhere, params,
      `q.*, j.job_number, j.status AS job_status, ir.customer_id, c.customer_name,
       (SELECT count(*)::int FROM br04_customer_quote_revisions x WHERE x.quote_id = q.id) AS revisions_count,
       lr.id AS latest_revision_id, lr.revision_no AS latest_revision_no, lr.quote_status AS latest_quote_status,
       lr.revised_pre_tax AS latest_revised_pre_tax, lr.tax_total AS latest_tax_total,
       lr.freight_charge AS latest_freight_charge, lr.currency_code AS latest_currency_code,
       lr.valid_until AS latest_valid_until, lr.created_at AS latest_revision_at`,
      'lr.created_at DESC, q.id', q);
  }

  // ================================================================ G16-G19, C2-1 lookups

  async customers(q: CustomerLookupQueryDto, actor: Actor) {
    const fromWhere = `
      FROM customers c
     WHERE c.company_id = $1
       AND c.status = ANY($2)
       AND ($3::uuid[] IS NULL OR c.id = ANY($3))
       AND ($4::text IS NULL OR c.customer_name ILIKE $4 OR c.customer_code ILIKE $4)`;
    const params = [actor.companyId, arr(q.status) ?? ['PENDING_APPROVAL', 'APPROVED'], arr(q.ids), likeTerm(q.search)];
    return this.page(fromWhere, params, 'c.id, c.customer_code, c.customer_name, c.status', 'c.customer_name, c.id', q);
  }

  async engineers(q: LookupQueryDto, actor: Actor) {
    // Same eligibility BR-02 assignEngineer checks: active ENGINEER in the caller's company.
    const fromWhere = `
      FROM employees e
     WHERE e.company_id = $1 AND e.role_code = 'ENGINEER' AND e.is_active
       AND ($2::uuid[] IS NULL OR e.id = ANY($2))
       AND ($3::text IS NULL OR e.full_name ILIKE $3 OR e.employee_code ILIKE $3)`;
    return this.page(fromWhere, [actor.companyId, arr(q.ids), likeTerm(q.search)],
      `e.id, e.employee_code, e.full_name,
       (SELECT count(*)::int FROM job_assignments a JOIN service_jobs j ON j.id = a.job_id
         WHERE a.engineer_id = e.id AND a.is_current AND j.status NOT IN ('CLOSED','CANCELLED')) AS open_jobs,
       (SELECT count(*)::int FROM job_assignments a JOIN service_jobs j ON j.id = a.job_id
         WHERE a.engineer_id = e.id AND a.is_current AND a.response = 'PENDING' AND j.status NOT IN ('CLOSED','CANCELLED')) AS pending_custody`,
      'e.full_name, e.id', q);
  }

  async employees(q: EmployeeLookupQueryDto, actor: Actor) {
    // Active employees only: expansion custodian, Sales hand-off and approver pickers all require an active employee.
    const fromWhere = `
      FROM employees e
     WHERE e.company_id = $1 AND e.is_active
       AND ($2::text[] IS NULL OR e.role_code = ANY($2))
       AND ($3::uuid[] IS NULL OR e.id = ANY($3))
       AND ($4::text IS NULL OR e.full_name ILIKE $4 OR e.employee_code ILIKE $4)`;
    return this.page(fromWhere, [actor.companyId, arr(q.role), arr(q.ids), likeTerm(q.search)],
      'e.id, e.employee_code, e.full_name, e.role_code', 'e.full_name, e.id', q);
  }

  async assemblies(q: AssemblyLookupQueryDto) {
    // `assemblies` (BR-01B customer-equipment master) has no company_id: it is shared by both companies.
    const fromWhere = `
      FROM assemblies a
     WHERE a.status = ANY($1)
       AND ($2::uuid[] IS NULL OR a.id = ANY($2))
       AND ($3::text IS NULL OR a.assembly_code ILIKE $3 OR a.assembly_name ILIKE $3)`;
    return this.page(fromWhere, [arr(q.status) ?? ['PENDING_APPROVAL', 'APPROVED'], arr(q.ids), likeTerm(q.search)],
      'a.id, a.assembly_code, a.assembly_name, a.status, a.repairable', 'a.assembly_name, a.id', q);
  }

  async custodyLocations(q: LookupQueryDto, actor: Actor) {
    // Active only: br02_expand_equipment_group rejects an inactive location.
    const fromWhere = `
      FROM custody_locations l
     WHERE l.company_id = $1 AND l.is_active
       AND ($2::uuid[] IS NULL OR l.id = ANY($2))
       AND ($3::text IS NULL OR l.location_code ILIKE $3 OR l.location_name ILIKE $3)`;
    return this.page(fromWhere, [actor.companyId, arr(q.ids), likeTerm(q.search)],
      `l.id, l.location_code, l.location_name,
       (SELECT count(*)::int FROM inward_equipment_units u WHERE u.company_id = l.company_id AND u.current_location_id = l.id) AS units_here`,
      'l.location_name, l.id', q);
  }

  async itemBridge(q: LookupQueryDto) {
    // Resolves item_bridge_id -> code/name for any status (lines may reference a since-delisted item).
    // The bridge is a global cache of the Item Master (no company_id), like fdn_item_master itself.
    if (!arr(q.ids) && !likeTerm(q.search)) throw new BadRequestException('ids or search is required');
    const fromWhere = `
      FROM br03_item_catalog_bridge b
     WHERE ($1::uuid[] IS NULL OR b.id = ANY($1))
       AND ($2::text IS NULL OR b.item_code ILIKE $2 OR b.item_name ILIKE $2)`;
    return this.page(fromWhere, [arr(q.ids), likeTerm(q.search)],
      'b.id AS item_bridge_id, b.br01_item_id, b.item_code, b.item_name, b.uom, b.approval_status, b.is_active',
      'b.item_code, b.id', q);
  }

  // ================================================================ B-3 / B-1 equipment units

  private async loadUnit(unitId: string, actor: Actor) {
    const u = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM inward_equipment_units WHERE id=$1`, [unitId]);
    if (!u.rows[0]) throw new NotFoundException('equipment unit not found');
    if (u.rows[0].company_id !== actor.companyId) throw new ForbiddenException('equipment unit belongs to another company');
  }

  async unitPhotos(unitId: string, actor: Actor) {
    await this.loadUnit(unitId, actor);
    const r = await this.pg.query(`SELECT * FROM equipment_photos WHERE unit_id=$1 ORDER BY uploaded_at, id`, [unitId]);
    return r.rows;
  }

  /**
   * B-1: edit a unit's descriptive fields. No DB trigger constrains these columns, so the API applies the
   * conservative rule (OPEN DECISION): editable only while verification_status is PENDING or ON_HOLD --
   * once VERIFIED (Job ID issued) or REJECTED the inward record is frozen. PURCHASE only; audited.
   */
  async updateUnit(unitId: string, dto: UpdateEquipmentUnitDto, actor: Actor) {
    const changes: Record<string, string | null> = {};
    for (const k of UNIT_EDITABLE_FIELDS) {
      const v = (dto as Record<string, unknown>)[k];
      if (v === undefined) continue;
      const s = v === null ? null : String(v).trim();
      changes[k] = s === '' ? null : s;
    }
    if (!Object.keys(changes).length) {
      throw new BadRequestException(`send at least one of: ${UNIT_EDITABLE_FIELDS.join(', ')}`);
    }
    return this.pg.tx(async (client) => {
      const cur = await client.query(`SELECT * FROM inward_equipment_units WHERE id=$1 FOR UPDATE`, [unitId]);
      const before = cur.rows[0];
      if (!before) throw new NotFoundException('equipment unit not found');
      if (before.company_id !== actor.companyId) throw new ForbiddenException('equipment unit belongs to another company');
      if (!['PENDING', 'ON_HOLD'].includes(before.verification_status)) {
        throw new BadRequestException(
          `equipment unit is ${before.verification_status}: unit details can only be edited before verification`);
      }
      const changed = Object.entries(changes).filter(([k, v]) => before[k] !== v);
      if (!changed.length) return before;
      const sets = changed.map(([k], i) => `${k}=$${i + 2}`).join(', ');
      const upd = await client.query(
        `UPDATE inward_equipment_units SET ${sets} WHERE id=$1 RETURNING *`, [unitId, ...changed.map(([, v]) => v)],
      );
      const pick = (row: Record<string, unknown>) => Object.fromEntries(changed.map(([k]) => [k, row[k]]));
      await client.query(
        `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
         VALUES ($1,$2,'inward_equipment_units',$3,'BR02_UNIT_DETAILS_UPDATED',$4,$5)`,
        [actor.companyId, actor.id, unitId, pick(before), pick(upd.rows[0])],
      );
      return upd.rows[0];
    });
  }
}
