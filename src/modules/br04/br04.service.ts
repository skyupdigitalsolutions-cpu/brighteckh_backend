import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgService } from '../../common/database/pg.service';
import { InventoryService } from '../inventory/inventory.service';
import {
  CreateQuoteDto, CreateRfqDto, MarkOfferValidityDto, RecordOfferDto, ReleaseToSalesDto, ReviseQuoteDto,
  StockCheckDto, SupplierInviteDto,
} from './dto/br04.dto';

interface Actor { id: string; role: string; companyId: string }

/**
 * BR-04: stock availability snapshot (reads the inventory API only, never
 * posts) -> per-job RFQ -> multiple supplier offers -> Purchase marks offer
 * lines valid/invalid -> customer quotation (Item or Assembled, full
 * component breakup) with immutable revisions. Pricing has no formula:
 * Purchase always types the final customer price manually and picks any
 * offer as the pricing reference; the quote-lines table has no cost/supplier
 * column by design, so supplier pricing can never leak to the customer side.
 */
@Injectable()
export class Br04Service {
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

  // ---------------------------------------------------------------- stock check (snapshot only)

  async stockCheck(jobId: string, dto: StockCheckDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);

        const req = await client.query<{ id: string; status: string; current_version_no: number }>(
          `SELECT id, status, current_version_no FROM br03_material_requests WHERE id=$1 AND job_id=$2`,
          [dto.material_request_id, jobId],
        );
        if (!req.rows[0]) throw new NotFoundException('material request not found for this job');
        if (req.rows[0].status === 'DRAFT') throw new BadRequestException('material request has not been submitted yet');

        const version = await client.query<{ id: string }>(
          `SELECT id FROM br03_material_request_versions WHERE request_id=$1 AND version_no=$2`,
          [req.rows[0].id, req.rows[0].current_version_no],
        );
        if (!version.rows[0]) throw new BadRequestException('material request has no submitted version');

        const lines = await client.query(
          `SELECT * FROM br03_material_request_lines WHERE request_id=$1 ORDER BY created_at`, [req.rows[0].id],
        );
        if (lines.rows.length === 0) throw new BadRequestException('material request has no lines');

        await client.query(
          `UPDATE br04_stock_checks SET is_current=false WHERE job_id=$1 AND is_current`, [jobId],
        );
        const check = await client.query(
          `INSERT INTO br04_stock_checks
             (company_id,job_id,material_request_id,material_request_version_id,checked_by_id,check_context,notes)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6,'MR_RECEIVED'),$7) RETURNING *`,
          [actor.companyId, jobId, req.rows[0].id, version.rows[0].id, actor.id,
            dto.check_context ?? null, dto.notes ?? null],
        );

        const resultLines: any[] = [];
        for (const line of lines.rows) {
          const item = await client.query<{ br01_item_id: string }>(
            `SELECT br01_item_id FROM br03_item_catalog_bridge WHERE id=$1`, [line.item_bridge_id],
          );
          if (!item.rows[0]) throw new BadRequestException(`item bridge row missing for line ${line.id}`);

          // Read-only: calls the single-writer inventory module's availability
          // query. BR-04 never posts a movement/reservation itself.
          const avail = await this.inventory.availability(actor.companyId, item.rows[0].br01_item_id);
          const byRole = (role: string) =>
            Number(avail.balances.find((b: any) => b.role === role)?.qty_on_hand ?? 0);
          // Ledger -> snapshot mapping (identical in br05 stockRecheck). The ledger keeps
          // QUARANTINE as its own location; this table models quarantine as a hold
          // INSIDE store on-hand (CHECK reserved+quarantined+... <= store_on_hand), so:
          //   store_on_hand = MAIN_STORE + QUARANTINE
          //   reserved      = active ledger reservations = MAIN_STORE - allocatable,
          //                   clamped to [0, MAIN_STORE] so the CHECK always holds
          //   available     = store_on_hand - reserved - quarantined (generated column)
          // Quarantined stock is therefore never counted as available, and it stays
          // non-allocatable in the ledger (fdn_allocatable counts MAIN_STORE only).
          const mainStore = byRole('MAIN_STORE');
          const quarantined = byRole('QUARANTINE');
          const engineerHeld = byRole('ENGINEER_HELD');
          const storeOnHand = mainStore + quarantined;
          const reserved = Math.min(mainStore, Math.max(0, mainStore - avail.allocatable));

          const r = await client.query(
            `INSERT INTO br04_stock_check_lines
               (stock_check_id,material_request_line_id,item_bridge_id,uom_snapshot,required_quantity,
                store_on_hand,engineer_held,store_reserved,store_quarantined)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [check.rows[0].id, line.id, line.item_bridge_id, line.uom_snapshot, line.quantity,
              storeOnHand, engineerHeld, reserved, quarantined],
          );
          resultLines.push(r.rows[0]);

          if (Number(r.rows[0].shortage_quantity) > 0) {
            await client.query(
              `INSERT INTO br04_shortage_sources (company_id,job_id,stock_check_line_id,shortage_quantity,created_by_id)
               VALUES ($1,$2,$3,$4,$5)`,
              [actor.companyId, jobId, r.rows[0].id, r.rows[0].shortage_quantity, actor.id],
            );
          }
        }

        await this.audit(client, actor.companyId, actor.id, 'br04_stock_checks', check.rows[0].id,
          'BR04_STOCK_CHECK_RECORDED', null, { header: check.rows[0], lines: resultLines });
        return { ...check.rows[0], lines: resultLines };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getStockChecks(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');

    const checks = await this.pg.query(
      `SELECT * FROM br04_stock_checks WHERE job_id=$1 ORDER BY checked_at DESC`, [jobId],
    );
    const withLines = await Promise.all(checks.rows.map(async (c) => {
      const lines = await this.pg.query(`SELECT * FROM br04_stock_check_lines WHERE stock_check_id=$1`, [c.id]);
      return { ...c, lines: lines.rows };
    }));
    return withLines;
  }

  async getShortages(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    const r = await this.pg.query(
      `SELECT * FROM br04_shortage_sources WHERE job_id=$1 ORDER BY created_at DESC`, [jobId],
    );
    return r.rows;
  }

  // ---------------------------------------------------------------- RFQ (per job, no cross-job grouping)

  async createRfq(jobId: string, dto: CreateRfqDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);
        if (dto.lines.length === 0) throw new BadRequestException('RFQ requires at least one line');

        const rfq = await client.query(
          `INSERT INTO br04_rfqs (company_id,created_by_id,notes) VALUES ($1,$2,$3) RETURNING *`,
          [actor.companyId, actor.id, dto.notes ?? null],
        );

        const createdLines: any[] = [];
        let lineNo = 1;
        for (const l of dto.lines) {
          const src = await client.query<{
            id: string; company_id: string; job_id: string; shortage_quantity: string; shortage_status: string;
          }>(
            `SELECT s.id, s.company_id, s.job_id, s.shortage_quantity, s.shortage_status, cl.item_bridge_id, cl.uom_snapshot
               FROM br04_shortage_sources s JOIN br04_stock_check_lines cl ON cl.id=s.stock_check_line_id
              WHERE s.id=$1`,
            [l.shortage_source_id],
          );
          if (!src.rows[0]) throw new BadRequestException(`shortage source ${l.shortage_source_id} not found`);
          const s = src.rows[0] as any;
          if (s.company_id !== actor.companyId) throw new ForbiddenException('shortage source belongs to another company');
          if (s.job_id !== jobId) {
            throw new BadRequestException('an RFQ cannot mix shortage sources from a different job (per-job only)');
          }

          const rfqLine = await client.query(
            `INSERT INTO br04_rfq_lines
               (rfq_id,line_no,item_bridge_id,quantity,uom,technical_specification,manufacturer_preference,
                preference_reason,desired_delivery_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [rfq.rows[0].id, lineNo++, s.item_bridge_id, s.shortage_quantity, s.uom_snapshot,
              l.technical_specification, l.manufacturer_preference ?? null, l.preference_reason ?? null,
              l.desired_delivery_by ?? null],
          );
          await client.query(
            `INSERT INTO br04_rfq_line_sources (rfq_line_id,shortage_source_id,demand_quantity)
             VALUES ($1,$2,$3)`,
            [rfqLine.rows[0].id, l.shortage_source_id, s.shortage_quantity],
          );
          await client.query(`UPDATE br04_shortage_sources SET shortage_status='IN_RFQ' WHERE id=$1`, [l.shortage_source_id]);
          createdLines.push(rfqLine.rows[0]);
        }

        await this.audit(client, actor.companyId, actor.id, 'br04_rfqs', rfq.rows[0].id,
          'BR04_RFQ_CREATED', null, { header: rfq.rows[0], lines: createdLines });
        return { ...rfq.rows[0], lines: createdLines };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getRfqs(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');

    const rfqs = await this.pg.query(
      `SELECT DISTINCT r.* FROM br04_rfqs r
         JOIN br04_rfq_lines l ON l.rfq_id=r.id
         JOIN br04_rfq_line_sources s ON s.rfq_line_id=l.id
         JOIN br04_shortage_sources sh ON sh.id=s.shortage_source_id
        WHERE sh.job_id=$1 ORDER BY r.created_at DESC`,
      [jobId],
    );
    return rfqs.rows;
  }

  async getRfq(id: string, actor: Actor) {
    const rfq = await this.pg.query(`SELECT * FROM br04_rfqs WHERE id=$1`, [id]);
    if (!rfq.rows[0]) throw new NotFoundException('RFQ not found');
    if (rfq.rows[0].company_id !== actor.companyId) throw new ForbiddenException('RFQ belongs to another company');

    const lines = await this.pg.query(`SELECT * FROM br04_rfq_lines WHERE rfq_id=$1 ORDER BY line_no`, [id]);
    const invites = await this.pg.query(`SELECT * FROM br04_rfq_supplier_invites WHERE rfq_id=$1`, [id]);
    const offers = await this.pg.query(
      `SELECT h.*, v.id AS version_id, v.version_no, v.comments
         FROM br04_supplier_offer_headers h
         JOIN br04_supplier_offer_versions v ON v.offer_header_id=h.id
        WHERE h.rfq_id=$1`,
      [id],
    );
    const offersWithLines = await Promise.all(offers.rows.map(async (o) => {
      const l = await this.pg.query(`SELECT * FROM br04_supplier_offer_lines WHERE offer_version_id=$1`, [o.version_id]);
      return { ...o, lines: l.rows };
    }));
    return { ...rfq.rows[0], lines: lines.rows, invites: invites.rows, offers: offersWithLines };
  }

  // ---------------------------------------------------------------- supplier invites + offers

  async addSupplierInvite(rfqId: string, dto: SupplierInviteDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const rfq = await client.query<{ company_id: string; rfq_status: string }>(
          `SELECT company_id, rfq_status FROM br04_rfqs WHERE id=$1 FOR UPDATE`, [rfqId],
        );
        if (!rfq.rows[0]) throw new NotFoundException('RFQ not found');
        if (rfq.rows[0].company_id !== actor.companyId) throw new ForbiddenException('RFQ belongs to another company');

        const invite = await client.query(
          `INSERT INTO br04_rfq_supplier_invites (rfq_id,supplier_name_snapshot,supplier_contact_snapshot)
           VALUES ($1,$2,$3) RETURNING *`,
          [rfqId, dto.supplier_name_snapshot, dto.supplier_contact_snapshot ?? null],
        );
        if (rfq.rows[0].rfq_status === 'DRAFT') {
          await client.query(`UPDATE br04_rfqs SET rfq_status='SENT', sent_at=now() WHERE id=$1`, [rfqId]);
        }
        await this.audit(client, actor.companyId, actor.id, 'br04_rfq_supplier_invites', invite.rows[0].id,
          'BR04_SUPPLIER_INVITED', null, invite.rows[0]);
        return invite.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException) throw e;
      this.mapErr(e);
    }
  }

  async recordOffer(rfqId: string, dto: RecordOfferDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const rfq = await client.query<{ company_id: string; rfq_status: string }>(
          `SELECT company_id, rfq_status FROM br04_rfqs WHERE id=$1 FOR UPDATE`, [rfqId],
        );
        if (!rfq.rows[0]) throw new NotFoundException('RFQ not found');
        if (rfq.rows[0].company_id !== actor.companyId) throw new ForbiddenException('RFQ belongs to another company');

        const invite = await client.query(
          `SELECT id FROM br04_rfq_supplier_invites WHERE id=$1 AND rfq_id=$2`, [dto.supplier_invite_id, rfqId],
        );
        if (!invite.rows[0]) throw new BadRequestException('supplier invite not found for this RFQ');

        const header = await client.query(
          `INSERT INTO br04_supplier_offer_headers
             (rfq_id,supplier_invite_id,supplier_quote_number,currency_code,payment_terms,validity_until,
              quote_date,attachment_uri,created_by_id)
           VALUES ($1,$2,$3,COALESCE($4,'INR'),$5,$6,$7,$8,$9) RETURNING *`,
          [rfqId, dto.supplier_invite_id, dto.supplier_quote_number ?? null, dto.currency_code ?? null,
            dto.payment_terms ?? null, dto.validity_until ?? null, dto.quote_date ?? null,
            dto.attachment_uri ?? null, actor.id],
        );
        const version = await client.query(
          `INSERT INTO br04_supplier_offer_versions
             (offer_header_id,version_no,quoted_valid_until,delivery_terms,warranty_terms,attachment_uri,comments,recorded_by_id)
           VALUES ($1,1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [header.rows[0].id, dto.validity_until ?? null, dto.delivery_terms ?? null, dto.warranty_terms ?? null,
            dto.attachment_uri ?? null, dto.comments ?? null, actor.id],
        );

        const createdLines: any[] = [];
        for (const l of dto.lines) {
          const rfqLine = await client.query(
            `SELECT id FROM br04_rfq_lines WHERE id=$1 AND rfq_id=$2`, [l.rfq_line_id, rfqId],
          );
          if (!rfqLine.rows[0]) throw new BadRequestException(`RFQ line ${l.rfq_line_id} not found on this RFQ`);

          const r = await client.query(
            `INSERT INTO br04_supplier_offer_lines
               (offer_version_id,rfq_line_id,offered_make,offered_part_number,product_condition,offered_quantity,
                quoted_unit_price,quoted_discount,freight_packing_nonrecoverable,nonrecoverable_tax,
                recoverable_tax,delivery_days,comparable_quantity)
             VALUES ($1,$2,$3,$4,COALESCE($5,'NEW'),$6,$7,COALESCE($8,0),COALESCE($9,0),COALESCE($10,0),
                     COALESCE($11,0),$12,$13)
             RETURNING *`,
            [version.rows[0].id, l.rfq_line_id, l.offered_make ?? null, l.offered_part_number ?? null,
              l.product_condition ?? null, l.offered_quantity, l.quoted_unit_price, l.quoted_discount ?? null,
              l.freight_packing_nonrecoverable ?? null, l.nonrecoverable_tax ?? null, l.recoverable_tax ?? null,
              l.delivery_days ?? null, l.comparable_quantity ?? null],
          );
          createdLines.push(r.rows[0]);
        }

        if (['DRAFT', 'SENT'].includes(rfq.rows[0].rfq_status)) {
          await client.query(`UPDATE br04_rfqs SET rfq_status='OFFERS_RECEIVED' WHERE id=$1`, [rfqId]);
        }
        await this.audit(client, actor.companyId, actor.id, 'br04_supplier_offer_headers', header.rows[0].id,
          'BR04_SUPPLIER_OFFER_RECORDED', null, { header: header.rows[0], version: version.rows[0], lines: createdLines });
        return { ...header.rows[0], version: version.rows[0], lines: createdLines };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async markOfferValidity(offerLineId: string, dto: MarkOfferValidityDto, actor: Actor) {
    const line = await this.pg.query<{ rfq_id: string }>(
      `SELECT r.company_id, r.id AS rfq_id FROM br04_supplier_offer_lines ol
         JOIN br04_supplier_offer_versions v ON v.id=ol.offer_version_id
         JOIN br04_supplier_offer_headers h ON h.id=v.offer_header_id
         JOIN br04_rfqs r ON r.id=h.rfq_id
        WHERE ol.id=$1`,
      [offerLineId],
    );
    if (!line.rows[0]) throw new NotFoundException('offer line not found');
    if ((line.rows[0] as any).company_id !== actor.companyId) throw new ForbiddenException('offer belongs to another company');

    try {
      const r = await this.pg.query(
        `UPDATE br04_supplier_offer_lines
            SET technical_status=$2, technical_checked_by_id=$3, technical_checked_at=now(), technical_reason=$4
          WHERE id=$1 RETURNING *`,
        [offerLineId, dto.valid ? 'COMPLIANT' : 'NONCOMPLIANT', actor.id, dto.reason ?? null],
      );
      return r.rows[0];
    } catch (e) {
      this.mapErr(e);
    }
  }

  // ---------------------------------------------------------------- customer quotation

  private lineTotal(lines: { quantity: number; net_unit_price_pre_tax: number }[]) {
    return Math.round(lines.reduce((sum, l) => sum + l.quantity * l.net_unit_price_pre_tax, 0) * 100) / 100;
  }

  private async insertQuoteLines(client: PoolClient, revisionId: string, lines: CreateQuoteDto['lines']) {
    const rows: any[] = [];
    let lineNo = 1;
    for (const l of lines) {
      const r = await client.query(
        `INSERT INTO br04_customer_quote_lines
           (quote_revision_id,line_no,line_type,line_description,quantity,uom,net_unit_price_pre_tax,
            scope_technically_indivisible,customer_selectable)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,false),COALESCE($9,true)) RETURNING *`,
        [revisionId, lineNo++, l.line_type, l.line_description, l.quantity, l.uom, l.net_unit_price_pre_tax,
          l.scope_technically_indivisible ?? null, l.customer_selectable ?? null],
      );
      rows.push(r.rows[0]);
    }
    return rows;
  }

  async createQuote(jobId: string, dto: CreateQuoteDto, actor: Actor) {
    if (dto.lines.length === 0) throw new BadRequestException('quote requires at least one line');
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);
        const total = this.lineTotal(dto.lines);

        const estimate = await client.query(
          `INSERT INTO br04_repair_estimates (company_id,job_id,created_by_id) VALUES ($1,$2,$3) RETURNING *`,
          [actor.companyId, jobId, actor.id],
        );
        const estimateRevision = await client.query(
          `INSERT INTO br04_estimate_revisions (estimate_id,revision_no,quoted_pre_tax_total,priced_by_id)
           VALUES ($1,0,$2,$3) RETURNING *`,
          [estimate.rows[0].id, total, actor.id],
        );

        const quoteNumber = await client.query<{ br04_next_quote_number: string }>(
          `SELECT br04_next_quote_number($1) AS br04_next_quote_number`, [actor.companyId],
        );
        const quote = await client.query(
          `INSERT INTO br04_customer_quotes (company_id,job_id,estimate_id,quote_number,created_by_id,quote_type)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [actor.companyId, jobId, estimate.rows[0].id, quoteNumber.rows[0].br04_next_quote_number, actor.id,
            dto.quote_type],
        );

        await this.validateOfferRefs(client, actor.companyId, dto.reference_offer_line_id, dto.procurement_offer_line_id);

        const revision = await client.query(
          `INSERT INTO br04_customer_quote_revisions
             (quote_id,estimate_revision_id,revision_no,original_authorised_pre_tax,revised_pre_tax,tax_total,
              freight_charge,currency_code,valid_until,terms_snapshot,inspection_fee_pre_tax,
              inspection_fee_agreement_ref,reference_offer_line_id,procurement_offer_line_id,created_by_id)
           VALUES ($1,$2,0,$3,$3,COALESCE($4,0),COALESCE($5,0),COALESCE($6,'INR'),$7,$8,COALESCE($9,0),$10,$11,$12,$13)
           RETURNING *`,
          [quote.rows[0].id, estimateRevision.rows[0].id, total, dto.tax_total ?? null, dto.freight_charge ?? null,
            dto.currency_code ?? null, dto.valid_until ?? null, dto.terms_snapshot ?? null,
            dto.inspection_fee_pre_tax ?? null, dto.inspection_fee_agreement_ref ?? null,
            dto.reference_offer_line_id ?? null, dto.procurement_offer_line_id ?? null, actor.id],
        );
        const lines = await this.insertQuoteLines(client, revision.rows[0].id, dto.lines);

        await this.audit(client, actor.companyId, actor.id, 'br04_customer_quotes', quote.rows[0].id,
          'BR04_QUOTE_CREATED', null, { quote: quote.rows[0], revision: revision.rows[0], lines });
        return { ...quote.rows[0], revision: revision.rows[0], lines };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  private async validateOfferRefs(client: PoolClient, companyId: string, refId?: string, procId?: string) {
    for (const id of [refId, procId].filter(Boolean) as string[]) {
      const r = await client.query<{ company_id: string }>(
        `SELECT r.company_id FROM br04_supplier_offer_lines ol
           JOIN br04_supplier_offer_versions v ON v.id=ol.offer_version_id
           JOIN br04_supplier_offer_headers h ON h.id=v.offer_header_id
           JOIN br04_rfqs r ON r.id=h.rfq_id
          WHERE ol.id=$1`,
        [id],
      );
      if (!r.rows[0]) throw new BadRequestException(`offer line ${id} not found`);
      if (r.rows[0].company_id !== companyId) throw new ForbiddenException('offer line belongs to another company');
    }
  }

  private async loadQuoteWithLatestRevision(client: PoolClient, quoteId: string, actor: Actor) {
    const quote = await client.query(`SELECT * FROM br04_customer_quotes WHERE id=$1 FOR UPDATE`, [quoteId]);
    if (!quote.rows[0]) throw new NotFoundException('quote not found');
    if (quote.rows[0].company_id !== actor.companyId) throw new ForbiddenException('quote belongs to another company');

    const revision = await client.query(
      `SELECT * FROM br04_customer_quote_revisions WHERE quote_id=$1 ORDER BY revision_no DESC LIMIT 1 FOR UPDATE`,
      [quoteId],
    );
    return { quote: quote.rows[0], revision: revision.rows[0] };
  }

  async reviseQuote(quoteId: string, dto: ReviseQuoteDto, actor: Actor) {
    if (dto.lines.length === 0) throw new BadRequestException('revision requires at least one line');
    try {
      return await this.pg.tx(async (client) => {
        const { quote, revision: latest } = await this.loadQuoteWithLatestRevision(client, quoteId, actor);
        const first = await client.query(
          `SELECT original_authorised_pre_tax FROM br04_customer_quote_revisions WHERE quote_id=$1 AND revision_no=0`,
          [quoteId],
        );
        const total = this.lineTotal(dto.lines);
        await this.validateOfferRefs(client, actor.companyId, dto.reference_offer_line_id, dto.procurement_offer_line_id);

        // UNCONFIRMED against CLAUDE.md section 6 ("no formula ... applies any %"):
        // br04_customer_quote_revisions_check4 in migration 001 blocks any revision
        // more than 10% below the original authorised price unless an explicit
        // higher-discount approver + reason is recorded. The API never fills these
        // in on Purchase's behalf -- the caller must explicitly name an approver.
        // If omitted and the discount exceeds 10%, the DB CHECK rejects the insert
        // and that is mapped to a clear message below.
        let higherDiscountApprovedAt: string | null = null;
        if (dto.higher_discount_approved_by_id) {
          const approver = await client.query<{ is_active: boolean }>(
            `SELECT is_active FROM employees WHERE id=$1 AND company_id=$2`,
            [dto.higher_discount_approved_by_id, actor.companyId],
          );
          if (!approver.rows[0] || !approver.rows[0].is_active) {
            throw new BadRequestException('higher_discount_approved_by_id must be an active employee in this company');
          }
          if (!dto.higher_discount_reason) {
            throw new BadRequestException('higher_discount_reason is required alongside higher_discount_approved_by_id');
          }
          higherDiscountApprovedAt = new Date().toISOString();
        }

        const estimateRevision = await client.query(
          `INSERT INTO br04_estimate_revisions (estimate_id,revision_no,quoted_pre_tax_total,priced_by_id,revision_reason)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [quote.estimate_id, latest.revision_no + 1, total, actor.id, dto.revision_reason],
        );

        const revision = await client.query(
          `INSERT INTO br04_customer_quote_revisions
             (quote_id,estimate_revision_id,revision_no,original_authorised_pre_tax,revised_pre_tax,tax_total,
              freight_charge,currency_code,valid_until,terms_snapshot,inspection_fee_pre_tax,
              inspection_fee_agreement_ref,reference_offer_line_id,procurement_offer_line_id,created_by_id,
              revision_reason,higher_discount_approved_by_id,higher_discount_approved_at,higher_discount_reason)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6,0),COALESCE($7,0),$8,$9,$10,COALESCE($11,0),$12,$13,$14,$15,$16,$17,$18,$19)
           RETURNING *`,
          [quoteId, estimateRevision.rows[0].id, latest.revision_no + 1, first.rows[0].original_authorised_pre_tax,
            total, dto.tax_total ?? null, dto.freight_charge ?? null, latest.currency_code, dto.valid_until ?? null,
            dto.terms_snapshot ?? null, dto.inspection_fee_pre_tax ?? null, dto.inspection_fee_agreement_ref ?? null,
            dto.reference_offer_line_id ?? null, dto.procurement_offer_line_id ?? null, actor.id,
            dto.revision_reason, dto.higher_discount_approved_by_id ?? null, higherDiscountApprovedAt,
            dto.higher_discount_reason ?? null],
        );
        const lines = await this.insertQuoteLines(client, revision.rows[0].id, dto.lines);

        await this.audit(client, actor.companyId, actor.id, 'br04_customer_quote_revisions', revision.rows[0].id,
          'BR04_QUOTE_REVISED', latest, { revision: revision.rows[0], lines });
        return { ...quote, revision: revision.rows[0], lines };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      if ((e as any)?.constraint === 'br04_customer_quote_revisions_check4') {
        throw new BadRequestException(
          'revision is more than 10% below the originally authorised price; needs explicit higher-discount approval + reason',
        );
      }
      this.mapErr(e);
    }
  }

  async releaseToSales(quoteId: string, dto: ReleaseToSalesDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const { revision: latest } = await this.loadQuoteWithLatestRevision(client, quoteId, actor);
        if (!latest) throw new NotFoundException('quote has no revision');
        if (latest.quote_status !== 'DRAFT') throw new BadRequestException('only a DRAFT revision can be released to Sales');

        const engineerCheck = await client.query<{ role_code: string; is_active: boolean }>(
          `SELECT role_code, is_active FROM employees WHERE id=$1 AND company_id=$2`, [dto.assigned_sales_id, actor.companyId],
        );
        if (!engineerCheck.rows[0] || !engineerCheck.rows[0].is_active || engineerCheck.rows[0].role_code !== 'SALES') {
          throw new BadRequestException('assigned_sales_id must be an active SALES employee in this company');
        }

        const updated = await client.query(
          `UPDATE br04_customer_quote_revisions SET quote_status='RELEASED_TO_SALES' WHERE id=$1 RETURNING *`,
          [latest.id],
        );
        await client.query(
          `INSERT INTO br04_quote_sales_handoffs (quote_revision_id,released_by_purchase_id,assigned_sales_id)
           VALUES ($1,$2,$3)`,
          [latest.id, actor.id, dto.assigned_sales_id],
        );
        await this.audit(client, actor.companyId, actor.id, 'br04_customer_quote_revisions', latest.id,
          'BR04_QUOTE_RELEASED_TO_SALES', latest, updated.rows[0]);
        return updated.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async sendQuote(quoteId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const { revision: latest } = await this.loadQuoteWithLatestRevision(client, quoteId, actor);
        if (!latest) throw new NotFoundException('quote has no revision');
        if (latest.quote_status !== 'RELEASED_TO_SALES') {
          throw new BadRequestException('quote must be released to Sales before it can be sent');
        }

        const handoff = await client.query(
          `SELECT id FROM br04_quote_sales_handoffs WHERE quote_revision_id=$1 AND assigned_sales_id=$2`,
          [latest.id, actor.id],
        );
        if (!handoff.rows[0]) throw new ForbiddenException('quote was not released to this Sales employee');

        const updated = await client.query(
          `UPDATE br04_customer_quote_revisions SET quote_status='SENT' WHERE id=$1 RETURNING *`, [latest.id],
        );
        await this.audit(client, actor.companyId, actor.id, 'br04_customer_quote_revisions', latest.id,
          'BR04_QUOTE_SENT', latest, updated.rows[0]);
        return updated.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getQuotes(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    const r = await this.pg.query(`SELECT * FROM br04_customer_quotes WHERE job_id=$1 ORDER BY created_at DESC`, [jobId]);
    return r.rows;
  }

  // Customer-facing detail. Deliberately does not join/resolve
  // reference_offer_line_id / procurement_offer_line_id into supplier pricing --
  // only the opaque internal ids are returned, never quoted_unit_price etc.
  async getQuote(id: string, actor: Actor) {
    const quote = await this.pg.query(`SELECT * FROM br04_customer_quotes WHERE id=$1`, [id]);
    if (!quote.rows[0]) throw new NotFoundException('quote not found');
    if (quote.rows[0].company_id !== actor.companyId) throw new ForbiddenException('quote belongs to another company');

    const revisions = await this.pg.query(
      `SELECT * FROM br04_customer_quote_revisions WHERE quote_id=$1 ORDER BY revision_no`, [id],
    );
    const withLines = await Promise.all(revisions.rows.map(async (rev) => {
      const lines = await this.pg.query(
        `SELECT * FROM br04_customer_quote_lines WHERE quote_revision_id=$1 ORDER BY line_no`, [rev.id],
      );
      return { ...rev, lines: lines.rows };
    }));
    return { ...quote.rows[0], revisions: withLines };
  }
}
