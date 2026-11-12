import { IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Min } from 'class-validator';

export class QuoteResponseDto {
  @IsUUID() br04_quote_revision_id!: string;
  @IsIn(['AWAITING_RESPONSE', 'ACCEPTED', 'COUNTER_OFFER', 'TECHNICAL_QUERY', 'PARTIAL_ACCEPTANCE', 'ON_HOLD', 'REJECTED', 'EXPIRED'])
  response_type!: string;
  @IsOptional() @IsIn(['EMAIL', 'WHATSAPP', 'CALL', 'IN_PERSON', 'OTHER']) response_channel?: string;
  @IsOptional() @IsString() customer_contact?: string;
  @IsOptional() @IsString() response_notes?: string;
  @IsOptional() @IsString() evidence_uri?: string;
}

// All three authority types are first-class; the required-evidence shape just
// differs per type (a PO/Job Order needs a reference, email needs sender+timestamp).
export class CustomerAuthorityDto {
  @IsIn(['CUSTOMER_PO', 'JOB_ORDER', 'EMAIL_AUTHORISATION']) authority_type!: string;
  @IsOptional() @IsString() customer_order_ref?: string;
  @IsOptional() @IsString() customer_email_sender?: string;
  @IsOptional() @IsString() customer_email_received_at?: string;
  @IsOptional() @IsNumber() @Min(0) pre_tax_total?: number;
  @IsOptional() @IsNumber() @Min(0) tax_total?: number;
  @IsOptional() @IsString() payment_terms_snapshot?: string;
}

export class VerifyCustomerAuthorityDto {
  @IsOptional() @IsString() verification_notes?: string;
}

export class CreateOrderAllocationDto {
  @IsUUID() order_id!: string;
  @IsUUID() quote_revision_ref_id!: string;
  @IsNumber() @Min(0) allocated_pre_tax!: number;
}

export class AuthoriseJobDto {
  @IsUUID() order_job_allocation_id!: string;
}

export class StockRecheckDto {
  @IsUUID() material_request_id!: string;
}

export class ReleaseJobDto {
  @IsOptional() @IsString() release_notes?: string;
}

export class ReserveMaterialDto {
  @IsUUID() stock_recheck_line_id!: string;
  @IsNumber() @IsPositive() reserved_quantity!: number;
}
