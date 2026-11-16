import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { Actor } from './purchase-desk.service';
import { SalesQuotesService } from './sales-quotes.service';
import { SalesQuoteListPage, SalesQuoteListQueryDto } from './dto/sales-quotes.dto';

/** Sales desk reads (G-S1). See CLAUDE.md §4i "Sales desk reads". */
@ApiTags('Sales desk')
@ApiAuth()
@ApiStdErrors()
@Controller('sales')
@UseGuards(RolesGuard)
export class SalesDeskController {
  constructor(private readonly svc: SalesQuotesService) {}

  @Get('quotes')
  @Roles(Role.SALES)
  @ApiOperation({
    summary: 'Sales quote worklist (G-S1): quotes whose LATEST revision was released to the caller',
    description: 'Paginated: `page` (default 1), `page_size` (default 25, max 100) -> { rows, total, page, page_size, '
      + 'counts_by_stage }. Filters: `stage` (comma-separated derived SalesStage), `valid_until_before` (YYYY-MM-DD, strict), '
      + '`search` (quote number, job number, customer name/code, serial, make, model). Company and assignee come from the '
      + 'token. A quote re-revised to DRAFT by Purchase drops out until it is released again. Customer-facing fields only.',
  })
  @ApiOkResponse({ type: SalesQuoteListPage })
  list(@Query() q: SalesQuoteListQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.list(q, actor);
  }
}
