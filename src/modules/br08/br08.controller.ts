import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Br08DeliveryAcknowledgementsRow, Br08DeliveryChallansRow, Br08InvoicesRow, Br08VJobBillingRow,
} from '../../common/swagger/rows.generated';
import { ApiAuth, ApiIdempotencyKey, ApiStdErrors } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { Br08Service } from './br08.service';
import {
  AllocatePaymentDto, CreateDispatchBatchDto, CreditNoteDto, DispatchBatchDto, EntityProfileDto,
  InvoiceRequestDto, ListInvoicesQueryDto, ProofOfDeliveryDto, RecordPaymentDto, SalesInvoiceRequestDto, WaiverDto,
} from './dto/br08.dto';
import {
  CreditNoteDetail, DispatchBatchCreated, DispatchBatchDetail, Dispatched, EntityProfileResponse, InvoiceDetail,
  InvoicePreview, InvoicePrint, ReceiptDetail, SalesInvoicePreview, WaiverResult,
} from './dto/br08.responses';

interface Actor { id: string; role: string; companyId: string }

/**
 * Role split (client-confirmed; enforced here AND by DB triggers):
 *   PURCHASE     -> dispatch batch, Delivery Challan (at dispatch), proof of delivery
 *   FINANCE      -> tax invoice (REPAIR and PRODUCT_SALES), payment receipt/allocation, credit note (raise + approve)
 *   SALES        -> no-charge waiver / job closure
 *   SYSTEM_ADMIN -> company invoicing profile (GSTIN, address, bank, prefix)
 * Reads are open to any authenticated user of the same company.
 */
@ApiTags('BR-08 Dispatch, Invoicing & Payment')
@ApiAuth()
@ApiStdErrors()
@Controller()
@UseGuards(RolesGuard)
export class Br08Controller {
  constructor(private readonly svc: Br08Service) {}

  // ---- company invoicing profile

  @Get('br08/entity-profile')
  @ApiOperation({ summary: "Caller's company invoicing profile (prefix, GSTIN, state, address, bank)" })
  @ApiOkResponse({ type: EntityProfileResponse })
  getProfile(@CurrentActor() actor: Actor) {
    return this.svc.getEntityProfile(actor);
  }

  @Put('br08/entity-profile')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiOperation({ summary: 'Update the invoicing profile. Prefix/state/GSTIN freeze once any BR-08 document exists.' })
  @ApiOkResponse({ type: EntityProfileResponse })
  updateProfile(@Body() dto: EntityProfileDto, @CurrentActor() actor: Actor) {
    return this.svc.updateEntityProfile(dto, actor);
  }

  // ---- dispatch

  @Post('dispatch-batches')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Create a DRAFT dispatch batch of BR-07-released jobs of one customer (no stock-ledger posting)' })
  @ApiCreatedResponse({ type: DispatchBatchCreated })
  createBatch(@Body() dto: CreateDispatchBatchDto, @CurrentActor() actor: Actor) {
    return this.svc.createBatch(dto, actor);
  }

  @Post('dispatch-batches/:id/dispatch')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Dispatch: issues the Job Work Delivery Challan (DB-numbered) and locks the batch' })
  @ApiCreatedResponse({ type: Dispatched })
  dispatch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DispatchBatchDto, @CurrentActor() actor: Actor) {
    return this.svc.dispatch(id, dto, actor);
  }

  @Post('dispatch-batches/:id/proof-of-delivery')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Record customer acknowledgement / POD (starts the 3-month warranty window)' })
  @ApiCreatedResponse({ type: Br08DeliveryAcknowledgementsRow })
  pod(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ProofOfDeliveryDto, @CurrentActor() actor: Actor) {
    return this.svc.recordProofOfDelivery(id, dto, actor);
  }

  @Get('dispatch-batches/:id')
  @ApiOkResponse({ type: DispatchBatchDetail })
  getBatch(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getBatch(id, actor);
  }

  @Get('delivery-challans/:id')
  @ApiOperation({ summary: 'Delivery Challan print payload (consignor/consignee/carrier/lines snapshots)' })
  @ApiOkResponse({ type: Br08DeliveryChallansRow })
  getChallan(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getChallan(id, actor);
  }

  // ---- tax invoice

  @Post('invoices/preview')
  @Roles(Role.FINANCE)
  @ApiOperation({ summary: 'Compute the invoice (lines, GST, totals) without issuing or consuming a number' })
  @ApiCreatedResponse({ type: InvoicePreview })
  preview(@Body() dto: InvoiceRequestDto, @CurrentActor() actor: Actor) {
    return this.svc.previewInvoice(dto, actor);
  }

  @Post('invoices')
  @Roles(Role.FINANCE)
  @ApiOperation({ summary: 'Issue a tax invoice (immutable). Lines = authorised quote; GST from place of supply; D6 gate.' })
  @ApiCreatedResponse({ type: InvoiceDetail })
  issue(@Body() dto: InvoiceRequestDto, @CurrentActor() actor: Actor) {
    return this.svc.issueInvoice(dto, actor);
  }

  @Post('sales-invoices/preview')
  @Roles(Role.FINANCE)
  @ApiOperation({ summary: 'PRODUCT_SALES: compute the invoice for a BR-11 Sales Order (no number consumed). Blocked until the company invoice trigger + PRODUCT_SALE GST rate are configured.' })
  @ApiCreatedResponse({ type: SalesInvoicePreview })
  previewSales(@Body() dto: SalesInvoiceRequestDto, @CurrentActor() actor: Actor) {
    return this.svc.previewSalesInvoice(dto, actor);
  }

  @Post('sales-invoices')
  @Roles(Role.FINANCE)
  @ApiIdempotencyKey()
  @ApiOperation({ summary: 'PRODUCT_SALES: issue a tax invoice on the SAME BR-08 series for a BR-11 Sales Order (no repair Job ID). Idempotent on the key.' })
  @ApiCreatedResponse({ type: InvoiceDetail })
  issueSales(@Body() dto: SalesInvoiceRequestDto, @Headers('idempotency-key') idem: string, @CurrentActor() actor: Actor) {
    return this.svc.issueSalesInvoice(dto, idem, actor);
  }

  @Get('invoices')
  @ApiOkResponse({ type: [Br08InvoicesRow] })
  list(@Query() q: ListInvoicesQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.listInvoices(q, actor);
  }

  @Get('invoices/:id')
  @ApiOkResponse({ type: InvoiceDetail })
  getInvoice(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getInvoice(id, actor);
  }

  @Get('invoices/:id/print')
  @ApiOperation({ summary: 'Print payload: render `document` three times -- ORIGINAL / DUPLICATE / TRIPLICATE' })
  @ApiOkResponse({ type: InvoicePrint })
  print(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.printInvoice(id, actor);
  }

  @Post('invoices/:id/credit-note')
  @Roles(Role.FINANCE)
  @ApiOperation({ summary: 'Raise (and approve) a credit note: cancels the invoice in full, reverses its payments to the receipts' })
  @ApiCreatedResponse({ type: CreditNoteDetail })
  creditNote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreditNoteDto, @CurrentActor() actor: Actor) {
    return this.svc.raiseCreditNote(id, dto, actor);
  }

  @Get('credit-notes/:id')
  @ApiOkResponse({ type: CreditNoteDetail })
  getCreditNote(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getCreditNote(id, actor);
  }

  // ---- payments

  @Post('payments')
  @Roles(Role.FINANCE)
  @ApiOperation({ summary: 'Record a payment receipt and (optionally) allocate it to invoices. Partial payments supported.' })
  @ApiCreatedResponse({ type: ReceiptDetail })
  recordPayment(@Body() dto: RecordPaymentDto, @CurrentActor() actor: Actor) {
    return this.svc.recordPayment(dto, actor);
  }

  @Post('payments/:id/allocations')
  @Roles(Role.FINANCE)
  @ApiOperation({ summary: "Allocate a receipt's unallocated amount to an invoice. Full payment closes the invoice's jobs." })
  @ApiCreatedResponse({ type: ReceiptDetail })
  allocate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AllocatePaymentDto, @CurrentActor() actor: Actor) {
    return this.svc.allocate(id, dto, actor);
  }

  @Get('payments/:id')
  @ApiOkResponse({ type: ReceiptDetail })
  getReceipt(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getReceipt(id, actor);
  }

  // ---- waiver + billing status

  @Post('jobs/:id/waiver')
  @Roles(Role.SALES)
  @ApiOperation({ summary: 'No-charge job closure (Sales). Job must not be on a live invoice.' })
  @ApiCreatedResponse({ type: WaiverResult })
  waive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: WaiverDto, @CurrentActor() actor: Actor) {
    return this.svc.waive(id, dto, actor);
  }

  @Get('jobs/:id/billing')
  @ApiOperation({ summary: 'Job dispatch / challan / POD / invoice / balance / waiver state' })
  @ApiOkResponse({ type: Br08VJobBillingRow })
  billing(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.jobBilling(id, actor);
  }
}
