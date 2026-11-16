import { Body, Controller, Get, Param, Post, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Br05CustomerOrdersRow, Br05JobAuthorisationsRow, Br05JobReleasesRow,
  Br05MaterialReservationsRow, Br05OrderJobAllocationsRow,
} from '../../common/swagger/rows.generated';
import {
  OrderAllocation, QuoteResponseEvent, QuoteResponseRecorded, ReservationCommitted, StockRecheckWithLines,
} from './dto/br05.responses';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { Br05Service } from './br05.service';
import {
  AuthoriseJobDto, CreateOrderAllocationDto, CustomerAuthorityDto, RepairQuoteResponseDto, ReleaseJobDto,
  ReserveMaterialDto, StockRecheckDto, VerifyCustomerAuthorityDto,
} from './dto/br05.dto';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';

interface Actor { id: string; role: string; companyId: string }

@ApiTags('BR-05 Customer Authority, Authorisation & Reservations')
@ApiAuth()
@ApiStdErrors()
@Controller()
@UseGuards(RolesGuard)
export class Br05Controller {
  constructor(private readonly svc: Br05Service) {}

  // customer quote response

  @ApiCreatedResponse({ type: QuoteResponseRecorded })
  @Post('jobs/:id/quote-responses')
  @Roles(Role.SALES)
  recordQuoteResponse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RepairQuoteResponseDto, @CurrentActor() actor: Actor) {
    return this.svc.recordQuoteResponse(id, dto, actor);
  }

  @Get('jobs/:id/quote-responses')
  @ApiOperation({ summary: "Customer quote responses, newest first (+ the BR-04 quote revision each one refers to)" })
  @ApiOkResponse({ type: [QuoteResponseEvent] })
  getQuoteResponses(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getQuoteResponses(id, actor);
  }

  // customer authority (PO / Job Order / verified email -- all first-class)

  @ApiCreatedResponse({ type: Br05CustomerOrdersRow })
  @Post('jobs/:id/customer-authority')
  @Roles(Role.PURCHASE)
  createCustomerAuthority(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CustomerAuthorityDto, @CurrentActor() actor: Actor) {
    return this.svc.createCustomerAuthority(id, dto, actor);
  }

  @Get('jobs/:id/customer-authority')
  @ApiOperation({ summary: "Customer authorities (PO / Job Order / email) for the job's customer" })
  @ApiOkResponse({ type: [Br05CustomerOrdersRow] })
  @Roles(Role.PURCHASE)
  getCustomerAuthority(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getCustomerAuthority(id, actor);
  }

  @ApiCreatedResponse({ type: Br05CustomerOrdersRow })
  @Post('customer-authority/:id/verify')
  @Roles(Role.PURCHASE)
  verifyCustomerAuthority(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyCustomerAuthorityDto, @CurrentActor() actor: Actor) {
    return this.svc.verifyCustomerAuthority(id, dto, actor);
  }

  // order-job allocation

  @ApiCreatedResponse({ type: Br05OrderJobAllocationsRow })
  @Post('jobs/:id/order-allocations')
  @Roles(Role.PURCHASE)
  createOrderAllocation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateOrderAllocationDto, @CurrentActor() actor: Actor) {
    return this.svc.createOrderAllocation(id, dto, actor);
  }

  @Get('jobs/:id/order-allocations')
  @ApiOperation({ summary: "Order-to-job allocations, newest first (+ the BR-04 quote revision each one is against)" })
  @ApiOkResponse({ type: [OrderAllocation] })
  @Roles(Role.PURCHASE)
  getOrderAllocations(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getOrderAllocations(id, actor);
  }

  @ApiCreatedResponse({ type: Br05OrderJobAllocationsRow })
  @Post('order-allocations/:id/verify')
  @Roles(Role.PURCHASE)
  verifyOrderAllocation(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.verifyOrderAllocation(id, actor);
  }

  // job authorisation

  @ApiCreatedResponse({ type: Br05JobAuthorisationsRow })
  @Post('jobs/:id/authorisations')
  @Roles(Role.PURCHASE)
  authoriseJob(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AuthoriseJobDto, @CurrentActor() actor: Actor) {
    return this.svc.authoriseJob(id, dto, actor);
  }

  @Get('jobs/:id/authorisations')
  @ApiOperation({ summary: "Job authorisations, newest first" })
  @ApiOkResponse({ type: [Br05JobAuthorisationsRow] })
  @Roles(Role.PURCHASE)
  getAuthorisations(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getAuthorisations(id, actor);
  }

  // post-authorisation stock recheck

  @ApiCreatedResponse({ type: StockRecheckWithLines })
  @Post('jobs/:id/stock-rechecks')
  @Roles(Role.PURCHASE)
  stockRecheck(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StockRecheckDto, @CurrentActor() actor: Actor) {
    return this.svc.stockRecheck(id, dto, actor);
  }

  @Get('jobs/:id/stock-rechecks')
  @ApiOperation({ summary: "Post-authorisation stock rechecks with lines" })
  @ApiOkResponse({ type: [StockRecheckWithLines] })
  @Roles(Role.PURCHASE)
  getStockRechecks(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getStockRechecks(id, actor);
  }

  // job release

  @ApiCreatedResponse({ type: Br05JobReleasesRow })
  @Post('jobs/:id/release')
  @Roles(Role.PURCHASE)
  releaseJob(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReleaseJobDto, @CurrentActor() actor: Actor) {
    return this.svc.releaseJob(id, dto, actor);
  }

  @Get('jobs/:id/release')
  @ApiOperation({ summary: "Job releases, newest first" })
  @ApiOkResponse({ type: [Br05JobReleasesRow] })
  @Roles(Role.PURCHASE)
  getRelease(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getRelease(id, actor);
  }

  // material reservation INTENT (-> real inventory ledger)

  @ApiCreatedResponse({ type: ReservationCommitted })
  @Post('jobs/:id/reservations')
  @Roles(Role.PURCHASE)
  reserveMaterial(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReserveMaterialDto, @CurrentActor() actor: Actor) {
    return this.svc.reserveMaterial(id, dto, actor);
  }

  @Get('jobs/:id/reservations')
  @ApiOperation({ summary: "Material reservations, newest first" })
  @ApiOkResponse({ type: [Br05MaterialReservationsRow] })
  @Roles(Role.PURCHASE)
  getReservations(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getReservations(id, actor);
  }
}
