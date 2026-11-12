import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Br11CarrierTrackingEventsRow, Br11CustomerQuoteResponsesRow, Br11DeliveryEvidenceRow, Br11InventoryReservationRequestsRow,
  Br11OrderAuthorisationEventsRow, Br11OrderPaymentConditionsRow, Br11OutwardLinesRow, Br11PackingEvidenceRow,
  Br11QuoteDispatchEventsRow, Br11QuoteLinesRow, Br11SalesChangeRequestsRow, Br11SalesEnquiriesRow, Br11SalesOrdersRow,
} from '../../common/swagger/rows.generated';
import { ApiAuth, ApiIdempotencyKey, ApiStdErrors } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { Br11Service } from './br11.service';
import {
  ChangeRequestDto, CloseOrderDto, ConfirmAdvanceDto, CreateEnquiryDto, CreateOutwardDto, CreateRevisionDto,
  CreateSalesOrderDto, CreateSalesQuoteDto, DecideChangeRequestDto, DeliveryEvidenceDto, DispatchOutwardDto,
  ListQueryDto, OrderAuthorisationDto, PackingEvidenceDto, PaymentTermsDto, PickDto, QuoteDispatchDto, QuoteLineDto,
  QuoteResponseDto, ReasonDto, ReserveDto, SalesPolicyDto, TrackingEventDto, VerifyOrderDto,
} from './dto/br11.dto';
import {
  ChangeDecisionResult, EnquiryDetail, OutwardDetail, ReservationResult, SalesConfigResponse, SalesOrderDetail,
  SalesQuoteDetail,
} from './dto/br11.responses';

interface Actor { id: string; role: string; companyId: string }

/**
 * BR-11 Sales & Supply. Role split (BR-11 Rev01 accepted recommendations; enforced
 * here AND by DB triggers):
 *   SALES        -> enquiry, quote dispatch to customer + customer responses (11A-01/09),
 *                   draft Sales Order + customer authorisation evidence, change requests
 *   PURCHASE     -> priced quote revisions (create/issue), Sales Order verification (11B-01),
 *                   order payment terms, reservations, outward/pick/dispatch/POD,
 *                   change-request decisions (11B-10), closure (11C-09 proposal)
 *   FINANCE      -> confirms an advance against a BR-08 receipt; invoices via /sales-invoices (BR-08)
 *   SYSTEM_ADMIN -> CLIENT-UNCONFIRMED company policy (invoice trigger, payment-before-closure)
 * Supplier sourcing / SALES_ORDER POs are BR-06 routes (Purchase only: supplier cost).
 * Reads: any authenticated user of the same company; no BR-11 read carries supplier cost.
 */
@ApiTags('BR-11 Sales & Supply (product sales)')
@ApiAuth()
@ApiStdErrors()
@Controller()
@UseGuards(RolesGuard)
export class Br11Controller {
  constructor(private readonly svc: Br11Service) {}

  // ---- config (CLIENT-UNCONFIRMED)

  @Get('sales-config')
  @ApiOperation({ summary: 'Company BR-11 policy + product GST rate and what is currently BLOCKED' })
  @ApiOkResponse({ type: SalesConfigResponse })
  getConfig(@CurrentActor() a: Actor) { return this.svc.getConfig(a); }

  @Put('sales-config/policy')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiOperation({ summary: 'Set the CLIENT-UNCONFIRMED invoice trigger (11C-07) / payment-before-closure (11C-09). null = blocked.' })
  @ApiOkResponse({ type: SalesConfigResponse })
  setPolicy(@Body() dto: SalesPolicyDto, @CurrentActor() a: Actor) { return this.svc.setPolicy(dto, a); }

  // ---- 11A enquiry

  @Post('sales-enquiries')
  @Roles(Role.SALES)
  @ApiOperation({ summary: 'Register a product-sales enquiry (DB-numbered SE-<CODE>-000001)' })
  @ApiCreatedResponse({ type: EnquiryDetail })
  createEnquiry(@Body() dto: CreateEnquiryDto, @CurrentActor() a: Actor) { return this.svc.createEnquiry(dto, a); }

  @Get('sales-enquiries')
  @ApiOkResponse({ type: [Br11SalesEnquiriesRow] })
  listEnquiries(@Query() q: ListQueryDto, @CurrentActor() a: Actor) { return this.svc.listEnquiries(q, a); }

  @Get('sales-enquiries/:id')
  @ApiOkResponse({ type: EnquiryDetail })
  getEnquiry(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.getEnquiry(id, a); }

  @Post('sales-enquiries/:id/cancel')
  @Roles(Role.SALES)
  @ApiCreatedResponse({ type: EnquiryDetail })
  cancelEnquiry(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentActor() a: Actor) {
    return this.svc.cancelEnquiry(id, dto, a);
  }

  // ---- 11A quotation

  @Post('sales-quotes')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Create a sales quotation (SQ-<CODE>-000001) with DRAFT revision 0 from an enquiry' })
  @ApiCreatedResponse({ type: SalesQuoteDetail })
  createQuote(@Body() dto: CreateSalesQuoteDto, @CurrentActor() a: Actor) { return this.svc.createQuote(dto, a); }

  @Get('sales-quotes/:id')
  @ApiOperation({ summary: 'Quote with every revision, lines (+ indicative ledger availability), sends and customer responses' })
  @ApiOkResponse({ type: SalesQuoteDetail })
  getQuote(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.getQuote(id, a); }

  @Post('sales-quotes/:id/revisions')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'New DRAFT revision (reason required). Issued revisions stay immutable.' })
  @ApiCreatedResponse({ type: SalesQuoteDetail })
  createRevision(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateRevisionDto, @CurrentActor() a: Actor) {
    return this.svc.createRevision(id, dto, a);
  }

  @Post('sales-quote-revisions/:id/lines')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Add a priced product line (Item Master item; DRAFT revisions only)' })
  @ApiCreatedResponse({ type: Br11QuoteLinesRow })
  addQuoteLine(@Param('id', ParseUUIDPipe) id: string, @Body() dto: QuoteLineDto, @CurrentActor() a: Actor) {
    return this.svc.addQuoteLine(id, dto, a);
  }

  @Post('sales-quote-revisions/:id/issue')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Release the revision: customer APPROVED (11A-03) + every item APPROVED/ACTIVE (11A-04); then immutable' })
  @ApiCreatedResponse({ type: SalesQuoteDetail })
  issueRevision(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.setRevisionStatus(id, 'ISSUED', a); }

  @Post('sales-quote-revisions/:id/cancel')
  @Roles(Role.PURCHASE)
  @ApiCreatedResponse({ type: SalesQuoteDetail })
  cancelRevision(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.setRevisionStatus(id, 'CANCELLED', a); }

  @Post('sales-quote-revisions/:id/dispatch')
  @Roles(Role.SALES)
  @ApiOperation({ summary: 'Sales sends the issued quotation through a tracked channel' })
  @ApiCreatedResponse({ type: Br11QuoteDispatchEventsRow })
  quoteDispatch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: QuoteDispatchDto, @CurrentActor() a: Actor) {
    return this.svc.quoteDispatch(id, dto, a);
  }

  @Post('sales-quote-revisions/:id/responses')
  @Roles(Role.SALES)
  @ApiCreatedResponse({ type: Br11CustomerQuoteResponsesRow })
  quoteResponse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: QuoteResponseDto, @CurrentActor() a: Actor) {
    return this.svc.quoteResponse(id, dto, a);
  }

  // ---- 11B Sales Order

  @Post('sales-orders')
  @Roles(Role.SALES, Role.PURCHASE)
  @ApiOperation({ summary: 'Draft a Sales Order from accepted lines/qty of the current issued revision (prices snapshotted by the DB)' })
  @ApiCreatedResponse({ type: SalesOrderDetail })
  createOrder(@Body() dto: CreateSalesOrderDto, @CurrentActor() a: Actor) { return this.svc.createOrder(dto, a); }

  @Get('sales-orders')
  @ApiOkResponse({ type: [Br11SalesOrdersRow] })
  listOrders(@Query() q: ListQueryDto, @CurrentActor() a: Actor) { return this.svc.listOrders(q, a); }

  @Get('sales-orders/:id')
  @ApiOkResponse({ type: SalesOrderDetail })
  getOrder(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.getOrder(id, a); }

  @Post('sales-orders/:id/authorisations')
  @Roles(Role.SALES, Role.PURCHASE)
  @ApiOperation({ summary: 'Attach customer PO / order confirmation / qualifying email evidence (PENDING)' })
  @ApiCreatedResponse({ type: Br11OrderAuthorisationEventsRow })
  addAuthorisation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderAuthorisationDto, @CurrentActor() a: Actor) {
    return this.svc.addAuthorisation(id, dto, a);
  }

  @Post('sales-orders/:id/verify')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Purchase verifies the evidence against the quote + customer; assigns SO-<CODE>-000001' })
  @ApiCreatedResponse({ type: SalesOrderDetail })
  verifyOrder(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyOrderDto, @CurrentActor() a: Actor) {
    return this.svc.verifyOrder(id, dto, a);
  }

  @Post('sales-orders/:id/cancel')
  @Roles(Role.SALES, Role.PURCHASE)
  @ApiOperation({ summary: 'Cancel a DRAFT order (a verified order needs an approved CANCELLATION change request)' })
  @ApiCreatedResponse({ type: SalesOrderDetail })
  cancelOrder(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.cancelDraftOrder(id, a); }

  @Post('sales-orders/:id/payment-terms')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: '11B-02 hook: record THIS order\'s accepted advance terms (no blanket rule). Required before reservation / sourcing.' })
  @ApiCreatedResponse({ type: Br11OrderPaymentConditionsRow })
  paymentTerms(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentTermsDto, @CurrentActor() a: Actor) {
    return this.svc.recordPaymentTerms(id, dto, a);
  }

  @Post('sales-orders/:id/payment-terms/confirm-advance')
  @Roles(Role.FINANCE)
  @ApiOperation({ summary: 'Finance confirms the required advance against a BR-08 payment receipt of the same customer' })
  @ApiCreatedResponse({ type: Br11OrderPaymentConditionsRow })
  confirmAdvance(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmAdvanceDto, @CurrentActor() a: Actor) {
    return this.svc.confirmAdvance(id, dto, a);
  }

  // ---- 11B reservation (real inventory ledger)

  @Post('sales-order-lines/:id/reservations')
  @Roles(Role.PURCHASE)
  @ApiIdempotencyKey()
  @ApiOperation({ summary: 'Request + ledger-confirm a stock reservation (fdn_reserve; MAIN_STORE allocatable only, 11B-04/05)' })
  @ApiCreatedResponse({ type: ReservationResult })
  reserve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReserveDto, @Headers('idempotency-key') k: string, @CurrentActor() a: Actor) {
    return this.svc.reserve(id, dto, k, a);
  }

  @Post('sales-reservations/:id/release')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Release a CONFIRMED reservation that is not on an outward line (ledger reservation RELEASED)' })
  @ApiCreatedResponse({ type: Br11InventoryReservationRequestsRow })
  release(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.releaseReservation(id, a); }

  // ---- 11C outward / delivery

  @Post('sales-outwards')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'DRAFT product outward for one customer; each line ships one whole CONFIRMED reservation' })
  @ApiCreatedResponse({ type: OutwardDetail })
  createOutward(@Body() dto: CreateOutwardDto, @CurrentActor() a: Actor) { return this.svc.createOutward(dto, a); }

  @Get('sales-outwards/:id')
  @ApiOkResponse({ type: OutwardDetail })
  getOutward(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.getOutward(id, a); }

  @Post('sales-outward-lines/:id/packing-evidence')
  @Roles(Role.PURCHASE)
  @ApiCreatedResponse({ type: Br11PackingEvidenceRow })
  packing(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PackingEvidenceDto, @CurrentActor() a: Actor) {
    return this.svc.addPackingEvidence(id, dto, a);
  }

  @Post('sales-outward-lines/:id/pick')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Confirm item/part/qty verification (serial numbers for serial-tracked items, 11C-02)' })
  @ApiCreatedResponse({ type: Br11OutwardLinesRow })
  pick(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PickDto, @CurrentActor() a: Actor) { return this.svc.pick(id, dto, a); }

  @Post('sales-outwards/:id/dispatch')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Physical outward: ledger ISSUE out of MAIN_STORE per line, reservation consumed, SOUT-<CODE>-000001 assigned' })
  @ApiCreatedResponse({ type: OutwardDetail })
  dispatch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DispatchOutwardDto, @CurrentActor() a: Actor) {
    return this.svc.dispatchOutward(id, dto, a);
  }

  @Post('sales-outwards/:id/cancel')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Cancel a DRAFT outward (only before any ledger issue)' })
  @ApiCreatedResponse({ type: OutwardDetail })
  cancelOutward(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.cancelOutward(id, a); }

  @Post('sales-outwards/:id/tracking-events')
  @Roles(Role.PURCHASE)
  @ApiCreatedResponse({ type: Br11CarrierTrackingEventsRow })
  tracking(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TrackingEventDto, @CurrentActor() a: Actor) {
    return this.svc.addTracking(id, dto, a);
  }

  @Post('sales-outward-lines/:id/delivery')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Line-specific POD (DELIVERED) or a FAILED/DAMAGED record; order/line status is derived by the DB' })
  @ApiCreatedResponse({ type: Br11DeliveryEvidenceRow })
  delivery(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliveryEvidenceDto, @CurrentActor() a: Actor) {
    return this.svc.recordDelivery(id, dto, a);
  }

  // ---- change requests + closure

  @Post('sales-orders/:id/change-requests')
  @Roles(Role.SALES, Role.PURCHASE)
  @ApiCreatedResponse({ type: Br11SalesChangeRequestsRow })
  raiseChange(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeRequestDto, @CurrentActor() a: Actor) {
    return this.svc.raiseChange(id, dto, a);
  }

  @Post('sales-change-requests/:id/decide')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Purchase decides. Only APPROVED CANCELLATION changes data (line/order cancelled, if nothing shipped/invoiced/reserved/on a PO).' })
  @ApiCreatedResponse({ type: ChangeDecisionResult })
  decideChange(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideChangeRequestDto, @CurrentActor() a: Actor) {
    return this.svc.decideChange(id, dto, a);
  }

  @Post('sales-orders/:id/close')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Closure review (11C-09): DB verifies POD-delivered = invoiced = ordered, live BR-08 invoice, and payment if policy requires' })
  @ApiCreatedResponse({ type: SalesOrderDetail })
  close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseOrderDto, @CurrentActor() a: Actor) { return this.svc.closeOrder(id, dto, a); }
}
