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

/** RFQ line with the catalogue-bridge item code/name (C2-1). */
export class RfqLineWithItem extends Br04RfqLinesRow {
  @ApiProperty({ type: 'string', nullable: true }) item_code!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) item_name!: string | null;
}

/** Where an RFQ line's demand came from (C2-2). */
export class RfqLineSourceLink {
  @ApiProperty({ format: 'uuid' }) rfq_line_id!: string;
  @ApiProperty({ type: 'integer' }) line_no!: number;
  @ApiProperty({ format: 'uuid', description: 'br04_shortage_sources.id' }) shortage_source_id!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) demand_quantity!: string;
  @ApiProperty({ format: 'uuid' }) job_id!: string;
  @ApiProperty({ format: 'uuid', description: 'br04_stock_check_lines.id' }) stock_check_line_id!: string;
  @ApiProperty({ format: 'uuid', description: 'br04_stock_checks.id' }) stock_check_id!: string;
  @ApiProperty({ format: 'uuid', description: 'br03_material_requests.id' }) material_request_id!: string;
  @ApiProperty() material_request_number!: string;
}

/** GET /rfqs/:id — RFQ with lines, supplier invites and every offer version (one entry per version). */
export class RfqDetail extends Br04RfqsRow {
  @ApiProperty({ type: [RfqLineWithItem], description: 'Ordered by line_no' }) lines!: RfqLineWithItem[];
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'The job the RFQ was raised from (RFQs are per job)' })
  job_id!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) job_number!: string | null;
  @ApiProperty({ type: [RfqLineSourceLink], description: 'Shortage -> stock-check line -> stock check -> material request, per line' })
  sources!: RfqLineSourceLink[];
  @ApiProperty({ type: [Br04RfqSupplierInvitesRow] }) invites!: Br04RfqSupplierInvitesRow[];
  @ApiProperty({ type: [RfqOfferWithLines] }) offers!: RfqOfferWithLines[];
}

export class QuoteRevisionWithLines extends Br04CustomerQuoteRevisionsRow {
  @ApiProperty({ type: [Br04CustomerQuoteLinesRow], description: 'Ordered by line_no' })
  lines!: Br04CustomerQuoteLinesRow[];
  @ApiProperty({
    type: String, format: 'uuid', nullable: true,
    description: 'br04_quote_sales_handoffs.assigned_sales_id for this revision; null until it is released to Sales',
  })
  assigned_sales_id!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'br04_quote_sales_handoffs.released_by_purchase_id' })
  released_to_sales_by_id!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'br04_quote_sales_handoffs.released_at' })
  released_to_sales_at!: string | null;
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
