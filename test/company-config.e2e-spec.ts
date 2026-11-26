import { Client } from 'pg';
import { api, db, dbRejects, Fixtures, fails, ok, setupFixtures } from './helpers';

/**
 * Client-confirmed config (migration 026, 26 Nov 2026): GET / PUT /company-config, plus the DB rules 026 changed.
 * Every config row this suite touches is saved first and restored afterwards; rule checks run in rolled-back
 * transactions (dbRejects) or against existing rows only.
 */
describe('Company config + client-confirmed rules (026)', () => {
  let c: Client;
  let f: Fixtures;
  let saved: any[] = [];

  const restore = async () => {
    await c.query(`DELETE FROM company_policy_config WHERE company_id=$1`, [f.companyId]);
    for (const r of saved) {
      const cols = Object.keys(r);
      await c.query(`INSERT INTO company_policy_config(${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        cols.map((k) => r[k]));
    }
  };

  beforeAll(async () => {
    c = await db();
    f = await setupFixtures(c);
    saved = (await c.query(`SELECT * FROM company_policy_config WHERE company_id=$1`, [f.companyId])).rows;
    await c.query(`DELETE FROM company_policy_config WHERE company_id=$1`, [f.companyId]);
  });

  afterAll(async () => {
    await restore();
    await c.end();
  });

  describe('GET / PUT /company-config', () => {
    it('unset: no row, effective discount threshold falls back to 10%', async () => {
      const r = ok(await api('get', '/company-config', f.sales));
      expect(r.policy).toBeNull();
      expect(r.effective_max_discount_percent).toBe('10');
      expect(r.enforced).toEqual(['max_discount_percent']);
      expect(r.stored_only).toContain('customer_return_window_days');
    });

    it('PUT is SYSTEM_ADMIN only', async () => {
      for (const who of [f.purchase, f.finance, f.mgmt, f.sales]) {
        fails(await api('put', '/company-config', who, { max_discount_percent: 5 }), 403);
      }
    });

    it('admin sets the client values; omitted fields stay, null clears; audited', async () => {
      const r = ok(await api('put', '/company-config', f.admin, {
        max_discount_percent: 5, customer_return_window_days: 15, supplier_return_window_min_days: 15,
        supplier_return_window_max_days: 20, return_freight_payer: 'CUSTOMER', quote_followup_days: 5,
        customer_return_authority_role: 'SALES', supplier_refund_authority_role: 'FINANCE', kpi_signoff_authority_role: 'MANAGEMENT',
      }));
      expect(r.policy).toMatchObject({
        max_discount_percent: '5.00', customer_return_window_days: 15, supplier_return_window_min_days: 15,
        supplier_return_window_max_days: 20, return_freight_payer: 'CUSTOMER', quote_followup_days: 5,
        rma_turnaround_target_working_days: null, customer_return_authority_role: 'SALES',
        supplier_refund_authority_role: 'FINANCE', kpi_signoff_authority_role: 'MANAGEMENT', updated_by_id: f.admin,
      });
      expect(r.effective_max_discount_percent).toBe('5');

      const p = ok(await api('put', '/company-config', f.admin, { quote_followup_days: 7, return_freight_payer: null }));
      expect(p.policy).toMatchObject({ quote_followup_days: 7, return_freight_payer: null, max_discount_percent: '5.00',
        customer_return_window_days: 15 });

      const audit = await c.query(
        `SELECT count(*)::int AS n FROM activity_audit_log WHERE entity_table='company_policy_config' AND actor_id=$1
            AND action='COMPANY_POLICY_CONFIGURED'`, [f.admin]);
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);
    });

    it('validation: bad role / payer / negative days are 400; supplier window min > max is refused by the DB', async () => {
      fails(await api('put', '/company-config', f.admin, { kpi_signoff_authority_role: 'MD' }), 400);
      fails(await api('put', '/company-config', f.admin, { return_freight_payer: 'SUPPLIER' }), 400);
      fails(await api('put', '/company-config', f.admin, { customer_return_window_days: 0 }), 400);
      fails(await api('put', '/company-config', f.admin, { max_discount_percent: 101 }), 400);
      fails(await api('put', '/company-config', f.admin, { supplier_return_window_min_days: 30 }), 400);
      fails(await api('put', '/company-config', f.admin, { unknown_field: 1 }), 400);
    });
  });

  describe('DB rules changed by 026', () => {
    it('GST: only the PRODUCT_SALE rate row may leave HSN empty (HSN per item)', async () => {
      expect(await dbRejects(c, `INSERT INTO br08_gst_rate_config(quote_line_type,hsn_sac,cgst_rate,sgst_rate,igst_rate,is_active)
        VALUES ('OTHER',NULL,9,9,18,false)`)).toMatch(/br08_gst_rate_config_hsn_required/);
      expect(await dbRejects(c, `INSERT INTO br08_gst_rate_config(quote_line_type,hsn_sac,cgst_rate,sgst_rate,igst_rate,is_active)
        VALUES ('PRODUCT_SALE',NULL,9,9,18,false)`)).toBe('');
    });

    it('BR-09: REPLACEMENT_APPROVAL is a valid authority kind; other kinds still refused', async () => {
      expect(await dbRejects(c, `INSERT INTO br09_authority_config(company_id,decision_kind,approver_role_code)
        VALUES ($1,'REPLACEMENT_APPROVAL','SALES') ON CONFLICT (company_id,decision_kind) DO UPDATE SET approver_role_code='SALES'`,
        [f.companyId])).toBe('');
      expect(await dbRejects(c, `INSERT INTO br09_authority_config(company_id,decision_kind,approver_role_code)
        VALUES ($1,'ADVANCE_REPLACEMENT','SALES')`, [f.companyId])).toMatch(/decision_kind_check/);
      const cfg = ok(await api('get', '/support-config', f.sales));
      expect(cfg.authorities.map((a: any) => a.decision_kind)).toContain('REPLACEMENT_APPROVAL');
    });

    it('BR-11: advance_policy accepts NONE / PER_ORDER only', async () => {
      const up = (v: string) => dbRejects(c, `INSERT INTO br11_company_policies(company_id,updated_by_id,advance_policy)
        VALUES ($1,$2,$3) ON CONFLICT (company_id) DO UPDATE SET advance_policy=EXCLUDED.advance_policy`, [f.companyId, f.admin, v]);
      expect(await up('SOMETIMES')).toMatch(/advance_policy_check/);
      expect(await up('NONE')).toBe('');
      expect(await up('PER_ORDER')).toBe('');
    });

    it('BR-08: one invoice per dispatch -- jobs from two dispatch batches are refused, one batch passes', async () => {
      const two = (await c.query(
        `SELECT DISTINCT ON (batch_id) job_id, batch_id FROM br08_dispatch_batch_jobs bj
           JOIN br08_dispatch_batches b ON b.id=bj.batch_id WHERE b.company_id=$1 ORDER BY batch_id LIMIT 2`, [f.companyId])).rows;
      expect(two.length).toBe(2); // the flow suite dispatches at least one batch per run
      expect(await dbRejects(c, `SELECT br08_assert_single_dispatch($1::uuid[])`, [two.map((r) => r.job_id)]))
        .toMatch(/one invoice per dispatch/);
      expect(await dbRejects(c, `SELECT br08_assert_single_dispatch($1::uuid[])`, [[two[0].job_id]])).toBe('');
      fails(await api('post', '/invoices/preview', f.finance, { job_ids: two.map((r) => r.job_id) }), 400, /one invoice per dispatch/);
    });
  });
});
