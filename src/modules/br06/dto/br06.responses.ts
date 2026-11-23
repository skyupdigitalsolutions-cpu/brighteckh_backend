import { ApiProperty } from '@nestjs/swagger';
import {
  Br06GrnLinesRow, Br06GrnsRow, Br06PoLinesRow, Br06SupplierPurchaseOrdersRow,
} from '../../../common/swagger/rows.generated';

/** GET /purchase-orders/:id */
export class PurchaseOrderDetail extends Br06SupplierPurchaseOrdersRow {
  @ApiProperty({ type: [Br06PoLinesRow], description: 'Ordered by line_no' }) lines!: Br06PoLinesRow[];
}

/** GET /grns/:id */
export class GrnDetail extends Br06GrnsRow {
  @ApiProperty({ type: [Br06GrnLinesRow] }) lines!: Br06GrnLinesRow[];
}

// ---------------------------------------------------------------- GET /purchase-orders/:id (read; 23 Nov 2026 additive)
// POST /jobs/:id/purchase-orders still returns PurchaseOrderDetail (header + raw lines); the read adds the fields below.

const nullableStr = (description?: string, format?: string) =>
  ApiProperty({ type: 'string', nullable: true, description, ...(format ? { format } : {}) });
const dec = (description: string) => ApiProperty({ type: 'string', format: 'decimal', description: `${description} (numeric, returned as decimal string)` });

export class PurchaseOrderReadLine extends Br06PoLinesRow {
  @ApiProperty({ description: 'br03_item_catalog_bridge.item_code' }) item_code!: string;
  @ApiProperty({ description: 'br03_item_catalog_bridge.item_name' }) item_name!: string;
  @nullableStr('br04_supplier_offer_lines.product_condition of source_br04_offer_line_id (CUSTOMER_JOB lines; null for SALES_ORDER)')
  product_condition!: string | null;
  @nullableStr('br04_supplier_offer_lines.offered_make (CUSTOMER_JOB lines)') offered_make!: string | null;
  @nullableStr('br04_supplier_offer_lines.offered_part_number (CUSTOMER_JOB lines)') offered_part_number!: string | null;
  @dec('Sum of br06_grn_lines.received_quantity over every GRN of this line (posted or not)') received_quantity!: string;
  @dec('GREATEST(quantity - received, 0)') outstanding_quantity!: string;
}

export class PurchaseOrderAcknowledgement {
  @nullableStr() supplier_reference!: string | null;
  @nullableStr('YYYY-MM-DD', 'date') expected_delivery_date!: string | null;
  @nullableStr() notes!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time', description: 'Server time of the acknowledge call (not an input)' }) acknowledged_at!: string;
  @ApiProperty({ format: 'uuid' }) recorded_by_id!: string;
  @ApiProperty() recorded_by_name!: string;
}

export class PurchaseOrderShipment {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @nullableStr() carrier!: string | null;
  @nullableStr() awb_or_lr_number!: string | null;
  @nullableStr('YYYY-MM-DD', 'date') expected_arrival_date!: string | null;
  @nullableStr() notes!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time', description: 'Server time of the shipment call (not an input)' }) shipped_at!: string;
  @ApiProperty({ format: 'uuid' }) recorded_by_id!: string;
  @ApiProperty() recorded_by_name!: string;
}

export class PurchaseOrderGrnSummary {
  @ApiProperty({ format: 'uuid' }) grn_id!: string;
  @ApiProperty() grn_number!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) received_at!: string;
  @ApiProperty({ format: 'uuid' }) received_by_id!: string;
  @ApiProperty() received_by_name!: string;
  @ApiProperty({ type: 'integer' }) lines_total!: number;
  @ApiProperty({ type: 'integer', description: 'lines with posted_at set' }) lines_posted!: number;
  @dec('Sum of received_quantity (all lines)') received_quantity!: string;
  @dec('Sum of accepted_quantity on POSTED lines') accepted_quantity!: string;
  @dec('Sum of rejected_quantity on POSTED lines') rejected_quantity!: string;
  @dec('Sum of held_quantity on POSTED lines') held_quantity!: string;
}

/** GET /purchase-orders/:id */
export class PurchaseOrderReadDetail extends Br06SupplierPurchaseOrdersRow {
  @nullableStr('service_jobs.job_number (CUSTOMER_JOB POs)') job_number!: string | null;
  @nullableStr('br11_sales_orders.sales_order_number (SALES_ORDER POs)') sales_order_number!: string | null;
  @nullableStr('customers.customer_name: the job\'s inward receipt customer, else the sales order customer') customer_name!: string | null;
  @ApiProperty({ description: 'employees.full_name of created_by_id' }) created_by_name!: string;
  @nullableStr('employees.full_name of released_by_id') released_by_name!: string | null;
  @ApiProperty({ type: PurchaseOrderAcknowledgement, nullable: true }) acknowledgement!: PurchaseOrderAcknowledgement | null;
  @ApiProperty({ type: [PurchaseOrderShipment], description: 'Newest first (shipped_at)' }) shipments!: PurchaseOrderShipment[];
  @ApiProperty({ type: [PurchaseOrderGrnSummary], description: 'GRNs on this PO, newest first' }) grns!: PurchaseOrderGrnSummary[];
  @ApiProperty({ type: [PurchaseOrderReadLine], description: 'Ordered by line_no' }) lines!: PurchaseOrderReadLine[];
}
