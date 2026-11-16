import { Client } from 'pg';
import request from 'supertest';
import {
  api, balances, BASE, bridge, createItem, db, dbRejects, Fixtures, fails, forgedToken, ok, otherCompany, RUN, setupFixtures, tokenFor,
} from './helpers';

/**
 * One fresh job driven BR-02 -> BR-07 through the live API, asserting the
 * integrity rules at each stage. Tests run in order and share state `s`; if an
 * early stage breaks, later stages fail too (the first failure is the real one).
 *
 * Stock story for the one material line (fresh item => starts at 0):
 *   MR needs 8 -> shortage 8 -> supplier offers 10 -> GRN receives 10:
 *   8 accepted (MAIN), 1 rejected + 1 held (QUARANTINE) -> reserve 8 ->
 *   issue 8 (MAIN -> ENGINEER_HELD) -> consume 5, return 3 -> MAIN 3.
 */
describe('Job lifecycle integrity (BR-02 -> BR-07)', () => {
  let c: Client;
  let f: Fixtures;
  const s: Record<string, any> = {};

  const P = () => f.purchase;
  const E = () => f.engineer;

  beforeAll(async () => {
    c = await db();
    f = await setupFixtures(c);
    s.item = await createItem(f.purchase, true, 'flow-part');
    s.draftItem = await createItem(f.purchase, false, 'flow-unapproved');
    s.bridgeOk = await bridge(c, s.item, 'APPROVED');
    s.bridgePending = await bridge(c, s.draftItem, 'PENDING_APPROVAL');
  });
  afterAll(() => c?.end());

  // ============================================================== BR-02
  describe('BR-02 inward -> Job ID -> assignment', () => {
    it('rejects a caller-supplied JIN number', async () => {
      fails(await api('post', '/inward-receipts', P(), {
        customer_id: f.customerId, receipt_at: new Date().toISOString(), receipt_channel: 'WALK_IN', customer_dc_number: `DC-${RUN}`,
        jin_number: 'FAKE-0001',
      }), 400, /jin_number/);
    });

    it('creates JIN, adds a 2-unit group and expands it into 2 units', async () => {
      s.jin = ok(await api('post', '/inward-receipts', P(), {
        customer_id: f.customerId, receipt_at: new Date().toISOString(), receipt_channel: 'WALK_IN', customer_dc_number: `DC-${RUN}`,
        notes: `integrity ${RUN}`,
      }));
      const g = ok(await api('post', `/inward-receipts/${s.jin.id}/equipment-groups`, P(), {
        assembly_id: f.assemblyId, quantity_received: 2,
      }));
      const ex = ok(await api('post', `/equipment-groups/${g.id}/expand`, P(), {
        location_id: f.custodyLocationId, custodian_id: f.purchase,
      }));
      expect(ex.units).toHaveLength(2);
      [s.unit1, s.unit2] = ex.units.map((u: any) => u.id);
    });

    it('photo-before-verify: a unit without a photo cannot be verified', async () => {
      fails(await api('post', `/equipment-units/${s.unit1}/verify`, P()), 400, /photo/i);
      const jobs = await c.query(`SELECT count(*)::int n FROM service_jobs WHERE unit_id=$1`, [s.unit1]);
      expect(jobs.rows[0].n).toBe(0);
    });

    it('one Job ID per unit: verify allocates exactly one, re-verify is rejected', async () => {
      for (const u of [s.unit1, s.unit2]) {
        ok(await api('post', `/equipment-units/${u}/photos`, P(), { file_uri: `s3://it/${u}.jpg`, file_name: 'unit.jpg' }));
      }
      const v1 = ok(await api('post', `/equipment-units/${s.unit1}/verify`, P()));
      const v2 = ok(await api('post', `/equipment-units/${s.unit2}/verify`, P()));
      s.job = v1.job.id;
      s.job2 = v2.job.id; // never driven past BR-02: used for BR-08 negative/waiver cases
      expect(v1.job.unit_id).toBe(s.unit1);
      expect(v1.job.job_number).not.toBe(v2.job.job_number);

      fails(await api('post', `/equipment-units/${s.unit1}/verify`, P()), 400, /already verified/);
      const jobs = await c.query(`SELECT count(*)::int n FROM service_jobs WHERE unit_id=$1`, [s.unit1]);
      expect(jobs.rows[0].n).toBe(1);

      // DB layer too: a second Job ID for the same unit violates the schema.
      const msg = await dbRejects(c,
        `INSERT INTO service_jobs(company_id,inward_id,unit_id,job_number) VALUES ($1,$2,$3,$4)`,
        [f.companyId, s.jin.id, s.unit1, `DUP-${RUN}`]);
      expect(msg).toMatch(/unique|duplicate/i);
    });

    it('an ENGINEER cannot assign a job (403); PURCHASE can', async () => {
      fails(await api('post', `/jobs/${s.job}/assign`, E(), { engineer_id: f.engineer }), 403);
      const a = ok(await api('post', `/jobs/${s.job}/assign`, P(), { engineer_id: f.engineer }));
      expect(a.engineer_id).toBe(f.engineer);
    });

    it('role comes from the server, not the request (forged PURCHASE token is 401)', async () => {
      // A client-built token claiming PURCHASE for this company, signed with a key the server doesn't know.
      const forged = forgedToken({ sub: f.engineer, role: 'PURCHASE', company_id: f.companyId });
      fails(await api('post', `/jobs/${s.job}/assign`, undefined, { engineer_id: f.engineer },
        { Authorization: `Bearer ${forged}` }), 401);
    });
  });

  // ============================================================== BR-03
  describe('BR-03 custody -> inspection -> material request', () => {
    it('material request is blocked until Purchase accepts an inspection', async () => {
      ok(await api('post', `/jobs/${s.job}/custody-ack`, E(), { condition_note: 'ok' }));
      fails(await api('post', `/jobs/${s.job}/material-requests`, E(), { priority: 'NORMAL' }),
        400, /accepted inspection/i);
    });

    it('inspection session -> report -> Purchase ACCEPT', async () => {
      const sess = ok(await api('post', `/jobs/${s.job}/inspection-sessions`, E()));
      ok(await api('post', `/inspection-sessions/${sess.id}/stop`, E()));
      const rep = ok(await api('post', `/jobs/${s.job}/inspection-reports`, E()));
      fails(await api('post', `/inspection-reports/${rep.id}/submit`, E(), {
        inspection_description: 'no photo yet', outcome: 'REPAIR_REQUIRED',
      }), 400, /photo/i);
      ok(await api('post', `/inspection-reports/${rep.id}/media`, E(), {
        media_type: 'PHOTO', file_uri: `s3://it/insp-${RUN}.jpg`, file_name: 'insp.jpg',
      }));
      ok(await api('post', `/inspection-reports/${rep.id}/submit`, E(), {
        inspection_description: 'DC bus capacitor failed', outcome: 'REPAIR_REQUIRED',
      }));
      const rv = ok(await api('post', `/inspection-reports/${rep.id}/review`, P(), { decision: 'ACCEPT' }));
      expect(rv.version.version_status).toBe('ACCEPTED');
    });

    it('APPROVED items only: a PENDING_APPROVAL item line is rejected', async () => {
      s.mr = ok(await api('post', `/jobs/${s.job}/material-requests`, E(), { priority: 'NORMAL' })).id;
      fails(await api('post', `/material-requests/${s.mr}/lines`, E(), { item_bridge_id: s.bridgePending, quantity: 1 }),
        400, /Approved/);
      ok(await api('post', `/material-requests/${s.mr}/lines`, E(), { item_bridge_id: s.bridgeOk, quantity: 8 }));
    });

    it('no approval gate: submit lands directly in Purchase inbox as SUBMITTED', async () => {
      const sub = ok(await api('post', `/material-requests/${s.mr}/submit`, E()));
      expect(sub.status).toBe('SUBMITTED');
      const inbox = ok(await api('get', `/material-requests?status=SUBMITTED`, P()));
      expect(inbox.map((r: any) => r.id)).toContain(s.mr);
      // There is no approve endpoint to call.
      fails(await api('post', `/material-requests/${s.mr}/approve`, P()), 404);
    });

    it('edit-lock deadline = 1 WORKING hour after submit (working calendar)', async () => {
      const r = (await c.query(
        `SELECT self_edit_deadline_at, submitted_at,
                cal_add_working_minutes(company_id, submitted_at, 60) AS expected
           FROM br03_material_requests WHERE id=$1`, [s.mr])).rows[0];
      expect(r.self_edit_deadline_at).not.toBeNull();
      expect(r.self_edit_deadline_at.getTime()).toBe(r.expected.getTime());
      expect(r.self_edit_deadline_at.getTime()).toBeGreaterThan(r.submitted_at.getTime());
    });

    it('locks when Purchase starts processing: direct line edits blocked, change-request path works', async () => {
      ok(await api('post', `/material-requests/${s.mr}/start-processing`, P()));
      // Processing started => locked even though the 1-working-hour window is still open.
      fails(await api('post', `/material-requests/${s.mr}/lines`, E(), { item_bridge_id: s.bridgeOk, quantity: 1 }),
        400, /locked/i);
      const cr = ok(await api('post', `/material-requests/${s.mr}/change-requests`, E(), {
        change_reason: 'integrity test', proposed_change: { note: 'no-op' },
      }));
      const rv = ok(await api('post', `/material-requests/${s.mr}/change-requests/${cr.id}/review`, P(), {
        decision: 'REJECTED', comment: 'keep original',
      }));
      expect(rv.review_status).toBe('REJECTED');
      const mr = ok(await api('get', `/material-requests/${s.mr}`, P()));
      expect(mr.lines).toHaveLength(1);
      expect(Number(mr.lines[0].quantity)).toBe(8);
    });
  });

  // ============================================================== BR-04
  describe('BR-04 stock check -> RFQ -> quotation', () => {
    const SUPPLIER_PRICE = 123.45;

    it('stock check posts nothing and records the full shortage', async () => {
      const chk = ok(await api('post', `/jobs/${s.job}/stock-checks`, P(), { material_request_id: s.mr }));
      expect(Number(chk.lines[0].shortage_quantity)).toBe(8);
      const j = await c.query(`SELECT count(*)::int n FROM fdn_inventory_journal WHERE item_id=$1`, [s.item]);
      expect(j.rows[0].n).toBe(0);
    });

    it('RFQ + supplier offer, marked valid manually', async () => {
      const sh = ok(await api('get', `/jobs/${s.job}/shortages`, P()));
      const rfq = ok(await api('post', `/jobs/${s.job}/rfqs`, P(), {
        lines: [{ shortage_source_id: sh[0].id, technical_specification: '470uF 450V 105C' }],
      }));
      const inv = ok(await api('post', `/rfqs/${rfq.id}/supplier-invites`, P(), { supplier_name_snapshot: `IT Supplier ${RUN}` }));
      ok(await api('post', `/rfqs/${rfq.id}/offers`, P(), {
        supplier_invite_id: inv.id,
        lines: [{ rfq_line_id: rfq.lines[0].id, offered_quantity: 10, quoted_unit_price: SUPPLIER_PRICE }],
      }));
      const full = ok(await api('get', `/rfqs/${rfq.id}`, P()));
      s.offerLine = full.offers[0].lines[0].id;
      ok(await api('post', `/offer-lines/${s.offerLine}/mark-validity`, P(), { valid: true }));
    });

    it('manual price: total is exactly the typed prices, even below supplier cost', async () => {
      const q = ok(await api('post', `/jobs/${s.job}/quotes`, P(), {
        quote_type: 'ITEM', reference_offer_line_id: s.offerLine, procurement_offer_line_id: s.offerLine,
        lines: [
          { line_type: 'MATERIAL', line_description: 'Capacitor', quantity: 8, uom: 'NOS', net_unit_price_pre_tax: 100 },
          { line_type: 'REPAIR_SERVICE', line_description: 'Repair', quantity: 1, uom: 'NOS', net_unit_price_pre_tax: 1000 },
        ],
      }));
      s.quote = q.id;
      expect(Number(q.revision.original_authorised_pre_tax)).toBe(1800);
      expect(Number(q.revision.revised_pre_tax)).toBe(1800);
      expect(Number(q.lines[0].net_unit_price_pre_tax)).toBe(100); // < 123.45 supplier cost: no markup formula
    });

    it('supplier cost never appears in the quote response (Purchase or Sales view)', async () => {
      for (const actor of [P(), f.sales]) {
        const body = JSON.stringify(ok(await api('get', `/quotes/${s.quote}`, actor)));
        expect(body).not.toContain(String(SUPPLIER_PRICE));
        expect(body).not.toMatch(/quoted_unit_price|supplier_name|unit_price"/);
      }
    });

    it('SALES cannot create or revise a price (403)', async () => {
      const lines = [{ line_type: 'REPAIR_SERVICE', line_description: 'x', quantity: 1, uom: 'NOS', net_unit_price_pre_tax: 1 }];
      fails(await api('post', `/quotes/${s.quote}/revise`, f.sales, { revision_reason: 'sales edit', lines }), 403);
      fails(await api('post', `/jobs/${s.job}/quotes`, f.sales, { quote_type: 'ITEM', lines }), 403);
    });

    const revLines = (repair: number) => [
      { line_type: 'MATERIAL', line_description: 'Capacitor', quantity: 8, uom: 'NOS', net_unit_price_pre_tax: 100 },
      { line_type: 'REPAIR_SERVICE', line_description: 'Repair', quantity: 1, uom: 'NOS', net_unit_price_pre_tax: repair },
    ];

    it('<=10% discount needs no extra approval', async () => {
      const r = ok(await api('post', `/quotes/${s.quote}/revise`, P(), { revision_reason: '5% off', lines: revLines(910) }));
      expect(Number(r.revision.revised_pre_tax)).toBe(1710);
    });

    it('>10% discount is blocked without an explicit approver + reason', async () => {
      fails(await api('post', `/quotes/${s.quote}/revise`, P(), { revision_reason: '50% off', lines: revLines(100) }),
        400, /10%/);
      fails(await api('post', `/quotes/${s.quote}/revise`, P(), {
        revision_reason: '50% off', lines: revLines(100), higher_discount_approved_by_id: f.purchase2,
      }), 400, /higher_discount_reason/);
    });

    it('>10% discount succeeds with explicit approver + reason, recorded on the revision', async () => {
      const r = ok(await api('post', `/quotes/${s.quote}/revise`, P(), {
        revision_reason: '50% off', lines: revLines(100),
        higher_discount_approved_by_id: f.purchase2, higher_discount_reason: 'key account',
      }));
      expect(Number(r.revision.revised_pre_tax)).toBe(900);
      expect(r.revision.higher_discount_approved_by_id).toBe(f.purchase2);
      expect(r.revision.higher_discount_approved_at).toBeTruthy();
      s.quoteRevision = r.revision.id;
    });
  });

  // ============================================================== BR-05
  describe('BR-05 customer authority -> authorisation -> release', () => {
    it('email authorisation is first-class (needs sender + received time, no PO ref)', async () => {
      fails(await api('post', `/jobs/${s.job}/customer-authority`, P(), { authority_type: 'EMAIL_AUTHORISATION' }),
        400, /customer_email_sender/);
      const o = ok(await api('post', `/jobs/${s.job}/customer-authority`, P(), {
        authority_type: 'EMAIL_AUTHORISATION', customer_email_sender: 'buyer@example.com',
        customer_email_received_at: new Date().toISOString(),
      }));
      expect(o.order_type).toBe('EMAIL_AUTHORISATION');
      expect(o.customer_order_ref).toBeNull();
      s.order = o.id;
      ok(await api('post', `/customer-authority/${s.order}/verify`, P(), {}));
    });

    // Since the 16 Nov 2026 server-side guard, a customer response (and so an allocation + authorisation) cannot exist
    // for a revision that was never sent: the API rejects the response itself, before any BR-05 ref is created.
    it('cannot record a customer response (so cannot authorise) against a quote that was never sent', async () => {
      fails(await api('post', `/jobs/${s.job}/quote-responses`, f.sales, {
        br04_quote_revision_id: s.quoteRevision, response_type: 'ACCEPTED', response_channel: 'EMAIL',
      }), 400, /not been sent/);
      expect(ok(await api('get', `/jobs/${s.job}/quote-responses`, f.sales))).toHaveLength(0);
      expect(ok(await api('get', `/jobs/${s.job}/authorisations`, P()))).toHaveLength(0);
    });

    it('after release-to-sales + send, the email authority authorises the job', async () => {
      fails(await api('post', `/quotes/${s.quote}/send`, f.sales), 400, /released to Sales/);
      ok(await api('post', `/quotes/${s.quote}/release-to-sales`, P(), { assigned_sales_id: f.sales }));
      ok(await api('post', `/quotes/${s.quote}/send`, f.sales));
      const resp = ok(await api('post', `/jobs/${s.job}/quote-responses`, f.sales, {
        br04_quote_revision_id: s.quoteRevision, response_type: 'ACCEPTED', response_channel: 'EMAIL',
      }));
      s.quoteRef = resp.quote_revision_ref_id;
      const alloc = ok(await api('post', `/jobs/${s.job}/order-allocations`, P(), {
        order_id: s.order, quote_revision_ref_id: s.quoteRef, allocated_pre_tax: 900,
      }));
      s.alloc = alloc.id;
      ok(await api('post', `/order-allocations/${s.alloc}/verify`, P()));
      const a = ok(await api('post', `/jobs/${s.job}/authorisations`, P(), { order_job_allocation_id: s.alloc }));
      expect(a.authorisation_kind).toBe('EMAIL_AUTHORISATION');
    });

    it('quote-response + allocation reads name the BR-04 revision behind the BR-05 ref', async () => {
      const quote = ok(await api('get', `/quotes/${s.quote}`, P()));
      const rev = quote.revisions.find((r: any) => r.id === s.quoteRevision);
      const expected = {
        source_br04_quote_revision_id: s.quoteRevision, quote_id: s.quote,
        quote_number: quote.quote_number, revision_no: rev.revision_no,
      };
      const resp = ok(await api('get', `/jobs/${s.job}/quote-responses`, f.sales))
        .find((r: any) => r.quote_revision_id === s.quoteRef);
      expect(resp).toMatchObject(expected);
      const alloc = ok(await api('get', `/jobs/${s.job}/order-allocations`, P())).find((a: any) => a.id === s.alloc);
      expect(alloc).toMatchObject({ ...expected, accepted_quote_revision_id: s.quoteRef });
    });

    it('quote detail shows the Sales person each revision was released to (null before release)', async () => {
      const quote = ok(await api('get', `/quotes/${s.quote}`, P()));
      const released = quote.revisions.find((r: any) => r.id === s.quoteRevision);
      expect(released.assigned_sales_id).toBe(f.sales);
      expect(released.released_to_sales_by_id).toBe(f.purchase);
      expect(released.released_to_sales_at).toBeTruthy();
      for (const r of quote.revisions.filter((x: any) => x.id !== s.quoteRevision)) {
        expect(r).toMatchObject({ assigned_sales_id: null, released_to_sales_by_id: null, released_to_sales_at: null });
      }
    });

    it('stock recheck + job release', async () => {
      const rc = ok(await api('post', `/jobs/${s.job}/stock-rechecks`, P(), { material_request_id: s.mr }));
      s.recheckLine = rc.lines[0].id;
      ok(await api('post', `/jobs/${s.job}/release`, P(), { release_notes: 'integrity' }));
    });
  });

  // ============================================================== BR-06
  describe('BR-06 PO -> GRN -> stock', () => {
    it('PO released, acknowledged; GRN of 10 created by Stores', async () => {
      const po = ok(await api('post', `/jobs/${s.job}/purchase-orders`, P(), { offer_line_ids: [s.offerLine] }));
      ok(await api('post', `/purchase-orders/${po.id}/release`, P()));
      ok(await api('post', `/purchase-orders/${po.id}/acknowledge`, P(), { supplier_reference: `SO-${RUN}` }));
      fails(await api('post', `/purchase-orders/${po.id}/grns`, P(), { lines: [] }), 403); // Purchase isn't Stores
      const grn = ok(await api('post', `/purchase-orders/${po.id}/grns`, f.stores, {
        lines: [{ po_line_id: po.lines[0].id, received_quantity: 10 }],
      }));
      s.grnLine = grn.lines[0].id;
      s.po = po.id;
      s.poLine = po.lines[0].id;
      s.poOrdered = Number(po.lines[0].quantity);
      // A GRN that is only counted (not yet posted) does not move the PO.
      expect(ok(await api('get', `/purchase-orders/${po.id}`, P())).po_status).toBe('ACKNOWLEDGED');
    });

    it('photo-per-line gate: cannot post a GRN line without a photo', async () => {
      fails(await api('post', `/grn-lines/${s.grnLine}/post`, f.stores, {
        accepted_quantity: 8, rejected_quantity: 1, held_quantity: 1,
      }), 400, /photo/i);
      expect((await balances(f.companyId, s.item, P())).main).toBe(0);
    });

    it('disposition cannot exceed the received quantity', async () => {
      ok(await api('post', `/grn-lines/${s.grnLine}/media`, f.stores, { file_uri: `s3://it/grn-${RUN}.jpg`, file_name: 'grn.jpg' }));
      fails(await api('post', `/grn-lines/${s.grnLine}/post`, f.stores, {
        accepted_quantity: 9, rejected_quantity: 1, held_quantity: 1,
      }), 400, /exceed/);
    });

    it('8-of-10: only accepted qty reaches MAIN_STORE; rejected + held go to QUARANTINE', async () => {
      ok(await api('post', `/grn-lines/${s.grnLine}/post`, f.stores, {
        accepted_quantity: 8, rejected_quantity: 1, held_quantity: 1,
      }));
      const b = await balances(f.companyId, s.item, P());
      expect(b).toMatchObject({ main: 8, quarantine: 2, allocatable: 8 });
      fails(await api('post', `/grn-lines/${s.grnLine}/post`, f.stores, {
        accepted_quantity: 8, rejected_quantity: 1, held_quantity: 1,
      }), 400, /already posted/);
      expect((await balances(f.companyId, s.item, P())).main).toBe(8);
    });

    it('PO -> RECEIVED once every line’s posted qty (accepted + rejected + held) covers the order', async () => {
      // 8 accepted + 1 rejected + 1 held = 10 posted against the ordered quantity.
      expect(s.poOrdered).toBeLessThanOrEqual(10);
      const po = ok(await api('get', `/purchase-orders/${s.po}`, P()));
      expect(po.po_status).toBe('RECEIVED');
      const audit = await c.query(
        `SELECT before_state->>'po_status' AS was, after_state->>'po_status' AS now
           FROM activity_audit_log WHERE entity_id=$1 AND action='BR06_PO_RECEIVED'`, [s.po],
      );
      expect(audit.rows).toEqual([{ was: 'ACKNOWLEDGED', now: 'RECEIVED' }]);
      // A fully received PO takes no further GRN.
      fails(await api('post', `/purchase-orders/${s.po}/grns`, f.stores, {
        lines: [{ po_line_id: s.poLine, received_quantity: 1 }],
      }), 400, /ACKNOWLEDGED or SHIPPED/);
    });
  });

  // ============================================================== BR-05 reservation
  describe('BR-05 reservation against the ledger', () => {
    it('reservation is capped by the release snapshot (pre-GRN snapshot saw 0)', async () => {
      fails(await api('post', `/jobs/${s.job}/reservations`, P(), {
        stock_recheck_line_id: s.recheckLine, reserved_quantity: 8,
      }), 400, /exceeds snapshot availability/);
    });

    it('post-GRN: re-authorise -> recheck -> release', async () => {
      // One release per authorisation (unique), and a reservation must use the
      // release's own recheck -- same sequence as the manual run.
      ok(await api('post', `/jobs/${s.job}/authorisations`, P(), { order_job_allocation_id: s.alloc }));
      s.recheck = ok(await api('post', `/jobs/${s.job}/stock-rechecks`, P(), { material_request_id: s.mr })).lines[0];
      s.recheckLine = s.recheck.id;
      ok(await api('post', `/jobs/${s.job}/release`, P(), { release_notes: 'post-GRN' }));
    });

    it('snapshot (MAIN=8, QUARANTINE=2): physical 10, quarantined 2, reserved 0, available 8', () => {
      // Quarantine is a hold INSIDE store physical in the snapshot schema, so it is
      // counted in physical and subtracted exactly once -> never available.
      expect(Number(s.recheck.store_physical_quantity)).toBe(10);
      expect(Number(s.recheck.quarantined_store_quantity)).toBe(2);
      expect(Number(s.recheck.reserved_store_quantity)).toBe(0);
      expect(Number(s.recheck.available_store_quantity)).toBe(8);
      expect(Number(s.recheck.shortage_quantity)).toBe(0);
    });

    it('reservation of 8 succeeds; quarantined 2 stays non-allocatable', async () => {
      const r = ok(await api('post', `/jobs/${s.job}/reservations`, P(), {
        stock_recheck_line_id: s.recheckLine, reserved_quantity: 8,
      }));
      expect(r.reservation_status).toBe('COMMITTED');
      s.reservation = r.id;
      const b = await balances(f.companyId, s.item, P());
      expect(b).toMatchObject({ main: 8, quarantine: 2, allocatable: 0 }); // on-hand unchanged

      // The 2 quarantined units cannot be reserved: not via the snapshot (requirement
      // already met) and not via the ledger (allocatable counts MAIN_STORE only).
      fails(await api('post', `/jobs/${s.job}/reservations`, P(), {
        stock_recheck_line_id: s.recheckLine, reserved_quantity: 1,
      }), 400, /exceeds snapshot availability/);
      fails(await api('post', '/inventory/reservations', P(), {
        company_id: f.companyId, item_id: s.item, uom: 'NOS', qty: 1, reference_id: s.reservation,
      }, { 'Idempotency-Key': `it-${RUN}-quarantine-probe` }), 409, /INSUFFICIENT_STOCK/);
    });
  });

  // ============================================================== BR-07
  describe('BR-07 issue -> repair -> test -> handoff -> dispatch release', () => {
    it('issuing reserved stock does not double-count allocatable', async () => {
      const iss = ok(await api('post', `/jobs/${s.job}/material-issues`, P(), { br05_material_reservation_id: s.reservation }));
      expect(iss.issue_status).toBe('ISSUED');
      expect(iss.ledger_reservation_status).toBe('CONSUMED');
      s.issue = iss.id;
      const b = await balances(f.companyId, s.item, P());
      // MAIN 8 -> 0 and allocatable stays 0 (would be -8 if the reservation were double-counted).
      expect(b).toMatchObject({ main: 0, held: 8, quarantine: 2, allocatable: 0 });
      fails(await api('post', `/jobs/${s.job}/material-issues`, P(), { br05_material_reservation_id: s.reservation }),
        400, /already been issued/);

      // CHECK regression: QUARANTINE (2) > MAIN_STORE (0) used to violate
      // reserved+quarantined <= store_physical and 400 the whole recheck.
      const rc = ok(await api('post', `/jobs/${s.job}/stock-rechecks`, P(), { material_request_id: s.mr })).lines[0];
      expect(Number(rc.store_physical_quantity)).toBe(2);
      expect(Number(rc.quarantined_store_quantity)).toBe(2);
      expect(Number(rc.reserved_store_quantity)).toBe(0);
      expect(Number(rc.available_store_quantity)).toBe(0);
    });

    it('consume 5 + verified return 3 balances exactly', async () => {
      ok(await api('post', `/material-issues/${s.issue}/acknowledge`, E(), {}));
      const con = ok(await api('post', `/material-issues/${s.issue}/consumptions`, E(), { quantity: 5 }));
      ok(await api('post', `/material-consumptions/${con.id}/post`, E()));
      fails(await api('post', `/material-issues/${s.issue}/returns`, E(), { quantity: 4 }), 400, /exceeds/);
      const ret = ok(await api('post', `/material-issues/${s.issue}/returns`, E(), { quantity: 3 }));
      fails(await api('post', `/material-returns/${ret.id}/verify`, E(), { decision: 'VERIFY' }), 403);
      ok(await api('post', `/material-returns/${ret.id}/verify`, P(), { decision: 'VERIFY' }));

      const b = await balances(f.companyId, s.item, P());
      expect(b).toMatchObject({ main: 3, held: 0, consumed: 5, quarantine: 2, allocatable: 3 });
      expect(b.main + b.held + b.consumed).toBe(8); // all 8 accepted units accounted for
    });

    it('GET /jobs/:id/material-requests: per-job read with each line live fulfilment', async () => {
      fails(await api('get', `/jobs/${s.job}/material-requests`, E()), 403);
      const mrs = ok(await api('get', `/jobs/${s.job}/material-requests`, P()));
      expect(mrs.map((m: any) => m.id)).toContain(s.mr);
      const mr = mrs.find((m: any) => m.id === s.mr);
      expect(Array.isArray(mr.change_requests)).toBe(true);
      expect(mr.lines.length).toBeGreaterThan(0);
      const line = mr.lines[0];
      expect(line.item_code).toBeTruthy();
      expect(line.item_name).toBeTruthy();
      // reserved 8 -> issued 8 -> consumed 5 + verified return 3; ledger allocatable back to 3 (MAIN 3, no reservation)
      expect(line.fulfilment).toEqual({
        allocatable_now: 3, reserved_quantity: 8, issued_quantity: 8, consumed_quantity: 5, returned_quantity: 3,
      });
    });

    const startCycle = async () =>
      ok(await api('post', `/jobs/${s.job}/test-runs`, E(), { test_procedure: 'Load test 2h @ rated current' })).id;
    const result = (id: string, r: 'PASS' | 'FAIL', actor = E()) =>
      api('post', `/test-runs/${id}/result`, actor, { result: r, observations: `integrity ${r}` });

    it('repair session + report opens the test-start SLA with a calendar-computed due_at', async () => {
      const rs = ok(await api('post', `/jobs/${s.job}/repair-sessions`, E()));
      ok(await api('post', `/repair-sessions/${rs.id}/stop`, E()));
      const rep = ok(await api('post', `/jobs/${s.job}/repair-report`, E(), { work_performed: 'Replaced DC bus caps' }));
      expect(rep.test_sla.due_at).toBeTruthy();
      expect(rep.test_sla.due_at_reason).toBeNull();
      // NORMAL priority = 1 WORKING_DAY = same clock time on the next working day.
      const r = (await c.query(
        `SELECT due_at, cal_add_working_days(company_id, started_at, 1) AS expected FROM sla_instances WHERE id=$1`,
        [rep.test_sla.sla_instance_id])).rows[0];
      expect(r.due_at.getTime()).toBe(r.expected.getTime());
    });

    it('engineer cannot turn a FAIL into a PASS (API and DB)', async () => {
      const first = ok(await api('post', `/jobs/${s.job}/test-runs`, E(), { test_procedure: 'Load test 2h @ rated current' }));
      s.t1 = first.id;
      // Test started well before due_at => the SLA closes as MET (no longer UNDETERMINED).
      expect(first.test_sla.state).toBe('MET');
      expect(first.test_sla.outcome).toBe('MET');
      fails(await result(s.t1, 'PASS', P()), 403); // Purchase can't record results either
      ok(await result(s.t1, 'FAIL'));
      fails(await result(s.t1, 'PASS'), 400, /immutable/);
      const msg = await dbRejects(c, `UPDATE br07_test_runs SET result='PASS' WHERE id=$1`, [s.t1]);
      expect(msg).toMatch(/immutable/);
    });

    it('handoff is blocked while the latest cycle is a FAIL', async () => {
      fails(await api('post', `/jobs/${s.job}/technical-handoff`, E(), {}), 400, /PASS/);
    });

    it('2-fail gate: a third cycle needs a Purchase review first', async () => {
      const t2 = await startCycle();
      const r2 = ok(await result(t2, 'FAIL'));
      expect(r2.failed_cycles).toBe(2);
      expect(r2.purchase_review_required).toBe(true);

      fails(await api('post', `/jobs/${s.job}/test-runs`, E(), { test_procedure: 'retry' }), 400, /Purchase review/);
      fails(await api('post', `/jobs/${s.job}/test-failure-reviews`, E(), { decision: 'CONTINUE', comment: 'x' }), 403);
      ok(await api('post', `/jobs/${s.job}/test-failure-reviews`, P(), { decision: 'CONTINUE', comment: 'retest after rework' }));

      s.t3 = await startCycle();
      ok(await result(s.t3, 'PASS'));
    });

    it('handoff needs the LATEST cycle to be PASS (an earlier PASS is not enough)', async () => {
      const t4 = await startCycle();
      ok(await result(t4, 'FAIL'));
      fails(await api('post', `/jobs/${s.job}/technical-handoff`, E(), {}), 400, /PASS/);

      // DB layer: pointing a handoff at the older PASS (cycle 3) is rejected too.
      const msg = await dbRejects(c,
        `INSERT INTO br07_technical_handoffs(company_id,job_id,test_run_id,engineer_id) VALUES ($1,$2,$3,$4)`,
        [f.companyId, s.job, s.t3, f.engineer]);
      expect(msg).toMatch(/no longer current|later test cycle/);
    });

    it('after review + a new PASS: handoff and dispatch release succeed once', async () => {
      fails(await api('post', `/jobs/${s.job}/test-runs`, E(), { test_procedure: 'retry' }), 400, /Purchase review/);
      ok(await api('post', `/jobs/${s.job}/test-failure-reviews`, P(), { decision: 'CONTINUE', comment: 'one more' }));
      const t5 = await startCycle();
      ok(await result(t5, 'PASS'));

      fails(await api('post', `/jobs/${s.job}/dispatch-release`, E(), {}), 403);
      const h = ok(await api('post', `/jobs/${s.job}/technical-handoff`, E(), { note: 'ready' }));
      expect(h.test_run_id).toBe(t5);
      ok(await api('post', `/jobs/${s.job}/dispatch-release`, P(), { note: 'release' }));
      fails(await api('post', `/jobs/${s.job}/dispatch-release`, P(), {}), 400, /already dispatch-released/);
    });
  });

  // ============================================================== BR-08
  describe('BR-08 dispatch -> challan -> invoice -> payment -> closure', () => {
    const F = () => f.finance;
    let fy: string;    // e.g. 2026-27
    let short: string; // e.g. 26-27
    let today: string; // company-local date, YYYY-MM-DD

    beforeAll(async () => {
      const r = (await c.query(
        `SELECT br08_fiscal_year(br08_local_today($1)) AS fy, to_char(br08_local_today($1),'YYYY-MM-DD') AS today`,
        [f.companyId])).rows[0];
      fy = r.fy; today = r.today; short = `${fy.slice(2, 4)}-${fy.slice(5, 7)}`;
    });

    it('company invoicing profile: SYSTEM_ADMIN only; BLR prefix BIAPL / Karnataka from config', async () => {
      fails(await api('put', '/br08/entity-profile', F(), { registered_address: 'x' }), 403);
      const prof = ok(await api('get', '/br08/entity-profile', F()));
      expect(prof).toMatchObject({ doc_prefix: 'BIAPL', state_code: '29', legal_name: 'Brightech Industrial Automation Pvt Ltd' });
      // Staging has no real GSTIN/bank yet: fill ONLY the missing fields (never overwrite a configured profile).
      const patch: Record<string, string> = {};
      if (!prof.gstin) patch.gstin = '29AAACB0000B1Z5';
      if (!prof.registered_address) patch.registered_address = 'IT staging address, Bengaluru';
      if (!prof.bank_name) patch.bank_name = 'IT Staging Bank';
      if (!prof.bank_account_no) patch.bank_account_no = '000111222333';
      if (!prof.bank_ifsc) patch.bank_ifsc = 'HDFC0000001';
      if (Object.keys(patch).length) ok(await api('put', '/br08/entity-profile', f.admin, patch));
    });

    const batchBody = (jobs: string[]) => ({
      customer_id: f.customerId, carrier_name: 'IT Carrier', destination_address: 'IT customer site', job_ids: jobs,
    });

    it('dispatch batch: PURCHASE only, and only BR-07 dispatch-released jobs', async () => {
      fails(await api('post', '/dispatch-batches', F(), batchBody([s.job])), 403);
      fails(await api('post', '/dispatch-batches', P(), batchBody([s.job2])), 400, /dispatch release/);
      const b = ok(await api('post', '/dispatch-batches', P(), batchBody([s.job])));
      expect(b.batch_status).toBe('DRAFT');
      s.batch = b.id;
    });

    it('a tax invoice cannot precede dispatch', async () => {
      fails(await api('post', '/invoices', F(), { job_ids: [s.job] }), 400, /at-or-after dispatch/);
    });

    it('dispatch issues a Job Work challan <seq>/BIAPL/NA/<FY> and posts nothing to the stock ledger', async () => {
      const journal = async () => (await c.query(
        `SELECT count(*)::int n FROM fdn_inventory_journal WHERE company_id=$1`, [f.companyId])).rows[0].n;
      const before = await journal();
      const d = ok(await api('post', `/dispatch-batches/${s.batch}/dispatch`, P(), { carrier_reference: `AWB-${RUN}` }));
      expect(d.delivery_challan.challan_number).toMatch(new RegExp(`^\\d+/BIAPL/NA/${fy}$`));
      expect(d.delivery_challan.challan_type).toBe('JOB_WORK');
      expect(d.delivery_challan.lines_snapshot).toHaveLength(1);
      expect(d.batch.batch_status).toBe('DISPATCHED');
      s.challan = d.delivery_challan;
      expect(await journal()).toBe(before); // customer-owned equipment: no ledger movement

      fails(await api('post', `/dispatch-batches/${s.batch}/dispatch`, P(), {}), 400, /already dispatched/);
      expect(await dbRejects(c, `UPDATE br08_delivery_challans SET challan_number='X' WHERE id=$1`, [s.challan.id]))
        .toMatch(/append_only/);
    });

    it('GST is server-derived from place of supply: KA -> CGST 9% + SGST 9%, TN -> IGST 18%', async () => {
      const intra = ok(await api('post', '/invoices/preview', F(), { job_ids: [s.job] }));
      expect(intra.tax_regime).toBe('INTRA_STATE');
      expect(intra.place_of_supply).toMatchObject({ state_code: '29', state_name: 'Karnataka' });
      // Authorised quote 8 x 100 + 1 x 100 = Rs 900.00 -> 9% + 9%.
      expect(intra).toMatchObject({ sub_total_paise: 90000, cgst_paise: 8100, sgst_paise: 8100, igst_paise: 0, total_paise: 106200 });
      expect(intra.invoice_number).toBeNull();
      for (const l of intra.lines) {
        expect(l.hsn_sac).toBe('998732');
        expect([Number(l.cgst_rate), Number(l.sgst_rate), Number(l.igst_rate)]).toEqual([9, 9, 0]);
      }

      await c.query(`UPDATE customers SET gstin='33AAACI1234A1Z5', state_code='33' WHERE id=$1`, [f.customerId]);
      try {
        const inter = ok(await api('post', '/invoices/preview', F(), { job_ids: [s.job] }));
        expect(inter.tax_regime).toBe('INTER_STATE');
        expect(inter.place_of_supply).toMatchObject({ state_code: '33', state_name: 'Tamil Nadu' });
        expect(inter).toMatchObject({ sub_total_paise: 90000, cgst_paise: 0, sgst_paise: 0, igst_paise: 16200, total_paise: 106200 });
        for (const l of inter.lines) expect([Number(l.cgst_rate), Number(l.sgst_rate), Number(l.igst_rate)]).toEqual([0, 0, 18]);
      } finally {
        await c.query(`UPDATE customers SET gstin='29AAACI1234A1Z5', state_code='29' WHERE id=$1`, [f.customerId]);
      }

      // The client can never choose the tax type or amounts.
      fails(await api('post', '/invoices/preview', F(), { job_ids: [s.job], tax_regime: 'INTER_STATE' }), 400, /tax_regime/);
      fails(await api('post', '/invoices', F(), { job_ids: [s.job], igst_paise: 0 }), 400, /igst_paise/);
    });

    it('invoice blocked until customer AND assembly are both APPROVED (D6)', async () => {
      await c.query(`UPDATE customers SET status='PENDING_APPROVAL' WHERE id=$1`, [f.customerId]);
      try {
        fails(await api('post', '/invoices', F(), { job_ids: [s.job] }), 400, /D6/);
      } finally {
        await c.query(`UPDATE customers SET status='APPROVED' WHERE id=$1`, [f.customerId]);
      }
      await c.query(`UPDATE assemblies SET status='PENDING_APPROVAL' WHERE id=$1`, [f.assemblyId]);
      try {
        fails(await api('post', '/invoices', F(), { job_ids: [s.job] }), 400, /D6/);
      } finally {
        await c.query(`UPDATE assemblies SET status='APPROVED' WHERE id=$1`, [f.assemblyId]);
      }
      expect(ok(await api('get', `/jobs/${s.job}/billing`, F())).invoice_id).toBeNull();
    });

    it('only FINANCE issues invoices (PURCHASE/SALES 403; DB rejects a non-Finance issuer)', async () => {
      fails(await api('post', '/invoices', P(), { job_ids: [s.job] }), 403);
      fails(await api('post', '/invoices', f.sales, { job_ids: [s.job] }), 403);
      const msg = await dbRejects(c, `SELECT br08_issue_invoice($1,$2,ARRAY[$3]::uuid[],NULL)`, [f.companyId, f.purchase, s.job]);
      expect(msg).toMatch(/only Finance/);
    });

    it('issues BIAPL/<next seq>/<FY>; due date = invoice date + customer credit days; 3 print copies', async () => {
      const prev = (await c.query(
        `SELECT last_value FROM br08_fy_counters WHERE company_id=$1 AND doc_kind='INV' AND fiscal_year=$2`,
        [f.companyId, fy])).rows[0]?.last_value ?? '0';
      const inv = ok(await api('post', '/invoices', F(), { job_ids: [s.job] }));
      expect(inv.invoice_number).toBe(`BIAPL/${Number(prev) + 1}/${short}`);
      expect(inv).toMatchObject({
        fiscal_year: fy, tax_regime: 'INTRA_STATE', invoice_status: 'ISSUED', credit_days: 30,
        sub_total_paise: '90000', cgst_paise: '8100', sgst_paise: '8100', igst_paise: '0', total_paise: '106200',
        balance_paise: '106200', supplier_state_code: '29', place_of_supply_state_code: '29',
        customer_gstin: '29AAACI1234A1Z5', total_in_words: 'Rupees One Thousand Sixty Two Only',
      });
      const gap = (await c.query(`SELECT due_date - invoice_date AS d FROM br08_invoices WHERE id=$1`, [inv.id])).rows[0].d;
      expect(gap).toBe(30);
      expect(inv.lines).toHaveLength(2);
      expect(inv.jobs[0].challan_number).toBe(s.challan.challan_number);
      s.invoice = inv;

      fails(await api('post', '/invoices', F(), { job_ids: [s.job] }), 400, /already on a live invoice/);
      const print = ok(await api('get', `/invoices/${inv.id}/print`, f.sales));
      expect(print.copies).toEqual(['ORIGINAL', 'DUPLICATE', 'TRIPLICATE']);
      expect(print.document.invoice_number).toBe(inv.invoice_number);
    });

    it('numbering is per company AND per FY (DB function; rolled back)', async () => {
      const zzb = await otherCompany(c);
      await c.query('BEGIN');
      try {
        await c.query(`UPDATE legal_entities SET doc_prefix='ZZBIT' WHERE id=$1`, [zzb]);
        const n = async (co: string, kind: string, d: string) =>
          (await c.query(`SELECT (br08_next_doc_number($1,$2,$3::date)).doc_number AS n`, [co, kind, d])).rows[0].n;
        // Company B has its own series, starting at 1, regardless of BLR's count.
        expect(await n(zzb, 'INV', '2026-11-05')).toBe('ZZBIT/1/26-27');
        expect(await n(zzb, 'INV', '2026-11-05')).toBe('ZZBIT/2/26-27');
        // A new financial year (from 1 April) restarts the series.
        expect(await n(zzb, 'INV', '2027-04-01')).toBe('ZZBIT/1/27-28');
        expect(await n(f.companyId, 'INV', '2027-04-01')).toBe('BIAPL/1/27-28');
        expect(await n(f.companyId, 'DC', '2027-04-01')).toBe('1/BIAPL/NA/2027-28');
        expect(await n(f.companyId, 'CN', '2027-04-01')).toBe('CN/BIAPL/1/27-28');
        // 31 March still belongs to the old FY.
        expect(await n(zzb, 'INV', '2027-03-31')).toBe('ZZBIT/3/26-27');
      } finally {
        await c.query('ROLLBACK');
      }
    });

    it('an issued invoice is immutable (no edit route; DB rejects UPDATE / DELETE / late lines)', async () => {
      const id = s.invoice.id;
      expect(await dbRejects(c, `UPDATE br08_invoices SET total_paise=1 WHERE id=$1`, [id])).toMatch(/immutable/);
      expect(await dbRejects(c, `UPDATE br08_invoices SET customer_name='x' WHERE id=$1`, [id])).toMatch(/immutable/);
      expect(await dbRejects(c,
        `UPDATE br08_invoices SET invoice_status='PAID', amount_paid_paise=total_paise WHERE id=$1`, [id]))
        .toMatch(/maintained only by payment allocations/);
      expect(await dbRejects(c, `UPDATE br08_invoice_lines SET unit_price=1 WHERE invoice_id=$1`, [id])).toMatch(/append_only/);
      expect(await dbRejects(c, `DELETE FROM br08_invoices WHERE id=$1`, [id])).toMatch(/append_only/);
      expect(await dbRejects(c,
        `INSERT INTO br08_invoice_lines(invoice_id,line_no,job_id,source_quote_line_id,line_type,description,hsn_sac,
           quantity,uom,unit_price,taxable_paise,cgst_rate,sgst_rate,igst_rate,cgst_paise,sgst_paise,igst_paise,line_total_paise)
         VALUES ($1,99,$2,$3,'OTHER','late line','998732',1,'NOS',1,100,9,9,0,9,9,0,118)`,
        [id, s.job, s.invoice.lines[0].source_quote_line_id])).toMatch(/immutable/);
      fails(await api('put', `/invoices/${id}`, F(), { total_paise: 1 }), 404);
    });

    it('credit note: FINANCE only; a warranty credit note needs proof of delivery first', async () => {
      const cn = { reason_code: 'WARRANTY_FAILURE', reason: 'failed in field', failed_job_id: s.job };
      fails(await api('post', `/invoices/${s.invoice.id}/credit-note`, P(), cn), 403);
      fails(await api('post', `/invoices/${s.invoice.id}/credit-note`, f.sales, cn), 403);
      fails(await api('post', `/invoices/${s.invoice.id}/credit-note`, F(), cn), 400, /proof of delivery/);
    });

    it('proof of delivery: PURCHASE only', async () => {
      // A time between dispatch and DB now() (avoids test-machine clock skew).
      const at = (await c.query(
        `SELECT dispatched_at + (now() - dispatched_at) / 2 AS t FROM br08_dispatch_batches WHERE id=$1`, [s.batch])).rows[0].t;
      const body = { received_by_name: 'Customer stores', received_at: at.toISOString() };
      fails(await api('post', `/dispatch-batches/${s.batch}/proof-of-delivery`, F(), body), 403);
      const pod = ok(await api('post', `/dispatch-batches/${s.batch}/proof-of-delivery`, P(), body));
      expect(pod.delivered_on).toBeTruthy();
      fails(await api('post', `/dispatch-batches/${s.batch}/proof-of-delivery`, P(), body), 400, /unique|duplicate/i);
    });

    it('partial payment keeps the job open; the balance-clearing payment closes it (FINANCE only)', async () => {
      const pay = (actor: string, amount: number, alloc?: number) => api('post', '/payments', actor, {
        customer_id: f.customerId, amount_paise: amount, received_on: today, payment_mode: 'NEFT',
        payment_reference: `UTR-${RUN}-${amount}`,
        allocations: alloc ? [{ invoice_id: s.invoice.id, amount_paise: alloc }] : [],
      });
      const jobStatus = async () => (await c.query(`SELECT status, closed_at FROM service_jobs WHERE id=$1`, [s.job])).rows[0];

      fails(await pay(f.sales, 1000, 1000), 403);
      fails(await pay(P(), 1000, 1000), 403);

      const r1 = ok(await pay(F(), 50000, 50000));
      expect(r1.allocations[0]).toMatchObject({ invoice_status: 'PARTIALLY_PAID', amount_paid_paise: '50000' });
      expect(r1.unallocated_paise).toBe('0');
      expect((await jobStatus()).status).not.toBe('CLOSED');

      const r2 = ok(await pay(F(), 60000)); // received, not yet allocated
      fails(await api('post', `/payments/${r2.id}/allocations`, F(), { invoice_id: s.invoice.id, amount_paise: 60000 }),
        400, /exceeds the invoice balance/);
      expect((await jobStatus()).status).not.toBe('CLOSED');

      const r2b = ok(await api('post', `/payments/${r2.id}/allocations`, F(), { invoice_id: s.invoice.id, amount_paise: 56200 }));
      expect(r2b.unallocated_paise).toBe('3800');
      const inv = ok(await api('get', `/invoices/${s.invoice.id}`, F()));
      expect(inv).toMatchObject({ invoice_status: 'PAID', amount_paid_paise: '106200', balance_paise: '0' });

      const js = await jobStatus();
      expect(js.status).toBe('CLOSED');
      expect(js.closed_at).not.toBeNull();
      const hist = await c.query(
        `SELECT reason FROM job_status_history WHERE job_id=$1 AND new_status='CLOSED'`, [s.job]);
      expect(hist.rows[0].reason).toMatch(/fully paid/);
      s.receipts = [r1.id, r2.id];
    });

    it('warranty credit note (within 3 months of POD) cancels the invoice and returns payments to the receipts', async () => {
      const cn = ok(await api('post', `/invoices/${s.invoice.id}/credit-note`, F(), {
        reason_code: 'WARRANTY_FAILURE', reason: 'failed within warranty', failed_job_id: s.job,
      }));
      expect(cn.credit_note_number).toMatch(new RegExp(`^CN/BIAPL/\\d+/${short}$`));
      expect(cn).toMatchObject({ total_paise: '106200', payments_reversed_paise: '106200', reason_code: 'WARRANTY_FAILURE' });
      expect(cn.warranty_end_date).toBeTruthy();
      expect(cn.payment_reversals).toHaveLength(2);

      const inv = ok(await api('get', `/invoices/${s.invoice.id}`, F()));
      expect(inv).toMatchObject({ invoice_status: 'CANCELLED', amount_paid_paise: '0' });
      expect(inv.jobs[0].is_live).toBe(false);
      expect(ok(await api('get', `/payments/${s.receipts[0]}`, F())).unallocated_paise).toBe('50000');
      expect(ok(await api('get', `/payments/${s.receipts[1]}`, F())).unallocated_paise).toBe('60000');

      fails(await api('post', `/invoices/${s.invoice.id}/credit-note`, F(), {
        reason_code: 'INVOICE_CORRECTION', reason: 'again',
      }), 400, /already cancelled/);
      expect(await dbRejects(c, `UPDATE br08_credit_notes SET total_paise=0 WHERE id=$1`, [cn.id])).toMatch(/append_only/);
      // Payments can no longer be applied to a cancelled invoice.
      fails(await api('post', `/payments/${s.receipts[0]}/allocations`, F(), { invoice_id: s.invoice.id, amount_paise: 100 }),
        400, /cancelled invoice/);
    });

    it('no-charge waiver / closure: SALES only (others 403)', async () => {
      const w = { reason: 'goodwill -- no charge' };
      fails(await api('post', `/jobs/${s.job2}/waiver`, F(), w), 403);
      fails(await api('post', `/jobs/${s.job2}/waiver`, P(), w), 403);
      fails(await api('post', `/jobs/${s.job2}/waiver`, E(), w), 403);
      const r = ok(await api('post', `/jobs/${s.job2}/waiver`, f.sales, w));
      expect(r.job.status).toBe('CLOSED');
      fails(await api('post', `/jobs/${s.job2}/waiver`, f.sales, w), 400, /already CLOSED|unique|duplicate/i);
      expect(ok(await api('get', `/jobs/${s.job2}/billing`, f.sales)).waiver_id).toBe(r.waiver.id);
      // DB layer: a non-Sales employee cannot insert a waiver directly either.
      expect(await dbRejects(c, `INSERT INTO br08_job_waivers(company_id,job_id,reason,waived_by_id) VALUES ($1,$2,'x',$3)`,
        [f.companyId, s.job, f.finance])).toMatch(/only Sales/);
    });
  });

  // ============================================================== BR-09
  describe('BR-09 complaint -> repeat return -> claim -> credit-note request -> case closure', () => {
    const F = () => f.finance;
    let savedAuth: any[] = [];

    // The approver roles are CLIENT-UNCONFIRMED company config. The suite assigns
    // them temporarily and restores whatever was there before.
    beforeAll(async () => {
      savedAuth = (await c.query(`SELECT * FROM br09_authority_config WHERE company_id=$1`, [f.companyId])).rows;
      await c.query(`DELETE FROM br09_authority_config WHERE company_id=$1`, [f.companyId]);
    });
    afterAll(async () => {
      await c.query(`DELETE FROM br09_authority_config WHERE company_id=$1`, [f.companyId]);
      for (const r of savedAuth) {
        await c.query(
          `INSERT INTO br09_authority_config(company_id,decision_kind,approver_role_code,note,updated_by_id,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [r.company_id, r.decision_kind, r.approver_role_code, r.note, r.updated_by_id, r.updated_at]);
      }
    });

    /** A physical return through BR-02 only: new JIN -> 1-unit group -> photo -> verify -> NEW Job. */
    const newReturnJob = async (tag: string) => {
      const jin = ok(await api('post', '/inward-receipts', P(), {
        customer_id: f.customerId, receipt_at: new Date().toISOString(), receipt_channel: 'COURIER',
        customer_dc_number: `RET-${tag}-${RUN}`, notes: `warranty return ${tag}`,
      }));
      const g = ok(await api('post', `/inward-receipts/${jin.id}/equipment-groups`, P(), { assembly_id: f.assemblyId, quantity_received: 1 }));
      const unit = ok(await api('post', `/equipment-groups/${g.id}/expand`, P(), {
        location_id: f.custodyLocationId, custodian_id: f.purchase,
      })).units[0].id;
      ok(await api('post', `/equipment-units/${unit}/photos`, P(), { file_uri: `s3://it/ret-${tag}-${RUN}.jpg`, file_name: 'ret.jpg' }));
      return { jin: jin.id, job: ok(await api('post', `/equipment-units/${unit}/verify`, P())).job };
    };
    const caseBody = (extra: Record<string, unknown>) => ({
      customer_id: f.customerId, complaint_type: 'REPEAT_FAILURE', channel: 'PHONE',
      contact_name: 'Plant maintenance', contact_detail: '+91 90000 00000',
      fault_description: 'Drive trips on overcurrent again after repair', ...extra,
    });
    const setAuthority = (kind: string, role: string | null) =>
      api('put', '/support-config/authorities', f.admin, { decision_kind: kind, approver_role_code: role, note: `integrity ${RUN}` });

    it('setup: Finance re-invoices the original job (its BR-08 invoice was cancelled by the earlier credit note)', async () => {
      s.inv2 = ok(await api('post', '/invoices', F(), { job_ids: [s.job] }));
      expect(s.inv2.invoice_status).toBe('ISSUED');
    });

    it('only SALES registers; the case links the ORIGINAL job and its live BR-08 invoice; warranty from POD', async () => {
      fails(await api('post', '/support-cases', P(), caseBody({ original_job_id: s.job })), 403);
      fails(await api('post', '/support-cases', f.sales, caseBody({ original_job_id: s.job2 })), 400, /never dispatched/);
      fails(await api('post', '/support-cases', f.sales, caseBody({ original_job_id: s.job, case_number: 'X' })), 400, /case_number/);

      const cs = ok(await api('post', '/support-cases', f.sales, caseBody({ original_job_id: s.job })));
      expect(cs.case_number).toMatch(/^ASC-BLR-\d{6}$/);
      expect(cs).toMatchObject({ case_status: 'REGISTERED', original_job_id: s.job, original_invoice_id: s.inv2.id,
        warranty_status: 'IN_WARRANTY' });
      expect(cs.original_invoice.invoice_number).toBe(s.inv2.invoice_number);
      expect(cs.original_pod_date).toBeTruthy();
      // Unseeded SLA targets: clocks run, but no due date is invented.
      expect(cs.sla.map((x: any) => x.event_code).sort()).toEqual(['ACKNOWLEDGEMENT', 'INITIAL_ASSESSMENT', 'RESOLUTION']);
      expect(cs.sla.every((x: any) => x.due_at === null && x.state === 'OPEN')).toBe(true);
      s.case = cs;
    });

    it('unlocated original job: enquiry goes to the unmatched queue; only Purchase matches it', async () => {
      const cs = ok(await api('post', '/support-cases', f.sales,
        caseBody({ complaint_type: 'WARRANTY_ENQUIRY', customer_reference: 'old DC 123' })));
      expect(cs).toMatchObject({ original_job_id: null, original_invoice_id: null, warranty_status: 'UNKNOWN' });
      expect(ok(await api('get', '/support-cases?unmatched=true', P())).map((x: any) => x.id)).toContain(cs.id);
      fails(await api('post', `/support-cases/${cs.id}/match-original-job`, f.sales, { original_job_id: s.job }), 403);
      const m = ok(await api('post', `/support-cases/${cs.id}/match-original-job`, P(), { original_job_id: s.job }));
      expect(m).toMatchObject({ original_job_id: s.job, original_invoice_id: s.inv2.id, warranty_status: 'IN_WARRANTY' });
      fails(await api('post', `/support-cases/${cs.id}/match-original-job`, P(), { original_job_id: s.job }), 400, /already matched/);
      s.case2 = m;
    });

    it('Sales acknowledges (stops the acknowledgement SLA); Purchase starts review', async () => {
      fails(await api('post', `/support-cases/${s.case.id}/communications`, P(),
        { comm_type: 'ACKNOWLEDGEMENT', channel: 'EMAIL', summary: 'x' }), 403);
      const a = ok(await api('post', `/support-cases/${s.case.id}/communications`, f.sales,
        { comm_type: 'ACKNOWLEDGEMENT', channel: 'EMAIL', summary: 'Complaint received, case opened' }));
      expect(a.sla.find((x: any) => x.event_code === 'ACKNOWLEDGEMENT').state).toBe('NO_TARGET');
      fails(await api('post', `/support-cases/${s.case.id}/start-review`, f.sales, {}), 403);
      const r = ok(await api('post', `/support-cases/${s.case.id}/start-review`, P(), {}));
      expect(r).toMatchObject({ case_status: 'UNDER_REVIEW', assigned_to_id: f.purchase });
    });

    it('ON_HOLD (Purchase only): resumes to the held-from status; no decision while held; evidence + comms still allowed', async () => {
      fails(await api('post', `/support-cases/${s.case.id}/hold`, f.sales, { reason: 'awaiting customer photos' }), 403);
      const h = ok(await api('post', `/support-cases/${s.case.id}/hold`, P(), { reason: 'awaiting customer photos' }));
      expect(h).toMatchObject({ case_status: 'ON_HOLD', hold_from_status: 'UNDER_REVIEW', held_by_id: f.purchase });
      expect(h.closure_blocker).toMatch(/ON_HOLD/);
      ok(await api('post', `/support-cases/${s.case.id}/communications`, f.sales,
        { comm_type: 'STATUS_UPDATE', channel: 'EMAIL', summary: 'Please send photos of the failed drive' }));
      const ev = ok(await api('post', `/support-cases/${s.case.id}/evidence`, f.sales, {
        evidence_type: 'CUSTOMER_PHOTO', file_uri: `s3://it/case-${RUN}/drive.jpg`, file_name: 'drive.jpg',
        submitted_by_kind: 'CUSTOMER', description: 'Burnt capacitor bank' }));
      expect(ev.evidence).toHaveLength(1);
      expect(ev.evidence[0]).toMatchObject({ evidence_type: 'CUSTOMER_PHOTO', submitted_by_kind: 'CUSTOMER', recorded_by_id: f.sales });
      expect(await dbRejects(c, `UPDATE br09_support_cases SET case_status='DECIDED' WHERE id=$1`, [s.case.id]))
        .toMatch(/resumes to UNDER_REVIEW/);
      expect(await dbRejects(c, `UPDATE br09_support_cases SET case_status='REGISTERED', last_resumed_by_id=$2 WHERE id=$1`,
        [s.case.id, f.purchase])).toMatch(/resumes to UNDER_REVIEW/);
      fails(await api('post', `/support-cases/${s.case.id}/resume`, f.sales), 403);
      const r = ok(await api('post', `/support-cases/${s.case.id}/resume`, P()));
      expect(r).toMatchObject({ case_status: 'UNDER_REVIEW', hold_from_status: null, last_resumed_by_id: f.purchase });
    });

    it('case evidence: Sales/Purchase only, append-only, decision link must be the same case, never future-dated', async () => {
      const body = { evidence_type: 'DELIVERY_POD', file_uri: `s3://it/case-${RUN}/pod.pdf`, file_name: 'pod.pdf', submitted_by_kind: 'STAFF' };
      fails(await api('post', `/support-cases/${s.case.id}/evidence`, E(), body), 403);
      fails(await api('post', `/support-cases/${s.case.id}/evidence`, P(), { ...body, evidence_type: 'SELFIE' }), 400);
      fails(await api('post', `/support-cases/${s.case.id}/evidence`, P(),
        { ...body, received_at: new Date(Date.now() + 86400000).toISOString() }), 400, /future/);
      ok(await api('post', `/support-cases/${s.case.id}/evidence`, P(), body));
      expect(await dbRejects(c, `UPDATE br09_case_evidence SET file_uri='x' WHERE case_id=$1`, [s.case.id])).toMatch(/append_only|mutation/i);
      expect(await dbRejects(c, `DELETE FROM br09_case_evidence WHERE case_id=$1`, [s.case.id])).toMatch(/append_only|mutation/i);
    });

    it('CANCELLED (Purchase only, with reason) is terminal; a cancelled case accepts nothing further', async () => {
      const dup = ok(await api('post', '/support-cases', f.sales, caseBody({ original_job_id: s.job, customer_reference: `DUP-${RUN}` })));
      fails(await api('post', `/support-cases/${dup.id}/cancel`, f.sales, { reason: 'duplicate of earlier case' }), 403);
      const x = ok(await api('post', `/support-cases/${dup.id}/cancel`, P(), { reason: 'duplicate of earlier case' }));
      expect(x).toMatchObject({ case_status: 'CANCELLED', cancelled_by_id: f.purchase, closure_blocker: null });
      expect(x.sla.every((k: any) => k.state !== 'OPEN')).toBe(true);
      fails(await api('post', `/support-cases/${dup.id}/communications`, f.sales,
        { comm_type: 'STATUS_UPDATE', channel: 'EMAIL', summary: 'late' }), 400, /cancelled/);
      fails(await api('post', `/support-cases/${dup.id}/evidence`, P(),
        { evidence_type: 'CUSTOMER_EMAIL', file_uri: 's3://x', file_name: 'x.eml', submitted_by_kind: 'CUSTOMER' }), 400, /cancelled/);
      fails(await api('post', `/support-cases/${dup.id}/start-review`, P(), {}), 400, /cancelled case is immutable/);
      expect(await dbRejects(c, `UPDATE br09_support_cases SET cancel_reason='edited' WHERE id=$1`, [dup.id])).toMatch(/cancelled case is immutable/);
    });

    it('warranty repeat return = NEW JIN + Job via BR-02, linked R01 to the original (no Job ID created by BR-09)', async () => {
      const ret = await newReturnJob('R1');
      expect(ret.job.job_number).toMatch(/^JOB-BLR-\d{6}$/); // allocated by BR-02's own counter
      expect(ret.job.inward_id).toBe(ret.jin);
      fails(await api('post', `/jobs/${ret.job.id}/repeat-link`, E(), { repeat_of_job_id: s.job, return_reason: 'x' }), 403);
      fails(await api('post', `/jobs/${ret.job.id}/repeat-link`, P(), { repeat_of_job_id: s.job2, return_reason: 'x' }),
        400, /never dispatched/);
      const link = ok(await api('post', `/jobs/${ret.job.id}/repeat-link`, P(),
        { repeat_of_job_id: s.job, return_reason: 'same fault within warranty' }));
      expect(link).toMatchObject({ job_id: ret.job.id, original_job_id: s.job, previous_job_id: null, repeat_ref: 'R01' });
      fails(await api('post', `/jobs/${ret.job.id}/repeat-link`, P(), { repeat_of_job_id: s.job, return_reason: 'x' }),
        400, /already linked/);
      s.rep1 = ret.job.id;

      // Attach to the case: Purchase only, and only a BR-02 repeat of THIS case's original job.
      fails(await api('post', `/support-cases/${s.case.id}/repeat-jobs`, f.sales, { repeat_job_id: s.rep1 }), 403);
      fails(await api('post', `/support-cases/${s.case.id}/repeat-jobs`, P(), { repeat_job_id: s.job2 }), 400, /not a BR-02 repeat/);
      const cs = ok(await api('post', `/support-cases/${s.case.id}/repeat-jobs`, P(), { repeat_job_id: s.rep1 }));
      expect(cs.repeat_jobs).toHaveLength(1);
      expect(cs.repeat_jobs[0]).toMatchObject({ repeat_job_id: s.rep1, repeat_ref: 'R01' });
      expect(cs.original_job.id).toBe(s.job);
    });

    it('technical assessment only by the current accepted engineer of the repeat job', async () => {
      ok(await api('post', `/jobs/${s.rep1}/assign`, P(), { engineer_id: f.engineer }));
      ok(await api('post', `/jobs/${s.rep1}/custody-ack`, E(), { condition_note: 'returned unit received' }));
      const body = { repeat_job_id: s.rep1, outcome: 'REPEAT_FAULT', findings: 'Same DC-bus capacitor bank failed',
        root_cause_category: 'Component ageing' };
      fails(await api('post', `/support-cases/${s.case.id}/technical-assessments`, P(), body), 403);
      const cs = ok(await api('post', `/support-cases/${s.case.id}/technical-assessments`, E(), body));
      expect(cs.technical_assessments[0]).toMatchObject({ outcome: 'REPEAT_FAULT', assessed_by_id: f.engineer });
    });

    it('claim decision is BLOCKED while the approver role is CLIENT-UNCONFIRMED; config is SYSTEM_ADMIN only', async () => {
      const cfg = ok(await api('get', '/support-config', P()));
      expect(cfg.authorities.find((a: any) => a.decision_kind === 'CLAIM_DECISION').status).toMatch(/CLIENT-UNCONFIRMED/);
      fails(await api('post', `/support-cases/${s.case.id}/decision`, P(),
        { resolution: 'REFUND_REVIEW', decision_reason: 'repeat fault in warranty' }), 400, /CLIENT-UNCONFIRMED/);
      fails(await api('put', '/support-config/authorities', P(), { decision_kind: 'CLAIM_DECISION', approver_role_code: 'PURCHASE' }), 403);
      // Test-only assignment (restored in afterAll) -- NOT a decision about who approves.
      const set = ok(await setAuthority('CLAIM_DECISION', 'PURCHASE'));
      expect(set.authorities.find((a: any) => a.decision_kind === 'CLAIM_DECISION').status).toBe('CONFIGURED');
      // Wrong role for the configured authority -> 403 (API) ...
      fails(await api('post', `/support-cases/${s.case.id}/decision`, f.sales,
        { resolution: 'REFUND_REVIEW', decision_reason: 'x' }), 403, /configured approver role/);
      // ... and the DB rejects it independently.
      expect(await dbRejects(c,
        `INSERT INTO br09_claim_decisions(company_id,case_id,resolution,decision_reason,decided_by_id,decided_role_code,warranty_status_at_decision)
         VALUES ($1,$2,'REJECTED','x',$3,'','')`, [f.companyId, s.case.id, f.sales])).toMatch(/configured approver role/);
    });

    it('REFUND_REVIEW needs the separate REFUND_REPLACEMENT_REVIEW authority (unconfigured = blocked) before any credit-note request', async () => {
      const d = ok(await api('post', `/support-cases/${s.case.id}/decision`, P(),
        { resolution: 'REFUND_REVIEW', decision_reason: 'repeat fault within warranty -- customer wants credit' }));
      expect(d.case_status).toBe('DECIDED');
      expect(d.credit_note_requests).toHaveLength(0);                       // no Finance request until the review approves
      expect(d.closure_blocker).toMatch(/refund\/replacement review authority/);
      // hold / cancel are blocked once a decision exists
      fails(await api('post', `/support-cases/${s.case.id}/hold`, P(), { reason: 'x' }), 400, /claim decision exists|REGISTERED or UNDER_REVIEW/);
      fails(await api('post', `/support-cases/${s.case.id}/cancel`, P(), { reason: 'x' }), 400, /cannot be cancelled|claim decision exists/);
      // evidence can be tied to the decision it supports
      const ev = ok(await api('post', `/support-cases/${s.case.id}/evidence`, P(), {
        evidence_type: 'TEST_RECORD', file_uri: `s3://it/case-${RUN}/test.pdf`, file_name: 'test.pdf', submitted_by_kind: 'STAFF',
        claim_decision_id: d.decisions.find((x: any) => x.is_current).id }));
      expect(ev.evidence.some((e: any) => e.claim_decision_id)).toBe(true);

      const cfg = ok(await api('get', '/support-config', P()));
      expect(cfg.authorities.find((a: any) => a.decision_kind === 'REFUND_REPLACEMENT_REVIEW').status).toMatch(/CLIENT-UNCONFIRMED/);
      const review = { outcome: 'APPROVED', note: 'refund justified by the repeat-fault assessment' };
      fails(await api('post', `/support-cases/${s.case.id}/refund-replacement-review`, f.mgmt, review), 400, /CLIENT-UNCONFIRMED/);
      // Test-only assignment (restored in afterAll) -- NOT a decision about who reviews refunds/replacements.
      ok(await setAuthority('REFUND_REPLACEMENT_REVIEW', 'MANAGEMENT'));
      fails(await api('post', `/support-cases/${s.case.id}/refund-replacement-review`, P(), review), 403, /configured approver role/);
      s.rrReviewed = ok(await api('post', `/support-cases/${s.case.id}/refund-replacement-review`, f.mgmt, review));
      expect(s.rrReviewed.refund_replacement_reviews[0]).toMatchObject({ outcome: 'APPROVED', reviewed_by_id: f.mgmt, reviewer_role_code: 'MANAGEMENT' });
      expect(await dbRejects(c, `UPDATE br09_refund_replacement_reviews SET outcome='REJECTED' WHERE id=$1`,
        [s.rrReviewed.refund_replacement_reviews[0].id])).toMatch(/append_only|mutation/i);
    });

    it('an APPROVED refund review triggers the Finance credit-note REQUEST (no credit note yet); closure waits for Finance', async () => {
      const cs = s.rrReviewed;
      expect(cs.case_status).toBe('DECIDED');
      expect(cs.credit_note_requests).toHaveLength(1);
      expect(cs.credit_note_requests[0]).toMatchObject({ request_status: 'REQUESTED', invoice_id: s.inv2.id, failed_job_id: s.job });
      expect(ok(await api('get', `/invoices/${s.inv2.id}`, F())).invoice_status).toBe('ISSUED');
      expect(cs.closure_blocker).toMatch(/pending with Finance/);
      s.cnReq = cs.credit_note_requests[0].id;
      expect(await dbRejects(c,
        `INSERT INTO br09_credit_note_requests(company_id,case_id,decision_id,invoice_id,failed_job_id,requested_by_id)
         SELECT company_id,case_id,decision_id,invoice_id,failed_job_id,requested_by_id FROM br09_credit_note_requests WHERE id=$1`,
        [s.cnReq])).toMatch(/created only by a REFUND_REVIEW/);
    });

    it('Finance fulfils through the BR-08 credit note: original invoice cancelled, CN linked to case + repeat job', async () => {
      fails(await api('post', `/credit-note-requests/${s.cnReq}/fulfil`, P()), 403);
      const r = ok(await api('post', `/credit-note-requests/${s.cnReq}/fulfil`, F()));
      expect(r.request).toMatchObject({ request_status: 'FULFILLED', br08_credit_note_id: r.credit_note.id });
      expect(r.credit_note.credit_note_number).toMatch(/^CN\/BIAPL\/\d+\/\d{2}-\d{2}$/);
      expect(r.credit_note).toMatchObject({ invoice_id: s.inv2.id, reason_code: 'WARRANTY_FAILURE',
        failed_job_id: s.job, warranty_return_job_id: s.rep1 });
      expect(ok(await api('get', `/invoices/${s.inv2.id}`, F())).invoice_status).toBe('CANCELLED');
      fails(await api('post', `/credit-note-requests/${s.cnReq}/fulfil`, F()), 400, /already FULFILLED/);
    });

    it('case closure is independent of job closure (Purchase only; needs a RESOLUTION communication)', async () => {
      fails(await api('post', `/support-cases/${s.case.id}/close`, P(), { closure_reason: 'credited' }), 400, /RESOLUTION communication/);
      ok(await api('post', `/support-cases/${s.case.id}/communications`, f.sales,
        { comm_type: 'RESOLUTION', channel: 'EMAIL', summary: 'Credit note issued against the original invoice' }));
      fails(await api('post', `/support-cases/${s.case.id}/close`, f.sales, { closure_reason: 'x' }), 403);

      const jobsBefore = (await c.query(
        `SELECT id, status, closed_at FROM service_jobs WHERE id = ANY($1) ORDER BY id`, [[s.job, s.rep1]])).rows;
      const histBefore = (await c.query(
        `SELECT count(*)::int n FROM job_status_history WHERE job_id = ANY($1)`, [[s.job, s.rep1]])).rows[0].n;

      const cs = ok(await api('post', `/support-cases/${s.case.id}/close`, P(), { closure_reason: 'Credit note issued; customer informed' }));
      expect(cs).toMatchObject({ case_status: 'CLOSED', closure_disposition: 'REFUND_REVIEW', closed_by_id: f.purchase });
      expect(cs.sla.find((x: any) => x.event_code === 'RESOLUTION').state).toBe('NO_TARGET');

      // Neither the original job nor the repeat job was touched by the case closure.
      const jobsAfter = (await c.query(
        `SELECT id, status, closed_at FROM service_jobs WHERE id = ANY($1) ORDER BY id`, [[s.job, s.rep1]])).rows;
      expect(jobsAfter).toEqual(jobsBefore);
      expect(jobsAfter.find((j: any) => j.id === s.rep1).status).not.toBe('CLOSED');
      expect((await c.query(`SELECT count(*)::int n FROM job_status_history WHERE job_id = ANY($1)`, [[s.job, s.rep1]])).rows[0].n)
        .toBe(histBefore);

      // A closed case is immutable.
      fails(await api('post', `/support-cases/${s.case.id}/communications`, f.sales,
        { comm_type: 'STATUS_UPDATE', channel: 'EMAIL', summary: 'late' }), 400, /closed/);
      expect(await dbRejects(c, `UPDATE br09_support_cases SET closure_reason='edited' WHERE id=$1`, [s.case.id]))
        .toMatch(/closed case is immutable/);
    });

    it('optional customer feedback (Sales, once)', async () => {
      fails(await api('post', `/support-cases/${s.case.id}/feedback`, P(), { rating: 4 }), 403);
      expect(ok(await api('post', `/support-cases/${s.case.id}/feedback`, f.sales, { rating: 4, comment: 'quick credit' })).rating).toBe(4);
      fails(await api('post', `/support-cases/${s.case.id}/feedback`, f.sales, { rating: 5 }), 400, /unique|duplicate/i);
    });

    it('second return links R02 (previous = R01); GOODWILL needs the separate, configured goodwill authority', async () => {
      ok(await api('post', `/support-cases/${s.case2.id}/start-review`, P(), {}));
      const ret = await newReturnJob('R2');
      const link = ok(await api('post', `/jobs/${ret.job.id}/repeat-link`, P(), { repeat_of_job_id: s.rep1, return_reason: 'failed again' }));
      expect(link).toMatchObject({ original_job_id: s.job, previous_job_id: s.rep1, repeat_ref: 'R02' });
      s.rep2 = ret.job.id;
      ok(await api('post', `/support-cases/${s.case2.id}/repeat-jobs`, P(), { repeat_job_id: s.rep2 }));
      ok(await api('post', `/jobs/${s.rep2}/assign`, P(), { engineer_id: f.engineer }));
      ok(await api('post', `/jobs/${s.rep2}/custody-ack`, E(), { condition_note: 'received' }));
      ok(await api('post', `/support-cases/${s.case2.id}/technical-assessments`, E(),
        { repeat_job_id: s.rep2, outcome: 'USER_DAMAGE', findings: 'Burnt terminal from wrong supply', root_cause_category: 'Site supply' }));

      const d = ok(await api('post', `/support-cases/${s.case2.id}/decision`, P(),
        { resolution: 'GOODWILL', decision_reason: 'user damage, key account goodwill repair' }));
      expect(d.closure_blocker).toMatch(/goodwill decision is not approved/);
      fails(await api('post', `/support-cases/${s.case2.id}/goodwill-approval`, P(),
        { outcome: 'APPROVED', note: 'ok' }), 400, /CLIENT-UNCONFIRMED/);
      ok(await setAuthority('GOODWILL_APPROVAL', 'PURCHASE'));
      const g = ok(await api('post', `/support-cases/${s.case2.id}/goodwill-approval`, f.purchase2,
        { outcome: 'APPROVED', note: 'approved as goodwill' }));
      expect(g.goodwill_approvals[0]).toMatchObject({ outcome: 'APPROVED', approved_by_id: f.purchase2, approver_role_code: 'PURCHASE' });
      // A repair resolution is only "completed" once the repeat job is dispatched back (BR-08).
      expect(g.closure_blocker).toMatch(/not yet dispatched/);
      fails(await api('post', `/support-cases/${s.case2.id}/close`, P(), { closure_reason: 'x' }), 400, /not yet dispatched/);
    });

    it('quality analytics: repeat failures, root cause, goodwill, feedback', async () => {
      const a = ok(await api('get', '/support-analytics', f.sales));
      const rf = a.repeat_failures.find((x: any) => x.original_job_id === s.job);
      expect(rf).toMatchObject({ repeat_count: '2', latest_repeat_number: 2 });
      expect(rf.assessment_outcomes.sort()).toEqual(['REPEAT_FAULT', 'USER_DAMAGE']);
      expect(a.root_cause.some((r: any) => r.outcome === 'REPEAT_FAULT' && r.root_cause_category === 'Component ageing')).toBe(true);
      expect(a.goodwill.find((g: any) => g.case_id === s.case2.id).goodwill_outcome).toBe('APPROVED');
      expect(Number(a.feedback.responses)).toBeGreaterThanOrEqual(1);
    });

    it('case SLA due dates use the working calendar once a target is configured (DB; rolled back)', async () => {
      await c.query('BEGIN');
      try {
        await c.query(`INSERT INTO br09_sla_targets(company_id,priority,event_code,target_amount,target_unit)
                       VALUES ($1,'NORMAL','ACKNOWLEDGEMENT',4,'WORKING_HOUR')
                       ON CONFLICT (company_id,priority,event_code) DO UPDATE SET target_amount=4, target_unit='WORKING_HOUR'`,
          [f.companyId]);
        const r = (await c.query(
          `SELECT br09_sla_due($1,'NORMAL','ACKNOWLEDGEMENT','2026-11-06T17:00:00+05:30') AS due,
                  br09_sla_due($1,'URGENT','ACKNOWLEDGEMENT','2026-11-06T17:00:00+05:30') AS none`, [f.companyId])).rows[0];
        // Fri 17:00 + 240 working min = 90 (Fri) + 150 (Sat 09:30 -> 12:00)
        expect(r.due.getTime()).toBe(new Date('2026-11-07T12:00:00+05:30').getTime());
        expect(r.none).toBeNull();
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

  // ============================================================== BR-10
  describe('BR-10 read-only MIS + RBAC (bindings, named grants, row scope, masking)', () => {
    const ADM = () => f.admin;
    let savedAuth: any[] = [];

    // Source-module tables BR-10 must never write (counts + content checksums).
    const SOURCE_TABLES = [
      'service_jobs', 'job_assignments', 'job_status_history', 'job_repeat_links', 'inward_receipts', 'customers', 'employees',
      'br03_material_requests', 'br04_customer_quotes', 'br04_customer_quote_lines', 'br05_job_authorisations',
      'br06_supplier_purchase_orders', 'br06_po_lines', 'br06_grn_lines', 'br07_test_runs', 'br07_dispatch_releases',
      'sla_instances', 'fdn_inventory_journal', 'fdn_inventory_balances', 'fdn_inventory_reservations',
      'br08_dispatch_batches', 'br08_invoices', 'br08_invoice_lines', 'br08_payment_receipts', 'br08_payment_allocations',
      'br08_credit_notes', 'br09_support_cases', 'br09_case_sla', 'br09_claim_decisions', 'activity_audit_log',
    ];
    const snapshot = async () => {
      const out: Record<string, string> = {};
      for (const t of SOURCE_TABLES) {
        const r = (await c.query(`SELECT count(*)::text AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`)).rows[0];
        out[t] = `${r.n}:${r.h}`;
      }
      return out;
    };

    beforeAll(async () => {
      savedAuth = (await c.query(`SELECT * FROM br10_authority_config WHERE company_id=$1`, [f.companyId])).rows;
      await c.query(`DELETE FROM br10_authority_config WHERE company_id=$1`, [f.companyId]);
    });
    afterAll(async () => {
      await c.query(`DELETE FROM br10_authority_config WHERE company_id=$1`, [f.companyId]);
      for (const r of savedAuth) {
        await c.query(
          `INSERT INTO br10_authority_config(company_id,authority_kind,approver_role_code,note,updated_by_id,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [r.company_id, r.authority_kind, r.approver_role_code, r.note, r.updated_by_id, r.updated_at]);
      }
    });

    const bind = async (employee: string, role: string) => {
      const b = ok(await api('post', '/mis/role-bindings', ADM(), { employee_id: employee, role_code: role }));
      expect(b.status).toBe('INACTIVE');
      return ok(await api('post', `/mis/role-bindings/${b.id}/activate`, ADM()));
    };
    const grant = async (employee: string, report: string, action: 'VIEW' | 'EXPORT') =>
      ok(await api('post', '/mis/report-grants', ADM(), { employee_id: employee, report_code: report, action }));
    const standardGrant = async (employee: string, report: string, action: 'VIEW' | 'EXPORT') => {
      const g = await grant(employee, report, action);
      expect(g).toMatchObject({ status: 'INACTIVE', required_approvals: ['STANDARD'] });
      const a = ok(await api('post', `/mis/report-grants/${g.id}/approve`, ADM(), { approval_kind: 'STANDARD' }));
      expect(a.status).toBe('ACTIVE');
      return a;
    };
    const view = (actor: string, report: string, qs = '') => api('get', `/mis/reports/${report}${qs}`, actor);
    const download = async (actor: string, report: string, format: string) => {
      const res = await request(BASE).get(`/mis/reports/${report}/export?format=${format}`)
        .set('Authorization', `Bearer ${await tokenFor(actor)}`)
        .buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (d: Buffer) => chunks.push(d)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
      if (res.status !== 200 && res.status !== 403) {
        throw new Error(`export ${format} -> ${res.status}: ${(res.body as Buffer).toString('utf8').slice(0, 300)}`);
      }
      return res;
    };

    it('bindings: SYSTEM_ADMIN only, start INACTIVE, no self-binding, R_* must map to the existing role_code', async () => {
      fails(await api('post', '/mis/role-bindings', P(), { employee_id: f.purchase, role_code: 'R_PURCHASE_EXEC' }), 403);
      fails(await api('post', '/mis/role-bindings', ADM(), { employee_id: f.engineer, role_code: 'R_SALES_EXEC' }),
        400, /second role system/);
      fails(await api('post', '/mis/role-bindings', ADM(), { employee_id: f.mgmt, role_code: 'R_AUDITOR' }),
        400, /no existing role_code mapping/);
      fails(await api('post', '/mis/role-bindings', ADM(), { employee_id: f.admin, role_code: 'R_TECH_ADMIN' }), 403, /no self-binding/);
      expect(await dbRejects(c,
        `INSERT INTO br10_role_bindings(company_id,employee_id,role_code,status,created_by_id,activated_by_id,activated_at)
         VALUES ($1,$2,'R_PURCHASE_EXEC','ACTIVE',$3,$3,now())`, [f.companyId, f.purchase, f.admin])).toMatch(/starts INACTIVE/);
      const cat = ok(await api('get', '/mis/catalogue', P()));
      expect(cat.roles.find((r: any) => r.role_code === 'R_MGMT_GROUP').maps_to_role_code).toBe('MANAGEMENT');
    });

    it('a report requires an ACTIVE binding AND its ACTIVE grant (ungranted -> 403, denial audited)', async () => {
      const b = ok(await api('post', '/mis/role-bindings', ADM(), { employee_id: f.purchase, role_code: 'R_PURCHASE_EXEC' }));
      fails(await view(P(), 'SERVICE_PIPELINE'), 403, /no ACTIVE BR-10 role binding/);
      s.purchaseBinding = ok(await api('post', `/mis/role-bindings/${b.id}/activate`, ADM())).id;
      fails(await view(P(), 'SERVICE_PIPELINE'), 403, /no ACTIVE VIEW grant/);

      const g = await grant(f.purchase, 'SERVICE_PIPELINE', 'VIEW');
      expect(g.status).toBe('INACTIVE');
      fails(await view(P(), 'SERVICE_PIPELINE'), 403, /no ACTIVE VIEW grant/);
      expect(await dbRejects(c, `UPDATE br10_report_grants SET status='ACTIVE', activated_at=now() WHERE id=$1`, [g.id]))
        .toMatch(/required approvals/);
      fails(await api('post', `/mis/report-grants/${g.id}/approve`, P(), { approval_kind: 'STANDARD' }), 403);
      ok(await api('post', `/mis/report-grants/${g.id}/approve`, ADM(), { approval_kind: 'STANDARD' }));

      const r = ok(await view(P(), 'SERVICE_PIPELINE'));
      expect(r.scope.row_scope).toBe('COMPANY');
      expect(r.rows.map((x: any) => x.job_id)).toContain(s.job);
      expect(new Set(r.rows.map((x: any) => x.customer_id)).size).toBeGreaterThan(1); // company-wide
      s.companyPipelineCount = r.rows.length;
      // Supplier cost / margin never appears outside the MARGIN_PROFIT report.
      expect(Object.keys(r.rows[0]).join(',')).not.toMatch(/cost|price|margin|paise/);

      const denied = await c.query(
        `SELECT count(*)::int n FROM br10_report_access_log WHERE employee_id=$1 AND outcome='DENIED' AND report_code='SERVICE_PIPELINE'`,
        [f.purchase]);
      expect(denied.rows[0].n).toBeGreaterThanOrEqual(3);
      expect(await dbRejects(c, `DELETE FROM br10_report_access_log WHERE employee_id=$1`, [f.purchase])).toMatch(/append_only/);
    });

    it('VIEW grant is not EXPORT; exports (csv/xlsx/pdf) need their own grant, are masked and audited', async () => {
      const csvDenied = await download(P(), 'SERVICE_PIPELINE', 'csv');
      expect(csvDenied.status).toBe(403);
      await standardGrant(f.purchase, 'SERVICE_PIPELINE', 'EXPORT');

      const csv = await download(P(), 'SERVICE_PIPELINE', 'csv');
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.headers['content-disposition']).toMatch(/attachment; filename="service_pipeline_/);
      const text = (csv.body as Buffer).toString('utf8');
      const customerName = `IT Customer ${RUN}`;
      expect(text).toMatch(/job_number/);
      expect(text).not.toContain(customerName);          // masked on export...
      // ...and (migration 021) on screen too, until an explicit PII_CUSTOMER grant -- see the PII test below
      expect(ok(await view(P(), 'SERVICE_PIPELINE')).rows.some((x: any) => x.customer_name === customerName)).toBe(false);

      const xlsx = await download(P(), 'SERVICE_PIPELINE', 'xlsx');
      expect(xlsx.status).toBe(200);
      expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
      const pdf = await download(P(), 'SERVICE_PIPELINE', 'pdf');
      expect(pdf.status).toBe(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

      const log = (await c.query(
        `SELECT export_format, filter_checksum, row_scope FROM br10_report_access_log
          WHERE employee_id=$1 AND action='EXPORT' AND outcome='ALLOWED' ORDER BY id`, [f.purchase])).rows;
      expect(log.map((l) => l.export_format)).toEqual(['csv', 'xlsx', 'pdf']);
      expect(log[0].filter_checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('PII_CUSTOMER: customer name masked ON SCREEN unless an explicit named PII grant; VIEW != EXPORT; revocation is immediate', async () => {
      const customerName = `IT Customer ${RUN}`;
      const masked = ok(await view(P(), 'SERVICE_PIPELINE'));
      expect(masked.scope.pii_unmasked).toBe(false);
      const mine = masked.rows.filter((x: any) => x.customer_id === f.customerId);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((x: any) => x.customer_name !== customerName && /^IT\*+$/.test(x.customer_name))).toBe(true);

      fails(await view(P(), 'PII_CUSTOMER'), 400, /entitlement/);                      // not a runnable report
      fails(await api('post', '/mis/report-grants', ADM(), { employee_id: f.stores, report_code: 'PII_CUSTOMER', action: 'VIEW' }),
        400, /ACTIVE BR-10 role binding/);                                              // no binding -> no PII grant
      fails(await api('post', '/mis/report-grants', P(), { employee_id: f.purchase, report_code: 'PII_CUSTOMER', action: 'VIEW' }), 403);

      const pii = await standardGrant(f.purchase, 'PII_CUSTOMER', 'VIEW');            // starts INACTIVE, admin approval
      const open = ok(await view(P(), 'SERVICE_PIPELINE'));
      expect(open.scope.pii_unmasked).toBe(true);
      expect(open.rows.some((x: any) => x.customer_name === customerName)).toBe(true);
      const csv = await download(P(), 'SERVICE_PIPELINE', 'csv');                      // a VIEW PII grant does not unmask exports
      expect((csv.body as Buffer).toString('utf8')).not.toContain(customerName);

      ok(await api('post', `/mis/report-grants/${pii.id}/revoke`, ADM()));
      expect(ok(await view(P(), 'SERVICE_PIPELINE')).rows.some((x: any) => x.customer_name === customerName)).toBe(false);
      expect(await dbRejects(c, `UPDATE br10_report_grants SET status='ACTIVE', revoked_at=NULL, revoked_by_id=NULL WHERE id=$1`, [pii.id]))
        .toMatch(/revoked grant stays revoked/);
    });

    it('engineer sees ONLY own assigned jobs, without customer fields; cannot be granted other classes', async () => {
      await bind(f.engineer, 'R_SERVICE_ENG');
      await standardGrant(f.engineer, 'SERVICE_PIPELINE', 'VIEW');
      const r = ok(await view(E(), 'SERVICE_PIPELINE'));
      expect(r.scope.row_scope).toBe('JOBS');
      expect(r.rows.length).toBeGreaterThan(0);
      expect(r.rows.every((x: any) => x.engineer_id === f.engineer)).toBe(true);
      expect(r.rows.map((x: any) => x.job_id)).toEqual(expect.arrayContaining([s.rep1, s.rep2]));
      expect(r.rows.every((x: any) => x.customer_name === null && x.customer_id === null)).toBe(true);
      expect(r.rows.length).toBeLessThan(s.companyPipelineCount);
      // Matrix: engineers have no PROCUREMENT / RECEIVABLES rights -> a grant cannot even be created.
      fails(await api('post', '/mis/report-grants', ADM(), { employee_id: f.engineer, report_code: 'PROCUREMENT_SUMMARY', action: 'VIEW' }),
        400, /no ACTIVE role binding/);
      fails(await api('post', '/mis/report-grants', ADM(), { employee_id: f.engineer, report_code: 'RECEIVABLES_AGING', action: 'VIEW' }),
        400, /no ACTIVE role binding/);
      // Another company is never implied.
      const zzb = await otherCompany(c);
      fails(await view(E(), 'SERVICE_PIPELINE', `?companies=${f.companyId},${zzb}`), 403, /another company/);
    });

    it('sales sees ONLY explicitly assigned customers; receivable status carries no amounts; no margin', async () => {
      await bind(f.sales, 'R_SALES_EXEC');
      await standardGrant(f.sales, 'SERVICE_PIPELINE', 'VIEW');
      await standardGrant(f.sales, 'RECEIVABLE_STATUS', 'VIEW');
      const none = ok(await view(f.sales, 'SERVICE_PIPELINE'));
      expect(none.scope.row_scope).toBe('CUSTOMERS');
      expect(none.rows).toHaveLength(0); // no ACTIVE assignment yet

      const a = ok(await api('post', '/mis/sales-assignments', ADM(), { employee_id: f.sales, customer_id: f.customerId }));
      expect(a.status).toBe('INACTIVE');
      expect(ok(await view(f.sales, 'SERVICE_PIPELINE')).rows).toHaveLength(0);
      ok(await api('post', `/mis/sales-assignments/${a.id}/activate`, ADM()));

      const r = ok(await view(f.sales, 'SERVICE_PIPELINE'));
      expect(r.rows.length).toBeGreaterThan(0);
      expect(r.rows.every((x: any) => x.customer_id === f.customerId)).toBe(true);
      const st = ok(await view(f.sales, 'RECEIVABLE_STATUS'));
      expect(st.rows.map((x: any) => x.invoice_number)).toEqual(expect.arrayContaining([s.invoice.invoice_number, s.inv2.invoice_number]));
      for (const row of st.rows) expect(Object.keys(row).join(',')).not.toMatch(/paise|amount|total|bank/);
      fails(await view(f.sales, 'RECEIVABLES_AGING'), 403);
      fails(await api('post', '/mis/report-grants', ADM(), { employee_id: f.sales, report_code: 'JOB_PROFITABILITY', action: 'VIEW' }),
        400, /no ACTIVE role binding/);
    });

    it('margin/profit needs an explicit named FINANCIAL grant: role alone, admin, or Purchase is not enough', async () => {
      await bind(f.finance, 'R_FINANCE_EXEC');
      fails(await view(f.finance, 'JOB_PROFITABILITY'), 403, /no ACTIVE VIEW grant/);
      const g = await grant(f.finance, 'JOB_PROFITABILITY', 'VIEW');
      expect(g.required_approvals).toEqual(['FINANCIAL']);
      fails(await api('post', `/mis/report-grants/${g.id}/approve`, ADM(), { approval_kind: 'STANDARD' }), 400, /does not need a STANDARD/);
      fails(await api('post', `/mis/report-grants/${g.id}/approve`, f.mgmt, { approval_kind: 'FINANCIAL' }), 400, /CLIENT-UNCONFIRMED/);

      // Test-only authoriser assignment (restored in afterAll) -- NOT a decision about who authorises.
      ok(await api('put', '/mis/authorities', ADM(), { authority_kind: 'FINANCIAL_GRANT', approver_role_code: 'MANAGEMENT' }));
      fails(await api('post', `/mis/report-grants/${g.id}/approve`, ADM(), { approval_kind: 'FINANCIAL' }), 403, /authoriser role/);
      expect(ok(await api('post', `/mis/report-grants/${g.id}/approve`, f.mgmt, { approval_kind: 'FINANCIAL' })).status).toBe('ACTIVE');

      const r = ok(await view(f.finance, 'JOB_PROFITABILITY'));
      expect(r.summary.kpi_status).toBe('UNVERIFIED');
      expect(r.formulas.provisional_margin_paise).toMatch(/supplier PO cost/);
      const row = r.rows.find((x: any) => x.job_id === s.job);
      expect(Number(row.supplier_po_cost)).toBeCloseTo(1234.5, 2); // 10 x 123.45 (BR-06 PO)
      expect(row.invoiced_taxable_paise).toBeNull();               // both invoices cancelled ...
      expect(row.provisional_margin_paise).toBeNull();             // ... so no margin -- never a silent zero

      // Purchase holds PO authority but no finance grant (T06).
      fails(await view(P(), 'JOB_PROFITABILITY'), 403);
      // T08: even if configured, SYSTEM_ADMIN can never authorise financial access (DB; rolled back).
      await c.query('BEGIN');
      try {
        await c.query(`UPDATE br10_authority_config SET approver_role_code='SYSTEM_ADMIN' WHERE company_id=$1 AND authority_kind='FINANCIAL_GRANT'`, [f.companyId]);
        const g2 = (await c.query(
          `INSERT INTO br10_report_grants(company_id,employee_id,report_code,action,target_company_id,created_by_id)
           VALUES ($1,$2,'JOB_PROFITABILITY','EXPORT',$1,$3) RETURNING id`, [f.companyId, f.finance, f.admin])).rows[0].id;
        await expect(c.query(
          `INSERT INTO br10_grant_approvals(grant_id,approval_kind,approver_company_id,approved_by_id,approver_role_code)
           VALUES ($1,'FINANCIAL',$2,$3,'')`, [g2, f.companyId, f.admin])).rejects.toThrow(/cannot authorise financial/);
      } finally {
        await c.query('ROLLBACK');
      }
    });

    it('BR-10 writes NOTHING to source tables (counts + checksums unchanged across every report and export)', async () => {
      await standardGrant(f.purchase, 'PROCUREMENT_SUMMARY', 'VIEW');
      await standardGrant(f.purchase, 'INVENTORY_POSITION', 'VIEW');
      await standardGrant(f.purchase, 'QUALITY_WARRANTY', 'VIEW');
      await standardGrant(f.purchase, 'SLA_MONITOR', 'VIEW');
      await standardGrant(f.engineer, 'ENGINEER_PERFORMANCE', 'VIEW');
      const logBefore = (await c.query(`SELECT count(*)::int n FROM br10_report_access_log`)).rows[0].n;
      const before = await snapshot();

      const runs: [string, string][] = [
        [P(), 'SERVICE_PIPELINE'], [P(), 'PROCUREMENT_SUMMARY'], [P(), 'INVENTORY_POSITION'], [P(), 'QUALITY_WARRANTY'],
        [P(), 'SLA_MONITOR'], [E(), 'SERVICE_PIPELINE'], [E(), 'ENGINEER_PERFORMANCE'], [f.sales, 'SERVICE_PIPELINE'],
        [f.sales, 'RECEIVABLE_STATUS'], [f.finance, 'JOB_PROFITABILITY'],
      ];
      for (const [actor, code] of runs) {
        const r = ok(await view(actor, code));
        expect(r.report_code).toBe(code);
      }
      for (const fmt of ['csv', 'xlsx', 'pdf']) expect((await download(P(), 'SERVICE_PIPELINE', fmt)).status).toBe(200);
      fails(await view(P(), 'RECEIVABLES_AGING'), 403); // denials don't write source data either

      expect(await snapshot()).toEqual(before);
      // The only rows written were BR-10's own access-log entries.
      expect((await c.query(`SELECT count(*)::int n FROM br10_report_access_log`)).rows[0].n).toBe(logBefore + runs.length + 3 + 1);

      const proc = ok(await view(P(), 'PROCUREMENT_SUMMARY'));
      expect(proc.summary.supplier_performance).toBeNull();
      expect(proc.readiness.find((x: any) => x.item.startsWith('Supplier performance')).status).toBe('SUPPLIER_MASTER_PENDING');
      expect(Object.keys(proc.rows[0] ?? {}).join(',')).not.toMatch(/price|cost|value/);
    }, 300_000); // full-content checksums of ~30 staging tables are slow

    it('revoking a binding takes effect on the very next call (no cached entitlement)', async () => {
      ok(await view(P(), 'SERVICE_PIPELINE'));
      ok(await api('post', `/mis/role-bindings/${s.purchaseBinding}/revoke`, ADM()));
      fails(await view(P(), 'SERVICE_PIPELINE'), 403, /no ACTIVE BR-10 role binding/);
    });
  });
});
