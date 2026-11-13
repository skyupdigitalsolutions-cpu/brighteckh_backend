import { Injectable } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { JOB_STATUSES } from '../br02/dto/br02.dto';
import { Actor, companyTimezone } from './purchase-desk.service';

const OPEN_JOB_STATUSES = JOB_STATUSES.filter((s) => !['CLOSED', 'CANCELLED'].includes(s));
const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * G22: P0 overview cards for Purchase. Read-only (runs in a READ ONLY transaction), company-scoped
 * from the token. "Today" and "this week" are calendar days in the company timezone. Raw counts only:
 * the Figma "4 / 16 today" style has no defined denominator, so no target/ratio is invented.
 * Every metric's definition is in the response schema (PurchaseOverview).
 */
@Injectable()
export class PurchaseOverviewService {
  constructor(private readonly pg: PgService) {}

  async overview(actor: Actor) {
    const tz = await companyTimezone(this.pg, actor.companyId);
    const co = actor.companyId;
    // today's local start as timestamptz: date_trunc on the local wall-clock, then back to an instant
    const T0 = `(date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`;
    return this.pg.readOnly(async (c) => {
      const one = async (sql: string, params: unknown[] = [co, tz]) => (await c.query(sql, params)).rows;

      const [head] = await one(`SELECT now() AS as_of, to_char(now() AT TIME ZONE $2, 'YYYY-MM-DD') AS today, $1::uuid AS _c`);
      const [verify] = await one(`
        SELECT count(*) FILTER (WHERE u.verification_status = 'PENDING')::int AS awaiting,
               count(DISTINCT u.inward_id) FILTER (WHERE u.verification_status = 'PENDING')::int AS receipts_with_pending_units,
               count(*) FILTER (WHERE u.verification_status = 'VERIFIED' AND u.verified_at >= ${T0}
                                  AND u.verified_at < ${T0} + interval '1 day')::int AS verified_today
          FROM inward_equipment_units u WHERE u.company_id = $1`);
      const [assign] = await one(`
        SELECT (SELECT count(*)::int FROM service_jobs j
                 WHERE j.company_id = $1 AND j.status NOT IN ('CLOSED','CANCELLED')
                   AND NOT EXISTS (SELECT 1 FROM job_assignments a WHERE a.job_id = j.id AND a.is_current)) AS unassigned,
               (SELECT count(*)::int FROM job_assignments a
                 WHERE a.company_id = $1 AND a.assigned_at >= ${T0} AND a.assigned_at < ${T0} + interval '1 day') AS assigned_today`);
      const [review] = await one(`
        SELECT (SELECT count(*)::int FROM br03_inspection_reports r WHERE r.company_id = $1 AND r.status = 'SUBMITTED') AS awaiting_review,
               (SELECT count(*)::int FROM br03_inspection_reports r WHERE r.company_id = $1 AND r.status = 'RETURNED') AS returned,
               (SELECT count(*)::int FROM br03_inspection_reviews rv
                  JOIN br03_inspection_report_versions v ON v.id = rv.version_id
                  JOIN br03_inspection_reports r ON r.id = v.report_id
                 WHERE r.company_id = $1 AND rv.reviewed_at >= ${T0} AND rv.reviewed_at < ${T0} + interval '1 day') AS reviewed_today`);
      const byStatus = await one(
        `SELECT status, count(*)::int AS n FROM service_jobs WHERE company_id = $1 AND status = ANY($2) GROUP BY status`,
        [co, OPEN_JOB_STATUSES],
      );
      const workload = await one(`
        SELECT e.id AS engineer_id, e.employee_code, e.full_name,
               count(j.id)::int AS open_jobs,
               count(j.id) FILTER (WHERE a.response = 'PENDING')::int AS pending_custody,
               count(*) OVER ()::int AS __total
          FROM employees e
          LEFT JOIN job_assignments a ON a.engineer_id = e.id AND a.is_current
          LEFT JOIN service_jobs j    ON j.id = a.job_id AND j.status NOT IN ('CLOSED','CANCELLED')
         WHERE e.company_id = $1 AND e.role_code = 'ENGINEER' AND e.is_active
         GROUP BY e.id
         ORDER BY open_jobs DESC, e.full_name, e.id
         LIMIT 50`, [co]);
      const engineersTotal = workload[0]?.__total
        ?? (await one(`SELECT count(*)::int AS n FROM employees WHERE company_id=$1 AND role_code='ENGINEER' AND is_active`, [co]))[0].n;
      const intake = await one(`
        WITH days AS (
          SELECT (date_trunc('week', now() AT TIME ZONE $2) + make_interval(days => i))::date AS d, i
            FROM generate_series(0, 5) i)
        SELECT to_char(d, 'YYYY-MM-DD') AS date, i,
               (SELECT COALESCE(sum(g.quantity_received), 0)::int
                  FROM inward_receipts r JOIN inward_equipment_groups g ON g.inward_id = r.id
                 WHERE r.company_id = $1 AND r.receipt_at >= (d::timestamp AT TIME ZONE $2)
                   AND r.receipt_at < ((d + 1)::timestamp AT TIME ZONE $2)) AS units_received,
               (SELECT count(*)::int FROM inward_equipment_units u
                 WHERE u.company_id = $1 AND u.verification_status = 'VERIFIED'
                   AND u.verified_at >= (d::timestamp AT TIME ZONE $2)
                   AND u.verified_at < ((d + 1)::timestamp AT TIME ZONE $2)) AS units_verified
          FROM days ORDER BY d`);
      const activity = await one(`
        SELECT l.id::text AS id, l.changed_at, l.actor_id, e.full_name AS actor_name, l.action, l.entity_table, l.entity_id
          FROM activity_audit_log l LEFT JOIN employees e ON e.id = l.actor_id
         WHERE l.company_id = $1
         ORDER BY l.changed_at DESC, l.id DESC
         LIMIT 10`, [co]);

      const counts = new Map(byStatus.map((r) => [r.status, r.n]));
      return {
        as_of: head.as_of, timezone: tz, today: head.today,
        verify_units: verify,
        assign_engineers: assign,
        review_reports: review,
        jobs_by_status: OPEN_JOB_STATUSES.map((s) => ({ status: s, count: counts.get(s) ?? 0 })),
        engineer_workload: workload.map(({ __total, ...w }) => w),
        engineers_total: engineersTotal,
        intake_this_week: intake.map(({ i, ...d }) => ({ ...d, weekday: WEEKDAYS[i] })),
        latest_activity: activity,
      };
    });
  }
}
