/* eslint-disable */
/**
 * Loads Brightech's CLIENT-CONFIRMED configuration (answers of 26 Nov 2026). Idempotent: re-run any time.
 *
 *   npm run seed:client-config                        (BLR + CHN if they exist)
 *   npm run seed:client-config -- --create-missing-entities   (also creates CHN "Brightech Engineering" if absent)
 *
 * Writes the same tables the SYSTEM_ADMIN config endpoints write (each value stays editable there):
 *   company_policy_config   PUT /company-config            discount 5% (enforced) + stored-only policy values
 *   br09_authority_config   PUT /support-config/authorities claim + goodwill = PURCHASE, refund = FINANCE, replacement = SALES
 *   br10_authority_config   PUT /mis/authorities            FINANCIAL_GRANT = MANAGEMENT (MD)
 *   br11_company_policies   PUT /sales-config/policy        invoice trigger DISPATCH, no payment before closure, advance NONE
 *   br08_gst_rate_config    (no endpoint)                   PRODUCT_SALE 18% (9 + 9 / 18), HSN per item (row HSN NULL)
 *   legal_entities (CHN)    PUT /br08/entity-profile        GSTIN 33CVKPP7269M2ZP, state 33
 * Never touches: holidays (client list pending), bank details (loaded separately), CROSS_COMPANY_GRANT (no answer).
 *
 * Attribution: config rows carry updated_by = the company's first non-test SYSTEM_ADMIN (env SEED_ADMIN_CODE overrides);
 * br11_company_policies REQUIRES one, so a company without an admin is skipped there. One audit row per company
 * (CLIENT_CONFIG_SEEDED, before/after of every table touched).
 */
const { Client } = require('pg');

const CREATE = process.argv.includes('--create-missing-entities');
const NOTE = 'Client-confirmed 26 Nov 2026 (seed:client-config)';

const POLICY = {
  max_discount_percent: 5,
  customer_return_window_days: 15,
  supplier_return_window_min_days: 15,
  supplier_return_window_max_days: 20,
  return_freight_payer: 'CUSTOMER',
  quote_followup_days: 5,
  rma_turnaround_target_working_days: null, // configurable, no value yet
  customer_return_authority_role: 'SALES',
  supplier_refund_authority_role: 'FINANCE',
  kpi_signoff_authority_role: 'MANAGEMENT',
};
const BR09 = { CLAIM_DECISION: 'PURCHASE', GOODWILL_APPROVAL: 'PURCHASE', REFUND_REPLACEMENT_REVIEW: 'FINANCE', REPLACEMENT_APPROVAL: 'SALES' };
const BR10 = { FINANCIAL_GRANT: 'MANAGEMENT' };
const BR11 = { invoice_trigger: 'DISPATCH', requires_full_payment_for_closure: false, advance_policy: 'NONE' };
const ENTITY = { CHN: { name: 'Brightech Engineering', gstin: '33CVKPP7269M2ZP', state_code: '33' } };

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;
  try {
    // -------- global: product GST rate (HSN per item -> row HSN NULL)
    await c.query('BEGIN');
    const gst = (await q(`SELECT * FROM br08_gst_rate_config WHERE is_active AND quote_line_type='PRODUCT_SALE'`))[0];
    if (gst && gst.hsn_sac === null && Number(gst.cgst_rate) === 9 && Number(gst.sgst_rate) === 9 && Number(gst.igst_rate) === 18) {
      console.log('GST     PRODUCT_SALE 9/9/18, HSN per item: already set');
    } else {
      if (gst) await c.query(`UPDATE br08_gst_rate_config SET is_active=false WHERE id=$1`, [gst.id]);
      await c.query(`INSERT INTO br08_gst_rate_config(quote_line_type,hsn_sac,cgst_rate,sgst_rate,igst_rate) VALUES ('PRODUCT_SALE',NULL,9,9,18)`);
      await c.query(
        `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
         SELECT id,NULL,'br08_gst_rate_config',id,'CLIENT_CONFIG_SEEDED',$1,$2 FROM legal_entities WHERE entity_code='BLR'`,
        [gst ?? null, { quote_line_type: 'PRODUCT_SALE', hsn_sac: null, cgst_rate: 9, sgst_rate: 9, igst_rate: 18 }]);
      console.log(`GST     PRODUCT_SALE 9/9/18, HSN per item: ${gst ? 'replaced the previous row' : 'set'}`);
    }
    await c.query('COMMIT');

    for (const code of ['BLR', 'CHN']) {
      await c.query('BEGIN');
      let co = (await q(`SELECT * FROM legal_entities WHERE entity_code=$1`, [code]))[0];
      if (!co && ENTITY[code] && CREATE) {
        co = (await q(`INSERT INTO legal_entities(entity_code,name) VALUES ($1,$2) RETURNING *`, [code, ENTITY[code].name]))[0];
        await q(`SELECT cal_seed_client_calendar($1)`, [co.id]);
        await q(`SELECT br08_seed_entity_profile($1)`, [co.id]);
        console.log(`${code}     legal entity created (${ENTITY[code].name}) + client calendar + entity profile seed`);
      }
      if (!co) { await c.query('ROLLBACK'); console.log(`${code}     SKIPPED: no legal entity (re-run with --create-missing-entities)`); continue; }

      const admin = (await q(
        `SELECT id, employee_code FROM employees WHERE company_id=$1 AND role_code='SYSTEM_ADMIN' AND is_active
            AND (employee_code=$2 OR ($2 IS NULL AND employee_code NOT LIKE 'IT-%'))
          ORDER BY created_at LIMIT 1`, [co.id, process.env.SEED_ADMIN_CODE ?? null]))[0];
      const by = admin?.id ?? null;
      const before = {}; const after = {};

      // entity profile (CHN only: the client gave its GSTIN + state)
      if (ENTITY[code]) {
        before.legal_entity = (await q(`SELECT gstin, state_code, doc_prefix, legal_name FROM legal_entities WHERE id=$1`, [co.id]))[0];
        after.legal_entity = (await q(
          `UPDATE legal_entities SET gstin=$2, state_code=$3 WHERE id=$1 RETURNING gstin, state_code, doc_prefix, legal_name`,
          [co.id, ENTITY[code].gstin, ENTITY[code].state_code]))[0];
      }

      // company policy
      before.company_policy_config = (await q(`SELECT * FROM company_policy_config WHERE company_id=$1`, [co.id]))[0] ?? null;
      const cols = Object.keys(POLICY);
      after.company_policy_config = (await q(
        `INSERT INTO company_policy_config(company_id,${cols.join(',')},note,updated_by_id)
         VALUES ($1,${cols.map((_, i) => `$${i + 2}`).join(',')},$${cols.length + 2},$${cols.length + 3})
         ON CONFLICT (company_id) DO UPDATE SET ${cols.map((k) => `${k}=EXCLUDED.${k}`).join(',')},
           note=EXCLUDED.note, updated_by_id=EXCLUDED.updated_by_id, updated_at=now()
         RETURNING *`, [co.id, ...cols.map((k) => POLICY[k]), NOTE, by]))[0];

      // BR-09 / BR-10 authorities
      before.br09 = await q(`SELECT decision_kind, approver_role_code FROM br09_authority_config WHERE company_id=$1`, [co.id]);
      for (const [kind, role] of Object.entries(BR09)) {
        await q(`INSERT INTO br09_authority_config(company_id,decision_kind,approver_role_code,note,updated_by_id) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (company_id,decision_kind) DO UPDATE SET approver_role_code=EXCLUDED.approver_role_code,
                   note=EXCLUDED.note, updated_by_id=EXCLUDED.updated_by_id, updated_at=now()`, [co.id, kind, role, NOTE, by]);
      }
      after.br09 = BR09;
      before.br10 = await q(`SELECT authority_kind, approver_role_code FROM br10_authority_config WHERE company_id=$1`, [co.id]);
      for (const [kind, role] of Object.entries(BR10)) {
        await q(`INSERT INTO br10_authority_config(company_id,authority_kind,approver_role_code,note,updated_by_id) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (company_id,authority_kind) DO UPDATE SET approver_role_code=EXCLUDED.approver_role_code,
                   note=EXCLUDED.note, updated_by_id=EXCLUDED.updated_by_id, updated_at=now()`, [co.id, kind, role, NOTE, by]);
      }
      after.br10 = BR10;

      // BR-11 policy (needs an employee for updated_by_id)
      before.br11 = (await q(`SELECT invoice_trigger, requires_full_payment_for_closure, advance_policy FROM br11_company_policies WHERE company_id=$1`, [co.id]))[0] ?? null;
      if (by) {
        await q(`INSERT INTO br11_company_policies(company_id,invoice_trigger,requires_full_payment_for_closure,advance_policy,note,updated_by_id)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (company_id) DO UPDATE SET invoice_trigger=EXCLUDED.invoice_trigger,
                   requires_full_payment_for_closure=EXCLUDED.requires_full_payment_for_closure, advance_policy=EXCLUDED.advance_policy,
                   note=EXCLUDED.note, updated_by_id=EXCLUDED.updated_by_id, updated_at=now()`,
          [co.id, BR11.invoice_trigger, BR11.requires_full_payment_for_closure, BR11.advance_policy, NOTE, by]);
        after.br11 = BR11;
      }

      await q(`INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
               VALUES ($1,$2,'company_policy_config',$1,'CLIENT_CONFIG_SEEDED',$3,$4)`, [co.id, by, before, after]);
      await c.query('COMMIT');

      const cal = (await q(
        `SELECT w.timezone, json_agg(json_build_object('dow',r.iso_dow,'open',r.start_local,'close',r.end_local,
                  'lunch',r.break_start_local||'-'||r.break_end_local) ORDER BY r.iso_dow) AS rules
           FROM working_calendars w JOIN working_calendar_day_rules r ON r.calendar_id=w.id
          WHERE w.company_id=$1 AND w.is_active GROUP BY w.timezone`, [co.id]))[0];
      const hol = (await q(`SELECT count(*)::int AS n FROM calendar_holidays h JOIN working_calendars w ON w.id=h.calendar_id
                             WHERE w.company_id=$1`, [co.id]))[0].n;
      console.log(`${code}     policy + BR-09 + BR-10 set; BR-11 ${by ? 'set' : 'SKIPPED (no SYSTEM_ADMIN employee in this company)'}`
        + `; attributed to ${admin?.employee_code ?? '(none)'}${ENTITY[code] ? `; GSTIN ${after.legal_entity.gstin} state ${after.legal_entity.state_code}` : ''}`);
      console.log(`        calendar: ${cal ? `${cal.timezone} ${JSON.stringify(cal.rules)}` : 'NO ACTIVE CALENDAR'}; holidays loaded: ${hol}`);
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
