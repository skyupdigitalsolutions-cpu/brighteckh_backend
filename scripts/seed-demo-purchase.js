/* eslint-disable */
/**
 * DEV/STAGING ONLY: give every Purchase list screen real rows (JINs, jobs, review queue, material requests,
 * RFQs, supplier offers, customer quotes) for UI work / screenshot comparison.
 *
 *   npm run seed:demo-purchase     (API must be running; .env must have DATABASE_URL + DEMO_LOGIN_PASSWORD)
 *   npm run seed:demo-purchase -- --again   (add ANOTHER full batch of JINs/jobs even if one exists)
 *
 * 1. Master rows that have NO API are inserted directly, select-then-insert (idempotent): DEMO-* customers,
 *    custody locations, assemblies, engineers + a SALES login (password = DEMO_LOGIN_PASSWORD; never printed),
 *    and the fdn_code_dictionary classes the demo items use.
 * 2. Item Master items are created + approved through the Masters API as DEMO-PUR (migration 023 syncs the
 *    BR-03 catalogue bridge). Fixed item codes, so reruns reuse them.
 * 3. Everything transactional goes through the REAL API (guards, triggers, number allocation all apply):
 *    BR-02 inward -> groups -> expand -> photos -> verify -> assign; BR-03 custody -> inspection -> review ->
 *    material request; BR-04 stock check -> RFQ -> invites -> offers -> validity -> quote -> revise / release.
 *    The transactional batch is skipped on rerun once a completed batch exists (pass --again to add another).
 *
 * Refuses to run against anything but Neon staging / localhost (CLAUDE.md: never Brightech's server).
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const API = process.env.SEED_API_URL || 'http://localhost:3000/api';
const PASSWORD = process.env.DEMO_LOGIN_PASSWORD;
const AGAIN = process.argv.includes('--again');
const DONE_MARK = '[demo-purchase-seed:complete]';

// 1x1 PNG (stands in for unit / inspection photos).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const CUSTOMERS = [
  { code: 'DEMO-CUST-KVP', name: 'Kaveri Polymers Pvt Ltd', state: '29', addr: 'Plot 42, KIADB Industrial Area, Bommasandra, Bengaluru' },
  { code: 'DEMO-CUST-DSR', name: 'Deccan Steel Rolling Mills', state: '29', addr: 'Survey 118, Peenya 2nd Stage, Bengaluru' },
  { code: 'DEMO-CUST-SPI', name: 'Sahyadri Packaging Industries', state: '29', addr: '7A, Hosur Road Industrial Estate, Bengaluru' },
  { code: 'DEMO-CUST-CTL', name: 'Coromandel Textiles Ltd', state: '33', addr: 'SIDCO Industrial Estate, Ambattur, Chennai' },
];
const ASSEMBLIES = [
  { code: 'DEMO-ASM-ACD75', name: 'AC Drive 7.5 kW' },
  { code: 'DEMO-ASM-SRV2K', name: 'Servo Drive 2 kW' },
  { code: 'DEMO-ASM-PLCCPU', name: 'PLC CPU module' },
  { code: 'DEMO-ASM-HMI7', name: 'HMI 7-inch panel' },
];
const LOCATIONS = [
  { code: 'DEMO-RACK-02', name: 'Inward rack B2' },
  { code: 'DEMO-BENCH-01', name: 'Inspection bench holding 01' },
];
const ENGINEERS = [
  { code: 'DEMO-ENG2', name: 'Divya P' },
  { code: 'DEMO-ENG3', name: 'Suresh K' },
  { code: 'DEMO-ENG4', name: 'Imran S' },
];
const SALES = { code: 'DEMO-SAL', name: 'Neha R' };
const DICT = [
  { cc: '02', ss: '02', tt: '02', label: 'Capacitor / Electrolytic / Aluminium' },
  { cc: '03', ss: '01', tt: '01', label: 'Semiconductor / IGBT / Power module' },
  { cc: '04', ss: '01', tt: '01', label: 'Fuse / Fast-acting / Ceramic' },
  { cc: '05', ss: '02', tt: '01', label: 'Relay / Power / 24V DC coil' },
];
const ITEMS = [
  { key: 'cap', code: '020202900101', cc: '02', ss: '02', tt: '02', name: 'DC bus capacitor 2200uF 450V', spec: '2200uF 450V 105C snap-in' },
  { key: 'igbt', code: '030101900102', cc: '03', ss: '01', tt: '01', name: 'IGBT module 1200V 50A', spec: '1200V 50A half-bridge, 62mm package' },
  { key: 'fuse', code: '040101900103', cc: '04', ss: '01', tt: '01', name: 'Fast-acting fuse 10A 500V', spec: '10A 500V ceramic 6.3x32mm' },
  { key: 'relay', code: '050201900104', cc: '05', ss: '02', tt: '01', name: 'Power relay 24V DC 10A', spec: '24V DC coil, SPDT 10A contacts' },
];
const SUPPLIERS = ['Elecon Components Pvt Ltd', 'Sri Venkateswara Electronics', 'Bharat Power Devices'];

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

const daysAgo = (d, hour = 10) => {
  const t = new Date(Date.now() - d * 86400000);
  t.setUTCHours(hour - 5, 30, 0, 0); // IST hour -> UTC
  return t.toISOString();
};

(async () => {
  if (!PASSWORD) throw new Error('DEMO_LOGIN_PASSWORD is not set in .env');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const host = new URL(url).hostname;
  if (!/neon\.tech$|^localhost$|^127\.0\.0\.1$/.test(host)) throw new Error(`refusing to seed ${host} (staging/local only)`);

  const c = new Client({ connectionString: url });
  c.on('error', (e) => console.warn(`pg client error: ${e.message}`));
  await c.connect();
  const one = async (sql, p) => (await c.query(sql, p)).rows[0];
  // The SELECT uses the first N params it references ($1..$N); the INSERT gets them all.
  const ensure = async (selectSql, insertSql, p) => {
    const n = Math.max(0, ...[...selectSql.matchAll(/\$(\d+)/g)].map((x) => Number(x[1])));
    return (await one(selectSql, p.slice(0, n))) || one(insertSql, p);
  };

  const m = { cust: {}, asm: {}, loc: {}, eng: {}, item: {}, bridge: {} };
  const created = { logins: [] };
  let co;
  try {
    await c.query('BEGIN');
    const company = await one(`SELECT id FROM legal_entities WHERE entity_code='BLR'`);
    if (!company) throw new Error('company BLR missing -- POST /api/dashboard/seed first');
    co = company.id;
    const hash = await bcrypt.hash(PASSWORD, 10);

    const emp = async (code, name, role) => {
      const e = await ensure(
        `SELECT id, role_code FROM employees WHERE company_id=$1 AND employee_code=$2`,
        `INSERT INTO employees(company_id,employee_code,full_name,role_code) VALUES ($1,$2,$3,$4) RETURNING id, role_code`,
        [co, code, name, role],
      );
      if (e.role_code !== role) throw new Error(`${code} exists with role ${e.role_code}, expected ${role}`);
      if (!(await one(`SELECT 1 FROM employee_credentials WHERE employee_id=$1`, [e.id]))) {
        await c.query(`INSERT INTO employee_credentials(employee_id,login_id,password_hash) VALUES ($1,$2,$3)`, [e.id, code, hash]);
        created.logins.push(code);
      }
      return e.id;
    };
    m.eng['DEMO-ENG'] = await emp('DEMO-ENG', 'Demo Engineer', 'ENGINEER');
    for (const e of ENGINEERS) m.eng[e.code] = await emp(e.code, e.name, 'ENGINEER');
    m.sales = await emp(SALES.code, SALES.name, 'SALES');

    for (const cu of CUSTOMERS) {
      m.cust[cu.code] = (await ensure(
        `SELECT id FROM customers WHERE company_id=$1 AND customer_code=$2`,
        `INSERT INTO customers(company_id,customer_code,customer_name,status,state_code,billing_address,credit_days)
         VALUES ($1,$2,$3,'APPROVED',$4,$5,30) RETURNING id`,
        [co, cu.code, cu.name, cu.state, cu.addr],
      )).id;
    }
    for (const a of ASSEMBLIES) {
      m.asm[a.code] = (await ensure(
        `SELECT id FROM assemblies WHERE assembly_code=$1`,
        `INSERT INTO assemblies(assembly_code,assembly_name,status) VALUES ($1,$2,'APPROVED') RETURNING id`,
        [a.code, a.name],
      )).id;
    }
    for (const l of LOCATIONS) {
      m.loc[l.code] = (await ensure(
        `SELECT id FROM custody_locations WHERE company_id=$1 AND location_code=$2`,
        `INSERT INTO custody_locations(company_id,location_code,location_name) VALUES ($1,$2,$3) RETURNING id`,
        [co, l.code, l.name],
      )).id;
    }
    for (const d of DICT) {
      await c.query(`INSERT INTO fdn_code_dictionary(kind,cc,ss,tt,label) VALUES ('ITEM',$1,$2,$3,$4) ON CONFLICT (kind,cc,ss,tt) DO NOTHING`,
        [d.cc, d.ss, d.tt, d.label]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
    throw e;
  }

  // ---------------------------------------------------------------- API sessions
  const login = async (id) => (await call('POST', '/auth/login', null, { login_id: id, password: PASSWORD })).access_token;
  const P = await login('DEMO-PUR');
  const purId = (await call('GET', '/auth/me', P)).id;
  const engTok = {};
  for (const code of Object.keys(m.eng)) engTok[code] = await login(code);

  // ---------------------------------------------------------------- items (Masters API)
  for (const it of ITEMS) {
    let row = await one(`SELECT id, status FROM fdn_item_master WHERE item_code=$1`, [it.code]);
    if (!row) {
      row = await call('POST', '/masters/items', P, {
        item_code: it.code, record_type: 'COMPONENT', standard_name: it.name, short_description: it.spec,
        cc: it.cc, ss: it.ss, tt: it.tt, base_uom: 'NOS', use_case: 'Spare for industrial drive / controller repair',
        stock_flag: 'STOCK', duplicate_review_note: 'demo seed: checked against existing items, none similar',
      });
      created[`item ${it.code}`] = 'created';
    }
    if (!['APPROVED', 'ACTIVE'].includes(row.status)) await call('POST', `/masters/items/${row.id}/approve`, P);
    m.item[it.key] = row.id;
    const b = await one(`SELECT id, approval_status FROM br03_item_catalog_bridge WHERE br01_item_id=$1`, [row.id]);
    if (!b || b.approval_status !== 'APPROVED') throw new Error(`catalogue bridge for ${it.code} not APPROVED (${b && b.approval_status})`);
    m.bridge[it.key] = b.id;
  }

  // ---------------------------------------------------------------- skip if a completed batch exists
  const done = await one(`SELECT jin_number FROM inward_receipts WHERE company_id=$1 AND notes LIKE $2 LIMIT 1`, [co, `%${DONE_MARK}%`]);
  if (done && !AGAIN) {
    await c.end();
    console.log(JSON.stringify({
      masters: 'ensured (no duplicates)', logins_created_now: created.logins,
      transactional: `skipped -- a completed demo batch exists (${done.jin_number}); pass --again to add another`,
    }, null, 2));
    return;
  }
  await c.end();

  // ---------------------------------------------------------------- upload one photo, reused
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'demo-photo.png');
  const upRes = await fetch(`${API}/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${P}` }, body: form });
  const upload = await upRes.json();
  if (!upRes.ok) throw new Error(`POST /uploads -> ${upRes.status}: ${JSON.stringify(upload)}`);
  const photo = (unitId, name) => call('POST', `/equipment-units/${unitId}/photos`, P, { file_uri: upload.file_uri, file_name: name });

  const stamp = Date.now().toString(36).toUpperCase();
  let dcN = 0;
  const jin = (customer, d, channel, priority, reason, notes) => call('POST', '/inward-receipts', P, {
    customer_id: m.cust[customer], receipt_at: daysAgo(d), receipt_channel: channel,
    customer_dc_number: `DC/${customer.slice(-3)}/${stamp}-${++dcN}`,
    ...(channel === 'COURIER' ? { courier_name: 'Professional Couriers', courier_awb: `PC${stamp}${dcN}` } : {}),
    priority, ...(reason ? { priority_reason: reason } : {}), notes,
  });
  const group = async (jinId, asm, qty, loc = 'DEMO-RACK-02') => {
    const g = await call('POST', `/inward-receipts/${jinId}/equipment-groups`, P, { assembly_id: m.asm[asm], quantity_received: qty });
    const ex = await call('POST', `/equipment-groups/${g.id}/expand`, P, { location_id: m.loc[loc], custodian_id: purId });
    return ex.units;
  };
  let serialN = 0;
  const details = (unitId, make, model, fault) => call('PATCH', `/equipment-units/${unitId}`, P, {
    serial_number: `${make.slice(0, 3).toUpperCase()}${stamp.slice(-4)}${String(++serialN).padStart(3, '0')}`,
    observed_make: make, observed_model: model, reported_fault: fault, physical_condition: 'Dusty, no visible physical damage',
  });
  const verify = async (unitId) => {
    await photo(unitId, 'inward.png');
    return (await call('POST', `/equipment-units/${unitId}/verify`, P)).job;
  };

  // ---- BR-03 helpers (engineer)
  const accept = (job, eng) => call('POST', `/jobs/${job.id}/custody-ack`, engTok[eng], { condition_note: 'Received on bench, seals intact' });
  const submitReport = async (job, eng, desc) => {
    const sess = await call('POST', `/jobs/${job.id}/inspection-sessions`, engTok[eng]);
    await call('POST', `/inspection-sessions/${sess.id}/stop`, engTok[eng]);
    const rep = await call('POST', `/jobs/${job.id}/inspection-reports`, engTok[eng]);
    await call('POST', `/inspection-reports/${rep.id}/media`, engTok[eng], { media_type: 'PHOTO', file_uri: upload.file_uri, file_name: 'inspection.png' });
    await call('POST', `/inspection-reports/${rep.id}/submit`, engTok[eng], { inspection_description: desc, outcome: 'REPAIR_REQUIRED' });
    return rep;
  };
  const materialRequest = async (job, eng, priority, lines) => {
    const mr = await call('POST', `/jobs/${job.id}/material-requests`, engTok[eng], { priority });
    for (const [key, qty] of lines) await call('POST', `/material-requests/${mr.id}/lines`, engTok[eng], { item_bridge_id: m.bridge[key], quantity: qty });
    await call('POST', `/material-requests/${mr.id}/submit`, engTok[eng]);
    return mr;
  };
  const fullToMr = async (job, eng, desc, priority, lines) => {
    await accept(job, eng);
    const rep = await submitReport(job, eng, desc);
    await call('POST', `/inspection-reports/${rep.id}/review`, P, { decision: 'ACCEPT', comment: 'Findings clear, proceed with material request' });
    return materialRequest(job, eng, priority, lines);
  };

  // ---- BR-04 helpers (purchase)
  const sourcing = async (job, mr) => {
    await call('POST', `/material-requests/${mr.id}/start-processing`, P);
    await call('POST', `/jobs/${job.id}/stock-checks`, P, { material_request_id: mr.id });
    return call('GET', `/jobs/${job.id}/shortages`, P);
  };
  const rfqFor = (job, shortages, specs) => call('POST', `/jobs/${job.id}/rfqs`, P, {
    notes: 'Shortage against submitted material request',
    lines: shortages.map((s, i) => ({ shortage_source_id: s.id, technical_specification: specs[i] })),
  });

  const out = { jins: [], jobs: [], rfqs: [], quotes: [] };
  const J = (label, job, state) => { out.jobs.push({ label, job_number: job.job_number, state }); return job; };

  // ================= JIN A: Kaveri, URGENT walk-in, last month -> 3 AC drives, all verified
  const jinA = await jin('DEMO-CUST-KVP', 30, 'WALK_IN', 'URGENT', 'Extruder line down', 'Three drives from extruder line 2 [demo-purchase-seed]');
  out.jins.push(jinA.jin_number);
  const uA = await group(jinA.id, 'DEMO-ASM-ACD75', 3);
  for (const u of uA) await details(u.id, 'Siemens', 'G120 PM240-2 7.5kW', 'Trips on overcurrent (F30001) at start');
  const [j1, j2, j3] = [await verify(uA[0].id), await verify(uA[1].id), await verify(uA[2].id)];
  for (const [j, e] of [[j1, 'DEMO-ENG2'], [j2, 'DEMO-ENG3'], [j3, 'DEMO-ENG4']]) await call('POST', `/jobs/${j.id}/assign`, P, { engineer_id: m.eng[e] });

  // ================= JIN B: Deccan, CRITICAL courier, late last month -> 2 servo drives + 1 PLC
  const jinB = await jin('DEMO-CUST-DSR', 17, 'COURIER', 'CRITICAL', 'Rolling mill stand idle', 'Mill stand 3 servo axis + PLC [demo-purchase-seed]');
  out.jins.push(jinB.jin_number);
  const uB = await group(jinB.id, 'DEMO-ASM-SRV2K', 2);
  for (const u of uB) await details(u.id, 'Yaskawa', 'SGD7S-120A 2kW', 'Encoder alarm A.810, no motion');
  const uB2 = await group(jinB.id, 'DEMO-ASM-PLCCPU', 1, 'DEMO-BENCH-01');
  await details(uB2[0].id, 'Allen-Bradley', '1756-L72 ControlLogix', 'CPU fault LED, will not go to RUN');
  const [j4, j5, j6] = [await verify(uB[0].id), await verify(uB[1].id), await verify(uB2[0].id)];
  await call('POST', `/jobs/${j4.id}/assign`, P, { engineer_id: m.eng['DEMO-ENG2'] });
  await call('POST', `/jobs/${j5.id}/assign`, P, { engineer_id: m.eng['DEMO-ENG'] });
  await call('POST', `/jobs/${j6.id}/assign`, P, { engineer_id: m.eng['DEMO-ENG3'] });

  // ================= JIN C: Coromandel (TN), NORMAL courier, this month -> 2 HMIs + 1 servo
  const jinC = await jin('DEMO-CUST-CTL', 10, 'COURIER', 'NORMAL', null, 'Loom panel HMIs + spare servo [demo-purchase-seed]');
  out.jins.push(jinC.jin_number);
  const uC = await group(jinC.id, 'DEMO-ASM-HMI7', 2);
  for (const u of uC) await details(u.id, 'Delta', 'DOP-107BV 7"', 'Touch not responding, display flickers');
  const uC2 = await group(jinC.id, 'DEMO-ASM-SRV2K', 1);
  await details(uC2[0].id, 'Delta', 'ASD-B2-2023-B 2kW', 'AL009 position deviation');
  const [j7, j8, j9] = [await verify(uC[0].id), await verify(uC[1].id), await verify(uC2[0].id)];
  await call('POST', `/jobs/${j7.id}/assign`, P, { engineer_id: m.eng['DEMO-ENG4'] });
  await call('POST', `/jobs/${j9.id}/assign`, P, { engineer_id: m.eng['DEMO-ENG'] });
  // j8 stays unassigned

  // ================= JIN D: Sahyadri, NORMAL walk-in -> 2 PLC CPUs expanded, units PENDING (photo on one)
  const jinD = await jin('DEMO-CUST-SPI', 3, 'WALK_IN', 'NORMAL', null, 'Packing line PLCs, customer DC to follow [demo-purchase-seed]');
  out.jins.push(jinD.jin_number);
  const uD = await group(jinD.id, 'DEMO-ASM-PLCCPU', 2);
  await details(uD[0].id, 'Mitsubishi', 'FX5U-32MT', 'Communication port dead');
  await photo(uD[0].id, 'inward.png');

  // ================= JIN E: Deccan, NORMAL courier, today -> 1 AC drive expanded, unit PENDING, no photo
  const jinE = await jin('DEMO-CUST-DSR', 0, 'COURIER', 'NORMAL', null, 'Spare drive for inspection [demo-purchase-seed]');
  out.jins.push(jinE.jin_number);
  await group(jinE.id, 'DEMO-ASM-ACD75', 1);

  // ================= BR-03 / BR-04 progression
  // j1: report accepted -> MR (cap x4, igbt x1) -> RFQ OFFERS_RECEIVED (1 valid, 1 invalid) -> quote, revised
  const mr1 = await fullToMr(j1, 'DEMO-ENG2', 'DC bus capacitors bulged; IGBT phase U short', 'URGENT', [['cap', 4], ['igbt', 1]]);
  const sh1 = await sourcing(j1, mr1);
  const rfq1 = await rfqFor(j1, sh1, sh1.map(() => 'Original-equivalent or better; datasheet with offer'));
  const inv1 = [];
  for (const s of SUPPLIERS) inv1.push(await call('POST', `/rfqs/${rfq1.id}/supplier-invites`, P, { supplier_name_snapshot: s, supplier_contact_snapshot: 'sales desk, by email' }));
  await call('POST', `/rfqs/${rfq1.id}/offers`, P, {
    supplier_invite_id: inv1[0].id, supplier_quote_number: `EC/Q/${stamp}`, delivery_terms: 'Ex-works Bengaluru', warranty_terms: '12 months',
    lines: rfq1.lines.map((l, i) => ({ rfq_line_id: l.id, offered_make: i ? 'Infineon' : 'EPCOS', offered_quantity: Number(l.required_quantity ?? l.quantity ?? (i ? 1 : 4)), quoted_unit_price: i ? 6850 : 1240, delivery_days: 5, product_condition: 'NEW' })),
  });
  await call('POST', `/rfqs/${rfq1.id}/offers`, P, {
    supplier_invite_id: inv1[1].id, supplier_quote_number: `SVE-${stamp}`,
    lines: rfq1.lines.map((l, i) => ({ rfq_line_id: l.id, offered_make: i ? 'Semikron' : 'Nichicon', offered_quantity: Number(l.required_quantity ?? l.quantity ?? (i ? 1 : 4)), quoted_unit_price: i ? 6400 : 1105, delivery_days: 9, product_condition: i ? 'REFURBISHED' : 'NEW' })),
  });
  const full1 = await call('GET', `/rfqs/${rfq1.id}`, P);
  const okLine = full1.offers[0].lines[0].id;
  await call('POST', `/offer-lines/${okLine}/mark-validity`, P, { valid: true });
  await call('POST', `/offer-lines/${full1.offers[0].lines[1].id}/mark-validity`, P, { valid: true });
  await call('POST', `/offer-lines/${full1.offers[1].lines[1].id}/mark-validity`, P, { valid: false, reason: 'Refurbished IGBT not acceptable for this drive' });
  const q1Lines = (repair) => [
    { line_type: 'MATERIAL', line_description: 'DC bus capacitor 2200uF 450V', quantity: 4, uom: 'NOS', net_unit_price_pre_tax: 1650 },
    { line_type: 'MATERIAL', line_description: 'IGBT module 1200V 50A', quantity: 1, uom: 'NOS', net_unit_price_pre_tax: 8900 },
    { line_type: 'REPAIR_SERVICE', line_description: 'Power stage repair, reassembly and load test', quantity: 1, uom: 'NOS', net_unit_price_pre_tax: repair },
  ];
  const q1 = await call('POST', `/jobs/${j1.id}/quotes`, P, {
    quote_type: 'ITEM', reference_offer_line_id: okLine, procurement_offer_line_id: okLine, lines: q1Lines(6500),
  });
  await call('POST', `/quotes/${q1.id}/revise`, P, { revision_reason: 'Customer asked for revised labour; 5% goodwill', lines: q1Lines(5525) });
  out.rfqs.push(rfq1.rfq_number || rfq1.id); out.quotes.push(q1.quote_number || q1.id);
  J('j1', j1, 'MR PROCESSING, RFQ offers received, quote revised (rev 2 DRAFT)');

  // j2: report accepted -> MR (cap x2, fuse x3) -> RFQ OFFERS_RECEIVED -> quote released to Sales
  const mr2 = await fullToMr(j2, 'DEMO-ENG3', 'Pre-charge fuse open, two DC caps leaking', 'NORMAL', [['cap', 2], ['fuse', 3]]);
  const sh2 = await sourcing(j2, mr2);
  const rfq2 = await rfqFor(j2, sh2, sh2.map(() => 'Same rating as fitted part'));
  const inv2 = [];
  for (const s of SUPPLIERS.slice(0, 2)) inv2.push(await call('POST', `/rfqs/${rfq2.id}/supplier-invites`, P, { supplier_name_snapshot: s }));
  await call('POST', `/rfqs/${rfq2.id}/offers`, P, {
    supplier_invite_id: inv2[0].id, supplier_quote_number: `EC/Q/${stamp}-2`,
    lines: rfq2.lines.map((l, i) => ({ rfq_line_id: l.id, offered_quantity: i ? 3 : 2, quoted_unit_price: i ? 185 : 1240, delivery_days: 4, product_condition: 'NEW' })),
  });
  const full2 = await call('GET', `/rfqs/${rfq2.id}`, P);
  for (const l of full2.offers[0].lines) await call('POST', `/offer-lines/${l.id}/mark-validity`, P, { valid: true });
  const q2 = await call('POST', `/jobs/${j2.id}/quotes`, P, {
    quote_type: 'ITEM', reference_offer_line_id: full2.offers[0].lines[0].id, procurement_offer_line_id: full2.offers[0].lines[0].id,
    lines: [
      { line_type: 'MATERIAL', line_description: 'DC bus capacitor 2200uF 450V', quantity: 2, uom: 'NOS', net_unit_price_pre_tax: 1650 },
      { line_type: 'MATERIAL', line_description: 'Fast-acting fuse 10A 500V', quantity: 3, uom: 'NOS', net_unit_price_pre_tax: 260 },
      { line_type: 'REPAIR_SERVICE', line_description: 'Repair, cleaning and full-load test', quantity: 1, uom: 'NOS', net_unit_price_pre_tax: 4800 },
    ],
  });
  await call('POST', `/quotes/${q2.id}/release-to-sales`, P, { assigned_sales_id: m.sales });
  out.rfqs.push(rfq2.rfq_number || rfq2.id); out.quotes.push(q2.quote_number || q2.id);
  J('j2', j2, 'MR PROCESSING, RFQ offers received, quote RELEASED_TO_SALES');

  // j3: report accepted -> MR (igbt x1, relay x2) -> RFQ #1 SENT (invites, no offers), RFQ #2 DRAFT
  const mr3 = await fullToMr(j3, 'DEMO-ENG4', 'IGBT gate driver damaged, main contactor relay chattering', 'URGENT', [['igbt', 1], ['relay', 2]]);
  const sh3 = await sourcing(j3, mr3);
  const rfq3a = await rfqFor(j3, [sh3[0]], ['1200V 50A, 62mm footprint']);
  for (const s of SUPPLIERS) await call('POST', `/rfqs/${rfq3a.id}/supplier-invites`, P, { supplier_name_snapshot: s });
  const rfq3b = await rfqFor(j3, [sh3[1]], ['24V DC coil, PCB mount, 10A']);
  out.rfqs.push(rfq3a.rfq_number || rfq3a.id, rfq3b.rfq_number || rfq3b.id);
  J('j3', j3, 'MR PROCESSING, RFQ SENT + RFQ DRAFT');

  // j4, j5: report submitted, awaiting Purchase review
  await accept(j4, 'DEMO-ENG2');
  await submitReport(j4, 'DEMO-ENG2', 'Encoder cable connector corroded; feedback board suspect');
  J('j4', j4, 'report SUBMITTED (awaiting review)');
  await accept(j5, 'DEMO-ENG');
  await submitReport(j5, 'DEMO-ENG', 'Encoder interface IC failed; needs replacement');
  J('j5', j5, 'report SUBMITTED (awaiting review)');

  // j6: custody ACCEPTED only
  await accept(j6, 'DEMO-ENG3');
  J('j6', j6, 'custody ACCEPTED');
  // j7: assigned, custody PENDING
  J('j7', j7, 'assigned (custody PENDING)');
  // j8: unassigned
  J('j8', j8, 'unassigned');
  // j9: report accepted -> MR SUBMITTED (in Purchase inbox, not processed)
  await fullToMr(j9, 'DEMO-ENG', 'Position loop OK; power relay and fuse failed', 'NORMAL', [['relay', 1], ['fuse', 2]]);
  J('j9', j9, 'MR SUBMITTED (Purchase inbox)');

  // ================= JIN F (last, completion marker): Sahyadri, URGENT walk-in, no groups yet
  const jinF = await jin('DEMO-CUST-SPI', 1, 'WALK_IN', 'URGENT', 'Customer waiting for estimate', `Header only, units being unpacked ${DONE_MARK}`);
  out.jins.push(jinF.jin_number);

  console.log(JSON.stringify({ logins_created_now: created.logins, items: Object.keys(m.item), ...out }, null, 2));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
