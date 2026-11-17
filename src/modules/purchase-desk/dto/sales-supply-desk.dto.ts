import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PageQueryDto } from './purchase-desk.dto';
import { PageMeta } from './purchase-desk.responses';
import { apply, csvArray } from './stores-desk.dto';

/**
 * BR-11 Sales & Supply desk reads (CLAUDE.md §4h "Sales & Supply desk reads"). Read-only lists with customer names,
 * counts and customer-facing totals for the Sales / Purchase / Finance / Management screens. Never supplier price or
 * cost (sourcing authorisations / SALES_ORDER POs stay on their PURCHASE-only routes). Money = paise (bigint string).
 */

export const ENQUIRY_STATUSES = ['RECEIVED', 'QUOTED', 'CANCELLED'] as const;
export const ORDER_STATUSES = ['DRAFT', 'VERIFIED', 'PART_DELIVERED', 'DELIVERED', 'CANCELLED', 'CLOSED'] as const;
export const OUTWARD_STATUSES = ['DRAFT', 'DISPATCHED', 'CANCELLED'] as const;
/** Derived from the LATEST revision (see SalesSupplyDeskService.QUOTE_STAGE_SQL). Not stored. */
export const QUOTE_STAGES = ['TO_PRICE', 'ISSUED', 'WITH_CUSTOMER', 'ACCEPTED', 'PART_ACCEPTED', 'REJECTED', 'CANCELLED'] as const;
export type QuoteStage = (typeof QUOTE_STAGES)[number];

const QUOTE_STAGE_DOC =
  'TO_PRICE = latest revision DRAFT (Purchase prices / issues it). CANCELLED = latest revision CANCELLED. For an ISSUED latest '
  + 'revision, from its newest customer response: ACCEPTED / PART_ACCEPTED / REJECTED = that response; ENQUIRY / NEGOTIATING / '
  + 'NO_RESPONSE = WITH_CUSTOMER; no response yet = WITH_CUSTOMER if the revision was sent (a dispatch event exists), else ISSUED.';

const statusFilter = (values: readonly string[], what: string) => [
  ApiPropertyOptional({ type: String, description: `${what} (comma-separated; one or more of ${values.join(', ')}). Omitted = all.` }),
  apply(csvArray(values)),
];

export class SupplyEnquiryQueryDto extends PageQueryDto {
  @apply(statusFilter(ENQUIRY_STATUSES, 'Enquiry status')) status?: string[];
}
export class SupplyQuoteQueryDto extends PageQueryDto {
  @apply([
    ApiPropertyOptional({ type: String, description: `Derived stage (comma-separated; ${QUOTE_STAGES.join(', ')}). ${QUOTE_STAGE_DOC}` }),
    apply(csvArray(QUOTE_STAGES)),
  ]) stage?: string[];
}
export class SupplyOrderQueryDto extends PageQueryDto {
  @apply(statusFilter(ORDER_STATUSES, 'Sales Order status')) status?: string[];
}
export class SupplyOutwardQueryDto extends PageQueryDto {
  @apply(statusFilter(OUTWARD_STATUSES, 'Outward status')) status?: string[];
}

// ---------------------------------------------------------------- shared

const nullableStr = (description?: string, format?: string) =>
  ApiProperty({ type: 'string', nullable: true, description, ...(format ? { format } : {}) });
const int = (description?: string) => ApiProperty({ type: 'integer', description });
const paise = (description: string) => ApiProperty({ type: 'string', format: 'int64', description: `${description} (paise, bigint string)` });

class SupplyCustomer {
  @ApiProperty({ format: 'uuid' }) customer_id!: string;
  @ApiProperty({ description: 'customers.customer_name (not BR-10 masked: an operational screen, same as GET /lookups/customers)' })
  customer_name!: string;
  @ApiProperty() customer_code!: string;
}

// ---------------------------------------------------------------- enquiries

export class SupplyEnquiryRow extends SupplyCustomer {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'SE-BLR-000012' }) enquiry_number!: string;
  @ApiProperty({ enum: ['EMAIL', 'WHATSAPP', 'PHONE', 'WEBSITE', 'WALK_IN', 'REFERRAL', 'OTHER'] }) enquiry_channel!: string;
  @nullableStr() enquiry_details!: string | null;
  @ApiProperty({ enum: ENQUIRY_STATUSES }) status!: string;
  @nullableStr(undefined, 'uuid') sales_owner_id!: string | null;
  @nullableStr('employees.full_name of sales_owner_id') sales_owner_name!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) created_at!: string;
  @int('br11_enquiry_lines') line_count!: number;
  @int('br11_sale_quotations raised from this enquiry') quote_count!: number;
  @nullableStr('newest quotation of this enquiry', 'uuid') latest_quote_id!: string | null;
  @nullableStr() latest_quote_number!: string | null;
}
export class SupplyEnquiryStatusCounts {
  @ApiProperty({ type: 'integer' }) RECEIVED!: number;
  @ApiProperty({ type: 'integer' }) QUOTED!: number;
  @ApiProperty({ type: 'integer' }) CANCELLED!: number;
}
export class SupplyEnquiryPage extends PageMeta {
  @ApiProperty({ type: [SupplyEnquiryRow], description: 'Newest first' }) rows!: SupplyEnquiryRow[];
  @ApiProperty({ type: SupplyEnquiryStatusCounts, description: 'Per-status totals under `search` only (ignores `status`)' })
  counts_by_status!: SupplyEnquiryStatusCounts;
}

// ---------------------------------------------------------------- quotes

export class SupplyQuoteRow extends SupplyCustomer {
  @ApiProperty({ format: 'uuid', description: 'br11_sale_quotations.id (GET /sales-quotes/:id)' }) quote_id!: string;
  @ApiProperty({ example: 'SQ-BLR-000007' }) quote_number!: string;
  @ApiProperty({ format: 'uuid' }) enquiry_id!: string;
  @ApiProperty() enquiry_number!: string;
  @ApiProperty({ format: 'uuid', description: 'LATEST br11_quote_revisions.id' }) latest_revision_id!: string;
  @int('0-based, as stored') revision_no!: number;
  @int('number of revisions') revisions_count!: number;
  @ApiProperty({ enum: ['DRAFT', 'ISSUED', 'CANCELLED'] }) revision_status!: string;
  @nullableStr('YYYY-MM-DD', 'date') validity_until!: string | null;
  @int('lines on the latest revision') line_count!: number;
  @paise('Sum of line_total_paise on the latest revision (customer price, pre-tax)') total_paise!: string;
  @nullableStr(undefined, 'date-time') released_at!: string | null;
  @nullableStr('newest br11_quote_dispatch_events.sent_at of the latest revision', 'date-time') last_sent_at!: string | null;
  @nullableStr('channel of that dispatch event') last_sent_channel!: string | null;
  @ApiProperty({ type: 'string', nullable: true, enum: ['ENQUIRY', 'NEGOTIATING', 'ACCEPTED', 'PART_ACCEPTED', 'REJECTED', 'NO_RESPONSE'] })
  latest_response_kind!: string | null;
  @nullableStr(undefined, 'date-time') latest_response_at!: string | null;
  @int('Sales Orders drafted from this quotation (any revision), excluding CANCELLED') sales_order_count!: number;
  @ApiProperty({ type: 'string', format: 'date-time', description: 'latest of revision created / released / sent / response' }) last_activity_at!: string;
  @ApiProperty({ enum: QUOTE_STAGES, description: QUOTE_STAGE_DOC }) stage!: QuoteStage;
}
export class SupplyQuoteStageCounts {
  @ApiProperty({ type: 'integer' }) TO_PRICE!: number;
  @ApiProperty({ type: 'integer' }) ISSUED!: number;
  @ApiProperty({ type: 'integer' }) WITH_CUSTOMER!: number;
  @ApiProperty({ type: 'integer' }) ACCEPTED!: number;
  @ApiProperty({ type: 'integer' }) PART_ACCEPTED!: number;
  @ApiProperty({ type: 'integer' }) REJECTED!: number;
  @ApiProperty({ type: 'integer' }) CANCELLED!: number;
}
export class SupplyQuotePage extends PageMeta {
  @ApiProperty({ type: [SupplyQuoteRow], description: 'last_activity_at descending, quote_number breaks ties' }) rows!: SupplyQuoteRow[];
  @ApiProperty({ type: SupplyQuoteStageCounts, description: 'Per-stage totals under `search` only (ignores `stage`)' })
  counts_by_stage!: SupplyQuoteStageCounts;
}

// ---------------------------------------------------------------- orders

export class SupplyOrderRow extends SupplyCustomer {
  @ApiProperty({ format: 'uuid', description: 'br11_sales_orders.id (GET /sales-orders/:id)' }) id!: string;
  @nullableStr('SO-<CODE>-000001, assigned at verify; null while DRAFT') sales_order_number!: string | null;
  @ApiProperty({ enum: ORDER_STATUSES }) status!: string;
  @ApiProperty({ format: 'uuid' }) quote_id!: string;
  @ApiProperty() quote_number!: string;
  @int('revision the order was drafted from') quote_revision_no!: number;
  @nullableStr() customer_order_reference!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) created_at!: string;
  @nullableStr(undefined, 'date-time') verified_at!: string | null;
  @nullableStr(undefined, 'date-time') closed_at!: string | null;
  @paise('Sum of round(accepted_qty x unit_price_paise) over the order lines (customer price, pre-tax)') order_total_paise!: string;
  @int() lines_total!: number;
  @int('lines with reserved (CONFIRMED) + shipped >= accepted qty') lines_reserved!: number;
  @int('lines with shipped >= accepted qty') lines_shipped!: number;
  @int('lines with outstanding_delivery_qty <= 0') lines_delivered!: number;
  @int('lines with invoiced >= accepted qty') lines_invoiced!: number;
  @int('authorisation evidence still PENDING verification') pending_authorisations!: number;
  @ApiProperty({ description: 'a br11_order_payment_conditions row exists (11B-02: required before reservation / sourcing)' })
  payment_terms_recorded!: boolean;
  @ApiProperty({ type: 'string', nullable: true, enum: ['NOT_REQUIRED', 'FIXED_AMOUNT', 'PERCENTAGE', 'FULL'] }) advance_kind!: string | null;
  @ApiProperty({ description: 'advance_kind NOT_REQUIRED, or Finance confirmed the advance (finance_confirmed_at set)' }) advance_cleared!: boolean;
  @int('change requests with decision PENDING') open_change_requests!: number;
  @int('outward batches carrying this order\'s lines, excluding CANCELLED') outward_count!: number;
}
export class SupplyOrderStatusCounts {
  @ApiProperty({ type: 'integer' }) DRAFT!: number;
  @ApiProperty({ type: 'integer' }) VERIFIED!: number;
  @ApiProperty({ type: 'integer' }) PART_DELIVERED!: number;
  @ApiProperty({ type: 'integer' }) DELIVERED!: number;
  @ApiProperty({ type: 'integer' }) CANCELLED!: number;
  @ApiProperty({ type: 'integer' }) CLOSED!: number;
}
export class SupplyOrderPage extends PageMeta {
  @ApiProperty({ type: [SupplyOrderRow], description: 'Newest first' }) rows!: SupplyOrderRow[];
  @ApiProperty({ type: SupplyOrderStatusCounts, description: 'Per-status totals under `search` only (ignores `status`)' })
  counts_by_status!: SupplyOrderStatusCounts;
}

// ---------------------------------------------------------------- outwards

export class SupplyOutwardOrderRef {
  @ApiProperty({ format: 'uuid' }) sales_order_id!: string;
  @nullableStr() sales_order_number!: string | null;
}
export class SupplyOutwardRow extends SupplyCustomer {
  @ApiProperty({ format: 'uuid', description: 'br11_outward_batches.id (GET /sales-outwards/:id)' }) id!: string;
  @nullableStr('SOUT-<CODE>-000001, assigned at dispatch; null while DRAFT / CANCELLED before dispatch') outward_number!: string | null;
  @ApiProperty({ enum: OUTWARD_STATUSES }) status!: string;
  @ApiProperty({ enum: ['COURIER', 'CUSTOMER_PICKUP', 'OWN_TRANSPORT', 'OTHER'] }) dispatch_mode!: string;
  @nullableStr() carrier_name!: string | null;
  @nullableStr() tracking_reference!: string | null;
  @nullableStr() recipient_name!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) created_at!: string;
  @nullableStr(undefined, 'date-time') dispatched_at!: string | null;
  @int() lines_total!: number;
  @int('lines past DRAFT (PICKED / DISPATCHED / DELIVERED)') lines_picked!: number;
  @int('lines with >= 1 packing-evidence row (the dispatch photo gate)') lines_with_packing_evidence!: number;
  @int('lines with status DELIVERED') lines_delivered!: number;
  @nullableStr('newest tracking event status_note', undefined) latest_tracking_note!: string | null;
  @nullableStr(undefined, 'date-time') latest_tracking_at!: string | null;
  @ApiProperty({ type: [SupplyOutwardOrderRef], description: 'Sales Orders whose lines are on this outward' }) sales_orders!: SupplyOutwardOrderRef[];
}
export class SupplyOutwardStatusCounts {
  @ApiProperty({ type: 'integer' }) DRAFT!: number;
  @ApiProperty({ type: 'integer' }) DISPATCHED!: number;
  @ApiProperty({ type: 'integer' }) CANCELLED!: number;
}
export class SupplyOutwardPage extends PageMeta {
  @ApiProperty({ type: [SupplyOutwardRow], description: 'Newest first' }) rows!: SupplyOutwardRow[];
  @ApiProperty({ type: SupplyOutwardStatusCounts, description: 'Per-status totals under `search` only (ignores `status`)' })
  counts_by_status!: SupplyOutwardStatusCounts;
}
