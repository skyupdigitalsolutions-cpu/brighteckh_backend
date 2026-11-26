import { applyDecorators, Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  ApiCreatedResponse, ApiExtension, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags,
} from '@nestjs/swagger';
import { Br09CaseFeedbackRow, Br09CreditNoteRequestsRow, Br09SupportCasesRow } from '../../common/swagger/rows.generated';
import { ApiAuth, ApiStdErrors, ErrorResponse } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { Br09Service } from './br09.service';
import {
  AuthorityConfigDto, CaseEvidenceDto, CaseReasonDto, ClaimDecisionDto, RefundReplacementReviewDto, CloseCaseDto, CommunicationDto, DeclineCreditNoteDto, FeedbackDto,
  GoodwillApprovalDto, LinkRepeatJobToCaseDto, ListCasesQueryDto, MatchOriginalJobDto, RegisterCaseDto,
  SlaTargetDto, StartReviewDto, TechnicalAssessmentDto,
} from './dto/br09.dto';
import { Br09Config, CaseDetail, CreditNoteFulfilled, SupportAnalytics } from './dto/br09.responses';

interface Actor { id: string; role: string; companyId: string }

/** Documents a route whose approver role is CLIENT-UNCONFIRMED config, not a fixed @Roles(). */
const ConfiguredApprover = (kind: string) => applyDecorators(
  ApiExtension('x-roles', [`CONFIGURED: br09_authority_config.${kind} (CLIENT-UNCONFIRMED; blocked until set)`]),
  ApiForbiddenResponse({ description: `Caller lacks the role configured for ${kind}`, type: ErrorResponse }),
);

/**
 * Role split (RolesGuard here AND DB triggers):
 *   SALES        -> register case, customer communications, feedback        (09A-01/06, 09C-04/08)
 *   PURCHASE     -> match original job, start review, link repeat job, close (09A-01/02/10, 09C-06)
 *   ENGINEER     -> technical assessment on the repeat job                   (09B-03/05)
 *   configured   -> claim decision, goodwill approval   (CLIENT-UNCONFIRMED: 09B-08, 09C-02)
 *   FINANCE      -> fulfil / decline credit-note request (via BR-08 credit note)
 *   SYSTEM_ADMIN -> approver-role + SLA-target config
 */
@ApiTags('BR-09 After-Sales & Warranty')
@ApiAuth()
@ApiStdErrors()
@Controller()
@UseGuards(RolesGuard)
export class Br09Controller {
  constructor(private readonly svc: Br09Service) {}

  @Post('support-cases')
  @Roles(Role.SALES)
  @ApiOperation({ summary: 'Register a complaint / warranty enquiry (case number per company, DB-assigned)' })
  @ApiCreatedResponse({ type: CaseDetail })
  register(@Body() dto: RegisterCaseDto, @CurrentActor() a: Actor) { return this.svc.register(dto, a); }

  @Get('support-cases')
  @ApiOkResponse({ type: [Br09SupportCasesRow] })
  list(@Query() q: ListCasesQueryDto, @CurrentActor() a: Actor) { return this.svc.listCases(q, a); }

  @Get('support-cases/:id')
  @ApiOperation({ summary: 'Case detail: original job + invoice, warranty, repeat jobs, evidence, decisions, CN requests, SLA, closure blocker' })
  @ApiOkResponse({ type: CaseDetail })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.getCase(id, a); }

  @Post('support-cases/:id/match-original-job')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Controlled search result: match an unlocated original job (once)' })
  @ApiCreatedResponse({ type: CaseDetail })
  match(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MatchOriginalJobDto, @CurrentActor() a: Actor) {
    return this.svc.matchOriginal(id, dto, a);
  }

  @Post('support-cases/:id/start-review')
  @Roles(Role.PURCHASE)
  @ApiCreatedResponse({ type: CaseDetail })
  review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StartReviewDto, @CurrentActor() a: Actor) {
    return this.svc.startReview(id, dto, a);
  }

  @Post('support-cases/:id/communications')
  @Roles(Role.SALES)
  @ApiOperation({ summary: 'Record a customer communication (ACKNOWLEDGEMENT stops the acknowledgement SLA)' })
  @ApiCreatedResponse({ type: CaseDetail })
  communicate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CommunicationDto, @CurrentActor() a: Actor) {
    return this.svc.communicate(id, dto, a);
  }

  @Post('support-cases/:id/repeat-jobs')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Attach a BR-02 repeat-return job (POST /jobs/:id/repeat-link first) to the case' })
  @ApiCreatedResponse({ type: CaseDetail })
  linkRepeat(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkRepeatJobToCaseDto, @CurrentActor() a: Actor) {
    return this.svc.linkRepeatJob(id, dto, a);
  }

  @Post('support-cases/:id/technical-assessments')
  @Roles(Role.ENGINEER)
  @ApiOperation({ summary: 'Engineer technical outcome for the returned unit (current accepted engineer of the repeat job)' })
  @ApiCreatedResponse({ type: CaseDetail })
  assess(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TechnicalAssessmentDto, @CurrentActor() a: Actor) {
    return this.svc.assess(id, dto, a);
  }

  @Post('support-cases/:id/decision')
  @ApiOperation({ summary: 'Claim decision by the CONFIGURED approver role. REPLACEMENT / REFUND_REVIEW then need the separate refund/replacement review.' })
  @ApiCreatedResponse({ type: CaseDetail })
  @ConfiguredApprover('CLAIM_DECISION')
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ClaimDecisionDto, @CurrentActor() a: Actor) {
    return this.svc.decide(id, dto, a);
  }

  @Post('support-cases/:id/goodwill-approval')
  @ApiOperation({ summary: 'Separate goodwill approval of a GOODWILL decision, by the CONFIGURED goodwill role' })
  @ApiCreatedResponse({ type: CaseDetail })
  @ConfiguredApprover('GOODWILL_APPROVAL')
  goodwill(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GoodwillApprovalDto, @CurrentActor() a: Actor) {
    return this.svc.approveGoodwill(id, dto, a);
  }

  @Post('support-cases/:id/refund-replacement-review')
  @ApiOperation({ summary: 'Separate review of a REPLACEMENT / REFUND_REVIEW decision by the CONFIGURED role (REPLACEMENT uses REPLACEMENT_APPROVAL when set, else REFUND_REPLACEMENT_REVIEW). Approved refund -> Finance credit-note request.' })
  @ApiCreatedResponse({ type: CaseDetail })
  @ConfiguredApprover('REFUND_REPLACEMENT_REVIEW / REPLACEMENT_APPROVAL')
  refundReplacementReview(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundReplacementReviewDto, @CurrentActor() a: Actor) {
    return this.svc.reviewRefundReplacement(id, dto, a);
  }

  @Post('support-cases/:id/evidence')
  @Roles(Role.SALES, Role.PURCHASE)
  @ApiOperation({ summary: 'Record case evidence (photo / video / email / invoice / POD / test record), optionally for a claim decision. Append-only.' })
  @ApiCreatedResponse({ type: CaseDetail })
  evidence(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CaseEvidenceDto, @CurrentActor() a: Actor) {
    return this.svc.addEvidence(id, dto, a);
  }

  @Post('support-cases/:id/hold')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Put a REGISTERED / UNDER_REVIEW case ON_HOLD (only before any claim decision or credit-note request)' })
  @ApiCreatedResponse({ type: CaseDetail })
  hold(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CaseReasonDto, @CurrentActor() a: Actor) {
    return this.svc.hold(id, dto, a);
  }

  @Post('support-cases/:id/resume')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Resume an ON_HOLD case to the status it was held from' })
  @ApiCreatedResponse({ type: CaseDetail })
  resume(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) {
    return this.svc.resume(id, a);
  }

  @Post('support-cases/:id/cancel')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Cancel a case (terminal). Blocked once a claim decision / credit-note request exists or a repeat job is linked.' })
  @ApiCreatedResponse({ type: CaseDetail })
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CaseReasonDto, @CurrentActor() a: Actor) {
    return this.svc.cancel(id, dto, a);
  }

  @Post('support-cases/:id/close')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Close the after-sales case (independent of BR-08 job closure). See closure_blocker on GET.' })
  @ApiCreatedResponse({ type: CaseDetail })
  close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseCaseDto, @CurrentActor() a: Actor) {
    return this.svc.close(id, dto, a);
  }

  @Post('support-cases/:id/feedback')
  @Roles(Role.SALES)
  @ApiOperation({ summary: 'Optional customer feedback / satisfaction rating (once per case)' })
  @ApiCreatedResponse({ type: Br09CaseFeedbackRow })
  feedback(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FeedbackDto, @CurrentActor() a: Actor) {
    return this.svc.feedback(id, dto, a);
  }

  // ---- Finance: credit-note requests (fulfilled through the BR-08 credit note)

  @Get('credit-note-requests')
  @ApiQuery({ name: 'status', required: false, enum: ['REQUESTED', 'FULFILLED', 'DECLINED'] })
  @ApiOkResponse({ type: [Br09CreditNoteRequestsRow] })
  cnRequests(@Query('status') status: string | undefined, @CurrentActor() a: Actor) {
    return this.svc.listCreditNoteRequests(a, status);
  }

  @Post('credit-note-requests/:id/fulfil')
  @Roles(Role.FINANCE)
  @ApiOperation({ summary: 'Raise the BR-08 credit note for this request (cancels the original invoice, reverses payments)' })
  @ApiCreatedResponse({ type: CreditNoteFulfilled })
  fulfil(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.fulfilCreditNote(id, a); }

  @Post('credit-note-requests/:id/decline')
  @Roles(Role.FINANCE)
  @ApiCreatedResponse({ type: Br09CreditNoteRequestsRow })
  decline(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeclineCreditNoteDto, @CurrentActor() a: Actor) {
    return this.svc.declineCreditNote(id, dto, a);
  }

  // ---- analytics + config

  @Get('support-analytics')
  @ApiOperation({ summary: 'Quality analytics: cases by status, repeat failures, root cause, goodwill, feedback, SLA' })
  @ApiOkResponse({ type: SupportAnalytics })
  analytics(@CurrentActor() a: Actor) { return this.svc.analytics(a); }

  @Get('support-config')
  @ApiOkResponse({ type: Br09Config })
  config(@CurrentActor() a: Actor) { return this.svc.getConfig(a); }

  @Put('support-config/authorities')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiOperation({ summary: 'Assign (or clear) the approver role for CLAIM_DECISION / GOODWILL_APPROVAL / REFUND_REPLACEMENT_REVIEW / REPLACEMENT_APPROVAL' })
  @ApiOkResponse({ type: Br09Config })
  setAuthority(@Body() dto: AuthorityConfigDto, @CurrentActor() a: Actor) { return this.svc.setAuthority(dto, a); }

  @Put('support-config/sla-targets')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiOperation({ summary: 'Set a case SLA target (working hours/days, company calendar). Unset = no due date.' })
  @ApiOkResponse({ type: Br09Config })
  setSla(@Body() dto: SlaTargetDto, @CurrentActor() a: Actor) { return this.svc.setSlaTarget(dto, a); }
}
