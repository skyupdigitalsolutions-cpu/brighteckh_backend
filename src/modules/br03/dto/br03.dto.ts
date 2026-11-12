import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsObject, IsOptional, IsPositive, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CustodyAckDto {
  @IsOptional() @IsString() condition_note?: string;
}

export class StartSessionDto {}

export class PauseSessionDto {
  @IsString() pause_reason!: string;
  @IsOptional() @IsString() pause_category?: string;
}

export class SubmitInspectionVersionDto {
  @IsString() inspection_description!: string;
  @IsIn(['REPAIR_REQUIRED', 'NO_FAULT_FOUND', 'NOT_REPAIRABLE', 'EXTERNAL_REPAIR_REQUIRED', 'FURTHER_INSPECTION_REQUIRED'])
  outcome!: string;
  @IsOptional() @IsString() amendment_reason?: string;
}

export class AddInspectionMediaDto {
  @IsIn(['PHOTO', 'VIDEO']) media_type!: string;
  @IsString() file_uri!: string;
  @IsString() file_name!: string;
  @IsOptional() customer_visible?: boolean;
}

export class ReviewInspectionDto {
  @IsIn(['ACCEPT', 'RETURN']) decision!: string;
  @IsOptional() @IsString() comment?: string;
}

export class CreateMaterialRequestDto {
  @IsIn(['NORMAL', 'URGENT', 'CRITICAL']) priority!: string;
  @IsOptional() @IsString() required_by_date?: string;
  @IsOptional() @IsString() required_by_reason?: string;
}

export class AddMaterialLineDto {
  @IsUUID() item_bridge_id!: string;
  @IsNumber() @IsPositive() quantity!: number;
  @IsOptional() @IsString() preferred_manufacturer?: string;
  @IsOptional() @IsString() preferred_part_number?: string;
  @IsOptional() @IsString() preference_reason?: string;
  @IsOptional() @IsString() technical_note?: string;
}

export class CreateChangeRequestDto {
  @IsString() change_reason!: string;
  @IsObject() proposed_change!: Record<string, unknown>;
}

export class ReviewChangeRequestDto {
  @IsIn(['ACCEPTED', 'REJECTED']) decision!: string;
  @IsOptional() @IsString() comment?: string;
}

/** GET /material-requests/:id/catalogue (G10) */
export class CatalogueQueryDto {
  @ApiPropertyOptional({ description: 'Case-insensitive match on item code or name (bridge and Item Master). Max 100 chars.' })
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ description: 'Max rows, 1-200 (default 50)', example: '50' })
  @IsOptional() @Matches(/^(?:[1-9]\d?|1\d\d|200)$/, { message: 'limit must be an integer between 1 and 200' }) limit?: string;
}
