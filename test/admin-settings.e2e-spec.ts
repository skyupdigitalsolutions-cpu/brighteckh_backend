import { Client } from 'pg';
import { api, db, Fixtures, fails, ok, otherCompany, setupFixtures } from './helpers';

/**
 * SYSTEM_ADMIN Settings panel (migration 027, Figma AST-D): /admin/settings/*.
 * Writes go to the test company ZZB (cross-company administration) and to the GLOBAL GST / test-SLA tables;
 * every row touched is saved first and restored afterwards.
 */
describe('Admin settings (027)', () => {
  let c: Client;
  let f: Fixtures;
  let zzb: string;
  let savedEntity: any;
  let savedPolicy: any[] = [];
  let savedSales: any[] = [];
  let savedBr09: any[] = [];
  let savedBr10: any[] = [];
  let savedSla: any;
  let savedFreight: any[] = [];
  let createdCalendar: string | null = null;

  const restoreRows = async (table: string, rows: any[]) => {
    await c.query(`DELETE FROM ${table} WHERE company_id=$1`, [zzb]);
    for (const r of rows) {
      const cols = Object.keys(r);
      await c.query(`INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        cols.map((k) => r[k]));
    }
  };

  beforeAll(async () => {
    c = await db();
    f = await setupFixtures(c);
    zzb = await otherCompany(c);
    savedEntity = (await c.query(`SELECT legal_name, udyam_number, registered_address FROM legal_entities WHERE id=$1`, [zzb])).rows[0];
    savedPolicy = (await c.query(`SELECT * FROM company_policy_config WHERE company_id=$1`, [zzb])).rows;
    savedSales = (await c.query(`SELECT * FROM br11_company_policies WHERE company_id=$1`, [zzb])).rows;
    savedBr09 = (await c.query(`SELECT * FROM br09_authority_config WHERE company_id=$1`, [zzb])).rows;
    savedBr10 = (await c.query(`SELECT * FROM br10_authority_config WHERE company_id=$1`, [zzb])).rows;
    savedSla = (await c.query(`SELECT * FROM br07_test_sla_targets WHERE priority='URGENT'`)).rows[0];
    savedFreight = (await c.query(`SELECT id, is_active FROM br08_gst_rate_config WHERE quote_line_type='FREIGHT'`)).rows;
    const cal = (await c.query(`SELECT id FROM working_calendars WHERE company_id=$1 AND is_active`, [zzb])).rows[0];
    if (!cal) {
      await c.query(`SELECT cal_seed_client_calendar($1)`, [zzb]);
      createdCalendar = (await c.query(`SELECT id FROM working_calendars WHERE company_id=$1 AND is_active`, [zzb])).rows[0].id;
    }
  });

  afterAll(async () => {
    await c.query(`UPDATE legal_entities SET legal_name=$2, udyam_number=$3, registered_address=$4 WHERE id=$1`,
      [zzb, savedEntity.legal_name, savedEntity.udyam_number, savedEntity.registered_address]);
    await restoreRows('company_policy_config', savedPolicy);
    await restoreRows('br11_company_policies', savedSales);
    await restoreRows('br09_authority_config', savedBr09);
    await restoreRows('br10_authority_config', savedBr10);
    await c.query(`UPDATE br07_test_sla_targets SET target_amount=$1, target_unit=$2 WHERE priority='URGENT'`,
      [savedSla.target_amount, savedSla.target_unit]);
    // GST: drop the FREIGHT rows this suite created, restore any earlier FREIGHT rows' active flag
    const keep = savedFreight.map((r) => r.id);
    await c.query(`DELETE FROM br08_gst_rate_config WHERE quote_line_type='FREIGHT' AND NOT (id = ANY($1::uuid[]))`, [keep]);
    for (const r of savedFreight) await c.query(`UPDATE br08_gst_rate_config SET is_active=$2 WHERE id=$1`, [r.id, r.is_active]);
    if (createdCalendar) {
      await c.query(`DELETE FROM calendar_holidays WHERE calendar_id=$1`, [createdCalendar]);
      await c.query(`DELETE FROM working_calendar_day_rules WHERE calendar_id=$1`, [createdCalendar]);
      await c.query(`DELETE FROM working_calendars WHERE id=$1`, [createdCalendar]);
    }
    await c.end();
  });

  it('SYSTEM_ADMIN only', async () => {
    for (const who of [f.purchase, f.finance, f.mgmt, f.sales]) {
      fails(await api('get', '/admin/settings/companies', who), 403);
      fails(await api('get', `/admin/settings/companies/${zzb}`, who), 403);
      fails(await api('put', `/admin/settings/companies/${zzb}/profile`, who, { legal_name: 'x' }), 403);
      fails(await api('put', '/admin/settings/test-sla-targets', who, { priority: 'URGENT', target_amount: 3, target_unit: 'WORKING_HOUR' }), 403);
    }
  });

  it('lists companies; reads another company with every section', async () => {
    const list = ok<any[]>(await api('get', '/admin/settings/companies', f.admin));
    expect(list.map((x) => x.entity_code)).toEqual(expect.arrayContaining(['BLR', 'ZZB']));
    const s = ok(await api('get', `/admin/settings/companies/${zzb}`, f.admin));
    expect(s.company).toMatchObject({ id: zzb, entity_code: 'ZZB' });
    expect(s.profile.id).toBe(zzb);
    expect(s.profile).toHaveProperty('udyam_number');
    expect(s.support_config.authorities).toHaveLength(4);
    expect(s.mis_authorities).toHaveLength(2);
    expect(s.calendar.company_id).toBe(zzb);
    expect(s.test_sla_targets.map((t: any) => t.priority)).toEqual(['NORMAL', 'URGENT', 'CRITICAL']);
    expect(Object.keys(s.last_saved).sort()).toEqual(['AUTHORISERS', 'CALENDAR', 'COMPANY_TAX', 'POLICIES']);
    fails(await api('get', '/admin/settings/companies/00000000-0000-0000-0000-000000000000', f.admin), 404);
  });

  it('profile: legal name + Udyam on another company; invalid Udyam rejected; audited against that company', async () => {
    fails(await api('put', `/admin/settings/companies/${zzb}/profile`, f.admin, { udyam_number: 'UDYAM-12' }), 400);
    const s = ok(await api('put', `/admin/settings/companies/${zzb}/profile`, f.admin, {
      legal_name: 'ZZB Test Pvt Ltd', udyam_number: 'UDYAM-KR-03-0012345', registered_address: '1 Test Road',
    }));
    expect(s.profile).toMatchObject({ legal_name: 'ZZB Test Pvt Ltd', udyam_number: 'UDYAM-KR-03-0012345', registered_address: '1 Test Road' });
    expect(s.last_saved.COMPANY_TAX).toMatchObject({ by_id: f.admin });
    const audit = (await c.query(
      `SELECT company_id, actor_id FROM activity_audit_log WHERE action='BR08_ENTITY_PROFILE_UPDATED' AND entity_id=$1
        ORDER BY id DESC LIMIT 1`, [zzb])).rows[0];
    expect(audit).toEqual({ company_id: zzb, actor_id: f.admin });
    // the admin's own company is untouched
    const own = (await c.query(`SELECT udyam_number FROM legal_entities WHERE id=$1`, [f.companyId])).rows[0];
    expect(own.udyam_number).not.toBe('UDYAM-KR-03-0012345');
  });

  it('authorisers: BR-09, BR-10 and the four company roles incl. supplier return (027)', async () => {
    fails(await api('put', `/admin/settings/companies/${zzb}/authorisers`, f.admin, {
      support: [{ decision_kind: 'CLAIM_DECISION', approver_role_code: 'MANAGEMENT' }, { decision_kind: 'CLAIM_DECISION', approver_role_code: 'FINANCE' }],
    }), 400);
    fails(await api('put', `/admin/settings/companies/${zzb}/authorisers`, f.admin, { roles: { supplier_return_authority_role: 'NOBODY' } }), 400);
    const s = ok(await api('put', `/admin/settings/companies/${zzb}/authorisers`, f.admin, {
      support: [{ decision_kind: 'CLAIM_DECISION', approver_role_code: 'MANAGEMENT' }],
      mis: [{ authority_kind: 'FINANCIAL_GRANT', approver_role_code: 'FINANCE' }],
      roles: { supplier_return_authority_role: 'PURCHASE', kpi_signoff_authority_role: 'MANAGEMENT' },
    }));
    expect(s.support_config.authorities.find((x: any) => x.decision_kind === 'CLAIM_DECISION').approver_role_code).toBe('MANAGEMENT');
    expect(s.mis_authorities.find((x: any) => x.authority_kind === 'FINANCIAL_GRANT').approver_role_code).toBe('FINANCE');
    expect(s.company_config.policy).toMatchObject({ supplier_return_authority_role: 'PURCHASE', kpi_signoff_authority_role: 'MANAGEMENT' });
    expect(s.company_config.stored_only).toContain('supplier_return_authority_role');
    expect(s.last_saved.AUTHORISERS).toMatchObject({ by_id: f.admin });
  });

  it('policies: company policy + BR-11 sales policy on another company (027 FK relaxed)', async () => {
    fails(await api('put', `/admin/settings/companies/${zzb}/policies`, f.admin, {}), 400);
    fails(await api('put', `/admin/settings/companies/${zzb}/policies`, f.admin, { sales: { invoice_trigger: 'SOMETIME' } }), 400);
    const s = ok(await api('put', `/admin/settings/companies/${zzb}/policies`, f.admin, {
      company: { max_discount_percent: 7, return_freight_payer: 'COMPANY' },
      sales: { invoice_trigger: 'DISPATCH', requires_full_payment_for_closure: true, advance_policy: 'NONE' },
    }));
    expect(s.company_config.policy).toMatchObject({ max_discount_percent: '7.00', return_freight_payer: 'COMPANY' });
    expect(s.sales_config.policy).toMatchObject({ invoice_trigger: 'DISPATCH', requires_full_payment_for_closure: true, advance_policy: 'NONE', updated_by_id: f.admin });
    expect(s.last_saved.POLICIES).toMatchObject({ by_id: f.admin });
  });

  it('working hours: replace day rules, keep the summary envelope in step; bad input rejected', async () => {
    const url = `/admin/settings/companies/${zzb}/working-hours`;
    fails(await api('put', url, f.admin, { days: [{ iso_dow: 1, start_local: '09:30', end_local: '18:30' }, { iso_dow: 1, start_local: '09:30', end_local: '18:30' }] }), 400);
    fails(await api('put', url, f.admin, { days: [{ iso_dow: 1, start_local: '09:30', end_local: '18:30', break_start_local: '13:30' }] }), 400);
    fails(await api('put', url, f.admin, { days: [{ iso_dow: 1, start_local: '18:30', end_local: '09:30' }] }), 400);
    const days = [1, 2, 3, 4, 5].map((d) => ({ iso_dow: d, start_local: '09:00', end_local: '18:00', break_start_local: '13:00', break_end_local: '13:45' }));
    days.push({ iso_dow: 6, start_local: '10:00', end_local: '14:00', break_start_local: null as any, break_end_local: null as any });
    const s = ok(await api('put', url, f.admin, { days }));
    expect(s.calendar.day_rules.map((r: any) => r.iso_dow)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.calendar.day_rules[5]).toMatchObject({ start_local: '10:00:00', end_local: '14:00:00', break_start_local: null });
    expect(s.calendar).toMatchObject({ working_dow: [1, 2, 3, 4, 5, 6], start_local: '09:00:00', end_local: '18:00:00' });
    expect(s.last_saved.CALENDAR).toMatchObject({ by_id: f.admin });
  });

  it('holidays: add and remove a future holiday on another company', async () => {
    const base = `/admin/settings/companies/${zzb}/holidays`;
    const s = ok(await api('post', base, f.admin, { holiday_date: '2099-12-25', description: 'IT holiday' }));
    const h = s.calendar.holidays.find((x: any) => String(x.holiday_date).startsWith('2099-12-25') || x.description === 'IT holiday');
    expect(h).toBeTruthy();
    fails(await api('post', base, f.admin, { holiday_date: '2099-12-25', description: 'dup' }), 400);
    const r = ok(await api('post', `${base}/${h.id}/remove`, f.admin));
    expect(r.calendar.holidays.find((x: any) => x.id === h.id)).toBeUndefined();
  });

  it('numbering: real formats, latest + next', async () => {
    const n = ok(await api('get', `/admin/settings/companies/${f.companyId}/numbering`, f.admin));
    expect(n.fiscal_year).toMatch(/^\d{4}-\d{2}$/);
    const kinds = n.series.map((x: any) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(['INV', 'DC', 'CN', 'JIN', 'JOB', 'QT', 'PO', 'GRN', 'SO', 'RFQ']));
    const job = n.series.find((x: any) => x.kind === 'JOB');
    expect(job.next_number).toMatch(/^JOB-BLR-\d{6}$/);
    const inv = n.series.find((x: any) => x.kind === 'INV');
    expect(inv.scope).toBe('FISCAL_YEAR');
    if (n.doc_prefix) expect(inv.next_number).toBe(`${n.doc_prefix}/${inv.latest_number ? Number(inv.latest_number.split('/')[1]) + 1 : 1}/${n.fiscal_year.slice(2, 4)}-${n.fiscal_year.slice(5, 7)}`);
  });

  it('global GST rate: replaces the active row, CGST = SGST = IGST/2, odd split rejected', async () => {
    fails(await api('put', '/admin/settings/gst-rates', f.admin, { quote_line_type: 'FREIGHT', hsn_sac: '996511', igst_rate: 0.01 }), 400);
    fails(await api('put', '/admin/settings/gst-rates', f.admin, { quote_line_type: 'FREIGHT', igst_rate: 18 }), 400); // no HSN/SAC: DB rule
    let rows = ok<any[]>(await api('put', '/admin/settings/gst-rates', f.admin, { quote_line_type: 'FREIGHT', hsn_sac: '996511', igst_rate: 12 }));
    expect(rows.find((r) => r.quote_line_type === 'FREIGHT')).toMatchObject({ hsn_sac: '996511', cgst_rate: '6.00', sgst_rate: '6.00', igst_rate: '12.00' });
    rows = ok<any[]>(await api('put', '/admin/settings/gst-rates', f.admin, { quote_line_type: 'FREIGHT', igst_rate: 18 }));
    expect(rows.filter((r) => r.quote_line_type === 'FREIGHT')).toHaveLength(1);
    expect(rows.find((r) => r.quote_line_type === 'FREIGHT')).toMatchObject({ hsn_sac: '996511', igst_rate: '18.00' });
  });

  it('global test-start SLA per priority', async () => {
    fails(await api('put', '/admin/settings/test-sla-targets', f.admin, { priority: 'URGENT', target_amount: 0, target_unit: 'WORKING_HOUR' }), 400);
    const rows = ok<any[]>(await api('put', '/admin/settings/test-sla-targets', f.admin, { priority: 'URGENT', target_amount: 6, target_unit: 'WORKING_HOUR' }));
    expect(rows.find((r) => r.priority === 'URGENT')).toMatchObject({ target_amount: 6, target_unit: 'WORKING_HOUR', event_code: 'BR07_TEST_START' });
  });
});
