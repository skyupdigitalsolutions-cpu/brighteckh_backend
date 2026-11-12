import {
  BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgService } from '../../common/database/pg.service';
import { InventoryService } from '../inventory/inventory.service';
import {
  AcknowledgeIssueDto, ConsumeMaterialDto, DispatchReleaseDto, FailureReviewDto, IssueMaterialDto,
  PauseRepairSessionDto, RecordTestResultDto, RequestReturnDto, StartTestRunDto, SubmitRepairReportDto,
  TechnicalHandoffDto, VerifyReturnDto,
} from './dto/br07.dto';

interface Actor { id: string; role: string; companyId: string }

const TEST_SLA_EVENT = 'BR07_TEST_START';

// Either a tx client or the pool -- just the one call shape this module uses.
type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

/**
 * BR-07: material issue (MAIN_STORE -> ENGINEER_HELD) against a committed BR-05
 * reservation -> engineer acknowledges custody of the material -> time-tracked
 * repair session -> versioned repair report -> test cycles (+ test-start SLA)
 * -> Purchase review after 2 failed cycles -> engineer technical handoff ->
 * PURCHASE dispatch release. Consumption (ENGINEER_HELD -> CONSUMED) and unused
 * returns (ENGINEER_HELD -> MAIN_STORE, after Purchase verify) run alongside.
 *
 * Every stock move goes through InventoryService (fdn_post_movement); this
 * module never writes fdn_inventory_balances. Ledger posts happen OUTSIDE the
 * BR-07 transaction (same pattern as BR-05/06): the BR-07 row commits first in
 * a PENDING state, then the idempotent ledger post, then a second tx records
 * the journal id. A failure in between leaves a resumable PENDING row, never a
 * ledger movement without a BR-07 record.
 *
 * Test-start SLA: due_at = br07_test_sla_due() (migration 012) from the
 * company's working calendar -- WORKING_HOUR targets count working minutes
 * (lunch/holidays excluded), WORKING_DAY = same clock time on the next working
 * day. Test start closes the clock as MET/BREACHED. If the company has no
 * active calendar, due_at stays NULL and test_sla.due_at_reason says why.
 */
@Injectable()
export class Br07Service {
  constructor(private readonly pg: PgService, private readonly inventory: InventoryService) {}

  private rethrow(e: unknown): never {
    if (e instanceof HttpException) throw e;
    throw new BadRequestException((e as Error).message || 'request failed');
  }

  private async audit(
    client: PoolClient, companyId: string, actorId: string, entityTable: string,
    entityId: string, action: string, before: unknown, after: unknown,
  ) {
    await client.query(
      `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [companyId, actorId, entityTable, entityId, action, before ?? null, after ?? null],
    );
  }

  private async loadJob(client: Queryable, jobId: string, actor: Actor, lock = false) {
    const r = await client.query(
      `SELECT company_id, priority, unit_id FROM service_jobs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [jobId],
    );
    if (!r.rows[0]) throw new NotFoundException('job not found');
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    return r.rows[0];
  }

  private async currentAssignment(client: PoolClient, jobId: string) {
    const r = await client.query<{ id: string; engineer_id: string }>(
      `SELECT id, engineer_id FROM job_assignments WHERE job_id=$1 AND is_current AND response='ACCEPTED'`, [jobId],
    );
    if (!r.rows[0]) throw new BadRequestException('job has no current accepted engineer');
    return r.rows[0];
  }

  private async requireCurrentEngineer(client: PoolClient, jobId: string, actor: Actor) {
    const a = await this.currentAssignment(client, jobId);
    if (a.engineer_id !== actor.id) {
      throw new ForbiddenException('actor is not the current accepted engineer for this job');
    }
    return a.id;
  }

  private async locationByRole(companyId: string, role: string) {
    const r = await this.pg.query<{ id: string }>(
      `SELECT id FROM fdn_inventory_locations WHERE company_id=$1 AND role=$2 AND is_active ORDER BY code LIMIT 1`,
      [companyId, role],
    );
    if (!r.rows[0]) throw new BadRequestException(`no active ${role} location configured for this company`);
    return r.rows[0].id;
  }

  // ================================================================ material issue

  async issueMaterial(jobId: string, dto: IssueMaterialDto, actor: Actor) {
    let issue: any;
    try {
      const [fromLoc, toLoc] = await Promise.all([
        this.locationByRole(actor.companyId, 'MAIN_STORE'),
        this.locationByRole(actor.companyId, 'ENGINEER_HELD'),
      ]);
      issue = await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor, true);

        const resv = await client.query(
          `SELECT * FROM br05_material_reservations WHERE id=$1 FOR UPDATE`, [dto.br05_material_reservation_id],
        );
        const r = resv.rows[0];
        if (!r || r.job_id !== jobId || r.company_id !== actor.companyId) {
          throw new NotFoundException('BR-05 reservation not found for this job');
        }

        const existing = await client.query(
          `SELECT * FROM br07_material_issues WHERE br05_material_reservation_id=$1`, [r.id],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].issue_status === 'PENDING_POST') return existing.rows[0]; // resume a partial post
          throw new BadRequestException('this reservation has already been issued');
        }
        if (r.reservation_status !== 'COMMITTED' || !r.inventory_reservation_ref) {
          throw new BadRequestException(
            `material issue requires a COMMITTED BR-05 reservation (this one is ${r.reservation_status})`,
          );
        }

        const line = await client.query<{ item_bridge_id: string; uom: string }>(
          `SELECT item_bridge_id, uom FROM br05_stock_recheck_lines WHERE id=$1`, [r.stock_recheck_line_id],
        );
        const item = await client.query<{ br01_item_id: string }>(
          `SELECT br01_item_id FROM br03_item_catalog_bridge WHERE id=$1`, [line.rows[0].item_bridge_id],
        );
        if (!item.rows[0]) throw new BadRequestException('item bridge row missing for this reservation');

        const assignment = await this.currentAssignment(client, jobId);

        const ins = await client.query(
          `INSERT INTO br07_material_issues
             (company_id,job_id,br05_job_release_id,br05_material_reservation_id,inventory_reservation_id,
              item_bridge_id,item_id,uom,issued_quantity,issued_to_engineer_id,assignment_id,
              from_location_id,to_location_id,issued_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [actor.companyId, jobId, r.job_release_id, r.id, r.inventory_reservation_ref, line.rows[0].item_bridge_id,
            item.rows[0].br01_item_id, line.rows[0].uom, r.reserved_quantity, assignment.engineer_id, assignment.id,
            fromLoc, toLoc, actor.id],
        );
        await this.audit(client, actor.companyId, actor.id, 'br07_material_issues', ins.rows[0].id,
          'BR07_MATERIAL_ISSUE_CREATED', null, ins.rows[0]);
        return ins.rows[0];
      });
    } catch (e) { this.rethrow(e); }

    // Ledger: physical ISSUE, then close the reservation it fulfils (otherwise
    // allocatable would subtract the same quantity twice). Both idempotent.
    const posted = await this.inventory.issue(
      {
        company_id: issue.company_id, item_id: issue.item_id, uom: issue.uom, qty: Number(issue.issued_quantity),
        from_location_id: issue.from_location_id, to_location_id: issue.to_location_id, reference_id: issue.id,
      } as any,
      `br07-issue-${issue.id}`,
      actor.id,
    );
    const reservation = await this.inventory.consumeReservation(issue.inventory_reservation_id);

    try {
      return await this.pg.tx(async (client) => {
        const r = await client.query(
          `UPDATE br07_material_issues SET issue_status='ISSUED', issue_movement_ref=$2, posted_at=now()
            WHERE id=$1 AND issue_status='PENDING_POST' RETURNING *`,
          [issue.id, posted.transaction_id],
        );
        const after = r.rows[0] ?? (await client.query(`SELECT * FROM br07_material_issues WHERE id=$1`, [issue.id])).rows[0];
        await this.audit(client, actor.companyId, actor.id, 'br07_material_issues', issue.id,
          'BR07_MATERIAL_ISSUED', issue, { ...after, ledger_reservation: reservation });
        return { ...after, ledger_reservation_status: reservation?.status, allocatable_after: posted.available_after };
      });
    } catch (e) { this.rethrow(e); }
  }

  async acknowledgeIssue(issueId: string, dto: AcknowledgeIssueDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const r = await client.query(`SELECT * FROM br07_material_issues WHERE id=$1 FOR UPDATE`, [issueId]);
        const before = r.rows[0];
        if (!before) throw new NotFoundException('material issue not found');
        if (before.company_id !== actor.companyId) throw new ForbiddenException('issue belongs to another company');
        if (before.issued_to_engineer_id !== actor.id) {
          throw new ForbiddenException('only the engineer the material was issued to can acknowledge custody');
        }
        await this.requireCurrentEngineer(client, before.job_id, actor);
        if (before.issue_status !== 'ISSUED') {
          throw new BadRequestException(`cannot acknowledge an issue in status ${before.issue_status}`);
        }
        const u = await client.query(
          `UPDATE br07_material_issues
              SET issue_status='ACKNOWLEDGED', acknowledged_by_id=$2, acknowledged_at=now(), acknowledgement_note=$3
            WHERE id=$1 RETURNING *`,
          [issueId, actor.id, dto.note ?? null],
        );
        await this.audit(client, actor.companyId, actor.id, 'br07_material_issues', issueId,
          'BR07_MATERIAL_CUSTODY_ACKNOWLEDGED', before, u.rows[0]);
        return u.rows[0];
      });
    } catch (e) { this.rethrow(e); }
  }

  // ================================================================ consumption

  async consume(issueId: string, dto: ConsumeMaterialDto, actor: Actor) {
    let row: any;
    try {
      row = await this.pg.tx(async (client) => {
        const i = await client.query(`SELECT company_id, job_id FROM br07_material_issues WHERE id=$1`, [issueId]);
        if (!i.rows[0]) throw new NotFoundException('material issue not found');
        if (i.rows[0].company_id !== actor.companyId) throw new ForbiddenException('issue belongs to another company');
        // Trigger enforces: ACKNOWLEDGED, holder == actor == current engineer, quantity headroom.
        const r = await client.query(
          `INSERT INTO br07_material_consumptions (company_id,job_id,issue_id,repair_session_id,quantity,consumed_by_id,note)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [actor.companyId, i.rows[0].job_id, issueId, dto.repair_session_id ?? null, dto.quantity, actor.id,
            dto.note ?? null],
        );
        await this.audit(client, actor.companyId, actor.id, 'br07_material_consumptions', r.rows[0].id,
          'BR07_CONSUMPTION_RECORDED', null, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) { this.rethrow(e); }
    return this.postConsumption(row.id, actor);
  }

  /** Posts (or resumes posting) a PENDING_POST consumption to the ledger. */
  async postConsumption(consumptionId: string, actor: Actor) {
    const c = await this.pg.query(
      `SELECT c.*, i.item_id, i.uom, i.to_location_id AS held_location_id
         FROM br07_material_consumptions c JOIN br07_material_issues i ON i.id=c.issue_id WHERE c.id=$1`,
      [consumptionId],
    );
    const row = c.rows[0];
    if (!row) throw new NotFoundException('consumption not found');
    if (row.company_id !== actor.companyId) throw new ForbiddenException('consumption belongs to another company');
    if (row.consumption_status === 'POSTED') return row;
    if (row.consumed_by_id !== actor.id) throw new ForbiddenException('only the consuming engineer can post this');

    const consumedLoc = await this.locationByRole(row.company_id, 'CONSUMED');
    const posted = await this.inventory.consume(
      {
        company_id: row.company_id, item_id: row.item_id, uom: row.uom, qty: Number(row.quantity),
        from_location_id: row.held_location_id, to_location_id: consumedLoc, reference_id: row.id,
      } as any,
      `br07-consume-${row.id}`,
      actor.id,
    );
    try {
      return await this.pg.tx(async (client) => {
        const u = await client.query(
          `UPDATE br07_material_consumptions SET consumption_status='POSTED', movement_ref=$2, posted_at=now()
            WHERE id=$1 AND consumption_status='PENDING_POST' RETURNING *`,
          [row.id, posted.transaction_id],
        );
        const after = u.rows[0] ?? (await client.query(`SELECT * FROM br07_material_consumptions WHERE id=$1`, [row.id])).rows[0];
        await this.audit(client, row.company_id, actor.id, 'br07_material_consumptions', row.id,
          'BR07_CONSUMPTION_POSTED', row, after);
        return after;
      });
    } catch (e) { this.rethrow(e); }
  }

  // ================================================================ unused return

  async requestReturn(issueId: string, dto: RequestReturnDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const i = await client.query(`SELECT company_id, job_id FROM br07_material_issues WHERE id=$1`, [issueId]);
        if (!i.rows[0]) throw new NotFoundException('material issue not found');
        if (i.rows[0].company_id !== actor.companyId) throw new ForbiddenException('issue belongs to another company');
        const r = await client.query(
          `INSERT INTO br07_material_returns (company_id,job_id,issue_id,quantity,return_reason,requested_by_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [actor.companyId, i.rows[0].job_id, issueId, dto.quantity, dto.return_reason ?? null, actor.id],
        );
        await this.audit(client, actor.companyId, actor.id, 'br07_material_returns', r.rows[0].id,
          'BR07_RETURN_REQUESTED', null, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) { this.rethrow(e); }
  }

  /** Purchase verifies (-> ledger RETURN to MAIN_STORE) or rejects. Re-calling on a
   *  VERIFIED-but-unposted return resumes the ledger post. */
  async verifyReturn(returnId: string, dto: VerifyReturnDto, actor: Actor) {
    let ret: any;
    try {
      ret = await this.pg.tx(async (client) => {
        const r = await client.query(`SELECT * FROM br07_material_returns WHERE id=$1 FOR UPDATE`, [returnId]);
        const before = r.rows[0];
        if (!before) throw new NotFoundException('return not found');
        if (before.company_id !== actor.companyId) throw new ForbiddenException('return belongs to another company');
        if (before.return_status === 'VERIFIED' && !before.movement_ref) return before; // resume
        if (before.return_status !== 'REQUESTED') throw new BadRequestException(`return already ${before.return_status}`);

        const status = dto.decision === 'VERIFY' ? 'VERIFIED' : 'REJECTED';
        const u = await client.query(
          `UPDATE br07_material_returns
              SET return_status=$2, verified_by_id=$3, verified_at=now(), verification_note=$4
            WHERE id=$1 RETURNING *`,
          [returnId, status, actor.id, dto.note ?? null],
        );
        await this.audit(client, actor.companyId, actor.id, 'br07_material_returns', returnId,
          status === 'VERIFIED' ? 'BR07_RETURN_VERIFIED' : 'BR07_RETURN_REJECTED', before, u.rows[0]);
        return u.rows[0];
      });
    } catch (e) { this.rethrow(e); }
    if (ret.return_status !== 'VERIFIED') return ret;

    const issue = (await this.pg.query(`SELECT * FROM br07_material_issues WHERE id=$1`, [ret.issue_id])).rows[0];
    const posted = await this.inventory.returnMaterial(
      {
        company_id: issue.company_id, item_id: issue.item_id, uom: issue.uom, qty: Number(ret.quantity),
        from_location_id: issue.to_location_id, to_location_id: issue.from_location_id, reference_id: ret.id,
      } as any,
      `br07-return-${ret.id}`,
      actor.id,
    );
    try {
      return await this.pg.tx(async (client) => {
        const u = await client.query(
          `UPDATE br07_material_returns SET movement_ref=$2, posted_at=now() WHERE id=$1 AND movement_ref IS NULL RETURNING *`,
          [ret.id, posted.transaction_id],
        );
        const after = u.rows[0] ?? (await client.query(`SELECT * FROM br07_material_returns WHERE id=$1`, [ret.id])).rows[0];
        await this.audit(client, actor.companyId, actor.id, 'br07_material_returns', ret.id,
          'BR07_RETURN_POSTED', ret, after);
        return { ...after, allocatable_after: posted.available_after };
      });
    } catch (e) { this.rethrow(e); }
  }

  async listMaterial(jobId: string, actor: Actor) {
    await this.loadJob(this.pg, jobId, actor);
    const [issues, consumptions, returns] = await Promise.all([
      this.pg.query(`SELECT * FROM br07_material_issues WHERE job_id=$1 ORDER BY created_at`, [jobId]),
      this.pg.query(`SELECT * FROM br07_material_consumptions WHERE job_id=$1 ORDER BY created_at`, [jobId]),
      this.pg.query(`SELECT * FROM br07_material_returns WHERE job_id=$1 ORDER BY requested_at`, [jobId]),
    ]);
    return { issues: issues.rows, consumptions: consumptions.rows, returns: returns.rows };
  }

  // ================================================================ repair sessions

  async startRepairSession(jobId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor, true);
        const assignmentId = await this.requireCurrentEngineer(client, jobId, actor);
        const s = await client.query(
          `INSERT INTO br07_repair_sessions (company_id,job_id,assignment_id,engineer_id) VALUES ($1,$2,$3,$4) RETURNING *`,
          [actor.companyId, jobId, assignmentId, actor.id],
        );
        await client.query(
          `INSERT INTO br07_repair_time_segments (session_id,segment_type,started_at,is_active_time)
           VALUES ($1,'ACTIVE',now(),true)`, [s.rows[0].id],
        );
        await this.audit(client, actor.companyId, actor.id, 'br07_repair_sessions', s.rows[0].id,
          'BR07_REPAIR_SESSION_STARTED', null, s.rows[0]);
        return s.rows[0];
      });
    } catch (e) {
      if ((e as any)?.constraint === 'br07_one_open_repair_session_per_job') {
        throw new BadRequestException('a repair session is already open for this job');
      }
      this.rethrow(e);
    }
  }

  private async loadSession(client: PoolClient, sessionId: string, actor: Actor) {
    const r = await client.query(`SELECT * FROM br07_repair_sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
    if (!r.rows[0]) throw new NotFoundException('repair session not found');
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('session belongs to another company');
    if (r.rows[0].engineer_id !== actor.id) throw new ForbiddenException('session belongs to another engineer');
    return r.rows[0];
  }

  async pauseRepairSession(sessionId: string, dto: PauseRepairSessionDto, actor: Actor) {
    return this.transitionSession(sessionId, actor, 'ACTIVE', 'PAUSED', 'BR07_REPAIR_SESSION_PAUSED', dto);
  }

  async resumeRepairSession(sessionId: string, actor: Actor) {
    return this.transitionSession(sessionId, actor, 'PAUSED', 'ACTIVE', 'BR07_REPAIR_SESSION_RESUMED');
  }

  async stopRepairSession(sessionId: string, actor: Actor) {
    return this.transitionSession(sessionId, actor, null, 'COMPLETED', 'BR07_REPAIR_SESSION_STOPPED');
  }

  private async transitionSession(
    sessionId: string, actor: Actor, from: string | null, to: 'ACTIVE' | 'PAUSED' | 'COMPLETED', action: string,
    pause?: PauseRepairSessionDto,
  ) {
    try {
      return await this.pg.tx(async (client) => {
        const s = await this.loadSession(client, sessionId, actor);
        const allowed = from ? [from] : ['ACTIVE', 'PAUSED'];
        if (!allowed.includes(s.status)) throw new BadRequestException(`session is ${s.status}`);

        await client.query(`UPDATE br07_repair_time_segments SET ended_at=now() WHERE session_id=$1 AND ended_at IS NULL`, [sessionId]);
        if (to === 'PAUSED') {
          await client.query(
            `INSERT INTO br07_repair_time_segments (session_id,segment_type,started_at,pause_reason,pause_category,is_active_time)
             VALUES ($1,'PAUSED',now(),$2,$3,false)`,
            [sessionId, pause!.pause_reason, pause!.pause_category ?? null],
          );
        } else if (to === 'ACTIVE') {
          await client.query(
            `INSERT INTO br07_repair_time_segments (session_id,segment_type,started_at,is_active_time)
             VALUES ($1,'ACTIVE',now(),true)`, [sessionId],
          );
        }
        const u = await client.query(
          `UPDATE br07_repair_sessions SET status=$2::varchar,
                  completed_at=CASE WHEN $2::varchar='COMPLETED' THEN now() ELSE completed_at END
            WHERE id=$1 RETURNING *`,
          [sessionId, to],
        );
        await this.audit(client, actor.companyId, actor.id, 'br07_repair_sessions', sessionId, action, s, u.rows[0]);
        return u.rows[0];
      });
    } catch (e) { this.rethrow(e); }
  }

  async getRepairSessions(jobId: string, actor: Actor) {
    await this.loadJob(this.pg, jobId, actor);
    const [sessions, totals] = await Promise.all([
      this.pg.query(`SELECT * FROM br07_repair_sessions WHERE job_id=$1 ORDER BY started_at`, [jobId]),
      this.pg.query(`SELECT * FROM br07_v_repair_time_totals WHERE job_id=$1`, [jobId]),
    ]);
    return { sessions: sessions.rows, time_totals: totals.rows };
  }

  // ================================================================ repair report + test SLA

  /**
   * Test-start SLA descriptor. due_at is the instance's stored due time (computed
   * by br07_test_sla_due from the working calendar when the clock opened), or
   * null with a reason when it could not be computed.
   */
  private async testSla(client: Queryable, companyId: string, priority: string, dueAt: Date | string | null = null) {
    const [t, cal] = await Promise.all([
      client.query(`SELECT target_amount, target_unit FROM br07_test_sla_targets WHERE priority=$1`, [priority]),
      client.query(`SELECT count(*)::int AS n FROM working_calendars WHERE company_id=$1 AND is_active`, [companyId]),
    ]);
    return {
      event_code: TEST_SLA_EVENT,
      priority,
      target: t.rows[0] ? `${t.rows[0].target_amount} ${t.rows[0].target_unit}` : null,
      due_at: dueAt,
      due_at_reason: dueAt
        ? null
        : cal.rows[0].n > 0
          ? 'NO_OPEN_SLA_INSTANCE (clock not started, or opened before the calendar was activated)'
          : 'NO_ACTIVE_WORKING_CALENDAR (configure working_calendars for this company)',
    };
  }

  async submitRepairReport(jobId: string, dto: SubmitRepairReportDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const job = await this.loadJob(client, jobId, actor, true);
        const assignmentId = await this.requireCurrentEngineer(client, jobId, actor);

        let report = (await client.query(`SELECT * FROM br07_repair_reports WHERE job_id=$1 FOR UPDATE`, [jobId])).rows[0];
        if (!report) {
          report = (await client.query(
            `INSERT INTO br07_repair_reports (company_id,job_id,engineer_id) VALUES ($1,$2,$3) RETURNING *`,
            [actor.companyId, jobId, actor.id],
          )).rows[0];
        }
        const versionNo = report.current_version_no + 1;
        const v = await client.query(
          `INSERT INTO br07_repair_report_versions
             (report_id,version_no,engineer_id,assignment_id,work_performed,root_cause,parts_replaced_summary)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [report.id, versionNo, actor.id, assignmentId, dto.work_performed, dto.root_cause ?? null,
            dto.parts_replaced_summary ?? null],
        );
        const updated = await client.query(
          `UPDATE br07_repair_reports SET current_version_no=$2, status='SUBMITTED', engineer_id=$3, updated_at=now()
            WHERE id=$1 RETURNING *`,
          [report.id, versionNo, actor.id],
        );

        // Ready-for-test: open the test-start SLA clock unless one is already
        // running for this job (a re-submission before testing keeps the
        // original readiness time). due_at from the working calendar
        // (br07_test_sla_due; NULL only if the company has no active calendar).
        let sla = (await client.query(
          `SELECT * FROM sla_instances WHERE job_id=$1 AND event_code=$2 AND completed_at IS NULL`, [jobId, TEST_SLA_EVENT],
        )).rows[0];
        if (!sla) {
          sla = (await client.query(
            `INSERT INTO sla_instances (company_id,job_id,assignment_id,event_code,started_at,due_at)
             VALUES ($1,$2,$3,$4,now(),br07_test_sla_due($1,$5,now())) RETURNING *`,
            [actor.companyId, jobId, assignmentId, TEST_SLA_EVENT, job.priority],
          )).rows[0];
        }
        await this.audit(client, actor.companyId, actor.id, 'br07_repair_report_versions', v.rows[0].id,
          'BR07_REPAIR_REPORT_SUBMITTED', null, { version: v.rows[0], sla_instance_id: sla.id });
        return {
          report: updated.rows[0], version: v.rows[0],
          test_sla: { ...(await this.testSla(client, actor.companyId, job.priority, sla.due_at)), sla_instance_id: sla.id, started_at: sla.started_at },
        };
      });
    } catch (e) { this.rethrow(e); }
  }

  async getRepairReport(jobId: string, actor: Actor) {
    await this.loadJob(this.pg, jobId, actor);
    const report = (await this.pg.query(`SELECT * FROM br07_repair_reports WHERE job_id=$1`, [jobId])).rows[0];
    if (!report) throw new NotFoundException('repair report not found for this job');
    const versions = await this.pg.query(
      `SELECT * FROM br07_repair_report_versions WHERE report_id=$1 ORDER BY version_no`, [report.id],
    );
    return { ...report, versions: versions.rows };
  }

  // ================================================================ test runs

  async startTestRun(jobId: string, dto: StartTestRunDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const job = await this.loadJob(client, jobId, actor, true);
        const assignmentId = await this.requireCurrentEngineer(client, jobId, actor);

        const latest = (await client.query(
          `SELECT v.id FROM br07_repair_reports r
             JOIN br07_repair_report_versions v ON v.report_id=r.id AND v.version_no=r.current_version_no
            WHERE r.job_id=$1 AND r.status='SUBMITTED'`, [jobId],
        )).rows[0];
        if (!latest) throw new BadRequestException('submit a repair report before testing');

        // Test started => close the test-start SLA clock: MET if on/before due_at,
        // else BREACHED. State stays as-is only when due_at is NULL (no calendar).
        const sla = (await client.query(
          `UPDATE sla_instances
              SET completed_at=now(),
                  state=CASE WHEN due_at IS NULL THEN state WHEN now()<=due_at THEN 'MET' ELSE 'BREACHED' END
            WHERE job_id=$1 AND event_code=$2 AND completed_at IS NULL RETURNING *`,
          [jobId, TEST_SLA_EVENT],
        )).rows[0];

        // cycle_no is assigned by the DB trigger (caller value ignored).
        const t = await client.query(
          `INSERT INTO br07_test_runs
             (company_id,job_id,repair_report_version_id,cycle_no,engineer_id,assignment_id,test_procedure,sla_instance_id)
           VALUES ($1,$2,$3,1,$4,$5,$6,$7) RETURNING *`,
          [actor.companyId, jobId, latest.id, actor.id, assignmentId, dto.test_procedure, sla?.id ?? null],
        );
        await this.audit(client, actor.companyId, actor.id, 'br07_test_runs', t.rows[0].id,
          'BR07_TEST_RUN_STARTED', null, { run: t.rows[0], sla_instance: sla ?? null });
        return {
          ...t.rows[0],
          test_sla: sla
            ? { ...(await this.testSla(client, actor.companyId, job.priority, sla.due_at)), sla_instance_id: sla.id,
                started_at: sla.started_at, completed_at: sla.completed_at, state: sla.state, outcome: sla.due_at ? sla.state : 'UNDETERMINED' }
            : null,
        };
      });
    } catch (e) {
      if ((e as any)?.constraint === 'br07_one_open_test_run_per_job') {
        throw new BadRequestException('a test run is already open for this job; record its result first');
      }
      this.rethrow(e);
    }
  }

  async recordTestResult(testRunId: string, dto: RecordTestResultDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const r = await client.query(`SELECT * FROM br07_test_runs WHERE id=$1 FOR UPDATE`, [testRunId]);
        const before = r.rows[0];
        if (!before) throw new NotFoundException('test run not found');
        if (before.company_id !== actor.companyId) throw new ForbiddenException('test run belongs to another company');
        await this.requireCurrentEngineer(client, before.job_id, actor);
        if (before.result) {
          throw new BadRequestException(`test result already recorded as ${before.result}; recorded results are immutable`);
        }
        const u = await client.query(
          `UPDATE br07_test_runs SET result=$2, observations=$3, completed_at=now(), result_recorded_by_id=$4
            WHERE id=$1 RETURNING *`,
          [testRunId, dto.result, dto.observations ?? null, actor.id],
        );
        const pending = await client.query<{ p: boolean }>(`SELECT br07_failure_review_pending($1) AS p`, [before.job_id]);
        const fails = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM br07_test_runs WHERE job_id=$1 AND result='FAIL'`, [before.job_id],
        );
        await this.audit(client, actor.companyId, actor.id, 'br07_test_runs', testRunId,
          dto.result === 'PASS' ? 'BR07_TEST_PASSED' : 'BR07_TEST_FAILED', before, u.rows[0]);
        return { ...u.rows[0], failed_cycles: fails.rows[0].n, purchase_review_required: pending.rows[0].p };
      });
    } catch (e) { this.rethrow(e); }
  }

  async getTestRuns(jobId: string, actor: Actor) {
    const job = await this.loadJob(this.pg, jobId, actor);
    const [runs, reviews, pending, slas] = await Promise.all([
      this.pg.query(`SELECT * FROM br07_test_runs WHERE job_id=$1 ORDER BY cycle_no`, [jobId]),
      this.pg.query(`SELECT * FROM br07_test_failure_reviews WHERE job_id=$1 ORDER BY reviewed_at`, [jobId]),
      this.pg.query<{ p: boolean }>(`SELECT br07_failure_review_pending($1) AS p`, [jobId]),
      this.pg.query(`SELECT * FROM sla_instances WHERE job_id=$1 AND event_code=$2 ORDER BY started_at`, [jobId, TEST_SLA_EVENT]),
    ]);
    return {
      runs: runs.rows,
      failed_cycles: runs.rows.filter((r) => r.result === 'FAIL').length,
      purchase_review_required: pending.rows[0].p,
      reviews: reviews.rows,
      test_sla: {
        ...(await this.testSla(this.pg, actor.companyId, job.priority, slas.rows.at(-1)?.due_at ?? null)),
        instances: slas.rows,
      },
    };
  }

  // ================================================================ two-fail Purchase review

  async reviewFailures(jobId: string, dto: FailureReviewDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor, true);
        const last = (await client.query(
          `SELECT * FROM br07_test_runs WHERE job_id=$1 AND result IS NOT NULL ORDER BY cycle_no DESC LIMIT 1`, [jobId],
        )).rows[0];
        if (!last) throw new BadRequestException('job has no completed test cycles');
        // Trigger enforces: reviewer is PURCHASE, run is the latest FAIL, >=2 fails.
        const r = await client.query(
          `INSERT INTO br07_test_failure_reviews
             (company_id,job_id,reviewed_test_run_id,failed_cycles_at_review,decision,review_comment,reviewed_by_id)
           VALUES ($1,$2,$3,2,$4,$5,$6) RETURNING *`,
          [actor.companyId, jobId, last.id, dto.decision, dto.comment, actor.id],
        );
        await this.audit(client, actor.companyId, actor.id, 'br07_test_failure_reviews', r.rows[0].id,
          'BR07_TEST_FAILURE_REVIEWED', null, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if ((e as any)?.constraint === 'br07_test_failure_reviews_reviewed_test_run_id_key') {
        throw new BadRequestException('the latest failed cycle has already been reviewed');
      }
      this.rethrow(e);
    }
  }

  // ================================================================ handoff + dispatch release

  async technicalHandoff(jobId: string, dto: TechnicalHandoffDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor, true);
        await this.requireCurrentEngineer(client, jobId, actor);
        const last = (await client.query(
          `SELECT * FROM br07_test_runs WHERE job_id=$1 ORDER BY cycle_no DESC LIMIT 1`, [jobId],
        )).rows[0];
        if (!last) throw new BadRequestException('job has no test cycles');
        // Trigger enforces: latest cycle is PASS, nothing open, no STOP review.
        const h = await client.query(
          `INSERT INTO br07_technical_handoffs (company_id,job_id,test_run_id,engineer_id,handoff_note)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [actor.companyId, jobId, last.id, actor.id, dto.note ?? null],
        );
        await this.audit(client, actor.companyId, actor.id, 'br07_technical_handoffs', h.rows[0].id,
          'BR07_TECHNICAL_HANDOFF', null, h.rows[0]);
        return h.rows[0];
      });
    } catch (e) {
      if ((e as any)?.constraint === 'br07_technical_handoffs_test_run_id_key') {
        throw new BadRequestException('this passing test cycle has already been handed off');
      }
      this.rethrow(e);
    }
  }

  async dispatchRelease(jobId: string, dto: DispatchReleaseDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor, true);
        const h = (await client.query(
          `SELECT * FROM br07_technical_handoffs WHERE job_id=$1 ORDER BY handed_off_at DESC LIMIT 1`, [jobId],
        )).rows[0];
        if (!h) throw new BadRequestException('no technical handoff exists for this job');
        // Trigger enforces: releaser is PURCHASE; handoff's PASS is still current.
        const r = await client.query(
          `INSERT INTO br07_dispatch_releases (company_id,job_id,handoff_id,released_by_id,release_note)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [actor.companyId, jobId, h.id, actor.id, dto.note ?? null],
        );
        await this.audit(client, actor.companyId, actor.id, 'br07_dispatch_releases', r.rows[0].id,
          'BR07_DISPATCH_RELEASED', null, r.rows[0]);
        // BR-08 dispatch/invoice is NOT created here (still client-blocked).
        return { ...r.rows[0], outstanding_engineer_held_qty: Number(h.outstanding_engineer_held_qty) };
      });
    } catch (e) {
      if ((e as any)?.constraint === 'br07_dispatch_releases_job_id_key') {
        throw new BadRequestException('job is already dispatch-released');
      }
      this.rethrow(e);
    }
  }

  async getRepairStatus(jobId: string, actor: Actor) {
    await this.loadJob(this.pg, jobId, actor);
    const [material, sessions, tests, handoffs, release] = await Promise.all([
      this.listMaterial(jobId, actor),
      this.getRepairSessions(jobId, actor),
      this.getTestRuns(jobId, actor),
      this.pg.query(`SELECT * FROM br07_technical_handoffs WHERE job_id=$1 ORDER BY handed_off_at`, [jobId]),
      this.pg.query(`SELECT * FROM br07_dispatch_releases WHERE job_id=$1`, [jobId]),
    ]);
    const report = (await this.pg.query(`SELECT * FROM br07_repair_reports WHERE job_id=$1`, [jobId])).rows[0] ?? null;
    return {
      material, repair_sessions: sessions, repair_report: report, tests,
      handoffs: handoffs.rows, dispatch_release: release.rows[0] ?? null,
    };
  }
}
