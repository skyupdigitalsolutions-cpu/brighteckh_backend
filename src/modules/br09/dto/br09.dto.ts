import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export const COMPLAINT_TYPES = ['WARRANTY_ENQUIRY', 'REPEAT_FAILURE', 'SERVICE_COMPLAINT', 'DELIVERY_ISSUE'];
export const CHANNELS = ['EMAIL', 'WHATSAPP', 'PHONE', 'CUSTOMER_PORTAL', 'WALK_IN', 'OTHER'];
export const RESOLUTIONS = ['WARRANTY_REPAIR', 'PAID_REPAIR', 'GOODWILL', 'REPLACEMENT', 'REFUND_REVIEW', 'REJECTED', 'INFORMATION_ONLY'];
export const OUTCOMES = ['REPEAT_FAULT', 'DIFFERENT_FAULT', 'USER_DAMAGE', 'NFF', 'NOT_REPAIRABLE', 'EXTERNAL_EVALUATION'];
export const ROLES = ['PURCHASE', 'ENGINEER', 'SALES', 'STORES_QUALITY', 'EXTERNAL_COORD', 'FINANCE', 'MANAGEMENT', 'SYSTEM_ADMIN'];

// No DTO accepts a case number, status, warranty status/dates, invoice id or
// decided-by: the DB derives them (forbidNonWhitelisted rejects them).

export class RegisterCaseDto {
  @ApiProperty() @IsUUID() customer_id!: string;
  @ApiProperty({ enum: COMPLAINT_TYPES }) @IsIn(COMPLAINT_TYPES) complaint_type!: string;
  @ApiProperty({ enum: CHANNELS }) @IsIn(CHANNELS) channel!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(150) contact_name!: string;
  @ApiProperty({ description: 'Phone / email of the complainant' }) @IsString() @MinLength(1) @MaxLength(254) contact_detail!: string;
  @ApiProperty({ minLength: 10 }) @IsString() @MinLength(10) fault_description!: string;
  @ApiPropertyOptional({ enum: ['NORMAL', 'URGENT', 'CRITICAL'] }) @IsOptional() @IsIn(['NORMAL', 'URGENT', 'CRITICAL']) priority?: string;
  @ApiPropertyOptional({ description: 'Original Job ID if known; otherwise leave empty and Purchase matches it later' })
  @IsOptional() @IsUUID() original_job_id?: string;
  @ApiPropertyOptional({ description: "Customer's own reference (DC no., old job no.) when the original job is unknown" })
  @IsOptional() @IsString() customer_reference?: string;
}

export class MatchOriginalJobDto {
  @ApiProperty() @IsUUID() original_job_id!: string;
}

export class StartReviewDto {
  @ApiPropertyOptional({ description: 'Purchase employee to own the case (defaults to the caller)' })
  @IsOptional() @IsUUID() assigned_to_id?: string;
}

export class CommunicationDto {
  @ApiProperty({ enum: ['ACKNOWLEDGEMENT', 'STATUS_UPDATE', 'DECISION', 'RESOLUTION'] })
  @IsIn(['ACKNOWLEDGEMENT', 'STATUS_UPDATE', 'DECISION', 'RESOLUTION']) comm_type!: string;
  @ApiProperty({ enum: CHANNELS }) @IsIn(CHANNELS) channel!: string;
  @ApiProperty() @IsString() @MinLength(1) summary!: string;
}

export class LinkRepeatJobToCaseDto {
  @ApiProperty({ description: 'A job already linked via POST /jobs/:id/repeat-link (BR-02)' }) @IsUUID() repeat_job_id!: string;
}

export class TechnicalAssessmentDto {
  @ApiProperty() @IsUUID() repeat_job_id!: string;
  @ApiProperty({ enum: OUTCOMES }) @IsIn(OUTCOMES) outcome!: string;
  @ApiProperty() @IsString() @MinLength(1) findings!: string;
  @ApiPropertyOptional({ description: 'Free category for RCA analytics (categories not yet fixed by client)' })
  @IsOptional() @IsString() @MaxLength(60) root_cause_category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() root_cause?: string;
}

export class ClaimDecisionDto {
  @ApiProperty({ enum: RESOLUTIONS }) @IsIn(RESOLUTIONS) resolution!: string;
  @ApiProperty() @IsString() @MinLength(1) decision_reason!: string;
}

export class GoodwillApprovalDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] }) @IsIn(['APPROVED', 'REJECTED']) outcome!: string;
  @ApiProperty() @IsString() @MinLength(1) note!: string;
}

export class DeclineCreditNoteDto {
  @ApiProperty() @IsString() @MinLength(1) reason!: string;
}

export class CloseCaseDto {
  @ApiProperty() @IsString() @MinLength(1) closure_reason!: string;
}

export class FeedbackDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5 }) @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() comment?: string;
}

export const CASE_STATUSES = ['REGISTERED', 'UNDER_REVIEW', 'DECIDED', 'CLOSED', 'ON_HOLD', 'CANCELLED'];
// REPLACEMENT_APPROVAL (026): approver of a REPLACEMENT decision's review; unset = REFUND_REPLACEMENT_REVIEW applies.
export const AUTHORITY_KINDS = ['CLAIM_DECISION', 'GOODWILL_APPROVAL', 'REFUND_REPLACEMENT_REVIEW', 'REPLACEMENT_APPROVAL'];

export class ListCasesQueryDto {
  @ApiPropertyOptional({ enum: CASE_STATUSES })
  @IsOptional() @IsIn(CASE_STATUSES) status?: string;
  @ApiPropertyOptional({ description: 'true = unmatched queue (no original job yet)' })
  @IsOptional() @IsIn(['true', 'false']) unmatched?: string;
}

export class AuthorityConfigDto {
  @ApiProperty({ enum: AUTHORITY_KINDS }) @IsIn(AUTHORITY_KINDS) decision_kind!: string;
  @ApiProperty({ enum: ROLES, nullable: true, description: 'null = unassign (decisions blocked again)' })
  @IsOptional() @IsIn(ROLES) approver_role_code?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() note?: string;
}

export class SlaTargetDto {
  @ApiProperty({ enum: ['NORMAL', 'URGENT', 'CRITICAL'] }) @IsIn(['NORMAL', 'URGENT', 'CRITICAL']) priority!: string;
  @ApiProperty({ enum: ['ACKNOWLEDGEMENT', 'INITIAL_ASSESSMENT', 'RESOLUTION'] })
  @IsIn(['ACKNOWLEDGEMENT', 'INITIAL_ASSESSMENT', 'RESOLUTION']) event_code!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(1000) target_amount!: number;
  @ApiProperty({ enum: ['WORKING_HOUR', 'WORKING_DAY'] }) @IsIn(['WORKING_HOUR', 'WORKING_DAY']) target_unit!: string;
}

// ---------------------------------------------------------------- migration 020

export const EVIDENCE_TYPES = ['CUSTOMER_PHOTO', 'CUSTOMER_VIDEO', 'CUSTOMER_EMAIL', 'ORIGINAL_INVOICE', 'DELIVERY_POD', 'TEST_RECORD'];

export class CaseEvidenceDto {
  @ApiProperty({ enum: EVIDENCE_TYPES }) @IsIn(EVIDENCE_TYPES) evidence_type!: string;
  @ApiProperty({ example: 's3://evidence/case-123/photo1.jpg' }) @IsString() @MinLength(1) file_uri!: string;
  @ApiProperty({ example: 'photo1.jpg' }) @IsString() @MinLength(1) @MaxLength(255) file_name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty({ enum: ['CUSTOMER', 'STAFF'] }) @IsIn(['CUSTOMER', 'STAFF']) submitted_by_kind!: string;
  @ApiPropertyOptional({ description: 'When the evidence was received (default now; never in the future)' })
  @IsOptional() @IsISO8601() received_at?: string;
  @ApiPropertyOptional({ description: 'Optional: the claim decision this evidence supports (same case)' })
  @IsOptional() @IsUUID() claim_decision_id?: string;
}

export class RefundReplacementReviewDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] }) @IsIn(['APPROVED', 'REJECTED']) outcome!: string;
  @ApiProperty() @IsString() @MinLength(1) note!: string;
}

export class CaseReasonDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
}
