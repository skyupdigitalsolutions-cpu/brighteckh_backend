import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { CompanyPolicyDto, POLICY_FIELDS } from './company-config.dto';

interface Actor { id: string; role: string; companyId: string }

/**
 * Company policy config (migration 026): client-confirmed values with no other home.
 * Only max_discount_percent is enforced (BR-04 trigger); the rest is recorded config.
 */
@Injectable()
export class CompanyConfigService {
  constructor(private readonly pg: PgService) {}

  async get(actor: Actor) {
    const [row, eff] = await Promise.all([
      this.pg.query(`SELECT * FROM company_policy_config WHERE company_id=$1`, [actor.companyId]),
      this.pg.query(`SELECT trim_scale(br04_max_discount_percent($1))::text AS v`, [actor.companyId]),
    ]);
    return {
      policy: row.rows[0] ?? null,
      effective_max_discount_percent: eff.rows[0].v,
      enforced: ['max_discount_percent'],
      stored_only: POLICY_FIELDS.filter((f) => f !== 'max_discount_percent'),
    };
  }

  async set(dto: CompanyPolicyDto, actor: Actor) {
    const d = dto as Record<string, unknown>;
    try {
      await this.pg.tx(async (c) => {
        const before = (await c.query(`SELECT * FROM company_policy_config WHERE company_id=$1 FOR UPDATE`, [actor.companyId])).rows[0];
        const vals = POLICY_FIELDS.map((f) => (d[f] !== undefined ? d[f] : (before?.[f] ?? null)));
        const cols = POLICY_FIELDS.join(',');
        const ph = POLICY_FIELDS.map((_, i) => `$${i + 2}`).join(',');
        const upd = POLICY_FIELDS.map((f) => `${f}=EXCLUDED.${f}`).join(',');
        const n = POLICY_FIELDS.length;
        const after = (await c.query(
          `INSERT INTO company_policy_config(company_id,${cols},note,updated_by_id)
           VALUES ($1,${ph},$${n + 2},$${n + 3})
           ON CONFLICT (company_id) DO UPDATE SET ${upd}, note=EXCLUDED.note,
             updated_by_id=EXCLUDED.updated_by_id, updated_at=now()
           RETURNING *`,
          [actor.companyId, ...vals, dto.note ?? before?.note ?? null, actor.id])).rows[0];
        await c.query(
          `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
           VALUES ($1,$2,'company_policy_config',$1,'COMPANY_POLICY_CONFIGURED',$3,$4)`,
          [actor.companyId, actor.id, before ?? null, after]);
      });
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new BadRequestException((e as Error).message || 'request failed');
    }
    return this.get(actor);
  }
}
