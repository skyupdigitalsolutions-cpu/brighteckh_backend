import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './common/database/database.module';
import { HealthController } from './health/health.controller';
import { MastersModule } from './modules/masters/masters.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { Br02Module } from './modules/br02/br02.module';
import { Br03Module } from './modules/br03/br03.module';
import { Br04Module } from './modules/br04/br04.module';
import { Br05Module } from './modules/br05/br05.module';
import { Br06Module } from './modules/br06/br06.module';
import { Br07Module } from './modules/br07/br07.module';
import { Br08Module } from './modules/br08/br08.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { Br09Module } from './modules/br09/br09.module';
import { Br10Module } from './modules/br10/br10.module';
import { Br11Module } from './modules/br11/br11.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { AuthModule } from './modules/auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule, // registers the global JwtAuthGuard (APP_GUARD)
    MastersModule,
    InventoryModule,
    Br02Module,
    Br03Module,
    Br04Module,
    Br05Module,
    Br06Module,
    Br07Module,
    Br08Module,
    CalendarModule,
    Br09Module,
    Br10Module,
    Br11Module,
    DashboardModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
