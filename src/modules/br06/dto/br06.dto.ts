import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Max,
  MaxLength, Min, MinLength,
} from 'class-validator';

export class CreatePoDto {
  @IsArray() @IsUUID('4', { each: true }) offer_line_ids!: string[];
  @IsOptional() @IsString() currency_code?: string;
  @IsOptional() @IsString() payment_terms?: string;
}

export class AcknowledgePoDto {
  @IsOptional() @IsString() supplier_reference?: string;
  @IsOptional() @IsString() expected_delivery_date?: string;
  @IsOptional() @IsString() notes?: string;
}

export class RecordShipmentDto {
  @IsOptional() @IsString() carrier?: string;
  @IsOptional() @IsString() awb_or_lr_number?: string;
  @IsOptional() @IsString() expected_arrival_date?: string;
  @IsOptional() @IsString() notes?: string;
}

class GrnLineInputDto {
  @IsUUID() po_line_id!: string;
  @IsNumber() @IsPositive() received_quantity!: number;
}

export class CreateGrnDto {
  @IsArray() lines!: GrnLineInputDto[];
  @IsOptional() @IsString() notes?: string;
}

export class AddGrnLineMediaDto {
  @IsString() file_uri!: string;
  @IsString() file_name!: string;
}

export class PostGrnLineDto {
  @IsNumber() @Min(0) accepted_quantity!: number;
  @IsNumber() @Min(0) rejected_quantity!: number;
  @IsNumber() @Min(0) held_quantity!: number;
}

// ---------------------------------------------------------------- SALES_ORDER purpose (BR-11 shortages, 11B-06)
export class CreateSalesSourcingDto {
  @ApiProperty({ example: 4 }) @IsNumber() @IsPositive() quantity!: number;
  @ApiPropertyOptional({ description: 'fdn_suppliers id (optional: the canonical supplier master has no approval flow yet)' })
  @IsOptional() @IsUUID() supplier_id?: string;
  @ApiProperty({ example: 'Acme Electronics' }) @IsString() @MinLength(1) @MaxLength(200) supplier_name!: string;
  @ApiProperty({ description: 'Supplier unit price for the PO (internal; never shown to Sales / customer)', example: 812.5 })
  @IsNumber() @Min(0) supplier_unit_price!: number;
  @ApiProperty() @IsString() @MinLength(1) supplier_offer_evidence_uri!: string;
  @ApiProperty() @IsString() @MinLength(1) comparison_evidence_uri!: string;
  @ApiProperty({ description: '1 = L1 (lowest). >1 requires MD approval evidence', example: 1 })
  @IsInt() @Min(1) @Max(99) selected_rank!: number;
  @ApiPropertyOptional({ description: 'Employee who gave MD approval (required when selected_rank > 1)' })
  @IsOptional() @IsUUID() md_approved_by_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() md_approved_at?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() md_approval_evidence_uri?: string;
}

export class CreateSalesOrderPoDto {
  @ApiProperty({ type: [String], description: 'APPROVED sourcing authorisations of ONE Sales Order and ONE supplier' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique() @IsUUID('all', { each: true }) sourcing_authorisation_ids!: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() currency_code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() payment_terms?: string;
}
