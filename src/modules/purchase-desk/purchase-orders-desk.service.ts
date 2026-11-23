import { Injectable } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { Actor, likeTerm, paging } from './purchase-desk.service';
import { PO_STATUSES, PoStatus, PurchasePoListQueryDto } from './dto/purchase-orders-desk.dto';

/**
 * Purchase supplier-PO register (CLAUDE.md §4i "Purchase PO register"). Read-only, company from the token, PURCHASE only.
 * Selects only br06 PO header/line columns PURCHASE already reads on GET /purchase-orders/:id, plus names and numbers.
 * Never joins br04 offers / comparisons / customer quotes, br06_sales_sourcing_authorisations or BR-11 line prices.
 */

/** $1 = company, $2 = search term. Header + names + ack + newest shipment; the base the counts and the list share. */
const BASE_SQL = `
  WITH base AS (
    SELECT p.id, p.po_number, p.po_status, p.purchase_purpose, p.supplier_id, p.supplier_name_snapshot AS supplier_name,
           p.job_id, j.job_number, p.sales_order_id, so.sales_order_number,
           COALESCE(jc.customer_name, sc.customer_name) AS customer_name,
           p.currency_code, p.payment_terms, p.created_at, cb.full_name AS created_by_name,
           p.released_at, rb.full_name AS released_by_name,
           ack.supplier_reference AS ack_supplier_reference,
           to_char(ack.expected_delivery_date, 'YYYY-MM-DD') AS ack_expected_delivery_date,
           ack.acknowledged_at AS ack_acknowledged_at,
           sh.carrier AS sh_carrier, sh.awb_or_lr_number AS sh_awb_or_lr_number,
           to_char(sh.expected_arrival_date, 'YYYY-MM-DD') AS sh_expected_arrival_date, sh.shipped_at AS sh_shipped_at
      FROM br06_supplier_purchase_orders p
      JOIN employees cb               ON cb.id = p.created_by_id
      LEFT JOIN employees rb          ON rb.id = p.released_by_id
      LEFT JOIN service_jobs j        ON j.id = p.job_id AND j.company_id = p.company_id
      LEFT JOIN inward_receipts r     ON r.id = j.inward_id AND r.company_id = j.company_id
      LEFT JOIN customers jc          ON jc.id = r.customer_id AND jc.company_id = r.company_id
      LEFT JOIN br11_sales_orders so  ON so.id = p.sales_order_id AND so.company_id = p.company_id
      LEFT JOIN customers sc          ON sc.id = so.customer_id AND sc.company_id = so.company_id
      LEFT JOIN br06_po_acknowledgements ack ON ack.po_id = p.id
      LEFT JOIN LATERAL (
        SELECT s.carrier, s.awb_or_lr_number, s.expected_arrival_date, s.shipped_at
          FROM br06_shipments s WHERE s.po_id = p.id ORDER BY s.shipped_at DESC, s.id DESC LIMIT 1) sh ON true
     WHERE p.company_id = $1
       AND ($2::text IS NULL OR p.po_number ILIKE $2 OR p.supplier_name_snapshot ILIKE $2 OR j.job_number ILIKE $2
            OR so.sales_order_number ILIKE $2 OR ack.supplier_reference ILIKE $2
            OR EXISTS (SELECT 1 FROM br06_shipments s2 WHERE s2.po_id = p.id AND s2.awb_or_lr_number ILIKE $2)))`;

const ORDER = 'ORDER BY created_at DESC, po_number DESC, id';

@Injectable()
export class PurchaseOrdersDeskService {
  constructor(private readonly pg: PgService) {}

  /** GET /purchase-orders */
  async list(q: PurchasePoListQueryDto, actor: Actor) {
    const { page, pageSize, offset } = paging(q);
    const baseParams = [actor.companyId, likeTerm(q.search)];
    // $3 statuses, $4 purposes, $5 job, $6 sales order, $7 supplier
    const filtered = `${BASE_SQL}
      SELECT * FROM base
       WHERE ($3::text[] IS NULL OR po_status = ANY($3))
         AND ($4::text[] IS NULL OR purchase_purpose = ANY($4))
         AND ($5::uuid IS NULL OR job_id = $5)
         AND ($6::uuid IS NULL OR sales_order_id = $6)
         AND ($7::uuid IS NULL OR supplier_id = $7)`;
    const params = [
      ...baseParams, q.status?.length ? q.status : null, q.purpose?.length ? q.purpose : null,
      q.job_id ?? null, q.sales_order_id ?? null, q.supplier_id ?? null,
    ];

    const [counts, total, rows] = await Promise.all([
      this.pg.query<{ po_status: PoStatus; n: number }>(
        `${BASE_SQL} SELECT po_status, count(*)::int AS n FROM base GROUP BY po_status`, baseParams),
      this.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${filtered}) f`, params),
      this.pg.query(`
        SELECT f.*, ln.lines_count, ln.lines_outstanding, ln.value_pre_tax, g.grns_count, g.last_received_at
          FROM (${filtered} ${ORDER} LIMIT $8 OFFSET $9) f
          JOIN LATERAL (
            SELECT count(*)::int AS lines_count,
                   count(*) FILTER (WHERE COALESCE(rcv.received, 0) < pl.quantity)::int AS lines_outstanding,
                   COALESCE(SUM(round(pl.quantity * pl.unit_price, 2)), 0)::numeric(18,2)::text AS value_pre_tax
              FROM br06_po_lines pl
              LEFT JOIN LATERAL (SELECT SUM(gl.received_quantity) AS received FROM br06_grn_lines gl
                                  WHERE gl.po_line_id = pl.id) rcv ON true
             WHERE pl.po_id = f.id) ln ON true
          JOIN LATERAL (
            SELECT count(*)::int AS grns_count, max(gr.received_at) AS last_received_at
              FROM br06_grns gr WHERE gr.po_id = f.id) g ON true
         ${ORDER}`, [...params, pageSize, offset]),
    ]);

    const counts_by_status = Object.fromEntries(PO_STATUSES.map((s) => [s, 0])) as Record<PoStatus, number>;
    for (const r of counts.rows) counts_by_status[r.po_status] = r.n;

    return {
      rows: rows.rows.map((r) => ({
        id: r.id, po_number: r.po_number, po_status: r.po_status, purchase_purpose: r.purchase_purpose,
        supplier_id: r.supplier_id, supplier_name: r.supplier_name,
        job_id: r.job_id, job_number: r.job_number, sales_order_id: r.sales_order_id,
        sales_order_number: r.sales_order_number, customer_name: r.customer_name,
        currency_code: r.currency_code, payment_terms: r.payment_terms, lines_count: r.lines_count,
        value_pre_tax: r.value_pre_tax,
        created_at: r.created_at, created_by_name: r.created_by_name,
        released_at: r.released_at, released_by_name: r.released_by_name,
        acknowledgement: r.ack_acknowledged_at ? {
          supplier_reference: r.ack_supplier_reference, expected_delivery_date: r.ack_expected_delivery_date,
          acknowledged_at: r.ack_acknowledged_at,
        } : null,
        latest_shipment: r.sh_shipped_at ? {
          carrier: r.sh_carrier, awb_or_lr_number: r.sh_awb_or_lr_number,
          expected_arrival_date: r.sh_expected_arrival_date, shipped_at: r.sh_shipped_at,
        } : null,
        expected_date: r.sh_expected_arrival_date ?? r.ack_expected_delivery_date ?? null,
        grns_count: r.grns_count, last_received_at: r.last_received_at, lines_outstanding: r.lines_outstanding,
      })),
      total: total.rows[0].n, page, page_size: pageSize, counts_by_status,
    };
  }
}
