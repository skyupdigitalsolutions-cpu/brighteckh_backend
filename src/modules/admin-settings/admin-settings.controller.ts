import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { Br08GstRateConfigRow } from '../../common/swagger/rows.generated';
import { AdminSettingsService } from './admin-settings.service';
import {
  AdminAuthorisersDto, AdminCompanyRow, AdminCompanySettings, AdminHolidayDto, AdminNumbering, AdminPoliciesDto,
  AdminProfileDto, GstRateDto, TestSlaTarget, TestSlaTargetDto, WorkingHoursDto,
} from './admin-settings.dto';

interface Actor { id: string; role: string; companyId: string }

/**
 * SYSTEM_ADMIN Settings panel (Figma AST-D). Unlike the per-company config endpoints, the company is
 * the :companyId in the path (company switcher). Every write returns the refreshed settings.
 */
@ApiTags('Admin settings')
@ApiAuth()
@ApiStdErrors()
@Controller('admin/settings')
@UseGuards(RolesGuard)
@Roles(Role.SYSTEM_ADMIN)
export class AdminSettingsController {
  constructor(private readonly svc: AdminSettingsService) {}

  @Get('companies')
  @ApiOperation({ summary: 'Companies the Settings switcher can open' })
  @ApiOkResponse({ type: [AdminCompanyRow] })
  companies() { return this.svc.listCompanies(); }

  @Get('companies/:companyId')
  @ApiOperation({ summary: "One company's settings: profile, authorisers, policies, calendar (+ global GST rates and test SLA), last saved per tab" })
  @ApiOkResponse({ type: AdminCompanySettings })
  get(@Param('companyId', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.get(id, a); }

  @Get('companies/:companyId/numbering')
  @ApiOperation({ summary: 'Document number series: format, latest and next number (read-only; numbers are assigned by the DB)' })
  @ApiOkResponse({ type: AdminNumbering })
  numbering(@Param('companyId', ParseUUIDPipe) id: string) { return this.svc.numbering(id); }

  @Put('companies/:companyId/profile')
  @ApiOperation({ summary: 'Company & tax: legal name, Udyam, GSTIN, state, address, document prefix, bank. Prefix/state/GSTIN freeze once BR-08 documents exist.' })
  @ApiOkResponse({ type: AdminCompanySettings })
  setProfile(@Param('companyId', ParseUUIDPipe) id: string, @Body() dto: AdminProfileDto, @CurrentActor() a: Actor) {
    return this.svc.setProfile(id, dto, a);
  }

  @Put('companies/:companyId/authorisers')
  @ApiOperation({ summary: 'Authorisers: BR-09 decision roles, BR-10 grant approvers, return / refund / KPI roles' })
  @ApiOkResponse({ type: AdminCompanySettings })
  setAuthorisers(@Param('companyId', ParseUUIDPipe) id: string, @Body() dto: AdminAuthorisersDto, @CurrentActor() a: Actor) {
    return this.svc.setAuthorisers(id, dto, a);
  }

  @Put('companies/:companyId/policies')
  @ApiOperation({ summary: 'Policies: company policy fields and the BR-11 sales policy' })
  @ApiOkResponse({ type: AdminCompanySettings })
  setPolicies(@Param('companyId', ParseUUIDPipe) id: string, @Body() dto: AdminPoliciesDto, @CurrentActor() a: Actor) {
    return this.svc.setPolicies(id, dto, a);
  }

  @Put('companies/:companyId/working-hours')
  @ApiOperation({ summary: 'Calendar: replace the per-weekday working hours (+ lunch break). Weekdays not listed are non-working.' })
  @ApiOkResponse({ type: AdminCompanySettings })
  setWorkingHours(@Param('companyId', ParseUUIDPipe) id: string, @Body() dto: WorkingHoursDto, @CurrentActor() a: Actor) {
    return this.svc.setWorkingHours(id, dto, a);
  }

  @Post('companies/:companyId/holidays')
  @ApiOperation({ summary: 'Calendar: add a holiday' })
  @ApiOkResponse({ type: AdminCompanySettings })
  addHoliday(@Param('companyId', ParseUUIDPipe) id: string, @Body() dto: AdminHolidayDto, @CurrentActor() a: Actor) {
    return this.svc.addHoliday(id, dto, a);
  }

  @Post('companies/:companyId/holidays/:holidayId/remove')
  @ApiOperation({ summary: 'Calendar: remove a future holiday (past holidays are kept)' })
  @ApiOkResponse({ type: AdminCompanySettings })
  removeHoliday(
    @Param('companyId', ParseUUIDPipe) id: string, @Param('holidayId', ParseUUIDPipe) holidayId: string,
    @CurrentActor() a: Actor,
  ) { return this.svc.removeHoliday(id, holidayId, a); }

  @Put('gst-rates')
  @ApiOperation({ summary: 'GLOBAL: set the GST rate (and HSN/SAC) for a quote line type. Replaces the active row; history kept.' })
  @ApiOkResponse({ type: [Br08GstRateConfigRow] })
  setGstRate(@Body() dto: GstRateDto, @CurrentActor() a: Actor) { return this.svc.setGstRate(dto, a); }

  @Put('test-sla-targets')
  @ApiOperation({ summary: 'GLOBAL: BR-07 test-start SLA for one job priority' })
  @ApiOkResponse({ type: [TestSlaTarget] })
  setTestSla(@Body() dto: TestSlaTargetDto, @CurrentActor() a: Actor) { return this.svc.setTestSlaTarget(dto, a); }
}
