import { Module } from '@nestjs/common';
import { Br08Module } from '../br08/br08.module';
import { Br09Module } from '../br09/br09.module';
import { Br10Module } from '../br10/br10.module';
import { Br11Module } from '../br11/br11.module';
import { CalendarModule } from '../calendar/calendar.module';
import { CompanyConfigModule } from '../company-config/company-config.module';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminSettingsService } from './admin-settings.service';

@Module({
  imports: [Br08Module, Br09Module, Br10Module, Br11Module, CalendarModule, CompanyConfigModule],
  controllers: [AdminSettingsController],
  providers: [AdminSettingsService],
})
export class AdminSettingsModule {}
