import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PgService } from '../../common/database/pg.service';
import { Actor } from './purchase-desk.service';

type StageStatus = 'done' | 'current' | 'pending' | 'blocked';
interface Stage {
  key: string; label: string; status?: StageStatus; at: Date | null; source: string; rule: string; detail: string | null;
  done: boolean; stop?: boolean;
}

const minDate = (...d: (Date | null | undefined)[]) =>
  d.filter((x): x is Date => !!x).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
const maxDate = (...d: (Date | null | undefined)[]) =>
  d.filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

/**
 * C1-1: GET /jobs/:id/progress. A purely DERIVED view over BR-02..BR-08 tables -- nothing is written and
 * no state the DB does not record is invented. Each stage's `rule` string is the exact derivation, also
 * returned to the client:
 *
 *  ASSIGNED          done = a current job_assignments row exists                       at = assigned_at
 *  CUSTODY           done = br03_custody_acknowledgements row for the CURRENT assignment at = acknowledged_at
 *  INSPECTION        done = the job's br03 inspection report has >= 1 submitted version  at = first submitted_at
 *                    (in progress from the first br03_inspection_sessions.started_at)
 *  REPORT_REVIEW     done = inspection report status ACCEPTED                           at = latest ACCEPT reviewed_at
 *  MATERIAL          done = a br03_material_requests row was submitted (submitted_at set, not WITHDRAWN)
 *  QUOTE             done = a revision of the job's br04 quote was sent to the customer
 *                           (activity_audit_log BR04_QUOTE_SENT; the revision row has no sent_at)
 *  AUTHORISATION     done = current br05_job_authorisations row with status AUTHORISED   at = authorised_at
 *  PO_GRN            done = the job has >= 1 non-cancelled supplier PO (br06) and every one has a GRN
 *                    at = latest GRN received_at. No PO at all stays not-done (stock may have covered it).
 *  REPAIR_TEST       done = br07_technical_handoffs row (written only after a PASS)     at = handed_off_at
 *                    blocked when a br07_test_failure_reviews STOP decision exists (BR-07 open decision 3)
 *  DISPATCH_INVOICE  done = (job in a DISPATCHED br08 batch AND on a live br08 invoice) OR a br08 waiver exists
 *
 * Status: the first not-done stage after the last done stage is `current` (`blocked` if the job is
 * ON_HOLD/CANCELLED, or REPAIR_TEST with a STOP); a CLOSED job has no current stage; all else `pending`.
 */
@Injectable()
export class JobProgressService {
  constructor(private readonly pg: PgService) {}

  async progress(jobId: string, actor: Actor) {
    const jr = await this.pg.query(`SELECT * FROM service_jobs WHERE id=$1`, [jobId]);
    const job = jr.rows[0];
    if (!job) throw new NotFoundException('job not found');
    if (job.company_id !== actor.companyId) throw new ForbiddenException('job belongs to another company');

    const q = (sql: string) => this.pg.query(sql, [jobId]).then((r) => r.rows);
    const [
      assignments, acks, sessions, report, versions, accepts, mrs, quotes, sent, auth, pos, repairSessions, tests,
      handoff, stops, dispatch, invoice, waiver,
    ] = await Promise.all([
      q(`SELECT a.*, e.full_name AS engineer_name, b.full_name AS assigned_by_name
           FROM job_assignments a JOIN employees e ON e.id = a.engineer_id JOIN employees b ON b.id = a.assigned_by_id
          WHERE a.job_id=$1 ORDER BY a.assigned_at, a.id`),
      q(`SELECT assignment_id, acknowledged_at FROM br03_custody_acknowledgements WHERE job_id=$1`),
      q(`SELECT min(started_at) AS first_started FROM br03_inspection_sessions WHERE job_id=$1`),
      q(`SELECT id, status, latest_outcome FROM br03_inspection_reports WHERE job_id=$1`),
      q(`SELECT min(v.submitted_at) AS first_submitted, count(*)::int AS n
           FROM br03_inspection_report_versions v JOIN br03_inspection_reports r ON r.id = v.report_id WHERE r.job_id=$1`),
      q(`SELECT max(rv.reviewed_at) AS at FROM br03_inspection_reviews rv
           JOIN br03_inspection_report_versions v ON v.id = rv.version_id
           JOIN br03_inspection_reports r ON r.id = v.report_id
          WHERE r.job_id=$1 AND rv.review_decision = 'ACCEPT'`),
      q(`SELECT request_number, status, submitted_at, created_at FROM br03_material_requests WHERE job_id=$1 ORDER BY created_at`),
      q(`SELECT q.quote_number, q.created_at, lr.quote_status, lr.revision_no
           FROM br04_customer_quotes q
           JOIN LATERAL (SELECT quote_status, revision_no FROM br04_customer_quote_revisions
                          WHERE quote_id = q.id ORDER BY revision_no DESC LIMIT 1) lr ON true
          WHERE q.job_id=$1 ORDER BY q.created_at DESC`),
      q(`SELECT min(l.changed_at) AS at FROM activity_audit_log l
           JOIN br04_customer_quote_revisions v ON v.id = l.entity_id
           JOIN br04_customer_quotes q ON q.id = v.quote_id
          WHERE q.job_id=$1 AND l.entity_table = 'br04_customer_quote_revisions' AND l.action = 'BR04_QUOTE_SENT'`),
      q(`SELECT authorisation_kind, authorisation_status, authorised_at FROM br05_job_authorisations
          WHERE job_id=$1 AND is_current`),
      q(`SELECT p.po_number, p.po_status, p.created_at,
                (SELECT max(g.received_at) FROM br06_grns g WHERE g.po_id = p.id) AS last_grn_at
           FROM br06_supplier_purchase_orders p WHERE p.job_id=$1 AND p.po_status <> 'CANCELLED' ORDER BY p.created_at`),
      q(`SELECT min(started_at) AS first_started FROM br07_repair_sessions WHERE job_id=$1`),
      q(`SELECT cycle_no, result, started_at FROM br07_test_runs WHERE job_id=$1 ORDER BY cycle_no DESC LIMIT 1`),
      q(`SELECT handed_off_at FROM br07_technical_handoffs WHERE job_id=$1 ORDER BY handed_off_at DESC LIMIT 1`),
      q(`SELECT reviewed_at FROM br07_test_failure_reviews WHERE job_id=$1 AND decision = 'STOP' ORDER BY reviewed_at DESC LIMIT 1`),
      q(`SELECT b.dispatched_at, b.batch_status, dc.challan_number
           FROM br08_dispatch_batch_jobs bj JOIN br08_dispatch_batches b ON b.id = bj.batch_id
           LEFT JOIN br08_delivery_challans dc ON dc.batch_id = b.id
          WHERE bj.job_id=$1 ORDER BY b.created_at DESC LIMIT 1`),
      q(`SELECT i.invoice_number, i.invoice_status, i.issued_at FROM br08_invoice_jobs ij JOIN br08_invoices i ON i.id = ij.invoice_id
          WHERE ij.job_id=$1 AND ij.is_live ORDER BY i.issued_at DESC LIMIT 1`),
      q(`SELECT waived_at FROM br08_job_waivers WHERE job_id=$1 ORDER BY waived_at DESC LIMIT 1`),
    ]);

    const current = assignments.find((a) => a.is_current) ?? null;
    const ack = current ? acks.find((a) => a.assignment_id === current.id) : undefined;
    const rep = report[0];
    const ver = versions[0];
    const mrSubmitted = mrs.filter((m) => m.submitted_at && m.status !== 'WITHDRAWN');
    const mrLatest = mrs[mrs.length - 1];
    const quote = quotes[0];
    const a = auth[0];
    const posWithGrn = pos.filter((p) => p.last_grn_at);
    const test = tests[0];
    const disp = dispatch[0];
    const inv = invoice[0];
    const dispatched = disp?.batch_status === 'DISPATCHED';

    const stages: Stage[] = [
      {
        key: 'ASSIGNED', label: 'Engineer assigned', source: 'job_assignments',
        rule: 'done when a current job_assignments row exists; at = assigned_at',
        done: !!current, at: current?.assigned_at ?? null,
        detail: current ? `${current.engineer_name} (${current.response})` : null,
      },
      {
        key: 'CUSTODY', label: 'Custody accepted', source: 'br03_custody_acknowledgements',
        rule: 'done when the CURRENT assignment has a custody acknowledgement; at = acknowledged_at',
        done: !!ack, at: ack?.acknowledged_at ?? null, detail: current ? `assignment ${current.response}` : null,
      },
      {
        key: 'INSPECTION', label: 'Inspection', source: 'br03_inspection_sessions, br03_inspection_report_versions',
        rule: 'done when the inspection report has >= 1 submitted version; at = first submitted_at (else first session start)',
        done: (ver?.n ?? 0) > 0, at: ver?.first_submitted ?? sessions[0]?.first_started ?? null,
        detail: rep?.latest_outcome ?? (sessions[0]?.first_started ? 'session started' : null),
      },
      {
        key: 'REPORT_REVIEW', label: 'Report reviewed', source: 'br03_inspection_reports, br03_inspection_reviews',
        rule: 'done when the inspection report status is ACCEPTED; at = latest ACCEPT review',
        done: rep?.status === 'ACCEPTED', at: accepts[0]?.at ?? null, detail: rep?.status ?? null,
      },
      {
        key: 'MATERIAL', label: 'Material requested', source: 'br03_material_requests',
        rule: 'done when a material request was submitted (submitted_at set, status not WITHDRAWN); at = first submitted_at',
        done: mrSubmitted.length > 0, at: minDate(...mrSubmitted.map((m) => m.submitted_at)),
        detail: mrLatest ? `${mrLatest.request_number} ${mrLatest.status}` : null,
      },
      {
        key: 'QUOTE', label: 'Quote sent', source: 'br04_customer_quotes, br04_customer_quote_revisions, activity_audit_log',
        rule: 'done when a revision of the job\'s quote was sent (BR04_QUOTE_SENT audit row); at = first send',
        done: !!sent[0]?.at, at: sent[0]?.at ?? quote?.created_at ?? null,
        detail: quote ? `${quote.quote_number} rev ${quote.revision_no} ${quote.quote_status}` : null,
      },
      {
        key: 'AUTHORISATION', label: 'Customer authorisation', source: 'br05_job_authorisations',
        rule: 'done when the current authorisation is AUTHORISED; at = authorised_at',
        done: a?.authorisation_status === 'AUTHORISED', at: a?.authorised_at ?? null,
        detail: a ? `${a.authorisation_kind} ${a.authorisation_status}` : null,
      },
      {
        key: 'PO_GRN', label: 'Supplier PO / GRN', source: 'br06_supplier_purchase_orders, br06_grns',
        rule: 'done when the job has >= 1 non-cancelled supplier PO and every one has a GRN; at = latest GRN',
        done: pos.length > 0 && posWithGrn.length === pos.length,
        at: pos.length && posWithGrn.length === pos.length ? maxDate(...pos.map((p) => p.last_grn_at)) : (pos[0]?.created_at ?? null),
        detail: pos.length ? `${pos.length} PO(s), ${posWithGrn.length} with GRN` : 'no supplier PO for this job',
      },
      {
        key: 'REPAIR_TEST', label: 'Repair & test', source: 'br07_repair_sessions, br07_test_runs, br07_technical_handoffs, br07_test_failure_reviews',
        rule: 'done when a technical handoff exists (after a PASS); at = handed_off_at. Blocked by a STOP failure review.',
        done: !!handoff[0], at: handoff[0]?.handed_off_at ?? test?.started_at ?? repairSessions[0]?.first_started ?? null,
        detail: stops[0] ? 'STOP review recorded' : test ? `test cycle ${test.cycle_no} ${test.result ?? 'IN_PROGRESS'}` : null,
        stop: !!stops[0],
      },
      {
        key: 'DISPATCH_INVOICE', label: 'Dispatch & invoice', source: 'br08_dispatch_batches, br08_delivery_challans, br08_invoices, br08_job_waivers',
        rule: 'done when the job is in a DISPATCHED batch AND on a live invoice, or a no-charge waiver exists',
        done: (dispatched && !!inv) || !!waiver[0],
        at: waiver[0]?.waived_at ?? maxDate(dispatched ? disp.dispatched_at : null, inv?.issued_at) ?? null,
        detail: [
          disp ? `${disp.batch_status}${disp.challan_number ? ` DC ${disp.challan_number}` : ''}` : null,
          inv ? `INV ${inv.invoice_number} ${inv.invoice_status}` : null,
          waiver[0] ? 'WAIVED' : null,
        ].filter(Boolean).join(' · ') || null,
      },
    ];

    let lastDone = -1;
    stages.forEach((s, i) => { if (s.done) lastDone = i; });
    let currentKey: string | null = null;
    stages.forEach((s, i) => {
      if (s.done) { s.status = 'done'; return; }
      if (i > lastDone && currentKey === null && job.status !== 'CLOSED') {
        currentKey = s.key;
        s.status = ['ON_HOLD', 'CANCELLED'].includes(job.status) || s.stop ? 'blocked' : 'current';
        return;
      }
      s.status = 'pending';
    });

    return {
      job_id: job.id, job_number: job.job_number, job_status: job.status, current_stage: currentKey,
      stages: stages.map(({ done, stop, ...s }) => s),
      assignments,
    };
  }
}
