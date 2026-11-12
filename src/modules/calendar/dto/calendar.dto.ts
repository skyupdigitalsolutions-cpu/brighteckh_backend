import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import {
  CalendarHolidaysRow, WorkingCalendarDayRulesRow, WorkingCalendarsRow,
} from '../../../common/swagger/rows.generated';

/** Admin adds holidays as they are announced -- there is no preset list. */
export class AddHolidayDto {
  @ApiProperty({ example: '2026-12-25', description: 'Local calendar date (YYYY-MM-DD)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/) holiday_date!: string;
  @ApiProperty({ example: 'Christmas' })
  @IsString() @MinLength(1) @MaxLength(150) description!: string;
}

export class WorkingTimeQueryDto {
  @ApiProperty({ example: '2026-11-06T17:00:00+05:30', description: 'Start instant (ISO-8601)' })
  @IsISO8601() from!: string;
  @ApiPropertyOptional({ description: 'Working minutes to add (lunch, non-working days and holidays count zero)' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) minutes?: number;
  @ApiPropertyOptional({ description: 'Working days to add (same clock time on the Nth next working day)' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) days?: number;
}

export class CalendarResponse extends WorkingCalendarsRow {
  @ApiProperty({ type: [WorkingCalendarDayRulesRow], description: 'Authoritative per-weekday hours (ISO 1=Mon..7=Sun)' })
  day_rules!: WorkingCalendarDayRulesRow[];
  @ApiProperty({ type: [CalendarHolidaysRow], description: 'All configured holidays, by date' })
  holidays!: CalendarHolidaysRow[];
}

export class WorkingTimeResponse {
  @ApiProperty({ format: 'date-time' }) from!: string;
  @ApiProperty({ type: 'integer', nullable: true }) minutes!: number | null;
  @ApiProperty({ type: 'integer', nullable: true }) days!: number | null;
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Null if the company has no active calendar' })
  due_at!: string | null;
}
