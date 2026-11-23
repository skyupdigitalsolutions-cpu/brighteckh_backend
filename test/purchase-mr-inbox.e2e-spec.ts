import { Client } from 'pg';
import {
  api, bridge, createItem, db, employeeIn, Fixtures, fails, ok, otherCompany, RUN, setupFixtures,
} from './helpers';

/**
 * Purchase material-request inbox (CLAUDE.md §4i "Purchase MR inbox"): GET /purchase/material-requests.
 * Two jobs (two customers, two engineers), each driven through the live BR-02 / BR-03 API (assign -> custody-ack ->
 * inspection -> Purchase ACCEPT -> MR + lines + submit / start-processing / change request). Nine MRs cover all seven
 * statuses. RETURNED / WITHDRAWN / CLOSED have no API that sets them, so those three are submitted through the API and
 * then moved by a direct fixture UPDATE (labelled below).
 *
 * BLR is shared with other suites and demo data, so company-wide assertions are scoped with `search=<RUN>` (every
 * customer / engineer name of this file contains this file's RUN).
 */
describe('Purchase MR inbox (GET /purchase/material-requests)', () => {
  let c: Client;
  let f: Fixtures;
  let eng2: string;          // second engineer, same company (job B)
  let customerB: string;     // second customer (job B)
  let foreignPurchase: string;
  const s: Record<string, any> = {};
  const P = () => f.purchase;
  const E = () => f.engineer;

  type Page = { rows: any[]; total: number; page: number; page_size: number; counts_by_status: Record<string, number> };
  const list = async (qs: string, actor = P()) =>
    ok<Page>(await api('get', `/purchase/material-requests${qs ? `?${qs}` : ''}`, actor));
  const ids = (p: Page) => p.rows.map((r) => r.id);
  const enc = encodeURIComponent;

  const KEYS = [
    'id', 'request_number', 'status', 'priority', 'required_by_date', 'required_by_reason', 'created_at', 'submitted_at',
    'self_edit_deadline_at', 'purchase_processing_started_at', 'purchase_started_by_name', 'closed_at',
    'engineer_can_edit', 'job_id', 'job_number', 'customer_name', 'responsible_engineer_id', 'responsible_engineer_name',
    'lines_count', 'pending_change_requests', 'latest_change_request_at',
  ].sort();
  const STATUSES = ['DRAFT', 'SUBMITTED', 'PROCESSING', 'RETURNED', 'CHANGE_REQUESTED', 'WITHDRAWN', 'CLOSED'];

  /** BR-02 JIN with one unit -> verified job. */
  const newJob = async (customerId: string, tag: string) => {
    const jin = ok(await api('post', '/inward-receipts', P(), {
      customer_id: customerId, receipt_at: new Date().toISOString(), receipt_channel: 'WALK_IN', customer_dc_number: `DC-MR-${tag}-${RUN}`,
    }));
    const g = ok(await api('post', `/inward-receipts/${jin.id}/equipment-groups`, P(), { assembly_id: f.assemblyId, quantity_received: 1 }));
    const ex = ok(await api('post', `/equipment-groups/${g.id}/expand`, P(), { location_id: f.custodyLocationId, custodian_id: P() }));
    const unit = ex.units[0].id;
    ok(await api('post', `/equipment-units/${unit}/photos`, P(), { file_uri: `s3://it/mr-${unit}.jpg`, file_name: 'unit.jpg' }));
    return ok(await api('post', `/equipment-units/${unit}/verify`, P())).job;
  };

  /** BR-03 prerequisite chain: assign -> custody-ack -> inspection -> report -> Purchase ACCEPT. */
  const readyForMr = async (jobId: string, engineer: string) => {
    ok(await api('post', `/jobs/${jobId}/assign`, P(), { engineer_id: engineer }));
    ok(await api('post', `/jobs/${jobId}/custody-ack`, engineer, { condition_note: 'ok' }));
    const sess = ok(await api('post', `/jobs/${jobId}/inspection-sessions`, engineer));
    ok(await api('post', `/inspection-sessions/${sess.id}/stop`, engineer));
    const rep = ok(await api('post', `/jobs/${jobId}/inspection-reports`, engineer));
    ok(await api('post', `/inspection-reports/${rep.id}/media`, engineer, {
      media_type: 'PHOTO', file_uri: `s3://it/mr-insp-${jobId}.jpg`, file_name: 'insp.jpg',
    }));
    ok(await api('post', `/inspection-reports/${rep.id}/submit`, engineer, {
      inspection_description: 'MR inbox fixture', outcome: 'REPAIR_REQUIRED',
    }));
    ok(await api('post', `/inspection-reports/${rep.id}/review`, P(), { decision: 'ACCEPT' }));
  };

  const mr = async (jobId: string, engineer: string, priority: string, nLines: number, extra: Record<string, unknown> = {}) => {
    const m = ok(await api('post', `/jobs/${jobId}/material-requests`, engineer, { priority, ...extra }));
    for (let i = 0; i < nLines; i++) {
      ok(await api('post', `/material-requests/${m.id}/lines`, engineer, { item_bridge_id: s.bridgeOk, quantity: i + 1 }));
    }
    return m.id as string;
  };
  const submit = async (id: string, engineer: string) => ok(await api('post', `/material-requests/${id}/submit`, engineer));
  const startProcessing = async (id: string) => ok(await api('post', `/material-requests/${id}/start-processing`, P()));
  const changeRequest = async (id: string, engineer: string) => ok(await api('post', `/material-requests/${id}/change-requests`, engineer, {
    change_reason: 'need one more', proposed_change: { note: 'mr inbox fixture' },
  }));

  beforeAll(async () => {
    c = await db();
    f = await setupFixtures(c);
    eng2 = await employeeIn(c, f.companyId, 'ENG', 'ENGINEER', 'MR2');
    foreignPurchase = await employeeIn(c, await otherCompany(c), 'PUR', 'PURCHASE', 'MRX');
    customerB = (await c.query(
      `INSERT INTO customers(company_id,customer_code,customer_name,status,gstin,state_code,billing_address,credit_days)
       VALUES ($1,$2,$3,'APPROVED','29AAACI1234A1Z5','29','IT billing address, Bengaluru',30) RETURNING id`,
      [f.companyId, `IT-CUST-${RUN}B`, `IT Customer ${RUN}B`],
    )).rows[0].id;
    s.item = await createItem(P(), true, 'mr-inbox-part');
    s.bridgeOk = await bridge(c, s.item, 'APPROVED');

    s.jobA = await newJob(f.customerId, 'A');
    s.jobB = await newJob(customerB, 'B');
    await readyForMr(s.jobA.id, E());
    await readyForMr(s.jobB.id, eng2);

    // Job A (engineer 1, customer A)
    s.draft = await mr(s.jobA.id, E(), 'NORMAL', 1);                                        // DRAFT
    s.sub = await mr(s.jobA.id, E(), 'URGENT', 2, { required_by_date: '2026-12-15', required_by_reason: 'plant stopped' });
    await submit(s.sub, E());                                                               // SUBMITTED
    s.proc = await mr(s.jobA.id, E(), 'NORMAL', 1);
    await submit(s.proc, E()); await startProcessing(s.proc);                               // PROCESSING
    s.cr = await mr(s.jobA.id, E(), 'CRITICAL', 1);
    await submit(s.cr, E()); await startProcessing(s.cr);
    s.crRow = await changeRequest(s.cr, E());                                               // CHANGE_REQUESTED, 1 pending CR
    s.crRev = await mr(s.jobA.id, E(), 'URGENT', 1);
    await submit(s.crRev, E()); await startProcessing(s.crRev);
    const cr2 = await changeRequest(s.crRev, E());
    ok(await api('post', `/material-requests/${s.crRev}/change-requests/${cr2.id}/review`, P(), { decision: 'REJECTED', comment: 'no' }));
    // -> PROCESSING again, 0 pending, latest_change_request_at set

    // Job B (engineer 2, customer B)
    s.b = await mr(s.jobB.id, eng2, 'CRITICAL', 3);
    await submit(s.b, eng2);                                                                // SUBMITTED
    s.closed = await mr(s.jobB.id, eng2, 'CRITICAL', 1);
    s.ret = await mr(s.jobB.id, eng2, 'NORMAL', 1);
    s.wd = await mr(s.jobB.id, eng2, 'NORMAL', 1);
    for (const id of [s.closed, s.ret, s.wd]) await submit(id, eng2);
    // FIXTURE ONLY: no API sets CLOSED / RETURNED / WITHDRAWN today.
    await c.query(`UPDATE br03_material_requests SET status='CLOSED', closed_at=now() WHERE id=$1`, [s.closed]);
    await c.query(`UPDATE br03_material_requests SET status='RETURNED' WHERE id=$1`, [s.ret]);
    await c.query(`UPDATE br03_material_requests SET status='WITHDRAWN' WHERE id=$1`, [s.wd]);

    s.all = [s.draft, s.sub, s.proc, s.cr, s.crRev, s.b, s.closed, s.ret, s.wd];
    s.jobBMrs = [s.b, s.closed, s.ret, s.wd];
  }, 600_000);
  afterAll(() => c?.end());

  describe('access', () => {
    it('PURCHASE and MANAGEMENT get 200 (same rows); ENGINEER, SALES, STORES, FINANCE 403; no token 401', async () => {
      const p = await list(`search=${RUN}&page_size=100`);
      const m = await list(`search=${RUN}&page_size=100`, f.mgmt);
      expect(ids(m)).toEqual(ids(p));
      for (const actor of [E(), eng2, f.sales, f.stores, f.finance]) {
        fails(await api('get', '/purchase/material-requests', actor), 403);
      }
      fails(await api('get', '/purchase/material-requests'), 401);
    });

    it('company scoping: another company sees none of these rows', async () => {
      const x = await list(`search=${RUN}`, foreignPurchase);
      expect(x.total).toBe(0);
      expect(x.rows).toEqual([]);
      expect(Object.values(x.counts_by_status).every((n) => n === 0)).toBe(true);
      const all = await list('page_size=100', foreignPurchase);
      expect(ids(all).filter((id) => s.all.includes(id))).toEqual([]);
    });
  });

  describe('scope, counts, ordering', () => {
    it('search=<RUN> returns exactly this file\'s 9 MRs, DRAFT included', async () => {
      const p = await list(`search=${RUN}&page_size=100`);
      expect([...ids(p)].sort()).toEqual([...s.all].sort());
      expect(p.total).toBe(9);
      expect(p.page).toBe(1);
      expect(p.page_size).toBe(100);
    });

    it('counts_by_status: all 7 statuses, respects search, ignores status / priority / job_id / engineer_id', async () => {
      const expected = { DRAFT: 1, SUBMITTED: 2, PROCESSING: 2, RETURNED: 1, CHANGE_REQUESTED: 1, WITHDRAWN: 1, CLOSED: 1 };
      expect((await list(`search=${RUN}`)).counts_by_status).toEqual(expected);
      const filtered = await list(`search=${RUN}&status=SUBMITTED&priority=CRITICAL&job_id=${s.jobB.id}&engineer_id=${eng2}`);
      expect(filtered.counts_by_status).toEqual(expected);
      expect(ids(filtered)).toEqual([s.b]);
      expect(filtered.total).toBe(1);
      // search narrows the counts (job B only)
      expect((await list(`search=${enc(`IT Customer ${RUN}B`)}`)).counts_by_status).toEqual(
        { DRAFT: 0, SUBMITTED: 1, PROCESSING: 0, RETURNED: 1, CHANGE_REQUESTED: 0, WITHDRAWN: 1, CLOSED: 1 });
      // keys are always the full 7
      expect(Object.keys((await list(`search=${enc(`no-such-${RUN}`)}`)).counts_by_status).sort()).toEqual([...STATUSES].sort());
    });

    it('order: CHANGE_REQUESTED, SUBMITTED, rest; then CRITICAL > URGENT > NORMAL; then submitted_at/created_at desc', async () => {
      const p = await list(`search=${RUN}&page_size=100`);
      // Head is fully determined by status group + priority.
      expect(ids(p).slice(0, 5)).toEqual([s.cr, s.b, s.sub, s.closed, s.crRev]);
      // Tail = the NORMAL "rest" rows (draft, proc, ret, wd), by COALESCE(submitted_at, created_at) desc.
      const tail = p.rows.slice(5);
      expect(tail.map((r) => r.id).sort()).toEqual([s.draft, s.proc, s.ret, s.wd].sort());
      const key = (r: any) => new Date(r.submitted_at ?? r.created_at).getTime();
      for (let i = 1; i < tail.length; i++) expect(key(tail[i - 1])).toBeGreaterThanOrEqual(key(tail[i]));
    });

    it('paging: page_size=4 pages concatenate to the full ordered list; total is all pages', async () => {
      const full = ids(await list(`search=${RUN}&page_size=100`));
      const pages: string[] = [];
      for (let page = 1; page <= 3; page++) {
        const p = await list(`search=${RUN}&page_size=4&page=${page}`);
        expect(p.total).toBe(9);
        expect(p.page).toBe(page);
        expect(p.page_size).toBe(4);
        expect(p.rows.length).toBe(page < 3 ? 4 : 1);
        pages.push(...ids(p));
      }
      expect(pages).toEqual(full);
      expect((await list(`search=${RUN}&page_size=4&page=4`)).rows).toEqual([]);
      // default page size
      expect((await list(`search=${RUN}`)).page_size).toBe(25);
    });
  });

  describe('filters + search', () => {
    it('status (csv)', async () => {
      const p = await list(`search=${RUN}&status=SUBMITTED,CHANGE_REQUESTED`);
      expect(ids(p)).toEqual([s.cr, s.b, s.sub]);
      expect((await list(`search=${RUN}&status=DRAFT`)).rows.map((r) => r.id)).toEqual([s.draft]);
      expect([...ids(await list(`search=${RUN}&status=RETURNED,WITHDRAWN,CLOSED`))].sort()).toEqual([s.ret, s.wd, s.closed].sort());
    });

    it('priority (csv)', async () => {
      expect([...ids(await list(`search=${RUN}&priority=CRITICAL`))].sort()).toEqual([s.cr, s.b, s.closed].sort());
      expect([...ids(await list(`search=${RUN}&priority=URGENT,CRITICAL`))].sort()).toEqual([s.cr, s.b, s.closed, s.sub, s.crRev].sort());
    });

    it('job_id and engineer_id', async () => {
      expect([...ids(await list(`job_id=${s.jobB.id}&page_size=100`))].sort()).toEqual([...s.jobBMrs].sort());
      expect([...ids(await list(`job_id=${s.jobA.id}&page_size=100`))].sort())
        .toEqual([s.draft, s.sub, s.proc, s.cr, s.crRev].sort());
      expect([...ids(await list(`engineer_id=${eng2}&page_size=100`))].sort()).toEqual([...s.jobBMrs].sort());
      expect((await list(`job_id=${s.jobA.id}&engineer_id=${eng2}`)).total).toBe(0);
    });

    it('search: request number, job number, engineer name, customer name (case-insensitive)', async () => {
      const subNo = (await c.query(`SELECT request_number FROM br03_material_requests WHERE id=$1`, [s.sub])).rows[0].request_number;
      expect(ids(await list(`search=${enc(subNo.toLowerCase())}`))).toEqual([s.sub]);
      expect([...ids(await list(`search=${enc(s.jobB.job_number)}`))].sort()).toEqual([...s.jobBMrs].sort());
      expect([...ids(await list(`search=${enc(`it eng ${RUN}mr2`)}`))].sort()).toEqual([...s.jobBMrs].sort());
      expect([...ids(await list(`search=${enc(`IT Customer ${RUN}B`)}`))].sort()).toEqual([...s.jobBMrs].sort());
      expect((await list(`search=${enc(`no-such-${RUN}`)}`)).total).toBe(0);
    });

    it('400 on unknown params and bad values', async () => {
      for (const qs of ['foo=1', 'company_id=x', 'status=OPEN', 'priority=LOW', 'job_id=nope', 'engineer_id=nope',
        'page_size=101', 'page=0', `search=${'x'.repeat(101)}`]) {
        fails(await api('get', `/purchase/material-requests?${qs}`, P()), 400);
      }
    });
  });

  describe('row values', () => {
    it('exact key set; no lines, price, offer, estimate or supplier keys', async () => {
      const p = await list(`search=${RUN}&page_size=100`);
      for (const r of p.rows) {
        expect(Object.keys(r).sort()).toEqual(KEYS);
        for (const k of ['lines', 'change_requests', 'unit_price', 'supplier_name', 'reference_offer_line_id',
          'procurement_offer_line_id', 'estimate_id', 'company_id', 'inspection_version_id']) {
          expect(r).not.toHaveProperty(k);
        }
      }
      const keys: string[] = [];
      const walk = (v: unknown) => {
        if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
      };
      walk(p);
      expect(keys.filter((k) => /offer|estimate|price|cost|supplier|margin|paise/i.test(k))).toEqual([]);
    });

    it('every field matches the DB', async () => {
      const p = await list(`search=${RUN}&page_size=100`);
      const dbRows = await c.query(`
        SELECT m.*, to_char(m.required_by_date,'YYYY-MM-DD') AS rbd, j.job_number, cu.customer_name,
               e.full_name AS eng_name, ps.full_name AS ps_name, br03_can_engineer_edit(m.id) AS can_edit,
               (SELECT count(*)::int FROM br03_material_request_lines l WHERE l.request_id=m.id) AS n_lines,
               (SELECT count(*)::int FROM br03_material_change_requests x WHERE x.material_request_id=m.id AND x.review_status='PENDING') AS n_pending,
               (SELECT max(a.changed_at) FROM br03_material_change_requests x
                  JOIN activity_audit_log a ON a.entity_id=x.id AND a.action='BR03_CHANGE_REQUEST_CREATED'
                 WHERE x.material_request_id=m.id) AS latest_cr
          FROM br03_material_requests m
          JOIN service_jobs j ON j.id=m.job_id
          JOIN inward_receipts r ON r.id=j.inward_id
          JOIN customers cu ON cu.id=r.customer_id
          JOIN employees e ON e.id=m.responsible_engineer_id
          LEFT JOIN employees ps ON ps.id=m.purchase_started_by_id
         WHERE m.id = ANY($1::uuid[])`, [s.all]);
      const byId = Object.fromEntries(dbRows.rows.map((d) => [d.id, d]));
      const ts = (v: any) => (v == null ? null : new Date(v).getTime());
      for (const r of p.rows) {
        const d = byId[r.id];
        expect(r).toMatchObject({
          request_number: d.request_number, status: d.status, priority: d.priority, required_by_date: d.rbd,
          required_by_reason: d.required_by_reason, purchase_started_by_name: d.ps_name, engineer_can_edit: d.can_edit,
          job_id: d.job_id, job_number: d.job_number, customer_name: d.customer_name,
          responsible_engineer_id: d.responsible_engineer_id, responsible_engineer_name: d.eng_name,
          lines_count: d.n_lines, pending_change_requests: d.n_pending,
        });
        for (const [k, col] of [['created_at', 'created_at'], ['submitted_at', 'submitted_at'],
          ['self_edit_deadline_at', 'self_edit_deadline_at'], ['purchase_processing_started_at', 'purchase_processing_started_at'],
          ['closed_at', 'closed_at'], ['latest_change_request_at', 'latest_cr']]) {
          expect([k, ts(r[k])]).toEqual([k, ts(d[col])]);
        }
      }
    });

    it('spot values: names, lines, change requests, edit window', async () => {
      const row = async (id: string) => (await list(`search=${RUN}&page_size=100`)).rows.find((r) => r.id === id);
      const sub = await row(s.sub);
      expect(sub).toMatchObject({
        status: 'SUBMITTED', priority: 'URGENT', required_by_date: '2026-12-15', required_by_reason: 'plant stopped',
        lines_count: 2, pending_change_requests: 0, latest_change_request_at: null, purchase_started_by_name: null,
        job_number: s.jobA.job_number, customer_name: `IT Customer ${RUN}`, responsible_engineer_id: E(),
        responsible_engineer_name: `IT ENG ${RUN}`,
      });
      expect(sub.self_edit_deadline_at).not.toBeNull();

      const draft = await row(s.draft);
      expect(draft).toMatchObject({ status: 'DRAFT', engineer_can_edit: true, submitted_at: null, required_by_date: null });

      const proc = await row(s.proc);
      expect(proc).toMatchObject({ status: 'PROCESSING', engineer_can_edit: false, purchase_started_by_name: `IT PUR ${RUN}` });
      expect(proc.purchase_processing_started_at).not.toBeNull();

      const cr = await row(s.cr);
      expect(cr).toMatchObject({ status: 'CHANGE_REQUESTED', pending_change_requests: 1, engineer_can_edit: false });
      expect(cr.latest_change_request_at).not.toBeNull();

      const crRev = await row(s.crRev);
      expect(crRev).toMatchObject({ status: 'PROCESSING', pending_change_requests: 0 });
      expect(crRev.latest_change_request_at).not.toBeNull();

      const b = await row(s.b);
      expect(b).toMatchObject({
        lines_count: 3, customer_name: `IT Customer ${RUN}B`, responsible_engineer_id: eng2,
        responsible_engineer_name: `IT ENG ${RUN}MR2`, job_number: s.jobB.job_number,
      });

      const closed = await row(s.closed);
      expect(closed.status).toBe('CLOSED');
      expect(closed.closed_at).not.toBeNull();
      expect(closed.engineer_can_edit).toBe(false);
    });
  });
});
