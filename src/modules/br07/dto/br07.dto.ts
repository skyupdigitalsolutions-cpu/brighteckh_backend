import { IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, MinLength } from 'class-validator';

// Material issue: the caller names WHICH committed BR-05 reservation to issue.
// Quantity, item, engineer and locations are all derived server-side (the
// issue converts the whole reservation; engineer = current accepted engineer).
export class IssueMaterialDto {
  @IsUUID() br05_material_reservation_id!: string;
}

export class AcknowledgeIssueDto {
  @IsOptional() @IsString() note?: string;
}

export class ConsumeMaterialDto {
  @IsNumber() @IsPositive() quantity!: number;
  @IsOptional() @IsUUID() repair_session_id?: string;
  @IsOptional() @IsString() note?: string;
}

export class RequestReturnDto {
  @IsNumber() @IsPositive() quantity!: number;
  @IsOptional() @IsString() return_reason?: string;
}

export class VerifyReturnDto {
  @IsIn(['VERIFY', 'REJECT']) decision!: string;
  @IsOptional() @IsString() note?: string;
}

export class PauseRepairSessionDto {
  @IsString() @MinLength(1) pause_reason!: string;
  @IsOptional() @IsString() pause_category?: string;
}

export class SubmitRepairReportDto {
  @IsString() @MinLength(1) work_performed!: string;
  @IsOptional() @IsString() root_cause?: string;
  @IsOptional() @IsString() parts_replaced_summary?: string;
}

export class StartTestRunDto {
  @IsString() @MinLength(1) test_procedure!: string;
}

export class RecordTestResultDto {
  @IsIn(['PASS', 'FAIL']) result!: string;
  @IsOptional() @IsString() observations?: string;
}

export class FailureReviewDto {
  @IsIn(['CONTINUE', 'STOP']) decision!: string;
  @IsString() @MinLength(1) comment!: string;
}

export class TechnicalHandoffDto {
  @IsOptional() @IsString() note?: string;
}

export class DispatchReleaseDto {
  @IsOptional() @IsString() note?: string;
}
