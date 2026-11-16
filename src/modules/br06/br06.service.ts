import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgService } from '../../common/database/pg.service';
import { InventoryService } from '../inventory/inventory.service';
import {
  AcknowledgePoDto, AddGrnLineMediaDto, CreateGrnDto, CreatePoDto, CreateSalesOrderPoDto, CreateSalesSourcingDto,
  PostGrnLineDto, RecordShipmentDto,
} from './dto/br06.dto';

interface Actor { id: string; role: string; companyId: string }

/**
 * BR-06: supplier PO (from a BR-04 selected procurement offer + a BR-05
 * released job) -> acknowledgement -> shipment -> GRN with a photo-per-line
 * gate -> accepted quantity posts to MAIN_STORE via the inventory API;
 * rejected/held quantity posts to QUARANTINE (never usable) via the same API.
 * Supplier returns move quarantined stock out via the existing
 * /inventory/supplier-returns path. This module never writes
 * fdn_inventory_balances directly.
 *
 * DOFA (who may release a PO of what value) is an unconfirmed CLAUDE.md
 * section 5 blocker. releasePO() below does NOT implement a value-tiered
 * approval gate -- see the comment on that method. This mirrors BR-05, which
 * built nothing against br05_supplier_po_authority_policies for the same
 * reason.
 */
@Injectable()
export class Br06Service {
  constructor(private readonly pg: PgService, private readonly inventory: InventoryService) {}

  private mapErr(e: unknown): never {
    throw new BadRequestException((e as Error).message || 'request failed');
  }

  private async audit(
    client: PoolClient, companyId: string, actorId: string, entityTable: string,
    entityId: string, action: string, before: unknown, after: unknown,
  ) {
    await client.query(
      `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [companyId, actorId, entityTable, entityId, action, before ?? null, after ?? null],
    );
  }

  private async loadJob(client: PoolClient, jobId: string, actor: Actor) {
    const r = await client.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!r.rows[0]) throw new NotFoundException('job not found');
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    return r.rows[0];
  }

  private async locationByRole(client: PoolClient, companyId: string, role: string) {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM fdn_inventory_locations WHERE company_id=$1 AND role=$2 AND is_active LIMIT 1`,
      [companyId, role],
    );
    if (!r.rows[0]) throw new BadRequestException(`no active ${role} location configured for this company`);
    return r.rows[0].id;
  }

  // ---------------------------------------------------------------- supplier PO

  async createPo(jobId: string, dto: CreatePoDto, actor: Actor) {
    if (dto.offer_line_ids.length === 0) throw new BadRequestException('at least one offer_line_id is required');
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);

        const release = await client.query<{ id: string }>(
          `SELECT id FROM br05_job_releases WHERE job_id=$1 AND company_id=$2 AND release_status='RELEASED'
           ORDER BY released_at DESC LIMIT 1`,
          [jobId, actor.companyId],
        );
        if (!release.rows[0]) throw new BadRequestException('job has no RELEASED BR-05 job release');

        const lines: any[] = [];
        let supplierInviteId: string | null = null;
        let supplierName: string | null = null;
        for (const offerLineId of dto.offer_line_ids) {
          const row = await client.query(
            `SELECT ol.id, ol.quoted_unit_price, ol.offered_quantity,
                    rl.item_bridge_id, rl.uom,
                    h.supplier_invite_id, r.company_id,
                    inv.supplier_name_snapshot
               FROM br04_supplier_offer_lines ol
               JOIN br04_rfq_lines rl ON rl.id=ol.rfq_line_id
               JOIN br04_supplier_offer_versions v ON v.id=ol.offer_version_id
               JOIN br04_supplier_offer_headers h ON h.id=v.offer_header_id
               JOIN br04_rfqs r ON r.id=h.rfq_id
               JOIN br04_rfq_supplier_invites inv ON inv.id=h.supplier_invite_id
              WHERE ol.id=$1`,
            [offerLineId],
          );
          if (!row.rows[0]) throw new BadRequestException(`offer line ${offerLineId} not found`);
          const o = row.rows[0] as any;
          if (o.company_id !== actor.companyId) throw new ForbiddenException('offer line belongs to another company');
          if (supplierInviteId === null) {
            supplierInviteId = o.supplier_invite_id;
            supplierName = o.supplier_name_snapshot;
          } else if (o.supplier_invite_id !== supplierInviteId) {
            throw new BadRequestException('all offer lines on one PO must come from the same supplier invite');
          }
          lines.push(o);
        }

        const num = await client.query<{ br06_next_po_number: string }>(
          `SELECT br06_next_po_number($1) AS br06_next_po_number`, [actor.companyId],
        );
        const po = await client.query(
          `INSERT INTO br06_supplier_purchase_orders
             (company_id,job_id,po_number,source_br05_job_release_id,supplier_invite_id,supplier_name_snapshot,
              currency_code,payment_terms,created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'INR'),$8,$9) RETURNING *`,
          [actor.companyId, jobId, num.rows[0].br06_next_po_number, release.rows[0].id, supplierInviteId,
            supplierName, dto.currency_code ?? null, dto.payment_terms ?? null, actor.id],
        );

        const createdLines: any[] = [];
        let lineNo = 1;
        for (const l of lines) {
          const r = await client.query(
            `INSERT INTO br06_po_lines (po_id,line_no,source_br04_offer_line_id,item_bridge_id,quantity,uom,unit_price)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [po.rows[0].id, lineNo++, l.id, l.item_bridge_id, l.offered_quantity, l.uom, l.quoted_unit_price],
          );
          createdLines.push(r.rows[0]);
        }

        await this.audit(client, actor.companyId, actor.id, 'br06_supplier_purchase_orders', po.rows[0].id,
          'BR06_PO_CREATED', null, { header: po.rows[0], lines: createdLines });
        return { ...po.rows[0], lines: createdLines };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  // ---------------------------------------------------------------- SALES_ORDER purpose (BR-11, 11B-06)
  // Same PO table, same PO-number series, same release/ack/shipment/GRN path as
  // the repair PO. Only the source differs: an APPROVED sourcing authorisation
  // for one exact BR-11 Sales Order line -- never a repair Job ID. The DB
  // triggers (migration 018) enforce verified order, advance terms, quantity
  // ceiling, item match and non-L1 MD evidence; this layer checks company
  // ownership and gives clear errors.

  async createSalesSourcing(salesOrderLineId: string, dto: CreateSalesSourcingDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const line = await client.query(`SELECT company_id FROM br11_sales_order_lines WHERE id=$1`, [salesOrderLineId]);
        if (!line.rows[0]) throw new NotFoundException('sales order line not found');
        if (line.rows[0].company_id !== actor.companyId) throw new ForbiddenException('sales order line belongs to another company');
        const r = await client.query(
          `INSERT INTO br06_sales_sourcing_authorisations
             (company_id,sales_order_line_id,quantity,supplier_id,supplier_name_snapshot,supplier_unit_price,
              supplier_offer_evidence_uri,comparison_evidence_uri,selected_rank,md_approved_by_id,md_approved_at,
              md_approval_evidence_uri,authorised_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [actor.companyId, salesOrderLineId, dto.quantity, dto.supplier_id ?? null, dto.supplier_name, dto.supplier_unit_price,
            dto.supplier_offer_evidence_uri, dto.comparison_evidence_uri, dto.selected_rank, dto.md_approved_by_id ?? null,
            dto.md_approved_at ?? null, dto.md_approval_evidence_uri ?? null, actor.id],
        );
        await this.audit(client, actor.companyId, actor.id, 'br06_sales_sourcing_authorisations', r.rows[0].id,
          'BR06_SALES_SOURCING_AUTHORISED', null, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async cancelSalesSourcing(id: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const before = (await client.query(`SELECT * FROM br06_sales_sourcing_authorisations WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!before) throw new NotFoundException('sourcing authorisation not found');
        if (before.company_id !== actor.companyId) throw new ForbiddenException('sourcing authorisation belongs to another company');
        const r = await client.query(
          `UPDATE br06_sales_sourcing_authorisations SET authorisation_status='CANCELLED' WHERE id=$1 RETURNING *`, [id]);
        await this.audit(client, actor.companyId, actor.id, 'br06_sales_sourcing_authorisations', id,
          'BR06_SALES_SOURCING_CANCELLED', before, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async listSalesSourcing(salesOrderId: string, actor: Actor) {
    await this.ownedSalesOrder(salesOrderId, actor);
    const r = await this.pg.query(
      `SELECT a.* FROM br06_sales_sourcing_authorisations a
         JOIN br11_sales_order_lines l ON l.id=a.sales_order_line_id
        WHERE l.sales_order_id=$1 ORDER BY a.authorised_at`, [salesOrderId]);
    return r.rows;
  }

  private async ownedSalesOrder(salesOrderId: string, actor: Actor) {
    const so = await this.pg.query(`SELECT company_id FROM br11_sales_orders WHERE id=$1`, [salesOrderId]);
    if (!so.rows[0]) throw new NotFoundException('sales order not found');
    if (so.rows[0].company_id !== actor.companyId) throw new ForbiddenException('sales order belongs to another company');
  }

  async createSalesOrderPo(salesOrderId: string, dto: CreateSalesOrderPoDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const so = (await client.query(`SELECT * FROM br11_sales_orders WHERE id=$1`, [salesOrderId])).rows[0];
        if (!so) throw new NotFoundException('sales order not found');
        if (so.company_id !== actor.companyId) throw new ForbiddenException('sales order belongs to another company');

        const auths: any[] = [];
        for (const id of dto.sourcing_authorisation_ids) {
          const a = (await client.query(
            `SELECT a.*, l.sales_order_id, l.item_id, l.uom
               FROM br06_sales_sourcing_authorisations a JOIN br11_sales_order_lines l ON l.id=a.sales_order_line_id
              WHERE a.id=$1`, [id])).rows[0];
          if (!a) throw new BadRequestException(`sourcing authorisation ${id} not found`);
          if (a.company_id !== actor.companyId) throw new ForbiddenException('sourcing authorisation belongs to another company');
          if (a.sales_order_id !== salesOrderId) throw new BadRequestException('every sourcing authorisation must belong to this Sales Order');
          if (auths.length && (a.supplier_name_snapshot !== auths[0].supplier_name_snapshot || a.supplier_id !== auths[0].supplier_id)) {
            throw new BadRequestException('all sourcing authorisations on one PO must be for the same supplier');
          }
          const bridge = (await client.query(
            `SELECT id FROM br03_item_catalog_bridge WHERE br01_item_id=$1 AND approval_status='APPROVED' AND is_active`, [a.item_id])).rows[0];
          if (!bridge) throw new BadRequestException('the sale line item has no APPROVED item-catalogue entry to order against');
          auths.push({ ...a, item_bridge_id: bridge.id });
        }

        const num = await client.query<{ n: string }>(`SELECT br06_next_po_number($1) AS n`, [actor.companyId]);
        const po = await client.query(
          `INSERT INTO br06_supplier_purchase_orders
             (company_id,purchase_purpose,sales_order_id,po_number,supplier_id,supplier_name_snapshot,
              currency_code,payment_terms,created_by_id)
           VALUES ($1,'SALES_ORDER',$2,$3,$4,$5,COALESCE($6,'INR'),$7,$8) RETURNING *`,
          [actor.companyId, salesOrderId, num.rows[0].n, auths[0].supplier_id, auths[0].supplier_name_snapshot,
            dto.currency_code ?? null, dto.payment_terms ?? null, actor.id],
        );
        const lines: any[] = [];
        let lineNo = 1;
        for (const a of auths) {
          const r = await client.query(
            `INSERT INTO br06_po_lines (po_id,line_no,sales_sourcing_authorisation_id,item_bridge_id,quantity,uom,unit_price)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [po.rows[0].id, lineNo++, a.id, a.item_bridge_id, a.quantity, a.uom, a.supplier_unit_price],
          );
          lines.push(r.rows[0]);
        }
        await this.audit(client, actor.companyId, actor.id, 'br06_supplier_purchase_orders', po.rows[0].id,
          'BR06_SALES_ORDER_PO_CREATED', null, { header: po.rows[0], lines });
        return { ...po.rows[0], lines };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async listSalesOrderPos(salesOrderId: string, actor: Actor) {
    await this.ownedSalesOrder(salesOrderId, actor);
    const r = await this.pg.query(
      `SELECT * FROM br06_supplier_purchase_orders WHERE sales_order_id=$1 ORDER BY created_at DESC`, [salesOrderId]);
    return r.rows;
  }

  private async loadPo(client: PoolClient, poId: string, actor: Actor) {
    const r = await client.query(`SELECT * FROM br06_supplier_purchase_orders WHERE id=$1 FOR UPDATE`, [poId]);
    if (!r.rows[0]) throw new NotFoundException('purchase order not found');
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('PO belongs to another company');
    return r.rows[0];
  }

  // No value-tiered approval gate here: DOFA (who may release a PO of what
  // value) is an unconfirmed CLAUDE.md section 5 blocker. Any PURCHASE actor
  // can release a PO of any value today. This is the flagged stop, not a
  // silently-assumed-safe default -- do not treat it as production-ready.
  async releasePo(poId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const before = await this.loadPo(client, poId, actor);
        if (before.po_status !== 'DRAFT') throw new BadRequestException('only a DRAFT PO can be released');

        const r = await client.query(
          `UPDATE br06_supplier_purchase_orders
              SET po_status='RELEASED', released_by_id=$2, released_at=now()
            WHERE id=$1 RETURNING *`,
          [poId, actor.id],
        );
        await this.audit(client, actor.companyId, actor.id, 'br06_supplier_purchase_orders', poId,
          'BR06_PO_RELEASED', before, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async acknowledgePo(poId: string, dto: AcknowledgePoDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const before = await this.loadPo(client, poId, actor);
        if (before.po_status !== 'RELEASED') throw new BadRequestException('only a RELEASED PO can be acknowledged');

        await client.query(
          `INSERT INTO br06_po_acknowledgements (po_id,supplier_reference,expected_delivery_date,notes,recorded_by_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [poId, dto.supplier_reference ?? null, dto.expected_delivery_date ?? null, dto.notes ?? null, actor.id],
        );
        const r = await client.query(
          `UPDATE br06_supplier_purchase_orders SET po_status='ACKNOWLEDGED' WHERE id=$1 RETURNING *`, [poId],
        );
        await this.audit(client, actor.companyId, actor.id, 'br06_supplier_purchase_orders', poId,
          'BR06_PO_ACKNOWLEDGED', before, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async recordShipment(poId: string, dto: RecordShipmentDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const before = await this.loadPo(client, poId, actor);
        if (before.po_status !== 'ACKNOWLEDGED') throw new BadRequestException('only an ACKNOWLEDGED PO can be shipped');

        await client.query(
          `INSERT INTO br06_shipments (po_id,carrier,awb_or_lr_number,expected_arrival_date,notes,recorded_by_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [poId, dto.carrier ?? null, dto.awb_or_lr_number ?? null, dto.expected_arrival_date ?? null,
            dto.notes ?? null, actor.id],
        );
        const r = await client.query(
          `UPDATE br06_supplier_purchase_orders SET po_status='SHIPPED' WHERE id=$1 RETURNING *`, [poId],
        );
        await this.audit(client, actor.companyId, actor.id, 'br06_supplier_purchase_orders', poId,
          'BR06_PO_SHIPPED', before, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getPo(id: string, actor: Actor) {
    const po = await this.pg.query(`SELECT * FROM br06_supplier_purchase_orders WHERE id=$1`, [id]);
    if (!po.rows[0]) throw new NotFoundException('purchase order not found');
    if (po.rows[0].company_id !== actor.companyId) throw new ForbiddenException('PO belongs to another company');
    const lines = await this.pg.query(`SELECT * FROM br06_po_lines WHERE po_id=$1 ORDER BY line_no`, [id]);
    return { ...po.rows[0], lines: lines.rows };
  }

  async listPos(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    const r = await this.pg.query(
      `SELECT * FROM br06_supplier_purchase_orders WHERE job_id=$1 ORDER BY created_at DESC`, [jobId],
    );
    return r.rows;
  }

  // ---------------------------------------------------------------- GRN

  async createGrn(poId: string, dto: CreateGrnDto, actor: Actor) {
    if (dto.lines.length === 0) throw new BadRequestException('GRN requires at least one line');
    try {
      return await this.pg.tx(async (client) => {
        const po = await this.loadPo(client, poId, actor);
        if (!['ACKNOWLEDGED', 'SHIPPED'].includes(po.po_status)) {
          throw new BadRequestException('GRN requires the PO to be ACKNOWLEDGED or SHIPPED');
        }

        const num = await client.query<{ br06_next_grn_number: string }>(
          `SELECT br06_next_grn_number($1) AS br06_next_grn_number`, [actor.companyId],
        );
        const grn = await client.query(
          `INSERT INTO br06_grns (company_id,po_id,grn_number,received_by_id,notes)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [actor.companyId, poId, num.rows[0].br06_next_grn_number, actor.id, dto.notes ?? null],
        );

        const createdLines: any[] = [];
        for (const l of dto.lines) {
          const poLine = await client.query(
            `SELECT * FROM br06_po_lines WHERE id=$1 AND po_id=$2`, [l.po_line_id, poId],
          );
          if (!poLine.rows[0]) throw new BadRequestException(`PO line ${l.po_line_id} not found on this PO`);

          const r = await client.query(
            `INSERT INTO br06_grn_lines (grn_id,po_line_id,item_bridge_id,uom,ordered_quantity,received_quantity)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [grn.rows[0].id, l.po_line_id, poLine.rows[0].item_bridge_id, poLine.rows[0].uom,
              poLine.rows[0].quantity, l.received_quantity],
          );
          createdLines.push(r.rows[0]);
        }

        await this.audit(client, actor.companyId, actor.id, 'br06_grns', grn.rows[0].id,
          'BR06_GRN_CREATED', null, { header: grn.rows[0], lines: createdLines });
        return { ...grn.rows[0], lines: createdLines };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getGrn(id: string, actor: Actor) {
    const grn = await this.pg.query(`SELECT * FROM br06_grns WHERE id=$1`, [id]);
    if (!grn.rows[0]) throw new NotFoundException('GRN not found');
    if (grn.rows[0].company_id !== actor.companyId) throw new ForbiddenException('GRN belongs to another company');
    const lines = await this.pg.query(`SELECT * FROM br06_grn_lines WHERE grn_id=$1`, [id]);
    return { ...grn.rows[0], lines: lines.rows };
  }

  async listGrns(poId: string, actor: Actor) {
    const po = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM br06_supplier_purchase_orders WHERE id=$1`, [poId]);
    if (!po.rows[0]) throw new NotFoundException('purchase order not found');
    if (po.rows[0].company_id !== actor.companyId) throw new ForbiddenException('PO belongs to another company');
    const r = await this.pg.query(`SELECT * FROM br06_grns WHERE po_id=$1 ORDER BY received_at DESC`, [poId]);
    return r.rows;
  }

  private async loadGrnLine(client: PoolClient, grnLineId: string, actor: Actor) {
    const r = await client.query(
      `SELECT gl.*, g.company_id FROM br06_grn_lines gl JOIN br06_grns g ON g.id=gl.grn_id WHERE gl.id=$1 FOR UPDATE`,
      [grnLineId],
    );
    if (!r.rows[0]) throw new NotFoundException('GRN line not found');
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('GRN line belongs to another company');
    return r.rows[0];
  }

  /**
   * PO -> RECEIVED (rule confirmed by the product owner 14 Nov 2026, "all qty posted"): once EVERY line of the PO has
   * POSTED GRN quantity (accepted + rejected + held, summed over all of its GRNs) >= the ordered quantity, an
   * ACKNOWLEDGED / SHIPPED PO becomes RECEIVED. Rejected / held stock still counts as received (it follows the
   * supplier-return path); a partial receipt leaves the status unchanged. Runs in the disposition transaction with the
   * PO row locked, so concurrent posts of different lines can't both miss the final state. CLOSED is not set here.
   */
  private async advancePoIfFullyReceived(client: PoolClient, grnId: string, actor: Actor) {
    const po = await client.query<{ id: string; po_status: string }>(
      `SELECT p.id, p.po_status FROM br06_supplier_purchase_orders p
         JOIN br06_grns g ON g.po_id = p.id
        WHERE g.id = $1 FOR UPDATE OF p`,
      [grnId],
    );
    const before = po.rows[0];
    if (!before || !['ACKNOWLEDGED', 'SHIPPED'].includes(before.po_status)) return;

    const short = await client.query(
      `SELECT pl.id
         FROM br06_po_lines pl
         LEFT JOIN LATERAL (
           SELECT SUM(gl.accepted_quantity + gl.rejected_quantity + gl.held_quantity) AS posted
             FROM br06_grn_lines gl
            WHERE gl.po_line_id = pl.id AND gl.posted_at IS NOT NULL
         ) x ON true
        WHERE pl.po_id = $1 AND COALESCE(x.posted, 0) < pl.quantity
        LIMIT 1`,
      [before.id],
    );
    if (short.rows.length > 0) return;

    const after = await client.query(
      `UPDATE br06_supplier_purchase_orders SET po_status='RECEIVED' WHERE id=$1 RETURNING *`, [before.id],
    );
    await this.audit(client, actor.companyId, actor.id, 'br06_supplier_purchase_orders', before.id,
      'BR06_PO_RECEIVED', before, after.rows[0]);
  }

  async addGrnLineMedia(grnLineId: string, dto: AddGrnLineMediaDto, actor: Actor) {
    const line = await this.pg.query<{ company_id: string }>(
      `SELECT g.company_id FROM br06_grn_lines gl JOIN br06_grns g ON g.id=gl.grn_id WHERE gl.id=$1`, [grnLineId],
    );
    if (!line.rows[0]) throw new NotFoundException('GRN line not found');
    if (line.rows[0].company_id !== actor.companyId) throw new ForbiddenException('GRN line belongs to another company');

    const r = await this.pg.query(
      `INSERT INTO br06_grn_line_media (grn_line_id,file_uri,file_name,uploaded_by_id)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [grnLineId, dto.file_uri, dto.file_name, actor.id],
    );
    return r.rows[0];
  }

  // Records the accept/reject/hold disposition (gated by the photo trigger),
  // then posts to the real inventory ledger: accepted -> MAIN_STORE,
  // rejected+held -> QUARANTINE (never usable). Idempotent per line via a
  // deterministic key, so a retried call cannot double-post.
  async postGrnLine(grnLineId: string, dto: PostGrnLineDto, actor: Actor) {
    let disposed: any;
    try {
      disposed = await this.pg.tx(async (client) => {
        const line = await this.loadGrnLine(client, grnLineId, actor);

        if (line.posted_at) {
          // Disposition was already recorded. Only continue if the inventory
          // postings below didn't fully complete last time (safe retry, same
          // idempotency keys) -- otherwise this is a genuine re-post and must
          // be rejected rather than silently re-disposing the line.
          const needsMain = Number(line.accepted_quantity) > 0 && !line.main_store_movement_ref;
          const needsQuarantine = Number(line.rejected_quantity) + Number(line.held_quantity) > 0
            && !line.quarantine_movement_ref;
          if (!needsMain && !needsQuarantine) throw new BadRequestException('GRN line already posted');
          return line;
        }

        const total = dto.accepted_quantity + dto.rejected_quantity + dto.held_quantity;
        if (total > Number(line.received_quantity)) {
          throw new BadRequestException('accepted + rejected + held cannot exceed received quantity');
        }

        const r = await client.query(
          `UPDATE br06_grn_lines
              SET accepted_quantity=$2, rejected_quantity=$3, held_quantity=$4, posted_at=now()
            WHERE id=$1 RETURNING *`,
          [grnLineId, dto.accepted_quantity, dto.rejected_quantity, dto.held_quantity],
        );
        await this.audit(client, actor.companyId, actor.id, 'br06_grn_lines', grnLineId,
          'BR06_GRN_LINE_DISPOSED', line, r.rows[0]);
        await this.advancePoIfFullyReceived(client, line.grn_id, actor);
        return { ...r.rows[0], company_id: line.company_id };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }

    const item = await this.pg.query<{ br01_item_id: string }>(
      `SELECT br01_item_id FROM br03_item_catalog_bridge WHERE id=$1`, [disposed.item_bridge_id],
    );
    if (!item.rows[0]) throw new BadRequestException('item bridge row missing for this GRN line');

    let mainStoreRef: string | null = disposed.main_store_movement_ref ?? null;
    let quarantineRef: string | null = disposed.quarantine_movement_ref ?? null;

    if (Number(disposed.accepted_quantity) > 0 && !mainStoreRef) {
      const loc = await this.pg.query<{ id: string }>(
        `SELECT id FROM fdn_inventory_locations WHERE company_id=$1 AND role='MAIN_STORE' AND is_active LIMIT 1`,
        [disposed.company_id],
      );
      if (!loc.rows[0]) throw new BadRequestException('no active MAIN_STORE location configured for this company');
      const posted = await this.inventory.receipt(
        {
          company_id: disposed.company_id, item_id: item.rows[0].br01_item_id, uom: disposed.uom,
          qty: Number(disposed.accepted_quantity), to_location_id: loc.rows[0].id, reference_id: grnLineId,
        } as any,
        `grn-accept-${grnLineId}`,
        actor.id,
      );
      mainStoreRef = posted.transaction_id;
    }

    const quarantineQty = Number(disposed.rejected_quantity) + Number(disposed.held_quantity);
    if (quarantineQty > 0 && !quarantineRef) {
      const loc = await this.pg.query<{ id: string }>(
        `SELECT id FROM fdn_inventory_locations WHERE company_id=$1 AND role='QUARANTINE' AND is_active LIMIT 1`,
        [disposed.company_id],
      );
      if (!loc.rows[0]) throw new BadRequestException('no active QUARANTINE location configured for this company');
      const posted = await this.inventory.receipt(
        {
          company_id: disposed.company_id, item_id: item.rows[0].br01_item_id, uom: disposed.uom,
          qty: quarantineQty, to_location_id: loc.rows[0].id, reference_id: grnLineId,
        } as any,
        `grn-quarantine-${grnLineId}`,
        actor.id,
      );
      quarantineRef = posted.transaction_id;
    }

    const updated = await this.pg.tx(async (client) => {
      const r = await client.query(
        `UPDATE br06_grn_lines SET main_store_movement_ref=$2, quarantine_movement_ref=$3 WHERE id=$1 RETURNING *`,
        [grnLineId, mainStoreRef, quarantineRef],
      );
      await this.audit(client, disposed.company_id, actor.id, 'br06_grn_lines', grnLineId,
        'BR06_GRN_LINE_POSTED', disposed, r.rows[0]);
      return r.rows[0];
    });
    return updated;
  }

  // Returns the full currently-quarantined-and-not-yet-returned amount for
  // this line (rejected + held - already returned). Goes through the
  // existing /inventory/supplier-returns path (QUARANTINE -> SUPPLIER_RETURN).
  async initiateSupplierReturn(grnLineId: string, actor: Actor) {
    const line = await this.pg.query(
      `SELECT gl.*, g.company_id FROM br06_grn_lines gl JOIN br06_grns g ON g.id=gl.grn_id WHERE gl.id=$1`,
      [grnLineId],
    );
    if (!line.rows[0]) throw new NotFoundException('GRN line not found');
    if (line.rows[0].company_id !== actor.companyId) throw new ForbiddenException('GRN line belongs to another company');
    if (!line.rows[0].posted_at) throw new BadRequestException('GRN line has not been posted yet');

    const remaining = Number(line.rows[0].rejected_quantity) + Number(line.rows[0].held_quantity)
      - Number(line.rows[0].returned_quantity);
    if (remaining <= 0) throw new BadRequestException('nothing left in quarantine for this line to return');

    const item = await this.pg.query<{ br01_item_id: string }>(
      `SELECT br01_item_id FROM br03_item_catalog_bridge WHERE id=$1`, [line.rows[0].item_bridge_id],
    );
    const quarantineLoc = await this.pg.query<{ id: string }>(
      `SELECT id FROM fdn_inventory_locations WHERE company_id=$1 AND role='QUARANTINE' AND is_active LIMIT 1`,
      [actor.companyId],
    );
    const returnLoc = await this.pg.query<{ id: string }>(
      `SELECT id FROM fdn_inventory_locations WHERE company_id=$1 AND role='SUPPLIER_RETURN' AND is_active LIMIT 1`,
      [actor.companyId],
    );
    if (!quarantineLoc.rows[0] || !returnLoc.rows[0]) {
      throw new BadRequestException('no active QUARANTINE/SUPPLIER_RETURN location configured for this company');
    }

    const posted = await this.inventory.supplierReturn(
      {
        company_id: actor.companyId, item_id: item.rows[0].br01_item_id, uom: line.rows[0].uom, qty: remaining,
        from_location_id: quarantineLoc.rows[0].id, to_location_id: returnLoc.rows[0].id, reference_id: grnLineId,
      } as any,
      `grn-return-${grnLineId}`,
      actor.id,
    );

    const updated = await this.pg.tx(async (client) => {
      const r = await client.query(
        `UPDATE br06_grn_lines
            SET returned_quantity=returned_quantity+$2, return_movement_ref=$3
          WHERE id=$1 RETURNING *`,
        [grnLineId, remaining, posted.transaction_id],
      );
      await this.audit(client, actor.companyId, actor.id, 'br06_grn_lines', grnLineId,
        'BR06_SUPPLIER_RETURN_INITIATED', line.rows[0], r.rows[0]);
      return r.rows[0];
    });
    return updated;
  }
}
