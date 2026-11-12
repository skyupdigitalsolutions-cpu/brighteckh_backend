import { Body, Controller, Get, Param, Post, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Br07MaterialIssuesRow, Br07MaterialReturnsRow, Br07RepairSessionsRow, Br07TechnicalHandoffsRow,
  Br07TestFailureReviewsRow,
} from '../../common/swagger/rows.generated';
import {
  ConsumptionResult, DispatchReleased, JobMaterialResponse, MaterialIssued, RepairReportDetail,
  RepairReportSubmitted, RepairSessionsResponse, RepairStatusResponse, ReturnVerified, TestResultRecorded,
  TestRunStarted, TestRunsResponse,
} from './dto/br07.responses';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { Br07Service } from './br07.service';
import {
  AcknowledgeIssueDto, ConsumeMaterialDto, DispatchReleaseDto, FailureReviewDto, IssueMaterialDto,
  PauseRepairSessionDto, RecordTestResultDto, RequestReturnDto, StartTestRunDto, SubmitRepairReportDto,
  TechnicalHandoffDto, VerifyReturnDto,
} from './dto/br07.dto';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';

interface Actor { id: string; role: string; companyId: string }

/**
 * Role split (both layers -- RolesGuard here, DB triggers below it):
 *   ENGINEER  -> custody ack, repair sessions, consumption, return request,
 *                repair report, test runs/results, technical handoff
 *   PURCHASE  -> material issue, return verification, two-fail review,
 *                dispatch release (the engineer cannot authorise dispatch)
 * Material-issue role is an OPEN DECISION (Purchase vs Stores) -- see README.
 */
@ApiTags('BR-07 Repair, Test & Dispatch')
@ApiAuth()
@ApiStdErrors()
@Controller()
@UseGuards(RolesGuard)
export class Br07Controller {
  constructor(private readonly svc: Br07Service) {}

  // ---- material issue / custody / consumption / return

  @ApiCreatedResponse({ type: MaterialIssued })
  @Post('jobs/:id/material-issues')
  @Roles(Role.PURCHASE)
  issueMaterial(@Param('id', ParseUUIDPipe) id: string, @Body() dto: IssueMaterialDto, @CurrentActor() actor: Actor) {
    return this.svc.issueMaterial(id, dto, actor);
  }

  @Get('jobs/:id/material-issues')
  @ApiOperation({ summary: "Material issued / consumed / returned for the job" })
  @ApiOkResponse({ type: JobMaterialResponse })
  listMaterial(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.listMaterial(id, actor);
  }

  @ApiCreatedResponse({ type: Br07MaterialIssuesRow })
  @Post('material-issues/:id/acknowledge')
  @Roles(Role.ENGINEER)
  acknowledgeIssue(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AcknowledgeIssueDto, @CurrentActor() actor: Actor) {
    return this.svc.acknowledgeIssue(id, dto, actor);
  }

  @ApiCreatedResponse({ type: ConsumptionResult })
  @Post('material-issues/:id/consumptions')
  @Roles(Role.ENGINEER)
  consume(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConsumeMaterialDto, @CurrentActor() actor: Actor) {
    return this.svc.consume(id, dto, actor);
  }

  @ApiCreatedResponse({ type: ConsumptionResult })
  @Post('material-consumptions/:id/post')
  @Roles(Role.ENGINEER)
  postConsumption(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.postConsumption(id, actor);
  }

  @ApiCreatedResponse({ type: Br07MaterialReturnsRow })
  @Post('material-issues/:id/returns')
  @Roles(Role.ENGINEER)
  requestReturn(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RequestReturnDto, @CurrentActor() actor: Actor) {
    return this.svc.requestReturn(id, dto, actor);
  }

  @ApiCreatedResponse({ type: ReturnVerified })
  @Post('material-returns/:id/verify')
  @Roles(Role.PURCHASE)
  verifyReturn(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyReturnDto, @CurrentActor() actor: Actor) {
    return this.svc.verifyReturn(id, dto, actor);
  }

  // ---- repair sessions

  @ApiCreatedResponse({ type: Br07RepairSessionsRow })
  @Post('jobs/:id/repair-sessions')
  @Roles(Role.ENGINEER)
  startRepairSession(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.startRepairSession(id, actor);
  }

  @Get('jobs/:id/repair-sessions')
  @ApiOperation({ summary: "Repair sessions + time totals" })
  @ApiOkResponse({ type: RepairSessionsResponse })
  getRepairSessions(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getRepairSessions(id, actor);
  }

  @ApiCreatedResponse({ type: Br07RepairSessionsRow })
  @Post('repair-sessions/:id/pause')
  @Roles(Role.ENGINEER)
  pauseRepairSession(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PauseRepairSessionDto, @CurrentActor() actor: Actor) {
    return this.svc.pauseRepairSession(id, dto, actor);
  }

  @ApiCreatedResponse({ type: Br07RepairSessionsRow })
  @Post('repair-sessions/:id/resume')
  @Roles(Role.ENGINEER)
  resumeRepairSession(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.resumeRepairSession(id, actor);
  }

  @ApiCreatedResponse({ type: Br07RepairSessionsRow })
  @Post('repair-sessions/:id/stop')
  @Roles(Role.ENGINEER)
  stopRepairSession(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.stopRepairSession(id, actor);
  }

  // ---- repair report

  @ApiCreatedResponse({ type: RepairReportSubmitted })
  @Post('jobs/:id/repair-report')
  @Roles(Role.ENGINEER)
  submitRepairReport(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitRepairReportDto, @CurrentActor() actor: Actor) {
    return this.svc.submitRepairReport(id, dto, actor);
  }

  @Get('jobs/:id/repair-report')
  @ApiOperation({ summary: "Repair report with all versions" })
  @ApiOkResponse({ type: RepairReportDetail })
  getRepairReport(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getRepairReport(id, actor);
  }

  // ---- testing

  @ApiCreatedResponse({ type: TestRunStarted })
  @Post('jobs/:id/test-runs')
  @Roles(Role.ENGINEER)
  startTestRun(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StartTestRunDto, @CurrentActor() actor: Actor) {
    return this.svc.startTestRun(id, dto, actor);
  }

  @Get('jobs/:id/test-runs')
  @ApiOperation({ summary: "Test cycles, failure reviews and test-start SLA" })
  @ApiOkResponse({ type: TestRunsResponse })
  getTestRuns(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getTestRuns(id, actor);
  }

  @ApiCreatedResponse({ type: TestResultRecorded })
  @Post('test-runs/:id/result')
  @Roles(Role.ENGINEER)
  recordTestResult(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordTestResultDto, @CurrentActor() actor: Actor) {
    return this.svc.recordTestResult(id, dto, actor);
  }

  @ApiCreatedResponse({ type: Br07TestFailureReviewsRow })
  @Post('jobs/:id/test-failure-reviews')
  @Roles(Role.PURCHASE)
  reviewFailures(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FailureReviewDto, @CurrentActor() actor: Actor) {
    return this.svc.reviewFailures(id, dto, actor);
  }

  // ---- handoff + dispatch release

  @ApiCreatedResponse({ type: Br07TechnicalHandoffsRow })
  @Post('jobs/:id/technical-handoff')
  @Roles(Role.ENGINEER)
  technicalHandoff(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TechnicalHandoffDto, @CurrentActor() actor: Actor) {
    return this.svc.technicalHandoff(id, dto, actor);
  }

  @ApiCreatedResponse({ type: DispatchReleased })
  @Post('jobs/:id/dispatch-release')
  @Roles(Role.PURCHASE)
  dispatchRelease(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DispatchReleaseDto, @CurrentActor() actor: Actor) {
    return this.svc.dispatchRelease(id, dto, actor);
  }

  @Get('jobs/:id/repair-status')
  @ApiOperation({ summary: "One-call aggregate for the repair/test/dispatch screen" })
  @ApiOkResponse({ type: RepairStatusResponse })
  getRepairStatus(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getRepairStatus(id, actor);
  }
}
