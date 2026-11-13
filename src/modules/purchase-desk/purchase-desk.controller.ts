import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EquipmentPhotosRow, InwardEquipmentUnitsRow } from '../../common/swagger/rows.generated';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { Actor, PurchaseDeskService } from './purchase-desk.service';
import { JobProgressService } from './job-progress.service';
import { PurchaseOverviewService } from './purchase-overview.service';
import {
  AssemblyLookupQueryDto, CustomerLookupQueryDto, EmployeeLookupQueryDto, JobListQueryDto, LookupQueryDto,
  QuoteListQueryDto, ReceiptListQueryDto, RfqListQueryDto, UpdateEquipmentUnitDto,
} from './dto/purchase-desk.dto';
import {
  AssemblyLookupPage, CustodyLocationLookupPage, CustomerLookupPage, EmployeeLookupPage, EngineerLookupPage,
  ItemBridgeLookupPage, JobListPage, JobProgress, PurchaseOverview, QuoteListPage, ReceiptListPage, RfqListPage,
} from './dto/purchase-desk.responses';

const PAGED = 'Paginated: `page` (default 1), `page_size` (default 25, max 100) -> { rows, total, page, page_size }. ';

/** BR-02 reads + unit-detail edit for the Purchase desk (G14, G15, B-1, B-3, C1-1). */
@ApiTags('BR-02 Inward & Jobs')
@ApiAuth()
@ApiStdErrors()
@Controller()
@UseGuards(RolesGuard)
export class PurchaseDeskBr02Controller {
  constructor(private readonly svc: PurchaseDeskService, private readonly progressSvc: JobProgressService) {}

  @Get('inward-receipts')
  @Roles(Role.PURCHASE, Role.MANAGEMENT)
  @ApiOperation({
    summary: 'Inward register (G14): the company\'s JINs with customer name and unit counts',
    description: PAGED + 'Filters: `status`, `priority` (comma-separated DB values), `month` (YYYY-MM of receipt_at, company '
      + 'timezone), `search` (JIN number, customer name/code, customer DC number). Newest receipt_at first.',
  })
  @ApiOkResponse({ type: ReceiptListPage })
  listReceipts(@Query() q: ReceiptListQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.listReceipts(q, actor);
  }

  @Get('jobs')
  @Roles(Role.PURCHASE, Role.MANAGEMENT)
  @ApiOperation({
    summary: 'Jobs list (G15): company jobs with customer, equipment, current engineer and last activity',
    description: PAGED + 'Filters: `status`, `priority` (comma-separated), `engineer_id` (UUID or `unassigned`), `search` '
      + '(job number, JIN, serial, make, model, assembly code/name, customer name/code). Newest job first.',
  })
  @ApiOkResponse({ type: JobListPage })
  listJobs(@Query() q: JobListQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.listJobs(q, actor);
  }

  @Get('jobs/:id/progress')
  @Roles(Role.PURCHASE, Role.MANAGEMENT)
  @ApiOperation({
    summary: 'Job progress (C1-1): 10 derived stages BR-02..BR-08 + full assignment history with names',
    description: 'Purely derived from recorded rows; each stage carries its `source` table(s) and exact `rule`. '
      + 'No stage state is invented: an un-recorded stage is `pending`, not "skipped".',
  })
  @ApiOkResponse({ type: JobProgress })
  progress(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.progressSvc.progress(id, actor);
  }

  @Get('equipment-units/:id/photos')
  @ApiOperation({
    summary: 'Photos recorded against an equipment unit (B-3), oldest first',
    description: 'Any role in the unit\'s company (same access as GET /inward-receipts/:id).',
  })
  @ApiOkResponse({ type: [EquipmentPhotosRow] })
  unitPhotos(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.unitPhotos(id, actor);
  }

  @Patch('equipment-units/:id')
  @Roles(Role.PURCHASE)
  @ApiOperation({
    summary: 'Edit unit details (B-1): serial, make/model, reported fault, physical condition, accessories',
    description: 'Only the keys sent are changed; null or "" clears a field. Allowed only while the unit\'s '
      + 'verification_status is PENDING or ON_HOLD (before verification / Job ID) -- OPEN DECISION, see CLAUDE.md §4i. '
      + 'Writes an activity_audit_log row (BR02_UNIT_DETAILS_UPDATED) with the before/after values of the changed fields.',
  })
  @ApiOkResponse({ type: InwardEquipmentUnitsRow })
  updateUnit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEquipmentUnitDto, @CurrentActor() actor: Actor) {
    return this.svc.updateUnit(id, dto, actor);
  }
}

/** BR-04 lists (G20, G21). */
@ApiTags('BR-04 Stock Check, RFQ & Quotes')
@ApiAuth()
@ApiStdErrors()
@Controller()
@UseGuards(RolesGuard)
export class PurchaseDeskBr04Controller {
  constructor(private readonly svc: PurchaseDeskService) {}

  @Get('rfqs')
  @Roles(Role.PURCHASE)
  @ApiOperation({
    summary: 'RFQ list (G20) with the job each RFQ was raised from and invite/offer counts',
    description: PAGED + 'Filters: `status` (comma-separated rfq_status), `job_id`, `search` (RFQ number, job number, '
      + 'customer name, invited supplier name). Newest first. PURCHASE only, like GET /rfqs/:id. No prices.',
  })
  @ApiOkResponse({ type: RfqListPage })
  listRfqs(@Query() q: RfqListQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.listRfqs(q, actor);
  }

  @Get('quotes')
  @Roles(Role.PURCHASE, Role.MANAGEMENT)
  @ApiOperation({
    summary: 'Customer quote list (G21) with job, customer and the latest revision\'s status and pre-tax total',
    description: PAGED + 'Filters: `status` (comma-separated, matched on the LATEST revision), `job_id`, `search` (quote '
      + 'number, job number, customer name/code). Newest latest-revision first. Customer-facing fields only.',
  })
  @ApiOkResponse({ type: QuoteListPage })
  listQuotes(@Query() q: QuoteListQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.listQuotes(q, actor);
  }
}

/** Picker lookups (G16-G19, C2-1): names instead of typed ids. */
@ApiTags('Lookups')
@ApiAuth()
@ApiStdErrors()
@Controller('lookups')
@UseGuards(RolesGuard)
export class LookupsController {
  constructor(private readonly svc: PurchaseDeskService) {}

  @Get('customers')
  @Roles(Role.PURCHASE, Role.SALES)
  @ApiOperation({
    summary: 'Customers of the caller\'s company (G16)',
    description: PAGED + '`search` = name/code; `ids` resolves known ids; `status` defaults to PENDING_APPROVAL,APPROVED '
      + '(what a JIN accepts). Ordered by name. Contact/GST/address fields are not returned.',
  })
  @ApiOkResponse({ type: CustomerLookupPage })
  customers(@Query() q: CustomerLookupQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.customers(q, actor);
  }

  @Get('engineers')
  @Roles(Role.PURCHASE)
  @ApiOperation({
    summary: 'Active Service Engineers of the caller\'s company with open-job counts (G17)',
    description: PAGED + '`search` = name/code; `ids` resolves known ids. Same eligibility as POST /jobs/:id/assign. Ordered by name.',
  })
  @ApiOkResponse({ type: EngineerLookupPage })
  engineers(@Query() q: LookupQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.engineers(q, actor);
  }

  @Get('employees')
  @Roles(Role.PURCHASE)
  @ApiOperation({
    summary: 'Active employees of the caller\'s company, optionally by role (custodian / Sales hand-off / approver pickers)',
    description: PAGED + '`role` = comma-separated role codes; `search` = name/code; `ids` resolves known ids. Ordered by name.',
  })
  @ApiOkResponse({ type: EmployeeLookupPage })
  employees(@Query() q: EmployeeLookupQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.employees(q, actor);
  }

  @Get('assemblies')
  @Roles(Role.PURCHASE)
  @ApiOperation({
    summary: 'Assembly Master (`assemblies`, the id equipment groups take) (G19)',
    description: PAGED + '`search` = code/name; `ids`; `status` defaults to PENDING_APPROVAL,APPROVED (what an equipment group '
      + 'accepts). The table is shared by both companies (no company_id). Not fdn_assembly_master.',
  })
  @ApiOkResponse({ type: AssemblyLookupPage })
  assemblies(@Query() q: AssemblyLookupQueryDto) {
    return this.svc.assemblies(q);
  }

  @Get('custody-locations')
  @Roles(Role.PURCHASE)
  @ApiOperation({
    summary: 'Active custody locations of the caller\'s company (G18)',
    description: PAGED + '`search` = code/name; `ids`. Only active locations (expansion rejects inactive ones).',
  })
  @ApiOkResponse({ type: CustodyLocationLookupPage })
  custodyLocations(@Query() q: LookupQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.custodyLocations(q, actor);
  }

  @Get('item-bridge')
  @Roles(Role.PURCHASE)
  @ApiOperation({
    summary: 'Resolve item_bridge_id -> item code/name/UOM (C2-1) for stock-check, shortage, RFQ and PO lines',
    description: PAGED + '`ids` and/or `search` (code/name) is required. Any approval status (a line may reference a since-delisted item).',
  })
  @ApiOkResponse({ type: ItemBridgeLookupPage })
  itemBridge(@Query() q: LookupQueryDto) {
    return this.svc.itemBridge(q);
  }
}

/** G22 Purchase overview cards. Path chosen not to clash with the dev-only /dashboard module. */
@ApiTags('Purchase overview')
@ApiAuth()
@Controller('overview')
@UseGuards(RolesGuard)
export class PurchaseOverviewController {
  constructor(private readonly svc: PurchaseOverviewService) {}

  @Get('purchase')
  @Roles(Role.PURCHASE, Role.MANAGEMENT)
  @ApiOperation({
    summary: 'P0 overview metrics (G22) for the caller\'s company',
    description: 'Raw counts only (no targets/denominators). "Today"/"this week" use the company timezone. '
      + 'Each field\'s exact definition is in the schema. Read-only transaction.',
  })
  @ApiOkResponse({ type: PurchaseOverview })
  overview(@CurrentActor() actor: Actor) {
    return this.svc.overview(actor);
  }
}
