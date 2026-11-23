import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto, PRIORITIES } from './purchase-desk.dto';
import { PageMeta } from './purchase-desk.responses';
import { apply, csvArray } from './stores-desk.dto';

/**
 * Purchase material-request inbox (CLAUDE.md §4i "Purchase MR inbox"). Read-only. No BR-04 offer / estimate / price or
 * supplier field is ever selected, and no lines are returned (the detail comes from GET /jobs/:id/material-requests).
 */

/** br03_material_requests.status CHECK values (migration 001). */
export const MR_STATUSES = ['DRAFT', 'SUBMITTED', 'PROCESSING', 'RETURNED', 'CHANGE_REQUESTED', 'WITHDRAWN', 'CLOSED'] as const;
export type MrStatus = (typeof MR_STATUSES)[number];

export class PurchaseMrListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    type: String, example: 'SUBMITTED,CHANGE_REQUESTED',
    description: `br03_material_requests.status (comma-separated; one or more of ${MR_STATUSES.join(', ')}). Omitted = all.`,
  })
  @apply(csvArray(MR_STATUSES))
  status?: string[];

  @ApiPropertyOptional({
    type: String, example: 'CRITICAL,URGENT',
    description: `br03_material_requests.priority (comma-separated; one or more of ${PRIORITIES.join(', ')}). Omitted = all.`,
  })
  @apply(csvArray(PRIORITIES))
  priority?: string[];

  @ApiPropertyOptional({ format: 'uuid', description: 'Only requests of this job (service_jobs.id)' })
  @IsOptional() @IsUUID() job_id?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only requests whose responsible_engineer_id is this employee' })
  @IsOptional() @IsUUID() engineer_id?: string;
}

// ---------------------------------------------------------------- response

const nullableStr = (description?: string, format?: string) =>
  ApiProperty({ type: 'string', nullable: true, description, ...(format ? { format } : {}) });
const int = (description?: string) => ApiProperty({ type: 'integer', description });

export class PurchaseMrRow {
  @ApiProperty({ format: 'uuid', description: 'br03_material_requests.id' }) id!: string;
  @ApiProperty({ description: 'MR-<CODE>-000001' }) request_number!: string;
  @ApiProperty({ enum: MR_STATUSES }) status!: MrStatus;
  @ApiProperty({ enum: PRIORITIES }) priority!: string;
  @nullableStr('YYYY-MM-DD', 'date') required_by_date!: string | null;
  @nullableStr() required_by_reason!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) created_at!: string;
  @nullableStr(undefined, 'date-time') submitted_at!: string | null;
  @nullableStr('Submit + 1 working hour (working calendar)', 'date-time') self_edit_deadline_at!: string | null;
  @nullableStr(undefined, 'date-time') purchase_processing_started_at!: string | null;
  @nullableStr('employees.full_name of purchase_started_by_id') purchase_started_by_name!: string | null;
  @nullableStr(undefined, 'date-time') closed_at!: string | null;
  @ApiProperty({ description: 'br03_can_engineer_edit(id) at read time: DRAFT, or SUBMITTED before Purchase starts and before the deadline' })
  engineer_can_edit!: boolean;
  @ApiProperty({ format: 'uuid' }) job_id!: string;
  @ApiProperty({ description: 'service_jobs.job_number' }) job_number!: string;
  @ApiProperty({ description: 'customers.customer_name via the job\'s inward receipt' }) customer_name!: string;
  @ApiProperty({ format: 'uuid' }) responsible_engineer_id!: string;
  @ApiProperty({ description: 'employees.full_name' }) responsible_engineer_name!: string;
  @int('br03_material_request_lines rows') lines_count!: number;
  @int('br03_material_change_requests with review_status PENDING') pending_change_requests!: number;
  @nullableStr(
    'Newest change request\'s creation time. br03_material_change_requests has no timestamp column, so this is the '
    + 'changed_at of its BR03_CHANGE_REQUEST_CREATED activity_audit_log row. Null when the request has none.',
    'date-time',
  )
  latest_change_request_at!: string | null;
}

export class PurchaseMrStatusCounts {
  @ApiProperty({ type: 'integer' }) DRAFT!: number;
  @ApiProperty({ type: 'integer' }) SUBMITTED!: number;
  @ApiProperty({ type: 'integer' }) PROCESSING!: number;
  @ApiProperty({ type: 'integer' }) RETURNED!: number;
  @ApiProperty({ type: 'integer' }) CHANGE_REQUESTED!: number;
  @ApiProperty({ type: 'integer' }) WITHDRAWN!: number;
  @ApiProperty({ type: 'integer' }) CLOSED!: number;
}

export class PurchaseMrPage extends PageMeta {
  @ApiProperty({
    type: [PurchaseMrRow],
    description: 'CHANGE_REQUESTED first, then SUBMITTED, then every other status; within each group priority CRITICAL -> '
      + 'URGENT -> NORMAL, then submitted_at (else created_at) newest first; request_number desc breaks ties.',
  })
  rows!: PurchaseMrRow[];
  @ApiProperty({
    type: PurchaseMrStatusCounts,
    description: 'Per-status totals (all 7, zeros included) over the company + `search` only: ignores `status`, `priority`, '
      + '`job_id` and `engineer_id`.',
  })
  counts_by_status!: PurchaseMrStatusCounts;
}
