import { ApiProperty } from '@nestjs/swagger';
import {
  Br09CaseEvidenceRow, Br09RefundReplacementReviewsRow,
  Br08CreditNotesRow, Br09CaseFeedbackRow, Br09CaseSlaRow, Br09ClaimDecisionsRow, Br09CreditNoteRequestsRow,
  Br09CustomerCommunicationsRow, Br09GoodwillApprovalsRow, Br09SlaTargetsRow, Br09SupportCasesRow,
  Br09TechnicalAssessmentsRow, Br09VGoodwillRow, Br09VRepeatFailuresRow, Br09VRootCauseRow, Br09VFeedbackRow,
  Br09CaseRepeatJobsRow,
} from '../../../common/swagger/rows.generated';

export class CaseRepeatJob extends Br09CaseRepeatJobsRow {
  @ApiProperty() job_number!: string;
  @ApiProperty() job_status!: string;
  @ApiProperty({ example: 'R01' }) repeat_ref!: string;
  @ApiProperty({ type: 'integer' }) repeat_number!: number;
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true }) previous_job_id!: string | null;
}

export class CaseDetail extends Br09SupportCasesRow {
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true, description: 'id, job_number, status, closed_at' })
  original_job!: Record<string, unknown> | null;
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true, description: 'id, invoice_number, invoice_status, total_paise' })
  original_invoice!: Record<string, unknown> | null;
  @ApiProperty({ type: 'string', nullable: true, description: 'Why the case cannot be closed yet (null = closable or closed)' })
  closure_blocker!: string | null;
  @ApiProperty({ type: [CaseRepeatJob] }) repeat_jobs!: CaseRepeatJob[];
  @ApiProperty({ type: [Br09TechnicalAssessmentsRow] }) technical_assessments!: Br09TechnicalAssessmentsRow[];
  @ApiProperty({ type: [Br09ClaimDecisionsRow] }) decisions!: Br09ClaimDecisionsRow[];
  @ApiProperty({ type: [Br09GoodwillApprovalsRow] }) goodwill_approvals!: Br09GoodwillApprovalsRow[];
  @ApiProperty({ type: [Br09CreditNoteRequestsRow] }) credit_note_requests!: Br09CreditNoteRequestsRow[];
  @ApiProperty({ type: [Br09CustomerCommunicationsRow] }) communications!: Br09CustomerCommunicationsRow[];
  @ApiProperty({ type: [Br09CaseSlaRow] }) sla!: Br09CaseSlaRow[];
  @ApiProperty({ type: Br09CaseFeedbackRow, nullable: true }) feedback!: Br09CaseFeedbackRow | null;
  @ApiProperty({ type: [Br09CaseEvidenceRow] }) evidence!: Br09CaseEvidenceRow[];
  @ApiProperty({ type: [Br09RefundReplacementReviewsRow] }) refund_replacement_reviews!: Br09RefundReplacementReviewsRow[];
}

export class CreditNoteFulfilled {
  @ApiProperty({ type: Br09CreditNoteRequestsRow }) request!: Br09CreditNoteRequestsRow;
  @ApiProperty({ type: Br08CreditNotesRow }) credit_note!: Br08CreditNotesRow;
}

export class SupportAnalytics {
  @ApiProperty({ type: 'array', items: { type: 'object' } }) cases_by_status!: unknown[];
  @ApiProperty({ type: [Br09VRepeatFailuresRow] }) repeat_failures!: Br09VRepeatFailuresRow[];
  @ApiProperty({ type: [Br09VRootCauseRow] }) root_cause!: Br09VRootCauseRow[];
  @ApiProperty({ type: [Br09VGoodwillRow] }) goodwill!: Br09VGoodwillRow[];
  @ApiProperty({ type: Br09VFeedbackRow, nullable: true }) feedback!: Br09VFeedbackRow | null;
  @ApiProperty({ type: 'array', items: { type: 'object' } }) sla!: unknown[];
}

export class SupportAuthorityStatus {
  @ApiProperty({ enum: ['CLAIM_DECISION', 'GOODWILL_APPROVAL'] }) decision_kind!: string;
  @ApiProperty({ type: 'string', nullable: true }) approver_role_code!: string | null;
  @ApiProperty({ example: 'CLIENT-UNCONFIRMED (decisions blocked)' }) status!: string;
  @ApiProperty({ type: 'string', nullable: true }) note!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true }) updated_at!: string | null;
}

export class Br09Config {
  @ApiProperty({ type: [SupportAuthorityStatus] }) authorities!: SupportAuthorityStatus[];
  @ApiProperty({ type: [Br09SlaTargetsRow] }) sla_targets!: Br09SlaTargetsRow[];
}
