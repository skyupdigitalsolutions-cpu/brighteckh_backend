import { Controller, ForbiddenException, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { Public } from '../../common/auth/public.decorator';

const ENABLED = process.env.NODE_ENV !== 'production' || process.env.ENABLE_DASHBOARD === 'true';
function guard() { if (!ENABLED) throw new ForbiddenException('dashboard disabled in production'); }

@ApiTags('dashboard (dev)')
// Dev tooling (disabled in production by guard()). Public so seed can create the
// first demo logins before anyone can log in.
@Public()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get('overview') overview() { guard(); return this.svc.overview(); }
  @Get('companies') companies() { guard(); return this.svc.companies(); }
  @Get('tables') tables() { guard(); return this.svc.tables(); }
  @Get('tables/:name') rows(@Param('name') n: string, @Query('limit') l?: string) {
    guard(); return this.svc.tableRows(n, l ? Number(l) : 50);
  }
  @Post('seed') seed() { guard(); return this.svc.seed(); }
}
