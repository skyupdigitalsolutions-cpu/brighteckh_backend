import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { Actor } from './purchase-desk.service';
import { PurchaseOrdersDeskService } from './purchase-orders-desk.service';
import { PurchasePoListQueryDto, PurchasePoPage } from './dto/purchase-orders-desk.dto';

/**
 * Supplier PO register for the Purchase "Orders" pill. See CLAUDE.md §4i "Purchase PO register". PURCHASE only, same as
 * GET /purchase-orders/:id (product owner, 23 Nov 2026: Management does not get the PO list yet).
 */
@ApiTags('BR-06 Supplier PO & GRN')
@ApiAuth()
@ApiStdErrors()
@Controller('purchase-orders')
@UseGuards(RolesGuard)
export class PurchaseOrdersDeskController {
  constructor(private readonly svc: PurchaseOrdersDeskService) {}

  @Get()
  @Roles(Role.PURCHASE)
  @ApiOperation({
    summary: 'Supplier PO register: company POs (repair + sales order) with job/SO, customer, value, ack, shipment, GRNs',
    description: 'Paginated: `page` (default 1), `page_size` (default 25, max 100) -> { rows, total, page, page_size, '
      + 'counts_by_status }. Filters: `status`, `purpose` (comma-separated DB values), `job_id`, `sales_order_id`, '
      + '`supplier_id`, `search` (PO number, supplier, job number, sales order number, ack supplier reference, shipment '
      + 'AWB/LR). `counts_by_status` covers company + `search` only. Newest first. No offer / sourcing / sell-price data.',
  })
  @ApiOkResponse({ type: PurchasePoPage })
  list(@Query() q: PurchasePoListQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.list(q, actor);
  }
}
