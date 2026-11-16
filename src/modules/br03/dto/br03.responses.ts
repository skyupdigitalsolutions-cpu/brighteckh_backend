import { ApiProperty } from '@nestjs/swagger';
import {
  Br03InspectionReportsRow, Br03InspectionReportVersionsRow, Br03InspectionReviewsRow, Br03InspectionSessionsRow,
  Br03MaterialChangeRequestsRow, Br03MaterialRequestLinesRow, Br03MaterialRequestsRow, Br03VEngineerTimeTotalsRow,
} from '../../../common/swagger/rows.generated';

/** GET /jobs/:id/inspection-sessions */
export class InspectionSessionsResponse {
  @ApiProperty({ type: [Br03InspectionSessionsRow], description: 'Ordered by started_at' })
  sessions!: Br03InspectionSessionsRow[];
  @ApiProperty({ type: [Br03VEngineerTimeTotalsRow], description: 'Per-engineer totals (view br03_v_engineer_time_totals)' })
  time_totals!: Br03VEngineerTimeTotalsRow[];
}

/** GET /jobs/:id/inspection-report — report header + every submitted version. */
export class InspectionReportDetail extends Br03InspectionReportsRow {
  @ApiProperty({ type: [Br03InspectionReportVersionsRow], description: 'Ordered by version_no' })
  versions!: Br03InspectionReportVersionsRow[];
  @ApiProperty({
    type: [Br03InspectionReviewsRow],
    description: "Purchase ACCEPT/RETURN decisions on this report's versions, ordered by reviewed_at (G13). "
      + 'review_comment is always present on a RETURN.',
  })
  reviews!: Br03InspectionReviewsRow[];
}

/** GET /material-requests/:id */
export class MaterialRequestDetail extends Br03MaterialRequestsRow {
  @ApiProperty({ type: [Br03MaterialRequestLinesRow] }) lines!: Br03MaterialRequestLinesRow[];
  @ApiProperty({ type: [Br03MaterialChangeRequestsRow] }) change_requests!: Br03MaterialChangeRequestsRow[];
}

/**
 * Live fulfilment of one material-request line (read-only; computed at read time, nothing is stored).
 * Quantities are traced MR line -> BR-05 stock-recheck lines -> COMMITTED reservations -> BR-07 issues.
 */
export class MaterialLineFulfilment {
  @ApiProperty({
    type: 'number',
    description: 'Ledger fdn_allocatable(company, item) right now: MAIN_STORE on hand minus active ledger reservations '
      + '(the same read BR-04 stock checks / BR-05 rechecks use). Company-wide for the item, not reserved for this job.',
  })
  allocatable_now!: number;
  @ApiProperty({ type: 'number', description: 'Σ COMMITTED BR-05 reservations for this line (stays counted after issue)' })
  reserved_quantity!: number;
  @ApiProperty({ type: 'number', description: 'Σ BR-07 issued_quantity of the issues made from those reservations' })
  issued_quantity!: number;
  @ApiProperty({ type: 'number', description: 'Σ BR-07 consumed_quantity of those issues' })
  consumed_quantity!: number;
  @ApiProperty({ type: 'number', description: 'Σ BR-07 returned_quantity (verified returns) of those issues' })
  returned_quantity!: number;
}

/** Element of JobMaterialRequest.lines: the stored line + its catalogue names + live fulfilment. */
export class JobMaterialRequestLine extends Br03MaterialRequestLinesRow {
  @ApiProperty({ type: String, nullable: true, description: 'br03_item_catalog_bridge.item_code' }) item_code!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'br03_item_catalog_bridge.item_name' }) item_name!: string | null;
  @ApiProperty({ type: MaterialLineFulfilment }) fulfilment!: MaterialLineFulfilment;
}

/** Element of GET /jobs/:id/material-requests */
export class JobMaterialRequest extends Br03MaterialRequestsRow {
  @ApiProperty({ type: [JobMaterialRequestLine], description: 'Ordered by created_at' }) lines!: JobMaterialRequestLine[];
  @ApiProperty({ type: [Br03MaterialChangeRequestsRow], description: 'Ordered by id' }) change_requests!: Br03MaterialChangeRequestsRow[];
}

/** POST /inspection-reports/:id/submit and /inspection-reports/:id/review */
export class InspectionVersionResult {
  @ApiProperty({ type: Br03InspectionReportsRow, description: 'Report header after the change' })
  report!: Br03InspectionReportsRow;
  @ApiProperty({ type: Br03InspectionReportVersionsRow, description: 'The submitted / reviewed version' })
  version!: Br03InspectionReportVersionsRow;
}

/**
 * GET /material-requests/:id/catalogue (G10) -- the catalogue-bridge rows a material line can use
 * (bridge APPROVED + active, the same test the line trigger applies), with the BR-01 Item Master
 * record each one points at. Send item_bridge_id to POST /material-requests/:id/lines.
 */
export class CatalogueItem {
  @ApiProperty({ format: 'uuid', description: 'Send this as item_bridge_id when adding a line' }) item_bridge_id!: string;
  @ApiProperty({ format: 'uuid' }) br01_item_id!: string;
  @ApiProperty({ description: 'Bridge item code' }) item_code!: string;
  @ApiProperty({ description: 'Bridge item name' }) item_name!: string;
  @ApiProperty({ description: 'UOM the line will snapshot' }) uom!: string;
  @ApiProperty() allows_fraction!: boolean;
  @ApiProperty({ description: 'Decimal places a quantity may carry (0 = whole numbers)' }) qty_precision!: number;
  @ApiProperty({ nullable: true, type: 'string', description: 'fdn_item_master.item_code; null if the bridge points at no master row' })
  master_item_code!: string | null;
  @ApiProperty({ nullable: true, type: 'string' }) master_standard_name!: string | null;
  @ApiProperty({ nullable: true, type: 'string', enum: ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'ON_HOLD', 'INACTIVE', 'SUPERSEDED'] })
  master_status!: string | null;
}
