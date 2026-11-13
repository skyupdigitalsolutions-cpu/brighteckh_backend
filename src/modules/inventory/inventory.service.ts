import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { ReceiptDto, InventoryReserveDto, IssueDto, ConsumeDto, ReturnDto, SupplierReturnDto } from './dto/inventory.dto';

/**
 * Inventory ledger consumer-facing service. This is the SINGLE WRITER boundary:
 * all physical movements go through the DB function fdn_post_movement (append-only
 * journal + materialised balances under row lock, idempotent on idempotency_key).
 * BR-04/05/06/07 call these endpoints; they never touch balances directly.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly pg: PgService) {}

  private mapErr(e: unknown): never {
    const m = (e as Error).message || '';
    if (m.includes('INSUFFICIENT_STOCK')) throw new ConflictException('INSUFFICIENT_STOCK');
    if (m.includes('MISSING_ITEM_APPROVAL')) throw new BadRequestException('MISSING_ITEM_APPROVAL');
    if (m.includes('COMPANY_MISMATCH')) throw new BadRequestException('COMPANY_MISMATCH');
    throw new BadRequestException(m);
  }

  async availability(companyId: string, itemId: string) {
    const [alloc, byLoc] = await Promise.all([
      this.pg.query(`SELECT fdn_allocatable($1,$2) AS allocatable`, [companyId, itemId]),
      this.pg.query(
        `SELECT l.role, l.code, b.qty_on_hand
           FROM fdn_inventory_balances b JOIN fdn_inventory_locations l ON l.id=b.location_id
          WHERE b.company_id=$1 AND b.item_id=$2 ORDER BY l.role`, [companyId, itemId]),
    ]);
    return {
      company_id: companyId,
      item_id: itemId,
      allocatable: Number(alloc.rows[0].allocatable),
      balances: byLoc.rows,
    };
  }

  private async post(type: string, refKind: string, d: any, from: string | null, to: string | null,
                     idem: string, actor: string) {
    if (!idem) throw new BadRequestException('Idempotency-Key header required');
    try {
      const r = await this.pg.query<{ id: string }>(
        `SELECT fdn_post_movement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS id`,
        [d.company_id, d.item_id, d.uom, d.qty, from, to, type, refKind, d.reference_id, idem, actor],
      );
      const journalId = (r.rows[0] as any).id;
      const avail = await this.availability(d.company_id, d.item_id);
      return { transaction_id: journalId, status: 'POSTED', available_after: avail.allocatable, version: avail };
    } catch (e) { this.mapErr(e); }
  }

  receipt(d: ReceiptDto, idem: string, actor: string) {
    return this.post('RECEIPT', 'BR06_GRN_LINE', d, null, d.to_location_id, idem, actor);
  }
  issue(d: IssueDto, idem: string, actor: string) {
    return this.post('ISSUE', 'BR07_ISSUE', d, d.from_location_id, d.to_location_id, idem, actor);
  }
  consume(d: ConsumeDto, idem: string, actor: string) {
    return this.post('CONSUME', 'BR07_CONSUME', d, d.from_location_id, d.to_location_id, idem, actor);
  }
  returnMaterial(d: ReturnDto, idem: string, actor: string) {
    return this.post('RETURN', 'BR07_RETURN', d, d.from_location_id, d.to_location_id, idem, actor);
  }
  supplierReturn(d: SupplierReturnDto, idem: string, actor: string) {
    return this.post('SUPPLIER_RETURN', 'BR06_SUPPLIER_RETURN', d, d.from_location_id, d.to_location_id, idem, actor);
  }

  /**
   * BR-11 product sale: saleable stock physically leaves the company at outward
   * dispatch. ISSUE out of MAIN_STORE with no destination location (the goods
   * now belong to the customer). Same single writer, same idempotency.
   */
  saleIssue(d: { company_id: string; item_id: string; uom: string; qty: number; from_location_id: string; reference_id: string },
            idem: string, actor: string) {
    return this.post('ISSUE', 'BR11_SALE_ISSUE', d, d.from_location_id, null, idem, actor);
  }

  /** refKind distinguishes the consumer (BR-05 job vs BR-11 sales order) on the ledger row. */
  async reserve(d: InventoryReserveDto, idem: string, actor: string,
                refKind: 'BR05_JOB_RESERVATION' | 'BR11_SALES_RESERVATION' = 'BR05_JOB_RESERVATION') {
    if (!idem) throw new BadRequestException('Idempotency-Key header required');
    try {
      const r = await this.pg.query<{ id: string }>(
        `SELECT fdn_reserve($1,$2,$3,$4,$5,$6,$7,$8) AS id`,
        [d.company_id, d.item_id, d.qty, refKind, d.reference_id, idem, actor,
         d.expires_at ?? null],
      );
      const avail = await this.availability(d.company_id, d.item_id);
      return { reservation_id: (r.rows[0] as any).id, status: 'ACTIVE', allocatable_after: avail.allocatable };
    } catch (e) { this.mapErr(e); }
  }

  /**
   * BR-07 material issue converts a reservation into physical engineer custody.
   * Once the ISSUE movement has left MAIN_STORE the ACTIVE reservation must be
   * closed, or fdn_allocatable would subtract the same quantity twice. Goes
   * through the foundation's own fdn_release_reservation (no-op unless ACTIVE,
   * so safe to retry).
   */
  async consumeReservation(reservationId: string, status: 'CONSUMED' | 'RELEASED' = 'CONSUMED') {
    try {
      await this.pg.query(`SELECT fdn_release_reservation($1,$2)`, [reservationId, status]);
      const r = await this.pg.query(`SELECT id,status FROM fdn_inventory_reservations WHERE id=$1`, [reservationId]);
      return r.rows[0];
    } catch (e) { this.mapErr(e); }
  }

  journal(companyId: string, refId?: string) {
    const sql = refId
      ? `SELECT * FROM fdn_inventory_journal WHERE company_id=$1 AND reference_id=$2 ORDER BY posted_at`
      : `SELECT * FROM fdn_inventory_journal WHERE company_id=$1 ORDER BY posted_at DESC LIMIT 100`;
    return this.pg.query(sql, refId ? [companyId, refId] : [companyId]).then((r) => r.rows);
  }
}
