import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { Actor } from './purchase-desk.service';
import { SalesSupplyDeskService } from './sales-supply-desk.service';
import {
  SupplyEnquiryPage, SupplyEnquiryQueryDto, SupplyOrderPage, SupplyOrderQueryDto, SupplyOutwardPage, SupplyOutwardQueryDto,
  SupplyQuotePage, SupplyQuoteQueryDto,
} from './dto/sales-supply-desk.dto';

/** Roles that work the BR-11 product-sales flow (Management views). Supplier cost is never in these responses. */
const DESK = [Role.SALES, Role.PURCHASE, Role.FINANCE, Role.MANAGEMENT] as const;
const PAGED = 'Paginated: `page` (default 1), `page_size` (default 25, max 100). Company from the token. ';

/**
 * BR-11 Sales & Supply desk reads (G-SS1..4). See CLAUDE.md §4h "Sales & Supply desk reads". Additive: the existing
 * GET /sales-enquiries and GET /sales-orders (raw rows) are unchanged.
 */
@ApiTags('Sales & Supply desk')
@ApiAuth()
@ApiStdErrors()
@Controller('sales-supply')
@UseGuards(RolesGuard)
export class SalesSupplyDeskController {
  constructor(private readonly svc: SalesSupplyDeskService) {}

  @Get('enquiries')
  @Roles(...DESK)
  @ApiOperation({
    summary: 'Enquiry list (G-SS1): SE- enquiries with customer name, line / quote counts, latest quote',
    description: `${PAGED}Filters: \`status\` (csv), \`search\` (enquiry no., customer name / code, details). Newest first.`,
  })
  @ApiOkResponse({ type: SupplyEnquiryPage })
  enquiries(@Query() q: SupplyEnquiryQueryDto, @CurrentActor() a: Actor) { return this.svc.enquiries(q, a); }

  @Get('quotes')
  @Roles(...DESK)
  @ApiOperation({
    summary: 'Quotation worklist (G-SS2): SQ- quotes by derived stage (TO_PRICE / ISSUED / WITH_CUSTOMER / ...) with latest-revision total',
    description: `${PAGED}Filters: \`stage\` (csv), \`search\` (quote no., customer name / code, enquiry no.). Most recent activity first.`,
  })
  @ApiOkResponse({ type: SupplyQuotePage })
  quotes(@Query() q: SupplyQuoteQueryDto, @CurrentActor() a: Actor) { return this.svc.quotes(q, a); }

  @Get('orders')
  @Roles(...DESK)
  @ApiOperation({
    summary: 'Sales Order list (G-SS3): customer, order total, line pipeline counts, pending authorisations / changes, advance state',
    description: `${PAGED}Filters: \`status\` (csv), \`search\` (SO no., customer name / code, quote no., customer order ref). Newest first.`,
  })
  @ApiOkResponse({ type: SupplyOrderPage })
  orders(@Query() q: SupplyOrderQueryDto, @CurrentActor() a: Actor) { return this.svc.orders(q, a); }

  @Get('outwards')
  @Roles(...DESK)
  @ApiOperation({
    summary: 'Outward list (G-SS4): SOUT- outwards with customer, line pick / packing-evidence / delivery counts, latest tracking, orders',
    description: `${PAGED}Filters: \`status\` (csv), \`search\` (SOUT no., customer name / code, tracking ref, SO no.). Newest first.`,
  })
  @ApiOkResponse({ type: SupplyOutwardPage })
  outwards(@Query() q: SupplyOutwardQueryDto, @CurrentActor() a: Actor) { return this.svc.outwards(q, a); }
}
