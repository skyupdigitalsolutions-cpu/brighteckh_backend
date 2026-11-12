import { ApiProperty } from '@nestjs/swagger';
import {
  Br05CustomerResponseEventsRow, Br05MaterialReservationsRow, Br05StockRecheckLinesRow, Br05StockRechecksRow,
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
