import { ApiProperty } from '@nestjs/swagger';
import {
  Br04CustomerQuoteLinesRow, Br04CustomerQuoteRevisionsRow, Br04CustomerQuotesRow, Br04RfqLinesRow, Br04RfqsRow,
  Br04RfqSupplierInvitesRow, Br04StockCheckLinesRow, Br04StockChecksRow, Br04SupplierOfferHeadersRow,
  Br04SupplierOfferLinesRow, Br04SupplierOfferVersionsRow,
} from '../../../common/swagger/rows.generated';

/** Element of GET /jobs/:id/stock-checks (snapshot only — posts nothing to inventory). */
export class StockCheckWithLines extends Br04StockChecksRow {
  @ApiProperty({ type: [Br04StockCheckLinesRow] }) lines!: Br04StockCheckLinesRow[];
}

/** Supplier offer header joined with one of its versions, plus that version's lines. */
export class RfqOfferWithLines extends Br04SupplierOfferHeadersRow {
  @ApiProperty({ format: 'uuid', description: 'br04_supplier_offer_versions.id' }) version_id!: string;
  @ApiProperty({ type: 'integer' }) version_no!: number;
  @ApiProperty({ type: 'string', nullable: true }) comments!: string | null;
  @ApiProperty({ type: [Br04SupplierOfferLinesRow] }) lines!: Br04SupplierOfferLinesRow[];
}

/** GET /rfqs/:id — RFQ with lines, supplier invites and every offer version (one entry per version). */
export class RfqDetail extends Br04RfqsRow {
  @ApiProperty({ type: [Br04RfqLinesRow], description: 'Ordered by line_no' }) lines!: Br04RfqLinesRow[];
  @ApiProperty({ type: [Br04RfqSupplierInvitesRow] }) invites!: Br04RfqSupplierInvitesRow[];
  @ApiProperty({ type: [RfqOfferWithLines] }) offers!: RfqOfferWithLines[];
}

export class QuoteRevisionWithLines extends Br04CustomerQuoteRevisionsRow {
  @ApiProperty({ type: [Br04CustomerQuoteLinesRow], description: 'Ordered by line_no' })
  lines!: Br04CustomerQuoteLinesRow[];
}

/** GET /quotes/:id — customer quote with every revision and its lines. */
export class QuoteDetail extends Br04CustomerQuotesRow {
  @ApiProperty({ type: [QuoteRevisionWithLines], description: 'Ordered by revision_no' })
  revisions!: QuoteRevisionWithLines[];
}

/** POST /jobs/:id/rfqs — the new RFQ with the lines created from the chosen shortages. */
export class RfqWithLines extends Br04RfqsRow {
  @ApiProperty({ type: [Br04RfqLinesRow] }) lines!: Br04RfqLinesRow[];
}

/** POST /rfqs/:id/offers — supplier offer header with its first version and lines. */
export class OfferRecorded extends Br04SupplierOfferHeadersRow {
  @ApiProperty({ type: Br04SupplierOfferVersionsRow }) version!: Br04SupplierOfferVersionsRow;
  @ApiProperty({ type: [Br04SupplierOfferLinesRow] }) lines!: Br04SupplierOfferLinesRow[];
}

/** POST /jobs/:id/quotes and POST /quotes/:id/revise — quote header + the revision just created + its lines. */
export class QuoteWithRevision extends Br04CustomerQuotesRow {
  @ApiProperty({ type: Br04CustomerQuoteRevisionsRow, description: 'The revision created by this call' })
  revision!: Br04CustomerQuoteRevisionsRow;
  @ApiProperty({ type: [Br04CustomerQuoteLinesRow], description: 'Lines of that revision, ordered by line_no' })
  lines!: Br04CustomerQuoteLinesRow[];
}
