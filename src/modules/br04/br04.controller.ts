import { Body, Controller, Get, Param, Post, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Br04CustomerQuoteRevisionsRow, Br04CustomerQuotesRow, Br04RfqSupplierInvitesRow, Br04RfqsRow,
  Br04ShortageSourcesRow, Br04SupplierOfferLinesRow,
} from '../../common/swagger/rows.generated';
import {
  OfferRecorded, QuoteDetail, QuoteWithRevision, RfqDetail, RfqWithLines, StockCheckWithLines,
} from './dto/br04.responses';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { Br04Service } from './br04.service';
import {
  CreateQuoteDto, CreateRfqDto, MarkOfferValidityDto, RecordOfferDto, ReleaseToSalesDto, ReviseQuoteDto,
  StockCheckDto, SupplierInviteDto,
} from './dto/br04.dto';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';

interface Actor { id: string; role: string; companyId: string }

@ApiTags('BR-04 Stock Check, RFQ & Quotes')
@ApiAuth()
@ApiStdErrors()
@Controller()
@UseGuards(RolesGuard)
export class Br04Controller {
  constructor(private readonly svc: Br04Service) {}

  // stock check (snapshot only, never posts to inventory)

  @ApiCreatedResponse({ type: StockCheckWithLines })
  @Post('jobs/:id/stock-checks')
  @Roles(Role.PURCHASE)
  stockCheck(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StockCheckDto, @CurrentActor() actor: Actor) {
    return this.svc.stockCheck(id, dto, actor);
  }

  @Get('jobs/:id/stock-checks')
  @ApiOperation({ summary: "Stock-check snapshots with lines, newest first" })
  @ApiOkResponse({ type: [StockCheckWithLines] })
  @Roles(Role.PURCHASE)
  getStockChecks(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getStockChecks(id, actor);
  }

  @Get('jobs/:id/shortages')
  @ApiOperation({ summary: "Shortage sources for the job, newest first" })
  @ApiOkResponse({ type: [Br04ShortageSourcesRow] })
  @Roles(Role.PURCHASE)
  getShortages(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getShortages(id, actor);
  }

  // RFQ (per job, no cross-job grouping)

  @ApiCreatedResponse({ type: RfqWithLines })
  @Post('jobs/:id/rfqs')
  @Roles(Role.PURCHASE)
  createRfq(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateRfqDto, @CurrentActor() actor: Actor) {
    return this.svc.createRfq(id, dto, actor);
  }

  @Get('jobs/:id/rfqs')
  @ApiOperation({ summary: "RFQs linked to the job (headers only), newest first" })
  @ApiOkResponse({ type: [Br04RfqsRow] })
  @Roles(Role.PURCHASE)
  getRfqs(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getRfqs(id, actor);
  }

  @Get('rfqs/:id')
  @ApiOperation({ summary: "RFQ detail: lines, supplier invites, offers with lines" })
  @ApiOkResponse({ type: RfqDetail })
  @Roles(Role.PURCHASE)
  getRfq(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getRfq(id, actor);
  }

  @ApiCreatedResponse({ type: Br04RfqSupplierInvitesRow })
  @Post('rfqs/:id/supplier-invites')
  @Roles(Role.PURCHASE)
  addSupplierInvite(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SupplierInviteDto, @CurrentActor() actor: Actor) {
    return this.svc.addSupplierInvite(id, dto, actor);
  }

  @ApiCreatedResponse({ type: OfferRecorded })
  @Post('rfqs/:id/offers')
  @Roles(Role.PURCHASE)
  recordOffer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordOfferDto, @CurrentActor() actor: Actor) {
    return this.svc.recordOffer(id, dto, actor);
  }

  @ApiCreatedResponse({ type: Br04SupplierOfferLinesRow })
  @Post('offer-lines/:id/mark-validity')
  @Roles(Role.PURCHASE)
  markOfferValidity(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkOfferValidityDto, @CurrentActor() actor: Actor) {
    return this.svc.markOfferValidity(id, dto, actor);
  }

  // customer quotation

  @ApiCreatedResponse({ type: QuoteWithRevision })
  @Post('jobs/:id/quotes')
  @Roles(Role.PURCHASE)
  createQuote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateQuoteDto, @CurrentActor() actor: Actor) {
    return this.svc.createQuote(id, dto, actor);
  }

  @Get('jobs/:id/quotes')
  @ApiOperation({ summary: "Customer quotes for the job (headers only), newest first" })
  @ApiOkResponse({ type: [Br04CustomerQuotesRow] })
  getQuotes(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getQuotes(id, actor);
  }

  @Get('quotes/:id')
  @ApiOperation({ summary: "Customer quote with all revisions and lines" })
  @ApiOkResponse({ type: QuoteDetail })
  getQuote(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getQuote(id, actor);
  }

  @ApiCreatedResponse({ type: QuoteWithRevision })
  @Post('quotes/:id/revise')
  @Roles(Role.PURCHASE)
  reviseQuote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviseQuoteDto, @CurrentActor() actor: Actor) {
    return this.svc.reviseQuote(id, dto, actor);
  }

  @ApiCreatedResponse({ type: Br04CustomerQuoteRevisionsRow })
  @Post('quotes/:id/release-to-sales')
  @Roles(Role.PURCHASE)
  releaseToSales(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReleaseToSalesDto, @CurrentActor() actor: Actor) {
    return this.svc.releaseToSales(id, dto, actor);
  }

  @ApiCreatedResponse({ type: Br04CustomerQuoteRevisionsRow })
  @Post('quotes/:id/send')
  @Roles(Role.SALES)
  sendQuote(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.sendQuote(id, actor);
  }
}
