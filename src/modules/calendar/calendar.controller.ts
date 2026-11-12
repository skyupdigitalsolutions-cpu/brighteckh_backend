import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CalendarHolidaysRow } from '../../common/swagger/rows.generated';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { CalendarService } from './calendar.service';
import { AddHolidayDto, CalendarResponse, WorkingTimeQueryDto, WorkingTimeResponse } from './dto/calendar.dto';

interface Actor { id: string; role: string; companyId: string }

/** Company = the caller's company (from the token). Holiday edits: SYSTEM_ADMIN only. */
@ApiTags('Working Calendar')
@ApiAuth()
@ApiStdErrors()
@Controller('calendars')
@UseGuards(RolesGuard)
export class CalendarController {
  constructor(private readonly svc: CalendarService) {}

  @Get('current')
  @ApiOperation({ summary: "The caller's company working calendar: per-weekday hours, lunch break, holidays" })
  @ApiOkResponse({ type: CalendarResponse })
  current(@CurrentActor() actor: Actor) {
    return this.svc.current(actor);
  }

  @Get('working-time')
  @ApiOperation({ summary: 'Compute a due time: from + N working minutes, or + N working days' })
  @ApiOkResponse({ type: WorkingTimeResponse })
  workingTime(@Query() q: WorkingTimeQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.workingTime(q, actor);
  }

  @Post('holidays')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiOperation({ summary: 'Add a holiday (admin adds dates as they are announced; no preset list)' })
  @ApiCreatedResponse({ type: CalendarHolidaysRow })
  addHoliday(@Body() dto: AddHolidayDto, @CurrentActor() actor: Actor) {
    return this.svc.addHoliday(dto, actor);
  }

  @Post('holidays/:id/remove')
  @Roles(Role.SYSTEM_ADMIN)
  @ApiOperation({ summary: 'Remove a FUTURE holiday (past/today cannot be removed)' })
  removeHoliday(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.removeHoliday(id, actor);
  }
}
