import { ApiProperty } from '@nestjs/swagger';
import {
  Br07DispatchReleasesRow, Br07MaterialConsumptionsRow, Br07MaterialIssuesRow, Br07MaterialReturnsRow,
  Br07RepairReportsRow, Br07RepairReportVersionsRow, Br07RepairSessionsRow, Br07TechnicalHandoffsRow,
  Br07TestFailureReviewsRow, Br07TestRunsRow, Br07VRepairTimeTotalsRow, SlaInstancesRow,
} from '../../../common/swagger/rows.generated';

/** GET /jobs/:id/material-issues */
export class JobMaterialResponse {
  @ApiProperty({ type: [Br07MaterialIssuesRow] }) issues!: Br07MaterialIssuesRow[];
  @ApiProperty({ type: [Br07MaterialConsumptionsRow] }) consumptions!: Br07MaterialConsumptionsRow[];
  @ApiProperty({ type: [Br07MaterialReturnsRow] }) returns!: Br07MaterialReturnsRow[];
}

/** GET /jobs/:id/repair-sessions */
export class RepairSessionsResponse {
  @ApiProperty({ type: [Br07RepairSessionsRow], description: 'Ordered by started_at' })
  sessions!: Br07RepairSessionsRow[];
  @ApiProperty({ type: [Br07VRepairTimeTotalsRow] }) time_totals!: Br07VRepairTimeTotalsRow[];
}

/** GET /jobs/:id/repair-report */
export class RepairReportDetail extends Br07RepairReportsRow {
  @ApiProperty({ type: [Br07RepairReportVersionsRow], description: 'Ordered by version_no' })
  versions!: Br07RepairReportVersionsRow[];
}

/** Test-start SLA facts shared by reads and writes. */
export class TestSlaInfo {
  @ApiProperty({ example: 'BR07_TEST_START' }) event_code!: string;
  @ApiProperty({ enum: ['NORMAL', 'URGENT', 'CRITICAL'] }) priority!: string;
  @ApiProperty({ type: 'string', nullable: true, example: '4 WORKING_HOUR', description: '"<target_amount> <target_unit>" from br07_test_sla_targets (unit WORKING_HOUR | WORKING_DAY); null if no target' })
  target!: string | null;
  @ApiProperty({
    type: 'string', format: 'date-time', nullable: true,
    description: 'Due time from the company working calendar (WORKING_HOUR = working minutes excl. lunch/holidays; '
      + 'WORKING_DAY = same clock time next working day). Null only when it cannot be computed — see due_at_reason.',
  })
  due_at!: string | null;
  @ApiProperty({ type: 'string', nullable: true, description: 'Why due_at is null (null when due_at is set)' })
  due_at_reason!: string | null;
}

export class TestSlaSummary extends TestSlaInfo {
  @ApiProperty({ type: [SlaInstancesRow] }) instances!: SlaInstancesRow[];
}

/** GET /jobs/:id/test-runs */
export class TestRunsResponse {
  @ApiProperty({ type: [Br07TestRunsRow], description: 'Ordered by cycle_no' }) runs!: Br07TestRunsRow[];
  @ApiProperty({ type: 'integer' }) failed_cycles!: number;
  @ApiProperty({ description: 'True when a Purchase failure review must happen before the next test cycle' })
  purchase_review_required!: boolean;
  @ApiProperty({ type: [Br07TestFailureReviewsRow] }) reviews!: Br07TestFailureReviewsRow[];
  @ApiProperty({ type: TestSlaSummary }) test_sla!: TestSlaSummary;
}

/** GET /jobs/:id/repair-status — one-call aggregate for a job's repair/test/dispatch screen. */
export class RepairStatusResponse {
  @ApiProperty({ type: JobMaterialResponse }) material!: JobMaterialResponse;
  @ApiProperty({ type: RepairSessionsResponse }) repair_sessions!: RepairSessionsResponse;
  @ApiProperty({ type: Br07RepairReportsRow, nullable: true, description: 'Header only (no versions); null if none yet' })
  repair_report!: Br07RepairReportsRow | null;
  @ApiProperty({ type: TestRunsResponse }) tests!: TestRunsResponse;
  @ApiProperty({ type: [Br07TechnicalHandoffsRow] }) handoffs!: Br07TechnicalHandoffsRow[];
  @ApiProperty({ type: Br07DispatchReleasesRow, nullable: true }) dispatch_release!: Br07DispatchReleasesRow | null;
}

// ---------------------------------------------------------------- write responses

/** POST /jobs/:id/material-issues — issue row after posting to the ledger (MAIN_STORE → ENGINEER_HELD). */
export class MaterialIssued extends Br07MaterialIssuesRow {
  @ApiProperty({
    enum: ['ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED'], nullable: true,
    description: 'Status of the ledger reservation this issue fulfilled (normally CONSUMED)',
  })
  ledger_reservation_status!: string | null;
  @ApiProperty({ type: 'number', description: 'Ledger allocatable qty after the issue' }) allocatable_after!: number;
}

/**
 * POST /material-issues/:id/consumptions and POST /material-consumptions/:id/post.
 * Normally the plain consumption row. If the consumption was ALREADY posted, the
 * stored row is returned joined with three issue fields (marked optional below).
 */
export class ConsumptionResult extends Br07MaterialConsumptionsRow {
  @ApiProperty({ format: 'uuid', required: false, description: 'Only on re-post of an already POSTED consumption' })
  item_id?: string;
  @ApiProperty({ required: false, description: 'Only on re-post of an already POSTED consumption' })
  uom?: string;
  @ApiProperty({ format: 'uuid', required: false, description: 'Only on re-post of an already POSTED consumption' })
  held_location_id?: string;
}

/** POST /material-returns/:id/verify — REJECTED returns come back without allocatable_after. */
export class ReturnVerified extends Br07MaterialReturnsRow {
  @ApiProperty({
    type: 'number', required: false,
    description: 'Present only when decision=VERIFY (stock moved ENGINEER_HELD → MAIN_STORE)',
  })
  allocatable_after?: number;
}

/** test_sla on POST /jobs/:id/repair-report — the clock has just started. */
export class TestSlaStarted extends TestSlaInfo {
  @ApiProperty({ format: 'uuid' }) sla_instance_id!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) started_at!: string;
}

/** POST /jobs/:id/repair-report */
export class RepairReportSubmitted {
  @ApiProperty({ type: Br07RepairReportsRow }) report!: Br07RepairReportsRow;
  @ApiProperty({ type: Br07RepairReportVersionsRow, description: 'The version just submitted' })
  version!: Br07RepairReportVersionsRow;
  @ApiProperty({ type: TestSlaStarted }) test_sla!: TestSlaStarted;
}

/** test_sla on POST /jobs/:id/test-runs — starting a test cycle stops the clock. */
export class TestSlaClosed extends TestSlaStarted {
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true }) completed_at!: string | null;
  @ApiProperty({ enum: ['OPEN', 'MET', 'BREACHED', 'PAUSED'], description: 'Stays OPEN while due_at is null' })
  state!: string;
  @ApiProperty({
    enum: ['OPEN', 'MET', 'BREACHED', 'PAUSED', 'UNDETERMINED'],
    description: 'UNDETERMINED until working calendars exist (due_at null)',
  })
  outcome!: string;
}

/** POST /jobs/:id/test-runs */
export class TestRunStarted extends Br07TestRunsRow {
  @ApiProperty({ type: TestSlaClosed, nullable: true, description: 'null if no open test-start SLA existed' })
  test_sla!: TestSlaClosed | null;
}

/** POST /test-runs/:id/result */
export class TestResultRecorded extends Br07TestRunsRow {
  @ApiProperty({ type: 'integer' }) failed_cycles!: number;
  @ApiProperty({ description: 'True when a Purchase failure review must happen before the next test cycle' })
  purchase_review_required!: boolean;
}

/** POST /jobs/:id/dispatch-release */
export class DispatchReleased extends Br07DispatchReleasesRow {
  @ApiProperty({
    type: 'number',
    description: 'Snapshot of engineer-held material not yet consumed/returned (does NOT block release — open decision 4)',
  })
  outstanding_engineer_held_qty!: number;
}
