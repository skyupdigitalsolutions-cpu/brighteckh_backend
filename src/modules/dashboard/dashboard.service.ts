import { Injectable } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { AuthService } from '../auth/auth.service';

/** Demo employees that get a login from the seed (login_id = employee_code). */
const DEMO_LOGIN_CODES = /^(DEMO-|EMP-)/;

// Tables safe to view in the dashboard (read-only). Extend as modules land.
const VIEWABLE = new Set<string>([
  'legal_entities', 'employees',
  'fdn_item_master', 'fdn_assembly_master', 'fdn_assembly_bom',
  'fdn_suppliers', 'fdn_manufacturers', 'fdn_code_dictionary',
  'fdn_inventory_locations', 'fdn_inventory_balances',
  'fdn_inventory_journal', 'fdn_inventory_reservations',
  'service_jobs', 'inward_receipts', 'inward_equipment_units',
  'br03_material_requests',
  // BR-04 operational tables -- internal visibility only (dev-gated dashboard).
  // Includes raw supplier offer pricing (br04_supplier_offer_lines); never
  // expose these alongside customer-facing quote data outside this gate.
  'br04_stock_checks', 'br04_stock_check_lines', 'br04_shortage_sources',
  'br04_rfqs', 'br04_rfq_lines', 'br04_rfq_line_sources', 'br04_rfq_supplier_invites',
  'br04_supplier_offer_headers', 'br04_supplier_offer_versions', 'br04_supplier_offer_lines',
  'br04_repair_estimates', 'br04_estimate_revisions',
  'br04_customer_quotes', 'br04_customer_quote_revisions', 'br04_customer_quote_lines',
  'br04_quote_sales_handoffs',
  // BR-05 operational tables -- same rules as BR-04: internal visibility only
  // (dev-gated dashboard), single-table reads, never joined with each other
  // or with customer-facing data to surface pricing/authority together.
  'br05_customer_orders', 'br05_quote_revision_refs', 'br05_order_job_allocations',
  'br05_job_authorisations', 'br05_stock_rechecks',
  'br05_job_releases', 'br05_material_reservations', 'br05_customer_response_events',
  // BR-06 operational tables -- same rules again: internal visibility only
  // (dev-gated dashboard), single-table reads only, never joined.
  'br06_supplier_purchase_orders', 'br06_po_lines', 'br06_po_acknowledgements',
  'br06_shipments', 'br06_grns', 'br06_grn_lines', 'br06_grn_line_media',
  // BR-07 operational tables -- internal visibility only, single-table reads.
  'br07_material_issues', 'br07_material_consumptions', 'br07_material_returns',
  'br07_repair_sessions', 'br07_repair_time_segments',
  'br07_repair_reports', 'br07_repair_report_versions', 'br07_test_sla_targets',
  'br07_test_runs', 'br07_test_failure_reviews', 'br07_technical_handoffs', 'br07_dispatch_releases',
  'sla_instances',
  // Working calendar (migration 012).
  'working_calendars', 'working_calendar_day_rules', 'calendar_holidays',
  // BR-08 (migration 013) -- internal visibility only, single-table reads.
  'br08_dispatch_batches', 'br08_dispatch_batch_jobs', 'br08_delivery_challans', 'br08_delivery_acknowledgements',
  'br08_invoices', 'br08_invoice_jobs', 'br08_invoice_lines', 'br08_payment_receipts', 'br08_payment_allocations',
  'br08_credit_notes', 'br08_job_waivers', 'br08_fy_counters', 'br08_gst_rate_config', 'gst_states',
  // BR-09 (migration 015) -- internal visibility only, single-table reads.
  'job_repeat_links', 'br09_support_cases', 'br09_case_repeat_jobs', 'br09_technical_assessments',
  'br09_claim_decisions', 'br09_goodwill_approvals', 'br09_credit_note_requests', 'br09_customer_communications',
  'br09_case_feedback', 'br09_case_sla', 'br09_authority_config', 'br09_sla_targets',
  'br09_case_evidence', 'br09_refund_replacement_reviews', // migration 020
  // BR-10 (migration 017) -- governance config + access log.
  'br10_role_catalogue', 'br10_permission_matrix', 'br10_report_catalogue', 'br10_authority_config',
  'br10_role_bindings', 'br10_report_grants', 'br10_grant_approvals', 'br10_sales_customer_assignments',
  'br10_column_masks', 'br10_report_access_log',
  // BR-11 (migration 018) -- internal visibility only, single-table reads.
  // br06_sales_sourcing_authorisations holds SUPPLIER cost: never join it with
  // customer-facing quote/order data outside this dev-gated view.
  'br11_company_policies', 'br11_sales_enquiries', 'br11_enquiry_lines', 'br11_sale_quotations', 'br11_quote_revisions',
  'br11_quote_lines', 'br11_quote_dispatch_events', 'br11_customer_quote_responses', 'br11_sales_orders',
  'br11_sales_order_lines', 'br11_order_authorisation_events', 'br11_order_payment_conditions',
  'br11_inventory_reservation_requests', 'br11_outward_batches', 'br11_outward_lines', 'br11_packing_evidence',
  'br11_carrier_tracking_events', 'br11_delivery_evidence', 'br11_sales_change_requests',
  'br11_sales_order_closure_reviews',
  'br06_sales_sourcing_authorisations', 'br08_sales_invoice_sources', 'br08_invoice_sales_lines',
]);

// Pipeline stages -> count source. status is derived: table missing => pending.
const STAGES: { key: string; label: string; table: string }[] = [
  { key: 'items', label: 'Item Master', table: 'fdn_item_master' },
  { key: 'assemblies', label: 'Assembly Master', table: 'fdn_assembly_master' },
  { key: 'inward', label: 'BR-02 Inward/Jobs', table: 'service_jobs' },
  { key: 'material', label: 'BR-03 Material Req', table: 'br03_material_requests' },
  { key: 'quote', label: 'BR-04 Quotation', table: 'br04_customer_quote_lines' },
  { key: 'auth', label: 'BR-05 Authorisation', table: 'br05_job_authorisations' },
  { key: 'po', label: 'BR-06 PO/GRN', table: 'br06_supplier_purchase_orders' },
  { key: 'inventory', label: 'Inventory Ledger', table: 'fdn_inventory_journal' },
  { key: 'repair', label: 'BR-07 Repair/Test', table: 'br07_repair_reports' },
  { key: 'release', label: 'BR-07 Dispatch Release', table: 'br07_dispatch_releases' },
  { key: 'dispatch', label: 'BR-08 Dispatch/DC', table: 'br08_delivery_challans' },
  { key: 'invoice', label: 'BR-08 Tax Invoice', table: 'br08_invoices' },
  { key: 'payment', label: 'BR-08 Payment', table: 'br08_payment_receipts' },
  { key: 'credit_note', label: 'BR-08 Credit Note', table: 'br08_credit_notes' },
  { key: 'support_case', label: 'BR-09 After-Sales Case', table: 'br09_support_cases' },
  { key: 'repeat_return', label: 'BR-09 Repeat Return', table: 'br09_case_repeat_jobs' },
  { key: 'claim_decision', label: 'BR-09 Claim Decision', table: 'br09_claim_decisions' },
  { key: 'mis_grants', label: 'BR-10 Report Grants', table: 'br10_report_grants' },
  { key: 'mis_access', label: 'BR-10 Report Access Log', table: 'br10_report_access_log' },
  { key: 'sales_enquiry', label: 'BR-11 Sales Enquiry', table: 'br11_sales_enquiries' },
  { key: 'sales_quote', label: 'BR-11 Sales Quotation', table: 'br11_quote_revisions' },
  { key: 'sales_order', label: 'BR-11 Sales Order', table: 'br11_sales_orders' },
  { key: 'sales_reservation', label: 'BR-11 Stock Reservation', table: 'br11_inventory_reservation_requests' },
  { key: 'sales_sourcing', label: 'BR-11 Sales PO Sourcing (BR-06)', table: 'br06_sales_sourcing_authorisations' },
  { key: 'sales_outward', label: 'BR-11 Outward / POD', table: 'br11_outward_batches' },
  { key: 'sales_invoice', label: 'BR-11 Product Invoice (BR-08)', table: 'br08_sales_invoice_sources' },
  { key: 'sales_closure', label: 'BR-11 Order Closure', table: 'br11_sales_order_closure_reviews' },
];

@Injectable()
export class DashboardService {
  constructor(private readonly pg: PgService, private readonly auth: AuthService) {}

  private async safeCount(table: string): Promise<number | null> {
    try {
      const r = await this.pg.query<{ c: string }>(`SELECT count(*)::int AS c FROM ${table}`);
      return Number(r.rows[0].c);
    } catch {
      return null; // table not present yet
    }
  }

  async overview() {
    const stages = await Promise.all(
      STAGES.map(async (s) => {
        const count = await this.safeCount(s.table);
        return { key: s.key, label: s.label, status: count === null ? 'pending' : 'built', count: count ?? 0 };
      }),
    );
    return { stages };
  }

  async companies() {
    try {
      const r = await this.pg.query(`SELECT id, entity_code, name FROM legal_entities ORDER BY entity_code`);
      return r.rows;
    } catch {
      return [];
    }
  }

  async tables() {
    const out: { name: string; rows: number }[] = [];
    for (const name of VIEWABLE) {
      const c = await this.safeCount(name);
      if (c !== null) out.push({ name, rows: c });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async tableRows(name: string, limit = 50) {
    if (!VIEWABLE.has(name)) return { error: 'table not viewable' };
    const r = await this.pg.query(`SELECT * FROM ${name} ORDER BY 1 DESC LIMIT $1`, [Math.min(limit, 200)]);
    return { name, rows: r.rows };
  }

  /** DEV ONLY: idempotent seed so the demo + manual testing have real ids to use. */
  async seed() {
    return this.pg.tx(async (c) => {
      const co = await c.query(
        `WITH ins AS (
           INSERT INTO legal_entities(entity_code,name)
           SELECT 'BLR','Brightech BLR (demo)'
           WHERE NOT EXISTS (SELECT 1 FROM legal_entities WHERE entity_code='BLR')
           RETURNING id)
         SELECT id FROM ins UNION ALL SELECT id FROM legal_entities WHERE entity_code='BLR' LIMIT 1`,
      );
      const companyId = co.rows[0].id;
      // Client-confirmed config (idempotent): working calendar + BR-08 entity profile defaults.
      await c.query(`SELECT cal_seed_client_calendar($1), br08_seed_entity_profile($1)`, [companyId]);

      const emp = await c.query(
        `INSERT INTO employees(company_id,employee_code,full_name,role_code)
         VALUES ($1,'DEMO-PUR','Demo Purchase Exec','PURCHASE')
         ON CONFLICT (company_id,employee_code) DO UPDATE SET full_name=EXCLUDED.full_name
         RETURNING id`,
        [companyId],
      );
      const actorId = emp.rows[0].id;

      await c.query(
        `INSERT INTO fdn_code_dictionary(kind,cc,ss,tt,label)
         VALUES ('ITEM','02','02','02','Capacitor / Electrolytic / Aluminium')
         ON CONFLICT (kind,cc,ss,tt) DO NOTHING`,
      );

      const locs: Record<string, string> = {};
      for (const [code, role] of [['MAIN', 'MAIN_STORE'], ['ENG1', 'ENGINEER_HELD'], ['CONS', 'CONSUMED'], ['QUAR', 'QUARANTINE']]) {
        const l = await c.query(
          `INSERT INTO fdn_inventory_locations(company_id,code,role)
           VALUES ($1,$2,$3) ON CONFLICT (company_id,code) DO UPDATE SET role=EXCLUDED.role
           RETURNING id`,
          [companyId, code, role],
        );
        locs[role] = l.rows[0].id;
      }

      // Demo logins (login_id = employee_code). Password comes ONLY from the
      // DEMO_LOGIN_PASSWORD env var -- never hardcoded, never returned. Existing
      // credentials are never overwritten.
      const password = process.env.DEMO_LOGIN_PASSWORD;
      const demo = (await c.query(
        `SELECT id, employee_code, role_code FROM employees
          WHERE company_id=$1 AND is_active ORDER BY employee_code`, [companyId],
      )).rows.filter((e) => DEMO_LOGIN_CODES.test(e.employee_code));
      const demoLogins = [];
      for (const e of demo) {
        const created = password ? await this.auth.ensureCredential(c, e.id, e.employee_code, password) : false;
        const has = (await c.query(`SELECT 1 FROM employee_credentials WHERE employee_id=$1`, [e.id])).rowCount! > 0;
        demoLogins.push({ login_id: e.employee_code, role: e.role_code, has_login: has, created_now: created });
      }

      return {
        company_id: companyId, actor_id: actorId, locations: locs,
        login_id: 'DEMO-PUR',
        demo_logins: demoLogins,
        login_note: password
          ? 'Log in with one of demo_logins[].login_id and the DEMO_LOGIN_PASSWORD from .env'
          : 'DEMO_LOGIN_PASSWORD is not set in .env -- no demo logins were created',
      };
    });
  }
}
