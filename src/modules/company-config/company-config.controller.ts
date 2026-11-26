import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { CompanyConfigService } from './company-config.service';
import { CompanyConfigResponse, CompanyPolicyDto } from './company-config.dto';

interface Actor { id: string; role: string; companyId: string }

/** Company = the caller's company (from the token). Edits: SYSTEM_ADMIN only. */
@ApiTags('Company config')
@ApiAuth()
@ApiStdErrors()
@Controller('company-config')
@UseGuards(RolesGuard)
export class CompanyConfigController {
  constructor(private readonly svc: CompanyConfigService) {}

  @Get()
  @ApiOperation({ summary: "The caller's company policy config (discount threshold, return windows, freight payer, follow-up, extra authorisers)" })
  @ApiOkResponse({ type: CompanyConfigResponse })
  get(@CurrentActor() a: Actor) { return this.svc.get(a); }

  @Put()
  @Roles(Role.SYSTEM_ADMIN)
  @ApiOperation({ summary: 'Set company policy fields. Omitted = unchanged, null = clear. Only max_discount_percent is enforced.' })
  @ApiOkResponse({ type: CompanyConfigResponse })
  set(@Body() dto: CompanyPolicyDto, @CurrentActor() a: Actor) { return this.svc.set(dto, a); }
}
