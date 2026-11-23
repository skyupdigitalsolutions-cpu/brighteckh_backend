import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto } from './purchase-desk.dto';
import { PageMeta } from './purchase-desk.responses';
import { apply, csvArray, StoresPoAcknowledgement, StoresPoShipment } from './stores-desk.dto';

/**
 * Purchase supplier-PO register ("Orders" pill, CLAUDE.md §4i "Purchase PO register"). PURCHASE only, read-only.
 * Returns what PURCHASE already sees on GET /purchase-orders/:id (PO unit prices -> value, currency, payment terms) and
 * nothing more: no supplier offer ids / versions / ranks / landed cost, no sourcing-authorisation evidence, no customer
 * quote or BR-04 reference price, no BR-11 sell price.
 */

/** br06_supplier_purchase_orders.po_status CHECK values (migration 008). */
export const PO_STATUSES = ['DRAFT', 'RELEASED', 'ACKNOWLEDGED', 'SHIPPED', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
export const PO_PURPOSES = ['CUSTOMER_JOB', 'SALES_ORDER'] as const;

export class PurchasePoListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    type: String, example: 'RELEASED,ACKNOWLEDGED',
    description: `po_status (comma-separated; one or more of ${PO_STATUSES.join(', ')}). Omitted = all.`,
  })
  @apply(csvArray(PO_STATUSES))
  status?: string[];

  @ApiPropertyOptional({
    type: String, example: 'SALES_ORDER',
    description: `purchase_purpose (comma-separated; one or more of ${PO_PURPOSES.join(', ')}). Omitted = both.`,
  })
  @apply(csvArray(PO_PURPOSES))
  purpose?: string[];

  @ApiPropertyOptional({ format: 'uuid', description: 'Only POs of this job (service_jobs.id)' })
  @IsOptional() @IsUUID() job_id?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only POs of this sales order (br11_sales_orders.id)' })
  @IsOptional() @IsUUID() sales_order_id?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only POs with this supplier_id (fdn_suppliers.id)' })
  @IsOptional() @IsUUID() supplier_id?: string;
}

// ---------------------------------------------------------------- response

const nullableStr = (description?: string, format?: string) =>
  ApiProperty({ type: 'string', nullable: true, description, ...(format ? { format } : {}) });
const int = (description?: string) => ApiProperty({ type: 'integer', description });

export class PurchasePoRow {
  @ApiProperty({ format: 'uuid', description: 'br06_supplier_purchase_orders.id' }) id!: string;
  @ApiProperty() po_number!: string;
  @ApiProperty({ enum: PO_STATUSES }) po_status!: PoStatus;
  @ApiProperty({ enum: PO_PURPOSES }) purchase_purpose!: string;
  @nullableStr('fdn_suppliers.id (optional on the PO)', 'uuid') supplier_id!: string | null;
  @ApiProperty({ description: 'supplier_name_snapshot' }) supplier_name!: string;
  @nullableStr('CUSTOMER_JOB POs', 'uuid') job_id!: string | null;
  @nullableStr('service_jobs.job_number (CUSTOMER_JOB POs)') job_number!: string | null;
  @nullableStr('SALES_ORDER POs', 'uuid') sales_order_id!: string | null;
  @nullableStr('br11_sales_orders.sales_order_number (SALES_ORDER POs)') sales_order_number!: string | null;
  @nullableStr('customers.customer_name: the job\'s inward receipt customer, else the sales order customer') customer_name!: string | null;
  @ApiProperty({ description: 'ISO 4217, e.g. INR' }) currency_code!: string;
  @nullableStr() payment_terms!: string | null;
  @int('br06_po_lines rows') lines_count!: number;
  @ApiProperty({
    type: 'string', format: 'decimal',
    description: 'Sum over lines of round(quantity x unit_price, 2), in currency_code (rupees, NOT paise). PO lines store '
      + 'only unit_price: no discount, freight or tax is included (none exists on the PO).',
  })
  value_pre_tax!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) created_at!: string;
  @ApiProperty({ description: 'employees.full_name of created_by_id' }) created_by_name!: string;
  @nullableStr(undefined, 'date-time') released_at!: string | null;
  @nullableStr('employees.full_name of released_by_id') released_by_name!: string | null;
  @ApiProperty({ type: StoresPoAcknowledgement, nullable: true }) acknowledgement!: StoresPoAcknowledgement | null;
  @ApiProperty({ type: StoresPoShipment, nullable: true, description: 'Newest br06_shipments row (by shipped_at); null if none' })
  latest_shipment!: StoresPoShipment | null;
  @nullableStr('latest_shipment.expected_arrival_date, else acknowledgement.expected_delivery_date (YYYY-MM-DD)', 'date')
  expected_date!: string | null;
  @int('GRNs on this PO') grns_count!: number;
  @nullableStr('max(br06_grns.received_at) on this PO', 'date-time') last_received_at!: string | null;
  @int('PO lines whose received quantity (summed over every GRN) is still below the ordered quantity (same as the Stores desk)')
  lines_outstanding!: number;
}

export class PurchasePoStatusCounts {
  @ApiProperty({ type: 'integer' }) DRAFT!: number;
  @ApiProperty({ type: 'integer' }) RELEASED!: number;
  @ApiProperty({ type: 'integer' }) ACKNOWLEDGED!: number;
  @ApiProperty({ type: 'integer' }) SHIPPED!: number;
  @ApiProperty({ type: 'integer' }) RECEIVED!: number;
  @ApiProperty({ type: 'integer' }) CLOSED!: number;
  @ApiProperty({ type: 'integer' }) CANCELLED!: number;
}

export class PurchasePoPage extends PageMeta {
  @ApiProperty({ type: [PurchasePoRow], description: 'created_at newest first; po_number desc breaks ties' })
  rows!: PurchasePoRow[];
  @ApiProperty({
    type: PurchasePoStatusCounts,
    description: 'Per-status totals (all 7, zeros included) over the company + `search` only: ignores `status`, `purpose`, '
      + '`job_id`, `sales_order_id` and `supplier_id`.',
  })
  counts_by_status!: PurchasePoStatusCounts;
}
