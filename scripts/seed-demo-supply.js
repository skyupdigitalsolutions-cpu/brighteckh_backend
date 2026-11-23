/* eslint-disable */
/**
 * DEV/STAGING ONLY: give the BR-11 Sales & Supply (product sales) screens real rows in every state, for Sales,
 * Purchase, Stores, Finance and SYSTEM_ADMIN smoke tests.
 *
 *   npm run seed:demo-supply              (API running; .env has DATABASE_URL + DEMO_LOGIN_PASSWORD)
 *   npm run seed:demo-supply -- --again   (add ANOTHER full batch even if one exists)
 *
 * 1. Logins: reuses DEMO-PUR / DEMO-SAL (seed:demo-purchase), DEMO-STO (seed:demo-stores), DEMO-FIN / DEMO-ADM
 *    (seed:demo-mis). Missing ones are created the same way (direct select-then-insert; employees have no API;
 *    password = DEMO_LOGIN_PASSWORD, never printed). Customers DEMO-CUST-* must exist (seed:demo-purchase).
 * 2. Products: 3 Item Master items with fixed codes, created + approved through the Masters API as DEMO-PUR
 *    (reruns reuse them). Item classes are the ones seed:demo-purchase put in fdn_code_dictionary.
 * 3. Everything transactional goes through the REAL API as the right role (guards, triggers, number allocation,
 *    the inventory ledger all apply). One batch =
 *      enquiry RECEIVED (no quote)                                   -> also carries the completion marker
 *      quote DRAFT (TO_PRICE) / ISSUED not sent / sent (WITH_CUSTOMER) / REJECTED
 *      SO DRAFT with customer PO evidence pending Purchase verification             (quote ACCEPTED)
 *      SO VERIFIED, FIXED_AMOUNT advance, BR-08 receipt recorded, advance NOT confirmed (quote ACCEPTED)
 *      SO VERIFIED, NOT_REQUIRED, SALES_ORDER PO -> GRN -> ledger, CONFIRMED reservation (quote PART_ACCEPTED)
 *      SO VERIFIED, NOT_REQUIRED, PO -> GRN, 2 reservations -> SOUT #1 dispatched + POD, SOUT #2 dispatched
 *         (in transit) -> PART_DELIVERED                                                (quote ACCEPTED)
 *
 * NEVER touches CLIENT-UNCONFIRMED config: br11_company_policies (invoice trigger / payment before closure), the
 * PRODUCT_SALE row of br08_gst_rate_config, the legal-entity invoicing profile. Product invoicing + closure stay BLOCKED.
 * Refuses to run against anything but Neon staging / localhost (CLAUDE.md: never Brightech's server).
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');

const API = process.env.SEED_API_URL || 'http://localhost:3000/api';
const PASSWORD = process.env.DEMO_LOGIN_PASSWORD;
const AGAIN = process.argv.includes('--again');
const DONE_MARK = '[demo-supply-seed:complete]';
const TAG = '[demo-supply-seed]';

// 1x1 PNG (stands in for packing / GRN photos).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const PEOPLE = [
  { code: 'DEMO-PUR', name: 'Demo Purchase', role: 'PURCHASE' },
  { code: 'DEMO-SAL', name: 'Neha R', role: 'SALES' },
  { code: 'DEMO-STO', name: 'Meena S', role: 'STORES_QUALITY' },
  { code: 'DEMO-FIN', name: 'Lakshmi R', role: 'FINANCE' },
  { code: 'DEMO-ADM', name: 'Kiran T', role: 'SYSTEM_ADMIN' },
];
const PRODUCTS = [
  { key: 'cap', code: '020202900201', cc: '02', ss: '02', tt: '02', name: 'Snap-in capacitor 470uF 400V (resale)',
    spec: '470uF 400V 105C snap-in, 30x45mm', mfr: 'EPCOS', pn: 'B43508-A9477', price: 185000, list: 210000 },
  { key: 'fuse', code: '040101900202', cc: '04', ss: '01', tt: '01', name: 'Semiconductor fuse 63A 690V (resale)',
    spec: '63A 690V aR, square body', mfr: 'Bussmann', pn: '170M1416', price: 240000, list: 265000 },
  { key: 'relay', code: '050201900203', cc: '05', ss: '02', tt: '01', name: 'Interface relay module 24V DC 4-channel (resale)',
    spec: '24V DC coil, 4 x SPDT 6A, DIN rail', mfr: 'Phoenix Contact', pn: 'PLC-RSC-24DC/21-4', price: 325000, list: 360000 },
];
const DEMO_CUSTOMERS = ['DEMO-CUST-KVP', 'DEMO-CUST-DSR', 'DEMO-CUST-SPI', 'DEMO-CUST-CTL'];

async function call(method, path, token, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    // No JSON content-type on a body-less POST: Fastify rejects an empty body declared as JSON.
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const idem = () => ({ 'Idempotency-Key': `demo-supply-${randomUUID()}` });

(async () => {
  if (!PASSWORD) throw new Error('DEMO_LOGIN_PASSWORD is not set in .env');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const host = new URL(url).hostname;
  if (!/neon\.tech$|^localhost$|^127\.0\.0\.1$/.test(host)) throw new Error(`refusing to seed ${host} (staging/local only)`);

  // ---------------------------------------------------------------- logins (direct, select-then-insert)
  const c = new Client({ connectionString: url });
  c.on('error', (e) => console.warn(`pg client error: ${e.message}`));
  await c.connect();
  const one = async (sql, p) => (await c.query(sql, p)).rows[0];
  const co = await one(`SELECT id FROM legal_entities WHERE entity_code='BLR'`);
  if (!co) throw new Error('company BLR missing -- POST /api/dashboard/seed first');
  const created = { logins: [], items: [] };
  const hash = await bcrypt.hash(PASSWORD, 10);
  for (const p of PEOPLE) {
    let e = await one(`SELECT id, role_code FROM employees WHERE company_id=$1 AND employee_code=$2`, [co.id, p.code]);
    if (!e) e = await one(`INSERT INTO employees(company_id,employee_code,full_name,role_code) VALUES ($1,$2,$3,$4) RETURNING id, role_code`,
      [co.id, p.code, p.name, p.role]);
    if (e.role_code !== p.role) throw new Error(`${p.code} exists with role ${e.role_code}, expected ${p.role}`);
    if (!(await one(`SELECT 1 FROM employee_credentials WHERE employee_id=$1`, [e.id]))) {
      await c.query(`INSERT INTO employee_credentials(employee_id,login_id,password_hash) VALUES ($1,$2,$3)`, [e.id, p.code, hash]);
      created.logins.push(p.code);
    }
  }
  const missingDict = [];
  for (const it of PRODUCTS) {
    if (!(await one(`SELECT 1 FROM fdn_code_dictionary WHERE kind='ITEM' AND cc=$1 AND ss=$2 AND tt=$3`, [it.cc, it.ss, it.tt]))) missingDict.push(it.code);
  }
  if (missingDict.length) throw new Error(`item classes missing for ${missingDict.join(', ')} -- run npm run seed:demo-purchase first`);

  // ---------------------------------------------------------------- sessions
  const login = async (id) => (await call('POST', '/auth/login', null, { login_id: id, password: PASSWORD })).access_token;
  const P = await login('DEMO-PUR');
  const S = await login('DEMO-SAL');
  const STO = await login('DEMO-STO');
  const F = await login('DEMO-FIN');

  // ---------------------------------------------------------------- products (Masters API)
  const item = {};
  for (const it of PRODUCTS) {
    let row = await one(`SELECT id, status FROM fdn_item_master WHERE item_code=$1`, [it.code]);
    if (!row) {
      row = await call('POST', '/masters/items', P, {
        item_code: it.code, record_type: 'COMPONENT', standard_name: it.name, short_description: it.spec,
        cc: it.cc, ss: it.ss, tt: it.tt, base_uom: 'NOS', use_case: 'Traded product for direct sale (BR-11 demo)',
        stock_flag: 'STOCK', duplicate_review_note: 'demo supply seed: resale SKU, checked against existing items',
      });
      created.items.push(it.code);
    }
    if (!['APPROVED', 'ACTIVE'].includes(row.status)) await call('POST', `/masters/items/${row.id}/approve`, P);
    item[it.key] = { ...it, id: row.id };
  }

  // ---------------------------------------------------------------- customers (must already exist)
  const cust = {};
  for (const r of (await call('GET', '/lookups/customers?page_size=100&search=DEMO-CUST', P)).rows) if (DEMO_CUSTOMERS.includes(r.customer_code)) cust[r.customer_code] = r;
  const missingCust = DEMO_CUSTOMERS.filter((k) => !cust[k]);
  if (missingCust.length) throw new Error(`customers missing: ${missingCust.join(', ')} -- run npm run seed:demo-purchase first`);
  const addr = Object.fromEntries((await c.query(`SELECT customer_code, billing_address FROM customers WHERE company_id=$1 AND customer_code = ANY($2)`,
    [co.id, DEMO_CUSTOMERS])).rows.map((r) => [r.customer_code, r.billing_address]));

  // ---------------------------------------------------------------- skip if a completed batch exists
  const done = await one(`SELECT enquiry_number FROM br11_sales_enquiries WHERE company_id=$1 AND enquiry_details LIKE $2 LIMIT 1`, [co.id, `%${DONE_MARK}%`]);
  if (done && !AGAIN) {
    await c.end();
    console.log(JSON.stringify({
      masters: 'ensured (no duplicates)', logins_created_now: created.logins, items_created_now: created.items,
      transactional: `skipped -- a completed demo supply batch exists (${done.enquiry_number}); pass --again to add another`,
    }, null, 2));
    return;
  }
  const dates = await one(`SELECT to_char(br08_local_today($1),'YYYY-MM-DD') AS today, to_char(br08_local_today($1)+30,'YYYY-MM-DD') AS validity,
    to_char(br08_local_today($1)+21,'YYYY-MM-DD') AS validity_short`, [co.id]);
  await c.end();

  // ---------------------------------------------------------------- upload one photo, reused
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'demo-packing.png');
  const upRes = await fetch(`${API}/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${P}` }, body: form });
  const upload = await upRes.json();
  if (!upRes.ok) throw new Error(`POST /uploads -> ${upRes.status}: ${JSON.stringify(upload)}`);

  const stamp = Date.now().toString(36).toUpperCase();
  const out = { enquiries: [], quotes: [], sales_orders: [], supplier_pos: [], outwards: [], receipts: [] };

  // ---- helpers
  const enquiry = async (custCode, channel, details, lines) => {
    const e = await call('POST', '/sales-enquiries', S, {
      customer_id: cust[custCode].id, enquiry_channel: channel, enquiry_details: details,
      source_evidence_uri: upload.file_uri,
      lines: lines.map(([k, qty]) => ({ product_description: item[k].name, item_id: item[k].id, requested_qty: qty, uom: 'NOS', desired_condition: 'NEW' })),
    });
    return e;
  };
  const terms = (payment, validity = dates.validity) => ({
    validity_until: validity, payment_terms: payment, delivery_terms: 'Ex-works Bengaluru, freight extra at actuals',
    warranty_terms: '12 months manufacturer warranty', tax_terms: 'GST extra as applicable',
  });
  /** Purchase prices the quote (rev 0) with `lines` [[key, qty]]; issues it when `issue`. Returns { quote, rev, lines }. */
  const quote = async (enq, lines, payment, issue = true) => {
    const q = await call('POST', '/sales-quotes', P, { enquiry_id: enq.id, ...terms(payment) });
    const rev = q.revisions[0];
    const ql = [];
    for (const [k, qty] of lines) {
      const it = item[k];
      ql.push(await call('POST', `/sales-quote-revisions/${rev.id}/lines`, P, {
        item_id: it.id, manufacturer: it.mfr, part_number: it.pn, specification: it.spec, product_condition: 'NEW',
        warranty: '12 months', qty, unit_price_paise: it.price, list_unit_price_paise: it.list,
      }));
    }
    if (issue) await call('POST', `/sales-quote-revisions/${rev.id}/issue`, P);
    return { quote: q, rev, lines: ql };
  };
  const send = (rev, recipient) => call('POST', `/sales-quote-revisions/${rev.id}/dispatch`, S, { channel: 'EMAIL', recipient });
  const respond = (rev, kind) => call('POST', `/sales-quote-revisions/${rev.id}/responses`, S, { response_kind: kind });
  /** Sales drafts the SO and records customer PO evidence; Purchase verifies when `verify`. */
  const order = async (qt, lines, poRef, verify) => {
    const so = await call('POST', '/sales-orders', S, {
      quote_revision_id: qt.rev.id, customer_order_reference: poRef,
      lines: lines.map(([i, qty]) => ({ quote_line_id: qt.lines[i].id, accepted_qty: qty })),
    });
    const ev = await call('POST', `/sales-orders/${so.id}/authorisations`, S, {
      source_kind: 'CUSTOMER_PO', source_reference: poRef, received_at: new Date().toISOString(), evidence_uri: upload.file_uri,
    });
    if (!verify) return so;
    return call('POST', `/sales-orders/${so.id}/verify`, P, { authorisation_event_id: ev.id });
  };
  /** BR-06 SALES_ORDER PO for one SO line -> release -> acknowledge -> Stores GRN + photo + post (stock into MAIN). */
  const procure = async (so, line, qty, supplier, unitPrice) => {
    const sa = await call('POST', `/sales-order-lines/${line.sales_order_line_id}/sourcing-authorisations`, P, {
      quantity: qty, supplier_name: supplier, supplier_unit_price: unitPrice, supplier_offer_evidence_uri: upload.file_uri,
      comparison_evidence_uri: upload.file_uri, selected_rank: 1,
    });
    const po = await call('POST', `/sales-orders/${so.id}/purchase-orders`, P, { sourcing_authorisation_ids: [sa.id] });
    await call('POST', `/purchase-orders/${po.id}/release`, P);
    await call('POST', `/purchase-orders/${po.id}/acknowledge`, P, { supplier_reference: `SO/${po.po_number}` });
    const grn = await call('POST', `/purchase-orders/${po.id}/grns`, STO, {
      lines: [{ po_line_id: po.lines[0].id, received_quantity: qty }], notes: `DN ${stamp}-${po.po_number.slice(-3)}, vehicle KA-01-AB-${String(Date.now()).slice(-4)} ${TAG}`,
    });
    await call('POST', `/grn-lines/${grn.lines[0].id}/media`, STO, { file_uri: upload.file_uri, file_name: 'grn.png' });
    await call('POST', `/grn-lines/${grn.lines[0].id}/post`, STO, { accepted_quantity: qty, rejected_quantity: 0, held_quantity: 0 });
    out.supplier_pos.push(`${po.po_number} (SALES_ORDER, ${supplier}, qty ${qty}, GRN ${grn.grn_number ?? grn.id} posted)`);
    return po;
  };
  const reserve = (line, qty) => call('POST', `/sales-order-lines/${line.sales_order_line_id}/reservations`, P, { qty }, idem());
  const outward = async (custCode, resv, mode, carrier) => {
    const o = await call('POST', '/sales-outwards', P, {
      customer_id: cust[custCode].id, dispatch_mode: mode, ...(carrier ? { carrier_name: carrier } : {}),
      recipient_name: `Stores in-charge, ${cust[custCode].customer_name}`, destination_address: addr[custCode] || 'Customer site',
      lines: [{ reservation_request_id: resv.id }],
    });
    const l = o.lines[0].id;
    await call('POST', `/sales-outward-lines/${l}/pick`, P, { verification_note: `Part no. + qty ${Number(o.lines[0].outward_qty)} checked against SO` });
    await call('POST', `/sales-outward-lines/${l}/packing-evidence`, P, { evidence_kind: 'PHOTO', file_uri: upload.file_uri, file_name: 'packing.png' });
    return o;
  };

  // ================= quotes in each pre-order stage
  // TO_PRICE: Purchase has a DRAFT revision with lines, not issued.
  const e2 = await enquiry('DEMO-CUST-DSR', 'PHONE', `Spare relay modules for mill MCC panels ${TAG}`, [['relay', 8]]);
  const q2 = await quote(e2, [['relay', 8]], '30 days credit', false);
  out.enquiries.push(`${e2.enquiry_number} QUOTED`); out.quotes.push(`${q2.quote.quote_number} TO_PRICE (rev 0 DRAFT)`);

  // ISSUED, not yet sent by Sales.
  const e3 = await enquiry('DEMO-CUST-SPI', 'WHATSAPP', `Fuses for packing-line drives, urgent ${TAG}`, [['fuse', 6]]);
  const q3 = await quote(e3, [['fuse', 6]], '30 days credit');
  out.enquiries.push(`${e3.enquiry_number} QUOTED`); out.quotes.push(`${q3.quote.quote_number} ISSUED (not sent)`);

  // WITH_CUSTOMER: sent, no response yet.
  const e4 = await enquiry('DEMO-CUST-CTL', 'EMAIL', `Capacitors + fuses for loom drive spares kit ${TAG}`, [['cap', 12], ['fuse', 4]]);
  const q4 = await quote(e4, [['cap', 12], ['fuse', 4]], '50% advance, balance before dispatch');
  await send(q4.rev, 'purchase@coromandel-textiles.example');
  out.enquiries.push(`${e4.enquiry_number} QUOTED`); out.quotes.push(`${q4.quote.quote_number} WITH_CUSTOMER (sent)`);

  // REJECTED.
  const e5 = await enquiry('DEMO-CUST-KVP', 'EMAIL', `Price check: relay modules for extruder panel ${TAG}`, [['relay', 3]]);
  const q5 = await quote(e5, [['relay', 3]], '30 days credit');
  await send(q5.rev, 'stores@kaveri-polymers.example');
  await respond(q5.rev, 'REJECTED');
  out.enquiries.push(`${e5.enquiry_number} QUOTED`); out.quotes.push(`${q5.quote.quote_number} REJECTED`);

  // ================= SO 1: DRAFT, customer PO evidence pending Purchase verification (quote ACCEPTED)
  const e6 = await enquiry('DEMO-CUST-DSR', 'EMAIL', `Capacitor bank spares for stand 3 drives ${TAG}`, [['cap', 10]]);
  const q6 = await quote(e6, [['cap', 10]], '30 days credit');
  await send(q6.rev, 'purchase@deccan-steel.example');
  await respond(q6.rev, 'ACCEPTED');
  const so1 = await order(q6, [[0, 10]], `DSR/PO/${stamp}/101`, false);
  out.enquiries.push(`${e6.enquiry_number} QUOTED`); out.quotes.push(`${q6.quote.quote_number} ACCEPTED`);
  out.sales_orders.push(`(draft, no number yet) DRAFT, customer PO DSR/PO/${stamp}/101 evidence PENDING verification [${so1.id}]`);

  // ================= SO 2: VERIFIED, FIXED_AMOUNT advance, receipt recorded by Finance, advance NOT confirmed
  const e7 = await enquiry('DEMO-CUST-CTL', 'EMAIL', `Relay modules for new loom shed panels ${TAG}`, [['relay', 10]]);
  const q7 = await quote(e7, [['relay', 10]], '30% advance with PO, balance 30 days');
  await send(q7.rev, 'purchase@coromandel-textiles.example');
  await respond(q7.rev, 'ACCEPTED');
  const so2 = await order(q7, [[0, 10]], `CTL/PO/${stamp}/207`, true);
  const advance = Math.round(10 * item.relay.price * 0.3); // 30% of pre-tax order value, typed by Purchase from the terms
  await call('POST', `/sales-orders/${so2.id}/payment-terms`, P, {
    advance_kind: 'FIXED_AMOUNT', required_amount_paise: advance, accepted_terms_evidence_uri: upload.file_uri,
  });
  const rcpt = await call('POST', '/payments', F, {
    customer_id: cust['DEMO-CUST-CTL'].id, amount_paise: advance, received_on: dates.today, payment_mode: 'NEFT',
    payment_reference: `DEMO-ADV-${stamp}`,
  });
  out.enquiries.push(`${e7.enquiry_number} ORDERED`); out.quotes.push(`${q7.quote.quote_number} ACCEPTED`);
  out.sales_orders.push(`${so2.sales_order_number} VERIFIED, FIXED_AMOUNT advance Rs ${advance / 100} awaiting Finance confirmation`);
  out.receipts.push(`DEMO-ADV-${stamp}: Rs ${advance / 100} from Coromandel Textiles (NEFT), unallocated, can back ${so2.sales_order_number}`);

  // ================= SO 3: VERIFIED, NOT_REQUIRED, stock received via SALES_ORDER PO, CONFIRMED reservation (PART_ACCEPTED)
  const e8 = await enquiry('DEMO-CUST-KVP', 'EMAIL', `Fuses + capacitors for extruder drive overhaul ${TAG}`, [['fuse', 6], ['cap', 4]]);
  const q8 = await quote(e8, [['fuse', 6], ['cap', 4]], '30 days credit');
  await send(q8.rev, 'stores@kaveri-polymers.example');
  await respond(q8.rev, 'PART_ACCEPTED');
  const so3 = await order(q8, [[0, 6]], `KVP/PO/${stamp}/33`, true); // customer took the fuses only
  await call('POST', `/sales-orders/${so3.id}/payment-terms`, P, { advance_kind: 'NOT_REQUIRED', accepted_terms_evidence_uri: upload.file_uri });
  await procure(so3, so3.lines[0], 6, 'Elecon Components Pvt Ltd', 1650);
  const r3 = await reserve(so3.lines[0], 6);
  if (r3.state !== 'CONFIRMED') throw new Error(`SO 3 reservation is ${r3.state}`);
  out.enquiries.push(`${e8.enquiry_number} ORDERED`); out.quotes.push(`${q8.quote.quote_number} PART_ACCEPTED`);
  out.sales_orders.push(`${so3.sales_order_number} VERIFIED, NOT_REQUIRED, 6 fuses received + reservation CONFIRMED`);

  // ================= SO 4: outward -> dispatch -> POD (PART_DELIVERED), second SOUT in transit
  const e9 = await enquiry('DEMO-CUST-SPI', 'WALK_IN', `Capacitors for packing-line servo drives ${TAG}`, [['cap', 5]]);
  const q9 = await quote(e9, [['cap', 5]], '30 days credit');
  await send(q9.rev, 'maintenance@sahyadri-packaging.example');
  await respond(q9.rev, 'ACCEPTED');
  const so4 = await order(q9, [[0, 5]], `SPI/PO/${stamp}/4`, true);
  await call('POST', `/sales-orders/${so4.id}/payment-terms`, P, { advance_kind: 'NOT_REQUIRED', accepted_terms_evidence_uri: upload.file_uri });
  await procure(so4, so4.lines[0], 5, 'Sri Venkateswara Electronics', 1240);
  const r4a = await reserve(so4.lines[0], 3);
  const r4b = await reserve(so4.lines[0], 2);
  const o1 = await outward('DEMO-CUST-SPI', r4a, 'COURIER', 'DTDC');
  const d1 = await call('POST', `/sales-outwards/${o1.id}/dispatch`, P, { tracking_reference: `D4409${String(Date.now()).slice(-6)}` });
  await call('POST', `/sales-outward-lines/${o1.lines[0].id}/delivery`, P, {
    delivery_status: 'DELIVERED', delivered_qty: 3, received_by_name: 'Ramesh K (stores)', delivered_at: new Date().toISOString(), pod_uri: upload.file_uri,
  });
  const o2 = await outward('DEMO-CUST-SPI', r4b, 'OWN_TRANSPORT');
  const d2 = await call('POST', `/sales-outwards/${o2.id}/dispatch`, P, {});
  await call('POST', `/sales-outwards/${o2.id}/tracking-events`, P, { status_note: 'Left Bengaluru warehouse in company van', occurred_at: new Date().toISOString() });
  const so4now = await call('GET', `/sales-orders/${so4.id}`, S);
  out.enquiries.push(`${e9.enquiry_number} ORDERED`); out.quotes.push(`${q9.quote.quote_number} ACCEPTED`);
  out.sales_orders.push(`${so4.sales_order_number} ${so4now.status}, 3 of 5 delivered (POD), 2 in transit`);
  out.outwards.push(`${d1.outward_number} DISPATCHED + POD (3 delivered)`, `${d2.outward_number} DISPATCHED (2, in transit)`);

  // ================= enquiry RECEIVED, no quote (completion marker; created last)
  const e1 = await enquiry('DEMO-CUST-KVP', 'PHONE', `Asked for 20 fuses for spares stock; quote to follow ${DONE_MARK}`, [['fuse', 20]]);
  out.enquiries.push(`${e1.enquiry_number} RECEIVED (no quote)`);

  const cfg = await call('GET', '/sales-config', S);
  console.log(JSON.stringify({
    logins_created_now: created.logins, items_created_now: created.items, products: PRODUCTS.map((p) => p.code), ...out,
    blocked_by_unconfirmed_config: cfg.blocked,
  }, null, 2));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
