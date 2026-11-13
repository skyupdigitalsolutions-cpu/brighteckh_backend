import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgService } from '../../common/database/pg.service';
import {
  AddUnitPhotoDto, AssignEngineerDto, CreateEquipmentGroupDto, CreateInwardReceiptDto,
  ExpandEquipmentGroupDto, LinkRepeatJobDto,
} from './dto/br02.dto';

interface Actor { id: string; role: string; companyId: string }

/**
 * BR-02: inward receipt -> equipment groups -> unit expansion -> verify -> Job ID
 * -> engineer assignment. One Job ID per physical unit; JIN/Job numbers are
 * allocated from per-company counters inside a transaction, never caller-supplied.
 * Every write here is scoped to the authenticated actor's own company.
 */
@Injectable()
export class Br02Service {
  constructor(private readonly pg: PgService) {}

  private mapErr(e: unknown): never {
    const m = (e as Error).message || '';
    if (m.includes('photo')) throw new BadRequestException(m);
    if (m.includes('verified equipment unit')) throw new BadRequestException(m);
    if (m.includes('Pending Approval or Approved')) throw new BadRequestException(m);
    if (m.includes('Invalid active custody location') || m.includes('Invalid current custodian')) {
      throw new BadRequestException(m);
    }
    if (m.includes('already expanded')) throw new BadRequestException(m);
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

  // ---------------------------------------------------------------- inward receipts

  async createInwardReceipt(dto: CreateInwardReceiptDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const num = await client.query<{ br02_next_identifier: string }>(
          `SELECT br02_next_identifier($1,'JIN') AS br02_next_identifier`, [actor.companyId],
        );
        const jin = num.rows[0].br02_next_identifier;

        const r = await client.query(
          `INSERT INTO inward_receipts
             (company_id,jin_number,customer_id,receipt_at,receipt_channel,received_by_id,
              customer_dc_number,dc_date,dc_exception_status,dc_exception_reason,
              courier_name,courier_awb,declared_quantity,priority,priority_reason,fiscal_year,notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'NONE'),$10,$11,$12,$13,COALESCE($14,'NORMAL'),$15,$16,$17)
           RETURNING *`,
          [actor.companyId, jin, dto.customer_id, dto.receipt_at, dto.receipt_channel, actor.id,
            dto.customer_dc_number ?? null, dto.dc_date ?? null, dto.dc_exception_status ?? null,
            dto.dc_exception_reason ?? null, dto.courier_name ?? null, dto.courier_awb ?? null,
            dto.declared_quantity ?? null, dto.priority ?? null, dto.priority_reason ?? null,
            dto.fiscal_year ?? null, dto.notes ?? null],
        );
        const receipt = r.rows[0];
        await this.audit(client, actor.companyId, actor.id, 'inward_receipts', receipt.id,
          'BR02_INWARD_RECEIPT_CREATED', null, receipt);
        return receipt;
      });
    } catch (e) {
      this.mapErr(e);
    }
  }

  async getInwardReceipt(id: string, actor: Actor) {
    const r = await this.pg.query(`SELECT * FROM inward_receipts WHERE id=$1`, [id]);
    const receipt = r.rows[0];
    if (!receipt) throw new NotFoundException('inward receipt not found');
    if (receipt.company_id !== actor.companyId) {
      throw new ForbiddenException('inward receipt belongs to another company');
    }
    const groups = await this.pg.query(
      `SELECT * FROM inward_equipment_groups WHERE inward_id=$1 ORDER BY group_number`, [id],
    );
    // B-2: each unit also carries the Job it became (null until verified). One Job per unit (unit_id UNIQUE).
    const units = await this.pg.query(
      `SELECT u.*, j.id AS job_id, j.job_number
         FROM inward_equipment_units u LEFT JOIN service_jobs j ON j.unit_id = u.id
        WHERE u.inward_id=$1 ORDER BY u.group_id, u.unit_number`, [id],
    );
    return { ...receipt, equipment_groups: groups.rows, equipment_units: units.rows };
  }

  // ---------------------------------------------------------------- equipment groups

  async addEquipmentGroup(inwardId: string, dto: CreateEquipmentGroupDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const parent = await client.query<{ company_id: string }>(
          `SELECT company_id FROM inward_receipts WHERE id=$1 FOR UPDATE`, [inwardId],
        );
        if (!parent.rows[0]) throw new NotFoundException('inward receipt not found');
        if (parent.rows[0].company_id !== actor.companyId) {
          throw new ForbiddenException('inward receipt belongs to another company');
        }

        const next = await client.query<{ next: number }>(
          `SELECT COALESCE(MAX(group_number),0)+1 AS next FROM inward_equipment_groups WHERE inward_id=$1`,
          [inwardId],
        );

        const r = await client.query(
          `INSERT INTO inward_equipment_groups
             (company_id,inward_id,group_number,assembly_id,quantity_received,customer_dc_line,created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`,
          [actor.companyId, inwardId, next.rows[0].next, dto.assembly_id, dto.quantity_received,
            dto.customer_dc_line ?? null, actor.id],
        );
        const group = r.rows[0];
        await this.audit(client, actor.companyId, actor.id, 'inward_equipment_groups', group.id,
          'BR02_EQUIPMENT_GROUP_CREATED', null, group);
        return group;
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException) throw e;
      this.mapErr(e);
    }
  }

  // ---------------------------------------------------------------- expansion

  async expandGroup(groupId: string, dto: ExpandEquipmentGroupDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const group = await client.query<{ company_id: string }>(
          `SELECT company_id FROM inward_equipment_groups WHERE id=$1`, [groupId],
        );
        if (!group.rows[0]) throw new NotFoundException('equipment group not found');
        if (group.rows[0].company_id !== actor.companyId) {
          throw new ForbiddenException('equipment group belongs to another company');
        }

        const expanded = await client.query<{ br02_expand_equipment_group: number }>(
          `SELECT br02_expand_equipment_group($1,$2,$3) AS br02_expand_equipment_group`,
          [groupId, dto.location_id, dto.custodian_id],
        );
        const qty = expanded.rows[0].br02_expand_equipment_group;

        const units = await client.query(
          `SELECT * FROM inward_equipment_units WHERE group_id=$1 ORDER BY unit_number`, [groupId],
        );
        await this.audit(client, actor.companyId, actor.id, 'inward_equipment_groups', groupId,
          'BR02_EQUIPMENT_GROUP_EXPANDED', null, { quantity_expanded: qty, unit_ids: units.rows.map((u) => u.id) });
        return { quantity_expanded: qty, units: units.rows };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException) throw e;
      this.mapErr(e);
    }
  }

  // ---------------------------------------------------------------- photos

  async addUnitPhoto(unitId: string, dto: AddUnitPhotoDto, actor: Actor) {
    const unit = await this.pg.query<{ company_id: string }>(
      `SELECT company_id FROM inward_equipment_units WHERE id=$1`, [unitId],
    );
    if (!unit.rows[0]) throw new NotFoundException('equipment unit not found');
    if (unit.rows[0].company_id !== actor.companyId) {
      throw new ForbiddenException('equipment unit belongs to another company');
    }
    const r = await this.pg.query(
      `INSERT INTO equipment_photos (unit_id,file_uri,file_name,photo_category,mime_type,file_size_bytes,uploaded_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [unitId, dto.file_uri, dto.file_name, dto.photo_category ?? null, dto.mime_type ?? null,
        dto.file_size_bytes ?? null, actor.id],
    );
    return r.rows[0];
  }

  // ---------------------------------------------------------------- verify + Job ID allocation

  async verifyUnit(unitId: string, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const u = await client.query<{ company_id: string; inward_id: string; verification_status: string }>(
          `SELECT company_id, inward_id, verification_status FROM inward_equipment_units WHERE id=$1 FOR UPDATE`,
          [unitId],
        );
        if (!u.rows[0]) throw new NotFoundException('equipment unit not found');
        const before = u.rows[0];
        if (before.company_id !== actor.companyId) {
          throw new ForbiddenException('equipment unit belongs to another company');
        }
        if (before.verification_status === 'VERIFIED') {
          throw new BadRequestException('equipment unit already verified');
        }

        const updated = await client.query(
          `UPDATE inward_equipment_units
              SET verification_status='VERIFIED', verified_at=now(), verified_by_id=$2
            WHERE id=$1
            RETURNING *`,
          [unitId, actor.id],
        );
        await this.audit(client, actor.companyId, actor.id, 'inward_equipment_units', unitId,
          'BR02_UNIT_VERIFIED', before, updated.rows[0]);

        const num = await client.query<{ br02_next_identifier: string }>(
          `SELECT br02_next_identifier($1,'JOB') AS br02_next_identifier`, [actor.companyId],
        );
        const jobNumber = num.rows[0].br02_next_identifier;

        const job = await client.query(
          `INSERT INTO service_jobs (company_id,inward_id,unit_id,job_number)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [actor.companyId, before.inward_id, unitId, jobNumber],
        );
        await this.audit(client, actor.companyId, actor.id, 'service_jobs', job.rows[0].id,
          'BR02_JOB_CREATED', null, job.rows[0]);

        return { equipment_unit: updated.rows[0], job: job.rows[0] };
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  // ---------------------------------------------------------------- jobs + assignment

  async getJob(id: string, actor: Actor) {
    const r = await this.pg.query(`SELECT * FROM service_jobs WHERE id=$1`, [id]);
    const job = r.rows[0];
    if (!job) throw new NotFoundException('job not found');
    if (job.company_id !== actor.companyId) {
      throw new ForbiddenException('job belongs to another company');
    }
    const assignment = await this.pg.query(
      `SELECT * FROM job_assignments WHERE job_id=$1 AND is_current`, [id],
    );
    return { ...job, current_assignment: assignment.rows[0] ?? null };
  }

  /**
   * G1: jobs whose CURRENT assignment is the caller (any response: PENDING jobs still need custody-ack),
   * in the caller's company. Read-only. Ordered CRITICAL -> URGENT -> NORMAL, then newest job first.
   */
  async listMyJobs(actor: Actor, status?: string) {
    const jobs = await this.pg.query(
      `SELECT j.*, a.id AS __assignment_id,
              r.jin_number, u.unit_number,
              (SELECT count(*)::int FROM inward_equipment_units u2 WHERE u2.group_id = u.group_id) AS units_in_group,
              u.serial_number, u.observed_make, u.observed_model,
              g.assembly_id, asm.assembly_code, asm.assembly_name
         FROM job_assignments a
         JOIN service_jobs j              ON j.id = a.job_id
         JOIN inward_receipts r           ON r.id = j.inward_id
         JOIN inward_equipment_units u    ON u.id = j.unit_id
         JOIN inward_equipment_groups g   ON g.id = u.group_id
         JOIN assemblies asm              ON asm.id = g.assembly_id
        WHERE a.engineer_id = $1 AND a.is_current AND j.company_id = $2
          AND ($3::text IS NULL OR j.status = $3)
        ORDER BY CASE j.priority WHEN 'CRITICAL' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END, j.created_at DESC
        LIMIT 500`,
      [actor.id, actor.companyId, status ?? null],
    );
    if (!jobs.rows.length) return [];
    // Assignment rows read separately so their timestamps serialise exactly like GET /jobs/:id.
    const assignments = await this.pg.query(
      `SELECT * FROM job_assignments WHERE id = ANY($1::uuid[])`, [jobs.rows.map((j) => j.__assignment_id)],
    );
    const byId = new Map(assignments.rows.map((a) => [a.id, a]));
    return jobs.rows.map(({ __assignment_id, ...job }) => ({ ...job, current_assignment: byId.get(__assignment_id) }));
  }

  async assignEngineer(jobId: string, dto: AssignEngineerDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const job = await client.query<{ company_id: string; status: string }>(
          `SELECT company_id, status FROM service_jobs WHERE id=$1 FOR UPDATE`, [jobId],
        );
        if (!job.rows[0]) throw new NotFoundException('job not found');
        if (job.rows[0].company_id !== actor.companyId) {
          throw new ForbiddenException('job belongs to another company');
        }
        if (['CANCELLED', 'CLOSED'].includes(job.rows[0].status)) {
          throw new BadRequestException(`cannot assign a ${job.rows[0].status.toLowerCase()} job`);
        }

        const engineer = await client.query<{ is_active: boolean; role_code: string }>(
          `SELECT is_active, role_code FROM employees WHERE id=$1 AND company_id=$2`,
          [dto.engineer_id, actor.companyId],
        );
        if (!engineer.rows[0] || !engineer.rows[0].is_active || engineer.rows[0].role_code !== 'ENGINEER') {
          throw new BadRequestException('engineer_id must be an active Service Engineer in this company');
        }

        const current = await client.query<{ id: string }>(
          `SELECT id FROM job_assignments WHERE job_id=$1 AND is_current`, [jobId],
        );
        if (current.rows[0]) {
          if (!dto.reassignment_reason) {
            throw new BadRequestException('reassignment_reason is required when reassigning an already-assigned job');
          }
          await client.query(
            `UPDATE job_assignments SET is_current=false WHERE id=$1`, [current.rows[0].id],
          );
        }

        const r = await client.query(
          `INSERT INTO job_assignments (company_id,job_id,assigned_by_id,engineer_id,reassignment_reason)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [actor.companyId, jobId, actor.id, dto.engineer_id, dto.reassignment_reason ?? null],
        );
        await client.query(`UPDATE service_jobs SET status='ASSIGNED' WHERE id=$1`, [jobId]);

        await this.audit(client, actor.companyId, actor.id, 'job_assignments', r.rows[0].id,
          current.rows[0] ? 'BR02_JOB_REASSIGNED' : 'BR02_JOB_ASSIGNED', null, r.rows[0]);

        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }

  // ---------------------------------------------------------------- warranty repeat returns

  /**
   * Link a NEW job (created by the normal inward -> verify flow) as a repeat
   * return of an earlier job. br02_link_repeat_job resolves the chain's original
   * and previous job and assigns R01/R02... under lock; triggers enforce same
   * company + customer, delivered original, new inward after dispatch.
   */
  async linkRepeatJob(jobId: string, dto: LinkRepeatJobDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        for (const id of [jobId, dto.repeat_of_job_id]) {
          const j = await client.query('SELECT company_id FROM service_jobs WHERE id=$1', [id]);
          if (!j.rows[0]) throw new NotFoundException('job not found');
          if (j.rows[0].company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');
        }
        await client.query('SELECT br02_link_repeat_job($1,$2,$3,$4)', [jobId, dto.repeat_of_job_id, actor.id, dto.return_reason]);
        const link = (await client.query('SELECT * FROM job_repeat_links WHERE job_id=$1', [jobId])).rows[0];
        await this.audit(client, actor.companyId, actor.id, 'job_repeat_links', jobId, 'BR02_REPEAT_RETURN_LINKED', null, link);
        return link;
      });
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ForbiddenException || e instanceof BadRequestException) throw e;
      this.mapErr(e);
    }
  }
}
