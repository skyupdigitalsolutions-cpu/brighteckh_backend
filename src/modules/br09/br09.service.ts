import {
  BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgService } from '../../common/database/pg.service';
import {
  AUTHORITY_KINDS, AuthorityConfigDto, CaseEvidenceDto, CaseReasonDto, ClaimDecisionDto, CloseCaseDto, CommunicationDto,
  DeclineCreditNoteDto, FeedbackDto, GoodwillApprovalDto, LinkRepeatJobToCaseDto, ListCasesQueryDto, MatchOriginalJobDto,
  RefundReplacementReviewDto, RegisterCaseDto, SlaTargetDto, StartReviewDto, TechnicalAssessmentDto,
} from './dto/br09.dto';

interface Actor { id: string; role: string; companyId: string }
type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

/**
 * BR-09 after-sales / warranty. All rules are in the DB (migration 015):
 * numbering, role checks, the CLIENT-UNCONFIRMED approver config, evidence
 * gates, credit-note request -> BR-08 credit note, closure conditions, SLA
 * clocks. This service scopes to the caller's company, runs each write in one
 * transaction and writes the audit row.
 *
 * BR-09 never creates a Job ID (repeat jobs come from BR-02 inward + repeat
 * link), never posts stock, never closes a BR-02/BR-08 job.
 */
@Injectable()
export class Br09Service {
  constructor(private readonly pg: PgService) {}

  private rethrow(e: unknown): never {
    if (e instanceof HttpException) throw e;
    const m = (e as Error).message || 'request failed';
    // Approver-role mismatch is an authorisation failure, not a validation one.
    if (/requires the configured approver role/.test(m)) throw new ForbiddenException(m);
    throw new BadRequestException(m);
  }

  private async audit(client: PoolClient, actor: Actor, table: string, id: string, action: string, before: unknown, after: unknown) {
    await client.query(
      `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor.companyId, actor.id, table, id, action, before ?? null, after ?? null],
    );
  }

  private async owned(client: Queryable, table: string, id: string, actor: Actor, lock = false) {
    const r = await client.query(`SELECT * FROM ${table} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!r.rows[0]) throw new NotFoundException(`${table.replace(/^br09_/, '').replace(/_/g, ' ')} not found`);
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('record belongs to another company');
    return r.rows[0];
  }

  /** Run one case mutation in a tx with audit; returns the refreshed case detail. */
  private async caseWrite(caseId: string, actor: Actor, action: string,
    fn: (client: PoolClient, before: any) => Promise<unknown>) {
    try {
      await this.pg.tx(async (client) => {
        const before = await this.owned(client, 'br09_support_cases', caseId, actor, true);
        const result = await fn(client, before);
        const after = (await client.query(`SELECT * FROM br09_support_cases WHERE id=$1`, [caseId])).rows[0];
        await this.audit(client, actor, 'br09_support_cases', caseId, action, before, { case: after, result });
      });
      return this.getCase(caseId, actor);
    } catch (e) { this.rethrow(e); }
  }

  // ================================================================ cases

  async register(dto: RegisterCaseDto, actor: Actor) {
    try {
      const id = await this.pg.tx(async (client) => {
        await this.owned(client, 'customers', dto.customer_id, actor);
        if (dto.original_job_id) await this.owned(client, 'service_jobs', dto.original_job_id, actor);
        const c = (await client.query(
          `INSERT INTO br09_support_cases
             (company_id,case_number,customer_id,complaint_type,channel,contact_name,contact_detail,fault_description,
              priority,customer_reference,original_job_id,registered_by_id)
           VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [actor.companyId, dto.customer_id, dto.complaint_type, dto.channel, dto.contact_name, dto.contact_detail,
            dto.fault_description, dto.priority ?? 'NORMAL', dto.customer_reference ?? null, dto.original_job_id ?? null, actor.id],
        )).rows[0];
        await this.audit(client, actor, 'br09_support_cases', c.id, 'BR09_CASE_REGISTERED', null, c);
        return c.id;
      });
      return this.getCase(id, actor);
    } catch (e) { this.rethrow(e); }
  }

  matchOriginal(caseId: string, dto: MatchOriginalJobDto, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_ORIGINAL_JOB_MATCHED', async (client, before) => {
      if (before.original_job_id) throw new BadRequestException('original job already matched');
      await this.owned(client, 'service_jobs', dto.original_job_id, actor);
      await client.query(`UPDATE br09_support_cases SET original_job_id=$2, matched_by_id=$3 WHERE id=$1`,
        [caseId, dto.original_job_id, actor.id]);
    });
  }

  startReview(caseId: string, dto: StartReviewDto, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_REVIEW_STARTED', async (client) => {
      await client.query(`UPDATE br09_support_cases SET case_status='UNDER_REVIEW', assigned_to_id=$2 WHERE id=$1`,
        [caseId, dto.assigned_to_id ?? actor.id]);
    });
  }

  communicate(caseId: string, dto: CommunicationDto, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_CUSTOMER_COMMUNICATION', (client) => client.query(
      `INSERT INTO br09_customer_communications(company_id,case_id,comm_type,channel,summary,sent_by_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [actor.companyId, caseId, dto.comm_type, dto.channel, dto.summary, actor.id]).then((r) => r.rows[0]));
  }

  linkRepeatJob(caseId: string, dto: LinkRepeatJobToCaseDto, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_REPEAT_JOB_LINKED', async (client) => {
      await this.owned(client, 'service_jobs', dto.repeat_job_id, actor);
      return (await client.query(
        `INSERT INTO br09_case_repeat_jobs(company_id,case_id,repeat_job_id,linked_by_id) VALUES ($1,$2,$3,$4) RETURNING *`,
        [actor.companyId, caseId, dto.repeat_job_id, actor.id])).rows[0];
    });
  }

  assess(caseId: string, dto: TechnicalAssessmentDto, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_TECHNICAL_ASSESSMENT', async (client) => (await client.query(
      `INSERT INTO br09_technical_assessments
         (company_id,case_id,repeat_job_id,outcome,findings,root_cause_category,root_cause,assessed_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [actor.companyId, caseId, dto.repeat_job_id, dto.outcome, dto.findings, dto.root_cause_category ?? null,
        dto.root_cause ?? null, actor.id])).rows[0]);
  }

  /** Approver role is NOT in RolesGuard: it is the CLIENT-UNCONFIRMED br09_authority_config, checked by the DB. */
  decide(caseId: string, dto: ClaimDecisionDto, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_CLAIM_DECIDED', async (client) => (await client.query(
      `INSERT INTO br09_claim_decisions(company_id,case_id,resolution,decision_reason,decided_by_id,decided_role_code,warranty_status_at_decision)
       VALUES ($1,$2,$3,$4,$5,'',  '') RETURNING *`,
      [actor.companyId, caseId, dto.resolution, dto.decision_reason, actor.id])).rows[0]);
  }

  approveGoodwill(caseId: string, dto: GoodwillApprovalDto, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_GOODWILL_APPROVAL', async (client) => {
      const d = (await client.query(
        `SELECT id FROM br09_claim_decisions WHERE case_id=$1 AND is_current`, [caseId])).rows[0];
      if (!d) throw new BadRequestException('case has no current decision');
      return (await client.query(
        `INSERT INTO br09_goodwill_approvals(company_id,decision_id,outcome,note,approved_by_id,approver_role_code)
         VALUES ($1,$2,$3,$4,$5,'') RETURNING *`,
        [actor.companyId, d.id, dto.outcome, dto.note, actor.id])).rows[0];
    });
  }

  /** Separate CLIENT-UNCONFIRMED authority (migration 020): approves/rejects a REPLACEMENT or REFUND_REVIEW decision. */
  reviewRefundReplacement(caseId: string, dto: RefundReplacementReviewDto, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_REFUND_REPLACEMENT_REVIEW', async (client) => {
      const d = (await client.query(
        `SELECT id FROM br09_claim_decisions WHERE case_id=$1 AND is_current`, [caseId])).rows[0];
      if (!d) throw new BadRequestException('case has no current decision');
      return (await client.query(
        `INSERT INTO br09_refund_replacement_reviews(company_id,decision_id,outcome,note,reviewed_by_id,reviewer_role_code)
         VALUES ($1,$2,$3,$4,$5,'') RETURNING *`,
        [actor.companyId, d.id, dto.outcome, dto.note, actor.id])).rows[0];
    });
  }

  addEvidence(caseId: string, dto: CaseEvidenceDto, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_EVIDENCE_RECORDED', async (client) => (await client.query(
      `INSERT INTO br09_case_evidence(company_id,case_id,claim_decision_id,evidence_type,file_uri,file_name,description,
         submitted_by_kind,received_at,recorded_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,now()),$10) RETURNING *`,
      [actor.companyId, caseId, dto.claim_decision_id ?? null, dto.evidence_type, dto.file_uri, dto.file_name,
        dto.description ?? null, dto.submitted_by_kind, dto.received_at ?? null, actor.id])).rows[0]);
  }

  hold(caseId: string, dto: CaseReasonDto, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_CASE_ON_HOLD', (client) => client.query(
      `UPDATE br09_support_cases SET case_status='ON_HOLD', hold_reason=$2, held_by_id=$3, hold_from_status=case_status, held_at=now()
        WHERE id=$1`, [caseId, dto.reason, actor.id]));
  }

  resume(caseId: string, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_CASE_RESUMED', async (client, before) => {
      if (before.case_status !== 'ON_HOLD') throw new BadRequestException(`case is ${before.case_status}, not ON_HOLD`);
      await client.query(`UPDATE br09_support_cases SET case_status=hold_from_status, last_resumed_by_id=$2 WHERE id=$1`,
        [caseId, actor.id]);
    });
  }

  cancel(caseId: string, dto: CaseReasonDto, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_CASE_CANCELLED', (client) => client.query(
      `UPDATE br09_support_cases SET case_status='CANCELLED', cancel_reason=$2, cancelled_by_id=$3, cancelled_at=now() WHERE id=$1`,
      [caseId, dto.reason, actor.id]));
  }

  close(caseId: string, dto: CloseCaseDto, actor: Actor) {
    return this.caseWrite(caseId, actor, 'BR09_CASE_CLOSED', (client) => client.query(
      `UPDATE br09_support_cases SET case_status='CLOSED', closed_by_id=$2, closure_reason=$3,
              closure_disposition='pending', closed_at=now() WHERE id=$1`,
      [caseId, actor.id, dto.closure_reason]));
  }

  async feedback(caseId: string, dto: FeedbackDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.owned(client, 'br09_support_cases', caseId, actor);
        const f = (await client.query(
          `INSERT INTO br09_case_feedback(company_id,case_id,rating,comment,recorded_by_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [actor.companyId, caseId, dto.rating ?? null, dto.comment ?? null, actor.id])).rows[0];
        await this.audit(client, actor, 'br09_case_feedback', f.id, 'BR09_FEEDBACK_RECORDED', null, f);
        return f;
      });
    } catch (e) { this.rethrow(e); }
  }

  // ================================================================ credit-note requests (Finance)

  async fulfilCreditNote(requestId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const before = await this.owned(client, 'br09_credit_note_requests', requestId, actor, true);
        const cnId = (await client.query(`SELECT br09_fulfil_credit_note_request($1,$2) AS id`, [requestId, actor.id])).rows[0].id;
        const req = (await client.query(`SELECT * FROM br09_credit_note_requests WHERE id=$1`, [requestId])).rows[0];
        const cn = (await client.query(`SELECT * FROM br08_credit_notes WHERE id=$1`, [cnId])).rows[0];
        await this.audit(client, actor, 'br09_credit_note_requests', requestId, 'BR09_CREDIT_NOTE_FULFILLED', before, { request: req, credit_note: cn });
        return { request: req, credit_note: cn };
      });
    } catch (e) { this.rethrow(e); }
  }

  async declineCreditNote(requestId: string, dto: DeclineCreditNoteDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const before = await this.owned(client, 'br09_credit_note_requests', requestId, actor, true);
        const req = (await client.query(
          `UPDATE br09_credit_note_requests SET request_status='DECLINED', decline_reason=$2, resolved_by_id=$3
            WHERE id=$1 RETURNING *`, [requestId, dto.reason, actor.id])).rows[0];
        await this.audit(client, actor, 'br09_credit_note_requests', requestId, 'BR09_CREDIT_NOTE_DECLINED', before, req);
        return req;
      });
    } catch (e) { this.rethrow(e); }
  }

  // ================================================================ reads

  async getCase(caseId: string, actor: Actor) {
    const c = await this.owned(this.pg, 'br09_support_cases', caseId, actor);
    const q = (sql: string) => this.pg.query(sql, [caseId]).then((r) => r.rows);
    const [repeatJobs, assessments, decisions, goodwill, cnRequests, comms, sla, feedback, evidence, rrReviews] = await Promise.all([
      q(`SELECT rj.*, sj.job_number, sj.status AS job_status, l.repeat_ref, l.repeat_number, l.previous_job_id
           FROM br09_case_repeat_jobs rj JOIN service_jobs sj ON sj.id=rj.repeat_job_id
           JOIN job_repeat_links l ON l.job_id=rj.repeat_job_id WHERE rj.case_id=$1 ORDER BY l.repeat_number`),
      q(`SELECT * FROM br09_technical_assessments WHERE case_id=$1 ORDER BY assessed_at`),
      q(`SELECT * FROM br09_claim_decisions WHERE case_id=$1 ORDER BY decided_at`),
      q(`SELECT g.* FROM br09_goodwill_approvals g JOIN br09_claim_decisions d ON d.id=g.decision_id WHERE d.case_id=$1`),
      q(`SELECT * FROM br09_credit_note_requests WHERE case_id=$1 ORDER BY requested_at`),
      q(`SELECT * FROM br09_customer_communications WHERE case_id=$1 ORDER BY sent_at`),
      q(`SELECT * FROM br09_case_sla WHERE case_id=$1 ORDER BY event_code`),
      q(`SELECT * FROM br09_case_feedback WHERE case_id=$1`),
      q(`SELECT * FROM br09_case_evidence WHERE case_id=$1 ORDER BY recorded_at`),
      q(`SELECT r.* FROM br09_refund_replacement_reviews r JOIN br09_claim_decisions d ON d.id=r.decision_id WHERE d.case_id=$1`),
    ]);
    const original = c.original_job_id
      ? (await this.pg.query(`SELECT id, job_number, status, closed_at FROM service_jobs WHERE id=$1`, [c.original_job_id])).rows[0]
      : null;
    const invoice = c.original_invoice_id
      ? (await this.pg.query(`SELECT id, invoice_number, invoice_status, total_paise, cancelled_by_credit_note_id FROM br08_invoices WHERE id=$1`,
          [c.original_invoice_id])).rows[0]
      : null;
    const blocker = ['CLOSED', 'CANCELLED'].includes(c.case_status) ? null
      : (await this.pg.query(`SELECT br09_closure_blocker($1) AS b`, [caseId])).rows[0].b;
    return {
      ...c, original_job: original, original_invoice: invoice, closure_blocker: blocker,
      repeat_jobs: repeatJobs, technical_assessments: assessments, decisions, goodwill_approvals: goodwill,
      credit_note_requests: cnRequests, communications: comms, sla, feedback: feedback[0] ?? null,
      evidence, refund_replacement_reviews: rrReviews,
    };
  }

  async listCases(q: ListCasesQueryDto, actor: Actor) {
    const r = await this.pg.query(
      `SELECT * FROM br09_support_cases
        WHERE company_id=$1 AND ($2::text IS NULL OR case_status=$2)
          AND ($3::text IS NULL OR ($3='true') = (original_job_id IS NULL))
        ORDER BY registered_at DESC LIMIT 200`,
      [actor.companyId, q.status ?? null, q.unmatched ?? null]);
    return r.rows;
  }

  async listCreditNoteRequests(actor: Actor, status?: string) {
    const r = await this.pg.query(
      `SELECT r.*, c.case_number, i.invoice_number FROM br09_credit_note_requests r
         JOIN br09_support_cases c ON c.id=r.case_id JOIN br08_invoices i ON i.id=r.invoice_id
        WHERE r.company_id=$1 AND ($2::text IS NULL OR r.request_status=$2) ORDER BY r.requested_at DESC`,
      [actor.companyId, status ?? null]);
    return r.rows;
  }

  async analytics(actor: Actor) {
    const q = (sql: string) => this.pg.query(sql, [actor.companyId]).then((r) => r.rows);
    const [byStatus, repeat, rootCause, goodwill, feedback, sla] = await Promise.all([
      q(`SELECT case_status, closure_disposition, count(*)::int AS cases FROM br09_support_cases
          WHERE company_id=$1 GROUP BY case_status, closure_disposition ORDER BY 1,2`),
      q(`SELECT * FROM br09_v_repeat_failures WHERE company_id=$1 ORDER BY repeat_count DESC LIMIT 100`),
      q(`SELECT * FROM br09_v_root_cause WHERE company_id=$1 ORDER BY assessments DESC`),
      q(`SELECT * FROM br09_v_goodwill WHERE company_id=$1 ORDER BY decided_at DESC LIMIT 100`),
      q(`SELECT * FROM br09_v_feedback WHERE company_id=$1`),
      q(`SELECT s.event_code, s.state, count(*)::int AS clocks FROM br09_case_sla s
           JOIN br09_support_cases c ON c.id=s.case_id WHERE c.company_id=$1 GROUP BY 1,2 ORDER BY 1,2`),
    ]);
    return { cases_by_status: byStatus, repeat_failures: repeat, root_cause: rootCause, goodwill, feedback: feedback[0] ?? null, sla };
  }

  // ================================================================ config (SYSTEM_ADMIN)

  async getConfig(actor: Actor) {
    const [auth, sla] = await Promise.all([
      this.pg.query(`SELECT * FROM br09_authority_config WHERE company_id=$1 ORDER BY decision_kind`, [actor.companyId]),
      this.pg.query(`SELECT * FROM br09_sla_targets WHERE company_id=$1 ORDER BY event_code, priority`, [actor.companyId]),
    ]);
    const configured = new Map(auth.rows.map((r) => [r.decision_kind, r]));
    return {
      authorities: AUTHORITY_KINDS.map((k) => ({
        decision_kind: k,
        approver_role_code: configured.get(k)?.approver_role_code ?? null,
        status: configured.get(k)?.approver_role_code ? 'CONFIGURED'
          : k === 'REPLACEMENT_APPROVAL' ? 'NOT SET (REFUND_REPLACEMENT_REVIEW applies)'
          : 'CLIENT-UNCONFIRMED (decisions blocked)',
        note: configured.get(k)?.note ?? null, updated_at: configured.get(k)?.updated_at ?? null,
      })),
      sla_targets: sla.rows,
    };
  }

  async setAuthority(dto: AuthorityConfigDto, actor: Actor) {
    try {
      await this.pg.tx(async (client) => {
        const before = (await client.query(
          `SELECT * FROM br09_authority_config WHERE company_id=$1 AND decision_kind=$2`, [actor.companyId, dto.decision_kind])).rows[0];
        const after = (await client.query(
          `INSERT INTO br09_authority_config(company_id,decision_kind,approver_role_code,note,updated_by_id)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (company_id,decision_kind) DO UPDATE
             SET approver_role_code=EXCLUDED.approver_role_code, note=EXCLUDED.note,
                 updated_by_id=EXCLUDED.updated_by_id, updated_at=now()
           RETURNING *`,
          [actor.companyId, dto.decision_kind, dto.approver_role_code ?? null, dto.note ?? null, actor.id])).rows[0];
        await client.query(
          `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
           VALUES ($1,$2,'br09_authority_config',$1,'BR09_AUTHORITY_CONFIGURED',$3,$4)`,
          [actor.companyId, actor.id, before ?? null, after]);
      });
      return this.getConfig(actor);
    } catch (e) { this.rethrow(e); }
  }

  async setSlaTarget(dto: SlaTargetDto, actor: Actor) {
    try {
      await this.pg.tx(async (client) => {
        const after = (await client.query(
          `INSERT INTO br09_sla_targets(company_id,priority,event_code,target_amount,target_unit,updated_by_id)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (company_id,priority,event_code) DO UPDATE
             SET target_amount=EXCLUDED.target_amount, target_unit=EXCLUDED.target_unit,
                 updated_by_id=EXCLUDED.updated_by_id, updated_at=now()
           RETURNING *`,
          [actor.companyId, dto.priority, dto.event_code, dto.target_amount, dto.target_unit, actor.id])).rows[0];
        await client.query(
          `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
           VALUES ($1,$2,'br09_sla_targets',$1,'BR09_SLA_TARGET_SET',NULL,$3)`,
          [actor.companyId, actor.id, after]);
      });
      return this.getConfig(actor);
    } catch (e) { this.rethrow(e); }
  }
}
