import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID,
  Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';

// NOTE: no DTO accepts a document number, tax type/regime, tax amount, invoice
// date, due date or price. The DB computes all of them; forbidNonWhitelisted
// rejects any attempt to send them.

export class CreateDispatchBatchDto {
  @ApiProperty() @IsUUID() customer_id!: string;
  @ApiProperty({ example: 'Blue Dart' }) @IsString() @MinLength(1) @MaxLength(120) carrier_name!: string;
  @ApiPropertyOptional({ description: 'AWB / LR / vehicle number (can also be given at dispatch)' })
  @IsOptional() @IsString() @MaxLength(120) carrier_reference?: string;
  @ApiProperty() @IsString() @MinLength(1) destination_address!: string;
  @ApiProperty({ type: [String], description: 'Jobs with a BR-07 dispatch release, all of this customer' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ArrayUnique() @IsUUID('all', { each: true }) job_ids!: string[];
}

export class DispatchBatchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) carrier_reference?: string;
}

export class ProofOfDeliveryDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(150) received_by_name!: string;
  @ApiProperty({ example: '2026-11-07T15:20:00+05:30' }) @IsISO8601() received_at!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() pod_document_uri?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() remarks?: string;
}

export class InvoiceRequestDto {
  @ApiProperty({ type: [String], description: 'Dispatched jobs of ONE customer; each job on at most one live invoice' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ArrayUnique() @IsUUID('all', { each: true }) job_ids!: string[];
  @ApiPropertyOptional({ description: "Payment terms for THIS invoice (days). Defaults to the customer's credit_days." })
  @IsOptional() @IsInt() @Min(0) @Max(3650) credit_days?: number;
}

export class AllocationLineDto {
  @ApiProperty() @IsUUID() invoice_id!: string;
  @ApiProperty({ description: 'Integer paise', example: 50000 }) @IsInt() @Min(1) amount_paise!: number;
}

export class RecordPaymentDto {
  @ApiProperty() @IsUUID() customer_id!: string;
  @ApiProperty({ description: 'Integer paise received', example: 106200 }) @IsInt() @Min(1) amount_paise!: number;
  @ApiProperty({ example: '2026-11-05' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) received_on!: string;
  @ApiProperty({ example: 'NEFT' }) @IsString() @MinLength(1) @MaxLength(30) payment_mode!: string;
  @ApiPropertyOptional({ example: 'UTR123456' }) @IsOptional() @IsString() @MaxLength(120) payment_reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() remarks?: string;
  @ApiPropertyOptional({ type: [AllocationLineDto], description: 'Allocate now (optional; can allocate later)' })
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => AllocationLineDto)
  allocations?: AllocationLineDto[];
}

export class AllocatePaymentDto extends AllocationLineDto {}

export class CreditNoteDto {
  @ApiProperty({ enum: ['WARRANTY_FAILURE', 'INVOICE_CORRECTION'] })
  @IsIn(['WARRANTY_FAILURE', 'INVOICE_CORRECTION']) reason_code!: string;
  @ApiProperty() @IsString() @MinLength(1) reason!: string;
  @ApiPropertyOptional({ description: 'WARRANTY_FAILURE: the job on this invoice that failed (3 months from its POD date)' })
  @IsOptional() @IsUUID() failed_job_id?: string;
  @ApiPropertyOptional({ description: 'BR-09 hook: the NEW warranty-return Job (BR-02 repeat link to the failed job)' })
  @IsOptional() @IsUUID() warranty_return_job_id?: string;
}

export class WaiverDto {
  @ApiProperty() @IsString() @MinLength(1) reason!: string;
}

export class ListInvoicesQueryDto {
  @ApiPropertyOptional({ enum: ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'] })
  @IsOptional() @IsIn(['ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customer_id?: string;
}

/** Company invoicing profile. Prefix/state/GSTIN freeze once documents exist (DB trigger). */
export class EntityProfileDto {
  @ApiPropertyOptional({ example: 'BIAPL' }) @IsOptional() @Matches(/^[A-Z0-9]{1,12}$/) doc_prefix?: string;
  @ApiPropertyOptional({ example: '29' }) @IsOptional() @Matches(/^[0-9]{2}$/) state_code?: string;
  @ApiPropertyOptional({ example: '29ABCDE1234F1Z5' })
  @IsOptional() @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/) gstin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) registered_address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(150) bank_account_name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) bank_name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) bank_account_no?: string;
  @ApiPropertyOptional({ example: 'HDFC0001234' }) @IsOptional() @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/) bank_ifsc?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) bank_branch?: string;
}

// ---------------------------------------------------------------- PRODUCT_SALES (BR-11 Sales Order source)
export class SalesInvoiceLineDto {
  @ApiProperty() @IsUUID() sales_order_line_id!: string;
  @ApiProperty({ description: 'Quantity to bill on this invoice (<= invoiceable under the configured trigger)', example: 2 })
  @Type(() => Number) @Min(0.0001) quantity!: number;
}

export class SalesInvoiceRequestDto {
  @ApiProperty() @IsUUID() sales_order_id!: string;
  @ApiPropertyOptional({ type: [SalesInvoiceLineDto], description: 'Omit = every line\'s remaining invoiceable quantity. Prices/tax are never accepted.' })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SalesInvoiceLineDto)
  lines?: SalesInvoiceLineDto[];
  @ApiPropertyOptional({ description: "Payment terms for THIS invoice (days). Defaults to the customer's credit_days." })
  @IsOptional() @IsInt() @Min(0) @Max(3650) credit_days?: number;
}

/** GET /payments: receipt list (Finance advance picker, receipts register). Purchase-desk paging conventions. */
export class ListReceiptsQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only this customer (the advance picker passes the customer of the order)' })
  @IsOptional() @IsUUID() customer_id?: string;
  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 25 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size?: number;
  @ApiPropertyOptional({ maxLength: 100, description: 'payment_reference, customer name / code, payment mode' })
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}
