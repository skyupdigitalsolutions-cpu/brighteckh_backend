import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { PageQueryDto } from './purchase-desk.dto';
import { PageMeta } from './purchase-desk.responses';
import { apply, csvArray } from './stores-desk.dto';

/**
 * Purchase "Stock" pill reads (CLAUDE.md §4i "Purchase Stock desk"). PURCHASE only, read-only.
 * Ledger rows come straight from fdn_inventory_journal / fdn_inventory_balances / fdn_inventory_reservations; allocatable
 * is always fdn_allocatable (never recomputed). Masters (items, assemblies, BOM) are global (no company column).
 */

/** fdn_inventory_journal.movement_type CHECK values (migration 003). */
export const MOVEMENT_TYPES = ['RECEIPT', 'ISSUE', 'CONSUME', 'RETURN', 'SUPPLIER_RETURN', 'TRANSFER', 'ADJUST'] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];
/** fdn_inventory_locations.role CHECK values (migration 003). */
export const LOCATION_ROLES = ['MAIN_STORE', 'QUARANTINE', 'ENGINEER_HELD', 'IN_TRANSIT', 'RETURNED', 'CONSUMED', 'SUPPLIER_RETURN'] as const;
/** reference_kind values the API's ledger writers post (InventoryService / BR-06 / BR-07 / BR-11). */
export const REFERENCE_KINDS = [
  'BR06_GRN_LINE', 'BR06_SUPPLIER_RETURN', 'BR07_ISSUE', 'BR07_CONSUME', 'BR07_RETURN', 'BR11_SALE_ISSUE',
] as const;
/** fdn_item_master / fdn_assembly_master status CHECK values (migration 003). */
export const MASTER_STATUSES = ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'ON_HOLD', 'INACTIVE', 'SUPERSEDED'] as const;
export type MasterStatus = (typeof MASTER_STATUSES)[number];
export const RECORD_TYPES = ['ITEM', 'COMPONENT', 'CONSUMABLE'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
export const STOCK_FLAGS = ['STOCK', 'NON_STOCK', 'CONSUMABLE'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class StockJournalQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, example: 'RECEIPT,ISSUE', description: `movement_type (comma-separated; ${MOVEMENT_TYPES.join(', ')}). Omitted = all.` })
  @apply(csvArray(MOVEMENT_TYPES))
  movement_type?: string[];

  @ApiPropertyOptional({ type: String, example: 'BR06_GRN_LINE', description: `reference_kind (comma-separated; ${REFERENCE_KINDS.join(', ')}). Omitted = all.` })
  @apply(csvArray(REFERENCE_KINDS))
  reference_kind?: string[];

  @ApiPropertyOptional({ format: 'uuid', description: 'Only postings of this reference_id (GRN line, BR-07 issue / consumption / return, BR-11 outward line)' })
  @IsOptional() @IsUUID() reference_id?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only this item (fdn_item_master.id)' })
  @IsOptional() @IsUUID() item_id?: string;

  @ApiPropertyOptional({ type: String, example: 'MAIN_STORE', description: `Location role, matched on from OR to (comma-separated; ${LOCATION_ROLES.join(', ')})` })
  @apply(csvArray(LOCATION_ROLES))
  location_role?: string[];

  @ApiPropertyOptional({ example: '2026-11-01', description: 'posted_at on or after this date (YYYY-MM-DD, company timezone)' })
  @IsOptional() @Matches(DATE_RE, { message: 'from must be YYYY-MM-DD' }) @IsISO8601({ strict: true }, { message: 'from must be a real date' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30', description: 'posted_at on or before this date (YYYY-MM-DD, company timezone, inclusive)' })
  @IsOptional() @Matches(DATE_RE, { message: 'to must be YYYY-MM-DD' }) @IsISO8601({ strict: true }, { message: 'to must be a real date' })
  to?: string;
}

export class StockItemsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, example: 'APPROVED,ACTIVE', description: `status (comma-separated; ${MASTER_STATUSES.join(', ')}). Omitted = all.` })
  @apply(csvArray(MASTER_STATUSES))
  status?: string[];

  @ApiPropertyOptional({ type: String, example: 'COMPONENT', description: `record_type (comma-separated; ${RECORD_TYPES.join(', ')}). Omitted = all.` })
  @apply(csvArray(RECORD_TYPES))
  record_type?: string[];

  @ApiPropertyOptional({ type: String, example: 'STOCK', description: `stock_flag (comma-separated; ${STOCK_FLAGS.join(', ')}). Omitted = all.` })
  @apply(csvArray(STOCK_FLAGS))
  stock_flag?: string[];
}

export class StockAssembliesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, example: 'ACTIVE', description: `status (comma-separated; ${MASTER_STATUSES.join(', ')}). Omitted = all.` })
  @apply(csvArray(MASTER_STATUSES))
  status?: string[];
}

export class StockAssemblyDetailQueryDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 0, description: 'BOM revision to return (default: the latest revision that has lines)' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) revision?: number;
}

// ---------------------------------------------------------------- response helpers

const nullableStr = (description?: string, format?: string) =>
  ApiProperty({ type: 'string', nullable: true, description, ...(format ? { format } : {}) });
const dec = (description: string) => ApiProperty({ type: 'string', format: 'decimal', description: `${description} (numeric, returned as decimal string)` });
const int = (description?: string) => ApiProperty({ type: 'integer', description });

// ---------------------------------------------------------------- counts

export class StockMovementCounts {
  @int() RECEIPT!: number; @int() ISSUE!: number; @int() CONSUME!: number; @int() RETURN!: number;
  @int() SUPPLIER_RETURN!: number; @int() TRANSFER!: number; @int() ADJUST!: number;
}
export class StockMasterStatusCounts {
  @int() DRAFT!: number; @int() UNDER_REVIEW!: number; @int() APPROVED!: number; @int() ACTIVE!: number;
  @int() ON_HOLD!: number; @int() INACTIVE!: number; @int() SUPERSEDED!: number;
}
export class StockRecordTypeCounts {
  @int() ITEM!: number; @int() COMPONENT!: number; @int() CONSUMABLE!: number;
}

// ---------------------------------------------------------------- journal

export class StockJournalRow {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) posted_at!: string;
  @ApiProperty({ enum: MOVEMENT_TYPES }) movement_type!: MovementType;
  @ApiProperty({ enum: ['POSTED', 'REVERSED'] }) status!: string;
  @ApiProperty({ format: 'uuid' }) item_id!: string;
  @ApiProperty() item_code!: string;
  @ApiProperty() item_name!: string;
  @ApiProperty() uom!: string;
  @dec('fdn_inventory_journal.qty (always > 0; direction = from -> to)') qty!: string;
  @nullableStr('fdn_inventory_locations.role of from_location_id; null = stock entered the company (receipt)') from_location_role!: string | null;
  @nullableStr() from_location_code!: string | null;
  @nullableStr('fdn_inventory_locations.role of to_location_id; null = stock left the company (sale issue)') to_location_role!: string | null;
  @nullableStr() to_location_code!: string | null;
  @ApiProperty({ description: `As stored (${REFERENCE_KINDS.join(', ')} today)` }) reference_kind!: string;
  @nullableStr(undefined, 'uuid') reference_id!: string | null;
  @ApiProperty({ type: 'string', nullable: true, enum: ['GRN', 'JOB', 'SALES_OUTWARD'], description: 'What reference_label names; null = not resolvable' })
  reference_document!: string | null;
  @nullableStr('Human document number: GRN number (BR06_*), job number (BR07_*), SOUT number (BR11_SALE_ISSUE)') reference_label!: string | null;
  @nullableStr('br06_grns.id (BR06_*)', 'uuid') grn_id!: string | null;
  @nullableStr('br06_supplier_purchase_orders.id of that GRN (BR06_*)', 'uuid') po_id!: string | null;
  @nullableStr() po_number!: string | null;
  @nullableStr('BR07_* rows, and BR06_* rows whose PO is a repair (CUSTOMER_JOB) PO', 'uuid') job_id!: string | null;
  @nullableStr() job_number!: string | null;
  @nullableStr('br11_outward_batches.id (BR11_SALE_ISSUE)', 'uuid') outward_id!: string | null;
  @nullableStr('BR11_SALE_ISSUE rows (via the outward line\'s sales order line); SALES_ORDER PO GRNs too', 'uuid') sales_order_id!: string | null;
  @nullableStr() sales_order_number!: string | null;
  @nullableStr('employees.full_name of actor_id') actor_name!: string | null;
}

export class StockJournalPage extends PageMeta {
  @ApiProperty({ type: [StockJournalRow] }) rows!: StockJournalRow[];
  @ApiProperty({ type: StockMovementCounts, description: 'Postings per movement type (all 7, zeros included) over company + `search` only' })
  counts_by_movement_type!: Record<MovementType, number>;
}

// ---------------------------------------------------------------- items

export class StockItemRow {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: '12 digits' }) item_code!: string;
  @ApiProperty() standard_name!: string;
  @nullableStr() short_description!: string | null;
  @ApiProperty({ enum: RECORD_TYPES }) record_type!: RecordType;
  @ApiProperty() base_uom!: string;
  @ApiProperty({ enum: STOCK_FLAGS }) stock_flag!: string;
  @ApiProperty({ enum: MASTER_STATUSES }) status!: MasterStatus;
  @ApiProperty() cc!: string;
  @ApiProperty() ss!: string;
  @ApiProperty() tt!: string;
  @ApiProperty() use_case!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) created_at!: string;
  @ApiProperty({ description: 'employees.full_name of created_by_id' }) created_by_name!: string;
  @nullableStr(undefined, 'date-time') tech_approved_at!: string | null;
  @nullableStr('employees.full_name of tech_approved_by_id') tech_approved_by_name!: string | null;
  @int('Distinct assemblies whose LATEST BOM revision has this item') bom_usage_count!: number;
}

export class StockItemsPage extends PageMeta {
  @ApiProperty({ type: [StockItemRow] }) rows!: StockItemRow[];
  @ApiProperty({ type: StockMasterStatusCounts, description: 'All 7 statuses over `search` only' })
  counts_by_status!: Record<MasterStatus, number>;
  @ApiProperty({ type: StockRecordTypeCounts, description: 'All 3 record types over `search` only' })
  counts_by_record_type!: Record<RecordType, number>;
}

export class StockItemUsedIn {
  @ApiProperty({ format: 'uuid' }) assembly_id!: string;
  @ApiProperty() assembly_code!: string;
  @ApiProperty() standard_name!: string;
  @ApiProperty({ enum: MASTER_STATUSES }) assembly_status!: string;
  @int('The assembly\'s latest BOM revision (the one this line is on)') bom_revision!: number;
  @dec('fdn_assembly_bom.qty_per') qty_per!: string;
  @ApiProperty() uom!: string;
}

export class StockBalance {
  @ApiProperty({ enum: LOCATION_ROLES }) role!: string;
  @ApiProperty() code!: string;
  @dec('fdn_inventory_balances.qty_on_hand') qty_on_hand!: string;
}

export class StockItemAvailability {
  @dec('fdn_allocatable(company, item) = MAIN_STORE on hand - ACTIVE reservations') allocatable!: string;
  @dec('Sum of ACTIVE fdn_inventory_reservations for company + item') reserved!: string;
  @ApiProperty({ type: [StockBalance], description: 'Every balance row of the company for this item (ordered by role, code)' })
  balances!: StockBalance[];
}

export class StockItemDetail extends StockItemRow {
  @nullableStr() criticality!: string | null;
  @nullableStr() hsn_tax!: string | null;
  @ApiProperty({ type: 'string', format: 'decimal', nullable: true }) reorder_min_qty!: string | null;
  @ApiProperty({ type: 'integer', nullable: true }) lead_time_days!: number | null;
  @ApiProperty() batch_tracking!: boolean;
  @ApiProperty() serial_tracking!: boolean;
  @nullableStr(undefined, 'date-time') released_at!: string | null;
  @nullableStr('employees.full_name of released_by_id') released_by_name!: string | null;
  @int() effective_revision!: number;
  @ApiProperty({ type: [StockItemUsedIn], description: 'Assemblies whose latest BOM revision has this item, by assembly_code' })
  used_in!: StockItemUsedIn[];
  @ApiProperty({ type: StockItemAvailability, description: 'For the caller\'s company' })
  availability!: StockItemAvailability;
}

// ---------------------------------------------------------------- assemblies

export class StockAssemblyRow {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: '12 digits' }) assembly_code!: string;
  @ApiProperty() standard_name!: string;
  @ApiProperty({ enum: ['ELECTRONIC_CARD', 'MOTOR', 'DRIVE', 'MODULE', 'INSTRUMENT', 'OTHER'] }) assembly_type!: string;
  @nullableStr('Closest field to "make / model" (there is no make or model column)') oem_compatibility!: string | null;
  @ApiProperty({ enum: ['KNOWN', 'PARTIAL', 'UNKNOWN', 'NOT_APPLICABLE'] }) bom_status!: string;
  @ApiProperty() repairable!: boolean;
  @ApiProperty() saleable!: boolean;
  @ApiProperty({ enum: MASTER_STATUSES }) status!: MasterStatus;
  @int() effective_revision!: number;
  @ApiProperty({ type: 'integer', nullable: true, description: 'Highest bom_revision with lines; null = no BOM lines' }) latest_bom_revision!: number | null;
  @int('Lines on the latest BOM revision') bom_lines!: number;
  @int('Lines on the latest revision whose item is not APPROVED / ACTIVE (not requestable)') draft_item_lines!: number;
  @ApiProperty({ type: 'string', format: 'date-time' }) created_at!: string;
}

export class StockAssembliesPage extends PageMeta {
  @ApiProperty({ type: [StockAssemblyRow] }) rows!: StockAssemblyRow[];
  @ApiProperty({ type: StockMasterStatusCounts, description: 'All 7 statuses over `search` only' })
  counts_by_status!: Record<MasterStatus, number>;
}

export class StockBomLine {
  @ApiProperty({ format: 'uuid', description: 'fdn_assembly_bom.id' }) id!: string;
  @ApiProperty({ format: 'uuid' }) item_id!: string;
  @ApiProperty() item_code!: string;
  @ApiProperty() item_name!: string;
  @dec('fdn_assembly_bom.qty_per') qty_per!: string;
  @ApiProperty() uom!: string;
  @ApiProperty({ enum: MASTER_STATUSES }) item_status!: string;
  @ApiProperty({ description: 'item_status is APPROVED or ACTIVE (the ledger / catalogue rule)' }) item_requestable!: boolean;
}

export class StockAssemblyDetail extends StockAssemblyRow {
  @ApiProperty() cc!: string;
  @ApiProperty() ss!: string;
  @ApiProperty() tt!: string;
  @ApiProperty() core_function!: string;
  @nullableStr() hardware_revision!: string | null;
  @nullableStr() firmware_compat!: string | null;
  @nullableStr() variant_interface!: string | null;
  @ApiProperty({ description: 'employees.full_name of created_by_id' }) created_by_name!: string;
  @nullableStr(undefined, 'date-time') tech_approved_at!: string | null;
  @nullableStr() tech_approved_by_name!: string | null;
  @ApiProperty({ type: [Number], description: 'Distinct bom_revision values with lines, ascending' }) bom_revisions!: number[];
  @ApiProperty({ type: 'integer', nullable: true, description: 'The revision `bom` shows (?revision=, else latest); null = no BOM lines' })
  bom_revision!: number | null;
  @ApiProperty({ type: [StockBomLine], description: 'Lines of bom_revision, by item_code' }) bom!: StockBomLine[];
}
