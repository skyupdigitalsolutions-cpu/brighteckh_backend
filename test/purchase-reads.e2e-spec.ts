import { Client } from 'pg';
import request from 'supertest';
import {
  api, BASE, bridge, createItem, db, employeeIn, Fixtures, fails, ok, otherCompany, RUN, setupFixtures,
} from './helpers';

/**
 * Purchase desk read pass (CLAUDE.md §4i "Purchase desk reads"):
 *   G14 GET /inward-receipts        G20 GET /rfqs (+ C2-2 links on GET /rfqs/:id)    B-1 PATCH /equipment-units/:id
 *   G15 GET /jobs                   G21 GET /quotes                                  B-2 job_id/job_number on GET /inward-receipts/:id
 *   G16-G19 + C2-1 GET /lookups/*   G22 GET /overview/purchase                       B-3 GET /equipment-units/:id/photos
 *   C1-1 GET /jobs/:id/progress     DTO renames visible in /api/docs-json
 * One JIN (3 units) is driven through BR-02 -> BR-03 -> BR-04 (quote SENT) via the live API.
 */
describe('Purchase desk reads (G14-G22, B-1..B-3, C1-1, C2-1/2)', () => {
  let c: Client;
  let f: Fixtures;
  let otherEngineer: string;   // same company, never assigned job1
  let foreignPurchase: string; // company B
  let foreignSales: string;    // company B
  const s: Record<string, any> = {};
  const P = () => f.purchase;
  const E = () => f.engineer;
  const SUPPLIER_PRICE = 987.65;
  const page = (path: string, actor: string) => api('get', path, actor).then((r) => ok<{ rows: any[]; total: number; page: number; page_size: number }>(r));

  beforeAll(async () => {
    c = await db();
    f = await setupFixtures(c);
    otherEngineer = await employeeIn(c, f.companyId, 'ENG', 'ENGINEER', 'PR');
    const coB = await otherCompany(c);
    foreignPurchase = await employeeIn(c, coB, 'PUR', 'PURCHASE', 'PR');
    foreignSales = await employeeIn(c, coB, 'SAL', 'SALES', 'PR');

    s.item = await createItem(P(), true, 'pr-part');
    s.bridge = await bridge(c, s.item, 'APPROVED');

    // BR-02: JIN1 (URGENT, 3 units). u1 -> job1 (assigned, driven to quote SENT); u2 stays PENDING for the PATCH tests.
    s.jin = ok(await api('post', '/inward-receipts', P(), {
      customer_id: f.customerId, receipt_at: new Date().toISOString(), receipt_channel: 'COURIER',
      customer_dc_number: `DC-PR-${RUN}`, priority: 'URGENT', priority_reason: 'purchase-reads suite',
    }));
    const g = ok(await api('post', `/inward-receipts/${s.jin.id}/equipment-groups`, P(), { assembly_id: f.assemblyId, quantity_received: 3 }));
    const ex = ok(await api('post', `/equipment-groups/${g.id}/expand`, P(), { location_id: f.custodyLocationId, custodian_id: f.purchase }));
    [s.u1, s.u2, s.u3] = ex.units.map((u: any) => u.id);
    ok(await api('post', `/equipment-units/${s.u1}/photos`, P(), { file_uri: `s3://it/pr-${s.u1}.jpg`, file_name: 'u1.jpg', photo_category: 'FRONT' }));
    s.job1 = ok(await api('post', `/equipment-units/${s.u1}/verify`, P())).job;
    ok(await api('post', `/jobs/${s.job1.id}/assign`, P(), { engineer_id: E() }));
    // A second, older-looking JIN for the same customer (pagination); NORMAL priority, not expanded.
    s.jin2 = ok(await api('post', '/inward-receipts', P(), {
      customer_id: f.customerId, receipt_at: new Date(Date.now() - 60_000).toISOString(), receipt_channel: 'WALK_IN',
      customer_dc_number: `DC-PR2-${RUN}`,
    }));

    // BR-03: custody -> inspection -> ACCEPT -> MR submitted
    ok(await api('post', `/jobs/${s.job1.id}/custody-ack`, E(), { condition_note: 'ok' }));
    const sess = ok(await api('post', `/jobs/${s.job1.id}/inspection-sessions`, E()));
    ok(await api('post', `/inspection-sessions/${sess.id}/stop`, E()));
    const rep = ok(await api('post', `/jobs/${s.job1.id}/inspection-reports`, E()));
    ok(await api('post', `/inspection-reports/${rep.id}/media`, E(), { media_type: 'PHOTO', file_uri: `s3://it/pr-insp-${RUN}.jpg`, file_name: 'i.jpg' }));
    ok(await api('post', `/inspection-reports/${rep.id}/submit`, E(), { inspection_description: 'cap failed', outcome: 'REPAIR_REQUIRED' }));
    ok(await api('post', `/inspection-reports/${rep.id}/review`, P(), { decision: 'ACCEPT' }));
    s.mr = ok(await api('post', `/jobs/${s.job1.id}/material-requests`, E(), { priority: 'NORMAL' }));
    ok(await api('post', `/material-requests/${s.mr.id}/lines`, E(), { item_bridge_id: s.bridge, quantity: 4 }));
    ok(await api('post', `/material-requests/${s.mr.id}/submit`, E()));

    // BR-04: stock check -> RFQ -> offer -> quote -> release -> SENT
    s.check = ok(await api('post', `/jobs/${s.job1.id}/stock-checks`, P(), { material_request_id: s.mr.id }));
    s.shortage = ok<any[]>(await api('get', `/jobs/${s.job1.id}/shortages`, P()))[0];
    s.rfq = ok(await api('post', `/jobs/${s.job1.id}/rfqs`, P(), {
      lines: [{ shortage_source_id: s.shortage.id, technical_specification: '470uF 450V' }],
    }));
    const inv = ok(await api('post', `/rfqs/${s.rfq.id}/supplier-invites`, P(), { supplier_name_snapshot: `IT PR Supplier ${RUN}` }));
    ok(await api('post', `/rfqs/${s.rfq.id}/offers`, P(), {
      supplier_invite_id: inv.id, lines: [{ rfq_line_id: s.rfq.lines[0].id, offered_quantity: 4, quoted_unit_price: SUPPLIER_PRICE }],
    }));
    const offerLine = ok(await api('get', `/rfqs/${s.rfq.id}`, P())).offers[0].lines[0].id;
    s.quote = ok(await api('post', `/jobs/${s.job1.id}/quotes`, P(), {
      quote_type: 'ITEM', reference_offer_line_id: offerLine, procurement_offer_line_id: offerLine,
      lines: [{ line_type: 'MATERIAL', line_description: 'Capacitor', quantity: 4, uom: 'NOS', net_unit_price_pre_tax: 1500 }],
    }));
    ok(await api('post', `/quotes/${s.quote.id}/release-to-sales`, P(), { assigned_sales_id: f.sales }));
    ok(await api('post', `/quotes/${s.quote.id}/send`, f.sales));
  }, 300_000); // ~30 live API calls (BR-02 -> BR-04) against the remote DB
  afterAll(() => c?.end());

  // ============================================================== G14
  describe('G14 GET /inward-receipts (register)', () => {
    it('lists the JIN with customer name and unit counts, paginated', async () => {
      const res = await page(`/inward-receipts?search=${encodeURIComponent(s.jin.jin_number)}`, P());
      expect(res).toMatchObject({ total: 1, page: 1, page_size: 25 });
      expect(res.rows[0]).toMatchObject({
        id: s.jin.id, jin_number: s.jin.jin_number, customer_id: f.customerId, customer_name: `IT Customer ${RUN}`,
        groups_count: 1, units_received: 3, units_total: 3, units_verified: 1, priority: 'URGENT', receipt_status: 'REGISTERED',
      });
    });

    it('search by customer name / DC number; page_size + page walk newest first', async () => {
      const both = await page(`/inward-receipts?search=${encodeURIComponent(`IT Customer ${RUN}`)}&page_size=1`, P());
      expect(both.total).toBe(2);
      expect(both.rows.map((r) => r.id)).toEqual([s.jin.id]);
      const p2 = await page(`/inward-receipts?search=${encodeURIComponent(`IT Customer ${RUN}`)}&page_size=1&page=2`, P());
      expect(p2.rows.map((r) => r.id)).toEqual([s.jin2.id]);
      expect(p2.rows[0]).toMatchObject({ groups_count: 0, units_total: 0, units_verified: 0 });
      const dc = await page(`/inward-receipts?search=DC-PR2-${RUN}`, P());
      expect(dc.rows.map((r) => r.id)).toEqual([s.jin2.id]);
    });

    it('status / priority (comma-separated) and month filters', async () => {
      const q = `search=${encodeURIComponent(`IT Customer ${RUN}`)}`;
      expect((await page(`/inward-receipts?${q}&priority=URGENT,CRITICAL`, P())).rows.map((r) => r.id)).toEqual([s.jin.id]);
      expect((await page(`/inward-receipts?${q}&status=REGISTERED,VERIFYING`, P())).total).toBe(2);
      expect((await page(`/inward-receipts?${q}&status=CLOSED`, P())).total).toBe(0);
      const m = (await c.query(
        `SELECT to_char(receipt_at AT TIME ZONE COALESCE((SELECT timezone FROM working_calendars WHERE company_id=$1 AND is_active LIMIT 1),'Asia/Kolkata'),'YYYY-MM') m
           FROM inward_receipts WHERE id=$2`, [f.companyId, s.jin.id])).rows[0].m;
      expect((await page(`/inward-receipts?${q}&month=${m}`, P())).total).toBe(2);
      expect((await page(`/inward-receipts?${q}&month=2000-01`, P())).total).toBe(0);
    });

    it('bad params are 400; ENGINEER/SALES 403; MANAGEMENT allowed; no token 401', async () => {
      for (const bad of ['status=NOPE', 'priority=LOW', 'month=2026-13', 'page=0', 'page_size=101', 'page_size=abc', 'sort=asc', 'company=x']) {
        fails(await api('get', `/inward-receipts?${bad}`, P()), 400);
      }
      fails(await api('get', '/inward-receipts', E()), 403);
      fails(await api('get', '/inward-receipts', f.sales), 403);
      expect((await page(`/inward-receipts?search=${s.jin.jin_number}`, f.mgmt)).total).toBe(1);
      fails(await api('get', '/inward-receipts'), 401);
    });

    it('another company never sees it (and cannot pass our company_id)', async () => {
      expect((await page(`/inward-receipts?search=${s.jin.jin_number}`, foreignPurchase)).total).toBe(0);
      fails(await api('get', `/inward-receipts?company_id=${f.companyId}`, foreignPurchase), 403);
    });
  });

  // ============================================================== B-2 / B-3 / B-1
  describe('B-2 receipt detail -> job per unit', () => {
    it('each unit carries job_id/job_number (null before verification)', async () => {
      const d = ok(await api('get', `/inward-receipts/${s.jin.id}`, P()));
      const by = Object.fromEntries(d.equipment_units.map((u: any) => [u.id, u]));
      expect(by[s.u1]).toMatchObject({ job_id: s.job1.id, job_number: s.job1.job_number });
      expect(by[s.u2]).toMatchObject({ job_id: null, job_number: null });
      expect(d.equipment_units.map((u: any) => u.unit_number)).toEqual([1, 2, 3]);
    });
  });

  describe('B-3 GET /equipment-units/:id/photos', () => {
    it('lists the unit photos for any role in the company; other company 403; unknown 404; bad id 400', async () => {
      for (const actor of [P(), E(), f.sales]) {
        const rows = ok<any[]>(await api('get', `/equipment-units/${s.u1}/photos`, actor));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ unit_id: s.u1, file_name: 'u1.jpg', photo_category: 'FRONT' });
      }
      expect(ok<any[]>(await api('get', `/equipment-units/${s.u3}/photos`, P()))).toEqual([]);
      fails(await api('get', `/equipment-units/${s.u1}/photos`, foreignPurchase), 403);
      fails(await api('get', `/equipment-units/00000000-0000-4000-8000-000000000000/photos`, P()), 404);
      fails(await api('get', `/equipment-units/not-a-uuid/photos`, P()), 400);
    });
  });

  describe('B-1 PATCH /equipment-units/:id', () => {
    it('before verification: PURCHASE edits only the sent fields and an audit row records before/after', async () => {
      const u = ok(await api('patch', `/equipment-units/${s.u2}`, P(), {
        serial_number: `SN-PR-${RUN}`, observed_make: 'ABB', observed_model: 'ACS880', accessories: '  2 cables  ',
      }));
      expect(u).toMatchObject({ id: s.u2, serial_number: `SN-PR-${RUN}`, observed_make: 'ABB', observed_model: 'ACS880',
        accessories: '2 cables', reported_fault: null, verification_status: 'PENDING' });
      const a = (await c.query(
        `SELECT actor_id, before_state, after_state FROM activity_audit_log
          WHERE entity_table='inward_equipment_units' AND entity_id=$1 AND action='BR02_UNIT_DETAILS_UPDATED'`, [s.u2])).rows;
      expect(a).toHaveLength(1);
      expect(a[0].actor_id).toBe(f.purchase);
      expect(a[0].before_state).toEqual({ serial_number: null, observed_make: null, observed_model: null, accessories: null });
      expect(a[0].after_state).toEqual({ serial_number: `SN-PR-${RUN}`, observed_make: 'ABB', observed_model: 'ACS880', accessories: '2 cables' });

      const cleared = ok(await api('patch', `/equipment-units/${s.u2}`, P(), { observed_make: null, observed_model: '' }));
      expect(cleared).toMatchObject({ observed_make: null, observed_model: null, serial_number: `SN-PR-${RUN}` });
    });

    it('validation: empty body, unknown field, over-long value -> 400', async () => {
      fails(await api('patch', `/equipment-units/${s.u2}`, P(), {}), 400, /at least one/);
      fails(await api('patch', `/equipment-units/${s.u2}`, P(), { verification_status: 'VERIFIED' }), 400);
      fails(await api('patch', `/equipment-units/${s.u2}`, P(), { serial_number: 'x'.repeat(151) }), 400);
    });

    it('ENGINEER/SALES 403; another company 403', async () => {
      fails(await api('patch', `/equipment-units/${s.u2}`, E(), { serial_number: 'x' }), 403);
      fails(await api('patch', `/equipment-units/${s.u2}`, f.sales, { serial_number: 'x' }), 403);
      fails(await api('patch', `/equipment-units/${s.u2}`, foreignPurchase, { serial_number: 'x' }), 403);
    });

    it('after verification the unit is frozen (400), and nothing changed', async () => {
      ok(await api('post', `/equipment-units/${s.u2}/photos`, P(), { file_uri: `s3://it/pr-${s.u2}.jpg`, file_name: 'u2.jpg' }));
      s.job2 = ok(await api('post', `/equipment-units/${s.u2}/verify`, P())).job;
      fails(await api('patch', `/equipment-units/${s.u2}`, P(), { serial_number: 'CHANGED' }), 400, /before verification/);
      const row = (await c.query(`SELECT serial_number FROM inward_equipment_units WHERE id=$1`, [s.u2])).rows[0];
      expect(row.serial_number).toBe(`SN-PR-${RUN}`);
    });
  });

  // ============================================================== G15
  describe('G15 GET /jobs', () => {
    it('row carries JIN, unit, equipment, customer, current engineer name and last activity', async () => {
      const res = await page(`/jobs?search=${s.job1.job_number}`, P());
      expect(res.total).toBe(1);
      const r = res.rows[0];
      expect(r).toMatchObject({
        id: s.job1.id, job_number: s.job1.job_number, jin_number: s.jin.jin_number, unit_number: 1, units_in_group: 3,
        assembly_id: f.assemblyId, assembly_name: `IT Drive ${RUN}`, customer_id: f.customerId, customer_name: `IT Customer ${RUN}`,
        current_engineer_id: f.engineer, current_engineer_name: `IT ENG ${RUN}`, assignment_response: 'ACCEPTED',
      });
      expect(r).not.toHaveProperty('__responded_at');
      expect(new Date(r.last_activity_at).getTime()).toBeGreaterThan(new Date(r.created_at).getTime());
    });

    it('engineer filter (uuid | unassigned), status/priority filters, search by serial and customer', async () => {
      const cust = `search=${encodeURIComponent(`IT Customer ${RUN}`)}`;
      expect((await page(`/jobs?${cust}`, P())).rows.map((r) => r.id)).toEqual([s.job2.id, s.job1.id]);
      expect((await page(`/jobs?${cust}&engineer_id=${f.engineer}`, P())).rows.map((r) => r.id)).toEqual([s.job1.id]);
      expect((await page(`/jobs?${cust}&engineer_id=unassigned`, P())).rows.map((r) => r.id)).toEqual([s.job2.id]);
      expect((await page(`/jobs?${cust}&engineer_id=${otherEngineer}`, P())).total).toBe(0);
      const st = (await c.query(`SELECT status FROM service_jobs WHERE id=$1`, [s.job1.id])).rows[0].status;
      expect((await page(`/jobs?${cust}&status=${st},ON_HOLD`, P())).rows.map((r) => r.id)).toContain(s.job1.id);
      expect((await page(`/jobs?${cust}&status=CLOSED,CANCELLED`, P())).total).toBe(0);
      expect((await page(`/jobs?${cust}&priority=NORMAL`, P())).total).toBe(2);
      expect((await page(`/jobs?search=SN-PR-${RUN}`, P())).rows.map((r) => r.id)).toEqual([s.job2.id]);
      expect((await page(`/jobs?search=${encodeURIComponent(`IT Drive ${RUN}`)}`, P())).total).toBe(2);
    });

    it('bad params 400; ENGINEER/SALES 403; MANAGEMENT ok; other company excluded', async () => {
      for (const bad of ['engineer_id=bob', 'status=DONE', 'priority=HIGH', 'page_size=0', 'search=' + 'x'.repeat(101)]) {
        fails(await api('get', `/jobs?${bad}`, P()), 400);
      }
      fails(await api('get', '/jobs', E()), 403);
      fails(await api('get', '/jobs', f.sales), 403);
      expect((await page(`/jobs?search=${s.job1.job_number}`, f.mgmt)).total).toBe(1);
      expect((await page(`/jobs?search=${s.job1.job_number}`, foreignPurchase)).total).toBe(0);
    });
  });

  // ============================================================== G20 + C2-1/C2-2
  describe('G20 GET /rfqs + C2-2 links on GET /rfqs/:id', () => {
    it('lists the RFQ with its job and counts; no supplier prices', async () => {
      const res = await page(`/rfqs?job_id=${s.job1.id}`, P());
      expect(res.total).toBe(1);
      expect(res.rows[0]).toMatchObject({
        id: s.rfq.id, rfq_number: s.rfq.rfq_number, job_id: s.job1.id, job_number: s.job1.job_number,
        customer_name: `IT Customer ${RUN}`, lines_count: 1, invites_count: 1, offers_count: 1,
      });
      const body = JSON.stringify(res);
      expect(body).not.toContain(String(SUPPLIER_PRICE));
      expect(body).not.toMatch(/quoted_unit_price|landed_cost/);
    });

    it('search by RFQ number / job number / supplier; status filter; bad params 400', async () => {
      expect((await page(`/rfqs?search=${s.rfq.rfq_number}`, P())).rows.map((r) => r.id)).toEqual([s.rfq.id]);
      expect((await page(`/rfqs?search=${s.job1.job_number}`, P())).rows.map((r) => r.id)).toEqual([s.rfq.id]);
      expect((await page(`/rfqs?search=${encodeURIComponent(`IT PR Supplier ${RUN}`)}`, P())).rows.map((r) => r.id)).toEqual([s.rfq.id]);
      expect((await page(`/rfqs?job_id=${s.job1.id}&status=CANCELLED,EXPIRED`, P())).total).toBe(0);
      fails(await api('get', '/rfqs?job_id=nope', P()), 400);
      fails(await api('get', '/rfqs?status=OPEN', P()), 400);
    });

    it('PURCHASE only (like GET /rfqs/:id); other company excluded', async () => {
      for (const actor of [E(), f.sales, f.mgmt, f.finance]) fails(await api('get', '/rfqs', actor), 403);
      expect((await page(`/rfqs?search=${s.rfq.rfq_number}`, foreignPurchase)).total).toBe(0);
    });

    it('GET /rfqs/:id now links back to job / shortage / stock check / MR, and lines carry the item code/name', async () => {
      const d = ok(await api('get', `/rfqs/${s.rfq.id}`, P()));
      expect(d).toMatchObject({ job_id: s.job1.id, job_number: s.job1.job_number });
      expect(d.sources).toHaveLength(1);
      expect(d.sources[0]).toMatchObject({
        rfq_line_id: s.rfq.lines[0].id, line_no: 1, shortage_source_id: s.shortage.id, job_id: s.job1.id,
        stock_check_id: s.check.id, material_request_id: s.mr.id, material_request_number: s.mr.request_number,
      });
      const item = (await c.query(`SELECT item_code, standard_name FROM fdn_item_master WHERE id=$1`, [s.item])).rows[0];
      expect(d.lines[0]).toMatchObject({ item_bridge_id: s.bridge, item_code: item.item_code, item_name: item.standard_name });
      // existing fields unchanged
      expect(d.invites).toHaveLength(1);
      expect(d.offers).toHaveLength(1);
    });
  });

  // ============================================================== G21
  describe('G21 GET /quotes', () => {
    it('lists the quote with job, customer and latest revision; no supplier references or costs', async () => {
      for (const actor of [P(), f.mgmt]) {
        const res = await page(`/quotes?job_id=${s.job1.id}`, actor);
        expect(res.total).toBe(1);
        expect(res.rows[0]).toMatchObject({
          id: s.quote.id, quote_number: s.quote.quote_number, job_id: s.job1.id, job_number: s.job1.job_number,
          customer_id: f.customerId, customer_name: `IT Customer ${RUN}`, revisions_count: 1,
          latest_revision_no: s.quote.revision.revision_no, latest_quote_status: 'SENT',
        });
        expect(Number(res.rows[0].latest_revised_pre_tax)).toBe(6000);
        const body = JSON.stringify(res);
        expect(body).not.toContain(String(SUPPLIER_PRICE));
        expect(body).not.toMatch(/reference_offer_line_id|procurement_offer_line_id|quoted_unit_price|supplier/);
      }
    });

    it('status filter matches the latest revision; search by quote/job number; bad params 400', async () => {
      expect((await page(`/quotes?job_id=${s.job1.id}&status=SENT,ACCEPTED`, P())).total).toBe(1);
      expect((await page(`/quotes?job_id=${s.job1.id}&status=DRAFT`, P())).total).toBe(0);
      expect((await page(`/quotes?search=${s.quote.quote_number}`, P())).rows.map((r) => r.id)).toEqual([s.quote.id]);
      expect((await page(`/quotes?search=${s.job1.job_number}`, P())).rows.map((r) => r.id)).toEqual([s.quote.id]);
      fails(await api('get', '/quotes?status=WON', P()), 400);
      fails(await api('get', '/quotes?page=-1', P()), 400);
    });

    it('ENGINEER/SALES/FINANCE 403; other company excluded', async () => {
      for (const actor of [E(), f.sales, f.finance]) fails(await api('get', '/quotes', actor), 403);
      expect((await page(`/quotes?search=${s.quote.quote_number}`, foreignPurchase)).total).toBe(0);
    });
  });

  // ============================================================== G16-G19, C2-1 lookups
  describe('lookups', () => {
    it('customers: name/code for PURCHASE and SALES, own company only, no contact/GST fields', async () => {
      for (const actor of [P(), f.sales]) {
        const res = await page(`/lookups/customers?search=${RUN}`, actor);
        expect(res.rows).toContainEqual({ id: f.customerId, customer_code: `IT-CUST-${RUN}`, customer_name: `IT Customer ${RUN}`, status: 'APPROVED' });
        expect(JSON.stringify(res)).not.toMatch(/gstin|primary_email|mobile|billing_address/);
      }
      expect((await page(`/lookups/customers?ids=${f.customerId}`, P())).rows.map((r) => r.id)).toEqual([f.customerId]);
      expect((await page(`/lookups/customers?ids=${f.customerId}&status=INACTIVE`, P())).total).toBe(0);
      expect((await page(`/lookups/customers?ids=${f.customerId}`, foreignSales)).total).toBe(0);
      fails(await api('get', '/lookups/customers', E()), 403);
      fails(await api('get', '/lookups/customers?ids=abc', P()), 400);
      fails(await api('get', '/lookups/customers?status=GOOD', P()), 400);
    });

    it('engineers: active ENGINEERs with names and open-job counts', async () => {
      const res = await page(`/lookups/engineers?ids=${f.engineer},${otherEngineer},${f.sales}`, P());
      const by = Object.fromEntries(res.rows.map((r) => [r.id, r]));
      expect(res.total).toBe(2); // the SALES id is not an engineer
      expect(by[f.engineer]).toMatchObject({ full_name: `IT ENG ${RUN}`, employee_code: `IT-ENG-${RUN}`, open_jobs: 1, pending_custody: 0 });
      expect(by[otherEngineer]).toMatchObject({ open_jobs: 0, pending_custody: 0 });
      expect((await page(`/lookups/engineers?ids=${f.engineer}`, foreignPurchase)).total).toBe(0);
      for (const actor of [E(), f.sales, f.mgmt]) fails(await api('get', '/lookups/engineers', actor), 403);
    });

    it('employees: role filter for the Sales / custodian / approver pickers', async () => {
      const res = await page(`/lookups/employees?role=SALES&search=${RUN}`, P());
      expect(res.rows.map((r) => r.id)).toEqual([f.sales]);
      expect(res.rows[0]).toEqual({ id: f.sales, employee_code: `IT-SAL-${RUN}`, full_name: `IT SAL ${RUN}`, role_code: 'SALES' });
      expect((await page(`/lookups/employees?role=PURCHASE,ENGINEER&search=${RUN}`, P())).total).toBe(4);
      fails(await api('get', '/lookups/employees?role=BOSS', P()), 400);
      fails(await api('get', '/lookups/employees', f.sales), 403);
    });

    it('assemblies: the `assemblies` master (not fdn_assembly_master), usable statuses by default', async () => {
      const res = await page(`/lookups/assemblies?search=IT-ASM-${RUN}`, P());
      expect(res.rows).toEqual([{ id: f.assemblyId, assembly_code: `IT-ASM-${RUN}`, assembly_name: `IT Drive ${RUN}`, status: 'APPROVED', repairable: true }]);
      expect((await page(`/lookups/assemblies?ids=${f.assemblyId}&status=REJECTED`, P())).total).toBe(0);
      fails(await api('get', '/lookups/assemblies', E()), 403);
    });

    it('custody locations: active, own company, with units held', async () => {
      const res = await page(`/lookups/custody-locations?search=${RUN}`, P());
      expect(res.rows).toEqual([{ id: f.custodyLocationId, location_code: `IT-RACK-${RUN}`, location_name: `IT Rack ${RUN}`, units_here: 3 }]);
      expect((await page(`/lookups/custody-locations?ids=${f.custodyLocationId}`, foreignPurchase)).total).toBe(0);
      fails(await api('get', '/lookups/custody-locations', E()), 403);
    });

    it('item-bridge (C2-1): resolves item_bridge_id to code/name; needs ids or search', async () => {
      const res = await page(`/lookups/item-bridge?ids=${s.bridge}`, P());
      expect(res.rows[0]).toMatchObject({ item_bridge_id: s.bridge, br01_item_id: s.item, uom: 'NOS', approval_status: 'APPROVED', is_active: true });
      expect(res.rows[0].item_name).toBe(`IT pr-part ${RUN}`);
      fails(await api('get', '/lookups/item-bridge', P()), 400, /ids or search/);
      fails(await api('get', '/lookups/item-bridge?ids=1', P()), 400);
      fails(await api('get', `/lookups/item-bridge?ids=${s.bridge}`, E()), 403);
    });
  });

  // ============================================================== C1-1
  describe('C1-1 GET /jobs/:id/progress', () => {
    it('job1: BR-02..BR-04 done, authorisation is current; each stage has source + rule', async () => {
      const p = ok(await api('get', `/jobs/${s.job1.id}/progress`, P()));
      expect(p).toMatchObject({ job_id: s.job1.id, job_number: s.job1.job_number, current_stage: 'AUTHORISATION' });
      expect(p.stages.map((x: any) => x.key)).toEqual(
        ['ASSIGNED', 'CUSTODY', 'INSPECTION', 'REPORT_REVIEW', 'MATERIAL', 'QUOTE', 'AUTHORISATION', 'PO_GRN', 'REPAIR_TEST', 'DISPATCH_INVOICE']);
      expect(p.stages.map((x: any) => x.status)).toEqual(
        ['done', 'done', 'done', 'done', 'done', 'done', 'current', 'pending', 'pending', 'pending']);
      for (const st of p.stages) {
        expect(st.source).toBeTruthy();
        expect(st.rule).toBeTruthy();
        if (st.status === 'done') expect(st.at).toBeTruthy();
      }
      expect(p.stages[3].detail).toBe('ACCEPTED');
      expect(p.stages[5].detail).toBe(`${s.quote.quote_number} rev ${s.quote.revision.revision_no} SENT`);
      expect(p.stages[7].detail).toBe('no supplier PO for this job');
      expect(p.assignments).toHaveLength(1);
      expect(p.assignments[0]).toMatchObject({ engineer_id: f.engineer, engineer_name: `IT ENG ${RUN}`, assigned_by_name: `IT PUR ${RUN}`, is_current: true });
    });

    it('job2: assignment history with names after a reassignment; custody is current for the new engineer', async () => {
      let p = ok(await api('get', `/jobs/${s.job2.id}/progress`, P()));
      expect(p.current_stage).toBe('ASSIGNED');
      expect(p.assignments).toEqual([]);
      ok(await api('post', `/jobs/${s.job2.id}/assign`, P(), { engineer_id: E() }));
      ok(await api('post', `/jobs/${s.job2.id}/assign`, f.purchase2, { engineer_id: otherEngineer, reassignment_reason: 'load balance' }));
      p = ok(await api('get', `/jobs/${s.job2.id}/progress`, f.mgmt));
      expect(p.current_stage).toBe('CUSTODY');
      expect(p.assignments.map((a: any) => [a.engineer_name, a.assigned_by_name, a.is_current])).toEqual([
        [`IT ENG ${RUN}`, `IT PUR ${RUN}`, false],
        [`IT ENG ${RUN}PR`, `IT PUR2 ${RUN}`, true],
      ]);
      expect(p.assignments[1].reassignment_reason).toBe('load balance');
    });

    it('ENGINEER/SALES 403; other company 403; unknown 404', async () => {
      fails(await api('get', `/jobs/${s.job1.id}/progress`, E()), 403);
      fails(await api('get', `/jobs/${s.job1.id}/progress`, f.sales), 403);
      fails(await api('get', `/jobs/${s.job1.id}/progress`, foreignPurchase), 403);
      fails(await api('get', `/jobs/00000000-0000-4000-8000-000000000000/progress`, P()), 404);
    });
  });

  // ============================================================== G22
  describe('G22 GET /overview/purchase', () => {
    it('counts match the documented definitions (checked against the DB)', async () => {
      const o = ok(await api('get', '/overview/purchase', P()));
      const one = async (sql: string) => (await c.query(sql, [f.companyId])).rows[0].n;
      expect(o.verify_units.awaiting).toBe(await one(
        `SELECT count(*)::int n FROM inward_equipment_units WHERE company_id=$1 AND verification_status='PENDING'`));
      expect(o.assign_engineers.unassigned).toBe(await one(
        `SELECT count(*)::int n FROM service_jobs j WHERE company_id=$1 AND status NOT IN ('CLOSED','CANCELLED')
           AND NOT EXISTS (SELECT 1 FROM job_assignments a WHERE a.job_id=j.id AND a.is_current)`));
      expect(o.review_reports.awaiting_review).toBe(await one(
        `SELECT count(*)::int n FROM br03_inspection_reports WHERE company_id=$1 AND status='SUBMITTED'`));
      expect(o.review_reports.returned).toBe(await one(
        `SELECT count(*)::int n FROM br03_inspection_reports WHERE company_id=$1 AND status='RETURNED'`));
      expect(o.jobs_by_status.map((x: any) => x.status)).toEqual(['JOB_CREATED', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED', 'INSPECTION', 'ON_HOLD']);
      expect(o.jobs_by_status.reduce((a: number, x: any) => a + x.count, 0)).toBe(await one(
        `SELECT count(*)::int n FROM service_jobs WHERE company_id=$1 AND status NOT IN ('CLOSED','CANCELLED')`));
      expect(o.verify_units.verified_today).toBeGreaterThanOrEqual(2);       // u1 + u2 this run
      expect(o.assign_engineers.assigned_today).toBeGreaterThanOrEqual(3);   // job1 + job2 twice
      expect(o.review_reports.reviewed_today).toBeGreaterThanOrEqual(1);
      expect(o.timezone).toBeTruthy();
      expect(o.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.intake_this_week.map((d: any) => d.weekday)).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
      expect(o.engineers_total).toBe(await one(`SELECT count(*)::int n FROM employees WHERE company_id=$1 AND role_code='ENGINEER' AND is_active`));
      expect(o.engineer_workload.length).toBeLessThanOrEqual(50);
      const loads = o.engineer_workload.map((w: any) => w.open_jobs);
      expect([...loads].sort((a, b) => b - a)).toEqual(loads);
    });

    it('latest activity: newest company audit rows with actor names, never before/after state', async () => {
      ok(await api('patch', `/equipment-units/${s.u3}`, P(), { reported_fault: 'no display' }));
      const o = ok(await api('get', '/overview/purchase', f.mgmt));
      expect(o.latest_activity.length).toBeLessThanOrEqual(10);
      expect(o.latest_activity[0]).toMatchObject({
        action: 'BR02_UNIT_DETAILS_UPDATED', entity_table: 'inward_equipment_units', entity_id: s.u3,
        actor_id: f.purchase, actor_name: `IT PUR ${RUN}`,
      });
      expect(JSON.stringify(o.latest_activity)).not.toMatch(/before_state|after_state/);
    });

    it('PURCHASE + MANAGEMENT only; another company sees none of our activity', async () => {
      for (const actor of [E(), f.sales, f.finance, f.admin]) fails(await api('get', '/overview/purchase', actor), 403);
      const o = ok(await api('get', '/overview/purchase', foreignPurchase));
      const ours = new Set([s.u1, s.u2, s.u3, s.job1.id, s.job2.id, s.jin.id]);
      expect(o.latest_activity.some((a: any) => ours.has(a.entity_id))).toBe(false);
    });
  });

  // ============================================================== OpenAPI contract
  describe('OpenAPI contract', () => {
    it('BR-04 quote lines have their own schema (no longer shadowed by the BR-11 QuoteLineDto); other collisions fixed', async () => {
      const doc = (await request(BASE).get('/docs-json')).body;
      const sc = doc.components.schemas;
      expect(Object.keys(sc.RepairQuoteLineDto.properties)).toEqual(expect.arrayContaining(['line_type', 'net_unit_price_pre_tax', 'quantity', 'uom']));
      expect(sc.CreateQuoteDto.properties.lines.items.$ref).toBe('#/components/schemas/RepairQuoteLineDto');
      expect(sc.ReviseQuoteDto.properties.lines.items.$ref).toBe('#/components/schemas/RepairQuoteLineDto');
      expect(Object.keys(sc.QuoteLineDto.properties)).toEqual(expect.arrayContaining(['item_id', 'unit_price_paise']));
      expect(Object.keys(sc.RepairQuoteResponseDto.properties)).toContain('response_type');
      expect(Object.keys(sc.QuoteResponseDto.properties)).toContain('response_kind');
      expect(Object.keys(sc.InventoryReserveDto.properties)).toContain('expires_at');
      expect(Object.keys(sc.ReserveDto.properties)).toContain('qty');
      expect(sc.SupportAuthorityStatus).toBeDefined();
      expect(sc.AuthorityStatus).toBeDefined();
      for (const p of ['/api/inward-receipts', '/api/jobs', '/api/rfqs', '/api/quotes', '/api/overview/purchase', '/api/jobs/{id}/progress',
        '/api/equipment-units/{id}/photos', '/api/lookups/customers', '/api/lookups/engineers', '/api/lookups/assemblies',
        '/api/lookups/custody-locations', '/api/lookups/item-bridge', '/api/lookups/employees']) {
        expect(doc.paths[p]?.get).toBeDefined();
      }
      expect(doc.paths['/api/equipment-units/{id}'].patch['x-roles']).toEqual(['PURCHASE']);
    });
  });
});
