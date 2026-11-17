/* eslint-disable */
/**
 * DEV/STAGING ONLY: demo logins + BR-10 access so the Management (/mg) and SYSTEM_ADMIN (/a) MIS screens show every state.
 *
 *   npm run seed:demo-mis   (API running; .env has DATABASE_URL + DEMO_LOGIN_PASSWORD)
 *
 * 1. Ensures logins (password = DEMO_LOGIN_PASSWORD; never printed), company BLR, direct select-then-insert
 *    (employees have no API): DEMO-ADM "Kiran T" SYSTEM_ADMIN, DEMO-MGT "Arun B" MANAGEMENT, DEMO-FIN "Lakshmi R" FINANCE.
 * 2. Through the REAL BR-10 API as DEMO-ADM (every DB guard applies; additive, idempotent: live rows are reused):
 *      bindings: DEMO-MGT R_MGMT_COMPANY, DEMO-FIN R_FINANCE_EXEC -> activated
 *      DEMO-MGT grants: VIEW SERVICE_PIPELINE / QUALITY_WARRANTY / SLA_MONITOR + EXPORT SERVICE_PIPELINE -> STANDARD-approved (ACTIVE)
 *                       EXPORT SLA_MONITOR -> left INACTIVE (export gate "awaiting approval")
 *                       VIEW JOB_PROFITABILITY -> INACTIVE, needs FINANCIAL (DEMO-MGT can't approve their own grant)
 *      DEMO-FIN grant:  VIEW JOB_PROFITABILITY -> INACTIVE, needs FINANCIAL: lands in DEMO-MGT's Approvals queue IF the BLR
 *                       FINANCIAL_GRANT authoriser is MANAGEMENT. This script never sets the authoriser (CLIENT-UNCONFIRMED
 *                       decision); it only reports what is configured.
 * Refuses to run against anything but Neon staging / localhost (CLAUDE.md: never Brightech's server).
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const API = process.env.SEED_API_URL || 'http://localhost:3000/api';
const PASSWORD = process.env.DEMO_LOGIN_PASSWORD;
const dbUrl = process.env.DATABASE_URL || '';
if (!/neon\.tech|localhost|127\.0\.0\.1/.test(dbUrl)) { console.error('Refusing: DATABASE_URL is not Neon staging or localhost'); process.exit(1); }
if (!PASSWORD) { console.error('DEMO_LOGIN_PASSWORD is not set'); process.exit(1); }

const PEOPLE = [
  { code: 'DEMO-ADM', name: 'Kiran T', role: 'SYSTEM_ADMIN' },
  { code: 'DEMO-MGT', name: 'Arun B', role: 'MANAGEMENT' },
  { code: 'DEMO-FIN', name: 'Lakshmi R', role: 'FINANCE' },
];

async function call(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    // No JSON content-type on a body-less POST: Fastify rejects an empty body declared as JSON.
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  const c = new Client({ connectionString: dbUrl });
  c.on('error', () => undefined);
  await c.connect();
  const co = (await c.query(`SELECT id FROM legal_entities WHERE entity_code='BLR'`)).rows[0];
  if (!co) throw new Error('company BLR missing -- POST /api/dashboard/seed first');
  const hash = await bcrypt.hash(PASSWORD, 10);
  const ids = {};
  const loginsCreated = [];
  for (const p of PEOPLE) {
    let e = (await c.query(`SELECT id, role_code FROM employees WHERE company_id=$1 AND employee_code=$2`, [co.id, p.code])).rows[0];
    if (!e) {
      e = (await c.query(`INSERT INTO employees(company_id,employee_code,full_name,role_code) VALUES ($1,$2,$3,$4) RETURNING id, role_code`,
        [co.id, p.code, p.name, p.role])).rows[0];
    }
    if (e.role_code !== p.role) throw new Error(`${p.code} exists with role ${e.role_code}, expected ${p.role}`);
    if (!(await c.query(`SELECT 1 FROM employee_credentials WHERE employee_id=$1`, [e.id])).rows[0]) {
      await c.query(`INSERT INTO employee_credentials(employee_id,login_id,password_hash) VALUES ($1,$2,$3)`, [e.id, p.code, hash]);
      loginsCreated.push(p.code);
    }
    ids[p.code] = e.id;
  }
  await c.end();

  const login = async (id) => (await call('POST', '/auth/login', null, { login_id: id, password: PASSWORD })).access_token;
  const ADM = await login('DEMO-ADM');

  // ---- bindings (reuse a live one)
  const bindings = await call('GET', '/mis/role-bindings', ADM);
  const bind = async (code, role) => {
    let b = bindings.find((x) => x.employee_id === ids[code] && x.role_code === role && x.status !== 'REVOKED');
    if (!b) b = await call('POST', '/mis/role-bindings', ADM, { employee_id: ids[code], role_code: role, note: 'demo-mis-seed' });
    if (b.status === 'INACTIVE') b = await call('POST', `/mis/role-bindings/${b.id}/activate`, ADM);
    return `${code} ${role} ${b.status}`;
  };
  const out = { logins_created_now: loginsCreated, bindings: [], grants: [] };
  out.bindings.push(await bind('DEMO-MGT', 'R_MGMT_COMPANY'));
  out.bindings.push(await bind('DEMO-FIN', 'R_FINANCE_EXEC'));

  // ---- grants (reuse a live one; approve STANDARD ones only when asked)
  const grants = await call('GET', '/mis/report-grants', ADM);
  const grant = async (code, report, action, approve) => {
    let g = grants.find((x) => x.employee_id === ids[code] && x.report_code === report && x.action === action
      && x.target_company_id === co.id && x.status !== 'REVOKED');
    if (!g) g = await call('POST', '/mis/report-grants', ADM, { employee_id: ids[code], report_code: report, action, note: 'demo-mis-seed' });
    if (approve && g.status === 'INACTIVE' && g.required_approvals.includes('STANDARD')) {
      g = await call('POST', `/mis/report-grants/${g.id}/approve`, ADM, { approval_kind: 'STANDARD' });
    }
    return `${code} ${action} ${report} ${g.status} (needs ${g.required_approvals.join('+')})`;
  };
  for (const r of ['SERVICE_PIPELINE', 'QUALITY_WARRANTY', 'SLA_MONITOR']) out.grants.push(await grant('DEMO-MGT', r, 'VIEW', true));
  out.grants.push(await grant('DEMO-MGT', 'SERVICE_PIPELINE', 'EXPORT', true));
  out.grants.push(await grant('DEMO-MGT', 'SLA_MONITOR', 'EXPORT', false));
  out.grants.push(await grant('DEMO-MGT', 'JOB_PROFITABILITY', 'VIEW', false));
  out.grants.push(await grant('DEMO-FIN', 'JOB_PROFITABILITY', 'VIEW', false));

  const auth = await call('GET', '/mis/authorities', ADM);
  out.authorities = auth.map((a) => `${a.authority_kind}: ${a.approver_role_code ?? 'NOT CONFIGURED (restricted grants blocked)'}`);
  const MGT = await login('DEMO-MGT');
  out.demo_mgt_pending_approvals = (await call('GET', '/mis/report-grants/pending-my-approval', MGT))
    .map((g) => `${g.employee_code} ${g.action} ${g.report_code} -> can give ${g.can_approve_kinds.join(',')}`);
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
