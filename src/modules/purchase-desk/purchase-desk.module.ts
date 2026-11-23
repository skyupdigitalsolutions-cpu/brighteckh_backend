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
import { SalesSupplyDeskController } from './sales-supply-desk.controller';
import { SalesSupplyDeskService } from './sales-supply-desk.service';
import { MaterialRequestsDeskController } from './material-requests-desk.controller';
import { MaterialRequestsDeskService } from './material-requests-desk.service';
import { PurchaseOrdersDeskController } from './purchase-orders-desk.controller';
import { PurchaseOrdersDeskService } from './purchase-orders-desk.service';

/** Read endpoints (+ the unit-detail edit) for the Purchase desktop UI, plus the Sales quote worklist Stores receiving reads and BR-11 Sales & Supply desk reads. See CLAUDE.md §4i. */
@Module({
  controllers: [PurchaseDeskBr02Controller, PurchaseDeskBr04Controller, LookupsController, PurchaseOverviewController, SalesDeskController,
    StoresDeskController, SalesSupplyDeskController, MaterialRequestsDeskController, PurchaseOrdersDeskController],
  providers: [PurchaseDeskService, JobProgressService, PurchaseOverviewService, SalesQuotesService, StoresDeskService, SalesSupplyDeskService,
    MaterialRequestsDeskService, PurchaseOrdersDeskService],
})
export class PurchaseDeskModule {}
