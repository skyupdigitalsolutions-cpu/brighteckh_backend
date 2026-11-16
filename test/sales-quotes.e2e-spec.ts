import { Client } from 'pg';
import request from 'supertest';
import { api, BASE, db, dbRejects, employeeIn, Fixtures, fails, ok, otherCompany, RUN, setupFixtures } from './helpers';

/**
 * Sales desk reads (CLAUDE.md §4i "Sales desk reads"):
 *   G-S1 GET /sales/quotes            -- the caller's quotes (latest revision released to them) + derived sales_stage
 *   G-S2 GET /quotes/:id              -- sent_at / sent_by_id / sent_by_name per revision (BR04_QUOTE_SENT audit row)
 * One JIN with 12 units -> 12 jobs -> one quote each, driven through the live API (create, release, send, revise,
 * customer responses). The BR-04 ACCEPTED/REJECTED/EXPIRED revision statuses are unreachable (no API sets them and the
 * DB trigger brcm_guard_quote_revision refuses any update of a SENT revision), which is asserted instead.
 */
describe('Sales desk reads (G-S1 /sales/quotes, G-S2 sent fields)', () => {
  let c: Client;
  let f: Fixtures;
  let salesB: string;        // same company, a different Sales employee
  let foreignSales: string;  // company B
  const s: Record<string, any> = {};
  const P = () => f.purchase;
  const S = () => f.sales;
  type Page = { rows: any[]; total: number; page: number; page_size: number; counts_by_stage: Record<string, number> };
  const list = (qs: string, actor = S()) => api('get', `/sales/quotes${qs ? `?${qs}` : ''}`, actor).then((r) => ok<Page>(r));
  const byQuote = (p: Page) => Object.fromEntries(p.rows.map((r) => [r.quote_id, r]));
  const LINES = [{ line_type: 'REPAIR_SERVICE', line_description: 'Drive repair', quantity: 1, uom: 'NOS', net_unit_price_pre_tax: 12000 }];
  const KEYS = [
    'quote_id', 'quote_number', 'quote_type', 'job_id', 'job_number',
    'customer_id', 'customer_name', 'customer_code',
    'serial_number', 'observed_make', 'observed_model', 'assembly_name',
    'latest_revision_id', 'revision_no', 'quote_status', 'valid_until',
    'revised_pre_tax', 'tax_total', 'freight_charge',
    'assigned_sales_id', 'released_to_sales_at', 'released_by_id', 'released_by_name',
    'sent_at', 'sent_by_id', 'sent_by_name', 'latest_response', 'sales_stage',
  ].sort();

  const quote = async (name: string, extra: Record<string, unknown> = {}) => {
    const q = ok(await api('post', `/jobs/${s.jobs[name].id}/quotes`, P(), { quote_type: 'ITEM', lines: LINES, tax_total: 2160, ...extra }));
    s.q[name] = q;
    return q;
  };
  const release = async (name: string, to = S()) => ok(await api('post', `/quotes/${s.q[name].id}/release-to-sales`, P(), { assigned_sales_id: to }));
  const send = async (name: string, by = S()) => ok(await api('post', `/quotes/${s.q[name].id}/send`, by));
  const respond = async (name: string, response_type: string, revisionId?: string) => ok(await api('post', `/jobs/${s.jobs[name].id}/quote-responses`, S(), {
    br04_quote_revision_id: revisionId ?? s.q[name].revision.id, response_type, response_channel: 'EMAIL', customer_contact: `Mr ${name}`,
  }));

  const NAMES = ['to1', 'to2', 'rerel', 'aw', 'aw2', 'disc', 'acc', 'rej', 'exp', 'other', 'draft'];

  beforeAll(async () => {
    c = await db();
    f = await setupFixtures(c);
    salesB = await employeeIn(c, f.companyId, 'SAL', 'SALES', 'SQ');
    foreignSales = await employeeIn(c, await otherCompany(c), 'SAL', 'SALES', 'SX');

    // BR-02: one JIN, 12 units -> 12 jobs. Unit "aw" gets a serial/make/model for the search test.
    s.jin = ok(await api('post', '/inward-receipts', P(), {
      customer_id: f.customerId, receipt_at: new Date().toISOString(), receipt_channel: 'COURIER', customer_dc_number: `DC-SQ-${RUN}`,
    }));
    const g = ok(await api('post', `/inward-receipts/${s.jin.id}/equipment-groups`, P(), { assembly_id: f.assemblyId, quantity_received: NAMES.length }));
    const ex = ok(await api('post', `/equipment-groups/${g.id}/expand`, P(), { location_id: f.custodyLocationId, custodian_id: f.purchase }));
    s.units = Object.fromEntries(NAMES.map((n, i) => [n, ex.units[i].id]));
    ok(await api('patch', `/equipment-units/${s.units.aw}`, P(), { serial_number: `SN-SQ-${RUN}`, observed_make: `MK${RUN}`, observed_model: `MD${RUN}` }));
    s.jobs = {};
    for (const n of NAMES) {
      ok(await api('post', `/equipment-units/${s.units[n]}/photos`, P(), { file_uri: `s3://it/sq-${s.units[n]}.jpg`, file_name: `${n}.jpg` }));
      s.jobs[n] = ok(await api('post', `/equipment-units/${s.units[n]}/verify`, P())).job;
    }

    // BR-04 / BR-05 fixtures, one quote per job.
    s.q = {};
    for (const n of NAMES) await quote(n, n === 'aw' ? { valid_until: '2026-12-01', freight_charge: 150 } : { valid_until: '2027-06-30' });

    // "rerel": rev0 sent + ACCEPTED, then revised and re-released -> TO_SEND on rev1, no response on rev1.
    await release('rerel'); await send('rerel'); await respond('rerel', 'ACCEPTED');
    // "draft": sent, then Purchase revises -> latest is a DRAFT with no handoff -> out of scope.
    await release('draft'); await send('draft');
    ok(await api('post', `/quotes/${s.q.draft.id}/revise`, P(), { revision_reason: 'customer asked for a re-quote', lines: LINES }));

    // TO_SEND in release order to1, to2, then rerel's re-release.
    await release('to1');
    await release('to2');
    s.rerelRev1 = ok(await api('post', `/quotes/${s.q.rerel.id}/revise`, P(), { revision_reason: 'scope change', lines: LINES })).revision;
    await release('rerel');

    await release('other', salesB);
    for (const n of ['aw', 'aw2', 'disc', 'acc', 'rej', 'exp']) { await release(n); await send(n); }
    await respond('aw2', 'AWAITING_RESPONSE');
    await respond('disc', 'ACCEPTED'); await respond('disc', 'COUNTER_OFFER'); // latest wins
    await respond('acc', 'ACCEPTED');
    await respond('rej', 'REJECTED');
    await respond('exp', 'EXPIRED');
  }, 600_000); // ~110 live API calls against the remote DB
  afterAll(() => c?.end());

  describe('scope', () => {
    it('only quotes whose LATEST revision was released to the caller; DRAFT re-revision drops out', async () => {
      const p = await list('page_size=100');
      const ids = p.rows.map((r) => r.quote_id).sort();
      const expected = NAMES.filter((n) => n !== 'other' && n !== 'draft').map((n) => s.q[n].id).sort();
      expect(ids).toEqual(expected);
      expect(p.total).toBe(9);
      expect(p.rows.every((r) => r.assigned_sales_id === S())).toBe(true);
    });

    it('another Sales user sees only their own; another company sees nothing', async () => {
      const b = await list('', salesB);
      expect(b.rows.map((r) => r.quote_id)).toEqual([s.q.other.id]);
      expect(b.counts_by_stage).toEqual({ TO_SEND: 1, AWAITING: 0, IN_DISCUSSION: 0, ACCEPTED: 0, REJECTED: 0, EXPIRED: 0 });
      const x = await list('', foreignSales);
      expect(x.total).toBe(0);
      expect(x.rows).toEqual([]);
    });

    it('PURCHASE, ENGINEER and MANAGEMENT get 403; no token 401', async () => {
      for (const actor of [P(), f.engineer, f.mgmt, f.finance]) fails(await api('get', '/sales/quotes', actor), 403);
      fails(await api('get', '/sales/quotes'), 401);
    });
  });

  describe('row shape', () => {
    it('exact key set: no offer, estimate or cost fields', async () => {
      const p = await list('page_size=100');
      for (const r of p.rows) {
        expect(Object.keys(r).sort()).toEqual(KEYS);
        for (const k of ['reference_offer_line_id', 'procurement_offer_line_id', 'estimate_id', 'estimate_revision_id',
          'source_estimate_cost_line_id', 'original_authorised_pre_tax', 'discount_percent', 'quoted_unit_price']) {
          expect(r).not.toHaveProperty(k);
        }
        if (r.latest_response) {
          expect(Object.keys(r.latest_response).sort()).toEqual(
            ['customer_contact', 'recorded_by_id', 'recorded_by_name', 'responded_at', 'response_channel', 'response_id', 'response_type']);
        }
      }
      // No key anywhere in the payload names an offer, estimate, cost, supplier or margin value
      // (values are not checked: COUNTER_OFFER is a legitimate response_type).
      const keys: string[] = [];
      const walk = (v: unknown) => {
        if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
      };
      walk(p);
      expect(keys.filter((k) => /offer|estimate|cost|supplier|margin/i.test(k))).toEqual([]);
    });

    it('fields: job, customer, equipment, revision, money as strings, release, sent, latest response', async () => {
      const r = byQuote(await list('page_size=100'))[s.q.aw.id];
      const sentRow = (await c.query(
        `SELECT changed_at FROM activity_audit_log WHERE entity_id=$1 AND action='BR04_QUOTE_SENT'`, [s.q.aw.revision.id])).rows[0];
      expect(r).toMatchObject({
        quote_number: s.q.aw.quote_number, quote_type: 'ITEM', job_id: s.jobs.aw.id, job_number: s.jobs.aw.job_number,
        customer_id: f.customerId, customer_name: `IT Customer ${RUN}`, customer_code: `IT-CUST-${RUN}`,
        serial_number: `SN-SQ-${RUN}`, observed_make: `MK${RUN}`, observed_model: `MD${RUN}`, assembly_name: `IT Drive ${RUN}`,
        latest_revision_id: s.q.aw.revision.id, revision_no: 0, quote_status: 'SENT', valid_until: '2026-12-01',
        revised_pre_tax: '12000.00', tax_total: '2160.00', freight_charge: '150.00',
        assigned_sales_id: S(), released_by_id: P(), released_by_name: `IT PUR ${RUN}`,
        sent_by_id: S(), sent_by_name: `IT SAL ${RUN}`, sent_at: new Date(sentRow.changed_at).toISOString(),
        latest_response: null, sales_stage: 'AWAITING',
      });
      expect(typeof r.released_to_sales_at).toBe('string');

      const to1 = byQuote(await list('page_size=100'))[s.q.to1.id];
      expect(to1).toMatchObject({ quote_status: 'RELEASED_TO_SALES', sent_at: null, sent_by_id: null, sent_by_name: null, latest_response: null });

      const acc = byQuote(await list('page_size=100'))[s.q.acc.id];
      expect(acc.latest_response).toMatchObject({
        response_type: 'ACCEPTED', response_channel: 'EMAIL', customer_contact: 'Mr acc', recorded_by_id: S(), recorded_by_name: `IT SAL ${RUN}`,
      });
    });
  });

  describe('sales_stage derivation', () => {
    it('every stage, from the latest revision and its latest BR-05 response', async () => {
      const by = byQuote(await list('page_size=100'));
      const stage = (n: string) => by[s.q[n].id].sales_stage;
      expect(stage('to1')).toBe('TO_SEND');
      expect(stage('to2')).toBe('TO_SEND');
      expect(stage('aw')).toBe('AWAITING');            // SENT, no response
      expect(stage('aw2')).toBe('AWAITING');           // SENT, AWAITING_RESPONSE
      expect(stage('disc')).toBe('IN_DISCUSSION');     // ACCEPTED then COUNTER_OFFER: latest wins
      expect(stage('acc')).toBe('ACCEPTED');
      expect(stage('rej')).toBe('REJECTED');
      expect(stage('exp')).toBe('EXPIRED');
      // BR-04 statuses past SENT cannot be reached, even directly in the DB (so the mapping's BR-04 branch is defensive only).
      for (const st of ['ACCEPTED', 'REJECTED', 'EXPIRED']) {
        expect(await dbRejects(c, `UPDATE br04_customer_quote_revisions SET quote_status=$2 WHERE id=$1`, [s.q.acc.revision.id, st]))
          .toMatch(/immutable/);
      }
    });

    it('re-released revision: TO_SEND on rev 1, the rev-0 response is not carried over', async () => {
      const r = byQuote(await list('page_size=100'))[s.q.rerel.id];
      expect(r).toMatchObject({
        sales_stage: 'TO_SEND', latest_revision_id: s.rerelRev1.id, revision_no: 1, quote_status: 'RELEASED_TO_SALES',
        sent_at: null, latest_response: null,
      });
    });
  });

  describe('counts, filters, ordering, pagination', () => {
    const ALL = { TO_SEND: 3, AWAITING: 2, IN_DISCUSSION: 1, ACCEPTED: 1, REJECTED: 1, EXPIRED: 1 };

    it('counts_by_stage covers the scope and ignores stage / valid_until_before', async () => {
      expect((await list('')).counts_by_stage).toEqual(ALL);
      const toSend = await list('stage=TO_SEND');
      expect(toSend.counts_by_stage).toEqual(ALL);
      expect(toSend.total).toBe(3);
      expect(toSend.rows.every((r) => r.sales_stage === 'TO_SEND')).toBe(true);
      const two = await list('stage=ACCEPTED,REJECTED');
      expect(two.rows.map((r) => r.quote_id).sort()).toEqual([s.q.acc.id, s.q.rej.id].sort());
      expect(two.counts_by_stage).toEqual(ALL);
      expect((await list('valid_until_before=2026-12-02')).counts_by_stage).toEqual(ALL);
    });

    it('counts_by_stage respects search', async () => {
      const p = await list(`search=${encodeURIComponent(s.q.acc.quote_number)}`);
      expect(p.rows.map((r) => r.quote_id)).toEqual([s.q.acc.id]);
      expect(p.counts_by_stage).toEqual({ TO_SEND: 0, AWAITING: 0, IN_DISCUSSION: 0, ACCEPTED: 1, REJECTED: 0, EXPIRED: 0 });
    });

    it('search: quote number, job number, customer name/code, serial, make, model', async () => {
      const ids = async (term: string) => (await list(`search=${encodeURIComponent(term)}&page_size=100`)).rows.map((r) => r.quote_id);
      expect(await ids(s.q.rej.quote_number)).toEqual([s.q.rej.id]);
      expect(await ids(s.jobs.rej.job_number)).toEqual([s.q.rej.id]);
      for (const t of [`SN-SQ-${RUN}`, `mk${RUN}`, `MD${RUN}`]) expect(await ids(t)).toEqual([s.q.aw.id]);
      expect(await ids(`IT Customer ${RUN}`)).toHaveLength(9);
      expect(await ids(`IT-CUST-${RUN}`)).toHaveLength(9);
      expect(await ids(`no-such-${RUN}`)).toEqual([]);
    });

    it('valid_until_before is strict and drops null valid_until', async () => {
      expect((await list('valid_until_before=2026-12-02')).rows.map((r) => r.quote_id)).toEqual([s.q.aw.id]);
      expect((await list('valid_until_before=2026-12-01')).total).toBe(0);
      // rerel's rev 1 was revised without valid_until (null) -> excluded; every other quote is 2027-06-30 or earlier.
      const late = (await list('valid_until_before=2027-07-01&page_size=100')).rows.map((r) => r.quote_id);
      expect(late).toHaveLength(8);
      expect(late).not.toContain(s.q.rerel.id);
      expect((await list('valid_until_before=2027-07-01&stage=AWAITING')).total).toBe(2);
    });

    it('ordering: TO_SEND oldest release first, then latest of sent/responded desc, quote_number ties', async () => {
      const p = await list('page_size=100');
      expect(p.rows.slice(0, 3).map((r) => r.quote_id)).toEqual([s.q.to1.id, s.q.to2.id, s.q.rerel.id]);
      const touched = (r: any) => Math.max(r.sent_at ? Date.parse(r.sent_at) : -Infinity,
        r.latest_response ? Date.parse(r.latest_response.responded_at) : -Infinity);
      const rest = p.rows.slice(3);
      expect(rest.every((r) => r.sales_stage !== 'TO_SEND')).toBe(true);
      for (let i = 1; i < rest.length; i++) {
        const a = touched(rest[i - 1]); const b = touched(rest[i]);
        expect(a > b || (a === b && rest[i - 1].quote_number < rest[i].quote_number)).toBe(true);
      }
      // exp got the last response of all the SENT quotes.
      expect(rest[0].quote_id).toBe(s.q.exp.id);
    });

    it('pagination walks the same order', async () => {
      const all = (await list('page_size=100')).rows.map((r) => r.quote_id);
      const pages: string[] = [];
      for (let pg = 1; pg <= 3; pg++) {
        const p = await list(`page_size=4&page=${pg}`);
        expect(p).toMatchObject({ total: 9, page: pg, page_size: 4 });
        pages.push(...p.rows.map((r) => r.quote_id));
      }
      expect(pages).toEqual(all);
      expect((await list('page_size=4&page=4')).rows).toEqual([]);
    });

    it('bad params are 400', async () => {
      for (const bad of ['stage=WON', 'stage=SENT', 'valid_until_before=2026-13-01', 'valid_until_before=2026-02-30',
        'valid_until_before=01-12-2026', 'page=0', 'page_size=101', 'status=SENT', 'assigned=all', 'company_id=x', 'sort=asc']) {
        fails(await api('get', `/sales/quotes?${bad}`, S()), 400);
      }
    });

    it('IN_DISCUSSION covers COUNTER_OFFER / TECHNICAL_QUERY / PARTIAL_ACCEPTANCE / ON_HOLD', async () => {
      for (const t of ['TECHNICAL_QUERY', 'PARTIAL_ACCEPTANCE', 'ON_HOLD', 'COUNTER_OFFER']) {
        await respond('disc', t);
        const r = byQuote(await list(`search=${encodeURIComponent(s.q.disc.quote_number)}`))[s.q.disc.id];
        expect(r).toMatchObject({ sales_stage: 'IN_DISCUSSION', latest_response: { response_type: t } });
      }
      await respond('disc', 'AWAITING_RESPONSE');
      expect(byQuote(await list(`search=${encodeURIComponent(s.q.disc.quote_number)}`))[s.q.disc.id].sales_stage).toBe('AWAITING');
    });
  });

  describe('G-S2 GET /quotes/:id sent fields', () => {
    it('null before send, set from the BR04_QUOTE_SENT audit row after', async () => {
      const before = ok(await api('get', `/quotes/${s.q.to1.id}`, S()));
      expect(before.revisions[0]).toMatchObject({ sent_at: null, sent_by_id: null, sent_by_name: null, assigned_sales_id: S() });

      await send('to1');
      const after = ok(await api('get', `/quotes/${s.q.to1.id}`, P()));
      const audit = (await c.query(
        `SELECT actor_id, changed_at FROM activity_audit_log WHERE entity_id=$1 AND action='BR04_QUOTE_SENT'`, [s.q.to1.revision.id])).rows;
      expect(audit).toHaveLength(1);
      expect(after.revisions[0]).toMatchObject({
        quote_status: 'SENT', sent_at: new Date(audit[0].changed_at).toISOString(), sent_by_id: S(), sent_by_name: `IT SAL ${RUN}`,
      });
      // The list moves it out of TO_SEND with the same sent fields.
      const row = byQuote(await list(`search=${encodeURIComponent(s.q.to1.quote_number)}`))[s.q.to1.id];
      expect(row).toMatchObject({ sales_stage: 'AWAITING', sent_at: after.revisions[0].sent_at, sent_by_id: S() });
    });

    it('per revision: rev 0 keeps its send, the re-released rev 1 is unsent; a DRAFT revision is null', async () => {
      const r = ok(await api('get', `/quotes/${s.q.rerel.id}`, S()));
      expect(r.revisions.map((x: any) => x.revision_no)).toEqual([0, 1]);
      expect(r.revisions[0]).toMatchObject({ quote_status: 'SENT', sent_by_id: S() });
      expect(typeof r.revisions[0].sent_at).toBe('string');
      expect(r.revisions[1]).toMatchObject({ quote_status: 'RELEASED_TO_SALES', sent_at: null, sent_by_id: null, sent_by_name: null });
      const d = ok(await api('get', `/quotes/${s.q.draft.id}`, S()));
      expect(d.revisions[1]).toMatchObject({ quote_status: 'DRAFT', sent_at: null, assigned_sales_id: null });
    });
  });

  describe('OpenAPI', () => {
    it('documents /sales/quotes (SALES) and the sent fields', async () => {
      const doc = (await request(BASE).get('/docs-json')).body;
      expect(doc.paths['/api/sales/quotes'].get['x-roles']).toEqual(['SALES']);
      const sc = doc.components.schemas;
      expect(Object.keys(sc.SalesQuoteRow.properties).sort()).toEqual(KEYS);
      expect(Object.keys(sc.SalesQuoteListPage.properties)).toEqual(expect.arrayContaining(['rows', 'total', 'page', 'page_size', 'counts_by_stage']));
      expect(Object.keys(sc.QuoteRevisionWithLines.properties)).toEqual(expect.arrayContaining(['sent_at', 'sent_by_id', 'sent_by_name']));
    });
  });

  describe('POST /jobs/:id/quote-responses server-side guards (latest revision, SENT, assigned Sales)', () => {
    const respondAs = (actor: string, name: string, revisionId: string, response_type = 'AWAITING_RESPONSE') =>
      api('post', `/jobs/${s.jobs[name].id}/quote-responses`, actor, {
        br04_quote_revision_id: revisionId, response_type, response_channel: 'EMAIL', customer_contact: `Mr ${name}`,
      });
    const responseCount = async (name: string) => ok<unknown[]>(await api('get', `/jobs/${s.jobs[name].id}/quote-responses`, S())).length;
    const revisions = async (name: string) =>
      ok<{ revisions: { id: string; revision_no: number; quote_status: string }[] }>(await api('get', `/quotes/${s.q[name].id}`, P()))
        .revisions.sort((a, b) => a.revision_no - b.revision_no);

    it('400 when the revision was released but never SENT; nothing is written', async () => {
      const before = await responseCount('to2');
      fails(await respondAs(S(), 'to2', s.q.to2.revision.id, 'ACCEPTED'), 400, /not been sent.*RELEASED_TO_SALES/);
      expect(await responseCount('to2')).toBe(before);
    });

    it('400 when the revision is not the latest (superseded by a released or a DRAFT revision); nothing is written', async () => {
      // rerel: rev 0 was SENT + ACCEPTED, then revised and re-released -> rev 0 is no longer the latest.
      const rerel = await revisions('rerel');
      expect(rerel.map((r) => r.quote_status)).toEqual(['SENT', 'RELEASED_TO_SALES']);
      const beforeRerel = await responseCount('rerel');
      fails(await respondAs(S(), 'rerel', rerel[0].id, 'REJECTED'), 400, /latest revision/);
      expect(await responseCount('rerel')).toBe(beforeRerel);

      // draft: rev 0 SENT, then Purchase revised -> the latest is a DRAFT. Neither revision accepts a response.
      const draft = await revisions('draft');
      expect(draft.map((r) => r.quote_status)).toEqual(['SENT', 'DRAFT']);
      const beforeDraft = await responseCount('draft');
      fails(await respondAs(S(), 'draft', draft[0].id), 400, /latest revision/);
      fails(await respondAs(S(), 'draft', draft[1].id), 400, /not been sent.*DRAFT/);
      expect(await responseCount('draft')).toBe(beforeDraft);
    });

    it('403 for a Sales employee the revision was not released to (either direction); nothing is written', async () => {
      const beforeAw = await responseCount('aw');
      fails(await respondAs(salesB, 'aw', s.q.aw.revision.id), 403, /not released to this Sales employee/);
      expect(await responseCount('aw')).toBe(beforeAw);

      // "other" was released to salesB; once salesB sends it, the caller (S) still cannot record on it.
      await send('other', salesB);
      fails(await respondAs(S(), 'other', s.q.other.revision.id), 403, /not released to this Sales employee/);
      expect(await responseCount('other')).toBe(0);
      ok(await respondAs(salesB, 'other', s.q.other.revision.id, 'ACCEPTED'));
      expect(await responseCount('other')).toBe(1);
    });

    it('non-Sales roles stay 403 by role; another company is refused', async () => {
      fails(await respondAs(P(), 'aw', s.q.aw.revision.id), 403);
      fails(await respondAs(f.engineer, 'aw', s.q.aw.revision.id), 403);
      const r = await respondAs(foreignSales, 'aw', s.q.aw.revision.id);
      expect([400, 403]).toContain(r.status);
    });

    it('the assigned Sales employee records on the latest SENT revision (201) and the list reflects it', async () => {
      const before = await responseCount('aw');
      const rec = ok<{ response: { response_type: string; recorded_by_id: string } }>(
        await respondAs(S(), 'aw', s.q.aw.revision.id, 'TECHNICAL_QUERY'));
      expect(rec.response).toMatchObject({ response_type: 'TECHNICAL_QUERY', recorded_by_id: S() });
      expect(await responseCount('aw')).toBe(before + 1);
      const row = byQuote(await list(`search=${encodeURIComponent(s.q.aw.quote_number)}`))[s.q.aw.id];
      expect(row).toMatchObject({ sales_stage: 'IN_DISCUSSION', latest_response: { response_type: 'TECHNICAL_QUERY' } });
    });
  });
});
