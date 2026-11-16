import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgService } from '../../common/database/pg.service';
import { InventoryService } from '../inventory/inventory.service';
import {
  AuthoriseJobDto, CreateOrderAllocationDto, CustomerAuthorityDto, RepairQuoteResponseDto, ReleaseJobDto,
  ReserveMaterialDto, StockRecheckDto, VerifyCustomerAuthorityDto,
} from './dto/br05.dto';

interface Actor { id: string; role: string; companyId: string }

/**
 * BR-05: customer quote response -> customer authority (PO / Job Order / verified
 * email, all first-class) -> order-job allocation -> job authorisation -> post-
 * authorisation stock recheck -> job release -> material reservation INTENT.
 *
 * Authorisation is only possible against a BR-04 quote revision that has actually
 * reached SENT/ACCEPTED (enforced by the DB trigger br05_guard_job_authorisation,
 * confirmed here with a clear pre-check too). Reservations are proposed as a BR-05
 * snapshot row, then confirmed only once the real inventory ledger (fdn_reserve,
 * via InventoryService) accepts the reservation -- this module never writes
 * fdn_inventory_balances directly.
 */
@Injectable()
export class Br05Service {
  constructor(private readonly pg: PgService, private readonly inventory: InventoryService) {}

  private mapErr(e: unknown): never {
    throw new BadRequestException((e as Error).message || 'request failed');
  }

  private async audit(
    client: PoolClient, companyId: string, actorId: string, jobId: string | null, entityType: string,
    entityId: string, eventCode: string, before: unknown, after: unknown,
  ) {
    await client.query(
      `INSERT INTO br05_audit_events(company_id,actor_id,job_id,entity_type,entity_id,event_code,before_state,after_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [companyId, actorId, jobId, entityType, entityId, eventCode, before ?? null, after ?? null],
    );
  }

  private async loadJob(client: PoolClient, jobId: string, actor: Actor) {
    const r = await client.query<{ company_id: string; inward_id: string }>(
      `SELECT company_id, inward_id FROM service_jobs WHERE id=$1`, [jobId],
    );
    if (!r.rows[0]) throw new NotFoundException('job not found');
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    return r.rows[0];
  }

  // ---------------------------------------------------------------- customer quote response

  async recordQuoteResponse(jobId: string, dto: RepairQuoteResponseDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);

        const quoteRev = await client.query<{ company_id: string; job_id: string }>(
          `SELECT q.company_id, q.job_id FROM br04_customer_quote_revisions r
             JOIN br04_customer_quotes q ON q.id=r.quote_id WHERE r.id=$1`,
          [dto.br04_quote_revision_id],
        );
        if (!quoteRev.rows[0]) throw new BadRequestException('BR-04 quote revision not found');
        if (quoteRev.rows[0].company_id !== actor.companyId || quoteRev.rows[0].job_id !== jobId) {
          throw new BadRequestException('quote revision does not belong to this job/company');
        }

        let bridge = await client.query<{ id: string }>(
          `SELECT id FROM br05_quote_revision_refs WHERE company_id=$1 AND job_id=$2 AND source_br04_quote_id=$3`,
          [actor.companyId, jobId, dto.br04_quote_revision_id],
        );
        if (!bridge.rows[0]) {
          bridge = await client.query(
            `INSERT INTO br05_quote_revision_refs (company_id,job_id,source_br04_quote_id,registered_by_id)
             VALUES ($1,$2,$3,$4) RETURNING id`,
            [actor.companyId, jobId, dto.br04_quote_revision_id, actor.id],
          );
        }

        const r = await client.query(
          `INSERT INTO br05_customer_response_events
             (quote_revision_id,response_type,response_channel,customer_contact,response_notes,evidence_uri,recorded_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [bridge.rows[0].id, dto.response_type, dto.response_channel ?? null, dto.customer_contact ?? null,
            dto.response_notes ?? null, dto.evidence_uri ?? null, actor.id],
        );
        await this.audit(client, actor.companyId, actor.id, jobId, 'br05_customer_response_events', r.rows[0].id,
          'BR05_QUOTE_RESPONSE_RECORDED', null, { bridge_id: bridge.rows[0].id, response: r.rows[0] });
        return { quote_revision_ref_id: bridge.rows[0].id, response: r.rows[0] };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getQuoteResponses(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');

    const r = await this.pg.query(
      // + the BR-04 revision behind the BR-05 ref (read-only join; no column changed).
      `SELECT e.*, b.source_br04_quote_id AS source_br04_quote_revision_id,
              q.id AS quote_id, q.quote_number, qr.revision_no
         FROM br05_customer_response_events e
         JOIN br05_quote_revision_refs b ON b.id=e.quote_revision_id
         JOIN br04_customer_quote_revisions qr ON qr.id=b.source_br04_quote_id
         JOIN br04_customer_quotes q ON q.id=qr.quote_id
        WHERE b.job_id=$1 ORDER BY e.responded_at DESC`,
      [jobId],
    );
    return r.rows;
  }

  // ---------------------------------------------------------------- customer authority (PO / Job Order / email)

  async createCustomerAuthority(jobId: string, dto: CustomerAuthorityDto, actor: Actor) {
    if (dto.authority_type === 'EMAIL_AUTHORISATION') {
      if (!dto.customer_email_sender || !dto.customer_email_received_at) {
        throw new BadRequestException('EMAIL_AUTHORISATION requires customer_email_sender and customer_email_received_at');
      }
    } else if (!dto.customer_order_ref) {
      throw new BadRequestException(`${dto.authority_type} requires customer_order_ref`);
    }
    try {
      return await this.pg.tx(async (client) => {
        const job = await this.loadJob(client, jobId, actor);
        const cust = await client.query<{ customer_id: string }>(
          `SELECT customer_id FROM inward_receipts WHERE id=$1`, [job.inward_id],
        );
        if (!cust.rows[0]) throw new BadRequestException('job has no linked customer');

        const r = await client.query(
          `INSERT INTO br05_customer_orders
             (company_id,customer_id,order_type,customer_order_ref,customer_email_sender,customer_email_received_at,
              received_by_id,pre_tax_total,tax_total,payment_terms_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [actor.companyId, cust.rows[0].customer_id, dto.authority_type, dto.customer_order_ref ?? null,
            dto.customer_email_sender ?? null, dto.customer_email_received_at ?? null, actor.id,
            dto.pre_tax_total ?? null, dto.tax_total ?? null, dto.payment_terms_snapshot ?? null],
        );
        await this.audit(client, actor.companyId, actor.id, jobId, 'br05_customer_orders', r.rows[0].id,
          'BR05_CUSTOMER_AUTHORITY_RECORDED', null, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async verifyCustomerAuthority(orderId: string, dto: VerifyCustomerAuthorityDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const before = await client.query<{ company_id: string; order_status: string }>(
          `SELECT * FROM br05_customer_orders WHERE id=$1 FOR UPDATE`, [orderId],
        );
        if (!before.rows[0]) throw new NotFoundException('customer order not found');
        if (before.rows[0].company_id !== actor.companyId) throw new ForbiddenException('order belongs to another company');
        if (before.rows[0].order_status !== 'RECEIVED') {
          throw new BadRequestException('only a RECEIVED order can be verified');
        }

        const r = await client.query(
          `UPDATE br05_customer_orders
              SET order_status='VERIFIED', verified_by_id=$2, verified_at=now(), verification_notes=$3
            WHERE id=$1 RETURNING *`,
          [orderId, actor.id, dto.verification_notes ?? null],
        );
        await this.audit(client, actor.companyId, actor.id, null, 'br05_customer_orders', orderId,
          'BR05_CUSTOMER_AUTHORITY_VERIFIED', before.rows[0], r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getCustomerAuthority(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string; inward_id: string }>(
      `SELECT company_id, inward_id FROM service_jobs WHERE id=$1`, [jobId],
    );
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');

    const cust = await this.pg.query<{ customer_id: string }>(
      `SELECT customer_id FROM inward_receipts WHERE id=$1`, [job.rows[0].inward_id],
    );
    const r = await this.pg.query(
      `SELECT * FROM br05_customer_orders WHERE company_id=$1 AND customer_id=$2 ORDER BY created_at DESC`,
      [actor.companyId, cust.rows[0]?.customer_id ?? null],
    );
    return r.rows;
  }

  // ---------------------------------------------------------------- order-job allocation

  async createOrderAllocation(jobId: string, dto: CreateOrderAllocationDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);

        const bridge = await client.query<{ id: string }>(
          `SELECT id FROM br05_quote_revision_refs WHERE id=$1 AND company_id=$2 AND job_id=$3`,
          [dto.quote_revision_ref_id, actor.companyId, jobId],
        );
        if (!bridge.rows[0]) throw new BadRequestException('quote_revision_ref_id not found for this job');

        const r = await client.query(
          `INSERT INTO br05_order_job_allocations
             (company_id,order_id,job_id,accepted_quote_revision_id,allocated_pre_tax)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [actor.companyId, dto.order_id, jobId, dto.quote_revision_ref_id, dto.allocated_pre_tax],
        );
        await this.audit(client, actor.companyId, actor.id, jobId, 'br05_order_job_allocations', r.rows[0].id,
          'BR05_ORDER_ALLOCATION_CREATED', null, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async verifyOrderAllocation(allocationId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const before = await client.query<{ company_id: string; job_id: string; allocation_status: string }>(
          `SELECT * FROM br05_order_job_allocations WHERE id=$1 FOR UPDATE`, [allocationId],
        );
        if (!before.rows[0]) throw new NotFoundException('order allocation not found');
        if (before.rows[0].company_id !== actor.companyId) throw new ForbiddenException('allocation belongs to another company');
        if (before.rows[0].allocation_status !== 'PROPOSED') {
          throw new BadRequestException('only a PROPOSED allocation can be verified');
        }

        const r = await client.query(
          `UPDATE br05_order_job_allocations SET allocation_status='VERIFIED' WHERE id=$1 RETURNING *`, [allocationId],
        );
        await this.audit(client, actor.companyId, actor.id, before.rows[0].job_id, 'br05_order_job_allocations',
          allocationId, 'BR05_ORDER_ALLOCATION_VERIFIED', before.rows[0], r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getOrderAllocations(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    const r = await this.pg.query(
      // + the BR-04 revision behind accepted_quote_revision_id (a BR-05 ref id).
      `SELECT a.*, b.source_br04_quote_id AS source_br04_quote_revision_id,
              q.id AS quote_id, q.quote_number, qr.revision_no
         FROM br05_order_job_allocations a
         JOIN br05_quote_revision_refs b ON b.id=a.accepted_quote_revision_id
         JOIN br04_customer_quote_revisions qr ON qr.id=b.source_br04_quote_id
         JOIN br04_customer_quotes q ON q.id=qr.quote_id
        WHERE a.job_id=$1 ORDER BY a.created_at DESC`, [jobId],
    );
    return r.rows;
  }

  // ---------------------------------------------------------------- job authorisation

  async authoriseJob(jobId: string, dto: AuthoriseJobDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);

        const allocation = await client.query(
          `SELECT * FROM br05_order_job_allocations WHERE id=$1 AND company_id=$2 AND job_id=$3`,
          [dto.order_job_allocation_id, actor.companyId, jobId],
        );
        if (!allocation.rows[0]) throw new BadRequestException('order allocation not found for this job');
        if (allocation.rows[0].allocation_status !== 'VERIFIED') {
          throw new BadRequestException('order allocation must be VERIFIED before authorisation');
        }

        const order = await client.query<{ order_type: string; order_status: string }>(
          `SELECT order_type, order_status FROM br05_customer_orders WHERE id=$1`, [allocation.rows[0].order_id],
        );
        if (!order.rows[0] || order.rows[0].order_status !== 'VERIFIED') {
          throw new BadRequestException('customer order must be VERIFIED before authorisation');
        }

        // Explicit, clearly-worded pre-check for the confirmed rule: a quote that
        // never reached Sales/customer cannot authorise a job. The DB trigger
        // (br05_guard_job_authorisation) enforces this independently as a backstop.
        const quote = await client.query<{ quote_status: string; valid_until: string | null }>(
          `SELECT r.quote_status, r.valid_until FROM br05_quote_revision_refs b
             JOIN br04_customer_quote_revisions r ON r.id=b.source_br04_quote_id
            WHERE b.id=$1`,
          [allocation.rows[0].accepted_quote_revision_id],
        );
        if (!quote.rows[0] || !['SENT', 'ACCEPTED'].includes(quote.rows[0].quote_status)) {
          throw new BadRequestException(
            'the BR-04 quote behind this allocation was never released to Sales/customer (must be SENT or ACCEPTED)',
          );
        }
        if (quote.rows[0].valid_until && new Date(quote.rows[0].valid_until) < new Date()) {
          throw new BadRequestException('the BR-04 quote has expired (valid_until is in the past)');
        }

        await client.query(
          `UPDATE br05_job_authorisations SET is_current=false, ended_at=now() WHERE job_id=$1 AND is_current`,
          [jobId],
        );

        const r = await client.query(
          `INSERT INTO br05_job_authorisations
             (company_id,job_id,order_job_allocation_id,authorised_by_id,authorisation_kind,scope_snapshot,authorised_amount_pre_tax)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [actor.companyId, jobId, dto.order_job_allocation_id, actor.id, order.rows[0].order_type,
            JSON.stringify(allocation.rows[0].approved_scope_snapshot ?? []), allocation.rows[0].allocated_pre_tax],
        );
        await this.audit(client, actor.companyId, actor.id, jobId, 'br05_job_authorisations', r.rows[0].id,
          'BR05_JOB_AUTHORISED', null, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getAuthorisations(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    const r = await this.pg.query(
      `SELECT * FROM br05_job_authorisations WHERE job_id=$1 ORDER BY authorised_at DESC`, [jobId],
    );
    return r.rows;
  }

  // ---------------------------------------------------------------- post-authorisation stock recheck

  async stockRecheck(jobId: string, dto: StockRecheckDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);

        const auth = await client.query<{ id: string }>(
          `SELECT id FROM br05_job_authorisations WHERE job_id=$1 AND is_current AND authorisation_status='AUTHORISED'`,
          [jobId],
        );
        if (!auth.rows[0]) throw new BadRequestException('job has no current AUTHORISED authorisation');

        const req = await client.query<{ id: string }>(
          `SELECT id FROM br03_material_requests WHERE id=$1 AND job_id=$2`, [dto.material_request_id, jobId],
        );
        if (!req.rows[0]) throw new NotFoundException('material request not found for this job');

        const lines = await client.query(
          `SELECT * FROM br03_material_request_lines WHERE request_id=$1 ORDER BY created_at`, [req.rows[0].id],
        );
        if (lines.rows.length === 0) throw new BadRequestException('material request has no lines');

        await client.query(`UPDATE br05_stock_rechecks SET is_current=false WHERE job_id=$1 AND is_current`, [jobId]);
        const recheck = await client.query(
          `INSERT INTO br05_stock_rechecks (company_id,job_id,job_authorisation_id,checked_by_id)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [actor.companyId, jobId, auth.rows[0].id, actor.id],
        );

        const resultLines: any[] = [];
        for (const line of lines.rows) {
          const item = await client.query<{ br01_item_id: string }>(
            `SELECT br01_item_id FROM br03_item_catalog_bridge WHERE id=$1`, [line.item_bridge_id],
          );
          if (!item.rows[0]) throw new BadRequestException(`item bridge row missing for line ${line.id}`);

          // Read-only: same inventory-API read BR-04 uses, taken fresh post-authorisation.
          const avail = await this.inventory.availability(actor.companyId, item.rows[0].br01_item_id);
          const byRole = (role: string) =>
            Number(avail.balances.find((b: any) => b.role === role)?.qty_on_hand ?? 0);
          // Ledger -> snapshot mapping (identical in br04 stockCheck). The ledger keeps
          // QUARANTINE as its own location; this table models quarantine as a hold
          // INSIDE store physical (CHECK reserved+quarantined+... <= store_physical), so:
          //   store_physical = MAIN_STORE + QUARANTINE
          //   reserved       = active ledger reservations = MAIN_STORE - allocatable,
          //                    clamped to [0, MAIN_STORE] so the CHECK always holds
          //   available      = store_physical - reserved - quarantined (generated column)
          // Quarantined stock is therefore never counted as available, and it stays
          // non-allocatable in the ledger (fdn_allocatable counts MAIN_STORE only).
          const mainStore = byRole('MAIN_STORE');
          const quarantined = byRole('QUARANTINE');
          const engineerHeld = byRole('ENGINEER_HELD');
          const storePhysical = mainStore + quarantined;
          const reserved = Math.min(mainStore, Math.max(0, mainStore - avail.allocatable));

          const r = await client.query(
            `INSERT INTO br05_stock_recheck_lines
               (stock_recheck_id,material_request_line_id,item_bridge_id,uom,required_quantity,
                store_physical_quantity,engineer_held_quantity,reserved_store_quantity,quarantined_store_quantity)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [recheck.rows[0].id, line.id, line.item_bridge_id, line.uom_snapshot, line.quantity,
              storePhysical, engineerHeld, reserved, quarantined],
          );
          resultLines.push(r.rows[0]);
        }

        await this.audit(client, actor.companyId, actor.id, jobId, 'br05_stock_rechecks', recheck.rows[0].id,
          'BR05_STOCK_RECHECK_RECORDED', null, { header: recheck.rows[0], lines: resultLines });
        return { ...recheck.rows[0], lines: resultLines };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getStockRechecks(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    const checks = await this.pg.query(
      `SELECT * FROM br05_stock_rechecks WHERE job_id=$1 ORDER BY checked_at DESC`, [jobId],
    );
    const withLines = await Promise.all(checks.rows.map(async (c) => {
      const lines = await this.pg.query(`SELECT * FROM br05_stock_recheck_lines WHERE stock_recheck_id=$1`, [c.id]);
      return { ...c, lines: lines.rows };
    }));
    return withLines;
  }

  // ---------------------------------------------------------------- job release

  async releaseJob(jobId: string, dto: ReleaseJobDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);

        const auth = await client.query<{ id: string }>(
          `SELECT id FROM br05_job_authorisations WHERE job_id=$1 AND is_current AND authorisation_status='AUTHORISED'`,
          [jobId],
        );
        if (!auth.rows[0]) throw new BadRequestException('job has no current AUTHORISED authorisation');

        const recheck = await client.query<{ id: string }>(
          `SELECT id FROM br05_stock_rechecks WHERE job_id=$1 AND is_current AND job_authorisation_id=$2`,
          [jobId, auth.rows[0].id],
        );
        if (!recheck.rows[0]) {
          throw new BadRequestException('job has no current stock recheck matching the current authorisation');
        }

        const r = await client.query(
          `INSERT INTO br05_job_releases (company_id,job_id,job_authorisation_id,stock_recheck_id,released_by_id,release_notes)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [actor.companyId, jobId, auth.rows[0].id, recheck.rows[0].id, actor.id, dto.release_notes ?? null],
        );
        // Deliberately not touching service_jobs.status: BR-05 has no approved
        // status-enum value for "released" (see CLAUDE.md / migration 001's own
        // comment "(n) BR05 does not update service_jobs.status with unapproved
        // enum values").
        await this.audit(client, actor.companyId, actor.id, jobId, 'br05_job_releases', r.rows[0].id,
          'BR05_JOB_RELEASED', null, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getRelease(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    const r = await this.pg.query(
      `SELECT * FROM br05_job_releases WHERE job_id=$1 ORDER BY released_at DESC`, [jobId],
    );
    return r.rows;
  }

  // ---------------------------------------------------------------- material reservation INTENT

  async reserveMaterial(jobId: string, dto: ReserveMaterialDto, actor: Actor) {
    let proposed: any;
    try {
      proposed = await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);

        const release = await client.query<{ id: string }>(
          `SELECT id FROM br05_job_releases WHERE job_id=$1 AND release_status='RELEASED' ORDER BY released_at DESC LIMIT 1`,
          [jobId],
        );
        if (!release.rows[0]) throw new BadRequestException('job has no RELEASED job release');

        const line = await client.query<{ item_bridge_id: string; uom: string }>(
          `SELECT item_bridge_id, uom FROM br05_stock_recheck_lines WHERE id=$1`, [dto.stock_recheck_line_id],
        );
        if (!line.rows[0]) throw new NotFoundException('stock recheck line not found');

        // This row is PROPOSED intent only -- the trigger br05_guard_material_reservation
        // validates it against the BR-05 snapshot (available_store_quantity) and
        // serialises via a row lock. It is NOT a real inventory-ledger reservation.
        const r = await client.query(
          `INSERT INTO br05_material_reservations
             (company_id,job_id,job_release_id,stock_recheck_line_id,reserved_quantity,created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [actor.companyId, jobId, release.rows[0].id, dto.stock_recheck_line_id, dto.reserved_quantity, actor.id],
        );
        await this.audit(client, actor.companyId, actor.id, jobId, 'br05_material_reservations', r.rows[0].id,
          'BR05_RESERVATION_PROPOSED', null, r.rows[0]);
        return { reservation: r.rows[0], itemBridgeId: line.rows[0].item_bridge_id, uom: line.rows[0].uom };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }

    // Confirm against the REAL inventory ledger. Deliberately outside the BR-05 tx:
    // the PROPOSED row above already committed, so a failure here just leaves it
    // PROPOSED (safe, retryable, idempotent on the key below) rather than risking
    // a committed external reservation with no corresponding BR-05 record.
    const item = await this.pg.query<{ br01_item_id: string }>(
      `SELECT br01_item_id FROM br03_item_catalog_bridge WHERE id=$1`, [proposed.itemBridgeId],
    );
    let ledger: { reservation_id: string; allocatable_after: number };
    try {
      ledger = await this.inventory.reserve(
        {
          company_id: proposed.reservation.company_id,
          item_id: item.rows[0].br01_item_id,
          uom: proposed.uom,
          qty: Number(proposed.reservation.reserved_quantity),
          reference_id: proposed.reservation.id,
        } as any,
        `br05-reservation-${proposed.reservation.id}`,
        actor.id,
      );
    } catch (e) {
      throw new BadRequestException(
        `reservation proposed (${proposed.reservation.id}) but the inventory ledger rejected it: ${(e as Error).message}`,
      );
    }

    const committed = await this.pg.tx(async (client) => {
      const r = await client.query(
        `UPDATE br05_material_reservations
            SET reservation_status='COMMITTED', inventory_reservation_ref=$2, committed_at=now()
          WHERE id=$1 RETURNING *`,
        [proposed.reservation.id, ledger.reservation_id],
      );
      await this.audit(client, actor.companyId, actor.id, jobId, 'br05_material_reservations', proposed.reservation.id,
        'BR05_RESERVATION_COMMITTED', proposed.reservation, r.rows[0]);
      return r.rows[0];
    });
    return { ...committed, allocatable_after: ledger.allocatable_after };
  }

  async getReservations(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    const r = await this.pg.query(
      `SELECT * FROM br05_material_reservations WHERE job_id=$1 ORDER BY created_at DESC`, [jobId],
    );
    return r.rows;
  }
}
