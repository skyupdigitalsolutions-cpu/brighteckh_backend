import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { JOB_STATUSES } from '../../br02/dto/br02.dto';

// DB enum values (CHECK constraints in migration 001). Filters accept only these.
export const RECEIPT_STATUSES = ['REGISTERED', 'VERIFYING', 'VERIFIED', 'ON_HOLD', 'REJECTED', 'CLOSED'];
export const PRIORITIES = ['NORMAL', 'URGENT', 'CRITICAL'];
export const RFQ_STATUSES = ['DRAFT', 'SENT', 'OFFERS_RECEIVED', 'COMPARED', 'CANCELLED', 'EXPIRED'];
export const QUOTE_STATUSES = ['DRAFT', 'RELEASED_TO_SALES', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'];
export const CUSTOMER_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'INACTIVE', 'REJECTED'];
export const ASSEMBLY_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'INACTIVE', 'REJECTED'];
export const ROLE_CODES = ['PURCHASE', 'ENGINEER', 'SALES', 'STORES_QUALITY', 'EXTERNAL_COORD', 'FINANCE', 'MANAGEMENT', 'SYSTEM_ADMIN'];

/** "A,B" or repeated ?x=A&x=B -> ['A','B'] (trimmed, empties dropped). */
const csv = () =>
  Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
    return parts.map((s) => s.trim()).filter(Boolean);
  });

const csvDoc = (values: string[], what: string) =>
  ApiPropertyOptional({
    type: String,
    description: `${what}. One or more of: ${values.join(', ')} (comma-separated). Omitted = all.`,
    example: values.slice(0, 2).join(','),
  });

/** Shared pagination + free-text search. Every list returns { rows, total, page, page_size }. */
export class PageQueryDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 25 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size?: number;

  @ApiPropertyOptional({ maxLength: 100, description: 'Case-insensitive substring match (see each endpoint for the fields searched)' })
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}

/** Lookups can also resolve known ids to names (e.g. ids already on a record). */
export class LookupQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, description: 'Only these ids (comma-separated UUIDs, max 100). Combine with search/status as an AND.' })
  @IsOptional() @csv() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) ids?: string[];
}

// ---------------------------------------------------------------- lists

export class ReceiptListQueryDto extends PageQueryDto {
  @csvDoc(RECEIPT_STATUSES, 'inward_receipts.receipt_status')
  @IsOptional() @csv() @IsArray() @ArrayMaxSize(10) @IsIn(RECEIPT_STATUSES, { each: true }) status?: string[];

  @csvDoc(PRIORITIES, 'inward_receipts.priority')
  @IsOptional() @csv() @IsArray() @ArrayMaxSize(3) @IsIn(PRIORITIES, { each: true }) priority?: string[];

  @ApiPropertyOptional({ example: '2026-11', description: 'Calendar month of receipt_at (YYYY-MM) in the company timezone' })
  @IsOptional() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' }) month?: string;
}

export class JobListQueryDto extends PageQueryDto {
  @csvDoc(JOB_STATUSES, 'service_jobs.status')
  @IsOptional() @csv() @IsArray() @ArrayMaxSize(10) @IsIn(JOB_STATUSES, { each: true }) status?: string[];

  @csvDoc(PRIORITIES, 'service_jobs.priority')
  @IsOptional() @csv() @IsArray() @ArrayMaxSize(3) @IsIn(PRIORITIES, { each: true }) priority?: string[];

  @ApiPropertyOptional({ description: 'Current engineer (employees.id), or the literal `unassigned` for jobs with no current assignment' })
  @IsOptional()
  @Matches(/^(unassigned|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, {
    message: 'engineer_id must be a UUID or "unassigned"',
  })
  engineer_id?: string;
}

export class RfqListQueryDto extends PageQueryDto {
  @csvDoc(RFQ_STATUSES, 'br04_rfqs.rfq_status')
  @IsOptional() @csv() @IsArray() @ArrayMaxSize(10) @IsIn(RFQ_STATUSES, { each: true }) status?: string[];

  @ApiPropertyOptional({ format: 'uuid', description: 'Only RFQs raised from this job' })
  @IsOptional() @IsUUID() job_id?: string;
}

export class QuoteListQueryDto extends PageQueryDto {
  @csvDoc(QUOTE_STATUSES, "Latest revision's br04_customer_quote_revisions.quote_status")
  @IsOptional() @csv() @IsArray() @ArrayMaxSize(10) @IsIn(QUOTE_STATUSES, { each: true }) status?: string[];

  @ApiPropertyOptional({ format: 'uuid', description: 'Only quotes of this job' })
  @IsOptional() @IsUUID() job_id?: string;
}

// ---------------------------------------------------------------- lookups

export class CustomerLookupQueryDto extends LookupQueryDto {
  @ApiPropertyOptional({
    type: String,
    description: `customers.status (comma-separated; one or more of ${CUSTOMER_STATUSES.join(', ')}). ` +
      'Default PENDING_APPROVAL,APPROVED = the statuses a JIN accepts (br02_receipt_master_guard).',
    example: 'PENDING_APPROVAL,APPROVED',
  })
  @IsOptional() @csv() @IsArray() @ArrayMaxSize(4) @IsIn(CUSTOMER_STATUSES, { each: true }) status?: string[];
}

export class AssemblyLookupQueryDto extends LookupQueryDto {
  @ApiPropertyOptional({
    type: String,
    description: `assemblies.status (comma-separated; one or more of ${ASSEMBLY_STATUSES.join(', ')}). ` +
      'Default PENDING_APPROVAL,APPROVED = the statuses an equipment group accepts (br02_group_assembly_guard).',
    example: 'PENDING_APPROVAL,APPROVED',
  })
  @IsOptional() @csv() @IsArray() @ArrayMaxSize(4) @IsIn(ASSEMBLY_STATUSES, { each: true }) status?: string[];
}

export class EmployeeLookupQueryDto extends LookupQueryDto {
  @csvDoc(ROLE_CODES, 'employees.role_code')
  @IsOptional() @csv() @IsArray() @ArrayMaxSize(8) @IsIn(ROLE_CODES, { each: true }) role?: string[];
}

// ---------------------------------------------------------------- B-1 unit-detail edit

const text = (max: number, what: string) =>
  ApiPropertyOptional({ type: String, nullable: true, maxLength: max, description: `${what}. null or "" clears it.` });

/** PATCH /equipment-units/:id -- only the unit's descriptive fields. Omitted keys are left unchanged. */
export class UpdateEquipmentUnitDto {
  @text(150, 'Serial number') @IsOptional() @IsString() @MaxLength(150) serial_number?: string | null;
  @text(150, 'Make as observed at inward') @IsOptional() @IsString() @MaxLength(150) observed_make?: string | null;
  @text(150, 'Model as observed at inward') @IsOptional() @IsString() @MaxLength(150) observed_model?: string | null;
  @text(4000, 'Fault reported by the customer') @IsOptional() @IsString() @MaxLength(4000) reported_fault?: string | null;
  @text(4000, 'Physical condition at inward') @IsOptional() @IsString() @MaxLength(4000) physical_condition?: string | null;
  @text(4000, 'Accessories received with the unit') @IsOptional() @IsString() @MaxLength(4000) accessories?: string | null;
}

export const UNIT_EDITABLE_FIELDS = [
  'serial_number', 'observed_make', 'observed_model', 'reported_fault', 'physical_condition', 'accessories',
] as const;
