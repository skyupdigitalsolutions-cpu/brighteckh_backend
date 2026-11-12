import { ApiProperty } from '@nestjs/swagger';
import {
  Br08GstRateConfigRow, Br11CarrierTrackingEventsRow, Br11CompanyPoliciesRow, Br11CustomerQuoteResponsesRow,
  Br11DeliveryEvidenceRow, Br11EnquiryLinesRow, Br11InventoryReservationRequestsRow, Br11OrderAuthorisationEventsRow,
  Br11OrderPaymentConditionsRow, Br11OutwardBatchesRow, Br11OutwardLinesRow, Br11PackingEvidenceRow,
  Br11QuoteDispatchEventsRow, Br11QuoteLinesRow, Br11QuoteRevisionsRow, Br11SaleQuotationsRow,
  Br11SalesChangeRequestsRow, Br11SalesEnquiriesRow, Br11SalesOrderClosureReviewsRow, Br11SalesOrdersRow,
  Br11VSalesOrderLinesRow,
} from '../../../common/swagger/rows.generated';

const PAISE = 'Integer paise, returned as a decimal string (bigint)';

export class SalesConfigBlocked {
  @ApiProperty({ description: 'true until an invoice trigger (not MILESTONE) AND a PRODUCT_SALE GST rate are configured' })
  product_invoicing!: boolean;
  @ApiProperty({ description: 'true until requires_full_payment_for_closure is configured' }) order_closure!: boolean;
}

export class SalesConfigResponse {
  @ApiProperty({ type: Br11CompanyPoliciesRow, nullable: true }) policy!: Br11CompanyPoliciesRow | null;
  @ApiProperty({ type: Br08GstRateConfigRow, nullable: true }) product_gst_rate!: Br08GstRateConfigRow | null;
  @ApiProperty({ type: SalesConfigBlocked }) blocked!: SalesConfigBlocked;
  @ApiProperty() note!: string;
}

export class EnquiryDetail extends Br11SalesEnquiriesRow {
  @ApiProperty({ type: [Br11EnquiryLinesRow] }) lines!: Br11EnquiryLinesRow[];
  @ApiProperty({ type: [Br11SaleQuotationsRow] }) quotes!: Br11SaleQuotationsRow[];
}

export class QuoteLineWithAvailability extends Br11QuoteLinesRow {
  @ApiProperty({ description: 'Current ledger allocatable for the item -- indicative only, nothing is reserved (11A-06)' })
  ledger_allocatable_qty!: string;
}

export class QuoteRevisionDetail extends Br11QuoteRevisionsRow {
  @ApiProperty({ type: [QuoteLineWithAvailability] }) lines!: QuoteLineWithAvailability[];
  @ApiProperty({ type: [Br11QuoteDispatchEventsRow] }) dispatch_events!: Br11QuoteDispatchEventsRow[];
  @ApiProperty({ type: [Br11CustomerQuoteResponsesRow] }) customer_responses!: Br11CustomerQuoteResponsesRow[];
}

export class SalesQuoteDetail extends Br11SaleQuotationsRow {
  @ApiProperty() availability_note!: string;
  @ApiProperty({ type: [QuoteRevisionDetail] }) revisions!: QuoteRevisionDetail[];
}

export class OrderInvoiceRef {
  @ApiProperty({ format: 'uuid' }) invoice_id!: string;
  @ApiProperty() invoice_number!: string;
  @ApiProperty() invoice_status!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) invoice_date!: string;
  @ApiProperty({ description: PAISE }) total_paise!: string;
  @ApiProperty({ description: PAISE }) amount_paid_paise!: string;
}

export class SalesOrderDetail extends Br11SalesOrdersRow {
  @ApiProperty({ type: [Br11VSalesOrderLinesRow], description: 'Per line: accepted / reserved / sourced / shipped / delivered / invoiced' })
  lines!: Br11VSalesOrderLinesRow[];
  @ApiProperty({ type: [Br11OrderAuthorisationEventsRow] }) authorisations!: Br11OrderAuthorisationEventsRow[];
  @ApiProperty({ type: Br11OrderPaymentConditionsRow, nullable: true }) payment_terms!: Br11OrderPaymentConditionsRow | null;
  @ApiProperty({ type: [Br11InventoryReservationRequestsRow] }) reservations!: Br11InventoryReservationRequestsRow[];
  @ApiProperty({ type: [Br11OutwardBatchesRow] }) outward_batches!: Br11OutwardBatchesRow[];
  @ApiProperty({ type: [Br11SalesChangeRequestsRow] }) change_requests!: Br11SalesChangeRequestsRow[];
  @ApiProperty({ type: Br11SalesOrderClosureReviewsRow, nullable: true }) closure_review!: Br11SalesOrderClosureReviewsRow | null;
  @ApiProperty({ type: [OrderInvoiceRef], description: 'BR-08 PRODUCT_SALES invoices (BR-08 is the owner)' }) invoices!: OrderInvoiceRef[];
}

export class ReservationResult extends Br11InventoryReservationRequestsRow {
  @ApiProperty({ required: false, description: 'Ledger allocatable after the reservation' }) allocatable_after?: number;
}

export class OutwardLineDetail extends Br11OutwardLinesRow {
  @ApiProperty({ type: [Br11PackingEvidenceRow] }) packing_evidence!: Br11PackingEvidenceRow[];
  @ApiProperty({ type: [Br11DeliveryEvidenceRow] }) delivery_evidence!: Br11DeliveryEvidenceRow[];
}

export class OutwardDetail extends Br11OutwardBatchesRow {
  @ApiProperty({ type: [OutwardLineDetail] }) lines!: OutwardLineDetail[];
  @ApiProperty({ type: [Br11CarrierTrackingEventsRow] }) tracking_events!: Br11CarrierTrackingEventsRow[];
}

export class ChangeDecisionResult {
  @ApiProperty({ type: Br11SalesChangeRequestsRow }) change_request!: Br11SalesChangeRequestsRow;
  @ApiProperty({ type: SalesOrderDetail }) order!: SalesOrderDetail;
}
