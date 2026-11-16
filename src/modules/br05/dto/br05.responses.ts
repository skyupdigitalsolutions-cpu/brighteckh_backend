import { ApiProperty } from '@nestjs/swagger';
import {
  Br05CustomerResponseEventsRow, Br05MaterialReservationsRow, Br05OrderJobAllocationsRow, Br05StockRecheckLinesRow,
  Br05StockRechecksRow,
} from '../../../common/swagger/rows.generated';

/** Element of GET /jobs/:id/stock-rechecks */
export class StockRecheckWithLines extends Br05StockRechecksRow {
  @ApiProperty({ type: [Br05StockRecheckLinesRow] }) lines!: Br05StockRecheckLinesRow[];
}

/** POST /jobs/:id/quote-responses */
export class QuoteResponseRecorded {
  @ApiProperty({ format: 'uuid', description: 'br05_quote_revision_refs.id (BR-05 bridge to the BR-04 quote revision)' })
  quote_revision_ref_id!: string;
  @ApiProperty({ type: Br05CustomerResponseEventsRow }) response!: Br05CustomerResponseEventsRow;
}

/** POST /jobs/:id/reservations — BR-05 row after it was COMMITTED against the inventory ledger. */
export class ReservationCommitted extends Br05MaterialReservationsRow {
  @ApiProperty({ type: 'number', description: 'Ledger allocatable qty after reserving' }) allocatable_after!: number;
}

/**
 * The BR-04 quote revision behind a br05_quote_revision_refs id (ref.source_br04_quote_id), resolved on read.
 * Added to the quote-response and order-allocation reads so a client can name the revision ("QT-BLR-000001 r1")
 * and match responses to GET /quotes/:id revisions by `source_br04_quote_revision_id`.
 */
const SRC = {
  source_br04_quote_revision_id: 'br04_customer_quote_revisions.id the BR-05 ref points to (br05_quote_revision_refs.source_br04_quote_id)',
  quote_id: 'br04_customer_quotes.id of that revision',
  quote_number: 'br04_customer_quotes.quote_number',
  revision_no: 'br04_customer_quote_revisions.revision_no (0-based, as stored)',
};

/** Element of GET /jobs/:id/quote-responses */
export class QuoteResponseEvent extends Br05CustomerResponseEventsRow {
  @ApiProperty({ format: 'uuid', description: SRC.source_br04_quote_revision_id }) source_br04_quote_revision_id!: string;
  @ApiProperty({ format: 'uuid', description: SRC.quote_id }) quote_id!: string;
  @ApiProperty({ description: SRC.quote_number }) quote_number!: string;
  @ApiProperty({ type: 'integer', description: SRC.revision_no }) revision_no!: number;
}

/** Element of GET /jobs/:id/order-allocations (accepted_quote_revision_id is the BR-05 ref id). */
export class OrderAllocation extends Br05OrderJobAllocationsRow {
  @ApiProperty({ format: 'uuid', description: SRC.source_br04_quote_revision_id }) source_br04_quote_revision_id!: string;
  @ApiProperty({ format: 'uuid', description: SRC.quote_id }) quote_id!: string;
  @ApiProperty({ description: SRC.quote_number }) quote_number!: string;
  @ApiProperty({ type: 'integer', description: SRC.revision_no }) revision_no!: number;
}
