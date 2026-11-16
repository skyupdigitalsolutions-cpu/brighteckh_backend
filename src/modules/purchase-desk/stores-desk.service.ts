import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { Actor, likeTerm, paging } from './purchase-desk.service';
import {
  GRN_RECEIVABLE_STATUSES, GRN_STATUSES, GrnStatus, RECEIVABLE_PO_STATUSES, ReceivablePoQueryDto, StoresGrnListQueryDto,
} from './dto/stores-desk.dto';

/**
 * Stores / Quality desk reads (CLAUDE.md §4i "Stores desk reads"). Read-only, company from the token, quantities only:
 * br06_po_lines.unit_price, currency_code and payment_terms are never selected.
 */

/** PO header + newest acknowledgement / shipment. $1 = company. Callers add WHERE clauses on `p`. */
const PO_HEADER_SQL = `
  SELECT p.id AS po_id, p.po_number, p.po_status, p.purchase_purpose, p.supplier_name_snapshot AS supplier_name,
         p.job_id, j.job_number, p.sales_order_id, so.sales_order_number, p.released_at,
         ack.supplier_reference AS ack_supplier_reference,
         to_char(ack.expected_delivery_date, 'YYYY-MM-DD') AS ack_expected_delivery_date,
         ack.acknowledged_at AS ack_acknowledged_at,
         sh.carrier AS sh_carrier, sh.awb_or_lr_number AS sh_awb_or_lr_number,
         to_char(sh.expected_arrival_date, 'YYYY-MM-DD') AS sh_expected_arrival_date, sh.shipped_at AS sh_shipped_at
    FROM br06_supplier_purchase_orders p
    LEFT JOIN service_jobs j        ON j.id = p.job_id AND j.company_id = p.company_id
    LEFT JOIN br11_sales_orders so  ON so.id = p.sales_order_id AND so.company_id = p.company_id
    LEFT JOIN br06_po_acknowledgements ack ON ack.po_id = p.id
    LEFT JOIN LATERAL (
      SELECT s.carrier, s.awb_or_lr_number, s.expected_arrival_date, s.shipped_at
        FROM br06_shipments s WHERE s.po_id = p.id ORDER BY s.shipped_at DESC, s.id DESC LIMIT 1) sh ON true
   WHERE p.company_id = $1`;

/** GRN header + posted counts. $1 = company. */
const GRN_SQL = `
  SELECT g.id AS grn_id, g.grn_number, g.received_at, g.received_by_id, rb.full_name AS received_by_name, g.notes,
         g.po_id, p.po_number, p.supplier_name_snapshot AS supplier_name, j.job_number, so.sales_order_number,
         cnt.lines_total, cnt.lines_posted,
         CASE WHEN cnt.lines_posted = 0 THEN 'OPEN'
              WHEN cnt.lines_posted < cnt.lines_total THEN 'PARTIAL'
              ELSE 'POSTED' END AS grn_status
    FROM br06_grns g
    JOIN br06_supplier_purchase_orders p ON p.id = g.po_id AND p.company_id = g.company_id
    LEFT JOIN service_jobs j       ON j.id = p.job_id AND j.company_id = p.company_id
    LEFT JOIN br11_sales_orders so ON so.id = p.sales_order_id AND so.company_id = p.company_id
    LEFT JOIN employees rb         ON rb.id = g.received_by_id
    JOIN LATERAL (
      SELECT count(*)::int AS lines_total, count(gl.posted_at)::int AS lines_posted
        FROM br06_grn_lines gl WHERE gl.grn_id = g.id) cnt ON true
   WHERE g.company_id = $1`;

const header = (r: any) => ({
  po_id: r.po_id, po_number: r.po_number, po_status: r.po_status, purchase_purpose: r.purchase_purpose,
  supplier_name: r.supplier_name, job_id: r.job_id, job_number: r.job_number,
  sales_order_id: r.sales_order_id, sales_order_number: r.sales_order_number, released_at: r.released_at,
  can_receive: GRN_RECEIVABLE_STATUSES.includes(r.po_status),
  acknowledgement: r.ack_acknowledged_at ? {
    supplier_reference: r.ack_supplier_reference, expected_delivery_date: r.ack_expected_delivery_date,
    acknowledged_at: r.ack_acknowledged_at,
  } : null,
  latest_shipment: r.sh_shipped_at ? {
    carrier: r.sh_carrier, awb_or_lr_number: r.sh_awb_or_lr_number,
    expected_arrival_date: r.sh_expected_arrival_date, shipped_at: r.sh_shipped_at,
  } : null,
});

const grnHeader = (r: any) => ({
  grn_id: r.grn_id, grn_number: r.grn_number, received_at: r.received_at, received_by_id: r.received_by_id,
  received_by_name: r.received_by_name, notes: r.notes, lines_total: r.lines_total, lines_posted: r.lines_posted,
  grn_status: r.grn_status as GrnStatus,
});

const grnRow = (r: any) => ({
  ...grnHeader(r),
  po_id: r.po_id, po_number: r.po_number, supplier_name: r.supplier_name,
  job_number: r.job_number, sales_order_number: r.sales_order_number,
});

@Injectable()
export class StoresDeskService {
  constructor(private readonly pg: PgService) {}

  /** GET /stores/receivable-pos */
  async receivablePos(q: ReceivablePoQueryDto, actor: Actor) {
    const { page, pageSize, offset } = paging(q);
    // $1 company, $2 search
    const base = `
      WITH base AS (
        ${PO_HEADER_SQL}
           AND p.po_status = ANY('{${RECEIVABLE_PO_STATUSES.join(',')}}'::text[])
           AND ($2::text IS NULL OR p.po_number ILIKE $2 OR p.supplier_name_snapshot ILIKE $2
                OR j.job_number ILIKE $2 OR so.sales_order_number ILIKE $2))`;
    const baseParams = [actor.companyId, likeTerm(q.search)];
    // $3 statuses
    const filtered = `${base} SELECT * FROM base WHERE ($3::text[] IS NULL OR po_status = ANY($3))`;
    const params = [...baseParams, q.status?.length ? q.status : null];
    const order = `ORDER BY CASE po_status WHEN 'SHIPPED' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 ELSE 2 END,
                            COALESCE(sh_expected_arrival_date, ack_expected_delivery_date) ASC NULLS LAST,
                            po_number, po_id`;

    const [counts, total, rows] = await Promise.all([
      this.pg.query<{ po_status: string; n: number }>(`${base} SELECT po_status, count(*)::int AS n FROM base GROUP BY po_status`, baseParams),
      this.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${filtered}) f`, params),
      this.pg.query(`
        SELECT f.*, ln.lines_total, ln.lines_outstanding, og.open_grns
          FROM (${filtered} ${order} LIMIT $4 OFFSET $5) f
          JOIN LATERAL (
            SELECT count(*)::int AS lines_total,
                   count(*) FILTER (WHERE COALESCE(rcv.received, 0) < pl.quantity)::int AS lines_outstanding
              FROM br06_po_lines pl
              LEFT JOIN LATERAL (SELECT SUM(gl.received_quantity) AS received FROM br06_grn_lines gl
                                  WHERE gl.po_line_id = pl.id) rcv ON true
             WHERE pl.po_id = f.po_id) ln ON true
          JOIN LATERAL (
            SELECT count(DISTINCT gl.grn_id)::int AS open_grns
              FROM br06_grns g JOIN br06_grn_lines gl ON gl.grn_id = g.id
             WHERE g.po_id = f.po_id AND gl.posted_at IS NULL) og ON true
         ${order}`, [...params, pageSize, offset]),
    ]);

    const counts_by_status = Object.fromEntries(RECEIVABLE_PO_STATUSES.map((s) => [s, 0])) as Record<string, number>;
    for (const r of counts.rows) counts_by_status[r.po_status] = r.n;

    return {
      rows: rows.rows.map((r) => ({
        ...header(r), lines_total: r.lines_total, lines_outstanding: r.lines_outstanding, open_grns: r.open_grns,
      })),
      total: total.rows[0].n, page, page_size: pageSize, counts_by_status,
    };
  }

  /** GET /stores/purchase-orders/:id */
  async purchaseOrder(id: string, actor: Actor) {
    await this.assertCompany('br06_supplier_purchase_orders', id, actor, 'purchase order');
    const [h, lines, grns] = await Promise.all([
      this.pg.query(`${PO_HEADER_SQL} AND p.id = $2`, [actor.companyId, id]),
      this.pg.query(`
        SELECT pl.id AS po_line_id, pl.line_no, pl.item_bridge_id, b.item_code, b.item_name, pl.uom,
               pl.quantity AS ordered_quantity,
               COALESCE(agg.received, 0)::numeric(16,4) AS received_quantity,
               COALESCE(agg.posted, 0)::numeric(16,4) AS posted_quantity,
               GREATEST(pl.quantity - COALESCE(agg.received, 0), 0)::numeric(16,4) AS outstanding_quantity
          FROM br06_po_lines pl
          JOIN br03_item_catalog_bridge b ON b.id = pl.item_bridge_id
          LEFT JOIN LATERAL (
            SELECT SUM(gl.received_quantity) AS received,
                   SUM(gl.accepted_quantity + gl.rejected_quantity + gl.held_quantity) FILTER (WHERE gl.posted_at IS NOT NULL) AS posted
              FROM br06_grn_lines gl WHERE gl.po_line_id = pl.id) agg ON true
         WHERE pl.po_id = $1
         ORDER BY pl.line_no`, [id]),
      this.pg.query(`${GRN_SQL} AND g.po_id = $2 ORDER BY g.received_at DESC, g.grn_number DESC`, [actor.companyId, id]),
    ]);
    return { ...header(h.rows[0]), lines: lines.rows, grns: grns.rows.map(grnHeader) };
  }

  /** GET /stores/grns */
  async grns(q: StoresGrnListQueryDto, actor: Actor) {
    const { page, pageSize, offset } = paging(q);
    // $1 company, $2 search
    const base = `
      WITH base AS (
        ${GRN_SQL}
           AND ($2::text IS NULL OR g.grn_number ILIKE $2 OR p.po_number ILIKE $2 OR p.supplier_name_snapshot ILIKE $2
                OR j.job_number ILIKE $2 OR so.sales_order_number ILIKE $2))`;
    const baseParams = [actor.companyId, likeTerm(q.search)];
    const filtered = `${base} SELECT * FROM base WHERE ($3::text[] IS NULL OR grn_status = ANY($3))`;
    const params = [...baseParams, q.status?.length ? q.status : null];

    const [counts, total, rows] = await Promise.all([
      this.pg.query<{ grn_status: GrnStatus; n: number }>(`${base} SELECT grn_status, count(*)::int AS n FROM base GROUP BY grn_status`, baseParams),
      this.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${filtered}) f`, params),
      this.pg.query(`${filtered} ORDER BY received_at DESC, grn_number DESC LIMIT $4 OFFSET $5`, [...params, pageSize, offset]),
    ]);

    const counts_by_status = Object.fromEntries(GRN_STATUSES.map((s) => [s, 0])) as Record<GrnStatus, number>;
    for (const r of counts.rows) counts_by_status[r.grn_status] = r.n;
    return { rows: rows.rows.map(grnRow), total: total.rows[0].n, page, page_size: pageSize, counts_by_status };
  }

  /** GET /stores/grns/:id */
  async grn(id: string, actor: Actor) {
    await this.assertCompany('br06_grns', id, actor, 'GRN');
    const [g, lines, media, moves] = await Promise.all([
      this.pg.query(`${GRN_SQL} AND g.id = $2`, [actor.companyId, id]),
      this.pg.query(`
        SELECT gl.id, gl.po_line_id, pl.line_no, gl.item_bridge_id, b.item_code, b.item_name, gl.uom,
               gl.ordered_quantity, gl.received_quantity, gl.accepted_quantity, gl.rejected_quantity, gl.held_quantity,
               gl.returned_quantity, gl.posted_at, pb.actor_id AS posted_by_id, e.full_name AS posted_by_name,
               gl.main_store_movement_ref, gl.quarantine_movement_ref, gl.return_movement_ref
          FROM br06_grn_lines gl
          JOIN br06_po_lines pl ON pl.id = gl.po_line_id
          JOIN br03_item_catalog_bridge b ON b.id = gl.item_bridge_id
          LEFT JOIN LATERAL (
            SELECT l.actor_id FROM activity_audit_log l
             WHERE l.entity_id = gl.id AND l.company_id = $2 AND l.entity_table = 'br06_grn_lines'
               AND l.action = 'BR06_GRN_LINE_DISPOSED'
             ORDER BY l.changed_at DESC, l.id DESC LIMIT 1) pb ON true
          LEFT JOIN employees e ON e.id = pb.actor_id
         WHERE gl.grn_id = $1
         ORDER BY pl.line_no`, [id, actor.companyId]),
      this.pg.query(`
        SELECT m.id, m.grn_line_id, m.file_uri, m.file_name, m.uploaded_by_id, m.uploaded_at
          FROM br06_grn_line_media m JOIN br06_grn_lines gl ON gl.id = m.grn_line_id
         WHERE gl.grn_id = $1 ORDER BY m.uploaded_at, m.id`, [id]),
      this.pg.query(`
        SELECT jr.id, jr.reference_id, jr.movement_type, jr.qty, jr.uom, jr.status, jr.posted_at,
               fl.role AS from_location_role, fl.code AS from_location_code,
               tl.role AS to_location_role, tl.code AS to_location_code
          FROM fdn_inventory_journal jr
          JOIN br06_grn_lines gl ON gl.id = jr.reference_id
          LEFT JOIN fdn_inventory_locations fl ON fl.id = jr.from_location_id
          LEFT JOIN fdn_inventory_locations tl ON tl.id = jr.to_location_id
         WHERE gl.grn_id = $1 AND jr.company_id = $2
         ORDER BY jr.posted_at, jr.id`, [id, actor.companyId]),
    ]);

    const by = <T extends { [k: string]: any }>(rows: T[], key: string) => {
      const m = new Map<string, Omit<T, string>[]>();
      for (const r of rows) {
        const { [key]: k, ...rest } = r;
        m.set(k, [...(m.get(k) ?? []), rest]);
      }
      return m;
    };
    const mediaBy = by(media.rows, 'grn_line_id');
    const movesBy = by(moves.rows, 'reference_id');
    return {
      ...grnRow(g.rows[0]),
      lines: lines.rows.map((l) => ({ ...l, media: mediaBy.get(l.id) ?? [], movements: movesBy.get(l.id) ?? [] })),
    };
  }

  private async assertCompany(table: 'br06_grns' | 'br06_supplier_purchase_orders', id: string, actor: Actor, label: string) {
    const r = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM ${table} WHERE id = $1`, [id]);
    if (!r.rows[0]) throw new NotFoundException(`${label} not found`);
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException(`${label} belongs to another company`);
  }
}
