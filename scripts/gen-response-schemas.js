/* eslint-disable */
/**
 * Generates OpenAPI response row classes from the LIVE schema (read-only:
 * queries information_schema / pg_catalog only, never writes).
 *
 *   npm run swagger:schemas
 *
 * Output: src/common/swagger/rows.generated.ts  (do not hand-edit; re-run after
 * a new migration). Each class mirrors one table/view exactly as `SELECT *`
 * returns it through node-postgres with default type parsers:
 *   numeric / bigint      -> decimal STRING (pg does not coerce to number)
 *   date / timestamp(tz)  -> ISO-8601 string (serialised from JS Date)
 *   json / jsonb          -> parsed JSON
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Tables/views returned by GET endpoints. Add here when a new read is exposed.
const TABLES = [
  // masters + inventory
  'fdn_item_master', 'fdn_assembly_master', 'fdn_inventory_journal',
  // BR-02
  'inward_receipts', 'inward_equipment_groups', 'inward_equipment_units', 'service_jobs', 'job_assignments',
  // BR-03
  'br03_inspection_sessions', 'br03_v_engineer_time_totals', 'br03_inspection_reports',
  'br03_inspection_report_versions', 'br03_material_requests', 'br03_material_request_lines',
  'br03_material_change_requests',
  // BR-04
  'br04_stock_checks', 'br04_stock_check_lines', 'br04_shortage_sources', 'br04_rfqs', 'br04_rfq_lines',
  'br04_rfq_supplier_invites', 'br04_supplier_offer_headers', 'br04_supplier_offer_lines',
  'br04_customer_quotes', 'br04_customer_quote_revisions', 'br04_customer_quote_lines',
  // BR-05
  'br05_customer_response_events', 'br05_customer_orders', 'br05_order_job_allocations',
  'br05_job_authorisations', 'br05_stock_rechecks', 'br05_stock_recheck_lines', 'br05_job_releases',
  'br05_material_reservations',
  // BR-06
  'br06_supplier_purchase_orders', 'br06_po_lines', 'br06_grns', 'br06_grn_lines',
  // BR-07
  'br07_material_issues', 'br07_material_consumptions', 'br07_material_returns', 'br07_repair_sessions',
  'br07_v_repair_time_totals', 'br07_repair_reports', 'br07_repair_report_versions', 'br07_test_runs',
  'br07_test_failure_reviews', 'sla_instances', 'br07_technical_handoffs', 'br07_dispatch_releases',
  // Working calendar (migration 012)
  'working_calendars', 'working_calendar_day_rules', 'calendar_holidays',
  // BR-08 (migration 013)
  'br08_dispatch_batches', 'br08_dispatch_batch_jobs', 'br08_delivery_challans', 'br08_delivery_acknowledgements',
  'br08_invoices', 'br08_invoice_jobs', 'br08_invoice_lines', 'br08_payment_receipts', 'br08_payment_allocations',
  'br08_credit_notes', 'br08_job_waivers', 'br08_v_job_billing', 'br08_gst_rate_config',
  // BR-09 (migration 015)
  'job_repeat_links', 'br09_support_cases', 'br09_case_repeat_jobs', 'br09_technical_assessments', 'br09_claim_decisions',
  'br09_goodwill_approvals', 'br09_credit_note_requests', 'br09_customer_communications', 'br09_case_feedback',
  'br09_case_sla', 'br09_authority_config', 'br09_sla_targets', 'br09_v_repeat_failures', 'br09_v_root_cause',
  'br09_v_goodwill', 'br09_v_feedback', 'br09_case_evidence', 'br09_refund_replacement_reviews',
  // BR-10 (migration 017)
  'br10_role_catalogue', 'br10_permission_matrix', 'br10_report_catalogue', 'br10_authority_config',
  'br10_role_bindings', 'br10_report_grants', 'br10_grant_approvals', 'br10_sales_customer_assignments',
  'br10_column_masks', 'br10_report_access_log',
  // BR-11 (migration 018) + its BR-06 / BR-08 extensions
  'br11_company_policies', 'br11_sales_enquiries', 'br11_enquiry_lines', 'br11_sale_quotations', 'br11_quote_revisions',
  'br11_quote_lines', 'br11_quote_dispatch_events', 'br11_customer_quote_responses', 'br11_sales_orders',
  'br11_sales_order_lines', 'br11_order_authorisation_events', 'br11_order_payment_conditions',
  'br11_inventory_reservation_requests', 'br11_outward_batches', 'br11_outward_lines', 'br11_packing_evidence',
  'br11_carrier_tracking_events', 'br11_delivery_evidence', 'br11_sales_change_requests',
  'br11_sales_order_closure_reviews', 'br11_v_sales_order_lines',
  'br06_sales_sourcing_authorisations', 'br08_sales_invoice_sources', 'br08_invoice_sales_lines',
  // returned only by POST (write) endpoints
  'fdn_assembly_bom', 'equipment_photos', 'br03_custody_acknowledgements', 'br03_inspection_media',
  'br04_supplier_offer_versions', 'br06_grn_line_media',
];

const pascal = (s) => s.split(/[_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const q = (s) => JSON.stringify(s);

function scalar(udt) {
  switch (udt) {
    case 'uuid': return { ts: 'string', api: { type: 'string', format: 'uuid' } };
    case 'text': case 'varchar': case 'bpchar': case 'citext': case 'name': case 'inet':
      return { ts: 'string', api: { type: 'string' } };
    case 'int2': case 'int4': return { ts: 'number', api: { type: 'integer' } };
    case 'int8': return { ts: 'string', api: { type: 'string', format: 'int64', note: 'bigint, returned as string' } };
    case 'numeric': return { ts: 'string', api: { type: 'string', format: 'decimal', note: 'numeric, returned as decimal string' } };
    case 'float4': case 'float8': return { ts: 'number', api: { type: 'number' } };
    case 'bool': return { ts: 'boolean', api: { type: 'boolean' } };
    case 'timestamptz': case 'timestamp': return { ts: 'string', api: { type: 'string', format: 'date-time' } };
    case 'date': return { ts: 'string', api: { type: 'string', format: 'date-time', note: 'date column, serialised as ISO timestamp' } };
    case 'time': case 'timetz': return { ts: 'string', api: { type: 'string', format: 'time' } };
    case 'interval': return { ts: 'Record<string, number>', api: { type: 'object', note: 'interval: {days,hours,minutes,seconds,...}' } };
    case 'json': case 'jsonb': return { ts: 'unknown', api: { type: 'object', note: 'JSON' } };
    default: return null;
  }
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const cols = await c.query(
    `SELECT c.table_name, c.column_name, c.is_nullable, c.data_type, c.udt_name, c.ordinal_position,
            col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) AS comment
       FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name = ANY($1)
      ORDER BY c.table_name, c.ordinal_position`, [TABLES]);
  const enums = await c.query(
    `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid GROUP BY t.typname`);
  // Status-style columns are text + CHECK (col IN (...)). Pull the allowed values
  // from single-column CHECK constraints so the docs show them as enums.
  const checks = await c.query(
    `SELECT cl.relname AS table_name, a.attname AS column_name, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid=con.conrelid
       JOIN pg_namespace n ON n.oid=cl.relnamespace AND n.nspname='public'
       JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=con.conkey[1]
      WHERE con.contype='c' AND array_length(con.conkey,1)=1 AND cl.relname = ANY($1)`, [TABLES]);
  await c.end();

  const checkEnums = {};
  for (const r of checks.rows) {
    // matches: CHECK ((status = ANY (ARRAY['A'::text, 'B'::text])))  or  CHECK ((status = 'A'::text))
    const m = r.def.match(/^CHECK \(\(\(?(\w+)\)?(?:::text)? = (?:ANY \(\(?ARRAY\[(.*)\]\)?(?:::text\[\])?\)|('[^']*'::\w+))\)\)$/);
    if (!m || m[1] !== r.column_name || / AND | OR /.test(r.def)) continue;
    const vals = [...(m[2] ?? m[3]).matchAll(/'([^']*)'/g)].map((x) => x[1]);
    if (vals.length) checkEnums[`${r.table_name}.${r.column_name}`] = vals;
  }

  const enumMap = Object.fromEntries(enums.rows.map((r) => [r.typname, r.labels]));
  const byTable = {};
  for (const r of cols.rows) (byTable[r.table_name] ??= []).push(r);
  const missing = TABLES.filter((t) => !byTable[t]);
  if (missing.length) { console.error('Tables/views not found in DB:', missing.join(', ')); process.exit(1); }

  const usedEnums = new Set();
  const out = [
    '/* AUTO-GENERATED by scripts/gen-response-schemas.js from the live schema. DO NOT EDIT. */',
    '/* eslint-disable */',
    "import { ApiProperty } from '@nestjs/swagger';",
    '',
  ];
  const unknownTypes = new Set();
  let checkCount = 0;

  for (const table of TABLES) {
    out.push(`/** Row of \`${table}\` as returned by SELECT * */`);
    out.push(`export class ${pascal(table)}Row {`);
    for (const col of byTable[table]) {
      const nullable = col.is_nullable === 'YES';
      let isArray = col.data_type === 'ARRAY';
      const udt = isArray ? col.udt_name.replace(/^_/, '') : col.udt_name;
      let ts, api;
      const chk = checkEnums[`${table}.${col.column_name}`];
      if (chk && !isArray) {
        checkCount++;
        ts = 'string';
        api = { type: 'string', enum: chk };
      } else if (enumMap[udt]) {
        usedEnums.add(udt);
        ts = 'string';
        api = { enum: enumMap[udt], enumName: pascal(udt) };
      } else {
        const s = scalar(udt);
        if (!s) { unknownTypes.add(udt); ts = 'unknown'; api = { type: 'string', note: `pg type ${udt}` }; }
        else ({ ts, api } = s);
      }
      const desc = [col.comment, api.note].filter(Boolean).join(' — ');
      const props = [];
      if (api.enum) {
        props.push(`enum: ${q(api.enum)}`);
        if (api.enumName) props.push(`enumName: ${q(api.enumName)}`);
      }
      else if (isArray) props.push(`type: ${q(api.type)}`, 'isArray: true');
      else props.push(`type: ${q(api.type)}`);
      if (api.format) props.push(`format: ${q(api.format)}`);
      if (nullable) props.push('nullable: true');
      if (desc) props.push(`description: ${q(desc)}`);
      out.push(`  @ApiProperty({ ${props.join(', ')} })`);
      out.push(`  ${col.column_name}!: ${ts}${isArray ? '[]' : ''}${nullable ? ' | null' : ''};`);
    }
    out.push('}', '');
  }

  const file = path.join(__dirname, '..', 'src', 'common', 'swagger', 'rows.generated.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n'));
  console.log(`wrote ${path.relative(process.cwd(), file)}: ${TABLES.length} row classes, ${usedEnums.size} pg enums, ${checkCount} CHECK-constraint value lists`);
  if (unknownTypes.size) console.warn('unmapped pg types (emitted as string):', [...unknownTypes].join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
