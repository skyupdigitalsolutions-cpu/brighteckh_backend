import { Injectable } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { Actor, likeTerm, paging } from './purchase-desk.service';
import { SALES_STAGES, SalesQuoteListQueryDto, SalesStage } from './dto/sales-quotes.dto';

/**
 * Sales stage derivation (latest revision `lr`, its newest BR-05 response `resp`):
 *   BR-04 RELEASED_TO_SALES                        -> TO_SEND
 *   BR-04 ACCEPTED / REJECTED / EXPIRED            -> same name, BR-04 status wins over responses (defensive: no API
 *                                                     sets these and brcm_guard_quote_revision refuses any update of a
 *                                                     SENT revision, so they are unreachable today)
 *   BR-04 SENT, no response / AWAITING_RESPONSE    -> AWAITING
 *   BR-04 SENT, response ACCEPTED/REJECTED/EXPIRED -> same name
 *   BR-04 SENT, any other response                 -> IN_DISCUSSION
 *     (COUNTER_OFFER, TECHNICAL_QUERY, PARTIAL_ACCEPTANCE, ON_HOLD)
 * DRAFT and SUPERSEDED latest revisions are out of scope (a re-revised DRAFT has no handoff; SUPERSEDED is never set).
 */
const STAGE_SQL = `
  CASE
    WHEN lr.quote_status = 'RELEASED_TO_SALES' THEN 'TO_SEND'
    WHEN lr.quote_status IN ('ACCEPTED', 'REJECTED', 'EXPIRED') THEN lr.quote_status
    WHEN resp.response_type IS NULL OR resp.response_type = 'AWAITING_RESPONSE' THEN 'AWAITING'
    WHEN resp.response_type IN ('ACCEPTED', 'REJECTED', 'EXPIRED') THEN resp.response_type
    ELSE 'IN_DISCUSSION'
  END`;

export const SCOPE_STATUSES = ['RELEASED_TO_SALES', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'];

/**
 * GET /sales/quotes: the caller's Sales worklist. Scope = quotes of the token's company whose LATEST revision has a
 * br04_quote_sales_handoffs row assigned to the caller. Read-only; customer-facing columns only (the revision's
 * reference/procurement offer ids, estimate ids and any supplier price are never selected).
 */
@Injectable()
export class SalesQuotesService {
  constructor(private readonly pg: PgService) {}

  async list(q: SalesQuoteListQueryDto, actor: Actor) {
    const { page, pageSize, offset } = paging(q);
    // $1 company, $2 caller, $3 search
    const base = `
      WITH base AS (
        SELECT q.id AS quote_id, q.quote_number, q.quote_type, q.job_id, j.job_number,
               ir.customer_id, c.customer_name, c.customer_code,
               u.serial_number, u.observed_make, u.observed_model, asm.assembly_name,
               lr.id AS latest_revision_id, lr.revision_no, lr.quote_status, lr.valid_until,
               to_char(lr.valid_until, 'YYYY-MM-DD') AS valid_until_date,
               lr.revised_pre_tax, lr.tax_total, lr.freight_charge,
               h.assigned_sales_id, h.released_at AS released_to_sales_at,
               h.released_by_purchase_id AS released_by_id, rb.full_name AS released_by_name,
               snt.changed_at AS sent_at, snt.actor_id AS sent_by_id, sb.full_name AS sent_by_name,
               resp.id AS response_id, resp.response_type, resp.response_channel, resp.customer_contact,
               resp.responded_at, resp.recorded_by_id, re.full_name AS recorded_by_name,
               ${STAGE_SQL} AS sales_stage
          FROM br04_customer_quotes q
          JOIN LATERAL (
            SELECT id, revision_no, quote_status, valid_until, revised_pre_tax, tax_total, freight_charge
              FROM br04_customer_quote_revisions WHERE quote_id = q.id ORDER BY revision_no DESC LIMIT 1) lr ON true
          JOIN br04_quote_sales_handoffs h ON h.quote_revision_id = lr.id AND h.assigned_sales_id = $2
          JOIN service_jobs j          ON j.id = q.job_id AND j.company_id = q.company_id
          JOIN inward_receipts ir      ON ir.id = j.inward_id
          JOIN customers c             ON c.id = ir.customer_id AND c.company_id = ir.company_id
          LEFT JOIN inward_equipment_units u  ON u.id = j.unit_id
          LEFT JOIN inward_equipment_groups g ON g.id = u.group_id
          LEFT JOIN assemblies asm            ON asm.id = g.assembly_id
          LEFT JOIN employees rb              ON rb.id = h.released_by_purchase_id
          LEFT JOIN LATERAL (
            SELECT l.changed_at, l.actor_id FROM activity_audit_log l
             WHERE l.entity_id = lr.id AND l.company_id = q.company_id AND l.action = 'BR04_QUOTE_SENT'
               AND l.entity_table = 'br04_customer_quote_revisions'
             ORDER BY l.changed_at DESC, l.id DESC LIMIT 1) snt ON true
          LEFT JOIN employees sb ON sb.id = snt.actor_id
          LEFT JOIN LATERAL (
            SELECT e.id, e.response_type, e.response_channel, e.customer_contact, e.responded_at, e.recorded_by_id
              FROM br05_quote_revision_refs b
              JOIN br05_customer_response_events e ON e.quote_revision_id = b.id
             WHERE b.company_id = q.company_id AND b.job_id = q.job_id AND b.source_br04_quote_id = lr.id
             ORDER BY e.responded_at DESC, e.id DESC LIMIT 1) resp ON true
          LEFT JOIN employees re ON re.id = resp.recorded_by_id
         WHERE q.company_id = $1
           AND lr.quote_status = ANY('{${SCOPE_STATUSES.join(',')}}'::text[])
           AND ($3::text IS NULL OR q.quote_number ILIKE $3 OR j.job_number ILIKE $3 OR c.customer_name ILIKE $3
                OR c.customer_code ILIKE $3 OR u.serial_number ILIKE $3 OR u.observed_make ILIKE $3
                OR u.observed_model ILIKE $3))`;
    const baseParams = [actor.companyId, actor.id, likeTerm(q.search)];
    // $4 stages, $5 valid_until_before
    const filtered = `${base}
      SELECT * FROM base
       WHERE ($4::text[] IS NULL OR sales_stage = ANY($4))
         AND ($5::date IS NULL OR valid_until < $5::date)`;
    const params = [...baseParams, q.stage?.length ? q.stage : null, q.valid_until_before ?? null];
    const order = `ORDER BY (sales_stage <> 'TO_SEND'),
               CASE WHEN sales_stage = 'TO_SEND' THEN released_to_sales_at END ASC,
               GREATEST(sent_at, responded_at) DESC NULLS LAST,
               quote_number, quote_id`;

    const [counts, total, rows] = await Promise.all([
      this.pg.query<{ sales_stage: SalesStage; n: number }>(
        `${base} SELECT sales_stage, count(*)::int AS n FROM base GROUP BY sales_stage`, baseParams),
      this.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${filtered}) f`, params),
      this.pg.query(`${filtered} ${order} LIMIT $6 OFFSET $7`, [...params, pageSize, offset]),
    ]);

    const counts_by_stage = Object.fromEntries(SALES_STAGES.map((s) => [s, 0])) as Record<SalesStage, number>;
    for (const r of counts.rows) counts_by_stage[r.sales_stage] = r.n;

    return {
      rows: rows.rows.map((r) => ({
        quote_id: r.quote_id, quote_number: r.quote_number, quote_type: r.quote_type,
        job_id: r.job_id, job_number: r.job_number,
        customer_id: r.customer_id, customer_name: r.customer_name, customer_code: r.customer_code,
        serial_number: r.serial_number, observed_make: r.observed_make, observed_model: r.observed_model,
        assembly_name: r.assembly_name,
        latest_revision_id: r.latest_revision_id, revision_no: r.revision_no, quote_status: r.quote_status,
        valid_until: r.valid_until_date, // plain YYYY-MM-DD (no timezone shift from a JS Date)
        revised_pre_tax: r.revised_pre_tax, tax_total: r.tax_total, freight_charge: r.freight_charge,
        assigned_sales_id: r.assigned_sales_id, released_to_sales_at: r.released_to_sales_at,
        released_by_id: r.released_by_id, released_by_name: r.released_by_name,
        sent_at: r.sent_at, sent_by_id: r.sent_by_id, sent_by_name: r.sent_by_name,
        latest_response: r.response_id ? {
          response_id: r.response_id, response_type: r.response_type, response_channel: r.response_channel,
          customer_contact: r.customer_contact, responded_at: r.responded_at,
          recorded_by_id: r.recorded_by_id, recorded_by_name: r.recorded_by_name,
        } : null,
        sales_stage: r.sales_stage,
      })),
      total: total.rows[0].n,
      page,
      page_size: pageSize,
      counts_by_stage,
    };
  }
}
