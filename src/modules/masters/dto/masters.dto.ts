import {
  IsString, IsOptional, IsIn, Length, Matches, IsBoolean, IsNumber, IsUUID, IsObject,
} from 'class-validator';

const CLASS2 = /^[0-9]{2}$/;

export class CreateItemDto {
  @Matches(/^[0-9]{12}$/, { message: 'item_code must be 12 digits' }) item_code!: string;
  @IsIn(['ITEM', 'COMPONENT', 'CONSUMABLE']) record_type!: string;
  @IsString() @Length(1, 300) standard_name!: string;
  @IsOptional() @IsString() short_description?: string;
  @Matches(CLASS2) cc!: string;
  @Matches(CLASS2) ss!: string;
  @Matches(CLASS2) tt!: string;
  @IsOptional() @IsObject() detailed_spec?: Record<string, unknown>;
  @IsString() base_uom!: string;
  @IsString() use_case!: string;
  @IsOptional() @IsString() package_footprint?: string;
  @IsOptional() @IsObject() electrical_ratings?: Record<string, unknown>;
  @IsOptional() @IsString() material_grade?: string;
  @IsIn(['STOCK', 'NON_STOCK', 'CONSUMABLE']) stock_flag!: string;
  @IsOptional() @IsBoolean() batch_tracking?: boolean;
  @IsOptional() @IsBoolean() serial_tracking?: boolean;
  @IsString() duplicate_review_note!: string; // IM-030 mandatory
}

export class CreateAssemblyDto {
  @Matches(/^[0-9]{12}$/) assembly_code!: string;
  @IsString() @Length(1, 300) standard_name!: string;
  @Matches(CLASS2) cc!: string;
  @Matches(CLASS2) ss!: string;
  @Matches(CLASS2) tt!: string;
  @IsIn(['ELECTRONIC_CARD', 'MOTOR', 'DRIVE', 'MODULE', 'INSTRUMENT', 'OTHER']) assembly_type!: string;
  @IsString() core_function!: string;
  @IsOptional() @IsObject() specifications?: Record<string, unknown>;
  @IsIn(['KNOWN', 'PARTIAL', 'UNKNOWN', 'NOT_APPLICABLE']) bom_status!: string;
  @IsBoolean() repairable!: boolean;   // AM-017 independent
  @IsBoolean() saleable!: boolean;     // AM-018 independent
  @IsString() duplicate_review_note!: string; // AM-024 mandatory
}

export class AddBomLineDto {
  @IsUUID() item_id!: string;
  @IsNumber() qty_per!: number;
  @IsString() uom!: string;
  @IsOptional() @IsNumber() bom_revision?: number;
}
