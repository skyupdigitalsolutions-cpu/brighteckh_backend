import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { Actor } from './purchase-desk.service';
import { StoresDeskService } from './stores-desk.service';
import {
  ReceivablePoPage, ReceivablePoQueryDto, StoresGrnDetail, StoresGrnListQueryDto, StoresGrnPage, StoresPoDetail,
} from './dto/stores-desk.dto';

/**
 * Stores / Quality desk reads (G-ST1..4). See CLAUDE.md §4i "Stores desk reads". The BR-06 writes Stores already has
 * (POST /purchase-orders/:id/grns, /grn-lines/:id/media, /grn-lines/:id/post) need a PO's line ids, which the
 * PURCHASE-only PO reads never gave Stores. Quantities only: no price / currency / payment terms.
 */
@ApiTags('Stores desk')
@ApiAuth()
@ApiStdErrors()
@Controller('stores')
@UseGuards(RolesGuard)
export class StoresDeskController {
  constructor(private readonly svc: StoresDeskService) {}

  @Get('receivable-pos')
  @Roles(Role.STORES_QUALITY)
  @ApiOperation({
    summary: 'POs to receive (G-ST1): RELEASED / ACKNOWLEDGED / SHIPPED supplier POs with ack + latest shipment',
    description: 'Paginated: `page`, `page_size` (max 100) -> { rows, total, page, page_size, counts_by_status }. Filters: '
      + '`status` (comma-separated), `search` (PO no., supplier, job no., sales order no.). `can_receive` = a GRN can be '
      + 'created now (ACKNOWLEDGED / SHIPPED). Quantities only.',
  })
  @ApiOkResponse({ type: ReceivablePoPage })
  receivablePos(@Query() q: ReceivablePoQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.receivablePos(q, actor);
  }

  @Get('purchase-orders/:id')
  @Roles(Role.STORES_QUALITY)
  @ApiOperation({
    summary: 'PO for receiving (G-ST2): header, lines with item code/name + received/outstanding qty, GRNs. No prices',
  })
  @ApiOkResponse({ type: StoresPoDetail })
  purchaseOrder(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.purchaseOrder(id, actor);
  }

  @Get('grns')
  @Roles(Role.STORES_QUALITY)
  @ApiOperation({
    summary: 'GRN register (G-ST3): company GRNs with PO, supplier, line counts and derived grn_status',
    description: 'Paginated -> { rows, total, page, page_size, counts_by_status }. Filters: `status` (OPEN / PARTIAL / POSTED, '
      + 'comma-separated), `search` (GRN no., PO no., supplier, job no., sales order no.). Newest received first.',
  })
  @ApiOkResponse({ type: StoresGrnPage })
  grns(@Query() q: StoresGrnListQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.grns(q, actor);
  }

  @Get('grns/:id')
  @Roles(Role.STORES_QUALITY)
  @ApiOperation({
    summary: 'GRN for inspection (G-ST4): lines with item code/name, photos, posted-by and the resulting ledger movements',
  })
  @ApiOkResponse({ type: StoresGrnDetail })
  grn(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.grn(id, actor);
  }
}
