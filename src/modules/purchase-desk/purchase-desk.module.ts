import { Module } from '@nestjs/common';
import {
  LookupsController, PurchaseDeskBr02Controller, PurchaseDeskBr04Controller, PurchaseOverviewController,
} from './purchase-desk.controller';
import { PurchaseDeskService } from './purchase-desk.service';
import { JobProgressService } from './job-progress.service';
import { PurchaseOverviewService } from './purchase-overview.service';

/** Read endpoints (+ the unit-detail edit) for the Purchase desktop UI. See CLAUDE.md §4i. */
@Module({
  controllers: [PurchaseDeskBr02Controller, PurchaseDeskBr04Controller, LookupsController, PurchaseOverviewController],
  providers: [PurchaseDeskService, JobProgressService, PurchaseOverviewService],
})
export class PurchaseDeskModule {}
