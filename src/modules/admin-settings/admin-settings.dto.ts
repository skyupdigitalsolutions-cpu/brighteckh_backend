import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min,
  MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { EntityProfileDto } from '../br08/dto/br08.dto';
import { EntityProfileResponse } from '../br08/dto/br08.responses';
import { AuthorityConfigDto, ROLES } from '../br09/dto/br09.dto';
import { Br09Config } from '../br09/dto/br09.responses';
import { AuthorityDto } from '../br10/dto/br10.dto';
import { AuthorityStatus } from '../br10/dto/br10.responses';
import { SalesPolicyDto } from '../br11/dto/br11.dto';
import { SalesConfigResponse } from '../br11/dto/br11.responses';
import { CalendarResponse } from '../calendar/dto/calendar.dto';
import { CompanyConfigResponse, CompanyPolicyDto } from '../company-config/company-config.dto';
import { Br08GstRateConfigRow } from '../../common/swagger/rows.generated';

const notNull = (_: unknown, v: unknown) => v !== null;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$/;

export const SETTINGS_TABS = ['COMPANY_TAX', 'AUTHORISERS', 'POLICIES', 'CALENDAR'] as const;
export const GST_LINE_TYPES = [
  'REPAIR_SERVICE', 'MATERIAL', 'LABOUR', 'INSPECTION', 'TESTING', 'EXTERNAL', 'FREIGHT', 'OTHER', 'PRODUCT_SALE',
];

// ---------------------------------------------------------------- writes

/** Company & tax: the BR-08 entity profile plus legal name and Udyam (027). Omitted = unchanged. */
export class AdminProfileDto extends EntityProfileDto {
  @ApiPropertyOptional({ example: 'Brightech Industrial Automation Pvt Ltd' })
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) legal_name?: string;
  @ApiPropertyOptional({ type: 'string', nullable: true, example: 'UDYAM-KR-03-0012345', description: 'null = clear' })
  @IsOptional() @ValidateIf(notNull) @Matches(/^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/) udyam_number?: string | null;
}

/** The four single-role authorisers held in company_policy_config (026/027). null = clear. Stored only. */
export class AuthorityRolesDto {
  @ApiPropertyOptional({ enum: ROLES, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsIn(ROLES)
  customer_return_authority_role?: string | null;
  @ApiPropertyOptional({ enum: ROLES, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsIn(ROLES)
  supplier_refund_authority_role?: string | null;
  @ApiPropertyOptional({ enum: ROLES, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsIn(ROLES)
  kpi_signoff_authority_role?: string | null;
  @ApiPropertyOptional({ enum: ROLES, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsIn(ROLES)
  supplier_return_authority_role?: string | null;
}

export class AdminAuthorisersDto {
  @ApiPropertyOptional({ type: [AuthorityConfigDto], description: 'BR-09 decision authorities (CLAIM_DECISION, GOODWILL_APPROVAL, ...)' })
  @IsOptional() @IsArray() @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => AuthorityConfigDto)
  support?: AuthorityConfigDto[];
  @ApiPropertyOptional({ type: [AuthorityDto], description: 'BR-10 restricted-grant approvers (FINANCIAL_GRANT, CROSS_COMPANY_GRANT)' })
  @IsOptional() @IsArray() @ArrayMaxSize(2) @ValidateNested({ each: true }) @Type(() => AuthorityDto)
  mis?: AuthorityDto[];
  @ApiPropertyOptional({ type: AuthorityRolesDto })
  @IsOptional() @ValidateNested() @Type(() => AuthorityRolesDto) roles?: AuthorityRolesDto;
}

export class AdminPoliciesDto {
  @ApiPropertyOptional({ type: CompanyPolicyDto, description: 'Company policy fields (discount, return windows, freight, follow-up, RMA turnaround)' })
  @IsOptional() @ValidateNested() @Type(() => CompanyPolicyDto) company?: CompanyPolicyDto;
  @ApiPropertyOptional({ type: SalesPolicyDto, description: 'BR-11 invoice trigger, payment-before-closure, advance policy' })
  @IsOptional() @ValidateNested() @Type(() => SalesPolicyDto) sales?: SalesPolicyDto;
}

export class WorkingDayDto {
  @ApiProperty({ minimum: 1, maximum: 7, description: 'ISO weekday, 1 = Monday .. 7 = Sunday' })
  @Type(() => Number) @IsInt() @Min(1) @Max(7) iso_dow!: number;
  @ApiProperty({ example: '09:30' }) @Matches(HHMM) start_local!: string;
  @ApiProperty({ example: '18:30' }) @Matches(HHMM) end_local!: string;
  @ApiPropertyOptional({ type: 'string', nullable: true, example: '13:30' })
  @IsOptional() @ValidateIf(notNull) @Matches(HHMM) break_start_local?: string | null;
  @ApiPropertyOptional({ type: 'string', nullable: true, example: '14:00' })
  @IsOptional() @ValidateIf(notNull) @Matches(HHMM) break_end_local?: string | null;
}

export class WorkingHoursDto {
  @ApiProperty({ type: [WorkingDayDto], description: 'Every working weekday. A weekday not listed is a non-working day.' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => WorkingDayDto)
  days!: WorkingDayDto[];
}

export class GstRateDto {
  @ApiProperty({ enum: GST_LINE_TYPES, nullable: true, description: 'null = the default row used by every line type without its own row' })
  @ValidateIf(notNull) @IsIn(GST_LINE_TYPES) quote_line_type!: string | null;
  @ApiPropertyOptional({ type: 'string', nullable: true, example: '998732', description: 'Omitted = keep the current HSN/SAC. Required unless PRODUCT_SALE (item HSN applies).' })
  @IsOptional() @ValidateIf(notNull) @Matches(/^[0-9]{4,8}$/) hsn_sac?: string | null;
  @ApiProperty({ example: 18, description: 'IGST %. CGST = SGST = IGST / 2.' })
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) igst_rate!: number;
}

export class TestSlaTargetDto {
  @ApiProperty({ enum: ['NORMAL', 'URGENT', 'CRITICAL'] }) @IsIn(['NORMAL', 'URGENT', 'CRITICAL']) priority!: string;
  @ApiProperty({ minimum: 1 }) @Type(() => Number) @IsInt() @Min(1) @Max(1000) target_amount!: number;
  @ApiProperty({ enum: ['WORKING_HOUR', 'WORKING_DAY'] }) @IsIn(['WORKING_HOUR', 'WORKING_DAY']) target_unit!: string;
}

export class AdminHolidayDto {
  @ApiProperty({ example: '2026-12-25' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) holiday_date!: string;
  @ApiProperty({ example: 'Christmas' }) @IsString() @MinLength(1) @MaxLength(200) description!: string;
}

// ---------------------------------------------------------------- reads

export class AdminCompanyRow {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'BLR' }) entity_code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: 'string', nullable: true }) legal_name!: string | null;
  @ApiProperty() is_active!: boolean;
}

export class SavedStamp {
  @ApiProperty({ format: 'date-time' }) at!: string;
  @ApiProperty({ format: 'uuid' }) by_id!: string;
  @ApiProperty() by_name!: string;
}

export class SettingsLastSaved {
  @ApiProperty({ type: SavedStamp, nullable: true }) COMPANY_TAX!: SavedStamp | null;
  @ApiProperty({ type: SavedStamp, nullable: true }) AUTHORISERS!: SavedStamp | null;
  @ApiProperty({ type: SavedStamp, nullable: true }) POLICIES!: SavedStamp | null;
  @ApiProperty({ type: SavedStamp, nullable: true }) CALENDAR!: SavedStamp | null;
}

export class TestSlaTarget {
  @ApiProperty({ enum: ['NORMAL', 'URGENT', 'CRITICAL'] }) priority!: string;
  @ApiProperty({ type: 'integer' }) target_amount!: number;
  @ApiProperty({ enum: ['WORKING_HOUR', 'WORKING_DAY'] }) target_unit!: string;
  @ApiProperty({ example: 'BR07_TEST_START' }) event_code!: string;
}

export class AdminCompanySettings {
  @ApiProperty({ type: AdminCompanyRow }) company!: AdminCompanyRow;
  @ApiProperty({ type: EntityProfileResponse }) profile!: EntityProfileResponse;
  @ApiProperty({ type: CompanyConfigResponse }) company_config!: CompanyConfigResponse;
  @ApiProperty({ type: SalesConfigResponse }) sales_config!: SalesConfigResponse;
  @ApiProperty({ type: Br09Config }) support_config!: Br09Config;
  @ApiProperty({ type: [AuthorityStatus] }) mis_authorities!: AuthorityStatus[];
  @ApiProperty({ type: CalendarResponse, nullable: true, description: 'null = the company has no active working calendar' })
  calendar!: CalendarResponse | null;
  @ApiProperty({ type: [Br08GstRateConfigRow], description: 'GLOBAL: active GST rate rows (shared by every company)' })
  gst_rates!: Br08GstRateConfigRow[];
  @ApiProperty({ type: [TestSlaTarget], description: 'GLOBAL: BR-07 test-start SLA per job priority (shared by every company)' })
  test_sla_targets!: TestSlaTarget[];
  @ApiProperty({ type: SettingsLastSaved, description: 'Last save from this Settings panel, per tab' })
  last_saved!: SettingsLastSaved;
}

export class NumberingSeries {
  @ApiProperty({ example: 'INV' }) kind!: string;
  @ApiProperty({ example: 'Tax invoice' }) label!: string;
  @ApiProperty({ enum: ['FISCAL_YEAR', 'COMPANY', 'GLOBAL'], description: 'FISCAL_YEAR = resets each 1 April; COMPANY = never resets; GLOBAL = one series for all companies' })
  scope!: string;
  @ApiProperty({ example: '<PREFIX>/<n>/<YY-YY>' }) format!: string;
  @ApiProperty({ type: 'string', nullable: true, example: 'BIAPL/496/26-27', description: 'null = nothing issued yet in this series' })
  latest_number!: string | null;
  @ApiProperty({ type: 'string', nullable: true, example: 'BIAPL/497/26-27', description: 'null = cannot be formed (e.g. no document prefix)' })
  next_number!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true }) last_issued_at!: string | null;
}

export class AdminNumbering {
  @ApiProperty({ type: AdminCompanyRow }) company!: AdminCompanyRow;
  @ApiProperty({ example: '2026-27', description: 'Current fiscal year (Asia/Kolkata)' }) fiscal_year!: string;
  @ApiProperty({ type: 'string', nullable: true, example: 'BIAPL' }) doc_prefix!: string | null;
  @ApiProperty({ type: [NumberingSeries] }) series!: NumberingSeries[];
}
