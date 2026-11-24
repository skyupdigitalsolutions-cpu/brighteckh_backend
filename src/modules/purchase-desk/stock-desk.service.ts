import { Injectable, NotFoundException } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { Actor, companyTimezone, likeTerm, paging } from './purchase-desk.service';
import {
  MASTER_STATUSES, MasterStatus, MOVEMENT_TYPES, MovementType, RECORD_TYPES, RecordType,
  StockAssembliesQueryDto, StockAssemblyDetailQueryDto, StockItemsQueryDto, StockJournalQueryDto,
} from './dto/stock-desk.dto';

/**
 * Purchase "Stock" pill reads (CLAUDE.md §4i "Purchase Stock desk"). Read-only, PURCHASE only, company from the token.
 * Ledger reads never do balance maths of their own: allocatable is fdn_allocatable, balances are fdn_inventory_balances.
 * Item / assembly masters are global (no company column); ledger rows and balances are filtered by the caller's company.
 */

const arr = (v?: string[]) => (v && v.length ? v : null);
const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/**
 * $1 = company, $2 = search term. Each posting + item + locations + its reference resolved to a document by kind:
 * BR06_GRN_LINE / BR06_SUPPLIER_RETURN -> GRN line -> GRN (+ PO, and the PO's job or sales order);
 * BR07_ISSUE / BR07_CONSUME / BR07_RETURN -> issue / consumption / return -> job;
 * BR11_SALE_ISSUE -> outward line -> SOUT batch + sales order. Every join is company-checked.
 */
const JOURNAL_SQL = `
  WITH base AS (
    SELECT j.id, j.posted_at, j.movement_type, j.status, j.item_id, im.item_code, im.standard_name AS item_name, j.uom,
           trim_scale(j.qty)::text AS qty,
           fl.role AS from_location_role, fl.code AS from_location_code,
           tl.role AS to_location_role, tl.code AS to_location_code,
           j.reference_kind, j.reference_id,
           g.id AS grn_id, g.grn_number, po.id AS po_id, po.po_number,
           sj.id AS job_id, sj.job_number,
           ob.id AS outward_id, ob.outward_number,
           so.id AS sales_order_id, so.sales_order_number,
           e.full_name AS actor_name
      FROM fdn_inventory_journal j
      JOIN fdn_item_master im ON im.id = j.item_id
      LEFT JOIN fdn_inventory_locations fl ON fl.id = j.from_location_id
      LEFT JOIN fdn_inventory_locations tl ON tl.id = j.to_location_id
      LEFT JOIN br06_grn_lines gl ON j.reference_kind IN ('BR06_GRN_LINE', 'BR06_SUPPLIER_RETURN') AND gl.id = j.reference_id
      LEFT JOIN br06_grns g ON g.id = gl.grn_id AND g.company_id = j.company_id
      LEFT JOIN br06_supplier_purchase_orders po ON po.id = g.po_id AND po.company_id = j.company_id
      LEFT JOIN br07_material_issues bi ON j.reference_kind = 'BR07_ISSUE' AND bi.id = j.reference_id AND bi.company_id = j.company_id
      LEFT JOIN br07_material_consumptions bc
             ON j.reference_kind = 'BR07_CONSUME' AND bc.id = j.reference_id AND bc.company_id = j.company_id
      LEFT JOIN br07_material_returns br ON j.reference_kind = 'BR07_RETURN' AND br.id = j.reference_id AND br.company_id = j.company_id
      LEFT JOIN br11_outward_lines ol ON j.reference_kind = 'BR11_SALE_ISSUE' AND ol.id = j.reference_id AND ol.company_id = j.company_id
      LEFT JOIN br11_outward_batches ob ON ob.id = ol.outward_batch_id AND ob.company_id = j.company_id
      LEFT JOIN br11_sales_order_lines sol ON sol.id = ol.sales_order_line_id AND sol.company_id = j.company_id
      LEFT JOIN service_jobs sj ON sj.id = COALESCE(bi.job_id, bc.job_id, br.job_id, po.job_id) AND sj.company_id = j.company_id
      LEFT JOIN br11_sales_orders so ON so.id = COALESCE(sol.sales_order_id, po.sales_order_id) AND so.company_id = j.company_id
      LEFT JOIN employees e ON e.id = j.actor_id
     WHERE j.company_id = $1
       AND ($2::text IS NULL OR im.item_code ILIKE $2 OR im.standard_name ILIKE $2 OR g.grn_number ILIKE $2
            OR po.po_number ILIKE $2 OR sj.job_number ILIKE $2 OR ob.outward_number ILIKE $2
            OR so.sales_order_number ILIKE $2 OR e.full_name ILIKE $2))`;

/** $1 = search. Items + creator / approver names + how many assemblies' latest BOM revision use them. */
const ITEMS_SQL = `
  WITH base AS (
    SELECT im.*, cb.full_name AS created_by_name, ab.full_name AS tech_approved_by_name, rb.full_name AS released_by_name
      FROM fdn_item_master im
      JOIN employees cb      ON cb.id = im.created_by_id
      LEFT JOIN employees ab ON ab.id = im.tech_approved_by_id
      LEFT JOIN employees rb ON rb.id = im.released_by_id
     WHERE ($1::text IS NULL OR im.item_code ILIKE $1 OR im.standard_name ILIKE $1 OR im.short_description ILIKE $1))`;

/** Latest BOM revision per assembly (only revisions that have lines exist). */
const LATEST_BOM = `
  latest_bom AS (
    SELECT b.* FROM fdn_assembly_bom b
     WHERE b.bom_revision = (SELECT max(b2.bom_revision) FROM fdn_assembly_bom b2 WHERE b2.assembly_id = b.assembly_id))`;

/** $1 = search. Assemblies + latest-revision line counts. */
const ASSEMBLIES_SQL = `
  WITH base AS (
    SELECT a.*, cb.full_name AS created_by_name, ab.full_name AS tech_approved_by_name
      FROM fdn_assembly_master a
      JOIN employees cb      ON cb.id = a.created_by_id
      LEFT JOIN employees ab ON ab.id = a.tech_approved_by_id
     WHERE ($1::text IS NULL OR a.assembly_code ILIKE $1 OR a.standard_name ILIKE $1 OR a.oem_compatibility ILIKE $1))`;

const ASSEMBLY_COUNTS = `
  LEFT JOIN LATERAL (
    SELECT max(b.bom_revision) AS latest_bom_revision FROM fdn_assembly_bom b WHERE b.assembly_id = f.id) lr ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS bom_lines,
           count(*) FILTER (WHERE im.status NOT IN ('APPROVED', 'ACTIVE'))::int AS draft_item_lines
      FROM fdn_assembly_bom b JOIN fdn_item_master im ON im.id = b.item_id
     WHERE b.assembly_id = f.id AND b.bom_revision = lr.latest_bom_revision) bl ON true`;

@Injectable()
export class StockDeskService {
  constructor(private readonly pg: PgService) {}

  /** GET /stock/journal */
  async journal(q: StockJournalQueryDto, actor: Actor) {
    const { page, pageSize, offset } = paging(q);
    const tz = await companyTimezone(this.pg, actor.companyId);
    const baseParams = [actor.companyId, likeTerm(q.search)];
    // $3 movement types, $4 reference kinds, $5 reference id, $6 item, $7 location roles, $8 from, $9 to, $10 tz
    const filtered = `${JOURNAL_SQL}
      SELECT * FROM base
       WHERE ($3::text[] IS NULL OR movement_type = ANY($3))
         AND ($4::text[] IS NULL OR reference_kind = ANY($4))
         AND ($5::uuid IS NULL OR reference_id = $5)
         AND ($6::uuid IS NULL OR item_id = $6)
         AND ($7::text[] IS NULL OR from_location_role = ANY($7) OR to_location_role = ANY($7))
         AND ($8::date IS NULL OR (posted_at AT TIME ZONE $10::text)::date >= $8::date)
         AND ($9::date IS NULL OR (posted_at AT TIME ZONE $10::text)::date <= $9::date)`;
    const params = [
      ...baseParams, arr(q.movement_type), arr(q.reference_kind), q.reference_id ?? null, q.item_id ?? null,
      arr(q.location_role), q.from ?? null, q.to ?? null, tz,
    ];
    const order = 'ORDER BY posted_at DESC, id DESC';

    const [counts, total, rows] = await Promise.all([
      this.pg.query<{ movement_type: MovementType; n: number }>(
        `${JOURNAL_SQL} SELECT movement_type, count(*)::int AS n FROM base GROUP BY movement_type`, baseParams),
      this.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${filtered}) f`, params),
      this.pg.query(`${filtered} ${order} LIMIT $11 OFFSET $12`, [...params, pageSize, offset]),
    ]);

    const counts_by_movement_type = zeros(MOVEMENT_TYPES);
    for (const r of counts.rows) counts_by_movement_type[r.movement_type] = r.n;

    return {
      rows: rows.rows.map((r) => {
        const kind: string = r.reference_kind;
        const doc = kind.startsWith('BR06_') && r.grn_number ? 'GRN'
          : kind.startsWith('BR07_') && r.job_number ? 'JOB'
            : kind === 'BR11_SALE_ISSUE' && r.outward_number ? 'SALES_OUTWARD' : null;
        return {
          id: r.id, posted_at: r.posted_at, movement_type: r.movement_type, status: r.status,
          item_id: r.item_id, item_code: r.item_code, item_name: r.item_name, uom: r.uom, qty: r.qty,
          from_location_role: r.from_location_role, from_location_code: r.from_location_code,
          to_location_role: r.to_location_role, to_location_code: r.to_location_code,
          reference_kind: kind, reference_id: r.reference_id, reference_document: doc,
          reference_label: doc === 'GRN' ? r.grn_number : doc === 'JOB' ? r.job_number : doc === 'SALES_OUTWARD' ? r.outward_number : null,
          grn_id: r.grn_id, po_id: r.po_id, po_number: r.po_number, job_id: r.job_id, job_number: r.job_number,
          outward_id: r.outward_id, sales_order_id: r.sales_order_id, sales_order_number: r.sales_order_number,
          actor_name: r.actor_name,
        };
      }),
      total: total.rows[0].n, page, page_size: pageSize, counts_by_movement_type,
    };
  }

  /** GET /stock/items */
  async items(q: StockItemsQueryDto) {
    const { page, pageSize, offset } = paging(q);
    const baseParams = [likeTerm(q.search)];
    const filtered = `${ITEMS_SQL}
      SELECT * FROM base
       WHERE ($2::text[] IS NULL OR status = ANY($2))
         AND ($3::text[] IS NULL OR record_type = ANY($3))
         AND ($4::text[] IS NULL OR stock_flag = ANY($4))`;
    const params = [...baseParams, arr(q.status), arr(q.record_type), arr(q.stock_flag)];

    const [byStatus, byType, total, rows] = await Promise.all([
      this.pg.query<{ k: MasterStatus; n: number }>(`${ITEMS_SQL} SELECT status AS k, count(*)::int AS n FROM base GROUP BY status`, baseParams),
      this.pg.query<{ k: RecordType; n: number }>(`${ITEMS_SQL} SELECT record_type AS k, count(*)::int AS n FROM base GROUP BY record_type`, baseParams),
      this.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${filtered}) f`, params),
      this.pg.query(`
        WITH ${LATEST_BOM.trim()}
        SELECT f.*, (SELECT count(DISTINCT lb.assembly_id)::int FROM latest_bom lb WHERE lb.item_id = f.id) AS bom_usage_count
          FROM (${filtered} ORDER BY item_code LIMIT $5 OFFSET $6) f
         ORDER BY f.item_code`, [...params, pageSize, offset]),
    ]);

    const counts_by_status = zeros(MASTER_STATUSES);
    for (const r of byStatus.rows) counts_by_status[r.k] = r.n;
    const counts_by_record_type = zeros(RECORD_TYPES);
    for (const r of byType.rows) counts_by_record_type[r.k] = r.n;

    return { rows: rows.rows.map(itemRow), total: total.rows[0].n, page, page_size: pageSize, counts_by_status, counts_by_record_type };
  }

  /** GET /stock/items/:id */
  async item(id: string, actor: Actor) {
    const [item, usedIn, alloc, balances] = await Promise.all([
      this.pg.query(`
        WITH ${LATEST_BOM.trim()}
        SELECT f.*, (SELECT count(DISTINCT lb.assembly_id)::int FROM latest_bom lb WHERE lb.item_id = f.id) AS bom_usage_count
          FROM (${ITEMS_SQL} SELECT * FROM base WHERE id = $2) f`, [null, id]),
      this.pg.query(`
        WITH ${LATEST_BOM.trim()}
        SELECT a.id AS assembly_id, a.assembly_code, a.standard_name, a.status AS assembly_status, lb.bom_revision,
               trim_scale(lb.qty_per)::text AS qty_per, lb.uom
          FROM latest_bom lb JOIN fdn_assembly_master a ON a.id = lb.assembly_id
         WHERE lb.item_id = $1
         ORDER BY a.assembly_code`, [id]),
      this.pg.query<{ allocatable: string; reserved: string }>(`
        SELECT trim_scale(fdn_allocatable($1, $2))::text AS allocatable,
               trim_scale(COALESCE((SELECT SUM(qty) FROM fdn_inventory_reservations
                                     WHERE company_id = $1 AND item_id = $2 AND status = 'ACTIVE'), 0))::text AS reserved`,
        [actor.companyId, id]),
      this.pg.query(`
        SELECT l.role, l.code, trim_scale(b.qty_on_hand)::text AS qty_on_hand
          FROM fdn_inventory_balances b JOIN fdn_inventory_locations l ON l.id = b.location_id
         WHERE b.company_id = $1 AND b.item_id = $2
         ORDER BY l.role, l.code`, [actor.companyId, id]),
    ]);
    const r = item.rows[0];
    if (!r) throw new NotFoundException('item not found');
    return {
      ...itemRow(r),
      criticality: r.criticality, hsn_tax: r.hsn_tax,
      reorder_min_qty: r.reorder_min_qty === null ? null : String(Number(r.reorder_min_qty)),
      lead_time_days: r.lead_time_days, batch_tracking: r.batch_tracking, serial_tracking: r.serial_tracking,
      released_at: r.released_at, released_by_name: r.released_by_name, effective_revision: r.effective_revision,
      used_in: usedIn.rows,
      availability: { allocatable: alloc.rows[0].allocatable, reserved: alloc.rows[0].reserved, balances: balances.rows },
    };
  }

  /** GET /stock/assemblies */
  async assemblies(q: StockAssembliesQueryDto) {
    const { page, pageSize, offset } = paging(q);
    const baseParams = [likeTerm(q.search)];
    const filtered = `${ASSEMBLIES_SQL} SELECT * FROM base WHERE ($2::text[] IS NULL OR status = ANY($2))`;
    const params = [...baseParams, arr(q.status)];

    const [byStatus, total, rows] = await Promise.all([
      this.pg.query<{ k: MasterStatus; n: number }>(`${ASSEMBLIES_SQL} SELECT status AS k, count(*)::int AS n FROM base GROUP BY status`, baseParams),
      this.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${filtered}) f`, params),
      this.pg.query(`
        SELECT f.*, lr.latest_bom_revision, COALESCE(bl.bom_lines, 0) AS bom_lines, COALESCE(bl.draft_item_lines, 0) AS draft_item_lines
          FROM (${filtered} ORDER BY assembly_code LIMIT $3 OFFSET $4) f
          ${ASSEMBLY_COUNTS}
         ORDER BY f.assembly_code`, [...params, pageSize, offset]),
    ]);

    const counts_by_status = zeros(MASTER_STATUSES);
    for (const r of byStatus.rows) counts_by_status[r.k] = r.n;
    return { rows: rows.rows.map(assemblyRow), total: total.rows[0].n, page, page_size: pageSize, counts_by_status };
  }

  /** GET /stock/assemblies/:id */
  async assembly(id: string, q: StockAssemblyDetailQueryDto) {
    const [head, revs] = await Promise.all([
      this.pg.query(`
        SELECT f.*, lr.latest_bom_revision, COALESCE(bl.bom_lines, 0) AS bom_lines, COALESCE(bl.draft_item_lines, 0) AS draft_item_lines
          FROM (${ASSEMBLIES_SQL} SELECT * FROM base WHERE id = $2) f
          ${ASSEMBLY_COUNTS}`, [null, id]),
      this.pg.query<{ r: number }>(
        `SELECT DISTINCT bom_revision AS r FROM fdn_assembly_bom WHERE assembly_id = $1 ORDER BY 1`, [id]),
    ]);
    const a = head.rows[0];
    if (!a) throw new NotFoundException('assembly not found');
    const revisions = revs.rows.map((x) => x.r);
    const revision = q.revision ?? a.latest_bom_revision ?? null;
    const lines = revision === null ? [] : (await this.pg.query(`
      SELECT b.id, b.item_id, im.item_code, im.standard_name AS item_name, trim_scale(b.qty_per)::text AS qty_per, b.uom,
             im.status AS item_status, im.status IN ('APPROVED', 'ACTIVE') AS item_requestable
        FROM fdn_assembly_bom b JOIN fdn_item_master im ON im.id = b.item_id
       WHERE b.assembly_id = $1 AND b.bom_revision = $2
       ORDER BY im.item_code`, [id, revision])).rows;
    return {
      ...assemblyRow(a),
      cc: a.cc, ss: a.ss, tt: a.tt, core_function: a.core_function, hardware_revision: a.hardware_revision,
      firmware_compat: a.firmware_compat, variant_interface: a.variant_interface,
      created_by_name: a.created_by_name, tech_approved_at: a.tech_approved_at, tech_approved_by_name: a.tech_approved_by_name,
      bom_revisions: revisions,
      bom_revision: revision,
      bom: lines,
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function itemRow(r: any) {
  return {
    id: r.id, item_code: r.item_code, standard_name: r.standard_name, short_description: r.short_description,
    record_type: r.record_type, base_uom: r.base_uom, stock_flag: r.stock_flag, status: r.status,
    cc: r.cc, ss: r.ss, tt: r.tt, use_case: r.use_case,
    created_at: r.created_at, created_by_name: r.created_by_name,
    tech_approved_at: r.tech_approved_at, tech_approved_by_name: r.tech_approved_by_name,
    bom_usage_count: r.bom_usage_count,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assemblyRow(r: any) {
  return {
    id: r.id, assembly_code: r.assembly_code, standard_name: r.standard_name, assembly_type: r.assembly_type,
    oem_compatibility: r.oem_compatibility, bom_status: r.bom_status, repairable: r.repairable, saleable: r.saleable,
    status: r.status, effective_revision: r.effective_revision, latest_bom_revision: r.latest_bom_revision,
    bom_lines: r.bom_lines, draft_item_lines: r.draft_item_lines, created_at: r.created_at,
  };
}
