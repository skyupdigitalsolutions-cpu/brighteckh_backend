import {
  IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class StockCheckDto {
  @IsUUID() material_request_id!: string;
  @IsOptional() @IsIn(['MR_RECEIVED', 'ESTIMATE_PREPARATION', 'CUSTOMER_ORDER_RECHECK', 'ISSUE_RECHECK'])
  check_context?: string;
  @IsOptional() @IsString() notes?: string;
}

class RfqLineDto {
  @IsUUID() shortage_source_id!: string;
  @IsString() technical_specification!: string;
  @IsOptional() @IsString() manufacturer_preference?: string;
  @IsOptional() @IsString() preference_reason?: string;
  @IsOptional() @IsString() desired_delivery_by?: string;
}

export class CreateRfqDto {
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => RfqLineDto) lines!: RfqLineDto[];
}

export class SupplierInviteDto {
  @IsString() supplier_name_snapshot!: string;
  @IsOptional() @IsString() supplier_contact_snapshot?: string;
}

class OfferLineDto {
  @IsUUID() rfq_line_id!: string;
  @IsOptional() @IsString() offered_make?: string;
  @IsOptional() @IsString() offered_part_number?: string;
  @IsOptional() @IsIn(['NEW', 'REFURBISHED', 'OTHER']) product_condition?: string;
  @IsNumber() @IsPositive() offered_quantity!: number;
  @IsNumber() @Min(0) quoted_unit_price!: number;
  @IsOptional() @IsNumber() @Min(0) quoted_discount?: number;
  @IsOptional() @IsNumber() @Min(0) freight_packing_nonrecoverable?: number;
  @IsOptional() @IsNumber() @Min(0) nonrecoverable_tax?: number;
  @IsOptional() @IsNumber() @Min(0) recoverable_tax?: number;
  @IsOptional() @IsNumber() @Min(0) delivery_days?: number;
  @IsOptional() @IsNumber() @IsPositive() comparable_quantity?: number;
}

export class RecordOfferDto {
  @IsUUID() supplier_invite_id!: string;
  @IsOptional() @IsString() supplier_quote_number?: string;
  @IsOptional() @IsString() currency_code?: string;
  @IsOptional() @IsString() payment_terms?: string;
  @IsOptional() @IsString() validity_until?: string;
  @IsOptional() @IsString() quote_date?: string;
  @IsOptional() @IsString() attachment_uri?: string;
  @IsOptional() @IsString() delivery_terms?: string;
  @IsOptional() @IsString() warranty_terms?: string;
  @IsOptional() @IsString() comments?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OfferLineDto) lines!: OfferLineDto[];
}

export class MarkOfferValidityDto {
  @IsBoolean() valid!: boolean;
  @IsOptional() @IsString() reason?: string;
}

export class RepairQuoteLineDto {
  @IsIn(['REPAIR_SERVICE', 'MATERIAL', 'LABOUR', 'INSPECTION', 'TESTING', 'EXTERNAL', 'FREIGHT', 'OTHER'])
  line_type!: string;
  @IsString() line_description!: string;
  @IsNumber() @IsPositive() quantity!: number;
  @IsString() uom!: string;
  @IsNumber() @Min(0) net_unit_price_pre_tax!: number;
  @IsOptional() @IsBoolean() scope_technically_indivisible?: boolean;
  @IsOptional() @IsBoolean() customer_selectable?: boolean;
}

export class CreateQuoteDto {
  @IsIn(['ITEM', 'ASSEMBLED']) quote_type!: string;
  @IsOptional() @IsUUID() reference_offer_line_id?: string;
  @IsOptional() @IsUUID() procurement_offer_line_id?: string;
  @IsOptional() @IsNumber() @Min(0) tax_total?: number;
  @IsOptional() @IsNumber() @Min(0) freight_charge?: number;
  @IsOptional() @IsString() currency_code?: string;
  @IsOptional() @IsString() valid_until?: string;
  @IsOptional() @IsString() terms_snapshot?: string;
  @IsOptional() @IsNumber() @Min(0) inspection_fee_pre_tax?: number;
  @IsOptional() @IsString() inspection_fee_agreement_ref?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => RepairQuoteLineDto) lines!: RepairQuoteLineDto[];
}

export class ReviseQuoteDto {
  @IsString() revision_reason!: string;
  @IsOptional() @IsUUID() reference_offer_line_id?: string;
  @IsOptional() @IsUUID() procurement_offer_line_id?: string;
  @IsOptional() @IsNumber() @Min(0) tax_total?: number;
  @IsOptional() @IsNumber() @Min(0) freight_charge?: number;
  @IsOptional() @IsString() valid_until?: string;
  @IsOptional() @IsString() terms_snapshot?: string;
  @IsOptional() @IsNumber() @Min(0) inspection_fee_pre_tax?: number;
  @IsOptional() @IsString() inspection_fee_agreement_ref?: string;
  // Both must be supplied explicitly by the caller to approve a revision more
  // than 10% below the originally authorised price (see br04_customer_quote_revisions_check4
  // in migration 001 -- UNCONFIRMED against CLAUDE.md section 6, see note there).
  // The API never fills these in on the caller's behalf.
  @IsOptional() @IsUUID() higher_discount_approved_by_id?: string;
  @IsOptional() @IsString() higher_discount_reason?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => RepairQuoteLineDto) lines!: RepairQuoteLineDto[];
}

export class ReleaseToSalesDto {
  @IsUUID() assigned_sales_id!: string;
}
