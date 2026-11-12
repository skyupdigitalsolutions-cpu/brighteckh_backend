import {
  applyDecorators, Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, StreamableFile, UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse, ApiExtension, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiTags,
} from '@nestjs/swagger';
import {
  Br10ReportGrantsRow, Br10RoleBindingsRow, Br10SalesCustomerAssignmentsRow,
} from '../../common/swagger/rows.generated';
import { ApiAuth, ApiStdErrors, ErrorResponse } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { Actor } from './br10-access.service';
import { Br10Service } from './br10.service';
import {
  ApproveGrantDto, AuthorityDto, CreateBindingDto, CreateGrantDto, CreateSalesAssignmentDto, ExportQueryDto,
  REPORT_CODES, ReportQueryDto,
} from './dto/br10.dto';
import { AuthorityStatus, Br10Catalogue, GrantWithApprovals, MyAccess, ReportResponse } from './dto/br10.responses';

/** Report routes: no fixed @Roles -- access is the per-employee BR-10 entitlement (binding + matrix + grant). */
const Entitled = (action: 'VIEW' | 'EXPORT') => applyDecorators(
  ApiExtension('x-roles', [`ENTITLED: ACTIVE br10_role_binding + permission matrix + ACTIVE ${action} grant for this report/company`]),
  ApiForbiddenResponse({ description: `No ACTIVE ${action} entitlement (denial is audited)`, type: ErrorResponse }),
  ApiParam({ name: 'code', enum: REPORT_CODES }),
);

/**
 * BR-10 is read-only over BR-02..09: reports run in READ ONLY transactions; the only
 * writes are BR-10's own grant/config tables (+ the access log and platform audit log).
 *   any authenticated      -> catalogue, my-access, reports (subject to entitlement)
 *   SYSTEM_ADMIN           -> role bindings, grants (create/revoke, STANDARD approval),
 *                             Sales customer assignments, authoriser config
 *   configured authoriser  -> FINANCIAL / CROSS_COMPANY grant approval (CLIENT-UNCONFIRMED)
 */
@ApiTags('BR-10 Management MIS & RBAC')
@ApiAuth()
@ApiStdErrors()
@Controller('mis')
@UseGuards(RolesGuard)
export class Br10Controller {
  constructor(private readonly svc: Br10Service) {}

  // ---- reports

  @Get('reports/:code')
  @Entitled('VIEW')
  @ApiOperation({ summary: 'Run a report (read-only, company + row scoped, masked per policy)' })
  @ApiOkResponse({ type: ReportResponse })
  view(@Param('code') code: string, @Query() q: ReportQueryDto, @CurrentActor() a: Actor) {
    return this.svc.view(code, q, a);
  }

  @Get('reports/:code/export')
  @Entitled('EXPORT')
  @ApiOperation({ summary: 'Export a report as CSV / XLSX / PDF -- needs a separate EXPORT grant; export masking applied; audited' })
  @ApiProduces('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf')
  @ApiOkResponse({ description: 'File download', schema: { type: 'string', format: 'binary' } })
  async export(@Param('code') code: string, @Query() q: ExportQueryDto, @CurrentActor() a: Actor) {
    const f = await this.svc.export(code, q, a);
    return new StreamableFile(f.body, { type: f.contentType, disposition: `attachment; filename="${f.filename}"` });
  }

  @Get('catalogue')
  @ApiOperation({ summary: 'Role catalogue (R_* -> existing role_code), permission matrix, reports, masking policy' })
  @ApiOkResponse({ type: Br10Catalogue })
  catalogue() { return this.svc.catalogue(); }

  @Get('my-access')
  @ApiOkResponse({ type: MyAccess })
  myAccess(@CurrentActor() a: Actor) { return this.svc.myAccess(a); }

  // ---- role bindings (SYSTEM_ADMIN)

  @Post('role-bindings')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiOperation({ summary: 'Bind an employee to an R_* role (must map to their existing role_code). Starts INACTIVE.' })
  @ApiCreatedResponse({ type: Br10RoleBindingsRow })
  createBinding(@Body() dto: CreateBindingDto, @CurrentActor() a: Actor) { return this.svc.createBinding(dto, a); }

  @Post('role-bindings/:id/activate')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiCreatedResponse({ type: Br10RoleBindingsRow })
  activateBinding(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.setBindingStatus(id, 'ACTIVE', a); }

  @Post('role-bindings/:id/revoke')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiCreatedResponse({ type: Br10RoleBindingsRow })
  revokeBinding(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.setBindingStatus(id, 'REVOKED', a); }

  // ---- report grants

  @Get('report-grants')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiOkResponse({ type: [GrantWithApprovals] })
  listGrants(@CurrentActor() a: Actor) { return this.svc.listGrants(a); }

  @Post('report-grants')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiOperation({ summary: 'Create a named-employee grant (report + VIEW|EXPORT + company). Starts INACTIVE; required approvals derived by the DB.' })
  @ApiCreatedResponse({ type: Br10ReportGrantsRow })
  createGrant(@Body() dto: CreateGrantDto, @CurrentActor() a: Actor) { return this.svc.createGrant(dto, a); }

  @Post('report-grants/:id/approve')
  @ApiExtension('x-roles', ['STANDARD: SYSTEM_ADMIN (grantee company)',
    'FINANCIAL / CROSS_COMPANY: CONFIGURED br10_authority_config role of the data-owner company (CLIENT-UNCONFIRMED; never SYSTEM_ADMIN for FINANCIAL)'])
  @ApiForbiddenResponse({ description: 'Caller lacks the required approver role', type: ErrorResponse })
  @ApiOperation({ summary: 'Record one required approval; the grant turns ACTIVE when all required approvals exist' })
  @ApiCreatedResponse({ type: GrantWithApprovals })
  approveGrant(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveGrantDto, @CurrentActor() a: Actor) {
    return this.svc.approveGrant(id, dto, a);
  }

  @Post('report-grants/:id/revoke')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiCreatedResponse({ type: Br10ReportGrantsRow })
  revokeGrant(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) { return this.svc.revokeGrant(id, a); }

  // ---- Sales customer assignments (row scope for Sales)

  @Post('sales-assignments')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiCreatedResponse({ type: Br10SalesCustomerAssignmentsRow })
  createAssignment(@Body() dto: CreateSalesAssignmentDto, @CurrentActor() a: Actor) { return this.svc.createSalesAssignment(dto, a); }

  @Post('sales-assignments/:id/activate')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiCreatedResponse({ type: Br10SalesCustomerAssignmentsRow })
  activateAssignment(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) {
    return this.svc.setSalesAssignmentStatus(id, 'ACTIVE', a);
  }

  @Post('sales-assignments/:id/revoke')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiCreatedResponse({ type: Br10SalesCustomerAssignmentsRow })
  revokeAssignment(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) {
    return this.svc.setSalesAssignmentStatus(id, 'REVOKED', a);
  }

  // ---- authoriser config (CLIENT-UNCONFIRMED)

  @Get('authorities')
  @ApiOkResponse({ type: [AuthorityStatus] })
  authorities(@CurrentActor() a: Actor) { return this.svc.getAuthorities(a); }

  @Put('authorities')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiOperation({ summary: 'Assign (or clear) the FINANCIAL_GRANT / CROSS_COMPANY_GRANT authoriser role -- CLIENT-UNCONFIRMED' })
  @ApiOkResponse({ type: [AuthorityStatus] })
  setAuthority(@Body() dto: AuthorityDto, @CurrentActor() a: Actor) { return this.svc.setAuthority(dto, a); }
}
