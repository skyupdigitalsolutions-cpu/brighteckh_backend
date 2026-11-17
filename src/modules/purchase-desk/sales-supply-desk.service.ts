import { Injectable } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { Actor, likeTerm, paging } from './purchase-desk.service';
import { PageQueryDto } from './dto/purchase-desk.dto';
import {
  ENQUIRY_STATUSES, ORDER_STATUSES, OUTWARD_STATUSES, QUOTE_STAGES, SupplyEnquiryQueryDto, SupplyOrderQueryDto,
  SupplyOutwardQueryDto, SupplyQuoteQueryDto,
} from './dto/sales-supply-desk.dto';

/**
 * BR-11 Sales & Supply desk reads (CLAUDE.md §4h "Sales & Supply desk reads"). Read-only, company from the token,
 * customer-facing columns only: br06 sourcing authorisations, supplier offers and SALES_ORDER PO prices are never
 * joined. Every list: page / page_size (<= 100), csv status-or-stage filter, `search`, counts per status under `search`.
 */

/** Stage of a quotation from its LATEST revision + that revision's newest response / dispatch (see the dto doc). */
const QUOTE_STAGE_SQL = `
  CASE
    WHEN x.revision_status = 'DRAFT' THEN 'TO_PRICE'
    WHEN x.revision_status = 'CANCELLED' THEN 'CANCELLED'
    WHEN x.latest_response_kind IN ('ACCEPTED', 'PART_ACCEPTED', 'REJECTED') THEN x.latest_response_kind
    WHEN x.latest_response_kind IS NOT NULL OR x.last_sent_at IS NOT NULL THEN 'WITH_CUSTOMER'
    ELSE 'ISSUED'
  END`;

@Injectable()
export class SalesSupplyDeskService {
  constructor(private readonly pg: PgService) {}

  /**
   * Run a paged list over `baseSql` (a CTE body selecting a `bucket` column = status / stage). $1 company, $2 search;
   * the bucket filter is $3, limit $4, offset $5.
   */
  private async page(baseSql: string, q: PageQueryDto, buckets: readonly string[], selected: string[] | undefined,
    order: string, countsKey: string, actor: Actor) {
    const { page, pageSize, offset } = paging(q);
    const base = `WITH base AS (${baseSql})`;
    const baseParams = [actor.companyId, likeTerm(q.search)];
    const filtered = `${base} SELECT * FROM base WHERE ($3::text[] IS NULL OR bucket = ANY($3))`;
    const params = [...baseParams, selected?.length ? selected : null];
    const [counts, total, rows] = await Promise.all([
      this.pg.query<{ bucket: string; n: number }>(`${base} SELECT bucket, count(*)::int AS n FROM base GROUP BY bucket`, baseParams),
      this.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${filtered}) f`, params),
      this.pg.query(`${filtered} ORDER BY ${order} LIMIT $4 OFFSET $5`, [...params, pageSize, offset]),
    ]);
    const byBucket = Object.fromEntries(buckets.map((b) => [b, 0])) as Record<string, number>;
    for (const r of counts.rows) byBucket[r.bucket] = r.n;
    return {
      rows: rows.rows.map(({ bucket: _b, ...r }) => r),
      total: total.rows[0].n, page, page_size: pageSize, [countsKey]: byBucket,
    };
  }

  /** GET /sales-supply/enquiries */
  enquiries(q: SupplyEnquiryQueryDto, actor: Actor) {
    return this.page(`
      SELECT e.id, e.enquiry_number, e.customer_id, c.customer_name, c.customer_code, e.enquiry_channel, e.enquiry_details,
             e.status, e.sales_owner_id, so.full_name AS sales_owner_name, e.created_at,
             (SELECT count(*)::int FROM br11_enquiry_lines l WHERE l.enquiry_id = e.id) AS line_count,
             (SELECT count(*)::int FROM br11_sale_quotations sq WHERE sq.enquiry_id = e.id) AS quote_count,
             lq.id AS latest_quote_id, lq.quote_number AS latest_quote_number,
             e.status AS bucket
        FROM br11_sales_enquiries e
        JOIN customers c       ON c.id = e.customer_id AND c.company_id = e.company_id
        LEFT JOIN employees so ON so.id = e.sales_owner_id
        LEFT JOIN LATERAL (SELECT id, quote_number FROM br11_sale_quotations
                            WHERE enquiry_id = e.id ORDER BY created_at DESC, id DESC LIMIT 1) lq ON true
       WHERE e.company_id = $1
         AND ($2::text IS NULL OR e.enquiry_number ILIKE $2 OR c.customer_name ILIKE $2 OR c.customer_code ILIKE $2
              OR e.enquiry_details ILIKE $2)`,
    q, ENQUIRY_STATUSES, q.status, 'created_at DESC, enquiry_number DESC', 'counts_by_status', actor);
  }

  /** GET /sales-supply/quotes */
  quotes(q: SupplyQuoteQueryDto, actor: Actor) {
    return this.page(`
      SELECT y.*, y.stage AS bucket FROM (
        SELECT x.*, ${QUOTE_STAGE_SQL} AS stage FROM (
          SELECT sq.id AS quote_id, sq.quote_number, sq.customer_id, c.customer_name, c.customer_code,
                 sq.enquiry_id, en.enquiry_number,
                 lr.id AS latest_revision_id, lr.revision_no, lr.revision_status,
                 (SELECT count(*)::int FROM br11_quote_revisions r WHERE r.quote_id = sq.id) AS revisions_count,
                 to_char(lr.validity_until, 'YYYY-MM-DD') AS validity_until,
                 tot.line_count, tot.total_paise::text AS total_paise,
                 lr.released_at, snt.sent_at AS last_sent_at, snt.channel AS last_sent_channel,
                 resp.response_kind AS latest_response_kind, resp.received_at AS latest_response_at,
                 (SELECT count(*)::int FROM br11_sales_orders o WHERE o.quote_id = sq.id AND o.status <> 'CANCELLED') AS sales_order_count,
                 GREATEST(lr.created_at, lr.released_at, snt.sent_at, resp.received_at) AS last_activity_at
            FROM br11_sale_quotations sq
            JOIN customers c ON c.id = sq.customer_id AND c.company_id = sq.company_id
            JOIN br11_sales_enquiries en ON en.id = sq.enquiry_id
            JOIN LATERAL (SELECT * FROM br11_quote_revisions WHERE quote_id = sq.id ORDER BY revision_no DESC LIMIT 1) lr ON true
            JOIN LATERAL (SELECT count(*)::int AS line_count, COALESCE(sum(line_total_paise), 0)::bigint AS total_paise
                            FROM br11_quote_lines WHERE revision_id = lr.id) tot ON true
            LEFT JOIN LATERAL (SELECT sent_at, channel FROM br11_quote_dispatch_events
                                WHERE revision_id = lr.id ORDER BY sent_at DESC, id DESC LIMIT 1) snt ON true
            LEFT JOIN LATERAL (SELECT response_kind, received_at FROM br11_customer_quote_responses
                                WHERE revision_id = lr.id ORDER BY received_at DESC, id DESC LIMIT 1) resp ON true
           WHERE sq.company_id = $1
             AND ($2::text IS NULL OR sq.quote_number ILIKE $2 OR c.customer_name ILIKE $2 OR c.customer_code ILIKE $2
                  OR en.enquiry_number ILIKE $2)
        ) x
      ) y`,
    q, QUOTE_STAGES, q.stage, 'last_activity_at DESC, quote_number DESC', 'counts_by_stage', actor);
  }

  /** GET /sales-supply/orders */
  orders(q: SupplyOrderQueryDto, actor: Actor) {
    return this.page(`
      SELECT o.id, o.sales_order_number, o.status, o.customer_id, c.customer_name, c.customer_code,
             o.quote_id, sq.quote_number, qr.revision_no AS quote_revision_no, o.customer_order_reference,
             o.created_at, o.verified_at, o.closed_at,
             ln.order_total_paise::text AS order_total_paise, ln.lines_total, ln.lines_reserved, ln.lines_shipped,
             ln.lines_delivered, ln.lines_invoiced,
             (SELECT count(*)::int FROM br11_order_authorisation_events a
               WHERE a.sales_order_id = o.id AND a.verified_status = 'PENDING') AS pending_authorisations,
             (pc.id IS NOT NULL) AS payment_terms_recorded, pc.advance_kind,
             (pc.advance_kind = 'NOT_REQUIRED' OR pc.finance_confirmed_at IS NOT NULL) IS TRUE AS advance_cleared,
             (SELECT count(*)::int FROM br11_sales_change_requests cr
               WHERE cr.sales_order_id = o.id AND cr.decision = 'PENDING') AS open_change_requests,
             (SELECT count(DISTINCT ob.id)::int FROM br11_outward_lines ol
                JOIN br11_sales_order_lines sl ON sl.id = ol.sales_order_line_id
                JOIN br11_outward_batches ob ON ob.id = ol.outward_batch_id
               WHERE sl.sales_order_id = o.id AND ob.status <> 'CANCELLED') AS outward_count,
             o.status AS bucket
        FROM br11_sales_orders o
        JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
        JOIN br11_sale_quotations sq ON sq.id = o.quote_id
        JOIN br11_quote_revisions qr ON qr.id = o.quote_revision_id
        LEFT JOIN LATERAL (SELECT * FROM br11_order_payment_conditions p WHERE p.sales_order_id = o.id
                            ORDER BY p.recorded_at DESC, p.id DESC LIMIT 1) pc ON true
        JOIN LATERAL (
          SELECT COALESCE(sum(round(v.accepted_qty * v.unit_price_paise)), 0)::bigint AS order_total_paise,
                 count(*)::int AS lines_total,
                 count(*) FILTER (WHERE v.reserved_qty + v.shipped_qty >= v.accepted_qty)::int AS lines_reserved,
                 count(*) FILTER (WHERE v.shipped_qty >= v.accepted_qty)::int AS lines_shipped,
                 count(*) FILTER (WHERE v.outstanding_delivery_qty <= 0)::int AS lines_delivered,
                 count(*) FILTER (WHERE v.invoiced_qty >= v.accepted_qty)::int AS lines_invoiced
            FROM br11_v_sales_order_lines v WHERE v.sales_order_id = o.id) ln ON true
       WHERE o.company_id = $1
         AND ($2::text IS NULL OR o.sales_order_number ILIKE $2 OR c.customer_name ILIKE $2 OR c.customer_code ILIKE $2
              OR sq.quote_number ILIKE $2 OR o.customer_order_reference ILIKE $2)`,
    q, ORDER_STATUSES, q.status, 'created_at DESC, id DESC', 'counts_by_status', actor);
  }

  /** GET /sales-supply/outwards */
  outwards(q: SupplyOutwardQueryDto, actor: Actor) {
    return this.page(`
      SELECT b.id, b.outward_number, b.status, b.customer_id, c.customer_name, c.customer_code, b.dispatch_mode,
             b.carrier_name, b.tracking_reference, b.recipient_name, b.created_at, b.dispatched_at,
             ln.lines_total, ln.lines_picked, ln.lines_with_packing_evidence, ln.lines_delivered,
             te.status_note AS latest_tracking_note, te.occurred_at AS latest_tracking_at,
             COALESCE(sos.sales_orders, '[]'::json) AS sales_orders,
             b.status AS bucket
        FROM br11_outward_batches b
        JOIN customers c ON c.id = b.customer_id AND c.company_id = b.company_id
        JOIN LATERAL (
          SELECT count(*)::int AS lines_total,
                 count(*) FILTER (WHERE ol.status <> 'DRAFT')::int AS lines_picked,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM br11_packing_evidence pe WHERE pe.outward_line_id = ol.id))::int
                   AS lines_with_packing_evidence,
                 count(*) FILTER (WHERE ol.status = 'DELIVERED')::int AS lines_delivered
            FROM br11_outward_lines ol WHERE ol.outward_batch_id = b.id) ln ON true
        LEFT JOIN LATERAL (SELECT status_note, occurred_at FROM br11_carrier_tracking_events
                            WHERE outward_batch_id = b.id ORDER BY occurred_at DESC, id DESC LIMIT 1) te ON true
        LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object('sales_order_id', d.id, 'sales_order_number', d.sales_order_number)
                          ORDER BY d.sales_order_number) AS sales_orders
            FROM (SELECT DISTINCT so.id, so.sales_order_number
                    FROM br11_outward_lines ol
                    JOIN br11_sales_order_lines sl ON sl.id = ol.sales_order_line_id
                    JOIN br11_sales_orders so ON so.id = sl.sales_order_id
                   WHERE ol.outward_batch_id = b.id) d) sos ON true
       WHERE b.company_id = $1
         AND ($2::text IS NULL OR b.outward_number ILIKE $2 OR c.customer_name ILIKE $2 OR c.customer_code ILIKE $2
              OR b.tracking_reference ILIKE $2
              OR EXISTS (SELECT 1 FROM br11_outward_lines ol
                           JOIN br11_sales_order_lines sl ON sl.id = ol.sales_order_line_id
                           JOIN br11_sales_orders so ON so.id = sl.sales_order_id
                          WHERE ol.outward_batch_id = b.id AND so.sales_order_number ILIKE $2))`,
    q, OUTWARD_STATUSES, q.status, 'created_at DESC, id DESC', 'counts_by_status', actor);
  }
}
