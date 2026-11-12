import { Client } from 'pg';
import request from 'supertest';
import { BASE, db, dbRejects, Fixtures, fails, forgedToken, loginFor, ok, RUN, setupFixtures } from './helpers';

/**
 * JWT auth (migration 011 + src/modules/auth). Uses its own fixture employees;
 * every assertion goes through the live HTTP API except the DB-layer guards.
 */
describe('Auth (JWT login / refresh / logout)', () => {
  let c: Client;
  let f: Fixtures;
  const post = (path: string, body: object, token?: string) => {
    const r = request(BASE).post(path).send(body);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  const get = (path: string, token?: string) => {
    const r = request(BASE).get(path);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  const events = async (employeeId: string | null, login: string) =>
    (await c.query(
      `SELECT event_type, reason FROM auth_events
        WHERE (employee_id=$1 OR ($1::uuid IS NULL AND lower(login_id_attempted)=lower($2)))
        ORDER BY id`, [employeeId, login],
    )).rows;

  beforeAll(async () => { c = await db(); f = await setupFixtures(c); });
  afterAll(() => c?.end());

  it('login returns an access + refresh pair; identity comes from the employee record', async () => {
    const body = ok(await post('/auth/login', loginFor(f.purchase)));
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token.split('.')).toHaveLength(3);
    expect(body.refresh_token.length).toBeGreaterThan(30);
    expect(body.user).toMatchObject({ id: f.purchase, role: 'PURCHASE', company_id: f.companyId });
    expect(JSON.stringify(body)).not.toMatch(/password|\$2[aby]\$/);

    const me = ok(await get('/auth/me', body.access_token));
    expect(me).toMatchObject({ id: f.purchase, role: 'PURCHASE', login_id: loginFor(f.purchase).login_id });
  });

  it('login is case-insensitive on login_id', async () => {
    const { login_id, password } = loginFor(f.engineer);
    ok(await post('/auth/login', { login_id: login_id.toLowerCase(), password }));
  });

  it('wrong password and unknown login both fail with the same 401, and both are audited', async () => {
    const { login_id } = loginFor(f.sales);
    const bad = await post('/auth/login', { login_id, password: 'definitely-wrong' });
    const unknown = await post('/auth/login', { login_id: `IT-NOPE-${RUN}`, password: 'x' });
    fails(bad, 401); fails(unknown, 401);
    expect(bad.body.message).toBe(unknown.body.message);

    expect(await events(f.sales, login_id)).toContainEqual({ event_type: 'LOGIN_FAILED', reason: 'BAD_PASSWORD' });
    expect(await events(null, `IT-NOPE-${RUN}`)).toContainEqual({ event_type: 'LOGIN_FAILED', reason: 'UNKNOWN_LOGIN' });
  });

  it('protected routes need a valid token; public routes do not', async () => {
    fails(await get('/masters/items'), 401);
    fails(await get('/masters/items', 'not.a.jwt'), 401);
    fails(await get('/masters/items', forgedToken({ sub: f.purchase, role: 'PURCHASE', company_id: f.companyId })), 401);
    ok(await get('/health'));
  });

  it('refresh rotates the token; re-using a rotated token revokes the whole chain', async () => {
    const first = ok(await post('/auth/login', loginFor(f.stores)));
    const second = ok(await post('/auth/refresh', { refresh_token: first.refresh_token }));
    expect(second.refresh_token).not.toBe(first.refresh_token);
    ok(await get('/auth/me', second.access_token));

    // Replay the already-rotated first token -> rejected, and the newer token dies with it.
    fails(await post('/auth/refresh', { refresh_token: first.refresh_token }), 401);
    fails(await post('/auth/refresh', { refresh_token: second.refresh_token }), 401);
    expect(await events(f.stores, '')).toContainEqual({ event_type: 'REFRESH_REUSE_DETECTED', reason: 'ROTATED_TOKEN_REUSED' });
  });

  it('logout revokes the refresh token (idempotent, no information leak)', async () => {
    const s = ok(await post('/auth/login', loginFor(f.purchase2)));
    expect(ok(await post('/auth/logout', { refresh_token: s.refresh_token }))).toEqual({ revoked: true });
    expect(ok(await post('/auth/logout', { refresh_token: s.refresh_token }))).toEqual({ revoked: false });
    fails(await post('/auth/refresh', { refresh_token: s.refresh_token }), 401);
    expect(await events(f.purchase2, '')).toContainEqual({ event_type: 'LOGOUT', reason: null });
  });

  it('role changes and deactivation take effect at the next refresh / login', async () => {
    const s = ok(await post('/auth/login', loginFor(f.sales)));
    await c.query(`UPDATE employees SET role_code='FINANCE' WHERE id=$1`, [f.sales]);
    const r = ok(await post('/auth/refresh', { refresh_token: s.refresh_token }));
    expect(r.user.role).toBe('FINANCE');

    await c.query(`UPDATE employees SET is_active=false WHERE id=$1`, [f.sales]);
    fails(await post('/auth/refresh', { refresh_token: r.refresh_token }), 401);
    fails(await post('/auth/login', loginFor(f.sales)), 401);
    expect(await events(f.sales, '')).toContainEqual({ event_type: 'LOGIN_FAILED', reason: 'EMPLOYEE_INACTIVE' });
  });

  it('DB layer: plain-text passwords cannot be stored; auth_events is append-only', async () => {
    const plain = await dbRejects(c,
      `UPDATE employee_credentials SET password_hash='hunter2' WHERE employee_id=$1`, [f.purchase]);
    expect(plain).toMatch(/check constraint/i);
    const mutate = await dbRejects(c, `DELETE FROM auth_events WHERE employee_id=$1`, [f.purchase]);
    expect(mutate).toMatch(/append_only/);
  });
});
