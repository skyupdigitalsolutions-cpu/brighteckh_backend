import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgService } from '../../common/database/pg.service';
import { InventoryService } from '../inventory/inventory.service';
import {
  ChangeRequestDto, CloseOrderDto, ConfirmAdvanceDto, CreateEnquiryDto, CreateOutwardDto, CreateRevisionDto,
  CreateSalesOrderDto, CreateSalesQuoteDto, DecideChangeRequestDto, DeliveryEvidenceDto, DispatchOutwardDto,
  ListQueryDto, OrderAuthorisationDto, PackingEvidenceDto, PaymentTermsDto, PickDto, QuoteDispatchDto, QuoteLineDto,
  QuoteResponseDto, ReasonDto, ReserveDto, SalesPolicyDto, TrackingEventDto, VerifyOrderDto,
} from './dto/br11.dto';

interface Actor { id: string; role: string; companyId: string }
type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

/**
 * BR-11 Sales & Supply: product enquiry -> quotation -> Sales Order -> stock
 * reservation -> outward -> proof of delivery -> (BR-08 invoice) -> closure.
 *
 * BR-11 owns ONLY sale orders + fulfilment records (migration 018). Every
 * business rule (roles, quantities, immutability, numbering, derived statuses,
 * advance gate, closure checks) is enforced by DB triggers; this service checks
 * company ownership, orchestrates the inventory-ledger calls and writes audit rows.
 *
 * Stock: only through InventoryService (fdn_reserve / fdn_post_movement), same
 * request -> ledger -> confirm pattern as BR-05/BR-07. Supplier PO: BR-06
 * (SALES_ORDER purpose). Invoice / receipts / credit notes: BR-08 (PRODUCT_SALES).
 * No service_jobs row is ever created here (11C-01).
 */
@Injectable()
export class Br11Service {
  constructor(private readonly pg: PgService, private readonly inventory: InventoryService) {}

  private rethrow(e: unknown): never {
    if (e instanceof HttpException) throw e;
    throw new BadRequestException((e as Error).message || 'request failed');
  }

  private async audit(client: PoolClient, actor: Actor, table: string, id: string, action: string, before: unknown, after: unknown) {
    await client.query(
      `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor.companyId, actor.id, table, id, action, before ?? null, after ?? null],
    );
  }

  /** Load a company-owned row or throw 404/403. */
  private async owned(client: Queryable, table: string, id: string, actor: Actor, lock = false) {
    const r = await client.query(`SELECT * FROM ${table} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!r.rows[0]) throw new NotFoundException(`${table.replace(/^br11_/, '').replace(/_/g, ' ')} not found`);
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('record belongs to another company');
    return r.rows[0];
  }

  private async write<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    try { return await this.pg.tx(fn); } catch (e) { this.rethrow(e); }
  }

  // ================================================================ config

  async getConfig(actor: Actor) {
    const [policy, gst] = await Promise.all([
      this.pg.query(`SELECT * FROM br11_company_policies WHERE company_id=$1`, [actor.companyId]),
      this.pg.query(`SELECT * FROM br08_gst_rate_config WHERE is_active AND quote_line_type='PRODUCT_SALE'`),
    ]);
    const p = policy.rows[0] ?? null;
    return {
      policy: p,
      product_gst_rate: gst.rows[0] ?? null,
      blocked: {
        product_invoicing: !p?.invoice_trigger || p.invoice_trigger === 'MILESTONE' || !gst.rows[0],
        order_closure: p?.requires_full_payment_for_closure == null,
      },
      note: 'Invoice trigger (11C-07), payment-before-closure (11C-09), advance policy (11B-02) and product GST rate (P-12) are '
        + 'never defaulted: unset = blocked. Product HSN comes from each item (fdn_item_master.hsn_tax) when the rate row has none.',
    };
  }

  async setPolicy(dto: SalesPolicyDto, actor: Actor) {
    await this.write(async (c) => {
      const before = (await c.query(`SELECT * FROM br11_company_policies WHERE company_id=$1`, [actor.companyId])).rows[0];
      const after = (await c.query(
        `INSERT INTO br11_company_policies(company_id,invoice_trigger,requires_full_payment_for_closure,note,updated_by_id,advance_policy)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (company_id) DO UPDATE SET invoice_trigger=EXCLUDED.invoice_trigger,
           requires_full_payment_for_closure=EXCLUDED.requires_full_payment_for_closure, note=EXCLUDED.note,
           advance_policy=EXCLUDED.advance_policy,
           updated_by_id=EXCLUDED.updated_by_id, updated_at=now()
         RETURNING *`,
        [actor.companyId,
          dto.invoice_trigger !== undefined ? dto.invoice_trigger : (before?.invoice_trigger ?? null),
          dto.requires_full_payment_for_closure !== undefined ? dto.requires_full_payment_for_closure
            : (before?.requires_full_payment_for_closure ?? null),
          dto.note ?? null, actor.id,
          dto.advance_policy !== undefined ? dto.advance_policy : (before?.advance_policy ?? null)])).rows[0];
      await this.audit(c, actor, 'br11_company_policies', actor.companyId, 'BR11_POLICY_CONFIGURED', before ?? null, after);
    });
    return this.getConfig(actor);
  }

  // ================================================================ 11A enquiry

  async createEnquiry(dto: CreateEnquiryDto, actor: Actor) {
    const id = await this.write(async (c) => {
      await this.owned(c, 'customers', dto.customer_id, actor);
      const e = (await c.query(
        `INSERT INTO br11_sales_enquiries(company_id,enquiry_number,customer_id,enquiry_channel,enquiry_details,
           source_evidence_uri,sales_owner_id)
         VALUES ($1,'pending',$2,$3,$4,$5,$6) RETURNING *`,
        [actor.companyId, dto.customer_id, dto.enquiry_channel, dto.enquiry_details, dto.source_evidence_uri ?? null, actor.id],
      )).rows[0];
      let n = 1;
      for (const l of dto.lines) {
        await c.query(
          `INSERT INTO br11_enquiry_lines(company_id,enquiry_id,line_no,product_description,item_id,requested_qty,uom,desired_condition,notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [actor.companyId, e.id, n++, l.product_description, l.item_id ?? null, l.requested_qty, l.uom,
            l.desired_condition ?? null, l.notes ?? null]);
      }
      await this.audit(c, actor, 'br11_sales_enquiries', e.id, 'BR11_ENQUIRY_REGISTERED', null, { ...e, lines: dto.lines });
      return e.id;
    });
    return this.getEnquiry(id, actor);
  }

  async getEnquiry(id: string, actor: Actor) {
    const e = await this.owned(this.pg, 'br11_sales_enquiries', id, actor);
    const [lines, quotes] = await Promise.all([
      this.pg.query(`SELECT * FROM br11_enquiry_lines WHERE enquiry_id=$1 ORDER BY line_no`, [id]),
      this.pg.query(`SELECT * FROM br11_sale_quotations WHERE enquiry_id=$1 ORDER BY created_at`, [id]),
    ]);
    return { ...e, lines: lines.rows, quotes: quotes.rows };
  }

  async listEnquiries(q: ListQueryDto, actor: Actor) {
    return (await this.pg.query(
      `SELECT * FROM br11_sales_enquiries WHERE company_id=$1 AND ($2::text IS NULL OR status=$2)
         AND ($3::uuid IS NULL OR customer_id=$3) ORDER BY created_at DESC LIMIT 200`,
      [actor.companyId, q.status ?? null, q.customer_id ?? null])).rows;
  }

  async cancelEnquiry(id: string, dto: ReasonDto, actor: Actor) {
    await this.write(async (c) => {
      const before = await this.owned(c, 'br11_sales_enquiries', id, actor, true);
      const after = (await c.query(
        `UPDATE br11_sales_enquiries SET status='CANCELLED', cancelled_by_id=$2, cancel_reason=$3 WHERE id=$1 RETURNING *`,
        [id, actor.id, dto.reason])).rows[0];
      await this.audit(c, actor, 'br11_sales_enquiries', id, 'BR11_ENQUIRY_CANCELLED', before, after);
    });
    return this.getEnquiry(id, actor);
  }

  // ================================================================ 11A quotation

  private async insertRevision(c: PoolClient, quoteId: string, dto: CreateRevisionDto | CreateSalesQuoteDto, actor: Actor) {
    return (await c.query(
      `INSERT INTO br11_quote_revisions(company_id,quote_id,revision_no,currency_code,validity_until,payment_terms_snapshot,
         delivery_terms_snapshot,warranty_terms_snapshot,tax_terms_snapshot,revision_reason,created_by_id)
       VALUES ($1,$2,0,COALESCE($3,'INR'),$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [actor.companyId, quoteId, dto.currency_code ?? null, dto.validity_until, dto.payment_terms ?? null,
        dto.delivery_terms ?? null, dto.warranty_terms ?? null, dto.tax_terms ?? null,
        (dto as CreateRevisionDto).revision_reason ?? null, actor.id])).rows[0];
  }

  async createQuote(dto: CreateSalesQuoteDto, actor: Actor) {
    const id = await this.write(async (c) => {
      const enq = await this.owned(c, 'br11_sales_enquiries', dto.enquiry_id, actor);
      const q = (await c.query(
        `INSERT INTO br11_sale_quotations(company_id,quote_number,customer_id,enquiry_id,created_by_id)
         VALUES ($1,'pending',$2,$3,$4) RETURNING *`, [actor.companyId, enq.customer_id, enq.id, actor.id])).rows[0];
      const rev = await this.insertRevision(c, q.id, dto, actor);
      await this.audit(c, actor, 'br11_sale_quotations', q.id, 'BR11_QUOTE_CREATED', null, { quote: q, revision: rev });
      return q.id;
    });
    return this.getQuote(id, actor);
  }

  async createRevision(quoteId: string, dto: CreateRevisionDto, actor: Actor) {
    await this.write(async (c) => {
      await this.owned(c, 'br11_sale_quotations', quoteId, actor);
      const rev = await this.insertRevision(c, quoteId, dto, actor);
      await this.audit(c, actor, 'br11_quote_revisions', rev.id, 'BR11_QUOTE_REVISION_CREATED', null, rev);
    });
    return this.getQuote(quoteId, actor);
  }

  async addQuoteLine(revisionId: string, dto: QuoteLineDto, actor: Actor) {
    return this.write(async (c) => {
      const rev = await this.owned(c, 'br11_quote_revisions', revisionId, actor);
      const item = (await c.query(`SELECT standard_name FROM fdn_item_master WHERE id=$1`, [dto.item_id])).rows[0];
      if (!item) throw new BadRequestException('item not found in the Item Master');
      const l = (await c.query(
        `INSERT INTO br11_quote_lines(company_id,revision_id,line_no,item_id,description_snapshot,manufacturer_snapshot,
           part_number_snapshot,specification_snapshot,product_condition,warranty_snapshot,alternative_label,qty,uom,
           unit_price_paise,list_unit_price_paise)
         VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,'-',$12,$13) RETURNING *`,
        [actor.companyId, rev.id, dto.item_id, dto.description ?? item.standard_name, dto.manufacturer ?? null,
          dto.part_number ?? null, dto.specification ?? null, dto.product_condition, dto.warranty ?? null,
          dto.alternative_label ?? null, dto.qty, dto.unit_price_paise, dto.list_unit_price_paise ?? null])).rows[0];
      await this.audit(c, actor, 'br11_quote_lines', l.id, 'BR11_QUOTE_LINE_ADDED', null, l);
      return l;
    });
  }

  async setRevisionStatus(revisionId: string, status: 'ISSUED' | 'CANCELLED', actor: Actor) {
    const rev = await this.write(async (c) => {
      const before = await this.owned(c, 'br11_quote_revisions', revisionId, actor, true);
      const after = (await c.query(
        `UPDATE br11_quote_revisions SET revision_status=$2::varchar, released_by_id=CASE WHEN $2::varchar='ISSUED' THEN $3::uuid END
          WHERE id=$1 RETURNING *`, [revisionId, status, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_quote_revisions', revisionId,
        status === 'ISSUED' ? 'BR11_QUOTE_ISSUED' : 'BR11_QUOTE_REVISION_CANCELLED', before, after);
      return after;
    });
    return this.getQuote(rev.quote_id, actor);
  }

  async quoteDispatch(revisionId: string, dto: QuoteDispatchDto, actor: Actor) {
    return this.write(async (c) => {
      await this.owned(c, 'br11_quote_revisions', revisionId, actor);
      const r = (await c.query(
        `INSERT INTO br11_quote_dispatch_events(company_id,revision_id,channel,recipient_snapshot,document_evidence_uri,sent_by_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [actor.companyId, revisionId, dto.channel, dto.recipient, dto.document_evidence_uri ?? null, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_quote_dispatch_events', r.id, 'BR11_QUOTE_SENT', null, r);
      return r;
    });
  }

  async quoteResponse(revisionId: string, dto: QuoteResponseDto, actor: Actor) {
    return this.write(async (c) => {
      await this.owned(c, 'br11_quote_revisions', revisionId, actor);
      const r = (await c.query(
        `INSERT INTO br11_customer_quote_responses(company_id,revision_id,response_kind,notes,response_evidence_uri,recorded_by_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [actor.companyId, revisionId, dto.response_kind, dto.notes ?? null, dto.response_evidence_uri ?? null, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_customer_quote_responses', r.id, 'BR11_QUOTE_RESPONSE_RECORDED', null, r);
      return r;
    });
  }

  /**
   * Quote detail. Each line carries the CURRENT ledger allocatable for its item
   * (11A-06): display-only, a quotation reserves nothing and guarantees nothing.
   */
  async getQuote(quoteId: string, actor: Actor) {
    const q = await this.owned(this.pg, 'br11_sale_quotations', quoteId, actor);
    const revs = (await this.pg.query(`SELECT * FROM br11_quote_revisions WHERE quote_id=$1 ORDER BY revision_no`, [quoteId])).rows;
    const ids = revs.map((r) => r.id);
    const [lines, sent, responses] = await Promise.all([
      this.pg.query(
        `SELECT l.*, fdn_allocatable(l.company_id, l.item_id) AS ledger_allocatable_qty
           FROM br11_quote_lines l WHERE l.revision_id = ANY($1::uuid[]) ORDER BY l.line_no`, [ids]),
      this.pg.query(`SELECT * FROM br11_quote_dispatch_events WHERE revision_id = ANY($1::uuid[]) ORDER BY sent_at`, [ids]),
      this.pg.query(`SELECT * FROM br11_customer_quote_responses WHERE revision_id = ANY($1::uuid[]) ORDER BY received_at`, [ids]),
    ]);
    return {
      ...q,
      availability_note: 'ledger_allocatable_qty is indicative only: a quotation does not reserve stock (11A-06)',
      revisions: revs.map((r) => ({
        ...r,
        lines: lines.rows.filter((l) => l.revision_id === r.id),
        dispatch_events: sent.rows.filter((x) => x.revision_id === r.id),
        customer_responses: responses.rows.filter((x) => x.revision_id === r.id),
      })),
    };
  }

  // ================================================================ 11B Sales Order

  async createOrder(dto: CreateSalesOrderDto, actor: Actor) {
    const id = await this.write(async (c) => {
      const rev = await this.owned(c, 'br11_quote_revisions', dto.quote_revision_id, actor);
      const q = (await c.query(`SELECT * FROM br11_sale_quotations WHERE id=$1`, [rev.quote_id])).rows[0];
      const so = (await c.query(
        `INSERT INTO br11_sales_orders(company_id,customer_id,quote_id,quote_revision_id,customer_order_reference,created_by_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [actor.companyId, q.customer_id, q.id, rev.id, dto.customer_order_reference ?? null, actor.id])).rows[0];
      for (const l of dto.lines) {
        await c.query(
          `INSERT INTO br11_sales_order_lines(company_id,sales_order_id,quote_revision_id,quote_line_id,line_no,item_id,
             description_snapshot,uom,unit_price_paise,accepted_qty)
           SELECT $1,$2,$3,$4,1,item_id,description_snapshot,uom,unit_price_paise,$5 FROM br11_quote_lines WHERE id=$4`,
          [actor.companyId, so.id, rev.id, l.quote_line_id, l.accepted_qty]);
      }
      const n = (await c.query(`SELECT count(*)::int AS n FROM br11_sales_order_lines WHERE sales_order_id=$1`, [so.id])).rows[0].n;
      if (n !== dto.lines.length) throw new BadRequestException('a quote line is not on this quote revision');
      await this.audit(c, actor, 'br11_sales_orders', so.id, 'BR11_ORDER_DRAFTED', null, { ...so, lines: dto.lines });
      return so.id;
    });
    return this.getOrder(id, actor);
  }

  async addAuthorisation(orderId: string, dto: OrderAuthorisationDto, actor: Actor) {
    return this.write(async (c) => {
      await this.owned(c, 'br11_sales_orders', orderId, actor);
      const r = (await c.query(
        `INSERT INTO br11_order_authorisation_events(company_id,sales_order_id,source_kind,source_reference,customer_email_sender,
           received_at,evidence_uri,recorded_by_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [actor.companyId, orderId, dto.source_kind, dto.source_reference ?? null, dto.customer_email_sender ?? null,
          dto.received_at, dto.evidence_uri, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_order_authorisation_events', r.id, 'BR11_ORDER_AUTHORISATION_RECORDED', null, r);
      return r;
    });
  }

  async verifyOrder(orderId: string, dto: VerifyOrderDto, actor: Actor) {
    await this.write(async (c) => {
      const before = await this.owned(c, 'br11_sales_orders', orderId, actor, true);
      const ev = await this.owned(c, 'br11_order_authorisation_events', dto.authorisation_event_id, actor, true);
      if (ev.sales_order_id !== orderId) throw new BadRequestException('authorisation evidence belongs to another Sales Order');
      await c.query(`UPDATE br11_order_authorisation_events SET verified_status='VERIFIED', verified_by_id=$2 WHERE id=$1`,
        [ev.id, actor.id]);
      const after = (await c.query(`UPDATE br11_sales_orders SET status='VERIFIED', verified_by_id=$2 WHERE id=$1 RETURNING *`,
        [orderId, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_sales_orders', orderId, 'BR11_ORDER_VERIFIED', before, { ...after, authorisation_event_id: ev.id });
    });
    return this.getOrder(orderId, actor);
  }

  async cancelDraftOrder(orderId: string, actor: Actor) {
    await this.write(async (c) => {
      const before = await this.owned(c, 'br11_sales_orders', orderId, actor, true);
      if (before.status !== 'DRAFT') {
        throw new BadRequestException('only a DRAFT order is cancelled directly; a verified order needs an approved CANCELLATION change request');
      }
      const after = (await c.query(`UPDATE br11_sales_orders SET status='CANCELLED' WHERE id=$1 RETURNING *`, [orderId])).rows[0];
      await this.audit(c, actor, 'br11_sales_orders', orderId, 'BR11_ORDER_DRAFT_CANCELLED', before, after);
    });
    return this.getOrder(orderId, actor);
  }

  async recordPaymentTerms(orderId: string, dto: PaymentTermsDto, actor: Actor) {
    return this.write(async (c) => {
      await this.owned(c, 'br11_sales_orders', orderId, actor);
      const r = (await c.query(
        `INSERT INTO br11_order_payment_conditions(company_id,sales_order_id,advance_kind,required_amount_paise,required_percent,
           accepted_terms_evidence_uri,recorded_by_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [actor.companyId, orderId, dto.advance_kind, dto.required_amount_paise ?? null, dto.required_percent ?? null,
          dto.accepted_terms_evidence_uri, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_order_payment_conditions', r.id, 'BR11_PAYMENT_TERMS_RECORDED', null, r);
      return r;
    });
  }

  async confirmAdvance(orderId: string, dto: ConfirmAdvanceDto, actor: Actor) {
    return this.write(async (c) => {
      await this.owned(c, 'br11_sales_orders', orderId, actor);
      await this.owned(c, 'br08_payment_receipts', dto.br08_receipt_id, actor);
      const before = (await c.query(`SELECT * FROM br11_order_payment_conditions WHERE sales_order_id=$1 FOR UPDATE`, [orderId])).rows[0];
      if (!before) throw new BadRequestException('payment terms for this order have not been recorded');
      const after = (await c.query(
        `UPDATE br11_order_payment_conditions SET br08_receipt_id=$2, finance_confirmation_reference=$3,
           finance_confirmed_by_id=$4, finance_confirmed_at=now() WHERE id=$1 RETURNING *`,
        [before.id, dto.br08_receipt_id, dto.finance_confirmation_reference, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_order_payment_conditions', before.id, 'BR11_ADVANCE_CONFIRMED', before, after);
      return after;
    });
  }

  async getOrder(orderId: string, actor: Actor) {
    const so = await this.owned(this.pg, 'br11_sales_orders', orderId, actor);
    const [lines, auths, terms, resv, outward, changes, closure, invoices] = await Promise.all([
      this.pg.query(`SELECT * FROM br11_v_sales_order_lines WHERE sales_order_id=$1 ORDER BY line_no`, [orderId]),
      this.pg.query(`SELECT * FROM br11_order_authorisation_events WHERE sales_order_id=$1 ORDER BY created_at`, [orderId]),
      this.pg.query(`SELECT * FROM br11_order_payment_conditions WHERE sales_order_id=$1`, [orderId]),
      this.pg.query(
        `SELECT r.* FROM br11_inventory_reservation_requests r JOIN br11_sales_order_lines l ON l.id=r.sales_order_line_id
          WHERE l.sales_order_id=$1 ORDER BY r.created_at`, [orderId]),
      this.pg.query(
        `SELECT DISTINCT b.* FROM br11_outward_batches b JOIN br11_outward_lines ol ON ol.outward_batch_id=b.id
           JOIN br11_sales_order_lines l ON l.id=ol.sales_order_line_id WHERE l.sales_order_id=$1 ORDER BY b.created_at`, [orderId]),
      this.pg.query(`SELECT * FROM br11_sales_change_requests WHERE sales_order_id=$1 ORDER BY created_at`, [orderId]),
      this.pg.query(`SELECT * FROM br11_sales_order_closure_reviews WHERE sales_order_id=$1`, [orderId]),
      // BR-08 is the owner: only the identifying/status fields are surfaced here.
      this.pg.query(
        `SELECT i.id AS invoice_id, i.invoice_number, i.invoice_status, i.invoice_date, i.total_paise, i.amount_paid_paise
           FROM br08_sales_invoice_sources s JOIN br08_invoices i ON i.id=s.invoice_id
          WHERE s.sales_order_id=$1 ORDER BY i.issued_at`, [orderId]),
    ]);
    return {
      ...so, lines: lines.rows, authorisations: auths.rows, payment_terms: terms.rows[0] ?? null,
      reservations: resv.rows, outward_batches: outward.rows, change_requests: changes.rows,
      closure_review: closure.rows[0] ?? null, invoices: invoices.rows,
    };
  }

  async listOrders(q: ListQueryDto, actor: Actor) {
    return (await this.pg.query(
      `SELECT * FROM br11_sales_orders WHERE company_id=$1 AND ($2::text IS NULL OR status=$2)
         AND ($3::uuid IS NULL OR customer_id=$3) ORDER BY created_at DESC LIMIT 200`,
      [actor.companyId, q.status ?? null, q.customer_id ?? null])).rows;
  }

  // ================================================================ 11B reservation (real ledger)

  /**
   * Request -> fdn_reserve -> CONFIRMED (the DB checks the CONFIRMED row against
   * the actual ledger reservation). The client Idempotency-Key makes the whole
   * request safe to retry: the same key returns the same request and never
   * reserves twice; the ledger call is itself idempotent on br11-reservation-<id>.
   */
  async reserve(lineId: string, dto: ReserveDto, idem: string, actor: Actor) {
    if (!idem) throw new BadRequestException('Idempotency-Key header required');
    const req = await this.write(async (c) => {
      await this.owned(c, 'br11_sales_order_lines', lineId, actor);
      const existing = (await c.query(
        `SELECT * FROM br11_inventory_reservation_requests WHERE company_id=$1 AND client_idempotency_key=$2`,
        [actor.companyId, idem])).rows[0];
      if (existing) {
        if (existing.sales_order_line_id !== lineId || Number(existing.requested_qty) !== dto.qty) {
          throw new BadRequestException('Idempotency-Key was already used for a different reservation request');
        }
        return existing;
      }
      const r = (await c.query(
        `INSERT INTO br11_inventory_reservation_requests(company_id,sales_order_line_id,requested_qty,client_idempotency_key,requested_by_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`, [actor.companyId, lineId, dto.qty, idem, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_inventory_reservation_requests', r.id, 'BR11_RESERVATION_REQUESTED', null, r);
      return r;
    });
    if (req.state !== 'REQUESTED') return req;

    const line = (await this.pg.query(`SELECT item_id, uom FROM br11_sales_order_lines WHERE id=$1`, [lineId])).rows[0];
    let ledger: { reservation_id: string; allocatable_after: number };
    try {
      ledger = (await this.inventory.reserve(
        { company_id: actor.companyId, item_id: line.item_id, uom: line.uom, qty: Number(req.requested_qty), reference_id: req.id } as any,
        `br11-reservation-${req.id}`, actor.id, 'BR11_SALES_RESERVATION'))!;
    } catch (e) {
      const msg = (e as Error).message || 'ledger rejected the reservation';
      await this.write(async (c) => {
        const after = (await c.query(
          `UPDATE br11_inventory_reservation_requests SET state='FAILED', error_message=$2 WHERE id=$1 AND state='REQUESTED' RETURNING *`,
          [req.id, `inventory ledger: ${msg}`])).rows[0];
        await this.audit(c, actor, 'br11_inventory_reservation_requests', req.id, 'BR11_RESERVATION_FAILED', req, after);
      });
      if (e instanceof HttpException) throw e;
      throw new BadRequestException(`inventory ledger rejected the reservation: ${msg}`);
    }
    return this.write(async (c) => {
      const after = (await c.query(
        `UPDATE br11_inventory_reservation_requests SET state='CONFIRMED', ledger_reservation_id=$2 WHERE id=$1 RETURNING *`,
        [req.id, ledger.reservation_id])).rows[0];
      await this.audit(c, actor, 'br11_inventory_reservation_requests', req.id, 'BR11_RESERVATION_CONFIRMED', req, after);
      return { ...after, allocatable_after: ledger.allocatable_after };
    });
  }

  async releaseReservation(id: string, actor: Actor) {
    const req = await this.owned(this.pg, 'br11_inventory_reservation_requests', id, actor);
    if (req.state !== 'CONFIRMED') throw new BadRequestException(`only a CONFIRMED reservation can be released (this one is ${req.state})`);
    const used = await this.pg.query(
      `SELECT 1 FROM br11_outward_lines l JOIN br11_outward_batches b ON b.id=l.outward_batch_id
        WHERE l.reservation_request_id=$1 AND b.status<>'CANCELLED'`, [id]);
    if (used.rows[0]) throw new BadRequestException('the reservation is on an outward line -- cancel that outward batch first');
    await this.inventory.consumeReservation(req.ledger_reservation_id, 'RELEASED');
    return this.write(async (c) => {
      const after = (await c.query(
        `UPDATE br11_inventory_reservation_requests SET state='RELEASED' WHERE id=$1 RETURNING *`, [id])).rows[0];
      await this.audit(c, actor, 'br11_inventory_reservation_requests', id, 'BR11_RESERVATION_RELEASED', req, after);
      return after;
    });
  }

  // ================================================================ 11C outward

  async createOutward(dto: CreateOutwardDto, actor: Actor) {
    const id = await this.write(async (c) => {
      await this.owned(c, 'customers', dto.customer_id, actor);
      const b = (await c.query(
        `INSERT INTO br11_outward_batches(company_id,customer_id,dispatch_mode,dispatch_mode_note,recipient_name,destination_address,
           carrier_name,tracking_reference,created_by_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [actor.companyId, dto.customer_id, dto.dispatch_mode, dto.dispatch_mode_note ?? null, dto.recipient_name,
          dto.destination_address, dto.carrier_name ?? null, dto.tracking_reference ?? null, actor.id])).rows[0];
      for (const l of dto.lines) {
        const r = await this.owned(c, 'br11_inventory_reservation_requests', l.reservation_request_id, actor);
        await c.query(
          `INSERT INTO br11_outward_lines(company_id,outward_batch_id,sales_order_line_id,reservation_request_id,item_id,uom,outward_qty)
           VALUES ($1,$2,$3,$4,$5,'-',1) `,
          [actor.companyId, b.id, r.sales_order_line_id, r.id,
            (await c.query(`SELECT item_id FROM br11_sales_order_lines WHERE id=$1`, [r.sales_order_line_id])).rows[0].item_id]);
      }
      await this.audit(c, actor, 'br11_outward_batches', b.id, 'BR11_OUTWARD_CREATED', null, { ...b, lines: dto.lines });
      return b.id;
    });
    return this.getOutward(id, actor);
  }

  private async ownedOutwardLine(c: Queryable, lineId: string, actor: Actor, lock = false) {
    return this.owned(c, 'br11_outward_lines', lineId, actor, lock);
  }

  async addPackingEvidence(lineId: string, dto: PackingEvidenceDto, actor: Actor) {
    return this.write(async (c) => {
      await this.ownedOutwardLine(c, lineId, actor);
      const r = (await c.query(
        `INSERT INTO br11_packing_evidence(company_id,outward_line_id,evidence_kind,file_uri,file_name,captured_by_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [actor.companyId, lineId, dto.evidence_kind, dto.file_uri, dto.file_name, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_packing_evidence', r.id, 'BR11_PACKING_EVIDENCE_ADDED', null, r);
      return r;
    });
  }

  async pick(lineId: string, dto: PickDto, actor: Actor) {
    return this.write(async (c) => {
      const before = await this.ownedOutwardLine(c, lineId, actor, true);
      const after = (await c.query(
        `UPDATE br11_outward_lines SET status='PICKED', verification_note=$2, serial_numbers=$3, pick_confirmed_by_id=$4
          WHERE id=$1 RETURNING *`, [lineId, dto.verification_note, dto.serial_numbers ?? null, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_outward_lines', lineId, 'BR11_OUTWARD_LINE_PICKED', before, after);
      return after;
    });
  }

  /**
   * Physical outward (11C-04: custody changes at dispatch). Pre-checks every line
   * BEFORE touching the ledger (so a missing photo can never leave stock issued on
   * an undispatched batch), then per line: ledger ISSUE out of MAIN_STORE ->
   * close the ledger reservation CONSUMED -> record both refs; finally the batch
   * goes DISPATCHED and the DB re-verifies everything and assigns the SOUT number.
   * Every ledger call is idempotent on a per-line key, so a retry resumes safely.
   */
  async dispatchOutward(batchId: string, dto: DispatchOutwardDto, actor: Actor) {
    const lines = await this.write(async (c) => {
      const b = await this.owned(c, 'br11_outward_batches', batchId, actor, true);
      if (b.status !== 'DRAFT') throw new BadRequestException(`outward batch is ${b.status}`);
      const ls = (await c.query(
        `SELECT l.*, r.state AS reservation_state, r.ledger_reservation_id,
                EXISTS (SELECT 1 FROM br11_packing_evidence p WHERE p.outward_line_id=l.id AND p.evidence_kind='PHOTO') AS has_photo
           FROM br11_outward_lines l JOIN br11_inventory_reservation_requests r ON r.id=l.reservation_request_id
          WHERE l.outward_batch_id=$1 ORDER BY l.created_at`, [batchId])).rows;
      if (!ls.length) throw new BadRequestException('an outward batch needs at least one line');
      for (const l of ls) {
        if (!l.has_photo) throw new BadRequestException('every outward line needs at least one packing PHOTO before dispatch (11C-02)');
        if (l.status !== 'PICKED') throw new BadRequestException('every outward line must be pick-verified before dispatch');
        if (!['CONFIRMED', 'CONSUMED'].includes(l.reservation_state)) {
          throw new BadRequestException(`outward line reservation is ${l.reservation_state}`);
        }
      }
      return ls;
    });
    const main = (await this.pg.query(
      `SELECT id FROM fdn_inventory_locations WHERE company_id=$1 AND role='MAIN_STORE' AND is_active ORDER BY code LIMIT 1`,
      [actor.companyId])).rows[0];
    if (!main) throw new BadRequestException('no active MAIN_STORE location configured for this company');

    for (const l of lines) {
      if (l.inventory_issue_ref) continue;
      const posted = await this.inventory.saleIssue(
        { company_id: actor.companyId, item_id: l.item_id, uom: l.uom, qty: Number(l.outward_qty), from_location_id: main.id, reference_id: l.id },
        `br11-outward-issue-${l.id}`, actor.id);
      await this.inventory.consumeReservation(l.ledger_reservation_id, 'CONSUMED');
      await this.write(async (c) => {
        await c.query(`UPDATE br11_inventory_reservation_requests SET state='CONSUMED' WHERE id=$1 AND state='CONFIRMED'`,
          [l.reservation_request_id]);
        const after = (await c.query(`UPDATE br11_outward_lines SET inventory_issue_ref=$2 WHERE id=$1 RETURNING *`,
          [l.id, posted!.transaction_id])).rows[0];
        await this.audit(c, actor, 'br11_outward_lines', l.id, 'BR11_OUTWARD_LINE_ISSUED', l, after);
      });
    }

    await this.write(async (c) => {
      const before = await this.owned(c, 'br11_outward_batches', batchId, actor, true);
      const after = (await c.query(
        `UPDATE br11_outward_batches SET status='DISPATCHED', dispatched_by_id=$2, tracking_reference=COALESCE($3,tracking_reference)
          WHERE id=$1 RETURNING *`, [batchId, actor.id, dto.tracking_reference ?? null])).rows[0];
      await this.audit(c, actor, 'br11_outward_batches', batchId, 'BR11_OUTWARD_DISPATCHED', before, after);
    });
    return this.getOutward(batchId, actor);
  }

  async cancelOutward(batchId: string, actor: Actor) {
    await this.write(async (c) => {
      const before = await this.owned(c, 'br11_outward_batches', batchId, actor, true);
      const after = (await c.query(`UPDATE br11_outward_batches SET status='CANCELLED' WHERE id=$1 RETURNING *`, [batchId])).rows[0];
      await this.audit(c, actor, 'br11_outward_batches', batchId, 'BR11_OUTWARD_CANCELLED', before, after);
    });
    return this.getOutward(batchId, actor);
  }

  async addTracking(batchId: string, dto: TrackingEventDto, actor: Actor) {
    return this.write(async (c) => {
      await this.owned(c, 'br11_outward_batches', batchId, actor);
      const r = (await c.query(
        `INSERT INTO br11_carrier_tracking_events(company_id,outward_batch_id,status_note,provider_event_ref,occurred_at,recorded_by_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [actor.companyId, batchId, dto.status_note, dto.provider_event_ref ?? null, dto.occurred_at, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_carrier_tracking_events', r.id, 'BR11_TRACKING_RECORDED', null, r);
      return r;
    });
  }

  async recordDelivery(lineId: string, dto: DeliveryEvidenceDto, actor: Actor) {
    return this.write(async (c) => {
      await this.ownedOutwardLine(c, lineId, actor);
      const r = (await c.query(
        `INSERT INTO br11_delivery_evidence(company_id,outward_line_id,delivery_status,delivered_qty,received_by_name,delivered_at,
           pod_uri,remarks,recorded_by_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [actor.companyId, lineId, dto.delivery_status, dto.delivered_qty ?? 0, dto.received_by_name ?? null,
          dto.delivered_at ?? null, dto.pod_uri ?? null, dto.remarks ?? null, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_delivery_evidence', r.id, 'BR11_DELIVERY_RECORDED', null, r);
      return r;
    });
  }

  async getOutward(batchId: string, actor: Actor) {
    const b = await this.owned(this.pg, 'br11_outward_batches', batchId, actor);
    const lines = (await this.pg.query(`SELECT * FROM br11_outward_lines WHERE outward_batch_id=$1 ORDER BY created_at`, [batchId])).rows;
    const ids = lines.map((l) => l.id);
    const [packing, pod, tracking] = await Promise.all([
      this.pg.query(`SELECT * FROM br11_packing_evidence WHERE outward_line_id = ANY($1::uuid[]) ORDER BY captured_at`, [ids]),
      this.pg.query(`SELECT * FROM br11_delivery_evidence WHERE outward_line_id = ANY($1::uuid[]) ORDER BY created_at`, [ids]),
      this.pg.query(`SELECT * FROM br11_carrier_tracking_events WHERE outward_batch_id=$1 ORDER BY occurred_at`, [batchId]),
    ]);
    return {
      ...b,
      lines: lines.map((l) => ({
        ...l,
        packing_evidence: packing.rows.filter((p) => p.outward_line_id === l.id),
        delivery_evidence: pod.rows.filter((p) => p.outward_line_id === l.id),
      })),
      tracking_events: tracking.rows,
    };
  }

  // ================================================================ change requests + closure

  async raiseChange(orderId: string, dto: ChangeRequestDto, actor: Actor) {
    return this.write(async (c) => {
      await this.owned(c, 'br11_sales_orders', orderId, actor);
      const r = (await c.query(
        `INSERT INTO br11_sales_change_requests(company_id,sales_order_id,sales_order_line_id,change_kind,reason,customer_evidence_uri,
           technical_approval_evidence_uri,financial_impact_description,requested_by_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [actor.companyId, orderId, dto.sales_order_line_id ?? null, dto.change_kind, dto.reason, dto.customer_evidence_uri ?? null,
          dto.technical_approval_evidence_uri ?? null, dto.financial_impact_description ?? null, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_sales_change_requests', r.id, 'BR11_CHANGE_REQUESTED', null, r);
      return r;
    });
  }

  async decideChange(id: string, dto: DecideChangeRequestDto, actor: Actor) {
    const r = await this.write(async (c) => {
      const before = await this.owned(c, 'br11_sales_change_requests', id, actor, true);
      const after = (await c.query(
        `UPDATE br11_sales_change_requests SET decision=$2, decision_note=$3, decided_by_id=$4 WHERE id=$1 RETURNING *`,
        [id, dto.decision, dto.decision_note ?? null, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_sales_change_requests', id, `BR11_CHANGE_${dto.decision}`, before, after);
      return after;
    });
    return { change_request: r, order: await this.getOrder(r.sales_order_id, actor) };
  }

  async closeOrder(orderId: string, dto: CloseOrderDto, actor: Actor) {
    await this.write(async (c) => {
      const before = await this.owned(c, 'br11_sales_orders', orderId, actor, true);
      // flags are placeholders: the DB trigger computes every one of them itself
      const review = (await c.query(
        `INSERT INTO br11_sales_order_closure_reviews(company_id,sales_order_id,closure_reason,delivery_verified,billing_verified,
           payment_required,payment_verified,finance_evidence,reviewed_by_id)
         VALUES ($1,$2,$3,false,false,false,false,'[]',$4) RETURNING *`,
        [actor.companyId, orderId, dto.closure_reason, actor.id])).rows[0];
      await this.audit(c, actor, 'br11_sales_orders', orderId, 'BR11_ORDER_CLOSED', before, { closure_review: review });
    });
    return this.getOrder(orderId, actor);
  }
}
