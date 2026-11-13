import { IsUUID, IsNumber, IsString, IsOptional, IsPositive } from 'class-validator';

class Base {
  @IsUUID() company_id!: string;
  @IsUUID() item_id!: string;
  @IsString() uom!: string;
  @IsNumber() @IsPositive() qty!: number;
  @IsUUID() reference_id!: string;   // originating BR-06/07/05 record
}
// RECEIPT: supplier goods accepted into a store (to_location). BR-06 GRN line.
export class ReceiptDto extends Base { @IsUUID() to_location_id!: string; }
// RESERVE: BR-05 job reservation (no physical move).
export class InventoryReserveDto extends Base { @IsOptional() @IsString() expires_at?: string; }
// ISSUE: main store -> engineer custody. BR-07.
export class IssueDto extends Base { @IsUUID() from_location_id!: string; @IsUUID() to_location_id!: string; }
// CONSUME: engineer custody -> consumed (terminal). BR-07.
export class ConsumeDto extends Base { @IsUUID() from_location_id!: string; @IsUUID() to_location_id!: string; }
// RETURN: engineer custody -> main store (after Purchase verify). BR-07.
export class ReturnDto extends Base { @IsUUID() from_location_id!: string; @IsUUID() to_location_id!: string; }
// SUPPLIER RETURN: quarantine -> supplier return (terminal). BR-06.
export class SupplierReturnDto extends Base { @IsUUID() from_location_id!: string; @IsUUID() to_location_id!: string; }
