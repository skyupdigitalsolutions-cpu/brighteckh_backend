import { Body, Controller, Get, Param, Post, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  Br03CustodyAcknowledgementsRow, Br03InspectionMediaRow, Br03InspectionReportsRow, Br03InspectionSessionsRow,
  Br03MaterialChangeRequestsRow, Br03MaterialRequestLinesRow, Br03MaterialRequestsRow,
} from '../../common/swagger/rows.generated';
import {
  CatalogueItem, InspectionReportDetail, InspectionSessionsResponse, InspectionVersionResult, JobMaterialRequest,
  MaterialRequestDetail,
} from './dto/br03.responses';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { Br03Service } from './br03.service';
import {
  AddInspectionMediaDto, AddMaterialLineDto, CatalogueQueryDto, CreateChangeRequestDto, CreateMaterialRequestDto,
  CustodyAckDto, PauseSessionDto, ReviewChangeRequestDto, ReviewInspectionDto, SubmitInspectionVersionDto,
} from './dto/br03.dto';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';

interface Actor { id: string; role: string; companyId: string }

@ApiTags('BR-03 Custody, Inspection & Material Requests')
@ApiAuth()
@ApiStdErrors()
@Controller()
@UseGuards(RolesGuard)
export class Br03Controller {
  constructor(private readonly svc: Br03Service) {}

  // custody

  @ApiCreatedResponse({ type: Br03CustodyAcknowledgementsRow })
  @Post('jobs/:id/custody-ack')
  @Roles(Role.ENGINEER)
  custodyAck(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CustodyAckDto, @CurrentActor() actor: Actor) {
    return this.svc.custodyAck(id, dto, actor);
  }

  // inspection sessions

  @ApiCreatedResponse({ type: Br03InspectionSessionsRow })
  @Post('jobs/:id/inspection-sessions')
  @Roles(Role.ENGINEER)
  startSession(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.startSession(id, actor);
  }

  @Get('jobs/:id/inspection-sessions')
  @ApiOperation({ summary: "Inspection sessions + per-engineer time totals" })
  @ApiOkResponse({ type: InspectionSessionsResponse })
  getSessions(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getSessions(id, actor);
  }

  @ApiCreatedResponse({ type: Br03InspectionSessionsRow })
  @Post('inspection-sessions/:id/pause')
  @Roles(Role.ENGINEER)
  pauseSession(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PauseSessionDto, @CurrentActor() actor: Actor) {
    return this.svc.pauseSession(id, dto, actor);
  }

  @ApiCreatedResponse({ type: Br03InspectionSessionsRow })
  @Post('inspection-sessions/:id/resume')
  @Roles(Role.ENGINEER)
  resumeSession(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.resumeSession(id, actor);
  }

  @ApiCreatedResponse({ type: Br03InspectionSessionsRow })
  @Post('inspection-sessions/:id/stop')
  @Roles(Role.ENGINEER)
  stopSession(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.stopSession(id, actor);
  }

  // inspection reports

  @ApiCreatedResponse({ type: Br03InspectionReportsRow })
  @Post('jobs/:id/inspection-reports')
  @Roles(Role.ENGINEER)
  getOrCreateReport(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getOrCreateReport(id, actor);
  }

  @Get('jobs/:id/inspection-report')
  @ApiOperation({ summary: "Inspection report with all versions and Purchase's review decisions/comments" })
  @ApiOkResponse({ type: InspectionReportDetail })
  getReportByJob(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getReportByJob(id, actor);
  }

  @Get('inspection-reports/:id/media')
  @ApiOperation({ summary: 'Photos/videos recorded on an inspection report (all versions), oldest first' })
  @ApiOkResponse({ type: [Br03InspectionMediaRow] })
  listMedia(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.listReportMedia(id, actor);
  }

  @ApiCreatedResponse({ type: Br03InspectionMediaRow })
  @Post('inspection-reports/:id/media')
  @Roles(Role.ENGINEER)
  addMedia(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddInspectionMediaDto, @CurrentActor() actor: Actor) {
    return this.svc.addMedia(id, dto, actor);
  }

  @ApiCreatedResponse({ type: InspectionVersionResult })
  @Post('inspection-reports/:id/submit')
  @Roles(Role.ENGINEER)
  submitInspectionVersion(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitInspectionVersionDto, @CurrentActor() actor: Actor) {
    return this.svc.submitInspectionVersion(id, dto, actor);
  }

  @ApiCreatedResponse({ type: InspectionVersionResult })
  @Post('inspection-reports/:id/review')
  @Roles(Role.PURCHASE)
  reviewInspection(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewInspectionDto, @CurrentActor() actor: Actor) {
    return this.svc.reviewInspection(id, dto, actor);
  }

  // material requests

  @ApiCreatedResponse({ type: Br03MaterialRequestsRow })
  @Post('jobs/:id/material-requests')
  @Roles(Role.ENGINEER)
  createMaterialRequest(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateMaterialRequestDto, @CurrentActor() actor: Actor) {
    return this.svc.createMaterialRequest(id, dto, actor);
  }

  @Get('jobs/:id/material-requests')
  @ApiOperation({
    summary: "The job's material requests (newest first) with lines, change requests and each line's live fulfilment",
    description:
      'Lines add item_code / item_name and `fulfilment` = { allocatable_now (ledger fdn_allocatable for the item, '
      + 'company-wide), reserved_quantity (COMMITTED BR-05 reservations), issued / consumed / returned_quantity (BR-07 '
      + 'issues from those reservations) }. Computed at read time; nothing is stored. Empty array when the job has none.',
  })
  @ApiOkResponse({ type: [JobMaterialRequest] })
  @Roles(Role.PURCHASE, Role.MANAGEMENT)
  getJobMaterialRequests(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getJobMaterialRequests(id, actor);
  }

  // PURCHASE / MANAGEMENT: the company inbox. ENGINEER: only MRs they are responsible for or on jobs currently
  // assigned to them (the Engineer app reads this list). Security fix 19 Nov 2026 — any role could read every MR.
  @Roles(Role.PURCHASE, Role.MANAGEMENT, Role.ENGINEER)
  @Get('material-requests')
  @ApiOperation({ summary: "Purchase inbox: company's material requests, newest first" })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT','SUBMITTED','PROCESSING','RETURNED','CHANGE_REQUESTED','WITHDRAWN','CLOSED'] })
  @ApiOkResponse({ type: [Br03MaterialRequestsRow] })
  listMaterialRequests(@Query('status') status: string | undefined, @CurrentActor() actor: Actor) {
    return this.svc.listMaterialRequests(actor, status);
  }

  @Get('material-requests/:id')
  @ApiOperation({ summary: "Material request with lines and change requests" })
  @ApiOkResponse({ type: MaterialRequestDetail })
  getMaterialRequest(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getMaterialRequest(id, actor);
  }

  @Get('material-requests/:id/catalogue')
  @ApiOperation({
    summary: 'Parts that can be added to this request: APPROVED + active catalogue-bridge rows with their item_bridge_id',
    description:
      'Same rule the line trigger applies. Rows are ordered by bridge item_code; use `search` to narrow. ' +
      'Since migration 023 the bridge is synced from the Item Master: an APPROVED or ACTIVE item is listed, ' +
      'DRAFT/UNDER_REVIEW/ON_HOLD/INACTIVE/SUPERSEDED items are not, and quantities are whole numbers only ' +
      '(CLIENT-UNCONFIRMED rules). There is no "request a new item" workflow: when a part is missing, the ' +
      'client should tell the engineer to ask Purchase to add it to the Item Master; it appears here once approved.',
  })
  @ApiOkResponse({ type: [CatalogueItem] })
  catalogue(@Param('id', ParseUUIDPipe) id: string, @Query() q: CatalogueQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.catalogue(id, actor, q.search, q.limit ? Number(q.limit) : 50);
  }

  @ApiCreatedResponse({ type: Br03MaterialRequestLinesRow })
  @Post('material-requests/:id/lines')
  @Roles(Role.ENGINEER)
  addLine(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddMaterialLineDto, @CurrentActor() actor: Actor) {
    return this.svc.addLine(id, dto, actor);
  }

  @ApiCreatedResponse({ type: Br03MaterialRequestsRow })
  @Post('material-requests/:id/submit')
  @Roles(Role.ENGINEER)
  submitMaterialRequest(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.submitMaterialRequest(id, actor);
  }

  @ApiCreatedResponse({ type: Br03MaterialRequestsRow })
  @Post('material-requests/:id/start-processing')
  @Roles(Role.PURCHASE)
  startProcessing(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.startProcessing(id, actor);
  }

  @ApiCreatedResponse({ type: Br03MaterialChangeRequestsRow })
  @Post('material-requests/:id/change-requests')
  @Roles(Role.ENGINEER)
  createChangeRequest(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateChangeRequestDto, @CurrentActor() actor: Actor) {
    return this.svc.createChangeRequest(id, dto, actor);
  }

  @ApiCreatedResponse({ type: Br03MaterialChangeRequestsRow })
  @Post('material-requests/:id/change-requests/:crId/review')
  @Roles(Role.PURCHASE)
  reviewChangeRequest(
    @Param('id', ParseUUIDPipe) id: string, @Param('crId', ParseUUIDPipe) crId: string, @Body() dto: ReviewChangeRequestDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.svc.reviewChangeRequest(id, crId, dto, actor);
  }
}
