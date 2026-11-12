import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export const REPORT_CODES = [
  'SERVICE_PIPELINE', 'QUALITY_WARRANTY', 'SLA_MONITOR', 'PROCUREMENT_SUMMARY', 'INVENTORY_POSITION',
  'RECEIVABLES_AGING', 'RECEIVABLE_STATUS', 'JOB_PROFITABILITY', 'ENGINEER_PERFORMANCE', 'ACCESS_AUDIT',
] as const;
/** Grantable codes: every runnable report + the PII_CUSTOMER entitlement (migration 021, not runnable). */
export const GRANTABLE_CODES = [...REPORT_CODES, 'PII_CUSTOMER'];
export const R_CODES = [
  'R_PURCHASE_EXEC', 'R_SALES_EXEC', 'R_SERVICE_ENG', 'R_MGMT_COMPANY', 'R_MGMT_GROUP',
  'R_FINANCE_EXEC', 'R_AUDITOR', 'R_TECH_ADMIN',
];
const ROLES = ['PURCHASE', 'ENGINEER', 'SALES', 'STORES_QUALITY', 'EXTERNAL_COORD', 'FINANCE', 'MANAGEMENT', 'SYSTEM_ADMIN'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Report filters. Default period = last 30 days (10A-06). */
export class ReportQueryDto {
  @ApiPropertyOptional({ example: '2026-10-06', description: 'Period start (inclusive, company-local date)' })
  @IsOptional() @Matches(DATE) from?: string;
  @ApiPropertyOptional({ example: '2026-11-05', description: 'Period end (inclusive)' })
  @IsOptional() @Matches(DATE) to?: string;
  @ApiPropertyOptional({
    description: 'Comma-separated company ids. Default = your company. Another company needs an ACTIVE '
      + 'cross-company grant (R_MGMT_GROUP); any ungranted company in the list -> 403.',
  })
  @IsOptional() @Matches(/^[0-9a-f-]{36}(,[0-9a-f-]{36})*$/i) companies?: string;
}

export class ExportQueryDto extends ReportQueryDto {
  @ApiProperty({ enum: ['csv', 'xlsx', 'pdf'] }) @IsIn(['csv', 'xlsx', 'pdf']) format!: string;
}

export class CreateBindingDto {
  @ApiProperty() @IsUUID() employee_id!: string;
  @ApiProperty({ enum: R_CODES }) @IsIn(R_CODES) role_code!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() note?: string;
}

export class CreateGrantDto {
  @ApiProperty() @IsUUID() employee_id!: string;
  @ApiProperty({ enum: GRANTABLE_CODES, description: 'PII_CUSTOMER = entitlement to see customer name/GSTIN unmasked (VIEW on screen, EXPORT in exports)' })
  @IsIn(GRANTABLE_CODES) report_code!: string;
  @ApiProperty({ enum: ['VIEW', 'EXPORT'], description: 'VIEW and EXPORT are separate grants' }) @IsIn(['VIEW', 'EXPORT']) action!: string;
  @ApiPropertyOptional({ description: 'Data-owner company (default: the employee\'s own). Different = cross-company grant.' })
  @IsOptional() @IsUUID() target_company_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() note?: string;
}

export class ApproveGrantDto {
  @ApiProperty({ enum: ['STANDARD', 'FINANCIAL', 'CROSS_COMPANY'] })
  @IsIn(['STANDARD', 'FINANCIAL', 'CROSS_COMPANY']) approval_kind!: string;
}

export class CreateSalesAssignmentDto {
  @ApiProperty() @IsUUID() employee_id!: string;
  @ApiProperty() @IsUUID() customer_id!: string;
}

export class AuthorityDto {
  @ApiProperty({ enum: ['FINANCIAL_GRANT', 'CROSS_COMPANY_GRANT'] }) @IsIn(['FINANCIAL_GRANT', 'CROSS_COMPANY_GRANT']) authority_kind!: string;
  @ApiProperty({ enum: ROLES, nullable: true, description: 'null = unassign (restricted grants blocked again)' })
  @IsOptional() @IsIn(ROLES) approver_role_code?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() note?: string;
}
