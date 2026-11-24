import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { api, createItem, db, employeeIn, Fixtures, fails, ok, otherCompany, RUN, setupFixtures } from './helpers';

/**
 * Purchase "Stock" pill reads (CLAUDE.md §4i "Purchase Stock desk"): GET /stock/journal, /stock/items(/:id),
 * /stock/assemblies(/:id). PURCHASE only, read-only.
 *
 * Fixtures go through the live API: items via the Masters API, assemblies + BOM lines via POST /masters/assemblies(/bom),
 * stock via POST /inventory/receipts and /inventory/reservations (Purchase). Those direct ledger posts carry a random
 * reference_id, so they also prove an unresolvable reference comes back with a null label. The GRN / job / SOUT label
 * resolution is asserted where those documents exist: test/flow.e2e-spec.ts (BR-06 / BR-07) and test/br11.e2e-spec.ts.
 *
 * Item and assembly masters are global and shared with other suites, so list assertions are scoped with `search=<RUN>`.
 */
describe('Purchase Stock desk (GET /stock/*)', () => {
  let c: Client;
  let f: Fixtures;
  let foreignPurchase: string;
  const s: Record<string, any> = {};
  const P = () => f.purchase;
  const get = async (path: string, actor = P()) => ok(await api('get', path, actor));

  const ITEM_KEYS = [
    'id', 'item_code', 'standard_name', 'short_description', 'record_type', 'base_uom', 'stock_flag', 'status', 'cc', 'ss', 'tt',
    'use_case', 'created_at', 'created_by_name', 'tech_approved_at', 'tech_approved_by_name', 'bom_usage_count',
  ];
  const ASM_KEYS = [
    'id', 'assembly_code', 'standard_name', 'assembly_type', 'oem_compatibility', 'bom_status', 'repairable', 'saleable', 'status',
    'effective_revision', 'latest_bom_revision', 'bom_lines', 'draft_item_lines', 'created_at',
  ];
  const JOURNAL_KEYS = [
    'id', 'posted_at', 'movement_type', 'status', 'item_id', 'item_code', 'item_name', 'uom', 'qty',
    'from_location_role', 'from_location_code', 'to_location_role', 'to_location_code', 'reference_kind', 'reference_id',
    'reference_document', 'reference_label', 'grn_id', 'po_id', 'po_number', 'job_id', 'job_number', 'outward_id',
    'sales_order_id', 'sales_order_number', 'actor_name',
  ];

  const newAssembly = async (name: string, oem: string) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = '030303' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
      const res = await api('post', '/masters/assemblies', P(), {
        assembly_code: code, standard_name: `IT ${name} ${RUN}`, cc: '03', ss: '03', tt: '03', assembly_type: 'DRIVE',
        core_function: 'integrity test drive', bom_status: 'KNOWN', repairable: true, saleable: false,
        duplicate_review_note: `integrity run ${RUN}`,
      });
      if (res.status === 400 && /duplicate|unique/i.test(JSON.stringify(res.body))) continue;
      const a = ok(res);
      if (oem) await c.query(`UPDATE fdn_assembly_master SET oem_compatibility=$2 WHERE id=$1`, [a.id, oem]); // no API sets it
      return a.id as string;
    }
    throw new Error('could not allocate a unique assembly code');
  };
  const bom = (asm: string, item: string, qty: number, rev: number) =>
    api('post', `/masters/assemblies/${asm}/bom`, P(), { item_id: item, qty_per: qty, uom: 'NOS', bom_revision: rev });
  const post = (path: string, body: Record<string, unknown>) =>
    api('post', `/inventory/${path}`, P(), { company_id: f.companyId, uom: 'NOS', reference_id: randomUUID(), ...body },
      { 'Idempotency-Key': `it-${RUN}-${randomUUID()}` });

  beforeAll(async () => {
    c = await db();
    f = await setupFixtures(c);
    foreignPurchase = await employeeIn(c, await otherCompany(c), 'PUR', 'PURCHASE', 'STK');
    await c.query(
      `INSERT INTO fdn_code_dictionary(kind,cc,ss,tt,label) VALUES ('ASSEMBLY','03','03','03','Drive / VFD / Integrity')
       ON CONFLICT (kind,cc,ss,tt) DO NOTHING`,
    );
    s.active = await createItem(P(), true, 'stock-active');   // ACTIVE (approve -> ACTIVE)
    s.draft = await createItem(P(), false, 'stock-draft');    // DRAFT
    s.activeCode = (await c.query(`SELECT item_code FROM fdn_item_master WHERE id=$1`, [s.active])).rows[0].item_code;

    s.asmA = await newAssembly('stock-asm-A', `OEM-${RUN} ACS550`);
    s.asmB = await newAssembly('stock-asm-B', '');
    ok(await api('post', `/masters/assemblies/${s.asmB}/approve`, P()));
    // A: revision 0 = active item only; revision 1 = active (qty 2) + draft item. B: revision 0 = active item.
    ok(await bom(s.asmA, s.active, 1, 0));
    ok(await bom(s.asmA, s.active, 2, 1));
    ok(await bom(s.asmA, s.draft, 1, 1));
    ok(await bom(s.asmB, s.active, 4, 0));

    // Stock: 10 received into MAIN_STORE, 3 reserved -> allocatable 7. 2 into QUARANTINE.
    ok(await post('receipts', { item_id: s.active, qty: 10, to_location_id: f.loc.MAIN_STORE }));
    ok(await post('receipts', { item_id: s.active, qty: 2, to_location_id: f.loc.QUARANTINE }));
    ok(await post('reservations', { item_id: s.active, qty: 3 }));
  }, 300_000);
  afterAll(() => c?.end());

  describe('access + validation', () => {
    const paths = () => [
      '/stock/journal', '/stock/items', `/stock/items/${s.active}`, '/stock/assemblies', `/stock/assemblies/${s.asmA}`,
    ];

    it('PURCHASE only: MANAGEMENT, STORES, SALES, ENGINEER, FINANCE, ADMIN get 403; no token 401', async () => {
      for (const p of paths()) {
        ok(await api('get', p, P()));
        for (const actor of [f.mgmt, f.stores, f.sales, f.engineer, f.finance, f.admin]) fails(await api('get', p, actor), 403);
        fails(await api('get', p), 401);
      }
    });

    it('unknown params, bad enums, bad dates, page_size > 100 and bad uuids are 400; unknown ids 404', async () => {
      for (const p of [
        '/stock/journal?company_id=x', '/stock/journal?movement_type=MOVE', '/stock/journal?reference_kind=BR99_X',
        '/stock/journal?location_role=SHELF', '/stock/journal?from=2026-13-01', '/stock/journal?to=2026-02-30',
        '/stock/journal?item_id=nope', '/stock/journal?page_size=101', '/stock/items?status=OPEN',
        '/stock/items?record_type=PART', '/stock/items?stock_flag=YES', '/stock/assemblies?status=LIVE',
        '/stock/items/nope', `/stock/assemblies/${s.asmA}?revision=-1`, `/stock/assemblies/${s.asmA}?foo=1`,
      ]) fails(await api('get', p, P()), 400);
      fails(await api('get', `/stock/items/${randomUUID()}`, P()), 404);
      fails(await api('get', `/stock/assemblies/${randomUUID()}`, P()), 404);
    });
  });

  describe('items', () => {
    it('lists all statuses with names, BOM usage on latest revisions, and counts under search only', async () => {
      const p = await get(`/stock/items?search=${RUN}&page_size=100`);
      const byId = Object.fromEntries(p.rows.map((r: any) => [r.id, r]));
      expect(Object.keys(byId).sort()).toEqual([s.active, s.draft].sort());
      expect(Object.keys(byId[s.active]).sort()).toEqual([...ITEM_KEYS].sort());
      expect(byId[s.active]).toMatchObject({
        status: 'ACTIVE', record_type: 'COMPONENT', base_uom: 'NOS', stock_flag: 'STOCK', cc: '02', ss: '02', tt: '02',
        created_by_name: `IT PUR ${RUN}`, tech_approved_by_name: `IT PUR ${RUN}`, bom_usage_count: 2,
      });
      // draft item is only on asmA revision 1, which is asmA's latest
      expect(byId[s.draft]).toMatchObject({ status: 'DRAFT', tech_approved_at: null, tech_approved_by_name: null, bom_usage_count: 1 });
      expect(p.counts_by_status).toEqual({ DRAFT: 1, UNDER_REVIEW: 0, APPROVED: 0, ACTIVE: 1, ON_HOLD: 0, INACTIVE: 0, SUPERSEDED: 0 });
      expect(p.counts_by_record_type).toEqual({ ITEM: 0, COMPONENT: 2, CONSUMABLE: 0 });

      const drafts = await get(`/stock/items?search=${RUN}&status=DRAFT,UNDER_REVIEW`);
      expect(drafts.rows.map((r: any) => r.id)).toEqual([s.draft]);
      expect(drafts.total).toBe(1);
      expect(drafts.counts_by_status.ACTIVE).toBe(1); // counts ignore the status filter
      expect((await get(`/stock/items?search=${RUN}&record_type=ITEM`)).total).toBe(0);
      expect((await get(`/stock/items?search=${s.activeCode}`)).rows.map((r: any) => r.id)).toEqual([s.active]);

      const p1 = await get(`/stock/items?search=${RUN}&page_size=1`);
      const p2 = await get(`/stock/items?search=${RUN}&page_size=1&page=2`);
      expect([p1.rows[0].id, p2.rows[0].id]).toEqual(p.rows.map((r: any) => r.id)); // ordered by item_code
      expect(p1.total).toBe(2);
    });

    it('detail adds used-in (latest revision per assembly) and the company availability', async () => {
      const d = await get(`/stock/items/${s.active}`);
      expect(d.used_in).toEqual(expect.arrayContaining([
        expect.objectContaining({ assembly_id: s.asmA, bom_revision: 1, qty_per: '2', uom: 'NOS', assembly_status: 'DRAFT' }),
        expect.objectContaining({ assembly_id: s.asmB, bom_revision: 0, qty_per: '4', assembly_status: 'ACTIVE' }),
      ]));
      expect(d.used_in).toHaveLength(2);
      expect(d.availability).toMatchObject({ allocatable: '7', reserved: '3' });
      const bal = Object.fromEntries(d.availability.balances.map((b: any) => [b.role, b.qty_on_hand]));
      expect(bal).toMatchObject({ MAIN_STORE: '10', QUARANTINE: '2' });
      // same numbers as the existing availability read
      const inv = await get(`/inventory/availability?company_id=${f.companyId}&item_id=${s.active}`);
      expect(Number(inv.allocatable)).toBe(7);
      expect(d).toMatchObject({ batch_tracking: false, serial_tracking: false, effective_revision: 0 });

      // another company sees the same master row with its own (empty) availability
      const foreign = await get(`/stock/items/${s.active}`, foreignPurchase);
      expect(foreign.availability).toEqual({ allocatable: '0', reserved: '0', balances: [] });

      const draft = await get(`/stock/items/${s.draft}`);
      expect(draft.used_in).toEqual([expect.objectContaining({ assembly_id: s.asmA, bom_revision: 1, qty_per: '1' })]);
      expect(draft.availability).toEqual({ allocatable: '0', reserved: '0', balances: [] });
    });
  });

  describe('assemblies', () => {
    it('lists with latest BOM revision, line count, non-requestable lines and counts under search only', async () => {
      const p = await get(`/stock/assemblies?search=${RUN}&page_size=100`);
      const byId = Object.fromEntries(p.rows.map((r: any) => [r.id, r]));
      expect(Object.keys(byId).sort()).toEqual([s.asmA, s.asmB].sort());
      expect(Object.keys(byId[s.asmA]).sort()).toEqual([...ASM_KEYS].sort());
      expect(byId[s.asmA]).toMatchObject({
        status: 'DRAFT', assembly_type: 'DRIVE', oem_compatibility: `OEM-${RUN} ACS550`, latest_bom_revision: 1, bom_lines: 2, draft_item_lines: 1,
      });
      expect(byId[s.asmB]).toMatchObject({ status: 'ACTIVE', oem_compatibility: null, latest_bom_revision: 0, bom_lines: 1, draft_item_lines: 0 });
      expect(p.counts_by_status).toMatchObject({ DRAFT: 1, ACTIVE: 1, APPROVED: 0 });
      expect((await get(`/stock/assemblies?search=${RUN}&status=ACTIVE`)).rows.map((r: any) => r.id)).toEqual([s.asmB]);
      expect((await get(`/stock/assemblies?search=OEM-${RUN}`)).rows.map((r: any) => r.id)).toEqual([s.asmA]); // oem_compatibility
    });

    it('detail returns the latest revision by default, any revision on request, with item status', async () => {
      const d = await get(`/stock/assemblies/${s.asmA}`);
      expect(d).toMatchObject({ bom_revisions: [0, 1], bom_revision: 1, created_by_name: `IT PUR ${RUN}`, core_function: 'integrity test drive' });
      const lines = Object.fromEntries(d.bom.map((l: any) => [l.item_id, l]));
      expect(lines[s.active]).toMatchObject({ qty_per: '2', uom: 'NOS', item_status: 'ACTIVE', item_requestable: true });
      expect(lines[s.draft]).toMatchObject({ qty_per: '1', item_status: 'DRAFT', item_requestable: false });

      const r0 = await get(`/stock/assemblies/${s.asmA}?revision=0`);
      expect(r0.bom_revision).toBe(0);
      expect(r0.bom).toEqual([expect.objectContaining({ item_id: s.active, qty_per: '1' })]);
      const none = await get(`/stock/assemblies/${s.asmA}?revision=7`);
      expect(none).toMatchObject({ bom_revision: 7, bom: [] });
    });
  });

  describe('journal', () => {
    it('company postings with item, locations and actor; an unresolvable reference has a null label', async () => {
      const j = await get(`/stock/journal?item_id=${s.active}&page_size=100`);
      expect(j.total).toBe(2); // reservations are not journal postings
      expect(Object.keys(j.rows[0]).sort()).toEqual([...JOURNAL_KEYS].sort());
      for (const r of j.rows) {
        expect(r).toMatchObject({
          movement_type: 'RECEIPT', status: 'POSTED', item_code: s.activeCode, uom: 'NOS', from_location_role: null,
          reference_kind: 'BR06_GRN_LINE', reference_document: null, reference_label: null, grn_id: null, job_id: null,
          actor_name: `IT PUR ${RUN}`,
        });
      }
      expect(j.rows.map((r: any) => `${r.to_location_role}:${r.qty}`).sort()).toEqual(['MAIN_STORE:10', 'QUARANTINE:2']);
      expect(JSON.stringify(j)).not.toMatch(/idempotency/i);
      // newest first
      expect(new Date(j.rows[0].posted_at).getTime()).toBeGreaterThanOrEqual(new Date(j.rows[1].posted_at).getTime());

      const q = await get(`/stock/journal?item_id=${s.active}&location_role=QUARANTINE`);
      expect(q.rows.map((r: any) => r.qty)).toEqual(['2']);
      expect((await get(`/stock/journal?item_id=${s.active}&movement_type=ISSUE`)).total).toBe(0);
      expect((await get(`/stock/journal?item_id=${s.active}&reference_id=${j.rows[0].reference_id}`)).total).toBe(1);

      const counts = await get(`/stock/journal?search=${s.activeCode}&movement_type=ISSUE`);
      expect(counts.total).toBe(0);
      expect(counts.counts_by_movement_type).toEqual({
        RECEIPT: 2, ISSUE: 0, CONSUME: 0, RETURN: 0, SUPPLIER_RETURN: 0, TRANSFER: 0, ADJUST: 0,
      });
    });

    it('date range is inclusive in the company timezone; another company sees none of these rows', async () => {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      expect((await get(`/stock/journal?item_id=${s.active}&from=${today}&to=${today}`)).total).toBe(2);
      expect((await get(`/stock/journal?item_id=${s.active}&from=2099-01-01`)).total).toBe(0);
      expect((await get(`/stock/journal?item_id=${s.active}&to=2020-01-01`)).total).toBe(0);
      expect((await get(`/stock/journal?item_id=${s.active}`, foreignPurchase)).total).toBe(0);
      expect((await get(`/stock/journal?search=${s.activeCode}`, foreignPurchase)).total).toBe(0);
    });
  });
});
