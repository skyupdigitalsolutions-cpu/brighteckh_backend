import { Module } from '@nestjs/common';
import {
  LookupsController, PurchaseDeskBr02Controller, PurchaseDeskBr04Controller, PurchaseOverviewController,
} from './purchase-desk.controller';
import { PurchaseDeskService } from './purchase-desk.service';
import { JobProgressService } from './job-progress.service';
import { PurchaseOverviewService } from './purchase-overview.service';
import { SalesDeskController } from './sales-quotes.controller';
import { SalesQuotesService } from './sales-quotes.service';
import { StoresDeskController } from './stores-desk.controller';
import { StoresDeskService } from './stores-desk.service';

/** Read endpoints (+ the unit-detail edit) for the Purchase desktop UI, plus the Sales quote worklist and Stores receiving reads. See CLAUDE.md §4i. */
@Module({
  controllers: [PurchaseDeskBr02Controller, PurchaseDeskBr04Controller, LookupsController, PurchaseOverviewController, SalesDeskController,
    StoresDeskController],
  providers: [PurchaseDeskService, JobProgressService, PurchaseOverviewService, SalesQuotesService, StoresDeskService],
})
export class PurchaseDeskModule {}
