import { ApiProperty } from '@nestjs/swagger';
import {
  Br04CustomerQuotesRow, Br04RfqsRow, InwardReceiptsRow, JobAssignmentsRow, ServiceJobsRow,
} from '../../../common/swagger/rows.generated';

/** Every list/lookup response: one page of rows plus the total match count. */
export class PageMeta {
  @ApiProperty({ type: 'integer', description: 'Rows matching the filters (all pages)' }) total!: number;
  @ApiProperty({ type: 'integer' }) page!: number;
  @ApiProperty({ type: 'integer' }) page_size!: number;
}

const nullableStr = (description?: string) => ApiProperty({ type: 'string', nullable: true, description });
const int = (description?: string) => ApiProperty({ type: 'integer', description });

// ---------------------------------------------------------------- G14 register

export class ReceiptListRow extends InwardReceiptsRow {
  @ApiProperty() customer_code!: string;
  @ApiProperty() customer_name!: string;
  @int('Equipment groups on the JIN') groups_count!: number;
  @int('SUM(inward_equipment_groups.quantity_received): units declared on the groups (counted before expansion)') units_received!: number;
  @int('Expanded unit rows (inward_equipment_units)') units_total!: number;
  @int("Unit rows with verification_status='VERIFIED' (each has a Job ID)") units_verified!: number;
}
export class ReceiptListPage extends PageMeta {
  @ApiProperty({ type: [ReceiptListRow], description: 'Newest receipt_at first' }) rows!: ReceiptListRow[];
}

// ---------------------------------------------------------------- G15 jobs

export class JobListRow extends ServiceJobsRow {
  @ApiProperty() jin_number!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) receipt_at!: string;
  @int('Unit number within its equipment group') unit_number!: number;
  @int('Units in that equipment group') units_in_group!: number;
  @nullableStr() serial_number!: string | null;
  @nullableStr() observed_make!: string | null;
  @nullableStr() observed_model!: string | null;
  @ApiProperty({ format: 'uuid', description: 'assemblies.id' }) assembly_id!: string;
  @ApiProperty() assembly_code!: string;
  @ApiProperty() assembly_name!: string;
  @ApiProperty({ format: 'uuid' }) customer_id!: string;
  @ApiProperty() customer_code!: string;
  @ApiProperty() customer_name!: string;
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Current job_assignments row, null if unassigned' })
  current_assignment_id!: string | null;
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true }) current_engineer_id!: string | null;
  @nullableStr('employees.full_name of the current engineer') current_engineer_name!: string | null;
  @ApiProperty({ type: 'string', nullable: true, enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'REASSIGNED'], description: 'Current assignment response (PENDING = custody not yet acknowledged)' })
  assignment_response!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true }) assigned_at!: string | null;
  @ApiProperty({
    type: 'string', format: 'date-time',
    description: 'Latest of: job created/closed/cancelled, current assignment assigned/responded, and any activity_audit_log row '
      + 'whose entity_id is the job or whose after_state has a top-level job_id equal to the job.',
  })
  last_activity_at!: string;
}
export class JobListPage extends PageMeta {
  @ApiProperty({ type: [JobListRow], description: 'Newest job first' }) rows!: JobListRow[];
}

// ---------------------------------------------------------------- G20 RFQs

export class RfqListRow extends Br04RfqsRow {
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'The job whose shortages the RFQ was raised from (RFQs are per job)' })
  job_id!: string | null;
  @nullableStr() job_number!: string | null;
  @nullableStr() customer_name!: string | null;
  @int() lines_count!: number;
  @int('br04_rfq_supplier_invites rows') invites_count!: number;
  @int('br04_supplier_offer_headers rows (offers recorded)') offers_count!: number;
}
export class RfqListPage extends PageMeta {
  @ApiProperty({ type: [RfqListRow], description: 'Newest first. No supplier prices are included.' }) rows!: RfqListRow[];
}

// ---------------------------------------------------------------- G21 quotes

export class QuoteListRow extends Br04CustomerQuotesRow {
  @ApiProperty() job_number!: string;
  @ApiProperty() job_status!: string;
  @ApiProperty({ format: 'uuid' }) customer_id!: string;
  @ApiProperty() customer_name!: string;
  @int() revisions_count!: number;
  @ApiProperty({ format: 'uuid' }) latest_revision_id!: string;
  @int() latest_revision_no!: number;
  @ApiProperty({ enum: ['DRAFT', 'RELEASED_TO_SALES', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'] }) latest_quote_status!: string;
  @ApiProperty({ type: 'string', format: 'decimal', description: 'Latest revision revised_pre_tax (customer price, rupees numeric)' }) latest_revised_pre_tax!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) latest_tax_total!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) latest_freight_charge!: string;
  @ApiProperty() latest_currency_code!: string;
  @ApiProperty({ type: 'string', format: 'date', nullable: true }) latest_valid_until!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) latest_revision_at!: string;
}
export class QuoteListPage extends PageMeta {
  @ApiProperty({ type: [QuoteListRow], description: 'Newest latest-revision first. No supplier offer references or costs.' }) rows!: QuoteListRow[];
}

// ---------------------------------------------------------------- lookups

export class CustomerLookupRow {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() customer_code!: string;
  @ApiProperty() customer_name!: string;
  @ApiProperty({ enum: ['PENDING_APPROVAL', 'APPROVED', 'INACTIVE', 'REJECTED'] }) status!: string;
}
export class CustomerLookupPage extends PageMeta { @ApiProperty({ type: [CustomerLookupRow] }) rows!: CustomerLookupRow[]; }

export class EngineerLookupRow {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() employee_code!: string;
  @ApiProperty() full_name!: string;
  @int('Jobs not CLOSED/CANCELLED whose current assignment is this engineer') open_jobs!: number;
  @int('Of those, assignments still PENDING (custody not acknowledged)') pending_custody!: number;
}
export class EngineerLookupPage extends PageMeta { @ApiProperty({ type: [EngineerLookupRow] }) rows!: EngineerLookupRow[]; }

export class EmployeeLookupRow {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() employee_code!: string;
  @ApiProperty() full_name!: string;
  @ApiProperty() role_code!: string;
}
export class EmployeeLookupPage extends PageMeta { @ApiProperty({ type: [EmployeeLookupRow] }) rows!: EmployeeLookupRow[]; }

export class AssemblyLookupRow {
  @ApiProperty({ format: 'uuid', description: 'assemblies.id (customer equipment master, the id equipment groups take)' }) id!: string;
  @ApiProperty() assembly_code!: string;
  @ApiProperty() assembly_name!: string;
  @ApiProperty({ enum: ['PENDING_APPROVAL', 'APPROVED', 'INACTIVE', 'REJECTED'] }) status!: string;
  @ApiProperty() repairable!: boolean;
}
export class AssemblyLookupPage extends PageMeta { @ApiProperty({ type: [AssemblyLookupRow] }) rows!: AssemblyLookupRow[]; }

export class CustodyLocationLookupRow {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() location_code!: string;
  @ApiProperty() location_name!: string;
  @int('Equipment units currently at this location') units_here!: number;
}
export class CustodyLocationLookupPage extends PageMeta { @ApiProperty({ type: [CustodyLocationLookupRow] }) rows!: CustodyLocationLookupRow[]; }

export class ItemBridgeLookupRow {
  @ApiProperty({ format: 'uuid', description: 'br03_item_catalog_bridge.id (the item_bridge_id on MR / stock-check / shortage / RFQ / PO lines)' })
  item_bridge_id!: string;
  @ApiProperty({ format: 'uuid', description: 'fdn_item_master.id' }) br01_item_id!: string;
  @ApiProperty() item_code!: string;
  @ApiProperty() item_name!: string;
  @ApiProperty() uom!: string;
  @ApiProperty({ enum: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'INACTIVE'] }) approval_status!: string;
  @ApiProperty() is_active!: boolean;
}
export class ItemBridgeLookupPage extends PageMeta { @ApiProperty({ type: [ItemBridgeLookupRow] }) rows!: ItemBridgeLookupRow[]; }

// ---------------------------------------------------------------- C1-1 job progress

export class JobProgressStage {
  @ApiProperty({
    enum: ['ASSIGNED', 'CUSTODY', 'INSPECTION', 'REPORT_REVIEW', 'MATERIAL', 'QUOTE', 'AUTHORISATION', 'PO_GRN', 'REPAIR_TEST', 'DISPATCH_INVOICE'],
  })
  key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({
    enum: ['done', 'current', 'pending', 'blocked'],
    description: 'done = the stage\'s completion is recorded (see `rule`). current = first not-done stage after the last done one. '
      + 'blocked = that current stage while the job is ON_HOLD/CANCELLED, or REPAIR_TEST after a BR-07 STOP review. '
      + 'pending = anything else (including earlier stages with no record, e.g. no supplier PO because stock covered it). '
      + 'A CLOSED job has no current stage.',
  })
  status!: string;
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'When the stage completed (done) or started (in progress); null if nothing recorded' })
  at!: string | null;
  @ApiProperty({ description: 'Table(s) the stage is derived from' }) source!: string;
  @ApiProperty({ description: 'The exact derivation rule' }) rule!: string;
  @ApiProperty({ type: 'string', nullable: true, description: 'Recorded state, e.g. report status, quote number + status, DC/invoice numbers' })
  detail!: string | null;
}

export class JobAssignmentHistoryRow extends JobAssignmentsRow {
  @ApiProperty() engineer_name!: string;
  @ApiProperty() assigned_by_name!: string;
}

export class JobProgress {
  @ApiProperty({ format: 'uuid' }) job_id!: string;
  @ApiProperty() job_number!: string;
  @ApiProperty() job_status!: string;
  @ApiProperty({ type: 'string', nullable: true, description: 'key of the current (or blocked) stage; null if none' }) current_stage!: string | null;
  @ApiProperty({ type: [JobProgressStage], description: 'Always 10 stages in this order' }) stages!: JobProgressStage[];
  @ApiProperty({ type: [JobAssignmentHistoryRow], description: 'Every job_assignments row for the job, oldest first' })
  assignments!: JobAssignmentHistoryRow[];
}

// ---------------------------------------------------------------- G22 overview

export class OverviewVerifyUnits {
  @int("inward_equipment_units with verification_status='PENDING' (expanded, not yet verified)") awaiting!: number;
  @int('JINs that have at least one such unit') receipts_with_pending_units!: number;
  @int('Units whose verified_at falls on today (company timezone)') verified_today!: number;
}
export class OverviewAssign {
  @int('Jobs not CLOSED/CANCELLED with no current job_assignments row') unassigned!: number;
  @int('job_assignments rows created today (company timezone), reassignments included') assigned_today!: number;
}
export class OverviewReviewReports {
  @int("br03_inspection_reports with status='SUBMITTED' (awaiting Purchase accept/return)") awaiting_review!: number;
  @int("br03_inspection_reports with status='RETURNED' (back with the engineer)") returned!: number;
  @int('br03_inspection_reviews (ACCEPT or RETURN) recorded today (company timezone)') reviewed_today!: number;
}
export class OverviewStatusCount {
  @ApiProperty() status!: string;
  @int() count!: number;
}
export class OverviewEngineerLoad {
  @ApiProperty({ format: 'uuid' }) engineer_id!: string;
  @ApiProperty() employee_code!: string;
  @ApiProperty() full_name!: string;
  @int('Jobs not CLOSED/CANCELLED whose current assignment is this engineer') open_jobs!: number;
  @int('Of those, assignments still PENDING (custody not acknowledged)') pending_custody!: number;
}
export class OverviewIntakeDay {
  @ApiProperty({ type: 'string', format: 'date' }) date!: string;
  @ApiProperty({ enum: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] }) weekday!: string;
  @int('SUM(quantity_received) of equipment groups on JINs whose receipt_at falls on this day') units_received!: number;
  @int('Units whose verified_at falls on this day') units_verified!: number;
}
export class OverviewActivity {
  @ApiProperty({ description: 'activity_audit_log.id (bigint as string)' }) id!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) changed_at!: string;
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true }) actor_id!: string | null;
  @nullableStr() actor_name!: string | null;
  @ApiProperty() action!: string;
  @ApiProperty() entity_table!: string;
  @ApiProperty({ format: 'uuid' }) entity_id!: string;
}

export class PurchaseOverview {
  @ApiProperty({ type: 'string', format: 'date-time' }) as_of!: string;
  @ApiProperty({ description: "Company timezone used for 'today' and the week (active working calendar; default Asia/Kolkata)" }) timezone!: string;
  @ApiProperty({ type: 'string', format: 'date' }) today!: string;
  @ApiProperty({ type: OverviewVerifyUnits }) verify_units!: OverviewVerifyUnits;
  @ApiProperty({ type: OverviewAssign }) assign_engineers!: OverviewAssign;
  @ApiProperty({ type: OverviewReviewReports }) review_reports!: OverviewReviewReports;
  @ApiProperty({ type: [OverviewStatusCount], description: 'One entry per open service_jobs.status (all but CLOSED/CANCELLED), zeros included' })
  jobs_by_status!: OverviewStatusCount[];
  @ApiProperty({ type: [OverviewEngineerLoad], description: 'Active ENGINEER employees, most open jobs first, max 50' })
  engineer_workload!: OverviewEngineerLoad[];
  @int('Active ENGINEER employees in the company (engineer_workload is capped at 50)') engineers_total!: number;
  @ApiProperty({ type: [OverviewIntakeDay], description: 'Mon..Sat of the current week (company timezone)' })
  intake_this_week!: OverviewIntakeDay[];
  @ApiProperty({ type: [OverviewActivity], description: 'Latest 10 activity_audit_log rows of the company. before/after state is NOT returned.' })
  latest_activity!: OverviewActivity[];
}
