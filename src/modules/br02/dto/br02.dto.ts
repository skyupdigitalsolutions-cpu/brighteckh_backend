import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateInwardReceiptDto {
  @IsUUID() customer_id!: string;
  @IsString() receipt_at!: string; // ISO timestamp
  @IsIn(['WALK_IN', 'COURIER']) receipt_channel!: string;
  @IsOptional() @IsString() customer_dc_number?: string;
  @IsOptional() @IsString() dc_date?: string;
  @IsOptional() @IsIn(['NONE', 'PENDING', 'RESOLVED', 'REJECTED']) dc_exception_status?: string;
  @IsOptional() @IsString() dc_exception_reason?: string;
  @IsOptional() @IsString() courier_name?: string;
  @IsOptional() @IsString() courier_awb?: string;
  @IsOptional() @IsInt() @Min(0) declared_quantity?: number;
  @IsOptional() @IsIn(['NORMAL', 'URGENT', 'CRITICAL']) priority?: string;
  @IsOptional() @IsString() priority_reason?: string;
  @IsOptional() @IsString() fiscal_year?: string;
  @IsOptional() @IsString() notes?: string;
}

export class CreateEquipmentGroupDto {
  @IsUUID() assembly_id!: string;
  @IsInt() @Min(1) quantity_received!: number;
  @IsOptional() @IsString() customer_dc_line?: string;
}

export class ExpandEquipmentGroupDto {
  @IsUUID() location_id!: string;
  @IsUUID() custodian_id!: string;
}

export class AddUnitPhotoDto {
  @IsString() file_uri!: string;
  @IsString() file_name!: string;
  @IsOptional() @IsString() photo_category?: string;
  @IsOptional() @IsString() mime_type?: string;
  @IsOptional() @IsInt() @Min(0) file_size_bytes?: number;
}

export class AssignEngineerDto {
  @IsUUID() engineer_id!: string;
  @IsOptional() @IsString() reassignment_reason?: string;
}

/** Warranty return: link a NEW job (from a new JIN) to the job it repeats. R-number + chain resolved by the DB. */
export class LinkRepeatJobDto {
  @IsUUID() repeat_of_job_id!: string;
  @IsString() return_reason!: string;
}

export const JOB_STATUSES = ['JOB_CREATED', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED', 'INSPECTION', 'ON_HOLD', 'CANCELLED', 'CLOSED'];

/** GET /my-jobs (G1) */
export class MyJobsQueryDto {
  @ApiPropertyOptional({ enum: JOB_STATUSES, description: 'Only jobs in this service_jobs.status (default: all)' })
  @IsOptional() @IsIn(JOB_STATUSES) status?: string;
}
