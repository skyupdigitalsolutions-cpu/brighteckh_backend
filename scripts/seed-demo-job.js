/* eslint-disable */
/**
 * DEV/STAGING ONLY: give the Engineer UI something real to show.
 *
 *   npm run seed:demo-job     (API must be running; .env must have DATABASE_URL + DEMO_LOGIN_PASSWORD)
 *
 * 1. Ensures a DEMO-ENG engineer login in BLR (password = DEMO_LOGIN_PASSWORD, same as the dashboard seed's
 *    DEMO-PUR / EMP-* logins; never hardcoded, never printed).
 * 2. Ensures demo masters that have no API: customer DEMO-CUST, custody rack DEMO-RACK-01, assembly DEMO-ASM-DRV.
 * 3. Runs the full BR-02 path through the REAL API as DEMO-PUR (all guards + triggers apply):
 *    upload unit photo -> inward receipt (JIN) -> equipment group (qty 1) -> expand -> unit photo -> verify (Job ID)
 *    -> assign DEMO-ENG. Each run creates one NEW job (assignment is PENDING until the engineer acknowledges custody).
 *
 * Refuses to run against anything but Neon staging / localhost (CLAUDE.md: never Brightech's server).
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const API = process.env.SEED_API_URL || 'http://localhost:3000/api';
const PASSWORD = process.env.DEMO_LOGIN_PASSWORD;

// 1x1 PNG (stands in for the unit's inward photo).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

(async () => {
  if (!PASSWORD) throw new Error('DEMO_LOGIN_PASSWORD is not set in .env');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const host = new URL(url).hostname;
  if (!/neon\.tech$|^localhost$|^127\.0\.0\.1$/.test(host)) throw new Error(`refusing to seed ${host} (staging/local only)`);

  const c = new Client({ connectionString: url });
  await c.connect();
  const one = async (sql, p) => (await c.query(sql, p)).rows[0];
  const ensure = async (selectSql, insertSql, p) => (await one(selectSql, p)) || one(insertSql, p);

  let ids;
  try {
    await c.query('BEGIN');
    const company = await one(`SELECT id FROM legal_entities WHERE entity_code='BLR'`);
    if (!company) throw new Error('company BLR missing -- POST /api/dashboard/seed first');
    const co = company.id;

    const eng = await ensure(
      `SELECT id FROM employees WHERE company_id=$1 AND employee_code='DEMO-ENG'`,
      `INSERT INTO employees(company_id,employee_code,full_name,role_code) VALUES ($1,'DEMO-ENG','Demo Engineer','ENGINEER') RETURNING id`,
      [co],
    );
    if (!(await one(`SELECT 1 FROM employee_credentials WHERE employee_id=$1`, [eng.id]))) {
      await c.query(`INSERT INTO employee_credentials(employee_id,login_id,password_hash) VALUES ($1,'DEMO-ENG',$2)`,
        [eng.id, await bcrypt.hash(PASSWORD, 10)]);
    }
    const customer = await ensure(
      `SELECT id FROM customers WHERE company_id=$1 AND customer_code='DEMO-CUST'`,
      `INSERT INTO customers(company_id,customer_code,customer_name,status,state_code,billing_address,credit_days)
       VALUES ($1,'DEMO-CUST','Demo Customer (staging)','APPROVED','29','Demo billing address, Bengaluru',30) RETURNING id`,
      [co],
    );
    const rack = await ensure(
      `SELECT id FROM custody_locations WHERE company_id=$1 AND location_code='DEMO-RACK-01'`,
      `INSERT INTO custody_locations(company_id,location_code,location_name) VALUES ($1,'DEMO-RACK-01','Demo inward rack 01') RETURNING id`,
      [co],
    );
    const assembly = await ensure(
      `SELECT id FROM assemblies WHERE assembly_code='DEMO-ASM-DRV'`,
      `INSERT INTO assemblies(assembly_code,assembly_name,status) VALUES ('DEMO-ASM-DRV','Demo AC Drive 7.5 kW','APPROVED') RETURNING id`,
      [],
    );
    await c.query('COMMIT');
    ids = { eng: eng.id, customer: customer.id, rack: rack.id, assembly: assembly.id };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }

  // ---- BR-02 through the API as DEMO-PUR
  const pur = await call('POST', '/auth/login', null, { login_id: 'DEMO-PUR', password: PASSWORD });
  const t = pur.access_token;
  const purId = (await call('GET', '/auth/me', t)).id;

  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'demo-unit.png');
  const upRes = await fetch(`${API}/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: form });
  const upload = await upRes.json();
  if (!upRes.ok) throw new Error(`POST /uploads -> ${upRes.status}: ${JSON.stringify(upload)}`);

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const jin = await call('POST', '/inward-receipts', t, {
    customer_id: ids.customer, receipt_at: new Date().toISOString(), receipt_channel: 'WALK_IN',
    customer_dc_number: `DEMO-DC-${stamp}`, priority: 'URGENT', priority_reason: 'Demo job for the Engineer UI',
  });
  const group = await call('POST', `/inward-receipts/${jin.id}/equipment-groups`, t, { assembly_id: ids.assembly, quantity_received: 1 });
  const expanded = await call('POST', `/equipment-groups/${group.id}/expand`, t, { location_id: ids.rack, custodian_id: purId });
  const unit = expanded.units[0];
  await call('POST', `/equipment-units/${unit.id}/photos`, t, { file_uri: upload.file_uri, file_name: 'demo-unit.png' });
  const job = (await call('POST', `/equipment-units/${unit.id}/verify`, t)).job;
  await call('POST', `/jobs/${job.id}/assign`, t, { engineer_id: ids.eng });

  console.log(JSON.stringify({
    engineer_login: 'DEMO-ENG', purchase_login: 'DEMO-PUR', password: 'DEMO_LOGIN_PASSWORD from .env',
    jin_number: jin.jin_number, job_number: job.job_number, job_id: job.id, assignment: 'PENDING (engineer must acknowledge custody)',
  }, null, 2));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
