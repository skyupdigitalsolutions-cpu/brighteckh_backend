import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString,
  IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';

// NOTE: no DTO accepts a document number (SE/SQ/SO/SOUT/INV), a status, a tax
// figure or an order-line price. The DB assigns numbers, derives statuses from
// evidence and snapshots prices from the issued quote line; forbidNonWhitelisted
// rejects any attempt to send them.

const CONDITIONS = ['NEW', 'REFURBISHED', 'REPAIRED', 'OTHER'];

// ---------------------------------------------------------------- config (CLIENT-UNCONFIRMED)

export class SalesPolicyDto {
  @ApiPropertyOptional({ enum: ['ADVANCE', 'DISPATCH', 'DELIVERY', 'MILESTONE'], nullable: true,
    description: '11C-07 product invoice trigger. null = unconfigured = product invoicing BLOCKED. MILESTONE has no schedule model and stays blocked.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(['ADVANCE', 'DISPATCH', 'DELIVERY', 'MILESTONE'])
  invoice_trigger?: string | null;
  @ApiPropertyOptional({ nullable: true, description: '11C-09 full payment before closure. null = unconfigured = closure BLOCKED.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsBoolean() requires_full_payment_for_closure?: boolean | null;
  @ApiPropertyOptional({ enum: ['NONE', 'PER_ORDER'], nullable: true,
    description: '11B-02 company advance policy (026). NONE = an order with no recorded payment terms needs no advance; terms recorded on an order still apply. null / PER_ORDER = terms must be recorded before reservation / sourcing.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(['NONE', 'PER_ORDER'])
  advance_policy?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

// ---------------------------------------------------------------- 11A enquiry

export class EnquiryLineDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(500) product_description!: string;
  @ApiPropertyOptional({ description: 'Item Master id if already identified' }) @IsOptional() @IsUUID() item_id?: string;
  @ApiProperty({ example: 5 }) @IsNumber() @Min(0.0001) requested_qty!: number;
  @ApiProperty({ example: 'NOS' }) @IsString() @MinLength(1) @MaxLength(16) uom!: string;
  @ApiPropertyOptional({ enum: CONDITIONS }) @IsOptional() @IsIn(CONDITIONS) desired_condition?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class CreateEnquiryDto {
  @ApiProperty() @IsUUID() customer_id!: string;
  @ApiProperty({ enum: ['EMAIL', 'WHATSAPP', 'PHONE', 'WEBSITE', 'WALK_IN', 'REFERRAL', 'OTHER'] })
  @IsIn(['EMAIL', 'WHATSAPP', 'PHONE', 'WEBSITE', 'WALK_IN', 'REFERRAL', 'OTHER']) enquiry_channel!: string;
  @ApiProperty() @IsString() @MinLength(1) enquiry_details!: string;
  @ApiPropertyOptional({ description: 'Email / chat export / call note (11A-02: retain source evidence)' })
  @IsOptional() @IsString() source_evidence_uri?: string;
  @ApiProperty({ type: [EnquiryLineDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => EnquiryLineDto)
  lines!: EnquiryLineDto[];
}

export class ReasonDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
}

export class ListQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customer_id?: string;
}

// ---------------------------------------------------------------- 11A quotation (PURCHASE prices, SALES sends)

export class RevisionTermsDto {
  @ApiProperty({ example: '2026-12-15', description: 'Quote valid until (company-local date)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/) validity_until!: string;
  @ApiPropertyOptional({ description: 'Accepted payment terms text, e.g. "30 days credit" or "50% advance"' })
  @IsOptional() @IsString() payment_terms?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() delivery_terms?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() warranty_terms?: string;
  @ApiPropertyOptional({ description: 'Tax declaration text (11A-07); the tax invoice computes GST server-side' })
  @IsOptional() @IsString() tax_terms?: string;
  @ApiPropertyOptional({ enum: ['INR'] }) @IsOptional() @IsIn(['INR']) currency_code?: string;
}

export class CreateSalesQuoteDto extends RevisionTermsDto {
  @ApiProperty() @IsUUID() enquiry_id!: string;
}

export class CreateRevisionDto extends RevisionTermsDto {
  @ApiProperty({ description: 'Required for every revision after the first' }) @IsString() @MinLength(1) revision_reason!: string;
}

export class QuoteLineDto {
  @ApiProperty({ description: 'Saleable product from the Item Master (APPROVED/ACTIVE required at issue, 11A-04)' })
  @IsUUID() item_id!: string;
  @ApiPropertyOptional({ description: 'Defaults to the Item Master standard name' }) @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(140) manufacturer?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(140) part_number?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() specification?: string;
  @ApiProperty({ enum: CONDITIONS }) @IsIn(CONDITIONS) product_condition!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() warranty?: string;
  @ApiPropertyOptional({ description: '11A-10: clearly-labelled alternative offer, e.g. "Alt A"' })
  @IsOptional() @IsString() @MaxLength(80) alternative_label?: string;
  @ApiProperty({ example: 4 }) @IsNumber() @Min(0.0001) qty!: number;
  @ApiProperty({ description: 'Final customer unit price, pre-tax, integer paise (typed by Purchase)', example: 125000 })
  @IsInt() @Min(0) unit_price_paise!: number;
  @ApiPropertyOptional({ description: 'Optional list price (paise) to show a discount; >= unit price. No discount band is enforced (11A-05 pending).' })
  @IsOptional() @IsInt() @Min(0) list_unit_price_paise?: number;
}

export class QuoteDispatchDto {
  @ApiProperty({ enum: ['EMAIL', 'WHATSAPP', 'PDF_PRINT', 'OTHER'] }) @IsIn(['EMAIL', 'WHATSAPP', 'PDF_PRINT', 'OTHER']) channel!: string;
  @ApiProperty({ example: 'buyer@customer.example' }) @IsString() @MinLength(1) recipient!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() document_evidence_uri?: string;
}

export class QuoteResponseDto {
  @ApiProperty({ enum: ['ENQUIRY', 'NEGOTIATING', 'ACCEPTED', 'PART_ACCEPTED', 'REJECTED', 'NO_RESPONSE'] })
  @IsIn(['ENQUIRY', 'NEGOTIATING', 'ACCEPTED', 'PART_ACCEPTED', 'REJECTED', 'NO_RESPONSE']) response_kind!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() response_evidence_uri?: string;
}

// ---------------------------------------------------------------- 11B Sales Order

export class OrderLineDto {
  @ApiProperty() @IsUUID() quote_line_id!: string;
  @ApiProperty({ description: '<= quoted qty (11B-03: only accepted lines/quantities)', example: 4 })
  @IsNumber() @Min(0.0001) accepted_qty!: number;
}

export class CreateSalesOrderDto {
  @ApiProperty({ description: 'The ISSUED, current, unexpired quote revision the customer accepted' }) @IsUUID() quote_revision_id!: string;
  @ApiPropertyOptional({ example: 'PO-4471' }) @IsOptional() @IsString() @MaxLength(160) customer_order_reference?: string;
  @ApiProperty({ type: [OrderLineDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => OrderLineDto)
  lines!: OrderLineDto[];
}

export class OrderAuthorisationDto {
  @ApiProperty({ enum: ['CUSTOMER_PO', 'ORDER_CONFIRMATION', 'EMAIL_AUTHORISATION'] })
  @IsIn(['CUSTOMER_PO', 'ORDER_CONFIRMATION', 'EMAIL_AUTHORISATION']) source_kind!: string;
  @ApiPropertyOptional({ description: 'Required for CUSTOMER_PO (the PO number)' }) @IsOptional() @IsString() @MaxLength(160) source_reference?: string;
  @ApiPropertyOptional({ description: 'Required for EMAIL_AUTHORISATION' }) @IsOptional() @IsString() @MaxLength(254) customer_email_sender?: string;
  @ApiProperty({ example: '2026-11-12T10:30:00+05:30' }) @IsISO8601() received_at!: string;
  @ApiProperty() @IsString() @MinLength(1) evidence_uri!: string;
}

export class VerifyOrderDto {
  @ApiProperty({ description: 'The PENDING authorisation evidence Purchase checked against the quote + customer' })
  @IsUUID() authorisation_event_id!: string;
}

export class PaymentTermsDto {
  @ApiProperty({ enum: ['NOT_REQUIRED', 'FIXED_AMOUNT', 'PERCENTAGE', 'FULL'],
    description: '11B-02 (NOT APPROVED as a policy): the terms THIS order was accepted on. No blanket advance.' })
  @IsIn(['NOT_REQUIRED', 'FIXED_AMOUNT', 'PERCENTAGE', 'FULL']) advance_kind!: string;
  @ApiPropertyOptional({ description: 'Advance amount the accepted terms require (integer paise). Required unless NOT_REQUIRED.' })
  @IsOptional() @IsInt() @Min(1) required_amount_paise?: number;
  @ApiPropertyOptional({ description: 'PERCENTAGE only: the % stated in the terms (recorded, not used to compute)' })
  @IsOptional() @IsNumber() @Min(0.0001) @Max(100) required_percent?: number;
  @ApiProperty() @IsString() @MinLength(1) accepted_terms_evidence_uri!: string;
}

export class ConfirmAdvanceDto {
  @ApiProperty({ description: 'BR-08 payment receipt (same customer) that satisfies the advance' }) @IsUUID() br08_receipt_id!: string;
  @ApiProperty() @IsString() @MinLength(1) finance_confirmation_reference!: string;
}

// ---------------------------------------------------------------- 11B reservation

export class ReserveDto {
  @ApiProperty({ example: 4, description: 'Reserved against the real ledger (fdn_reserve). One outward line later ships this whole reservation.' })
  @IsNumber() @Min(0.0001) qty!: number;
}

// ---------------------------------------------------------------- 11C outward / delivery

export class OutwardLineDto {
  @ApiProperty({ description: 'A ledger-CONFIRMED BR-11 reservation (its whole quantity ships on this line)' })
  @IsUUID() reservation_request_id!: string;
}

export class CreateOutwardDto {
  @ApiProperty() @IsUUID() customer_id!: string;
  @ApiProperty({ enum: ['COURIER', 'CUSTOMER_PICKUP', 'OWN_TRANSPORT', 'OTHER'] })
  @IsIn(['COURIER', 'CUSTOMER_PICKUP', 'OWN_TRANSPORT', 'OTHER']) dispatch_mode!: string;
  @ApiPropertyOptional({ description: 'Required for OTHER (controlled Other, 11C-03)' }) @IsOptional() @IsString() dispatch_mode_note?: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(150) recipient_name!: string;
  @ApiProperty() @IsString() @MinLength(1) destination_address!: string;
  @ApiPropertyOptional({ description: 'Required for COURIER' }) @IsOptional() @IsString() @MaxLength(180) carrier_name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(180) tracking_reference?: string;
  @ApiProperty({ type: [OutwardLineDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => OutwardLineDto)
  lines!: OutwardLineDto[];
}

export class PackingEvidenceDto {
  @ApiProperty({ enum: ['PHOTO', 'VIDEO', 'PACKING_LIST', 'SERIAL_LABEL', 'OTHER'] })
  @IsIn(['PHOTO', 'VIDEO', 'PACKING_LIST', 'SERIAL_LABEL', 'OTHER']) evidence_kind!: string;
  @ApiProperty() @IsString() @MinLength(1) file_uri!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(255) file_name!: string;
}

export class PickDto {
  @ApiProperty({ description: 'Item / part / quantity verification performed (11C-02)' }) @IsString() @MinLength(1) verification_note!: string;
  @ApiPropertyOptional({ type: [String], description: 'Required (one per unit) when the item is serial-tracked' })
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @ArrayUnique() @IsString({ each: true }) serial_numbers?: string[];
}

export class DispatchOutwardDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(180) tracking_reference?: string;
}

export class TrackingEventDto {
  @ApiProperty() @IsString() @MinLength(1) status_note!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) provider_event_ref?: string;
  @ApiProperty() @IsISO8601() occurred_at!: string;
}

export class DeliveryEvidenceDto {
  @ApiProperty({ enum: ['DELIVERED', 'FAILED', 'DAMAGED'] }) @IsIn(['DELIVERED', 'FAILED', 'DAMAGED']) delivery_status!: string;
  @ApiPropertyOptional({ description: 'DELIVERED: quantity confirmed by the POD (<= shipped)' })
  @IsOptional() @IsNumber() @Min(0) delivered_qty?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(150) received_by_name?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() delivered_at?: string;
  @ApiPropertyOptional({ description: 'DELIVERED: line-specific POD / customer receipt (11C-04)' }) @IsOptional() @IsString() pod_uri?: string;
  @ApiPropertyOptional({ description: 'Required for FAILED / DAMAGED' }) @IsOptional() @IsString() remarks?: string;
}

// ---------------------------------------------------------------- change requests + closure

export class ChangeRequestDto {
  @ApiPropertyOptional({ description: 'Omit for a whole-order change' }) @IsOptional() @IsUUID() sales_order_line_id?: string;
  @ApiProperty({ enum: ['PRICE', 'QTY', 'CANCELLATION', 'SUBSTITUTION', 'BACKORDER_REMOVAL', 'DELIVERY_DATE', 'OTHER'] })
  @IsIn(['PRICE', 'QTY', 'CANCELLATION', 'SUBSTITUTION', 'BACKORDER_REMOVAL', 'DELIVERY_DATE', 'OTHER']) change_kind!: string;
  @ApiProperty() @IsString() @MinLength(1) reason!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() customer_evidence_uri?: string;
  @ApiPropertyOptional({ description: 'SUBSTITUTION: engineer / technical suitability evidence (11B-09)' })
  @IsOptional() @IsString() technical_approval_evidence_uri?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() financial_impact_description?: string;
}

export class DecideChangeRequestDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] }) @IsIn(['APPROVED', 'REJECTED']) decision!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() decision_note?: string;
}

export class CloseOrderDto {
  @ApiProperty() @IsString() @MinLength(1) closure_reason!: string;
}
