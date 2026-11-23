import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { Actor } from './purchase-desk.service';
import { MaterialRequestsDeskService } from './material-requests-desk.service';
import { PurchaseMrListQueryDto, PurchaseMrPage } from './dto/material-requests-desk.dto';

/**
 * Purchase material-request inbox ("Requests" pill). See CLAUDE.md §4i "Purchase MR inbox". The existing
 * GET /material-requests (raw rows) is unchanged; the detail panel uses GET /jobs/:id/material-requests.
 */
@ApiTags('BR-03 Custody, Inspection & Material Requests')
@ApiAuth()
@ApiStdErrors()
@Controller('purchase')
@UseGuards(RolesGuard)
export class MaterialRequestsDeskController {
  constructor(private readonly svc: MaterialRequestsDeskService) {}

  @Get('material-requests')
  @Roles(Role.PURCHASE, Role.MANAGEMENT)
  @ApiOperation({
    summary: 'Material request inbox: company MRs with job, customer, engineer, line count and change-request counts',
    description: 'Paginated: `page` (default 1), `page_size` (default 25, max 100) -> { rows, total, page, page_size, '
      + 'counts_by_status }. Filters: `status`, `priority` (comma-separated DB values), `job_id`, `engineer_id` '
      + '(responsible engineer), `search` (request number, job number, engineer name, customer name). '
      + '`counts_by_status` covers company + `search` only. DRAFT requests are included. No lines, prices, offers or '
      + 'supplier data.',
  })
  @ApiOkResponse({ type: PurchaseMrPage })
  list(@Query() q: PurchaseMrListQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.list(q, actor);
  }
}
