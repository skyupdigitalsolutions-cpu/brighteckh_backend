import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgService } from '../../common/database/pg.service';
import {
  AddInspectionMediaDto, AddMaterialLineDto, CreateChangeRequestDto, CreateMaterialRequestDto,
  CustodyAckDto, PauseSessionDto, ReviewChangeRequestDto, ReviewInspectionDto, SubmitInspectionVersionDto,
} from './dto/br03.dto';

interface Actor { id: string; role: string; companyId: string }

/**
 * BR-03: custody acknowledgement -> time-tracked inspection session -> versioned
 * inspection report -> Purchase accept/return -> material requirement submitted
 * DIRECT to Purchase (no approval gate; only the inspection report is reviewed).
 * Edit-lock: on submit self_edit_deadline_at = 1 WORKING hour later, from the
 * company's active working calendar (migration 012, br03_self_edit_deadline).
 * br03_can_engineer_edit() locks at that deadline OR when Purchase starts
 * processing, whichever is first. A company with no active calendar gets NULL,
 * which the DB treats as "locked immediately" (change-request path only).
 */
@Injectable()
export class Br03Service {
  constructor(private readonly pg: PgService) {}

  private mapErr(e: unknown): never {
    const m = (e as Error).message || '';
    throw new BadRequestException(m);
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

  private async loadJob(client: PoolClient, jobId: string, actor: Actor) {
    const r = await client.query<{ company_id: string; unit_id: string; status: string }>(
      `SELECT company_id, unit_id, status FROM service_jobs WHERE id=$1 FOR UPDATE`, [jobId],
    );
    if (!r.rows[0]) throw new NotFoundException('job not found');
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    return r.rows[0];
  }

  private async currentAssignment(client: PoolClient, jobId: string, actor: Actor) {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM job_assignments WHERE job_id=$1 AND engineer_id=$2 AND is_current AND response='ACCEPTED'`,
      [jobId, actor.id],
    );
    if (!r.rows[0]) throw new BadRequestException('actor is not the current accepted engineer for this job');
    return r.rows[0].id;
  }

  // ---------------------------------------------------------------- custody

  async custodyAck(jobId: string, dto: CustodyAckDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const job = await this.loadJob(client, jobId, actor);

        const a = await client.query<{ id: string }>(
          `SELECT id FROM job_assignments
            WHERE job_id=$1 AND engineer_id=$2 AND is_current AND response='PENDING' FOR UPDATE`,
          [jobId, actor.id],
        );
        if (!a.rows[0]) {
          throw new BadRequestException('no pending assignment for this engineer on this job');
        }

        await client.query(
          `UPDATE job_assignments SET response='ACCEPTED', responded_at=now() WHERE id=$1`, [a.rows[0].id],
        );

        const ack = await client.query(
          `INSERT INTO br03_custody_acknowledgements (company_id,job_id,assignment_id,unit_id,engineer_id,condition_note)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [actor.companyId, jobId, a.rows[0].id, job.unit_id, actor.id, dto.condition_note ?? null],
        );
        await client.query(`UPDATE service_jobs SET status='ACCEPTED' WHERE id=$1`, [jobId]);
        await this.audit(client, actor.companyId, actor.id, 'br03_custody_acknowledgements', ack.rows[0].id,
          'BR03_CUSTODY_ACKNOWLEDGED', null, ack.rows[0]);
        return ack.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  // ---------------------------------------------------------------- inspection sessions

  async startSession(jobId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);
        const assignmentId = await this.currentAssignment(client, jobId, actor);

        const open = await client.query(
          `SELECT id FROM br03_inspection_sessions
            WHERE job_id=$1 AND completed_at IS NULL AND status IN ('ACTIVE','PAUSED')`, [jobId],
        );
        if (open.rows[0]) throw new BadRequestException('an inspection session is already open for this job');

        const session = await client.query(
          `INSERT INTO br03_inspection_sessions (company_id,job_id,assignment_id,engineer_id)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [actor.companyId, jobId, assignmentId, actor.id],
        );
        await client.query(
          `INSERT INTO br03_time_segments (session_id,segment_type,started_at,is_active_time)
           VALUES ($1,'ACTIVE',now(),true)`,
          [session.rows[0].id],
        );
        await client.query(`UPDATE service_jobs SET status='INSPECTION' WHERE id=$1 AND status<>'INSPECTION'`, [jobId]);
        await this.audit(client, actor.companyId, actor.id, 'br03_inspection_sessions', session.rows[0].id,
          'BR03_SESSION_STARTED', null, session.rows[0]);
        return session.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  private async loadSession(client: PoolClient, sessionId: string, actor: Actor) {
    const r = await client.query<{ company_id: string; engineer_id: string; status: string }>(
      `SELECT company_id, engineer_id, status FROM br03_inspection_sessions WHERE id=$1 FOR UPDATE`, [sessionId],
    );
    if (!r.rows[0]) throw new NotFoundException('inspection session not found');
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('session belongs to another company');
    if (r.rows[0].engineer_id !== actor.id) throw new ForbiddenException('session belongs to another engineer');
    return r.rows[0];
  }

  async pauseSession(sessionId: string, dto: PauseSessionDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const s = await this.loadSession(client, sessionId, actor);
        if (s.status !== 'ACTIVE') throw new BadRequestException('session is not active');

        await client.query(
          `UPDATE br03_time_segments SET ended_at=now() WHERE session_id=$1 AND ended_at IS NULL`, [sessionId],
        );
        await client.query(
          `INSERT INTO br03_time_segments (session_id,segment_type,started_at,pause_reason,pause_category,is_active_time)
           VALUES ($1,'PAUSED',now(),$2,$3,false)`,
          [sessionId, dto.pause_reason, dto.pause_category ?? null],
        );
        const updated = await client.query(
          `UPDATE br03_inspection_sessions SET status='PAUSED' WHERE id=$1 RETURNING *`, [sessionId],
        );
        await this.audit(client, actor.companyId, actor.id, 'br03_inspection_sessions', sessionId,
          'BR03_SESSION_PAUSED', s, updated.rows[0]);
        return updated.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async resumeSession(sessionId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const s = await this.loadSession(client, sessionId, actor);
        if (s.status !== 'PAUSED') throw new BadRequestException('session is not paused');

        await client.query(
          `UPDATE br03_time_segments SET ended_at=now() WHERE session_id=$1 AND ended_at IS NULL`, [sessionId],
        );
        await client.query(
          `INSERT INTO br03_time_segments (session_id,segment_type,started_at,is_active_time)
           VALUES ($1,'ACTIVE',now(),true)`,
          [sessionId],
        );
        const updated = await client.query(
          `UPDATE br03_inspection_sessions SET status='ACTIVE' WHERE id=$1 RETURNING *`, [sessionId],
        );
        await this.audit(client, actor.companyId, actor.id, 'br03_inspection_sessions', sessionId,
          'BR03_SESSION_RESUMED', s, updated.rows[0]);
        return updated.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async stopSession(sessionId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const s = await this.loadSession(client, sessionId, actor);
        if (!['ACTIVE', 'PAUSED'].includes(s.status)) throw new BadRequestException('session is already closed');

        await client.query(
          `UPDATE br03_time_segments SET ended_at=now() WHERE session_id=$1 AND ended_at IS NULL`, [sessionId],
        );
        const updated = await client.query(
          `UPDATE br03_inspection_sessions SET status='COMPLETED', completed_at=now() WHERE id=$1 RETURNING *`,
          [sessionId],
        );
        await this.audit(client, actor.companyId, actor.id, 'br03_inspection_sessions', sessionId,
          'BR03_SESSION_STOPPED', s, updated.rows[0]);
        return updated.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getSessions(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    const sessions = await this.pg.query(
      `SELECT * FROM br03_inspection_sessions WHERE job_id=$1 ORDER BY started_at`, [jobId],
    );
    const totals = await this.pg.query(
      `SELECT * FROM br03_v_engineer_time_totals WHERE job_id=$1`, [jobId],
    );
    return { sessions: sessions.rows, time_totals: totals.rows };
  }

  // ---------------------------------------------------------------- inspection reports

  async getOrCreateReport(jobId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);
        const existing = await client.query(`SELECT * FROM br03_inspection_reports WHERE job_id=$1`, [jobId]);
        if (existing.rows[0]) return existing.rows[0];

        const r = await client.query(
          `INSERT INTO br03_inspection_reports (company_id,job_id,engineer_id) VALUES ($1,$2,$3) RETURNING *`,
          [actor.companyId, jobId, actor.id],
        );
        await this.audit(client, actor.companyId, actor.id, 'br03_inspection_reports', r.rows[0].id,
          'BR03_INSPECTION_REPORT_CREATED', null, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException) throw e;
      this.mapErr(e);
    }
  }

  async getReportByJob(jobId: string, actor: Actor) {
    const job = await this.pg.query<{ company_id: string }>(`SELECT company_id FROM service_jobs WHERE id=$1`, [jobId]);
    if (!job.rows[0]) throw new NotFoundException('job not found');
    if (job.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
    const report = await this.pg.query(`SELECT * FROM br03_inspection_reports WHERE job_id=$1`, [jobId]);
    if (!report.rows[0]) throw new NotFoundException('inspection report not found for this job');
    const versions = await this.pg.query(
      `SELECT * FROM br03_inspection_report_versions WHERE report_id=$1 ORDER BY version_no`, [report.rows[0].id],
    );
    return { ...report.rows[0], versions: versions.rows };
  }

  private async loadReport(client: PoolClient, reportId: string, actor: Actor) {
    const r = await client.query(`SELECT * FROM br03_inspection_reports WHERE id=$1 FOR UPDATE`, [reportId]);
    if (!r.rows[0]) throw new NotFoundException('inspection report not found');
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('report belongs to another company');
    return r.rows[0];
  }

  async addMedia(reportId: string, dto: AddInspectionMediaDto, actor: Actor) {
    const report = await this.pg.query(`SELECT company_id, job_id FROM br03_inspection_reports WHERE id=$1`, [reportId]);
    if (!report.rows[0]) throw new NotFoundException('inspection report not found');
    if (report.rows[0].company_id !== actor.companyId) throw new ForbiddenException('report belongs to another company');

    const r = await this.pg.query(
      `INSERT INTO br03_inspection_media (report_id,version_id,job_id,media_type,file_uri,file_name,uploaded_by_id,customer_visible)
       VALUES ($1,NULL,$2,$3,$4,$5,$6,COALESCE($7,false)) RETURNING *`,
      [reportId, report.rows[0].job_id, dto.media_type, dto.file_uri, dto.file_name, actor.id, dto.customer_visible ?? null],
    );
    return r.rows[0];
  }

  async submitInspectionVersion(reportId: string, dto: SubmitInspectionVersionDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const report = await this.loadReport(client, reportId, actor);
        const assignmentId = await this.currentAssignment(client, report.job_id, actor);

        const versionNo = report.status === 'DRAFT' ? 0 : report.current_version_no + 1;

        const v = await client.query(
          `INSERT INTO br03_inspection_report_versions
             (report_id,version_no,assignment_id,engineer_id,inspection_description,outcome,amendment_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [reportId, versionNo, assignmentId, actor.id, dto.inspection_description, dto.outcome,
            dto.amendment_reason ?? null],
        );
        const updated = await client.query(
          `UPDATE br03_inspection_reports
              SET current_version_no=$2, status='SUBMITTED', updated_at=now()
            WHERE id=$1 RETURNING *`,
          [reportId, versionNo],
        );
        await this.audit(client, actor.companyId, actor.id, 'br03_inspection_report_versions', v.rows[0].id,
          'BR03_INSPECTION_VERSION_SUBMITTED', null, v.rows[0]);
        return { report: updated.rows[0], version: v.rows[0] };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async reviewInspection(reportId: string, dto: ReviewInspectionDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const report = await this.loadReport(client, reportId, actor);
        if (report.status !== 'SUBMITTED') throw new BadRequestException('report has no pending submission to review');

        const version = await client.query(
          `SELECT * FROM br03_inspection_report_versions WHERE report_id=$1 AND version_no=$2 FOR UPDATE`,
          [reportId, report.current_version_no],
        );
        if (!version.rows[0]) throw new NotFoundException('current inspection version not found');

        const newVersionStatus = dto.decision === 'ACCEPT' ? 'ACCEPTED' : 'RETURNED';
        const updatedVersion = await client.query(
          `UPDATE br03_inspection_report_versions SET version_status=$2 WHERE id=$1 RETURNING *`,
          [version.rows[0].id, newVersionStatus],
        );
        await client.query(
          `INSERT INTO br03_inspection_reviews (version_id,reviewer_id,review_decision,review_comment)
           VALUES ($1,$2,$3,$4)`,
          [version.rows[0].id, actor.id, dto.decision, dto.comment ?? null],
        );
        const updatedReport = await client.query(
          `UPDATE br03_inspection_reports
              SET status=$2::varchar, latest_outcome=CASE WHEN $2::varchar='ACCEPTED' THEN $3 ELSE latest_outcome END, updated_at=now()
            WHERE id=$1 RETURNING *`,
          [reportId, newVersionStatus, version.rows[0].outcome],
        );
        await this.audit(client, actor.companyId, actor.id, 'br03_inspection_report_versions', version.rows[0].id,
          dto.decision === 'ACCEPT' ? 'BR03_INSPECTION_ACCEPTED' : 'BR03_INSPECTION_RETURNED',
          version.rows[0], updatedVersion.rows[0]);
        return { report: updatedReport.rows[0], version: updatedVersion.rows[0] };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  // ---------------------------------------------------------------- material requests

  async createMaterialRequest(jobId: string, dto: CreateMaterialRequestDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.loadJob(client, jobId, actor);

        const acceptedVersion = await client.query(
          `SELECT v.id FROM br03_inspection_report_versions v
             JOIN br03_inspection_reports r ON r.id=v.report_id
            WHERE r.job_id=$1 AND v.version_status='ACCEPTED'
            ORDER BY v.version_no DESC LIMIT 1`,
          [jobId],
        );
        if (!acceptedVersion.rows[0]) {
          throw new BadRequestException('no Purchase-accepted inspection version exists for this job');
        }

        const num = await client.query<{ br03_next_request_number: string }>(
          `SELECT br03_next_request_number($1) AS br03_next_request_number`, [actor.companyId],
        );

        const r = await client.query(
          `INSERT INTO br03_material_requests
             (company_id,job_id,inspection_version_id,responsible_engineer_id,request_number,priority,
              required_by_date,required_by_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [actor.companyId, jobId, acceptedVersion.rows[0].id, actor.id, num.rows[0].br03_next_request_number,
            dto.priority, dto.required_by_date ?? null, dto.required_by_reason ?? null],
        );
        await this.audit(client, actor.companyId, actor.id, 'br03_material_requests', r.rows[0].id,
          'BR03_MATERIAL_REQUEST_CREATED', null, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  private async loadRequest(client: PoolClient, requestId: string, actor: Actor) {
    const r = await client.query(`SELECT * FROM br03_material_requests WHERE id=$1 FOR UPDATE`, [requestId]);
    if (!r.rows[0]) throw new NotFoundException('material request not found');
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('request belongs to another company');
    return r.rows[0];
  }

  async addLine(requestId: string, dto: AddMaterialLineDto, actor: Actor) {
    const req = await this.pg.query(`SELECT company_id FROM br03_material_requests WHERE id=$1`, [requestId]);
    if (!req.rows[0]) throw new NotFoundException('material request not found');
    if (req.rows[0].company_id !== actor.companyId) throw new ForbiddenException('request belongs to another company');

    const item = await this.pg.query<{ uom: string }>(
      `SELECT uom FROM br03_item_catalog_bridge WHERE id=$1`, [dto.item_bridge_id],
    );
    if (!item.rows[0]) throw new BadRequestException('item not found in catalog bridge');

    try {
      const r = await this.pg.query(
        `INSERT INTO br03_material_request_lines
           (request_id,item_bridge_id,quantity,uom_snapshot,preferred_manufacturer,preferred_part_number,
            preference_reason,technical_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [requestId, dto.item_bridge_id, dto.quantity, item.rows[0].uom, dto.preferred_manufacturer ?? null,
          dto.preferred_part_number ?? null, dto.preference_reason ?? null, dto.technical_note ?? null],
      );
      return r.rows[0];
    } catch (e) {
      this.mapErr(e);
    }
  }

  async submitMaterialRequest(requestId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const req = await this.loadRequest(client, requestId, actor);
        if (req.status !== 'DRAFT') throw new BadRequestException('only a DRAFT material request can be submitted');

        const lines = await client.query(
          `SELECT * FROM br03_material_request_lines WHERE request_id=$1 ORDER BY created_at`, [requestId],
        );
        if (lines.rows.length === 0) throw new BadRequestException('add at least one line before submitting');

        const versionNo = req.current_version_no + 1;
        await client.query(
          `INSERT INTO br03_material_request_versions (request_id,version_no,change_action,changed_by_id,lines_snapshot)
           VALUES ($1,$2,'SUBMIT',$3,$4)`,
          [requestId, versionNo, actor.id, JSON.stringify(lines.rows)],
        );
        const updated = await client.query(
          `UPDATE br03_material_requests
              SET status='SUBMITTED', submitted_at=now(), current_version_no=$2,
                  self_edit_deadline_at=br03_self_edit_deadline(company_id, now())
            WHERE id=$1 RETURNING *`,
          [requestId, versionNo],
        );
        await this.audit(client, actor.companyId, actor.id, 'br03_material_requests', requestId,
          'BR03_MATERIAL_REQUEST_SUBMITTED', req, updated.rows[0]);
        return updated.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async startProcessing(requestId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const req = await this.loadRequest(client, requestId, actor);
        if (req.status !== 'SUBMITTED') throw new BadRequestException('only a SUBMITTED material request can start processing');

        const updated = await client.query(
          `UPDATE br03_material_requests
              SET status='PROCESSING', purchase_processing_started_at=now(), purchase_started_by_id=$2
            WHERE id=$1 RETURNING *`,
          [requestId, actor.id],
        );
        await this.audit(client, actor.companyId, actor.id, 'br03_material_requests', requestId,
          'BR03_MATERIAL_REQUEST_PROCESSING_STARTED', req, updated.rows[0]);
        return updated.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async getMaterialRequest(id: string, actor: Actor) {
    const r = await this.pg.query(`SELECT * FROM br03_material_requests WHERE id=$1`, [id]);
    if (!r.rows[0]) throw new NotFoundException('material request not found');
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('request belongs to another company');
    const lines = await this.pg.query(`SELECT * FROM br03_material_request_lines WHERE request_id=$1`, [id]);
    const changeRequests = await this.pg.query(
      `SELECT * FROM br03_material_change_requests WHERE material_request_id=$1 ORDER BY id`, [id],
    );
    return { ...r.rows[0], lines: lines.rows, change_requests: changeRequests.rows };
  }

  async listMaterialRequests(actor: Actor, status?: string) {
    const r = status
      ? await this.pg.query(
        `SELECT * FROM br03_material_requests WHERE company_id=$1 AND status=$2 ORDER BY created_at DESC`,
        [actor.companyId, status],
      )
      : await this.pg.query(
        `SELECT * FROM br03_material_requests WHERE company_id=$1 ORDER BY created_at DESC`, [actor.companyId],
      );
    return r.rows;
  }

  // ---------------------------------------------------------------- change requests

  async createChangeRequest(requestId: string, dto: CreateChangeRequestDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const req = await this.loadRequest(client, requestId, actor);

        const editable = await client.query<{ br03_can_engineer_edit: boolean }>(
          `SELECT br03_can_engineer_edit($1) AS br03_can_engineer_edit`, [requestId],
        );
        if (editable.rows[0].br03_can_engineer_edit) {
          throw new BadRequestException('request is still directly editable; use the lines endpoint instead');
        }
        if (!['SUBMITTED', 'PROCESSING'].includes(req.status)) {
          throw new BadRequestException(`cannot raise a change request against a ${req.status} material request`);
        }

        const r = await client.query(
          `INSERT INTO br03_material_change_requests (material_request_id,requested_by_id,change_reason,proposed_change)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [requestId, actor.id, dto.change_reason, JSON.stringify(dto.proposed_change)],
        );
        await client.query(`UPDATE br03_material_requests SET status='CHANGE_REQUESTED' WHERE id=$1`, [requestId]);
        await this.audit(client, actor.companyId, actor.id, 'br03_material_change_requests', r.rows[0].id,
          'BR03_CHANGE_REQUEST_CREATED', null, r.rows[0]);
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  async reviewChangeRequest(requestId: string, crId: string, dto: ReviewChangeRequestDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const req = await this.loadRequest(client, requestId, actor);

        const cr = await client.query(
          `SELECT * FROM br03_material_change_requests WHERE id=$1 AND material_request_id=$2 FOR UPDATE`,
          [crId, requestId],
        );
        if (!cr.rows[0]) throw new NotFoundException('change request not found');
        if (cr.rows[0].review_status !== 'PENDING') throw new BadRequestException('change request already reviewed');

        const updatedCr = await client.query(
          `UPDATE br03_material_change_requests
              SET review_status=$2, reviewed_by_id=$3, reviewed_at=now(), review_comment=$4
            WHERE id=$1 RETURNING *`,
          [crId, dto.decision, actor.id, dto.comment ?? null],
        );
        // Restores the request to Purchase's working queue; applying the proposed
        // line changes themselves is a separate, unbuilt step (see note below).
        await client.query(
          `UPDATE br03_material_requests SET status='PROCESSING' WHERE id=$1 AND status='CHANGE_REQUESTED'`,
          [requestId],
        );
        await this.audit(client, actor.companyId, actor.id, 'br03_material_change_requests', crId,
          'BR03_CHANGE_REQUEST_REVIEWED', cr.rows[0], updatedCr.rows[0]);
        return updatedCr.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }
}
