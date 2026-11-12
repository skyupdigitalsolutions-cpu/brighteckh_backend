import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { PgService } from '../common/database/pg.service';
import { Public } from '../common/auth/public.decorator';

@ApiTags('Health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly pg: PgService) {}

  @Get()
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        db: { type: 'string', example: 'up' },
        now: { type: 'string', format: 'date-time' },
      },
    },
  })
  async check() {
    const r = await this.pg.query<{ now: string }>('SELECT now()');
    return { status: 'ok', db: 'up', now: r.rows[0].now };
  }
}
