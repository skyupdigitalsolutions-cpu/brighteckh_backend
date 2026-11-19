import { Client } from 'pg';
import {
  api, balances, bridge, createItem, db, dbRejects, employeeIn, Fixtures, fails, idem, ok, otherCompany, RUN, setupFixtures,
} from './helpers';

/**
 * BR-11 Sales & Supply through the live API, plus its BR-06 SALES_ORDER and
 * BR-08 PRODUCT_SALES extensions. Tests run in order and share state `s`.
 *
 * Stock story (fresh item => 0):
 *   order 6 -> reserve fails (0 stock) -> SALES_ORDER PO 6 via BR-06 -> GRN 6 into MAIN
 *   -> reserve 4 + 2 (real ledger) -> outward 4 (ISSUE out of MAIN) -> POD 4
 *   -> invoice 4 (DELIVERY trigger) -> outward 2 -> POD 2 -> invoice 2 -> paid -> closed.
 * Money: 125000 paise/unit pre-tax; KA customer -> CGST 9% + SGST 9%.
 *
 * CLIENT-UNCONFIRMED config (invoice trigger, payment-before-closure, product GST
 * rate) is assigned TEMPORARILY by this suite and restored afterwards -- these are
 * test values, not decisions.
 */
describe('BR-11 Sales & Supply (enquiry -> quote -> SO -> reserve -> outward -> POD -> BR-08 invoice -> closure)', () => {
  let c: Client;
  let f: Fixtures;
  const s: Record<string, any> = {};
  let savedPolicy: any[] = [];
  let savedGst: any[] = [];
  let jobsBefore = 0;
  const P = () => f.purchase;
  /** GET /sales-supply/<list>?<qs> as `actor` (default Purchase). */
  const desk = async (list: string, qs: string, actor = f.purchase) => ok(await api('get', `/sales-supply/${list}?${qs}`, actor));
  const deskRow = async (list: string, search: string, actor = f.purchase) => {
    const page = await desk(list, `search=${encodeURIComponent(search)}`, actor);
    expect(page.total).toBe(1);
    return page.rows[0];
  };
  const S = () => f.sales;
  const F = () => f.finance;
  const PRICE = 125000;

  beforeAll(async () => {
    c = await db();
    f = await setupFixtures(c);
    s.item = await createItem(f.purchase, true, 'sale-product');
    s.draftItem = await createItem(f.purchase, false, 'sale-unapproved');
    s.bridge = await bridge(c, s.item, 'APPROVED');
    s.pendingCustomer = (await c.query(
      `INSERT INTO customers(company_id,customer_code,customer_name,status,gstin,state_code,billing_address)
       VALUES ($1,$2,$3,'PENDING_APPROVAL','29AAACI1234A1Z5','29','IT pending address') RETURNING id`,
      [f.companyId, `IT-CUST-${RUN}P`, `IT Customer ${RUN}P`])).rows[0].id;
    s.companyB = await otherCompany(c);
    s.bPurchase = await employeeIn(c, s.companyB, 'PUR', 'PURCHASE', 'B');

    savedPolicy = (await c.query(`SELECT * FROM br11_company_policies WHERE company_id=$1`, [f.companyId])).rows;
    await c.query(`DELETE FROM br11_company_policies WHERE company_id=$1`, [f.companyId]);
    savedGst = (await c.query(`SELECT * FROM br08_gst_rate_config WHERE quote_line_type='PRODUCT_SALE'`)).rows;
    await c.query(`DELETE FROM br08_gst_rate_config WHERE quote_line_type='PRODUCT_SALE'`);
    jobsBefore = (await c.query(`SELECT count(*)::int AS n FROM service_jobs WHERE company_id=$1`, [f.companyId])).rows[0].n;

    // invoicing profile: fill ONLY missing fields (never overwrite a configured profile) -- same as the BR-08 suite
    const prof = ok(await api('get', '/br08/entity-profile', F()));
    const patch: Record<string, string> = {};
    if (!prof.gstin) patch.gstin = '29AAACB0000B1Z5';
    if (!prof.registered_address) patch.registered_address = 'IT staging address, Bengaluru';
    if (!prof.bank_name) patch.bank_name = 'IT Staging Bank';
    if (!prof.bank_account_no) patch.bank_account_no = '000111222333';
    if (!prof.bank_ifsc) patch.bank_ifsc = 'HDFC0000001';
    if (Object.keys(patch).length) ok(await api('put', '/br08/entity-profile', f.admin, patch));
    s.today = (await c.query(`SELECT to_char(br08_local_today($1),'YYYY-MM-DD') AS d`, [f.companyId])).rows[0].d;
    s.validity = (await c.query(`SELECT to_char(br08_local_today($1)+30,'YYYY-MM-DD') AS d`, [f.companyId])).rows[0].d;
  });

  afterAll(async () => {
    try {
      await c.query(`DELETE FROM br11_company_policies WHERE company_id=$1`, [f.companyId]);
      for (const r of savedPolicy) {
        await c.query(
          `INSERT INTO br11_company_policies(company_id,invoice_trigger,requires_full_payment_for_closure,note,updated_by_id,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [r.company_id, r.invoice_trigger, r.requires_full_payment_for_closure, r.note, r.updated_by_id, r.updated_at]);
      }
      await c.query(`DELETE FROM br08_gst_rate_config WHERE quote_line_type='PRODUCT_SALE'`);
      for (const r of savedGst) {
        await c.query(
          `INSERT INTO br08_gst_rate_config(id,quote_line_type,hsn_sac,cgst_rate,sgst_rate,igst_rate,is_active,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [r.id, r.quote_line_type, r.hsn_sac, r.cgst_rate, r.sgst_rate, r.igst_rate, r.is_active, r.created_at]);
      }
    } finally { await c?.end(); }
  });

  const enquiryBody = (customerId: string) => ({
    customer_id: customerId, enquiry_channel: 'EMAIL', enquiry_details: 'Need 6 x drive capacitors',
    source_evidence_uri: `s3://it/enq-${RUN}.eml`,
    lines: [{ product_description: 'Electrolytic capacitor', item_id: s.item, requested_qty: 6, uom: 'NOS', desired_condition: 'NEW' }],
  });
  const quoteTerms = { validity_until: '', payment_terms: 'Advance Rs 500, balance 30 days', delivery_terms: 'Ex-works BLR',
    warranty_terms: '3 months', tax_terms: 'GST extra as applicable' };
  const line = (item: string) => ({ item_id: item, product_condition: 'NEW', qty: 6, unit_price_paise: PRICE,
    list_unit_price_paise: 140000, manufacturer: 'IT Mfr', part_number: 'CAP-470' });

  // ============================================================== 11A enquiry + quote

  describe('11A enquiry -> quotation', () => {
    it('only SALES registers an enquiry; DB-numbered SE-<CODE>-000001', async () => {
      fails(await api('post', '/sales-enquiries', P(), enquiryBody(f.customerId)), 403);
      fails(await api('post', '/sales-enquiries', S(), { ...enquiryBody(f.customerId), enquiry_number: 'SE-FAKE-1' }), 400);
      s.enq = ok(await api('post', '/sales-enquiries', S(), enquiryBody(f.customerId)));
      expect(s.enq.enquiry_number).toMatch(/^SE-BLR-\d{6}$/);
      expect(s.enq.status).toBe('RECEIVED');
      expect(s.enq.lines).toHaveLength(1);
      // Sales & Supply desk: enriched enquiry row, customer name for every desk role (Finance included).
      const row = await deskRow('enquiries', s.enq.enquiry_number, F());
      expect(row).toMatchObject({ id: s.enq.id, status: 'RECEIVED', customer_id: f.customerId, line_count: 1, quote_count: 0, latest_quote_id: null });
      expect(row.customer_name).toBe(`IT Customer ${RUN}`);
      expect(row).toHaveProperty('sales_owner_name');
    });

    it('only PURCHASE prices a quote (SALES 403); quote numbered SQ-<CODE>-000001, separate from the BR-04 QT series', async () => {
      quoteTerms.validity_until = s.validity;
      fails(await api('post', '/sales-quotes', S(), { enquiry_id: s.enq.id, ...quoteTerms }), 403);
      s.quote = ok(await api('post', '/sales-quotes', P(), { enquiry_id: s.enq.id, ...quoteTerms }));
      expect(s.quote.quote_number).toMatch(/^SQ-BLR-\d{6}$/);
      s.rev0 = s.quote.revisions[0];
      expect(s.rev0).toMatchObject({ revision_no: 0, revision_status: 'DRAFT' });
      const enq = ok(await api('get', `/sales-enquiries/${s.enq.id}`, S()));
      expect(enq.status).toBe('QUOTED');
      fails(await api('post', `/sales-quote-revisions/${s.rev0.id}/lines`, S(), line(s.item)), 403);
      const q = await deskRow('quotes', s.quote.quote_number);
      expect(q).toMatchObject({
        quote_id: s.quote.id, stage: 'TO_PRICE', revision_no: 0, revision_status: 'DRAFT', revisions_count: 1, line_count: 0,
        total_paise: '0', enquiry_number: s.enq.enquiry_number, last_sent_at: null, latest_response_kind: null, sales_order_count: 0,
      });
      expect(await deskRow('enquiries', s.enq.enquiry_number)).toMatchObject({ status: 'QUOTED', quote_count: 1, latest_quote_id: s.quote.id });
    });

    it('A02: an unapproved Item Master item blocks quotation issue', async () => {
      ok(await api('post', `/sales-quote-revisions/${s.rev0.id}/lines`, P(), line(s.draftItem)));
      fails(await api('post', `/sales-quote-revisions/${s.rev0.id}/issue`, P()), 400, /APPROVED\/ACTIVE in the Item Master/);
      ok(await api('post', `/sales-quote-revisions/${s.rev0.id}/cancel`, P()));
    });

    it('A01: a PENDING customer can be quoted in draft but the issue is blocked (11A-03)', async () => {
      const enq = ok(await api('post', '/sales-enquiries', S(), enquiryBody(s.pendingCustomer)));
      const q = ok(await api('post', '/sales-quotes', P(), { enquiry_id: enq.id, ...quoteTerms }));
      ok(await api('post', `/sales-quote-revisions/${q.revisions[0].id}/lines`, P(), line(s.item)));
      fails(await api('post', `/sales-quote-revisions/${q.revisions[0].id}/issue`, P()), 400, /customer is APPROVED/);
    });

    it('revision 1 needs a reason; issued revision + its lines are immutable (API and DB)', async () => {
      fails(await api('post', `/sales-quotes/${s.quote.id}/revisions`, P(), { ...quoteTerms }), 400);
      const q = ok(await api('post', `/sales-quotes/${s.quote.id}/revisions`, P(), { ...quoteTerms, revision_reason: 'replace unapproved item' }));
      s.rev1 = q.revisions.find((r: any) => r.revision_no === 1);
      s.qline = ok(await api('post', `/sales-quote-revisions/${s.rev1.id}/lines`, P(), line(s.item)));
      expect(s.qline.line_total_paise).toBe(String(6 * PRICE));
      const issued = ok(await api('post', `/sales-quote-revisions/${s.rev1.id}/issue`, P()));
      expect(issued.revisions.find((r: any) => r.revision_no === 1).revision_status).toBe('ISSUED');
      // 11A-06: availability is display-only and comes from the ledger (fresh item = 0)
      expect(Number(issued.revisions.find((r: any) => r.revision_no === 1).lines[0].ledger_allocatable_qty)).toBe(0);

      fails(await api('post', `/sales-quote-revisions/${s.rev1.id}/lines`, P(), line(s.item)), 400, /immutable/);
      expect(await dbRejects(c, `UPDATE br11_quote_lines SET unit_price_paise=1 WHERE id=$1`, [s.qline.id])).toMatch(/immutable/);
      expect(await dbRejects(c, `UPDATE br11_quote_revisions SET validity_until=validity_until+1 WHERE id=$1`, [s.rev1.id])).toMatch(/immutable/);
    });

    it('SALES sends the issued quote and records the response (Purchase cannot)', async () => {
      // Desk stage follows the LATEST revision: rev 1 issued, not yet sent -> ISSUED, with rev 1's total.
      expect(await deskRow('quotes', s.quote.quote_number, S())).toMatchObject({
        stage: 'ISSUED', revision_no: 1, revision_status: 'ISSUED', revisions_count: 2, line_count: 1, total_paise: String(6 * PRICE),
      });
      fails(await api('post', `/sales-quote-revisions/${s.rev1.id}/dispatch`, P(), { channel: 'EMAIL', recipient: 'buyer@it.example' }), 403);
      ok(await api('post', `/sales-quote-revisions/${s.rev1.id}/dispatch`, S(), { channel: 'EMAIL', recipient: 'buyer@it.example' }));
      expect(await deskRow('quotes', s.quote.quote_number)).toMatchObject({ stage: 'WITH_CUSTOMER', last_sent_channel: 'EMAIL' });
      ok(await api('post', `/sales-quote-revisions/${s.rev1.id}/responses`, S(), { response_kind: 'ACCEPTED' }));
      const accepted = await desk('quotes', `stage=ACCEPTED&search=${encodeURIComponent(s.quote.quote_number)}`);
      expect(accepted.rows.map((r: any) => r.quote_id)).toEqual([s.quote.id]);
      expect(accepted.rows[0]).toMatchObject({ latest_response_kind: 'ACCEPTED' });
      expect((await desk('quotes', `stage=TO_PRICE&search=${encodeURIComponent(s.quote.quote_number)}`)).total).toBe(0);
    });

    it('Sales & Supply desk: desk roles only, company-scoped, filters validated, no supplier cost anywhere', async () => {
      for (const list of ['enquiries', 'quotes', 'orders', 'outwards']) {
        fails(await api('get', `/sales-supply/${list}`, f.stores), 403);
        fails(await api('get', `/sales-supply/${list}`, f.engineer), 403);
        const other = ok(await api('get', `/sales-supply/${list}?page_size=100&search=${encodeURIComponent(RUN)}`, s.bPurchase));
        expect(other.total).toBe(0);
      }
      fails(await api('get', '/sales-supply/quotes?stage=SENT', P()), 400);
      fails(await api('get', '/sales-supply/orders?status=OPEN', P()), 400);
      fails(await api('get', '/sales-supply/orders?page_size=101', P()), 400);
      const body = JSON.stringify(await desk('quotes', `search=${encodeURIComponent(s.quote.quote_number)}`));
      expect(body).not.toMatch(/quoted_unit_price|supplier|cost/);
    });

    it('A04: another company cannot read the quote', async () => {
      fails(await api('get', `/sales-quotes/${s.quote.id}`, s.bPurchase), 403);
    });
  });

  // ============================================================== 11B order

  describe('11B Sales Order -> verification -> payment terms', () => {
    it('SO lines = accepted quote lines only; qty <= quoted; price cannot be sent', async () => {
      fails(await api('post', '/sales-orders', S(), { quote_revision_id: s.rev1.id, lines: [{ quote_line_id: s.qline.id, accepted_qty: 7 }] }),
        400, /exceeds the quoted quantity/);
      fails(await api('post', '/sales-orders', S(), {
        quote_revision_id: s.rev1.id, lines: [{ quote_line_id: s.qline.id, accepted_qty: 6, unit_price_paise: 1 }] }), 400);
      fails(await api('post', '/sales-orders', S(), { quote_revision_id: s.rev0.id, lines: [{ quote_line_id: s.qline.id, accepted_qty: 6 }] }),
        400, /ISSUED quote revision/);
      s.so = ok(await api('post', '/sales-orders', S(), {
        quote_revision_id: s.rev1.id, customer_order_reference: `PO-${RUN}`, lines: [{ quote_line_id: s.qline.id, accepted_qty: 6 }] }));
      expect(s.so).toMatchObject({ status: 'DRAFT', sales_order_number: null });
      expect(s.so.lines[0]).toMatchObject({ unit_price_paise: String(PRICE) });
      s.sol = s.so.lines[0].sales_order_line_id;
    });

    it('verification: PURCHASE only, needs verified customer evidence; assigns SO-<CODE>-000001', async () => {
      fails(await api('post', `/sales-orders/${s.so.id}/authorisations`, S(), {
        source_kind: 'EMAIL_AUTHORISATION', received_at: new Date().toISOString(), evidence_uri: 's3://it/po.eml' }), 400, /check/i);
      const ev = ok(await api('post', `/sales-orders/${s.so.id}/authorisations`, S(), {
        source_kind: 'CUSTOMER_PO', source_reference: `PO-${RUN}`, received_at: new Date().toISOString(), evidence_uri: `s3://it/po-${RUN}.pdf` }));
      fails(await api('post', `/sales-orders/${s.so.id}/verify`, S(), { authorisation_event_id: ev.id }), 403);
      const v = ok(await api('post', `/sales-orders/${s.so.id}/verify`, P(), { authorisation_event_id: ev.id }));
      expect(v.status).toBe('VERIFIED');
      expect(v.sales_order_number).toMatch(/^SO-BLR-\d{6}$/);
      expect(await dbRejects(c, `UPDATE br11_sales_order_lines SET accepted_qty=1 WHERE id=$1`, [s.sol])).toMatch(/immutable/);
      expect(await dbRejects(c, `UPDATE br11_sales_orders SET status='DELIVERED' WHERE id=$1`, [s.so.id])).toMatch(/not allowed directly/);
    });

    it('11B-02: no blanket advance -- reservation waits for THIS order\'s recorded terms; a required advance needs Finance', async () => {
      fails(await api('post', `/sales-order-lines/${s.sol}/reservations`, P(), { qty: 2 }, { 'Idempotency-Key': idem() }),
        400, /payment terms .* not recorded/);
      fails(await api('post', `/sales-orders/${s.so.id}/payment-terms`, S(), {
        advance_kind: 'FIXED_AMOUNT', required_amount_paise: 50000, accepted_terms_evidence_uri: 's3://it/terms.pdf' }), 403);
      ok(await api('post', `/sales-orders/${s.so.id}/payment-terms`, P(), {
        advance_kind: 'FIXED_AMOUNT', required_amount_paise: 50000, accepted_terms_evidence_uri: 's3://it/terms.pdf' }));
      fails(await api('post', `/sales-order-lines/${s.sol}/reservations`, P(), { qty: 2 }, { 'Idempotency-Key': idem() }),
        400, /require an advance/);

      // Finance advances queue: the order's recorded terms need an advance Finance hasn't confirmed yet.
      const pending = await desk('orders', `advance_pending=true&search=${encodeURIComponent(`PO-${RUN}`)}`, F());
      expect(pending.rows.map((r: any) => r.id)).toEqual([s.so.id]);
      expect(pending.rows[0]).toMatchObject({
        advance_kind: 'FIXED_AMOUNT', advance_required_amount_paise: '50000', advance_required_percent: null, advance_cleared: false,
        advance_confirmed_at: null,
      });
      expect(pending.rows[0].payment_terms_recorded_at).toBeTruthy();
      expect(pending.rows[0].payment_terms_recorded_by_name).toBeTruthy();
      expect((await desk('orders', `advance_pending=false&search=${encodeURIComponent(`PO-${RUN}`)}`, F())).total).toBe(0);
      fails(await api('get', '/sales-supply/orders?advance_pending=maybe', F()), 400);

      s.advanceReceipt = ok(await api('post', '/payments', F(), {
        customer_id: f.customerId, amount_paise: 50000, received_on: s.today, payment_mode: 'NEFT', payment_reference: `ADV-${RUN}` }));
      // Receipt list (the advance picker): full coverage available before any confirmation; Finance / Management only.
      fails(await api('get', `/payments?customer_id=${f.customerId}`, P()), 403);
      fails(await api('get', `/payments?customer_id=${f.customerId}`, S()), 403);
      const before = ok(await api('get', `/payments?customer_id=${f.customerId}&search=${encodeURIComponent(`ADV-${RUN}`)}`, F()));
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0]).toMatchObject({
        id: s.advanceReceipt.id, amount_paise: '50000', unallocated_paise: '50000', advance_backed_paise: '0',
        available_for_advance_paise: '50000', customer_name: `IT Customer ${RUN}`,
      });
      fails(await api('post', `/sales-orders/${s.so.id}/payment-terms/confirm-advance`, P(), {
        br08_receipt_id: s.advanceReceipt.id, finance_confirmation_reference: 'bank stmt' }), 403);
      const t = ok(await api('post', `/sales-orders/${s.so.id}/payment-terms/confirm-advance`, F(), {
        br08_receipt_id: s.advanceReceipt.id, finance_confirmation_reference: `bank stmt ${RUN}` }));
      expect(t.finance_confirmed_at).toBeTruthy();
      const after = ok(await api('get', `/payments?customer_id=${f.customerId}&search=${encodeURIComponent(`ADV-${RUN}`)}`, F()));
      expect(after.rows[0]).toMatchObject({ advance_backed_paise: '50000', available_for_advance_paise: '0', unallocated_paise: '50000' });
      expect((await desk('orders', `advance_pending=true&search=${encodeURIComponent(`PO-${RUN}`)}`, F())).total).toBe(0);
      const o = await deskRow('orders', `PO-${RUN}`, F());
      expect(o).toMatchObject({
        id: s.so.id, status: 'VERIFIED', quote_id: s.quote.id, quote_number: s.quote.quote_number, quote_revision_no: 1,
        customer_order_reference: `PO-${RUN}`, order_total_paise: String(6 * PRICE), lines_total: 1, lines_reserved: 0,
        lines_shipped: 0, lines_delivered: 0, lines_invoiced: 0, pending_authorisations: 0, payment_terms_recorded: true,
        advance_kind: 'FIXED_AMOUNT', advance_cleared: true, open_change_requests: 0, outward_count: 0,
      });
      expect(o.sales_order_number).toMatch(/^SO-BLR-\d{6}$/);
      s.soNumber = o.sales_order_number;
      expect((await deskRow('quotes', s.quote.quote_number)).sales_order_count).toBe(1);
    });
  });

  // ============================================================== 11B stock + BR-06 SALES_ORDER

  describe('11B stock: real ledger reservation + BR-06 SALES_ORDER supplier PO', () => {
    it('no stock yet: the ledger rejects the reservation and the request is recorded FAILED', async () => {
      fails(await api('post', `/sales-order-lines/${s.sol}/reservations`, P(), { qty: 2 }, { 'Idempotency-Key': idem() }),
        409, /INSUFFICIENT_STOCK/);
      const so = ok(await api('get', `/sales-orders/${s.so.id}`, S()));
      expect(so.reservations.map((r: any) => r.state)).toEqual(['FAILED']);
    });

    it('B07: a non-L1 supplier needs MD approval evidence; sourcing qty is capped by the order line; Purchase only', async () => {
      const body = { quantity: 6, supplier_name: `IT Supplier ${RUN}`, supplier_unit_price: 800, supplier_offer_evidence_uri: 's3://it/offer.pdf',
        comparison_evidence_uri: 's3://it/cmp.xlsx', selected_rank: 1 };
      fails(await api('post', `/sales-order-lines/${s.sol}/sourcing-authorisations`, S(), body), 403);
      fails(await api('post', `/sales-order-lines/${s.sol}/sourcing-authorisations`, P(), { ...body, selected_rank: 2 }), 400, /check/i);
      fails(await api('post', `/sales-order-lines/${s.sol}/sourcing-authorisations`, P(), { ...body, quantity: 7 }), 400, /exceeds the accepted/);
      s.sourcing = ok(await api('post', `/sales-order-lines/${s.sol}/sourcing-authorisations`, P(), body));
      fails(await api('get', `/sales-orders/${s.so.id}/sourcing-authorisations`, S()), 403); // supplier cost: never to Sales
    });

    it('B06: SALES_ORDER PO on the same PO series, no repair Job ID; purpose/source CHECKs hold (B08 regression)', async () => {
      s.po = ok(await api('post', `/sales-orders/${s.so.id}/purchase-orders`, P(), { sourcing_authorisation_ids: [s.sourcing.id] }));
      expect(s.po).toMatchObject({ purchase_purpose: 'SALES_ORDER', job_id: null, source_br05_job_release_id: null,
        supplier_invite_id: null, sales_order_id: s.so.id });
      expect(s.po.po_number).toMatch(/^PO-BLR-\d{6}$/);
      expect(s.po.lines[0]).toMatchObject({ source_br04_offer_line_id: null, sales_sourcing_authorisation_id: s.sourcing.id });
      // CUSTOMER_JOB rows still need their job/release/invite; SALES_ORDER rows must not carry them
      expect(await dbRejects(c,
        `INSERT INTO br06_supplier_purchase_orders(company_id,po_number,supplier_name_snapshot,created_by_id,purchase_purpose)
         VALUES ($1,'IT-X','x',$2,'CUSTOMER_JOB')`, [f.companyId, f.purchase])).toMatch(/br06_po_purpose_source_check/);
      expect(await dbRejects(c,
        `INSERT INTO br06_po_lines(po_id,line_no,item_bridge_id,quantity,uom,unit_price) VALUES ($1,9,$2,1,'NOS',1)`,
        [s.po.id, s.bridge])).toMatch(/br06_po_line_source_check|sourcing authorisation/);
      fails(await api('post', `/sales-orders/${s.so.id}/purchase-orders`, P(), { sourcing_authorisation_ids: [s.sourcing.id] }), 400);
    });

    it('B09: supplier goods become saleable only after the BR-06 GRN posts to the ledger', async () => {
      ok(await api('post', `/purchase-orders/${s.po.id}/release`, P()));
      ok(await api('post', `/purchase-orders/${s.po.id}/acknowledge`, P(), { supplier_reference: `ACK-${RUN}` }));
      const grn = ok(await api('post', `/purchase-orders/${s.po.id}/grns`, f.stores, { lines: [{ po_line_id: s.po.lines[0].id, received_quantity: 6 }] }));
      expect((await balances(f.companyId, s.item, P())).allocatable).toBe(0);
      ok(await api('post', `/grn-lines/${grn.lines[0].id}/media`, f.stores, { file_uri: `s3://it/grn-${RUN}.jpg`, file_name: 'grn.jpg' }));
      ok(await api('post', `/grn-lines/${grn.lines[0].id}/post`, f.stores, { accepted_quantity: 6, rejected_quantity: 0, held_quantity: 0 }));
      expect(await balances(f.companyId, s.item, P())).toMatchObject({ main: 6, allocatable: 6 });
    });

    it('B04: reserve 4 through fdn_reserve; the same Idempotency-Key returns the same request (no double reservation)', async () => {
      const key = idem();
      s.resA = ok(await api('post', `/sales-order-lines/${s.sol}/reservations`, P(), { qty: 4 }, { 'Idempotency-Key': key }));
      expect(s.resA.state).toBe('CONFIRMED');
      const again = ok(await api('post', `/sales-order-lines/${s.sol}/reservations`, P(), { qty: 4 }, { 'Idempotency-Key': key }));
      expect(again.id).toBe(s.resA.id);
      expect((await balances(f.companyId, s.item, P())).allocatable).toBe(2);
      const led = (await c.query(`SELECT * FROM fdn_inventory_reservations WHERE id=$1`, [s.resA.ledger_reservation_id])).rows[0];
      expect(led).toMatchObject({ status: 'ACTIVE', reference_kind: 'BR11_SALES_RESERVATION', reference_id: s.resA.id });
      expect(Number(led.qty)).toBe(4);
    });

    it('CONFIRMED cannot be self-attested: the DB checks the real ledger reservation', async () => {
      const msg = await dbRejects(c, `DO $$ DECLARE v uuid; BEGIN
          INSERT INTO br11_inventory_reservation_requests(company_id,sales_order_line_id,requested_qty,client_idempotency_key,requested_by_id)
          VALUES ('${f.companyId}','${s.sol}',1,'forge-${RUN}','${f.purchase}') RETURNING id INTO v;
          UPDATE br11_inventory_reservation_requests SET state='CONFIRMED', ledger_reservation_id='${s.resA.ledger_reservation_id}' WHERE id=v;
        END $$`);
      expect(msg).toMatch(/matching ACTIVE reservation in the inventory ledger/);
    });

    it('cumulative reservations cannot exceed the accepted qty; another company is denied', async () => {
      fails(await api('post', `/sales-order-lines/${s.sol}/reservations`, P(), { qty: 3 }, { 'Idempotency-Key': idem() }),
        400, /exceed the accepted quantity/);
      fails(await api('post', `/sales-order-lines/${s.sol}/reservations`, s.bPurchase, { qty: 1 }, { 'Idempotency-Key': idem() }), 403);
      fails(await api('get', `/sales-orders/${s.so.id}`, s.bPurchase), 403);
      s.resB = ok(await api('post', `/sales-order-lines/${s.sol}/reservations`, P(), { qty: 2 }, { 'Idempotency-Key': idem() }));
      expect((await balances(f.companyId, s.item, P())).allocatable).toBe(0);
    });
  });

  // ============================================================== 11C outward + POD

  describe('11C outward -> proof of delivery', () => {
    const outwardBody = (resv: string) => ({
      customer_id: f.customerId, dispatch_mode: 'COURIER', carrier_name: 'IT Courier', recipient_name: 'Stores, IT Customer',
      destination_address: 'IT customer site, Peenya', lines: [{ reservation_request_id: resv }],
    });

    it('C01: dispatch is blocked without a packing PHOTO (and nothing leaves the ledger)', async () => {
      s.out1 = ok(await api('post', '/sales-outwards', P(), outwardBody(s.resA.id)));
      s.oline1 = s.out1.lines[0].id;
      expect(Number(s.out1.lines[0].outward_qty)).toBe(4);
      ok(await api('post', `/sales-outward-lines/${s.oline1}/pick`, P(), { verification_note: 'part no + qty 4 checked' }));
      fails(await api('post', `/sales-outwards/${s.out1.id}/dispatch`, P(), {}), 400, /PHOTO/);
      expect((await balances(f.companyId, s.item, P())).main).toBe(6);
      const draft = (await desk('outwards', `status=DRAFT&search=${encodeURIComponent(s.soNumber)}`)).rows.find((r: any) => r.id === s.out1.id);
      expect(draft).toMatchObject({
        status: 'DRAFT', outward_number: null, carrier_name: 'IT Courier', lines_total: 1, lines_picked: 1,
        lines_with_packing_evidence: 0, lines_delivered: 0, sales_orders: [{ sales_order_id: s.so.id, sales_order_number: s.soNumber }],
      });
    });

    it('C03: dispatch posts a ledger ISSUE out of MAIN, consumes the reservation (no double count), numbers SOUT-<CODE>-000001', async () => {
      fails(await api('post', `/sales-outward-lines/${s.oline1}/packing-evidence`, S(),
        { evidence_kind: 'PHOTO', file_uri: 's3://it/pack.jpg', file_name: 'pack.jpg' }), 403);
      ok(await api('post', `/sales-outward-lines/${s.oline1}/packing-evidence`, P(),
        { evidence_kind: 'PHOTO', file_uri: `s3://it/pack-${RUN}.jpg`, file_name: 'pack.jpg' }));
      const d = ok(await api('post', `/sales-outwards/${s.out1.id}/dispatch`, P(), { tracking_reference: `AWB-${RUN}` }));
      expect(d.status).toBe('DISPATCHED');
      expect(d.outward_number).toMatch(/^SOUT-BLR-\d{6}$/);
      expect(await balances(f.companyId, s.item, P())).toMatchObject({ main: 2, allocatable: 0 });
      const j = (await c.query(`SELECT * FROM fdn_inventory_journal WHERE id=$1`, [d.lines[0].inventory_issue_ref])).rows[0];
      expect(j).toMatchObject({ movement_type: 'ISSUE', reference_kind: 'BR11_SALE_ISSUE', reference_id: s.oline1, to_location_id: null });
      const led = (await c.query(`SELECT status FROM fdn_inventory_reservations WHERE id=$1`, [s.resA.ledger_reservation_id])).rows[0];
      expect(led.status).toBe('CONSUMED');
      expect(await deskRow('outwards', d.outward_number, S())).toMatchObject({
        id: s.out1.id, status: 'DISPATCHED', tracking_reference: `AWB-${RUN}`, lines_with_packing_evidence: 1, customer_name: `IT Customer ${RUN}`,
      });
      expect(await deskRow('orders', s.soNumber)).toMatchObject({ lines_reserved: 1, lines_shipped: 0, outward_count: 1 });
    });

    it('C02: a reservation ships once; a dispatched batch is immutable', async () => {
      fails(await api('post', '/sales-outwards', P(), outwardBody(s.resA.id)), 400, /CONFIRMED reservation/);
      expect(await dbRejects(c, `UPDATE br11_outward_batches SET status='CANCELLED' WHERE id=$1`, [s.out1.id])).toMatch(/immutable/);
    });

    it('C04: POD is line-specific, <= shipped; order becomes PART_DELIVERED (derived, not set)', async () => {
      const pod = { delivery_status: 'DELIVERED', received_by_name: 'IT Stores', delivered_at: new Date().toISOString(), pod_uri: `s3://it/pod1-${RUN}.pdf` };
      fails(await api('post', `/sales-outward-lines/${s.oline1}/delivery`, P(), { ...pod, delivered_qty: 5 }), 400, /exceeds the shipped/);
      fails(await api('post', `/sales-outward-lines/${s.oline1}/delivery`, P(), { delivery_status: 'DELIVERED', delivered_qty: 4 }), 400);
      ok(await api('post', `/sales-outward-lines/${s.oline1}/delivery`, P(), { ...pod, delivered_qty: 4 }));
      const so = ok(await api('get', `/sales-orders/${s.so.id}`, S()));
      expect(so.status).toBe('PART_DELIVERED');
      expect(so.lines[0]).toMatchObject({ line_status: 'PART_DELIVERED' });
      expect(Number(so.lines[0].delivered_qty)).toBe(4);
      expect(Number(so.lines[0].outstanding_delivery_qty)).toBe(2);
    });
  });

  // ============================================================== BR-08 PRODUCT_SALES

  describe('BR-08 PRODUCT_SALES invoice (same series, no repair Job ID)', () => {
    it('C08: invoicing is BLOCKED while the trigger (11C-07) and product GST rate (P-12) are unconfigured; config is SYSTEM_ADMIN only', async () => {
      fails(await api('post', '/sales-invoices/preview', F(), { sales_order_id: s.so.id }), 400, /CLIENT-UNCONFIRMED.*invoice trigger/);
      // Invoice queue mirrors the same gate: every row BLOCKED, with the server's reason; Finance / Management only.
      for (const actor of [P(), S()]) fails(await api('get', '/sales-supply/invoice-queue', actor), 403);
      const q0 = await desk('invoice-queue', `search=${encodeURIComponent(s.soNumber)}`, F());
      expect(q0.config).toMatchObject({ invoice_trigger: null, blocked: true });
      expect(q0.rows).toHaveLength(1);
      expect(q0.rows[0]).toMatchObject({ sales_order_id: s.so.id, readiness: 'BLOCKED', invoiceable_taxable_paise: '0' });
      expect(q0.rows[0].blocked_reason).toMatch(/11C-07/);
      fails(await api('put', '/sales-config/policy', P(), { invoice_trigger: 'DELIVERY' }), 403);
      // test-only assignment (restored in afterAll) -- NOT a decision about the trigger
      ok(await api('put', '/sales-config/policy', f.admin, { invoice_trigger: 'DELIVERY', note: `integrity ${RUN}` }));
      fails(await api('post', '/sales-invoices/preview', F(), { sales_order_id: s.so.id }), 400, /PRODUCT_SALE GST rate/);
      const q1 = await desk('invoice-queue', `search=${encodeURIComponent(s.soNumber)}`, F());
      expect(q1.config).toMatchObject({ invoice_trigger: 'DELIVERY', product_gst_rate_configured: false, blocked: true });
      expect(q1.rows[0].blocked_reason).toMatch(/P-12/);
      await c.query(`INSERT INTO br08_gst_rate_config(quote_line_type,hsn_sac,cgst_rate,sgst_rate,igst_rate) VALUES ('PRODUCT_SALE','8532',9,9,18)`);
      const cfg = ok(await api('get', '/sales-config', S()));
      expect(cfg.blocked).toEqual({ product_invoicing: false, order_closure: true });
    });

    it('invoiceable = POD-delivered under DELIVERY; GST server-derived; Finance only', async () => {
      const pv = ok(await api('post', '/sales-invoices/preview', F(), { sales_order_id: s.so.id }));
      // The queue agrees with the preview: 4 delivered of 6 -> READY for 4 x PRICE, triggered by the SOUT's POD.
      const ready = await desk('invoice-queue', `readiness=READY&search=${encodeURIComponent(s.soNumber)}`, F());
      expect(ready.config).toMatchObject({ invoice_trigger: 'DELIVERY', product_gst_rate_configured: true, blocked: false });
      expect(ready.rows).toHaveLength(1);
      expect(ready.rows[0]).toMatchObject({
        sales_order_id: s.so.id, readiness: 'READY', blocked_reason: null, tax_regime: pv.tax_regime,
        invoiceable_taxable_paise: String(4 * PRICE), uninvoiced_taxable_paise: String(6 * PRICE), lines_total: 1,
        lines_invoiceable: 1, invoices_count: 0, trigger_event_kind: 'DELIVERED',
      });
      expect(ready.rows[0].trigger_event_ref).toMatch(/^SOUT-BLR-\d{6}$/);
      expect(Number(ready.rows[0].invoiceable_taxable_paise)).toBe(Number(pv.sub_total_paise));
      expect(pv).toMatchObject({ invoice_type: 'PRODUCT_SALES', tax_regime: 'INTRA_STATE', sub_total_paise: 4 * PRICE,
        cgst_paise: 45000, sgst_paise: 45000, igst_paise: 0, total_paise: 590000, jobs: [] });
      expect(pv.lines[0]).toMatchObject({ hsn_sac: '8532', quantity: 4 });
      fails(await api('post', '/sales-invoices/preview', F(), { sales_order_id: s.so.id, lines: [{ sales_order_line_id: s.sol, quantity: 5 }] }),
        400, /exceeds the invoiceable quantity/);
      fails(await api('post', '/sales-invoices', P(), { sales_order_id: s.so.id }, { 'Idempotency-Key': idem() }), 403);
    });

    it('C05/C06/C07: issued on the BR-08 INV series as PRODUCT_SALES with no Job rows; same key returns the same invoice', async () => {
      const key = idem();
      s.inv1 = ok(await api('post', '/sales-invoices', F(), { sales_order_id: s.so.id }, { 'Idempotency-Key': key }));
      expect(s.inv1).toMatchObject({ invoice_type: 'PRODUCT_SALES', invoice_status: 'ISSUED', total_paise: '590000', jobs: [], lines: [] });
      expect(s.inv1.invoice_number).toMatch(/^BIAPL\/\d+\/\d{2}-\d{2}$/);
      expect(s.inv1.sales_lines).toHaveLength(1);
      expect(s.inv1.sales_source).toMatchObject({ sales_order_id: s.so.id, invoice_trigger_snapshot: 'DELIVERY' });
      const again = ok(await api('post', '/sales-invoices', F(), { sales_order_id: s.so.id }, { 'Idempotency-Key': key }));
      expect(again.id).toBe(s.inv1.id);
      fails(await api('post', '/sales-invoices', F(), { sales_order_id: s.so.id }, { 'Idempotency-Key': idem() }), 400, /nothing to invoice/);
      // Remaining 2 not delivered yet -> WAITING with the un-invoiced value; counts reflect it.
      const waiting = await desk('invoice-queue', `search=${encodeURIComponent(s.soNumber)}`, F());
      expect(waiting.rows[0]).toMatchObject({
        readiness: 'WAITING', invoiceable_taxable_paise: '0', uninvoiced_taxable_paise: String(2 * PRICE), invoices_count: 1,
      });
      expect(waiting.counts_by_readiness).toEqual({ READY: 0, WAITING: 1, BLOCKED: 0 });
      // the INV counter is BR-08's: the latest number for this FY is this invoice
      const ctr = (await c.query(`SELECT last_value FROM br08_fy_counters WHERE company_id=$1 AND doc_kind='INV' AND fiscal_year=$2`,
        [f.companyId, s.inv1.fiscal_year])).rows[0];
      expect(String(ctr.last_value)).toBe(String(s.inv1.invoice_seq));
      // no fabricated repair Job ID can ever be attached, and the invoice is sealed
      expect(await dbRejects(c, `INSERT INTO br08_invoice_lines(invoice_id,line_no,job_id,source_quote_line_id,line_type,description,hsn_sac,
          quantity,uom,unit_price,taxable_paise,cgst_rate,sgst_rate,igst_rate,cgst_paise,sgst_paise,igst_paise,line_total_paise)
          SELECT $1,9,id,(SELECT id FROM br04_customer_quote_lines LIMIT 1),'X','x','998732',1,'NOS',1,1,0,0,0,0,0,0,1 FROM service_jobs LIMIT 1`,
        [s.inv1.id])).toMatch(/PRODUCT_SALES invoice carries no repair Job ID|immutable|null value/);
      expect(await dbRejects(c, `UPDATE br08_invoice_sales_lines SET quantity=1 WHERE invoice_id=$1`, [s.inv1.id])).toMatch(/append|immutable|not allowed|mutation/i);
    });
  });

  // ============================================================== change requests

  describe('11B-10 change requests (Purchase decides)', () => {
    it('cancellation after shipment is refused (no sales-return path); Sales cannot decide', async () => {
      const cr = ok(await api('post', `/sales-orders/${s.so.id}/change-requests`, S(), {
        sales_order_line_id: s.sol, change_kind: 'CANCELLATION', reason: 'customer asks to cancel' }));
      fails(await api('post', `/sales-change-requests/${cr.id}/decide`, S(), { decision: 'APPROVED' }), 403);
      fails(await api('post', `/sales-change-requests/${cr.id}/decide`, P(), { decision: 'APPROVED' }), 400, /outward stock/);
      ok(await api('post', `/sales-change-requests/${cr.id}/decide`, P(), { decision: 'REJECTED', decision_note: 'already shipped' }));
    });

    it('an approved CANCELLATION of an untouched verified order cancels it (DB-derived)', async () => {
      const so2 = ok(await api('post', '/sales-orders', S(), { quote_revision_id: s.rev1.id, lines: [{ quote_line_id: s.qline.id, accepted_qty: 1 }] }));
      const ev = ok(await api('post', `/sales-orders/${so2.id}/authorisations`, S(), {
        source_kind: 'ORDER_CONFIRMATION', received_at: new Date().toISOString(), evidence_uri: `s3://it/oc-${RUN}.pdf` }));
      ok(await api('post', `/sales-orders/${so2.id}/verify`, P(), { authorisation_event_id: ev.id }));
      const cr = ok(await api('post', `/sales-orders/${so2.id}/change-requests`, S(), { change_kind: 'CANCELLATION', reason: 'duplicate order' }));
      const d = ok(await api('post', `/sales-change-requests/${cr.id}/decide`, P(), { decision: 'APPROVED' }));
      expect(d.order.status).toBe('CANCELLED');
      expect(d.order.lines[0].line_status).toBe('CANCELLED');
    });
  });

  // ============================================================== second shipment + closure

  describe('11C-09 closure review', () => {
    it('second shipment of the remaining 2 -> DELIVERED; second invoice for the remainder', async () => {
      const out2 = ok(await api('post', '/sales-outwards', P(), {
        customer_id: f.customerId, dispatch_mode: 'CUSTOMER_PICKUP', recipient_name: 'IT driver', destination_address: 'collected at BLR',
        lines: [{ reservation_request_id: s.resB.id }] }));
      const l2 = out2.lines[0].id;
      ok(await api('post', `/sales-outward-lines/${l2}/packing-evidence`, P(), { evidence_kind: 'PHOTO', file_uri: `s3://it/p2-${RUN}.jpg`, file_name: 'p2.jpg' }));
      ok(await api('post', `/sales-outward-lines/${l2}/pick`, P(), { verification_note: 'qty 2 checked' }));
      ok(await api('post', `/sales-outwards/${out2.id}/dispatch`, P(), {}));
      ok(await api('post', `/sales-outward-lines/${l2}/delivery`, P(), {
        delivery_status: 'DELIVERED', delivered_qty: 2, received_by_name: 'IT driver', delivered_at: new Date().toISOString(), pod_uri: `s3://it/pod2-${RUN}.pdf` }));
      const so = ok(await api('get', `/sales-orders/${s.so.id}`, S()));
      expect(so.status).toBe('DELIVERED');
      expect(await balances(f.companyId, s.item, P())).toMatchObject({ main: 0, allocatable: 0 });
      s.inv2 = ok(await api('post', '/sales-invoices', F(), { sales_order_id: s.so.id }, { 'Idempotency-Key': idem() }));
      expect(s.inv2.total_paise).toBe('295000');
      expect(Number(s.inv2.invoice_seq)).toBe(Number(s.inv1.invoice_seq) + 1);
    });

    it('closure is BLOCKED until payment-before-closure (11C-09) is configured; Purchase only', async () => {
      fails(await api('post', `/sales-orders/${s.so.id}/close`, S(), { closure_reason: 'done' }), 403);
      fails(await api('post', `/sales-orders/${s.so.id}/close`, P(), { closure_reason: 'done' }), 400, /CLIENT-UNCONFIRMED.*full payment/);
      // test-only assignment (restored in afterAll)
      ok(await api('put', '/sales-config/policy', f.admin, { requires_full_payment_for_closure: true }));
      fails(await api('post', `/sales-orders/${s.so.id}/close`, P(), { closure_reason: 'done' }), 400, /not PAID in BR-08/);
    });

    it('C10: once BR-08 receipts settle both invoices, Purchase closes; flags are DB-computed; closed is terminal', async () => {
      ok(await api('post', `/payments/${s.advanceReceipt.id}/allocations`, F(), { invoice_id: s.inv1.id, amount_paise: 50000 }));
      ok(await api('post', '/payments', F(), { customer_id: f.customerId, amount_paise: 540000, received_on: s.today, payment_mode: 'NEFT',
        allocations: [{ invoice_id: s.inv1.id, amount_paise: 540000 }] }));
      ok(await api('post', '/payments', F(), { customer_id: f.customerId, amount_paise: 295000, received_on: s.today, payment_mode: 'NEFT',
        allocations: [{ invoice_id: s.inv2.id, amount_paise: 295000 }] }));
      const closed = ok(await api('post', `/sales-orders/${s.so.id}/close`, P(), { closure_reason: `delivered, billed and paid ${RUN}` }));
      expect(closed.status).toBe('CLOSED');
      expect(closed.closure_review).toMatchObject({ delivery_verified: true, billing_verified: true, payment_required: true, payment_verified: true });
      expect(closed.closure_review.finance_evidence).toHaveLength(2);
      expect(await deskRow('orders', s.soNumber, F())).toMatchObject({
        status: 'CLOSED', lines_reserved: 1, lines_shipped: 1, lines_delivered: 1, lines_invoiced: 1, outward_count: 2,
      });
      const counts = (await desk('orders', `search=${encodeURIComponent(s.soNumber)}`)).counts_by_status;
      expect(counts).toEqual({ DRAFT: 0, VERIFIED: 0, PART_DELIVERED: 0, DELIVERED: 0, CANCELLED: 0, CLOSED: 1 });
      expect(await dbRejects(c, `UPDATE br11_sales_orders SET status='DELIVERED' WHERE id=$1`, [s.so.id])).toMatch(/CLOSED Sales Order cannot change/);
    });
  });

  // ============================================================== source-of-truth

  describe('source-of-truth: no duplicate ledger / counter / billing, no fabricated Job IDs', () => {
    it('BR-11 created no stock/invoice/receipt/counter tables of its own and no service_jobs rows', async () => {
      const own = (await c.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public'
           AND table_name ~ '^br11_.*(counter|ledger|journal|balance|invoice|receipt|allocation)'`)).rows;
      expect(own).toEqual([]);
      const kinds = (await c.query(
        `SELECT number_kind FROM company_number_counters WHERE company_id=$1 AND number_kind IN ('SE','SQ','SO','SOUT') ORDER BY 1`,
        [f.companyId])).rows.map((r) => r.number_kind);
      expect(kinds).toEqual(['SE', 'SO', 'SOUT', 'SQ']);
      const jobsAfter = (await c.query(`SELECT count(*)::int AS n FROM service_jobs WHERE company_id=$1`, [f.companyId])).rows[0].n;
      expect(jobsAfter).toBe(jobsBefore);
      const movements = (await c.query(
        `SELECT reference_kind, sum(qty)::int AS q FROM fdn_inventory_journal WHERE company_id=$1 AND item_id=$2 GROUP BY 1 ORDER BY 1`,
        [f.companyId, s.item])).rows;
      expect(movements).toEqual([{ reference_kind: 'BR06_GRN_LINE', q: 6 }, { reference_kind: 'BR11_SALE_ISSUE', q: 6 }]);
    });
  });
});
