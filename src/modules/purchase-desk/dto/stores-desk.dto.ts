import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional } from 'class-validator';
import { PageQueryDto } from './purchase-desk.dto';
import { PageMeta } from './purchase-desk.responses';

/**
 * Stores / Quality desk reads (CLAUDE.md §4i "Stores desk reads"). Quantities only: no unit_price, currency,
 * payment terms or any other supplier commercial field is ever selected for these endpoints.
 */

/** PO statuses on the Stores receiving list. GRN creation itself is allowed only for ACKNOWLEDGED / SHIPPED. */
export const RECEIVABLE_PO_STATUSES = ['RELEASED', 'ACKNOWLEDGED', 'SHIPPED'] as const;
export const GRN_RECEIVABLE_STATUSES = ['ACKNOWLEDGED', 'SHIPPED'];

/** Derived GRN status (not stored): OPEN = no line posted, PARTIAL = some, POSTED = every line posted. */
export const GRN_STATUSES = ['OPEN', 'PARTIAL', 'POSTED'] as const;
export type GrnStatus = (typeof GRN_STATUSES)[number];

const csvArray = (allowed: readonly string[]) => [
  IsOptional(),
  Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
    return parts.map((s) => s.trim()).filter(Boolean);
  }),
  IsArray(), ArrayMaxSize(allowed.length), IsIn(allowed as unknown as string[], { each: true }),
];
const apply = (decorators: PropertyDecorator[]): PropertyDecorator => (target, key) => decorators.forEach((d) => d(target, key));

export class ReceivablePoQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    type: String, example: 'ACKNOWLEDGED,SHIPPED',
    description: `PO status (comma-separated; one or more of ${RECEIVABLE_PO_STATUSES.join(', ')}). Omitted = all three.`,
  })
  @apply(csvArray(RECEIVABLE_PO_STATUSES))
  status?: string[];
}

export class StoresGrnListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    type: String, example: 'OPEN,PARTIAL',
    description: `Derived GRN status (comma-separated; one or more of ${GRN_STATUSES.join(', ')}). Omitted = all.`,
  })
  @apply(csvArray(GRN_STATUSES))
  status?: string[];
}

// ---------------------------------------------------------------- shared pieces

const nullableStr = (description?: string, format?: string) =>
  ApiProperty({ type: 'string', nullable: true, description, ...(format ? { format } : {}) });
const dec = (description: string) => ApiProperty({ type: 'string', format: 'decimal', description: `${description} (numeric, returned as decimal string)` });
const int = (description?: string) => ApiProperty({ type: 'integer', description });

export class StoresPoShipment {
  @nullableStr('br06_shipments.carrier') carrier!: string | null;
  @nullableStr('br06_shipments.awb_or_lr_number') awb_or_lr_number!: string | null;
  @nullableStr('br06_shipments.expected_arrival_date (YYYY-MM-DD)', 'date') expected_arrival_date!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) shipped_at!: string;
}

export class StoresPoAcknowledgement {
  @nullableStr('br06_po_acknowledgements.supplier_reference') supplier_reference!: string | null;
  @nullableStr('br06_po_acknowledgements.expected_delivery_date (YYYY-MM-DD)', 'date') expected_delivery_date!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) acknowledged_at!: string;
}

/** PO header fields Stores may see. */
export class StoresPoHeader {
  @ApiProperty({ format: 'uuid', description: 'br06_supplier_purchase_orders.id (POST /purchase-orders/:id/grns takes this)' }) po_id!: string;
  @ApiProperty() po_number!: string;
  @ApiProperty({ enum: ['DRAFT', 'RELEASED', 'ACKNOWLEDGED', 'SHIPPED', 'RECEIVED', 'CLOSED', 'CANCELLED'] }) po_status!: string;
  @ApiProperty({ enum: ['CUSTOMER_JOB', 'SALES_ORDER'] }) purchase_purpose!: string;
  @ApiProperty() supplier_name!: string;
  @nullableStr(undefined, 'uuid') job_id!: string | null;
  @nullableStr('service_jobs.job_number (CUSTOMER_JOB POs)') job_number!: string | null;
  @nullableStr(undefined, 'uuid') sales_order_id!: string | null;
  @nullableStr('br11_sales_orders.sales_order_number (SALES_ORDER POs)') sales_order_number!: string | null;
  @nullableStr(undefined, 'date-time') released_at!: string | null;
  @ApiProperty({ description: 'true when POST /purchase-orders/:id/grns will accept a GRN (po_status ACKNOWLEDGED or SHIPPED)' })
  can_receive!: boolean;
  @ApiProperty({ type: StoresPoAcknowledgement, nullable: true }) acknowledgement!: StoresPoAcknowledgement | null;
  @ApiProperty({ type: StoresPoShipment, nullable: true, description: 'Newest br06_shipments row (by shipped_at); null if none' })
  latest_shipment!: StoresPoShipment | null;
}

export class ReceivablePoRow extends StoresPoHeader {
  @int('PO lines') lines_total!: number;
  @int('PO lines whose received quantity (summed over every GRN) is still below the ordered quantity') lines_outstanding!: number;
  @int('GRNs on this PO with at least one unposted line') open_grns!: number;
}

export class ReceivablePoStatusCounts {
  @ApiProperty({ type: 'integer' }) RELEASED!: number;
  @ApiProperty({ type: 'integer' }) ACKNOWLEDGED!: number;
  @ApiProperty({ type: 'integer' }) SHIPPED!: number;
}

export class ReceivablePoPage extends PageMeta {
  @ApiProperty({
    type: [ReceivablePoRow],
    description: 'SHIPPED first, then ACKNOWLEDGED, then RELEASED; within a status by expected date (shipment expected_arrival_date, '
      + 'else acknowledgement expected_delivery_date) ascending, nulls last; po_number breaks ties.',
  })
  rows!: ReceivablePoRow[];
  @ApiProperty({ type: ReceivablePoStatusCounts, description: 'Per-status totals under the current `search` only (ignores `status`).' })
  counts_by_status!: ReceivablePoStatusCounts;
}

export class StoresPoLine {
  @ApiProperty({ format: 'uuid', description: 'br06_po_lines.id (GrnLineInputDto.po_line_id)' }) po_line_id!: string;
  @int() line_no!: number;
  @ApiProperty({ format: 'uuid' }) item_bridge_id!: string;
  @ApiProperty({ description: 'br03_item_catalog_bridge.item_code' }) item_code!: string;
  @ApiProperty({ description: 'br03_item_catalog_bridge.item_name' }) item_name!: string;
  @ApiProperty() uom!: string;
  @dec('br06_po_lines.quantity') ordered_quantity!: string;
  @dec('Sum of br06_grn_lines.received_quantity over every GRN of this PO line (posted or not)') received_quantity!: string;
  @dec('Sum of accepted + rejected + held over POSTED GRN lines (what the PO -> RECEIVED rule counts)') posted_quantity!: string;
  @dec('GREATEST(ordered - received, 0)') outstanding_quantity!: string;
}

export class StoresGrnHeaderRow {
  @ApiProperty({ format: 'uuid' }) grn_id!: string;
  @ApiProperty() grn_number!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) received_at!: string;
  @ApiProperty({ format: 'uuid' }) received_by_id!: string;
  @ApiProperty({ description: 'employees.full_name of received_by_id' }) received_by_name!: string;
  @nullableStr() notes!: string | null;
  @int() lines_total!: number;
  @int('lines with posted_at set') lines_posted!: number;
  @ApiProperty({ enum: GRN_STATUSES, description: 'OPEN = no line posted, PARTIAL = some, POSTED = every line posted' }) grn_status!: GrnStatus;
}

export class StoresPoDetail extends StoresPoHeader {
  @ApiProperty({ type: [StoresPoLine], description: 'Ordered by line_no' }) lines!: StoresPoLine[];
  @ApiProperty({ type: [StoresGrnHeaderRow], description: 'GRNs on this PO, newest first' }) grns!: StoresGrnHeaderRow[];
}

// ---------------------------------------------------------------- GRN list / detail

export class StoresGrnRow extends StoresGrnHeaderRow {
  @ApiProperty({ format: 'uuid' }) po_id!: string;
  @ApiProperty() po_number!: string;
  @ApiProperty() supplier_name!: string;
  @nullableStr() job_number!: string | null;
  @nullableStr() sales_order_number!: string | null;
}

export class StoresGrnStatusCounts {
  @ApiProperty({ type: 'integer' }) OPEN!: number;
  @ApiProperty({ type: 'integer' }) PARTIAL!: number;
  @ApiProperty({ type: 'integer' }) POSTED!: number;
}

export class StoresGrnPage extends PageMeta {
  @ApiProperty({ type: [StoresGrnRow], description: 'received_at descending; grn_number breaks ties' }) rows!: StoresGrnRow[];
  @ApiProperty({ type: StoresGrnStatusCounts, description: 'Per-status totals under the current `search` only (ignores `status`).' })
  counts_by_status!: StoresGrnStatusCounts;
}

export class StoresGrnLineMedia {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'GET it with the bearer token to read the bytes (/api/uploads/:id)' }) file_uri!: string;
  @ApiProperty() file_name!: string;
  @ApiProperty({ format: 'uuid' }) uploaded_by_id!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) uploaded_at!: string;
}

export class StoresLedgerMovement {
  @ApiProperty({ format: 'uuid', description: 'fdn_inventory_journal.id (= the *_movement_ref on the GRN line)' }) id!: string;
  @ApiProperty({ enum: ['RECEIPT', 'ISSUE', 'CONSUME', 'RETURN', 'SUPPLIER_RETURN', 'TRANSFER', 'ADJUST'] }) movement_type!: string;
  @dec('fdn_inventory_journal.qty') qty!: string;
  @ApiProperty() uom!: string;
  @nullableStr('fdn_inventory_locations.role of from_location_id') from_location_role!: string | null;
  @nullableStr() from_location_code!: string | null;
  @nullableStr('fdn_inventory_locations.role of to_location_id (MAIN_STORE for accepted, QUARANTINE for rejected + held)') to_location_role!: string | null;
  @nullableStr() to_location_code!: string | null;
  @ApiProperty({ enum: ['POSTED', 'REVERSED'] }) status!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) posted_at!: string;
}

export class StoresGrnLine {
  @ApiProperty({ format: 'uuid', description: 'br06_grn_lines.id (POST /grn-lines/:id/media, /post)' }) id!: string;
  @ApiProperty({ format: 'uuid' }) po_line_id!: string;
  @int('br06_po_lines.line_no') line_no!: number;
  @ApiProperty({ format: 'uuid' }) item_bridge_id!: string;
  @ApiProperty() item_code!: string;
  @ApiProperty() item_name!: string;
  @ApiProperty() uom!: string;
  @dec('ordered_quantity snapshot') ordered_quantity!: string;
  @dec('received_quantity') received_quantity!: string;
  @dec('accepted_quantity') accepted_quantity!: string;
  @dec('rejected_quantity') rejected_quantity!: string;
  @dec('held_quantity') held_quantity!: string;
  @dec('returned_quantity (supplier return, Purchase)') returned_quantity!: string;
  @nullableStr(undefined, 'date-time') posted_at!: string | null;
  @nullableStr('actor of the BR06_GRN_LINE_DISPOSED audit row', 'uuid') posted_by_id!: string | null;
  @nullableStr('employees.full_name of posted_by_id') posted_by_name!: string | null;
  @nullableStr(undefined, 'uuid') main_store_movement_ref!: string | null;
  @nullableStr(undefined, 'uuid') quarantine_movement_ref!: string | null;
  @nullableStr(undefined, 'uuid') return_movement_ref!: string | null;
  @ApiProperty({ type: [StoresGrnLineMedia], description: 'br06_grn_line_media, oldest first (the post gate needs >= 1)' }) media!: StoresGrnLineMedia[];
  @ApiProperty({ type: [StoresLedgerMovement], description: 'fdn_inventory_journal rows with reference_id = this line, oldest first' })
  movements!: StoresLedgerMovement[];
}

export class StoresGrnDetail extends StoresGrnRow {
  @ApiProperty({ type: [StoresGrnLine], description: 'Ordered by PO line_no' }) lines!: StoresGrnLine[];
}
