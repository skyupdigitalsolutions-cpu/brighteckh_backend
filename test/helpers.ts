import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { Client } from 'pg';
import request, { Response } from 'supertest';

export const BASE = process.env.TEST_API_URL ?? 'http://localhost:3000/api';
export const RUN = Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1e4);

// ---------------------------------------------------------------- auth

/** Per-run password for every fixture employee (random; never reused across runs). */
const TEST_PASSWORD = `it-${RUN}-${randomBytes(12).toString('base64url')}`;
/** employee id -> login_id, registered when fixtures create a credential. */
const logins = new Map<string, string>();
const tokens = new Map<string, { token: string; at: number }>();

/** Log in as a fixture employee through the real /auth/login and cache the access token. */
export async function tokenFor(employeeId: string): Promise<string> {
  const cached = tokens.get(employeeId);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.token;
  const loginId = logins.get(employeeId);
  if (!loginId) throw new Error(`no test login registered for employee ${employeeId}`);
  const res = await request(BASE).post('/auth/login').send({ login_id: loginId, password: TEST_PASSWORD });
  if (res.status !== 200) throw new Error(`test login failed for ${loginId}: ${res.status} ${JSON.stringify(res.body)}`);
  tokens.set(employeeId, { token: res.body.access_token, at: Date.now() });
  return res.body.access_token;
}

export function loginFor(employeeId: string) {
  return { login_id: logins.get(employeeId)!, password: TEST_PASSWORD };
}

/**
 * A well-formed HS256 JWT claiming the given identity, signed with a key the
 * server does NOT know. Proves role/company can't be asserted by the client.
 */
export function forgedToken(claims: { sub: string; role: string; company_id: string }): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    ...claims, typ: 'access', iat: now, exp: now + 600, iss: 'brightech-jms', aud: 'brightech-jms-api',
  })}`;
  return `${body}.${createHmac('sha256', randomBytes(32)).update(body).digest('base64url')}`;
}

// ---------------------------------------------------------------- HTTP

type Method = 'get' | 'post' | 'put';
/** `actorId` = a fixture employee id: the helper logs in as them and sends Authorization: Bearer. */
export async function api(
  method: Method, path: string, actorId?: string, body?: unknown, headers: Record<string, string> = {},
): Promise<Response> {
  let r = request(BASE)[method](path);
  if (actorId) r = r.set('Authorization', `Bearer ${await tokenFor(actorId)}`);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  if (body !== undefined) r = r.send(body as object);
  return r;
}

/** Assert a 2xx and return the body; on failure, surface the server's message. */
export function ok<T = any>(res: Response): T {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`expected 2xx, got ${res.status} ${(res as any).req?.method} ${(res as any).req?.path}: ${JSON.stringify(res.body)}`);
  }
  return res.body as T;
}

/** Assert a specific failure status (and optionally message pattern). */
export function fails(res: Response, status: number, msg?: RegExp) {
  if (res.status !== status) {
    throw new Error(`expected ${status}, got ${res.status} ${(res as any).req?.method} ${(res as any).req?.path}: ${JSON.stringify(res.body)}`);
  }
  if (msg) expect(JSON.stringify(res.body.message ?? res.body)).toMatch(msg);
}

export const idem = () => `it-${RUN}-${randomUUID()}`;

// ---------------------------------------------------------------- DB (fixtures + read-back only)

export async function db(): Promise<Client> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  // Same reason as PgService: an idle-connection reset must not crash the test process.
  c.on('error', (e) => console.warn(`test pg client error: ${e.message}`));
  await c.connect();
  return c;
}

/**
 * Run SQL that is EXPECTED to be rejected by a DB trigger/constraint, inside a
 * transaction that is always rolled back -- proves the DB layer enforces the
 * rule independently of the API, without leaving any rows behind.
 */
export async function dbRejects(c: Client, sql: string, params: unknown[] = []): Promise<string> {
  await c.query('BEGIN');
  try {
    await c.query(sql, params);
    return '';
  } catch (e) {
    return (e as Error).message;
  } finally {
    await c.query('ROLLBACK');
  }
}

export async function balances(companyId: string, itemId: string, actorId: string) {
  const b = ok(await api('get', `/inventory/availability?company_id=${companyId}&item_id=${itemId}`, actorId));
  const by = (role: string) => Number(b.balances.find((x: any) => x.role === role)?.qty_on_hand ?? 0);
  return {
    allocatable: Number(b.allocatable),
    main: by('MAIN_STORE'), held: by('ENGINEER_HELD'), consumed: by('CONSUMED'),
    quarantine: by('QUARANTINE'), supplierReturn: by('SUPPLIER_RETURN'),
  };
}

// ---------------------------------------------------------------- fixtures

export interface Fixtures {
  companyId: string;
  purchase: string; purchase2: string; engineer: string; sales: string; stores: string;
  finance: string; admin: string; mgmt: string;
  customerId: string; custodyLocationId: string; assemblyId: string;
  loc: Record<string, string>;
}

/**
 * Per-run lookup/master rows that have no API yet (employees, customers, custody
 * locations, BR-01 assemblies). Everything is suffixed with RUN so re-runs never
 * collide. Reuses the company's existing inventory locations (services pick them
 * by role, so creating duplicates would make results nondeterministic).
 */
export async function setupFixtures(c: Client): Promise<Fixtures> {
  const co = await c.query(`SELECT id FROM legal_entities WHERE entity_code='BLR'`);
  if (!co.rows[0]) throw new Error('company BLR missing -- POST /api/dashboard/seed first');
  const companyId = co.rows[0].id;

  // Low bcrypt cost keeps fixture setup fast; the server verifies whatever cost is stored.
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 8);
  const emp = async (code: string, role: string) => {
    const employeeCode = `IT-${code}-${RUN}`;
    const id = (await c.query(
      `INSERT INTO employees(company_id,employee_code,full_name,role_code) VALUES ($1,$2,$3,$4) RETURNING id`,
      [companyId, employeeCode, `IT ${code} ${RUN}`, role],
    )).rows[0].id as string;
    await c.query(
      `INSERT INTO employee_credentials(employee_id,login_id,password_hash) VALUES ($1,$2,$3)`,
      [id, employeeCode, passwordHash],
    );
    logins.set(id, employeeCode);
    return id;
  };

  const purchase = await emp('PUR', 'PURCHASE');
  const purchase2 = await emp('PUR2', 'PURCHASE');
  const engineer = await emp('ENG', 'ENGINEER');
  const sales = await emp('SAL', 'SALES');
  const stores = await emp('SQ', 'STORES_QUALITY');
  const finance = await emp('FIN', 'FINANCE');
  const admin = await emp('ADM', 'SYSTEM_ADMIN');
  const mgmt = await emp('MGT', 'MANAGEMENT');

  const customerId = (await c.query(
    // GST fields for BR-08: Karnataka (29) -- same state as BLR -> CGST+SGST by default.
    `INSERT INTO customers(company_id,customer_code,customer_name,status,gstin,state_code,billing_address,credit_days)
     VALUES ($1,$2,$3,'APPROVED','29AAACI1234A1Z5','29','IT billing address, Bengaluru',30) RETURNING id`,
    [companyId, `IT-CUST-${RUN}`, `IT Customer ${RUN}`],
  )).rows[0].id;
  const custodyLocationId = (await c.query(
    `INSERT INTO custody_locations(company_id,location_code,location_name) VALUES ($1,$2,$3) RETURNING id`,
    [companyId, `IT-RACK-${RUN}`, `IT Rack ${RUN}`],
  )).rows[0].id;
  const assemblyId = (await c.query(
    `INSERT INTO assemblies(assembly_code,assembly_name,status) VALUES ($1,$2,'APPROVED') RETURNING id`,
    [`IT-ASM-${RUN}`, `IT Drive ${RUN}`],
  )).rows[0].id;

  await c.query(
    `INSERT INTO fdn_code_dictionary(kind,cc,ss,tt,label) VALUES ('ITEM','02','02','02','Capacitor / Electrolytic / Aluminium')
     ON CONFLICT (kind,cc,ss,tt) DO NOTHING`,
  );
  const locs = await c.query(
    `SELECT DISTINCT ON (role) role, id FROM fdn_inventory_locations
      WHERE company_id=$1 AND is_active ORDER BY role, code`, [companyId],
  );
  const loc: Record<string, string> = {};
  for (const r of locs.rows) loc[r.role] = r.id;
  for (const role of ['MAIN_STORE', 'ENGINEER_HELD', 'CONSUMED', 'QUARANTINE', 'SUPPLIER_RETURN']) {
    if (!loc[role]) throw new Error(`no active ${role} inventory location for BLR`);
  }

  return { companyId, purchase, purchase2, engineer, sales, stores, finance, admin, mgmt, customerId, custodyLocationId, assemblyId, loc };
}

/**
 * A second company ("company B") for cross-company tests. entity_code must be
 * exactly 3 letters and unique, so this is one fixed, clearly-labelled row
 * shared by all runs (upserted; test:clean removes it).
 */
export async function otherCompany(c: Client): Promise<string> {
  return (await c.query(
    `WITH ins AS (
       INSERT INTO legal_entities(entity_code,name) VALUES ('ZZB','IT test company B (integrity suite)')
       ON CONFLICT (entity_code) DO NOTHING RETURNING id)
     SELECT id FROM ins UNION ALL SELECT id FROM legal_entities WHERE entity_code='ZZB' LIMIT 1`,
  )).rows[0].id;
}

/**
 * A login-capable fixture employee in ANOTHER company (cross-company denial tests).
 * Code/name follow the test:clean root patterns (IT-<ROLE>-<RUN><suffix>).
 */
export async function employeeIn(c: Client, companyId: string, code: 'SAL' | 'PUR' | 'FIN', role: string, suffix: string): Promise<string> {
  const employeeCode = `IT-${code}-${RUN}${suffix}`;
  const id = (await c.query(
    `INSERT INTO employees(company_id,employee_code,full_name,role_code) VALUES ($1,$2,$3,$4) RETURNING id`,
    [companyId, employeeCode, `IT ${code} ${RUN}${suffix}`, role],
  )).rows[0].id as string;
  await c.query(`INSERT INTO employee_credentials(employee_id,login_id,password_hash) VALUES ($1,$2,$3)`,
    [id, employeeCode, await bcrypt.hash(TEST_PASSWORD, 8)]);
  logins.set(id, employeeCode);
  return id;
}

/** Create an item through the Masters API (optionally approve it). Fresh item => balances start at 0. */
export async function createItem(actorId: string, approve: boolean, label: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = '020202' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    const res = await api('post', '/masters/items', actorId, {
      item_code: code, record_type: 'COMPONENT', standard_name: `IT ${label} ${RUN}`,
      cc: '02', ss: '02', tt: '02', base_uom: 'NOS', use_case: 'integrity test',
      stock_flag: 'STOCK', duplicate_review_note: `integrity run ${RUN}`,
    });
    if (res.status === 400 && /duplicate|unique/i.test(JSON.stringify(res.body))) continue;
    const item = ok(res);
    if (approve) ok(await api('post', `/masters/items/${item.id}/approve`, actorId));
    return item.id;
  }
  throw new Error('could not allocate a unique item code');
}

/** BR-03 catalog bridge row (read-only cache of the BR-01 item master; no API writes it). */
export async function bridge(c: Client, itemId: string, status: 'APPROVED' | 'PENDING_APPROVAL'): Promise<string> {
  return (await c.query(
    `INSERT INTO br03_item_catalog_bridge(br01_item_id,item_code,item_name,uom,approval_status)
     VALUES ($1,$2,$3,'NOS',$4) RETURNING id`,
    [itemId, `IT-${RUN}-${itemId.slice(0, 8)}`, `IT bridge ${RUN}`, status],
  )).rows[0].id;
}
