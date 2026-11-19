import { ApiProperty } from '@nestjs/swagger';
import {
  Br08CreditNotesRow, Br08DeliveryAcknowledgementsRow, Br08DeliveryChallansRow, Br08DispatchBatchesRow,
  Br08DispatchBatchJobsRow, Br08InvoiceJobsRow, Br08InvoiceLinesRow, Br08InvoicesRow, Br08JobWaiversRow,
  Br08InvoiceSalesLinesRow, Br08PaymentAllocationsRow, Br08PaymentReceiptsRow, Br08SalesInvoiceSourcesRow, ServiceJobsRow,
} from '../../../common/swagger/rows.generated';

const PAISE = 'Integer paise, returned as a decimal string (bigint)';

export class EntityProfileResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() entity_code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) legal_name!: string | null;
  @ApiProperty({ nullable: true, example: 'BIAPL' }) doc_prefix!: string | null;
  @ApiProperty({ nullable: true }) gstin!: string | null;
  @ApiProperty({ nullable: true, example: '29' }) state_code!: string | null;
  @ApiProperty({ nullable: true, example: 'Karnataka' }) state_name!: string | null;
  @ApiProperty({ nullable: true }) registered_address!: string | null;
  @ApiProperty({ nullable: true }) bank_account_name!: string | null;
  @ApiProperty({ nullable: true }) bank_name!: string | null;
  @ApiProperty({ nullable: true }) bank_account_no!: string | null;
  @ApiProperty({ nullable: true }) bank_ifsc!: string | null;
  @ApiProperty({ nullable: true }) bank_branch!: string | null;
}

export class DispatchBatchCreated extends Br08DispatchBatchesRow {
  @ApiProperty({ type: [Br08DispatchBatchJobsRow] }) jobs!: Br08DispatchBatchJobsRow[];
}

export class DispatchBatchJob extends Br08DispatchBatchJobsRow {
  @ApiProperty() job_number!: string;
}

export class DispatchBatchDetail extends Br08DispatchBatchesRow {
  @ApiProperty({ type: [DispatchBatchJob] }) jobs!: DispatchBatchJob[];
  @ApiProperty({ type: Br08DeliveryChallansRow, nullable: true }) delivery_challan!: Br08DeliveryChallansRow | null;
  @ApiProperty({ type: Br08DeliveryAcknowledgementsRow, nullable: true }) proof_of_delivery!: Br08DeliveryAcknowledgementsRow | null;
}

export class Dispatched {
  @ApiProperty({ type: Br08DispatchBatchesRow }) batch!: Br08DispatchBatchesRow;
  @ApiProperty({ type: Br08DeliveryChallansRow, description: 'Job Work challan, number <seq>/<PREFIX>/NA/<YYYY-YY>' })
  delivery_challan!: Br08DeliveryChallansRow;
}

export class InvoicePreview {
  @ApiProperty({ type: 'string', nullable: true, description: 'Always null in a preview (no number is consumed)' })
  invoice_number!: null;
  @ApiProperty() preview!: boolean;
  @ApiProperty({ enum: ['INTRA_STATE', 'INTER_STATE'], description: 'Server-derived from place of supply vs entity state' })
  tax_regime!: string;
  @ApiProperty({ type: 'string', format: 'date' }) invoice_date!: string;
  @ApiProperty({ type: 'integer' }) credit_days!: number;
  @ApiProperty({ type: 'string', format: 'date' }) due_date!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) supplier!: Record<string, unknown>;
  @ApiProperty({ type: 'object', additionalProperties: true }) customer!: Record<string, unknown>;
  @ApiProperty({ type: 'object', additionalProperties: true }) place_of_supply!: Record<string, unknown>;
  @ApiProperty({ type: 'object', additionalProperties: true }) bank!: Record<string, unknown>;
  @ApiProperty({ type: 'array', items: { type: 'object' } }) customer_order_refs!: unknown[];
  @ApiProperty({ type: 'array', items: { type: 'object' } }) jobs!: unknown[];
  @ApiProperty({ type: 'array', items: { type: 'object' }, description: 'Same shape as br08_invoice_lines' }) lines!: unknown[];
  @ApiProperty({ type: 'integer' }) sub_total_paise!: number;
  @ApiProperty({ type: 'integer' }) cgst_paise!: number;
  @ApiProperty({ type: 'integer' }) sgst_paise!: number;
  @ApiProperty({ type: 'integer' }) igst_paise!: number;
  @ApiProperty({ type: 'integer' }) total_paise!: number;
  @ApiProperty({ example: 'Rupees One Thousand Sixty Two Only' }) total_in_words!: string;
}

export class InvoiceJob extends Br08InvoiceJobsRow {
  @ApiProperty() job_number!: string;
  @ApiProperty({ nullable: true }) challan_number!: string | null;
}

export class InvoiceDetail extends Br08InvoicesRow {
  @ApiProperty({ description: PAISE }) balance_paise!: string;
  @ApiProperty({ type: [InvoiceJob] }) jobs!: InvoiceJob[];
  @ApiProperty({ type: [Br08InvoiceLinesRow], description: 'REPAIR invoices; empty for PRODUCT_SALES' }) lines!: Br08InvoiceLinesRow[];
  @ApiProperty({ type: [Br08InvoiceSalesLinesRow], description: 'PRODUCT_SALES invoices (BR-11 Sales Order lines); empty for REPAIR' })
  sales_lines!: Br08InvoiceSalesLinesRow[];
  @ApiProperty({ type: () => SalesInvoiceSource, nullable: true }) sales_source!: SalesInvoiceSource | null;
  @ApiProperty({ type: [Br08PaymentAllocationsRow] }) allocations!: Br08PaymentAllocationsRow[];
  @ApiProperty({ type: Br08CreditNotesRow, nullable: true }) credit_note!: Br08CreditNotesRow | null;
}

export class InvoicePrint {
  @ApiProperty({ example: ['ORIGINAL', 'DUPLICATE', 'TRIPLICATE'], description: 'Render `document` once per label' })
  copies!: string[];
  @ApiProperty({ type: InvoiceDetail }) document!: InvoiceDetail;
}

export class ReceiptAllocation extends Br08PaymentAllocationsRow {
  @ApiProperty() invoice_number!: string;
  @ApiProperty() invoice_status!: string;
  @ApiProperty({ description: PAISE }) total_paise!: string;
  @ApiProperty({ description: PAISE }) amount_paid_paise!: string;
}

export class ReceiptDetail extends Br08PaymentReceiptsRow {
  @ApiProperty({ description: PAISE }) unallocated_paise!: string;
  @ApiProperty({ type: [ReceiptAllocation] }) allocations!: ReceiptAllocation[];
}

export class CreditNoteDetail extends Br08CreditNotesRow {
  @ApiProperty({ type: [Br08PaymentAllocationsRow], description: 'Negative allocations returning paid amounts to their receipts' })
  payment_reversals!: Br08PaymentAllocationsRow[];
}

export class WaiverResult {
  @ApiProperty({ type: Br08JobWaiversRow }) waiver!: Br08JobWaiversRow;
  @ApiProperty({ type: ServiceJobsRow }) job!: ServiceJobsRow;
}

export class SalesInvoicePreview extends InvoicePreview {
  @ApiProperty({ enum: ['PRODUCT_SALES'] }) invoice_type!: string;
  @ApiProperty({ enum: ['ADVANCE', 'DISPATCH', 'DELIVERY'], description: 'Company invoice trigger (CLIENT-UNCONFIRMED config, 11C-07)' })
  invoice_trigger!: string;
  @ApiProperty({ format: 'uuid' }) sales_order_id!: string;
  @ApiProperty() sales_order_number!: string;
}

export class SalesInvoiceSource extends Br08SalesInvoiceSourcesRow {
  @ApiProperty() sales_order_number!: string;
}

// ---------------------------------------------------------------- GET /payments (receipt list)

export class PaymentReceiptListRow extends Br08PaymentReceiptsRow {
  @ApiProperty() customer_name!: string;
  @ApiProperty() customer_code!: string;
  @ApiProperty({ type: 'string', nullable: true, description: 'employees.full_name of recorded_by_id' }) recorded_by_name!: string | null;
  @ApiProperty({ type: 'string', format: 'int64', description: 'amount_paise - allocated_paise (not yet allocated to invoices)' })
  unallocated_paise!: string;
  @ApiProperty({ type: 'string', format: 'int64', description: 'sum of BR-11 advances (required_amount_paise) already confirmed against this receipt' })
  advance_backed_paise!: string;
  @ApiProperty({ type: 'string', format: 'int64', description: 'amount_paise - advance_backed_paise: what a further BR-11 advance confirmation can still count (br11_guard_payment_condition rule)' })
  available_for_advance_paise!: string;
}

export class PaymentReceiptListPage {
  @ApiProperty({ type: [PaymentReceiptListRow], description: 'received_on descending, newest recorded first' }) rows!: PaymentReceiptListRow[];
  @ApiProperty({ type: 'integer' }) total!: number;
  @ApiProperty({ type: 'integer' }) page!: number;
  @ApiProperty({ type: 'integer' }) page_size!: number;
}
