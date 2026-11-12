import { PoolClient } from 'pg';
import { Entitlement } from './br10-access.service';

export interface Period { from: string; to: string }
export interface Readiness { item: string; status: string; note: string }
export interface ReportResult {
  summary: Record<string, unknown>;
  rows: Record<string, unknown>[];
  readiness: Readiness[];
  formulas?: Record<string, string>;
}

/**
 * BR-10 report queries. Contract:
 *   - SELECT / GROUP BY only; executed inside PgService.readOnly() (Postgres-enforced).
 *   - company filter = the entitled company set; row filter = the entitled row scope.
 *   - money stays in integer paise / source numeric; missing sources return NULL with a
 *     readiness reason, never a silent zero (10A-10, T24).
 *   - supplier cost / margin appears ONLY in JOB_PROFITABILITY (MARGIN_PROFIT class).
 */
type Q = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/** SQL predicate + params for the row scope, applied to a job alias / customer column. */
function scopeOn(ent: Entitlement, p: unknown[], cols: { job?: string; customer?: string; engineer?: string }) {
  const s = ent.rowScope;
  if (s.kind === 'COMPANY') return 'true';
  if (s.kind === 'CUSTOMERS') {
    if (!cols.customer) return 'false';
    p.push(s.customerIds); return `${cols.customer} = ANY($${p.length}::uuid[])`;
  }
  if (s.kind === 'JOBS') {
    if (!cols.job) return 'false';
    p.push(s.engineerId);
    return `EXISTS (SELECT 1 FROM job_assignments ja WHERE ja.job_id=${cols.job} AND ja.is_current AND ja.engineer_id=$${p.length})`;
  }
  if (!cols.engineer) return 'false';
  p.push(s.employeeId); return `${cols.engineer} = $${p.length}`;
}

const JOB_CUSTOMER = (j: string) => `(SELECT r.customer_id FROM inward_receipts r WHERE r.id=${j}.inward_id)`;

export async function runReport(client: PoolClient, ent: Entitlement, period: Period): Promise<ReportResult> {
  const q: Q = async (sql, params) => (await client.query(sql, params)).rows;
  const base = (): unknown[] => [ent.companyIds, period.from, period.to];
  switch (ent.report.report_code) {
    case 'SERVICE_PIPELINE': return servicePipeline(q, ent, base());
    case 'QUALITY_WARRANTY': return qualityWarranty(q, ent, base());
    case 'SLA_MONITOR': return slaMonitor(q, ent, base());
    case 'PROCUREMENT_SUMMARY': return procurement(q, ent, base());
    case 'INVENTORY_POSITION': return inventory(q, ent);
    case 'RECEIVABLES_AGING': return receivables(q, ent);
    case 'RECEIVABLE_STATUS': return receivableStatus(q, ent, base());
    case 'JOB_PROFITABILITY': return profitability(q, ent, base());
    case 'ENGINEER_PERFORMANCE': return engineerPerformance(q, ent, base());
    case 'ACCESS_AUDIT': return accessAudit(q, ent, base());
    default: throw new Error(`report ${ent.report.report_code} has no query`);
  }
}

// Period predicate on a timestamptz column, in each row's company-local date.
const inPeriod = (col: string, company: string) =>
  `(${col} AT TIME ZONE br08_company_tz(${company}))::date BETWEEN $2::date AND $3::date`;

async function servicePipeline(q: Q, ent: Entitlement, p: unknown[]): Promise<ReportResult> {
  const scope = scopeOn(ent, p, { job: 'sj.id', customer: JOB_CUSTOMER('sj') });
  const engineerView = ent.rowScope.kind === 'JOBS'; // engineers get no customer fields (T29)
  const rows = await q(
    `SELECT le.entity_code AS company, sj.id AS job_id, sj.job_number, sj.status AS job_status, sj.priority,
            sj.created_at, ${engineerView ? 'NULL::uuid AS customer_id, NULL::text AS customer_name'
                                          : 'c.id AS customer_id, c.customer_name'},
            (rl.job_id IS NOT NULL) AS is_repeat, rl.repeat_ref, ja.engineer_id, e.full_name AS engineer_name,
            EXISTS (SELECT 1 FROM br03_inspection_reports ir JOIN br03_inspection_report_versions v ON v.report_id=ir.id
                     WHERE ir.job_id=sj.id AND v.version_status='ACCEPTED') AS inspection_accepted,
            EXISTS (SELECT 1 FROM br05_job_authorisations a WHERE a.job_id=sj.id AND a.is_current AND a.authorisation_status='AUTHORISED') AS authorised,
            EXISTS (SELECT 1 FROM br05_job_releases jr WHERE jr.job_id=sj.id AND jr.release_status='RELEASED') AS released,
            EXISTS (SELECT 1 FROM br07_dispatch_releases d WHERE d.job_id=sj.id) AS dispatch_released,
            EXISTS (SELECT 1 FROM br08_dispatch_batch_jobs bj JOIN br08_dispatch_batches b ON b.id=bj.batch_id
                     WHERE bj.job_id=sj.id AND b.batch_status='DISPATCHED') AS dispatched,
            EXISTS (SELECT 1 FROM br08_invoice_jobs ij WHERE ij.job_id=sj.id AND ij.is_live) AS invoiced,
            EXISTS (SELECT 1 FROM br08_job_waivers w WHERE w.job_id=sj.id) AS waived,
            sj.closed_at
       FROM service_jobs sj
       JOIN legal_entities le ON le.id=sj.company_id
       JOIN inward_receipts r ON r.id=sj.inward_id
       JOIN customers c ON c.id=r.customer_id
       LEFT JOIN job_repeat_links rl ON rl.job_id=sj.id
       LEFT JOIN job_assignments ja ON ja.job_id=sj.id AND ja.is_current
       LEFT JOIN employees e ON e.id=ja.engineer_id
      WHERE sj.company_id = ANY($1::uuid[]) AND ${inPeriod('sj.created_at', 'sj.company_id')} AND ${scope}
      ORDER BY sj.created_at DESC LIMIT 2000`, p);
  const by = (k: string) => rows.reduce<Record<string, number>>((o, r) => { const v = String(r[k] ?? 'UNASSIGNED'); o[v] = (o[v] ?? 0) + 1; return o; }, {});
  const active = rows.filter((r) => !['CLOSED', 'CANCELLED'].includes(String(r.job_status)));
  return {
    summary: {
      jobs: rows.length, active_jobs: active.length, repeat_jobs: rows.filter((r) => r.is_repeat).length,
      by_status: by('job_status'), by_priority: by('priority'),
      active_by_engineer: active.reduce<Record<string, number>>((o, r) => { const k = String(r.engineer_name ?? 'UNASSIGNED'); o[k] = (o[k] ?? 0) + 1; return o; }, {}),
      // Missing milestone (10A-10): delivered but neither invoiced nor waived as no-charge.
      dispatched_not_invoiced: rows.filter((r) => r.dispatched && !r.invoiced && !r.waived).length,
    },
    rows,
    readiness: [{ item: 'Workload', status: 'COUNTS_ONLY', note: 'Assigned active jobs only; productivity is not inferred from elapsed time (10A-05)' }],
  };
}

async function qualityWarranty(q: Q, ent: Entitlement, p: unknown[]): Promise<ReportResult> {
  const pj = [...p];
  const jobScope = scopeOn(ent, pj, { job: 'sj.id', customer: JOB_CUSTOMER('sj') });
  const [jobs] = await q(
    `SELECT count(*)::int AS jobs, count(rl.job_id)::int AS repeat_jobs
       FROM service_jobs sj LEFT JOIN job_repeat_links rl ON rl.job_id=sj.id
      WHERE sj.company_id = ANY($1::uuid[]) AND ${inPeriod('sj.created_at', 'sj.company_id')} AND ${jobScope}`, pj);
  const pc = [...p];
  const caseScope = ent.rowScope.kind === 'JOBS'
    ? scopeOn(ent, pc, { job: 'c.original_job_id' })
    : scopeOn(ent, pc, { customer: 'c.customer_id' });
  const rows = await q(
    `SELECT c.case_number, c.complaint_type, c.channel, c.case_status, c.warranty_status, c.closure_disposition,
            oj.job_number AS original_job_number,
            (SELECT count(*)::int FROM br09_case_repeat_jobs rj WHERE rj.case_id=c.id) AS repeat_returns,
            (SELECT array_agg(DISTINCT a.outcome) FROM br09_technical_assessments a WHERE a.case_id=c.id) AS outcomes,
            (SELECT resolution FROM br09_claim_decisions d WHERE d.case_id=c.id AND d.is_current) AS resolution,
            c.registered_at
       FROM br09_support_cases c LEFT JOIN service_jobs oj ON oj.id=c.original_job_id
      WHERE c.company_id = ANY($1::uuid[]) AND ${inPeriod('c.registered_at', 'c.company_id')} AND ${caseScope}
      ORDER BY c.registered_at DESC LIMIT 2000`, pc);
  const count = (k: string) => rows.reduce<Record<string, number>>((o, r) => { const v = String(r[k] ?? 'NONE'); o[v] = (o[v] ?? 0) + 1; return o; }, {});
  const outcomes: Record<string, number> = {};
  rows.forEach((r) => ((r.outcomes as string[] | null) ?? []).forEach((o) => { outcomes[o] = (outcomes[o] ?? 0) + 1; }));
  const total = Number(jobs.jobs);
  return {
    summary: {
      jobs: total, repeat_jobs: jobs.repeat_jobs,
      repeat_job_rate: total ? Number(jobs.repeat_jobs) / total : null,
      cases: rows.length, complaint_types: count('complaint_type'), resolutions: count('resolution'),
      technical_outcomes: outcomes, goodwill_cases: rows.filter((r) => r.resolution === 'GOODWILL').length,
    },
    rows,
    readiness: [{ item: 'Complaints vs warranty', status: 'INFO', note: 'A complaint is not a valid warranty claim; repeat = BR-02 repeat link only (10A-07, 10B-09, T14)' }],
    formulas: { repeat_job_rate: 'jobs with a BR-02 job_repeat_links row / jobs created in period (null if no jobs)' },
  };
}

async function slaMonitor(q: Q, ent: Entitlement, p: unknown[]): Promise<ReportResult> {
  const ps = [...p];
  const scope = scopeOn(ent, ps, { job: 'sj.id', customer: JOB_CUSTOMER('sj') });
  const jobSla = await q(
    `SELECT 'JOB' AS source, split_part(s.event_code,'_',1) AS module, s.event_code, sj.priority, s.state,
            sj.job_number AS reference, s.started_at, s.due_at, s.completed_at,
            (s.due_at IS NULL) AS due_not_computed,
            (s.completed_at IS NULL AND s.due_at IS NOT NULL AND now() > s.due_at) AS overdue_open
       FROM sla_instances s JOIN service_jobs sj ON sj.id=s.job_id
      WHERE s.company_id = ANY($1::uuid[]) AND ${inPeriod('s.started_at', 's.company_id')} AND ${scope}`, ps);
  const pc = [...p];
  const caseScope = ent.rowScope.kind === 'JOBS'
    ? scopeOn(ent, pc, { job: 'c.original_job_id' }) : scopeOn(ent, pc, { customer: 'c.customer_id' });
  const caseSla = await q(
    `SELECT 'CASE' AS source, 'BR09' AS module, s.event_code, c.priority, s.state, c.case_number AS reference,
            s.started_at, s.due_at, s.completed_at, (s.due_at IS NULL) AS due_not_computed,
            (s.completed_at IS NULL AND s.due_at IS NOT NULL AND now() > s.due_at) AS overdue_open
       FROM br09_case_sla s JOIN br09_support_cases c ON c.id=s.case_id
      WHERE c.company_id = ANY($1::uuid[]) AND ${inPeriod('s.started_at', 'c.company_id')} AND ${caseScope}`, pc);
  const rows = [...jobSla, ...caseSla];
  const groups: Record<string, number> = {};
  rows.forEach((r) => { const k = `${r.module}|${r.event_code}|${r.priority}|${r.state}`; groups[k] = (groups[k] ?? 0) + 1; });
  const [cal] = await q(`SELECT count(*)::int AS n FROM working_calendars WHERE company_id = ANY($1::uuid[]) AND is_active`, [ent.companyIds]);
  return {
    summary: {
      clocks: rows.length, open: rows.filter((r) => r.state === 'OPEN').length,
      overdue_open: rows.filter((r) => r.overdue_open).length,
      due_not_computed: rows.filter((r) => r.due_not_computed).length,
      by_module_event_priority_state: groups,
    },
    rows,
    readiness: [
      { item: 'Working calendar', status: Number(cal.n) === ent.companyIds.length ? 'ACTIVE' : 'PENDING_CONFIG',
        note: 'Due dates computed from migration-012 calendars (10C-02)' },
      { item: 'BR-09 case targets', status: 'PENDING_CONFIG', note: 'br09_sla_targets unseeded -> case clocks show NO_TARGET' },
      { item: 'Alerts / 75% reminder / +2h escalation', status: 'PENDING_CONFIG', note: 'Thresholds and recipients pending (10C-03/04, P11, P15); no alerts emitted' },
    ],
  };
}

async function procurement(q: Q, ent: Entitlement, p: unknown[]): Promise<ReportResult> {
  // No PO value / unit price here: supplier cost is MARGIN_PROFIT-gated.
  const rows = await q(
    `SELECT le.entity_code AS company, po.po_number, sj.job_number, po.po_status, po.supplier_name_snapshot,
            po.created_at, po.released_at, ack.acknowledged_at, ack.expected_delivery_date,
            CASE WHEN ack.acknowledged_at IS NOT NULL AND po.released_at IS NOT NULL
                 THEN round(EXTRACT(EPOCH FROM ack.acknowledged_at - po.released_at)/3600.0, 2) END AS ack_delay_hours,
            (SELECT count(*)::int FROM br06_po_lines l WHERE l.po_id=po.id) AS lines,
            (SELECT COALESCE(sum(g.accepted_quantity),0) FROM br06_grn_lines g JOIN br06_po_lines l ON l.id=g.po_line_id WHERE l.po_id=po.id AND g.posted_at IS NOT NULL) AS grn_accepted_qty,
            (SELECT COALESCE(sum(g.rejected_quantity),0) FROM br06_grn_lines g JOIN br06_po_lines l ON l.id=g.po_line_id WHERE l.po_id=po.id AND g.posted_at IS NOT NULL) AS grn_rejected_qty,
            (SELECT COALESCE(sum(g.held_quantity),0) FROM br06_grn_lines g JOIN br06_po_lines l ON l.id=g.po_line_id WHERE l.po_id=po.id AND g.posted_at IS NOT NULL) AS grn_held_qty
       FROM br06_supplier_purchase_orders po
       JOIN legal_entities le ON le.id=po.company_id
       JOIN service_jobs sj ON sj.id=po.job_id
       LEFT JOIN br06_po_acknowledgements ack ON ack.po_id=po.id
      WHERE po.company_id = ANY($1::uuid[]) AND ${inPeriod('po.created_at', 'po.company_id')} AND ${scopeOn(ent, p, { job: 'sj.id' })}
      ORDER BY po.created_at DESC LIMIT 2000`, p);
  const delays = rows.map((r) => r.ack_delay_hours).filter((x) => x !== null).map(Number);
  const status: Record<string, number> = {};
  rows.forEach((r) => { status[String(r.po_status)] = (status[String(r.po_status)] ?? 0) + 1; });
  return {
    summary: {
      purchase_orders: rows.length, by_status: status,
      avg_ack_delay_hours: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null,
      grn_accepted_qty: rows.reduce((a, r) => a + Number(r.grn_accepted_qty), 0),
      grn_rejected_qty: rows.reduce((a, r) => a + Number(r.grn_rejected_qty), 0),
      grn_held_qty: rows.reduce((a, r) => a + Number(r.grn_held_qty), 0),
      supplier_performance: null, supplier_lead_time: null,
    },
    rows,
    readiness: [
      { item: 'Supplier performance by supplier', status: 'SUPPLIER_MASTER_PENDING', note: 'Needs canonical Supplier Master IDs (10B-02, T09)' },
      { item: 'Supplier lead time / on-time %', status: 'DRAFT', note: 'Partial-delivery and exclusion rules pending (10B-08, P09, T23)' },
    ],
  };
}

async function inventory(q: Q, ent: Entitlement): Promise<ReportResult> {
  const p: unknown[] = [ent.companyIds];
  const rows = await q(
    `SELECT le.entity_code AS company, i.item_code, i.standard_name, l.role AS location_role, l.code AS location_code,
            b.qty_on_hand, b.updated_at
       FROM fdn_inventory_balances b
       JOIN fdn_item_master i ON i.id=b.item_id
       JOIN fdn_inventory_locations l ON l.id=b.location_id
       JOIN legal_entities le ON le.id=b.company_id
      WHERE b.company_id = ANY($1::uuid[]) AND b.qty_on_hand <> 0 AND ${scopeOn(ent, p, {})}
      ORDER BY i.item_code, l.role LIMIT 5000`, p);
  const [res] = await q(
    `SELECT count(*)::int AS active_reservations, COALESCE(sum(qty),0) AS reserved_qty
       FROM fdn_inventory_reservations WHERE company_id = ANY($1::uuid[]) AND status='ACTIVE'`, [ent.companyIds]);
  const byRole: Record<string, number> = {};
  rows.forEach((r) => { byRole[String(r.location_role)] = (byRole[String(r.location_role)] ?? 0) + Number(r.qty_on_hand); });
  return {
    summary: { balance_rows: rows.length, qty_by_location_role: byRole, ...res },
    rows,
    readiness: [{ item: 'Source', status: 'LEDGER', note: 'Authoritative fdn_inventory_balances only; never BR-06/07 requests (10B-03/04, T10)' }],
  };
}

const AGING = `CASE WHEN d.days_overdue <= 0 THEN 'NOT_DUE' WHEN d.days_overdue <= 30 THEN '1-30'
                    WHEN d.days_overdue <= 60 THEN '31-60' WHEN d.days_overdue <= 90 THEN '61-90' ELSE '90+' END`;

async function receivables(q: Q, ent: Entitlement): Promise<ReportResult> {
  // Posted invoices + confirmed allocations only (BR-08 has no drafts; cancelled excluded).
  const p: unknown[] = [ent.companyIds];
  const rows = await q(
    `SELECT d.*, ${AGING} AS aging_bucket FROM (
       SELECT le.entity_code AS company, i.invoice_number, i.customer_name, i.customer_gstin, i.invoice_date, i.due_date,
              i.invoice_status, i.total_paise, i.amount_paid_paise, (i.total_paise - i.amount_paid_paise) AS balance_paise,
              (br08_local_today(i.company_id) - i.due_date) AS days_overdue
         FROM br08_invoices i JOIN legal_entities le ON le.id=i.company_id
        WHERE i.company_id = ANY($1::uuid[]) AND i.invoice_status IN ('ISSUED','PARTIALLY_PAID')
          AND ${scopeOn(ent, p, { customer: 'i.customer_id' })}) d
      ORDER BY d.days_overdue DESC LIMIT 5000`, p);
  const buckets: Record<string, number> = {};
  rows.forEach((r) => { buckets[String(r.aging_bucket)] = (buckets[String(r.aging_bucket)] ?? 0) + Number(r.balance_paise); });
  const [unalloc] = await q(
    `SELECT COALESCE(sum(amount_paise - allocated_paise),0) AS unallocated_receipts_paise
       FROM br08_payment_receipts WHERE company_id = ANY($1::uuid[])`, [ent.companyIds]);
  return {
    summary: {
      open_invoices: rows.length, outstanding_paise: rows.reduce((a, r) => a + Number(r.balance_paise), 0),
      outstanding_by_aging_bucket_paise: buckets, ...unalloc,
    },
    rows,
    readiness: [
      { item: 'Aging buckets', status: 'DRAFT', note: 'NOT_DUE / 1-30 / 31-60 / 61-90 / 90+ days past due date -- bucket edges not client-confirmed' },
      { item: 'TDS', status: 'NOT_MODELLED', note: 'BR-08 open decision 6: TDS short-payments stay outstanding' },
    ],
  };
}

async function receivableStatus(q: Q, ent: Entitlement, p: unknown[]): Promise<ReportResult> {
  // Sales tier: status + due date only; no amounts, no bank data (permission matrix R_SALES_EXEC).
  const rows = await q(
    `SELECT i.invoice_number, i.customer_name, i.invoice_date, i.due_date, i.invoice_status,
            CASE WHEN i.invoice_status IN ('ISSUED','PARTIALLY_PAID') THEN br08_local_today(i.company_id) - i.due_date END AS days_overdue
       FROM br08_invoices i
      WHERE i.company_id = ANY($1::uuid[])
        AND i.invoice_date BETWEEN $2::date AND $3::date AND ${scopeOn(ent, p, { customer: 'i.customer_id' })}
      ORDER BY i.due_date LIMIT 2000`, p);
  const st: Record<string, number> = {};
  rows.forEach((r) => { st[String(r.invoice_status)] = (st[String(r.invoice_status)] ?? 0) + 1; });
  return {
    summary: { invoices: rows.length, by_status: st, overdue: rows.filter((r) => Number(r.days_overdue) > 0).length },
    rows,
    readiness: [{ item: 'Amounts', status: 'WITHHELD', note: 'Receivable-status tier shows status/due date only; amounts need a RECEIVABLES grant' }],
  };
}

async function profitability(q: Q, ent: Entitlement, p: unknown[]): Promise<ReportResult> {
  const rows = await q(
    `SELECT x.*, CASE WHEN x.invoiced_taxable_paise IS NOT NULL
                      THEN x.invoiced_taxable_paise - round(x.supplier_po_cost * 100)::bigint END AS provisional_margin_paise,
            CASE WHEN x.invoiced_taxable_paise > 0
                 THEN round(((x.invoiced_taxable_paise - x.supplier_po_cost * 100) * 100.0 / x.invoiced_taxable_paise)::numeric, 2) END AS provisional_margin_pct
       FROM (
         SELECT le.entity_code AS company, sj.id AS job_id, sj.job_number, c.customer_name,
                (SELECT a.authorised_amount_pre_tax FROM br05_job_authorisations a
                  WHERE a.job_id=sj.id AND a.is_current AND a.authorisation_status='AUTHORISED') AS authorised_value,
                (SELECT sum(l.taxable_paise) FROM br08_invoice_lines l JOIN br08_invoice_jobs ij
                    ON ij.invoice_id=l.invoice_id AND ij.job_id=l.job_id AND ij.is_live WHERE l.job_id=sj.id) AS invoiced_taxable_paise,
                COALESCE((SELECT sum(pl.quantity * pl.unit_price) FROM br06_po_lines pl
                    JOIN br06_supplier_purchase_orders po ON po.id=pl.po_id
                   WHERE po.job_id=sj.id AND po.po_status NOT IN ('DRAFT','CANCELLED')), 0) AS supplier_po_cost
           FROM service_jobs sj
           JOIN legal_entities le ON le.id=sj.company_id
           JOIN inward_receipts r ON r.id=sj.inward_id
           JOIN customers c ON c.id=r.customer_id
          WHERE sj.company_id = ANY($1::uuid[]) AND ${inPeriod('sj.created_at', 'sj.company_id')}
            AND ${scopeOn(ent, p, { job: 'sj.id', customer: JOB_CUSTOMER('sj') })}
            AND EXISTS (SELECT 1 FROM br05_job_authorisations a WHERE a.job_id=sj.id)
       ) x ORDER BY x.job_number LIMIT 2000`, p);
  const inv = rows.filter((r) => r.invoiced_taxable_paise !== null);
  return {
    summary: {
      jobs: rows.length, invoiced_jobs: inv.length,
      invoiced_taxable_paise: inv.reduce((a, r) => a + Number(r.invoiced_taxable_paise), 0),
      supplier_po_cost: inv.reduce((a, r) => a + Number(r.supplier_po_cost), 0),
      provisional_margin_paise: inv.reduce((a, r) => a + Number(r.provisional_margin_paise), 0),
      kpi_status: 'UNVERIFIED',
    },
    rows,
    readiness: [{ item: 'Margin basis', status: 'UNVERIFIED', note: 'Margin bases and cost allocation pending (10B-05, P10); labour/stock/freight costs not included' }],
    formulas: {
      provisional_margin_paise: 'invoiced taxable value (live BR-08 invoice lines for the job) - job-linked supplier PO cost (BR-06 lines qty x unit_price, POs not DRAFT/CANCELLED) x 100',
      provisional_margin_pct: 'provisional margin / invoiced taxable value x 100',
    },
  };
}

async function engineerPerformance(q: Q, ent: Entitlement, p: unknown[]): Promise<ReportResult> {
  const rows = await q(
    `SELECT sj.job_number, sj.status AS job_status, ja.assigned_at, ja.response,
            COALESCE((SELECT sum(t.active_seconds) FROM br03_v_engineer_time_totals t WHERE t.job_id=sj.id AND t.engineer_id=ja.engineer_id),0) AS inspection_active_seconds,
            COALESCE((SELECT sum(t.active_seconds) FROM br07_v_repair_time_totals t WHERE t.job_id=sj.id AND t.engineer_id=ja.engineer_id),0) AS repair_active_seconds
       FROM job_assignments ja JOIN service_jobs sj ON sj.id=ja.job_id
      WHERE ja.company_id = ANY($1::uuid[]) AND ${inPeriod('ja.assigned_at', 'ja.company_id')}
        AND ${scopeOn(ent, p, { engineer: 'ja.engineer_id' })}
      ORDER BY ja.assigned_at DESC LIMIT 2000`, p);
  return {
    summary: {
      assignments: rows.length,
      active_assigned: rows.filter((r) => !['CLOSED', 'CANCELLED'].includes(String(r.job_status))).length,
      completed: rows.filter((r) => r.job_status === 'CLOSED').length,
      inspection_active_seconds: rows.reduce((a, r) => a + Number(r.inspection_active_seconds), 0),
      repair_active_seconds: rows.reduce((a, r) => a + Number(r.repair_active_seconds), 0),
    },
    rows,
    readiness: [{ item: 'Productivity', status: 'NOT_INFERRED', note: 'Active jobs, recorded time and completions shown separately (10A-05)' }],
  };
}

async function accessAudit(q: Q, ent: Entitlement, p: unknown[]): Promise<ReportResult> {
  const rows = await q(
    `SELECT l.occurred_at, e.employee_code, l.report_code, l.action, l.outcome, l.export_format,
            l.row_scope, l.row_count, l.filter_checksum, l.filters, l.denial_reason
       FROM br10_report_access_log l JOIN employees e ON e.id=l.employee_id
      WHERE l.company_id = ANY($1::uuid[]) AND ${inPeriod('l.occurred_at', 'l.company_id')} AND ${scopeOn(ent, p, {})}
      ORDER BY l.occurred_at DESC LIMIT 5000`, p);
  const src = await q(
    `SELECT entity_table, count(*)::int AS events FROM activity_audit_log
      WHERE company_id = ANY($1::uuid[]) AND ${inPeriod('changed_at', 'company_id')}
      GROUP BY entity_table ORDER BY events DESC`, [ent.companyIds, p[1], p[2]]);
  const by: Record<string, number> = {};
  rows.forEach((r) => { const k = `${r.report_code}|${r.action}|${r.outcome}`; by[k] = (by[k] ?? 0) + 1; });
  return { summary: { access_events: rows.length, by_report_action_outcome: by, source_audit_events_by_table: src }, rows, readiness: [] };
}
