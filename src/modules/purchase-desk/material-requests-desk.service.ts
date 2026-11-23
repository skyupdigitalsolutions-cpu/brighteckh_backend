import { Injectable } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { Actor, likeTerm, paging } from './purchase-desk.service';
import { MR_STATUSES, MrStatus, PurchaseMrListQueryDto } from './dto/material-requests-desk.dto';

/**
 * Purchase material-request inbox (CLAUDE.md §4i "Purchase MR inbox"). Read-only, company from the token. Never joins
 * BR-04 offers / estimates / prices or any supplier table, and never returns lines.
 */

/** $1 = company, $2 = search term. Header + names; the base the counts and the list share. */
const BASE_SQL = `
  WITH base AS (
    SELECT m.id, m.request_number, m.status, m.priority,
           to_char(m.required_by_date, 'YYYY-MM-DD') AS required_by_date, m.required_by_reason,
           m.created_at, m.submitted_at, m.self_edit_deadline_at, m.purchase_processing_started_at,
           ps.full_name AS purchase_started_by_name, m.closed_at,
           m.job_id, j.job_number, c.customer_name,
           m.responsible_engineer_id, e.full_name AS responsible_engineer_name
      FROM br03_material_requests m
      JOIN service_jobs j     ON j.id = m.job_id AND j.company_id = m.company_id
      JOIN inward_receipts r  ON r.id = j.inward_id AND r.company_id = j.company_id
      JOIN customers c        ON c.id = r.customer_id AND c.company_id = r.company_id
      JOIN employees e        ON e.id = m.responsible_engineer_id
      LEFT JOIN employees ps  ON ps.id = m.purchase_started_by_id
     WHERE m.company_id = $1
       AND ($2::text IS NULL OR m.request_number ILIKE $2 OR j.job_number ILIKE $2
            OR e.full_name ILIKE $2 OR c.customer_name ILIKE $2))`;

const ORDER = `ORDER BY CASE status WHEN 'CHANGE_REQUESTED' THEN 0 WHEN 'SUBMITTED' THEN 1 ELSE 2 END,
                        CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END,
                        COALESCE(submitted_at, created_at) DESC, request_number DESC, id`;

@Injectable()
export class MaterialRequestsDeskService {
  constructor(private readonly pg: PgService) {}

  /** GET /purchase/material-requests */
  async list(q: PurchaseMrListQueryDto, actor: Actor) {
    const { page, pageSize, offset } = paging(q);
    const baseParams = [actor.companyId, likeTerm(q.search)];
    // $3 statuses, $4 priorities, $5 job, $6 engineer
    const filtered = `${BASE_SQL}
      SELECT * FROM base
       WHERE ($3::text[] IS NULL OR status = ANY($3))
         AND ($4::text[] IS NULL OR priority = ANY($4))
         AND ($5::uuid IS NULL OR job_id = $5)
         AND ($6::uuid IS NULL OR responsible_engineer_id = $6)`;
    const params = [
      ...baseParams, q.status?.length ? q.status : null, q.priority?.length ? q.priority : null,
      q.job_id ?? null, q.engineer_id ?? null,
    ];

    const [counts, total, rows] = await Promise.all([
      this.pg.query<{ status: MrStatus; n: number }>(
        `${BASE_SQL} SELECT status, count(*)::int AS n FROM base GROUP BY status`, baseParams),
      this.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${filtered}) f`, params),
      this.pg.query(`
        SELECT f.*, br03_can_engineer_edit(f.id) AS engineer_can_edit,
               ln.lines_count, cr.pending_change_requests, cr.latest_change_request_at
          FROM (${filtered} ${ORDER} LIMIT $7 OFFSET $8) f
          JOIN LATERAL (
            SELECT count(*)::int AS lines_count FROM br03_material_request_lines l WHERE l.request_id = f.id) ln ON true
          JOIN LATERAL (
            SELECT count(*) FILTER (WHERE x.review_status = 'PENDING')::int AS pending_change_requests,
                   max(a.created_at) AS latest_change_request_at
              FROM br03_material_change_requests x
              LEFT JOIN LATERAL (
                SELECT min(l.changed_at) AS created_at FROM activity_audit_log l
                 WHERE l.entity_id = x.id AND l.company_id = $1
                   AND l.entity_table = 'br03_material_change_requests' AND l.action = 'BR03_CHANGE_REQUEST_CREATED') a ON true
             WHERE x.material_request_id = f.id) cr ON true
         ${ORDER}`, [...params, pageSize, offset]),
    ]);

    const counts_by_status = Object.fromEntries(MR_STATUSES.map((s) => [s, 0])) as Record<MrStatus, number>;
    for (const r of counts.rows) counts_by_status[r.status] = r.n;

    return {
      rows: rows.rows.map((r) => ({
        id: r.id, request_number: r.request_number, status: r.status, priority: r.priority,
        required_by_date: r.required_by_date, required_by_reason: r.required_by_reason,
        created_at: r.created_at, submitted_at: r.submitted_at, self_edit_deadline_at: r.self_edit_deadline_at,
        purchase_processing_started_at: r.purchase_processing_started_at,
        purchase_started_by_name: r.purchase_started_by_name, closed_at: r.closed_at,
        engineer_can_edit: r.engineer_can_edit,
        job_id: r.job_id, job_number: r.job_number, customer_name: r.customer_name,
        responsible_engineer_id: r.responsible_engineer_id, responsible_engineer_name: r.responsible_engineer_name,
        lines_count: r.lines_count, pending_change_requests: r.pending_change_requests,
        latest_change_request_at: r.latest_change_request_at,
      })),
      total: total.rows[0].n, page, page_size: pageSize, counts_by_status,
    };
  }
}
