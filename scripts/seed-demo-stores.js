/* eslint-disable */
/**
 * DEV/STAGING ONLY: give the Stores / Quality screens real POs to receive.
 *
 *   npm run seed:demo-stores                  (API running; .env has DATABASE_URL + DEMO_LOGIN_PASSWORD)
 *   npm run seed:demo-stores -- --limit 3     (default 2 jobs, newest eligible quotes first)
 *
 * It CONSUMES demo-purchase jobs (their quotes move to SENT + ACCEPTED), so to keep the existing Purchase / Sales demo
 * rows as they are, first add a fresh batch:  npm run seed:demo-purchase -- --again   then run this.
 *
 * 1. Ensures a DEMO-STO login (role STORES_QUALITY, password = DEMO_LOGIN_PASSWORD; never printed). Direct insert,
 *    select-then-insert, same as seed:demo-purchase (employees have no API).
 * 2. Takes every demo-purchase job whose customer quote is still DRAFT / RELEASED_TO_SALES and has COMPLIANT supplier
 *    offer lines, and drives it through the REAL API to a supplier PO:
 *      BR-04 release-to-sales (if DRAFT) -> Sales send -> BR-05 customer response ACCEPTED -> email authority + verify
 *      -> order allocation + verify -> authorisation -> stock recheck -> job release
 *      -> BR-06 PO (the first invite's compliant lines) -> release -> acknowledge.
 *    The first PO also gets a shipment (carrier + AWB) -> SHIPPED; the rest stay ACKNOWLEDGED. Both take GRNs.
 * Rerun: jobs already past those quote states are skipped, so nothing is duplicated (run seed:demo-purchase -- --again
 * for more). Refuses to run against anything but Neon staging / localhost (CLAUDE.md: never Brightech's server).
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const API = process.env.SEED_API_URL || 'http://localhost:3000/api';
const PASSWORD = process.env.DEMO_LOGIN_PASSWORD;
const DEMO_CUSTOMERS = ['DEMO-CUST-KVP', 'DEMO-CUST-DSR', 'DEMO-CUST-SPI', 'DEMO-CUST-CTL'];
const LIMIT = Number(process.argv[process.argv.indexOf('--limit') + 1]) || 2;
const CARRIERS = [['DTDC', 'D4409'], ['Professional Couriers', 'PC5521'], ['Blue Dart', 'BD7781']];

const dbUrl = process.env.DATABASE_URL || '';
if (!/neon\.tech|localhost|127\.0\.0\.1/.test(dbUrl)) { console.error('Refusing: DATABASE_URL is not Neon staging or localhost'); process.exit(1); }
if (!PASSWORD) { console.error('DEMO_LOGIN_PASSWORD is not set'); process.exit(1); }

async function call(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    // No JSON content-type on a body-less POST: Fastify rejects an empty body declared as JSON (same as seed-demo-purchase).
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return json;
}
const daysFromNow = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

(async () => {
  // ---------------------------------------------------------------- DEMO-STO login
  const c = new Client({ connectionString: dbUrl });
  c.on('error', () => undefined);
  await c.connect();
  const co = (await c.query(`SELECT id FROM legal_entities WHERE entity_code='BLR'`)).rows[0];
  if (!co) throw new Error('company BLR missing -- POST /api/dashboard/seed first');
  let sto = (await c.query(`SELECT id, role_code FROM employees WHERE company_id=$1 AND employee_code='DEMO-STO'`, [co.id])).rows[0];
  if (!sto) {
    sto = (await c.query(
      `INSERT INTO employees(company_id,employee_code,full_name,role_code) VALUES ($1,'DEMO-STO','Meena S','STORES_QUALITY') RETURNING id, role_code`,
      [co.id],
    )).rows[0];
  }
  if (sto.role_code !== 'STORES_QUALITY') throw new Error(`DEMO-STO exists with role ${sto.role_code}`);
  let loginCreated = false;
  if (!(await c.query(`SELECT 1 FROM employee_credentials WHERE employee_id=$1`, [sto.id])).rows[0]) {
    await c.query(`INSERT INTO employee_credentials(employee_id,login_id,password_hash) VALUES ($1,'DEMO-STO',$2)`,
      [sto.id, await bcrypt.hash(PASSWORD, 10)]);
    loginCreated = true;
  }
  await c.end();

  // ---------------------------------------------------------------- sessions
  const login = async (id) => (await call('POST', '/auth/login', null, { login_id: id, password: PASSWORD })).access_token;
  const P = await login('DEMO-PUR');
  const S = await login('DEMO-SAL');
  const salesId = (await call('GET', '/auth/me', S)).id;

  // ---------------------------------------------------------------- candidates
  const customers = (await call('GET', '/lookups/customers?page_size=100', P)).rows
    .filter((r) => DEMO_CUSTOMERS.includes(r.customer_code)).map((r) => r.id);
  const quotes = (await call('GET', '/quotes?page_size=100', P)).rows
    .filter((q) => customers.includes(q.customer_id) && ['DRAFT', 'RELEASED_TO_SALES'].includes(q.latest_quote_status))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const inbox = await call('GET', '/material-requests', P);

  const out = { login_created_now: loginCreated ? ['DEMO-STO'] : [], purchase_orders: [], skipped: [] };
  for (const q of quotes) {
    if (out.purchase_orders.length >= LIMIT) break;
    const job = q.job_id;
    // Compliant offer lines, grouped by supplier invite (one PO = one supplier).
    const byInvite = new Map();
    for (const r of await call('GET', `/jobs/${job}/rfqs`, P)) {
      const rfq = await call('GET', `/rfqs/${r.id}`, P);
      for (const o of rfq.offers ?? []) {
        const ok = (o.lines ?? []).filter((l) => l.technical_status === 'COMPLIANT').map((l) => l.id);
        if (ok.length) byInvite.set(o.supplier_invite_id, [...(byInvite.get(o.supplier_invite_id) ?? []), ...ok]);
      }
    }
    const offerLines = [...byInvite.values()][0];
    const mr = (Array.isArray(inbox) ? inbox : inbox.rows ?? []).find((m) => m.job_id === job);
    if (!offerLines || !mr) { out.skipped.push(`${q.quote_number}: ${!offerLines ? 'no compliant offer lines' : 'no material request'}`); continue; }

    // BR-04 -> Sales
    let full = await call('GET', `/quotes/${q.id}`, P);
    let latest = full.revisions.reduce((a, b) => (b.revision_no > a.revision_no ? b : a));
    if (latest.quote_status === 'DRAFT') await call('POST', `/quotes/${q.id}/release-to-sales`, P, { assigned_sales_id: salesId });
    await call('POST', `/quotes/${q.id}/send`, S);
    full = await call('GET', `/quotes/${q.id}`, P);
    latest = full.revisions.reduce((a, b) => (b.revision_no > a.revision_no ? b : a));

    // BR-05 customer acceptance -> authorisation -> release
    const resp = await call('POST', `/jobs/${job}/quote-responses`, S, {
      br04_quote_revision_id: latest.id, response_type: 'ACCEPTED', response_channel: 'EMAIL', customer_contact: 'Purchase desk, by email',
    });
    const order = await call('POST', `/jobs/${job}/customer-authority`, P, {
      authority_type: 'EMAIL_AUTHORISATION', customer_email_sender: 'purchase@customer.example', customer_email_received_at: new Date().toISOString(),
    });
    await call('POST', `/customer-authority/${order.id}/verify`, P, {});
    const alloc = await call('POST', `/jobs/${job}/order-allocations`, P, {
      order_id: order.id, quote_revision_ref_id: resp.quote_revision_ref_id, allocated_pre_tax: Number(latest.revised_pre_tax),
    });
    await call('POST', `/order-allocations/${alloc.id}/verify`, P);
    await call('POST', `/jobs/${job}/authorisations`, P, { order_job_allocation_id: alloc.id });
    await call('POST', `/jobs/${job}/stock-rechecks`, P, { material_request_id: mr.id });
    await call('POST', `/jobs/${job}/release`, P, { release_notes: 'Demo: customer accepted by email [demo-stores-seed]' });

    // BR-06 PO -> release -> acknowledge (-> shipment for the first one)
    const po = await call('POST', `/jobs/${job}/purchase-orders`, P, { offer_line_ids: offerLines });
    await call('POST', `/purchase-orders/${po.id}/release`, P);
    const i = out.purchase_orders.length;
    await call('POST', `/purchase-orders/${po.id}/acknowledge`, P, {
      supplier_reference: `SO/${po.po_number}`, expected_delivery_date: daysFromNow(2 + i),
    });
    let status = 'ACKNOWLEDGED';
    if (i === 0) {
      const [carrier, awb] = CARRIERS[i % CARRIERS.length];
      await call('POST', `/purchase-orders/${po.id}/shipment`, P, {
        carrier, awb_or_lr_number: `${awb} ${String(Date.now()).slice(-6)}`, expected_arrival_date: daysFromNow(0),
      });
      status = 'SHIPPED';
    }
    out.purchase_orders.push(`${po.po_number} (${q.job_number}, ${po.lines.length} line${po.lines.length === 1 ? '' : 's'}, ${status})`);
  }

  if (!out.purchase_orders.length) out.note = 'No eligible demo jobs left -- run `npm run seed:demo-purchase -- --again` first, then rerun this.';
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
