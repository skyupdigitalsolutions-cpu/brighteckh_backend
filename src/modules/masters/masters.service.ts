import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { CreateItemDto, CreateAssemblyDto, AddBomLineDto } from './dto/masters.dto';

/**
 * Item + Assembly Master (BR-01B field spec). Purchase/Data-Steward owned.
 * Code + class are immutable after insert (DB trigger enforces). Approval moves
 * status to ACTIVE and stamps the audit trio.
 */
@Injectable()
export class MastersService {
  constructor(private readonly pg: PgService) {}

  async createItem(dto: CreateItemDto, actorId: string) {
    try {
      const r = await this.pg.query(
        `INSERT INTO fdn_item_master
          (item_code,record_type,standard_name,short_description,cc,ss,tt,detailed_spec,
           base_uom,use_case,package_footprint,electrical_ratings,material_grade,stock_flag,
           batch_tracking,serial_tracking,duplicate_review_note,created_by_id,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 COALESCE($15,false),COALESCE($16,false),$17,$18,'DRAFT')
         RETURNING *`,
        [dto.item_code, dto.record_type, dto.standard_name, dto.short_description ?? null,
         dto.cc, dto.ss, dto.tt, dto.detailed_spec ?? {}, dto.base_uom, dto.use_case,
         dto.package_footprint ?? null, dto.electrical_ratings ?? null, dto.material_grade ?? null,
         dto.stock_flag, dto.batch_tracking ?? null, dto.serial_tracking ?? null,
         dto.duplicate_review_note, actorId],
      );
      return r.rows[0];
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /** Approve = technical approval + steward release + ACTIVE (split later if needed). */
  async approveItem(id: string, actorId: string) {
    const r = await this.pg.query(
      `UPDATE fdn_item_master
          SET status='ACTIVE', tech_approved_by_id=$2, tech_approved_at=now(),
              released_by_id=$2, released_at=now()
        WHERE id=$1 AND status IN ('DRAFT','UNDER_REVIEW','APPROVED','ON_HOLD')
        RETURNING *`,
      [id, actorId],
    );
    if (!r.rows[0]) throw new NotFoundException('item not found or not approvable');
    return r.rows[0];
  }

  listItems(status = 'ACTIVE', limit = 50) {
    return this.pg
      .query(`SELECT * FROM fdn_item_master WHERE status=$1 ORDER BY item_code LIMIT $2`, [status, limit])
      .then((r) => r.rows);
  }

  getItem(id: string) {
    return this.pg.query(`SELECT * FROM fdn_item_master WHERE id=$1`, [id]).then((r) => {
      if (!r.rows[0]) throw new NotFoundException('item not found');
      return r.rows[0];
    });
  }

  async createAssembly(dto: CreateAssemblyDto, actorId: string) {
    try {
      const r = await this.pg.query(
        `INSERT INTO fdn_assembly_master
          (assembly_code,standard_name,cc,ss,tt,assembly_type,core_function,specifications,
           bom_status,repairable,saleable,duplicate_review_note,created_by_id,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'DRAFT')
         RETURNING *`,
        [dto.assembly_code, dto.standard_name, dto.cc, dto.ss, dto.tt, dto.assembly_type,
         dto.core_function, dto.specifications ?? {}, dto.bom_status, dto.repairable, dto.saleable,
         dto.duplicate_review_note, actorId],
      );
      return r.rows[0];
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  async approveAssembly(id: string, actorId: string) {
    const r = await this.pg.query(
      `UPDATE fdn_assembly_master
          SET status='ACTIVE', tech_approved_by_id=$2, tech_approved_at=now(),
              released_by_id=$2, released_at=now()
        WHERE id=$1 AND status IN ('DRAFT','UNDER_REVIEW','APPROVED','ON_HOLD')
        RETURNING *`,
      [id, actorId],
    );
    if (!r.rows[0]) throw new NotFoundException('assembly not found or not approvable');
    return r.rows[0];
  }

  async addBomLine(assemblyId: string, dto: AddBomLineDto) {
    try {
      const r = await this.pg.query(
        `INSERT INTO fdn_assembly_bom (assembly_id,bom_revision,item_id,qty_per,uom)
         VALUES ($1,COALESCE($2,0),$3,$4,$5) RETURNING *`,
        [assemblyId, dto.bom_revision ?? null, dto.item_id, dto.qty_per, dto.uom],
      );
      return r.rows[0];
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  listAssemblies(status = 'ACTIVE', limit = 50) {
    return this.pg
      .query(`SELECT * FROM fdn_assembly_master WHERE status=$1 ORDER BY assembly_code LIMIT $2`, [status, limit])
      .then((r) => r.rows);
  }
}
