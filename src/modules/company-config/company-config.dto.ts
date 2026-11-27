import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { CompanyPolicyConfigRow } from '../../common/swagger/rows.generated';

const ROLES = ['PURCHASE', 'ENGINEER', 'SALES', 'STORES_QUALITY', 'EXTERNAL_COORD', 'FINANCE', 'MANAGEMENT', 'SYSTEM_ADMIN'];
const notNull = (_: unknown, v: unknown) => v !== null;

/** Omitted field = unchanged; null = clear. */
export class CompanyPolicyDto {
  @ApiPropertyOptional({ nullable: true, example: 5,
    description: 'ENFORCED (BR-04): a quote revision more than this % below the original authorised price needs a named approver + reason. null = 10% (pre-026 default).' })
  @IsOptional() @ValidateIf(notNull) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  max_discount_percent?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 15, description: 'Stored only (no return workflow yet)' })
  @IsOptional() @ValidateIf(notNull) @IsInt() @Min(1) customer_return_window_days?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 15, description: 'Stored only' })
  @IsOptional() @ValidateIf(notNull) @IsInt() @Min(1) supplier_return_window_min_days?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 20, description: 'Stored only' })
  @IsOptional() @ValidateIf(notNull) @IsInt() @Min(1) supplier_return_window_max_days?: number | null;

  @ApiPropertyOptional({ nullable: true, enum: ['CUSTOMER', 'COMPANY'], description: 'Stored only' })
  @IsOptional() @ValidateIf(notNull) @IsIn(['CUSTOMER', 'COMPANY']) return_freight_payer?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 5, description: 'Stored only (no follow-up reminders yet)' })
  @IsOptional() @ValidateIf(notNull) @IsInt() @Min(1) quote_followup_days?: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'Stored only. RMA turnaround target in working days; unset until the client fixes one.' })
  @IsOptional() @ValidateIf(notNull) @IsInt() @Min(1) rma_turnaround_target_working_days?: number | null;

  @ApiPropertyOptional({ nullable: true, enum: ROLES, description: 'Stored only: customer return (RMA) authoriser' })
  @IsOptional() @ValidateIf(notNull) @IsIn(ROLES) customer_return_authority_role?: string | null;

  @ApiPropertyOptional({ nullable: true, enum: ROLES, description: 'Stored only: supplier refund / AP authoriser (no AP module)' })
  @IsOptional() @ValidateIf(notNull) @IsIn(ROLES) supplier_refund_authority_role?: string | null;

  @ApiPropertyOptional({ nullable: true, enum: ROLES, description: 'Stored only: management KPI sign-off (no KPI validation workflow)' })
  @IsOptional() @ValidateIf(notNull) @IsIn(ROLES) kpi_signoff_authority_role?: string | null;

  @ApiPropertyOptional({ nullable: true, enum: ROLES, description: 'Stored only: supplier return authoriser (027; no supplier-return workflow)' })
  @IsOptional() @ValidateIf(notNull) @IsIn(ROLES) supplier_return_authority_role?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export const POLICY_FIELDS = [
  'max_discount_percent', 'customer_return_window_days', 'supplier_return_window_min_days',
  'supplier_return_window_max_days', 'return_freight_payer', 'quote_followup_days',
  'rma_turnaround_target_working_days', 'customer_return_authority_role', 'supplier_refund_authority_role',
  'kpi_signoff_authority_role', 'supplier_return_authority_role',
] as const;

export class CompanyConfigResponse {
  @ApiProperty({ type: CompanyPolicyConfigRow, nullable: true }) policy!: CompanyPolicyConfigRow | null;
  @ApiProperty({ example: '5', description: 'The BR-04 discount threshold in force (config, else 10)' })
  effective_max_discount_percent!: string;
  @ApiProperty({ type: [String], description: 'Fields a server rule reads' }) enforced!: string[];
  @ApiProperty({ type: [String], description: 'Fields recorded for reference only: no workflow consumes them yet' })
  stored_only!: string[];
}
