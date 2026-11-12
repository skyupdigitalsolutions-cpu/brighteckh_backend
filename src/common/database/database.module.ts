import { Global, Module } from '@nestjs/common';
import { PgService } from './pg.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PgService, PrismaService],
  exports: [PgService, PrismaService],
})
export class DatabaseModule {}
