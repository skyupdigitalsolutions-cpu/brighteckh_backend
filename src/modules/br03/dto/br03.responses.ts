import { ApiProperty } from '@nestjs/swagger';
import {
  Br03InspectionReportsRow, Br03InspectionReportVersionsRow, Br03InspectionSessionsRow,
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
}

/** GET /material-requests/:id */
export class MaterialRequestDetail extends Br03MaterialRequestsRow {
  @ApiProperty({ type: [Br03MaterialRequestLinesRow] }) lines!: Br03MaterialRequestLinesRow[];
  @ApiProperty({ type: [Br03MaterialChangeRequestsRow] }) change_requests!: Br03MaterialChangeRequestsRow[];
}

/** POST /inspection-reports/:id/submit and /inspection-reports/:id/review */
export class InspectionVersionResult {
  @ApiProperty({ type: Br03InspectionReportsRow, description: 'Report header after the change' })
  report!: Br03InspectionReportsRow;
  @ApiProperty({ type: Br03InspectionReportVersionsRow, description: 'The submitted / reviewed version' })
  version!: Br03InspectionReportVersionsRow;
}
