import {
  BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgService } from '../../common/database/pg.service';
import {
  AllocatePaymentDto, CreateDispatchBatchDto, CreditNoteDto, DispatchBatchDto, EntityProfileDto,
  InvoiceRequestDto, ListInvoicesQueryDto, ProofOfDeliveryDto, RecordPaymentDto, SalesInvoiceRequestDto, WaiverDto,
} from './dto/br08.dto';

interface Actor { id: string; role: string; companyId: string }
type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const INVOICE_COPIES = ['ORIGINAL', 'DUPLICATE', 'TRIPLICATE'] as const;

/**
 * BR-08: dispatch batch -> Delivery Challan (Job Work) -> proof of delivery ->
 * Tax Invoice -> payment receipts/allocations -> job closure; credit notes and
 * no-charge waivers.
 *
 * All rules live in the DB (migration 013): numbering, GST regime + tax maths,
 * D6 master gate, role checks (Finance / Sales / Purchase), immutability,
 * partial-payment bookkeeping and automatic job closure. This service only
 * validates ownership (company scoping), calls the plpgsql functions inside a
 * transaction, and writes the audit row.
 *
 * Dispatch moves CUSTOMER-OWNED equipment: nothing is posted to the inventory
 * ledger here.
 */
@Injectable()
export class Br08Service {
  constructor(private readonly pg: PgService) {}

  private rethrow(e: unknown): never {
    if (e instanceof HttpException) throw e;
    throw new BadRequestException((e as Error).message || 'request failed');
  }

  private async audit(
    client: PoolClient, actor: Actor, entityTable: string, entityId: string, action: string,
    before: unknown, after: unknown,
  ) {
    await client.query(
      `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor.companyId, actor.id, entityTable, entityId, action, before ?? null, after ?? null],
    );
  }

  /** Load a company-owned row or throw 404/403. */
  private async owned(client: Queryable, table: string, id: string, actor: Actor, lock = false) {
    const r = await client.query(`SELECT * FROM ${table} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!r.rows[0]) throw new NotFoundException(`${table.replace(/^br08_/, '').replace(/_/g, ' ')} not found`);
    if (r.rows[0].company_id !== actor.companyId) throw new ForbiddenException('record belongs to another company');
    return r.rows[0];
  }

  // ================================================================ entity profile

  async getEntityProfile(actor: Actor) {
    const r = await this.pg.query(
      `SELECT le.id, le.entity_code, le.name, le.legal_name, le.doc_prefix, le.gstin, le.state_code,
              gs.state_name, le.registered_address, le.bank_account_name, le.bank_name, le.bank_account_no,
              le.bank_ifsc, le.bank_branch
         FROM legal_entities le LEFT JOIN gst_states gs ON gs.state_code=le.state_code WHERE le.id=$1`,
      [actor.companyId],
    );
    return r.rows[0];
  }

  async updateEntityProfile(dto: EntityProfileDto, actor: Actor) {
    const fields = Object.entries(dto).filter(([, v]) => v !== undefined);
    if (fields.length === 0) throw new BadRequestException('nothing to update');
    try {
      return await this.pg.tx(async (client) => {
        const before = (await client.query(`SELECT * FROM legal_entities WHERE id=$1 FOR UPDATE`, [actor.companyId])).rows[0];
        // Column names come from the DTO's whitelisted keys only (forbidNonWhitelisted).
        const sets = fields.map(([k], i) => `${k}=$${i + 2}`).join(', ');
        const after = (await client.query(
          `UPDATE legal_entities SET ${sets} WHERE id=$1 RETURNING *`, [actor.companyId, ...fields.map(([, v]) => v)],
        )).rows[0];
        await this.audit(client, actor, 'legal_entities', actor.companyId, 'BR08_ENTITY_PROFILE_UPDATED', before, after);
        return this.getEntityProfile(actor);
      });
    } catch (e) { this.rethrow(e); }
  }

  // ================================================================ dispatch

  async createBatch(dto: CreateDispatchBatchDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.owned(client, 'customers', dto.customer_id, actor);
        const batch = (await client.query(
          `INSERT INTO br08_dispatch_batches(company_id,customer_id,carrier_name,carrier_reference,destination_address,created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [actor.companyId, dto.customer_id, dto.carrier_name, dto.carrier_reference ?? null, dto.destination_address, actor.id],
        )).rows[0];
        const jobs = [];
        for (const jobId of dto.job_ids) {
          await this.owned(client, 'service_jobs', jobId, actor);
          const rel = (await client.query(`SELECT id FROM br07_dispatch_releases WHERE job_id=$1`, [jobId])).rows[0];
          if (!rel) throw new BadRequestException(`job ${jobId} has no BR-07 dispatch release`);
          jobs.push((await client.query(
            `INSERT INTO br08_dispatch_batch_jobs(company_id,batch_id,job_id,dispatch_release_id,added_by_id)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [actor.companyId, batch.id, jobId, rel.id, actor.id],
          )).rows[0]);
        }
        await this.audit(client, actor, 'br08_dispatch_batches', batch.id, 'BR08_DISPATCH_BATCH_CREATED', null, { batch, jobs });
        return { ...batch, jobs };
      });
    } catch (e) { this.rethrow(e); }
  }

  async dispatch(batchId: string, dto: DispatchBatchDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const before = await this.owned(client, 'br08_dispatch_batches', batchId, actor, true);
        const dcId = (await client.query(`SELECT br08_dispatch_batch($1,$2,$3) AS id`,
          [batchId, actor.id, dto.carrier_reference ?? null])).rows[0].id;
        const batch = (await client.query(`SELECT * FROM br08_dispatch_batches WHERE id=$1`, [batchId])).rows[0];
        const challan = (await client.query(`SELECT * FROM br08_delivery_challans WHERE id=$1`, [dcId])).rows[0];
        await this.audit(client, actor, 'br08_dispatch_batches', batchId, 'BR08_DISPATCHED_DC_ISSUED', before, { batch, challan });
        return { batch, delivery_challan: challan };
      });
    } catch (e) { this.rethrow(e); }
  }

  async recordProofOfDelivery(batchId: string, dto: ProofOfDeliveryDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        await this.owned(client, 'br08_dispatch_batches', batchId, actor);
        const pod = (await client.query(
          `INSERT INTO br08_delivery_acknowledgements
             (company_id,batch_id,received_by_name,received_at,delivered_on,pod_document_uri,remarks,recorded_by_id)
           VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7) RETURNING *`,
          [actor.companyId, batchId, dto.received_by_name, dto.received_at, dto.pod_document_uri ?? null,
            dto.remarks ?? null, actor.id],
        )).rows[0];
        await this.audit(client, actor, 'br08_delivery_acknowledgements', pod.id, 'BR08_PROOF_OF_DELIVERY', null, pod);
        return pod;
      });
    } catch (e) { this.rethrow(e); }
  }

  async getBatch(batchId: string, actor: Actor) {
    const batch = await this.owned(this.pg, 'br08_dispatch_batches', batchId, actor);
    const [jobs, challan, pod] = await Promise.all([
      this.pg.query(
        `SELECT bj.*, sj.job_number FROM br08_dispatch_batch_jobs bj JOIN service_jobs sj ON sj.id=bj.job_id
          WHERE bj.batch_id=$1 ORDER BY sj.job_number`, [batchId]),
      this.pg.query(`SELECT * FROM br08_delivery_challans WHERE batch_id=$1`, [batchId]),
      this.pg.query(`SELECT * FROM br08_delivery_acknowledgements WHERE batch_id=$1`, [batchId]),
    ]);
    return { ...batch, jobs: jobs.rows, delivery_challan: challan.rows[0] ?? null, proof_of_delivery: pod.rows[0] ?? null };
  }

  async getChallan(challanId: string, actor: Actor) {
    return this.owned(this.pg, 'br08_delivery_challans', challanId, actor);
  }

  // ================================================================ invoice

  async previewInvoice(dto: InvoiceRequestDto, actor: Actor) {
    try {
      const r = await this.pg.query(`SELECT br08_build_invoice($1,$2::uuid[],$3) AS d`,
        [actor.companyId, dto.job_ids, dto.credit_days ?? null]);
      return { ...r.rows[0].d, invoice_number: null, preview: true };
    } catch (e) { this.rethrow(e); }
  }

  async issueInvoice(dto: InvoiceRequestDto, actor: Actor) {
    try {
      const id = await this.pg.tx(async (client) => {
        for (const jobId of dto.job_ids) await this.owned(client, 'service_jobs', jobId, actor);
        const invId = (await client.query(`SELECT br08_issue_invoice($1,$2,$3::uuid[],$4) AS id`,
          [actor.companyId, actor.id, dto.job_ids, dto.credit_days ?? null])).rows[0].id;
        const inv = (await client.query(`SELECT * FROM br08_invoices WHERE id=$1`, [invId])).rows[0];
        await this.audit(client, actor, 'br08_invoices', invId, 'BR08_INVOICE_ISSUED', null, inv);
        return invId;
      });
      return this.getInvoice(id, actor);
    } catch (e) { this.rethrow(e); }
  }

  // ---- PRODUCT_SALES (BR-11 Sales Order source). Same br08_invoices row, same INV
  // series, same Finance-only DB gate, same GST maths; lines come from the BR-11
  // order line snapshot (never a repair Job ID). Trigger / GST rate are
  // CLIENT-UNCONFIRMED config: unconfigured = the DB refuses.

  async previewSalesInvoice(dto: SalesInvoiceRequestDto, actor: Actor) {
    try {
      await this.owned(this.pg, 'br11_sales_orders', dto.sales_order_id, actor);
      const r = await this.pg.query(`SELECT br08_build_sales_invoice($1,$2,$3::jsonb,$4) AS d`,
        [actor.companyId, dto.sales_order_id, dto.lines ? JSON.stringify(dto.lines) : null, dto.credit_days ?? null]);
      return { ...r.rows[0].d, invoice_number: null, preview: true, jobs: [] };
    } catch (e) { this.rethrow(e); }
  }

  async issueSalesInvoice(dto: SalesInvoiceRequestDto, idem: string, actor: Actor) {
    if (!idem) throw new BadRequestException('Idempotency-Key header required');
    try {
      const id = await this.pg.tx(async (client) => {
        await this.owned(client, 'br11_sales_orders', dto.sales_order_id, actor, true);
        const existed = (await client.query(
          `SELECT invoice_id FROM br08_sales_invoice_sources WHERE company_id=$1 AND idempotency_key=$2`,
          [actor.companyId, idem])).rows[0];
        const invId = (await client.query(`SELECT br08_issue_sales_invoice($1,$2,$3,$4::jsonb,$5,$6) AS id`,
          [actor.companyId, actor.id, dto.sales_order_id, dto.lines ? JSON.stringify(dto.lines) : null,
            dto.credit_days ?? null, idem])).rows[0].id;
        if (!existed) {
          const inv = (await client.query(`SELECT * FROM br08_invoices WHERE id=$1`, [invId])).rows[0];
          await this.audit(client, actor, 'br08_invoices', invId, 'BR08_PRODUCT_SALES_INVOICE_ISSUED', null, inv);
        }
        return invId;
      });
      return this.getInvoice(id, actor);
    } catch (e) { this.rethrow(e); }
  }

  async getInvoice(invoiceId: string, actor: Actor) {
    const inv = await this.owned(this.pg, 'br08_invoices', invoiceId, actor);
    const [salesLines, salesSource] = await Promise.all([
      this.pg.query(`SELECT * FROM br08_invoice_sales_lines WHERE invoice_id=$1 ORDER BY line_no`, [invoiceId]),
      this.pg.query(
        `SELECT s.*, so.sales_order_number FROM br08_sales_invoice_sources s
           JOIN br11_sales_orders so ON so.id=s.sales_order_id WHERE s.invoice_id=$1`, [invoiceId]),
    ]);
    const [jobs, lines, allocations, cn] = await Promise.all([
      this.pg.query(
        `SELECT ij.*, sj.job_number, dc.challan_number FROM br08_invoice_jobs ij
           JOIN service_jobs sj ON sj.id=ij.job_id
           LEFT JOIN br08_delivery_challans dc ON dc.batch_id=ij.dispatch_batch_id
          WHERE ij.invoice_id=$1 ORDER BY sj.job_number`, [invoiceId]),
      this.pg.query(`SELECT * FROM br08_invoice_lines WHERE invoice_id=$1 ORDER BY line_no`, [invoiceId]),
      this.pg.query(`SELECT * FROM br08_payment_allocations WHERE invoice_id=$1 ORDER BY allocated_at`, [invoiceId]),
      this.pg.query(`SELECT * FROM br08_credit_notes WHERE invoice_id=$1`, [invoiceId]),
    ]);
    return {
      ...inv,
      balance_paise: String(BigInt(inv.total_paise) - BigInt(inv.amount_paid_paise)),
      jobs: jobs.rows, lines: lines.rows, sales_lines: salesLines.rows, sales_source: salesSource.rows[0] ?? null,
      allocations: allocations.rows, credit_note: cn.rows[0] ?? null,
    };
  }

  /** Print payload: one document, rendered three times with these copy labels. */
  async printInvoice(invoiceId: string, actor: Actor) {
    const document = await this.getInvoice(invoiceId, actor);
    return { copies: [...INVOICE_COPIES], document };
  }

  async listInvoices(q: ListInvoicesQueryDto, actor: Actor) {
    const r = await this.pg.query(
      `SELECT * FROM br08_invoices
        WHERE company_id=$1 AND ($2::text IS NULL OR invoice_status=$2) AND ($3::uuid IS NULL OR customer_id=$3)
        ORDER BY issued_at DESC LIMIT 200`,
      [actor.companyId, q.status ?? null, q.customer_id ?? null],
    );
    return r.rows;
  }

  // ================================================================ payments

  async recordPayment(dto: RecordPaymentDto, actor: Actor) {
    try {
      const id = await this.pg.tx(async (client) => {
        await this.owned(client, 'customers', dto.customer_id, actor);
        const rc = (await client.query(
          `INSERT INTO br08_payment_receipts(company_id,customer_id,amount_paise,received_on,payment_mode,payment_reference,remarks,recorded_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [actor.companyId, dto.customer_id, dto.amount_paise, dto.received_on, dto.payment_mode,
            dto.payment_reference ?? null, dto.remarks ?? null, actor.id],
        )).rows[0];
        await this.audit(client, actor, 'br08_payment_receipts', rc.id, 'BR08_PAYMENT_RECEIVED', null, rc);
        for (const a of dto.allocations ?? []) await this.insertAllocation(client, rc.id, a, actor);
        return rc.id;
      });
      return this.getReceipt(id, actor);
    } catch (e) { this.rethrow(e); }
  }

  async allocate(receiptId: string, dto: AllocatePaymentDto, actor: Actor) {
    try {
      await this.pg.tx(async (client) => {
        await this.owned(client, 'br08_payment_receipts', receiptId, actor);
        await this.insertAllocation(client, receiptId, dto, actor);
      });
      return this.getReceipt(receiptId, actor);
    } catch (e) { this.rethrow(e); }
  }

  private async insertAllocation(client: PoolClient, receiptId: string, a: { invoice_id: string; amount_paise: number }, actor: Actor) {
    const before = await this.owned(client, 'br08_invoices', a.invoice_id, actor);
    const al = (await client.query(
      `INSERT INTO br08_payment_allocations(company_id,receipt_id,invoice_id,amount_paise,allocated_by_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [actor.companyId, receiptId, a.invoice_id, a.amount_paise, actor.id],
    )).rows[0];
    const after = (await client.query(`SELECT * FROM br08_invoices WHERE id=$1`, [a.invoice_id])).rows[0];
    await this.audit(client, actor, 'br08_invoices', a.invoice_id, 'BR08_PAYMENT_ALLOCATED',
      { invoice_status: before.invoice_status, amount_paid_paise: before.amount_paid_paise },
      { invoice_status: after.invoice_status, amount_paid_paise: after.amount_paid_paise, allocation: al });
    if (after.invoice_status === 'PAID' && before.invoice_status !== 'PAID') {
      const closed = await client.query(
        `SELECT sj.id, sj.job_number, sj.status FROM br08_invoice_jobs ij JOIN service_jobs sj ON sj.id=ij.job_id
          WHERE ij.invoice_id=$1 AND ij.is_live`, [a.invoice_id]);
      for (const j of closed.rows) {
        await this.audit(client, actor, 'service_jobs', j.id, 'BR08_JOB_CLOSED_FULLY_PAID', null,
          { status: j.status, invoice_id: a.invoice_id });
      }
    }
    return al;
  }

  async getReceipt(receiptId: string, actor: Actor) {
    const rc = await this.owned(this.pg, 'br08_payment_receipts', receiptId, actor);
    const allocations = await this.pg.query(
      `SELECT a.*, i.invoice_number, i.invoice_status, i.total_paise, i.amount_paid_paise
         FROM br08_payment_allocations a JOIN br08_invoices i ON i.id=a.invoice_id
        WHERE a.receipt_id=$1 ORDER BY a.allocated_at`, [receiptId]);
    return {
      ...rc,
      unallocated_paise: String(BigInt(rc.amount_paise) - BigInt(rc.allocated_paise)),
      allocations: allocations.rows,
    };
  }

  // ================================================================ credit note

  async raiseCreditNote(invoiceId: string, dto: CreditNoteDto, actor: Actor) {
    try {
      const id = await this.pg.tx(async (client) => {
        const before = await this.owned(client, 'br08_invoices', invoiceId, actor, true);
        const cn = (await client.query(
          `INSERT INTO br08_credit_notes
             (company_id,invoice_id,customer_id,credit_note_number,credit_note_seq,fiscal_year,credit_note_date,
              reason_code,reason,failed_job_id,warranty_return_job_id,
              sub_total_paise,cgst_paise,sgst_paise,igst_paise,total_paise,issued_by_id)
           VALUES ($1,$2,$3,'pending',0,'0000-00',CURRENT_DATE,$4,$5,$6,$7,0,0,0,0,0,$8) RETURNING *`,
          [actor.companyId, invoiceId, before.customer_id, dto.reason_code, dto.reason, dto.failed_job_id ?? null,
            dto.warranty_return_job_id ?? null, actor.id],
        )).rows[0];
        const after = (await client.query(`SELECT * FROM br08_invoices WHERE id=$1`, [invoiceId])).rows[0];
        await this.audit(client, actor, 'br08_invoices', invoiceId, 'BR08_CREDIT_NOTE_INVOICE_CANCELLED', before, { invoice: after, credit_note: cn });
        return cn.id;
      });
      return this.getCreditNote(id, actor);
    } catch (e) { this.rethrow(e); }
  }

  async getCreditNote(cnId: string, actor: Actor) {
    const cn = await this.owned(this.pg, 'br08_credit_notes', cnId, actor);
    const reversals = await this.pg.query(
      `SELECT * FROM br08_payment_allocations WHERE credit_note_id=$1 ORDER BY allocated_at`, [cnId]);
    return { ...cn, payment_reversals: reversals.rows };
  }

  // ================================================================ waiver + job billing

  async waive(jobId: string, dto: WaiverDto, actor: Actor) {
    try {
      return await this.pg.tx(async (client) => {
        const before = await this.owned(client, 'service_jobs', jobId, actor, true);
        const w = (await client.query(
          `INSERT INTO br08_job_waivers(company_id,job_id,reason,waived_by_id) VALUES ($1,$2,$3,$4) RETURNING *`,
          [actor.companyId, jobId, dto.reason, actor.id],
        )).rows[0];
        const job = (await client.query(`SELECT * FROM service_jobs WHERE id=$1`, [jobId])).rows[0];
        await this.audit(client, actor, 'service_jobs', jobId, 'BR08_JOB_WAIVED_NO_CHARGE',
          { status: before.status }, { status: job.status, waiver: w });
        return { waiver: w, job };
      });
    } catch (e) { this.rethrow(e); }
  }

  async jobBilling(jobId: string, actor: Actor) {
    await this.owned(this.pg, 'service_jobs', jobId, actor);
    const r = await this.pg.query(`SELECT * FROM br08_v_job_billing WHERE job_id=$1`, [jobId]);
    return r.rows[0];
  }
}
