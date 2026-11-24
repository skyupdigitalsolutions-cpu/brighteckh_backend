import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { Actor } from './purchase-desk.service';
import { StockDeskService } from './stock-desk.service';
import {
  StockAssembliesPage, StockAssembliesQueryDto, StockAssemblyDetail, StockAssemblyDetailQueryDto, StockItemDetail,
  StockItemsPage, StockItemsQueryDto, StockJournalPage, StockJournalQueryDto,
} from './dto/stock-desk.dto';

/**
 * Purchase "Stock" pill reads: ledger journal, item master, assembly master + BOM. See CLAUDE.md §4i "Purchase Stock desk".
 * PURCHASE only, read-only (product owner 23 Nov 2026). Availability uses the existing GET /inventory/availability.
 */
@ApiTags('Stock desk')
@ApiAuth()
@ApiStdErrors()
@Controller('stock')
@UseGuards(RolesGuard)
@Roles(Role.PURCHASE)
export class StockDeskController {
  constructor(private readonly svc: StockDeskService) {}

  @Get('journal')
  @ApiOperation({
    summary: 'Ledger journal for the company: item, locations, reference resolved to its GRN / job / SOUT number, actor',
    description: 'Paginated (`page`, `page_size` <= 100) -> { rows, total, page, page_size, counts_by_movement_type }. Filters: '
      + '`movement_type`, `reference_kind`, `location_role` (from OR to) as comma-separated DB values, `reference_id`, `item_id`, '
      + '`from` / `to` (YYYY-MM-DD, company timezone, inclusive), `search` (item code / name, GRN / PO / job / SOUT / SO number, '
      + 'actor name). Counts cover company + `search` only. Newest first. Never returns idempotency keys.',
  })
  @ApiOkResponse({ type: StockJournalPage })
  journal(@Query() q: StockJournalQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.journal(q, actor);
  }

  @Get('items')
  @ApiOperation({
    summary: 'Item Master register (all statuses) with creator / approver names and BOM usage',
    description: 'Paginated -> { rows, total, page, page_size, counts_by_status, counts_by_record_type }. Filters: `status`, '
      + '`record_type`, `stock_flag` (comma-separated), `search` (item code, standard name, short description). Counts cover '
      + '`search` only. Ordered by item_code.',
  })
  @ApiOkResponse({ type: StockItemsPage })
  items(@Query() q: StockItemsQueryDto) {
    return this.svc.items(q);
  }

  @Get('items/:id')
  @ApiOperation({ summary: 'Item Master row + assemblies whose latest BOM revision uses it + the company\'s availability' })
  @ApiOkResponse({ type: StockItemDetail })
  item(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.item(id, actor);
  }

  @Get('assemblies')
  @ApiOperation({
    summary: 'Assembly Master register with latest BOM revision, line count and not-requestable item lines',
    description: 'Paginated -> { rows, total, page, page_size, counts_by_status }. Filters: `status` (comma-separated), `search` '
      + '(assembly code, standard name, OEM compatibility). Counts cover `search` only. Ordered by assembly_code.',
  })
  @ApiOkResponse({ type: StockAssembliesPage })
  assemblies(@Query() q: StockAssembliesQueryDto) {
    return this.svc.assemblies(q);
  }

  @Get('assemblies/:id')
  @ApiOperation({ summary: 'Assembly Master row + BOM revisions + the lines of one revision (default latest) with item status' })
  @ApiOkResponse({ type: StockAssemblyDetail })
  assembly(@Param('id', ParseUUIDPipe) id: string, @Query() q: StockAssemblyDetailQueryDto) {
    return this.svc.assembly(id, q);
  }
}
