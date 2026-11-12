/* eslint-disable */
/**
 * Remove rows left behind by the integrity suite (test/*.e2e-spec.ts) from the
 * STAGING DB in .env. Never drops or alters tables persistently.
 *
 *   npm run test:clean              -> DRY RUN (default): shows what would be deleted
 *   npm run test:clean -- --execute -> deletes, in ONE transaction (all or nothing)
 *
 * What counts as test data
 *   ROOTS = the fixture rows test/helpers.ts inserts, matched by their exact
 *   run-id-suffixed patterns (IT-PUR-<RUN>, IT-CUST-<RUN>, ...).
 *   CLOSURE = every row that references a root through a foreign key, directly
 *   or transitively (i.e. everything the API created for a test actor / test
 *   customer / test item). Rows the suite only READS (company, inventory
 *   locations, code dictionary) never reference a root, so they are untouched.
 *
 * Safety
 *   - Refuses to run unless DATABASE_URL host looks like staging (not Brightech's server)
 *     unless TEST_CLEAN_ALLOW_HOST is set to that host.
 *   - Reports "mixed" rows: closure rows that ALSO reference a NON-test root row
 *     (e.g. a real employee). --execute refuses if any exist.
 *   - Append-only / immutability triggers that block DELETE are disabled ONLY for
 *     the tables that have rows to delete, ONLY inside the transaction, and are
 *     re-enabled (and verified enabled) before COMMIT. FK constraints stay enforced.
 */
const { Client } = require('pg');

const EXECUTE = process.argv.includes('--execute');

// Exact fixture patterns from test/helpers.ts (RUN = base36 timestamp + digits, uppercased).
const ROOTS = [
  { table: 'employees', where: `employee_code ~ '^IT-(PUR|PUR2|ENG|SAL|SQ|FIN|ADM|MGT)-[0-9A-Z]+$' AND full_name ~ '^IT (PUR|PUR2|ENG|SAL|SQ|FIN|ADM|MGT) [0-9A-Z]+$'` },
  { table: 'customers', where: `customer_code ~ '^IT-CUST-[0-9A-Z]+$' AND customer_name ~ '^IT Customer [0-9A-Z]+$'` },
  { table: 'custody_locations', where: `location_code ~ '^IT-RACK-[0-9A-Z]+$' AND location_name ~ '^IT Rack [0-9A-Z]+$'` },
  { table: 'assemblies', where: `assembly_code ~ '^IT-ASM-[0-9A-Z]+$' AND assembly_name ~ '^IT Drive [0-9A-Z]+$'` },
  { table: 'fdn_item_master', where: `duplicate_review_note ~ '^integrity run [0-9A-Z]+$' AND standard_name ~ '^IT .+ [0-9A-Z]+$'` },
  { table: 'br03_item_catalog_bridge', where: `item_code ~ '^IT-[0-9A-Z]+-[0-9a-f]{8}$' AND item_name ~ '^IT bridge [0-9A-Z]+$'` },
  // inventory.e2e-spec company-scoping test: the fixed "company B" (nothing may reference it -- the guard blocks writes).
  { table: 'legal_entities', mixedCheck: false, where: `entity_code = 'ZZB' AND name = 'IT test company B (integrity suite)'` },
  // auth.e2e-spec "unknown login" attempts: no employee FK, so not reachable from the roots above.
  { table: 'auth_events', mixedCheck: false, where: `employee_id IS NULL AND login_id_attempted ~ '^IT-NOPE-[0-9A-Z]+$'` },
];
// Mixed-row check only against identity roots: every test row legitimately references the real company (BLR).
const ROOT_TABLES = ROOTS.filter((r) => r.mixedCheck !== false).map((r) => r.table);

const qi = (s) => '"' + s.replace(/"/g, '""') + '"';

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const host = new URL(url).hostname;
  const allowed = /neon\.tech$|^localhost$|^127\.0\.0\.1$/.test(host) || host === process.env.TEST_CLEAN_ALLOW_HOST;
  if (!allowed) throw new Error(`refusing to run against ${host} (staging/local only; set TEST_CLEAN_ALLOW_HOST to override)`);

  const c = new Client({ connectionString: url });
  await c.connect();
  const q = async (sql, p) => (await c.query(sql, p)).rows;

  // FK edges: child(cols) -> parent(cols), public schema only.
  const fks = await q(`
    SELECT con.conname, ch.relname AS child, pa.relname AS parent,
           array_agg(ca.attname::text ORDER BY k.ord) AS child_cols,
           array_agg(pa_att.attname::text ORDER BY k.ord) AS parent_cols
      FROM pg_constraint con
      JOIN pg_class ch ON ch.oid=con.conrelid
      JOIN pg_class pa ON pa.oid=con.confrelid
      JOIN pg_namespace n ON n.oid=ch.relnamespace AND n.nspname='public'
      CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(ck, pk, ord)
      JOIN pg_attribute ca ON ca.attrelid=con.conrelid AND ca.attnum=k.ck
      JOIN pg_attribute pa_att ON pa_att.attrelid=con.confrelid AND pa_att.attnum=k.pk
     WHERE con.contype='f'
     GROUP BY con.conname, ch.relname, pa.relname`);

  await c.query('BEGIN');
  // Closure keyed by ctid. Nothing is updated before the deletes, so ctids stay valid in this tx.
  await c.query(`CREATE TEMP TABLE _cl (tbl text NOT NULL, rid tid NOT NULL, gen int NOT NULL, PRIMARY KEY (tbl, rid)) ON COMMIT DROP`);

  for (const r of ROOTS) {
    await c.query(`INSERT INTO _cl SELECT $1, ctid, 0 FROM ${qi(r.table)} WHERE ${r.where}`, [r.table]);
  }

  // Semi-naive fixpoint: only follow edges out of rows added in the previous generation.
  for (let gen = 1; ; gen++) {
    const grown = new Set((await q(`SELECT DISTINCT tbl FROM _cl WHERE gen=$1`, [gen - 1])).map((r) => r.tbl));
    if (!grown.size) break;
    for (const fk of fks.filter((f) => grown.has(f.parent))) {
      const cc = fk.child_cols.map((x) => `ch.${qi(x)}`).join(',');
      const pc = fk.parent_cols.map((x) => `p.${qi(x)}`).join(',');
      await c.query(
        `INSERT INTO _cl
         SELECT $1, ch.ctid, $3 FROM ${qi(fk.child)} ch
          WHERE (${cc}) IN (SELECT ${pc} FROM ${qi(fk.parent)} p
                             WHERE p.ctid = ANY (ARRAY(SELECT rid FROM _cl WHERE tbl=$2 AND gen=$4)))
         ON CONFLICT DO NOTHING`,
        [fk.child, fk.parent, gen, gen - 1],
      );
    }
  }

  const counts = await q(`SELECT tbl, count(*)::int n FROM _cl GROUP BY tbl ORDER BY tbl`);
  const inSet = new Set(counts.map((r) => r.tbl));
  const total = counts.reduce((a, r) => a + r.n, 0);

  // Mixed rows: closure rows referencing a NON-test row in a root table.
  const mixed = [];
  for (const fk of fks.filter((f) => inSet.has(f.child) && ROOT_TABLES.includes(f.parent))) {
    const cc = fk.child_cols.map((x) => `ch.${qi(x)}`).join(',');
    const pc = fk.parent_cols.map((x) => `p.${qi(x)}`).join(',');
    const notNull = fk.child_cols.map((x) => `ch.${qi(x)} IS NOT NULL`).join(' AND ');
    const r = await q(
      `SELECT count(*)::int n FROM ${qi(fk.child)} ch
        WHERE ch.ctid = ANY (ARRAY(SELECT rid FROM _cl WHERE tbl=$1)) AND ${notNull}
          AND (${cc}) IN (SELECT ${pc} FROM ${qi(fk.parent)} p
                           WHERE NOT (p.ctid = ANY (ARRAY(SELECT rid FROM _cl WHERE tbl=$2))))`,
      [fk.child, fk.parent],
    );
    if (r[0].n) mixed.push(`${fk.child}.${fk.child_cols.join(',')} -> non-test ${fk.parent}: ${r[0].n} row(s)`);
  }

  // Delete-blocking user triggers on the affected tables.
  const blockers = await q(
    `SELECT c.relname AS tbl, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE NOT t.tgisinternal AND (t.tgtype & 8) <> 0 AND c.relname = ANY($1)
        AND c.relnamespace='public'::regnamespace ORDER BY 1, 2`, [[...inSet]]);

  // Child-first delete order over the table-level FK graph (self-references are fine in one statement).
  const edges = fks.filter((f) => inSet.has(f.child) && inSet.has(f.parent) && f.child !== f.parent);
  const order = [];
  const remaining = new Set(inSet);
  while (remaining.size) {
    const leaf = [...remaining].filter((t) => !edges.some((e) => e.parent === t && remaining.has(e.child)));
    if (!leaf.length) {
      const cyc = [...remaining].join(', ');
      await c.query('ROLLBACK');
      throw new Error(`FK cycle among: ${cyc} -- not handled; nothing was changed`);
    }
    leaf.sort().forEach((t) => { order.push(t); remaining.delete(t); });
  }

  console.log(`\n${EXECUTE ? 'EXECUTE' : 'DRY RUN'} against ${host}`);
  console.log('\nRoots (test fixtures):');
  for (const r of ROOTS) {
    const n = counts.find((x) => x.tbl === r.table)?.n ?? 0;
    const all = (await q(`SELECT count(*)::int n FROM ${qi(r.table)}`))[0].n;
    console.log(`  ${r.table.padEnd(28)} ${String(n).padStart(6)} of ${all} total rows`);
  }
  console.log(`\nRows to delete, by table (${total} total, delete order = top to bottom):`);
  for (const t of order) {
    const n = counts.find((x) => x.tbl === t).n;
    const all = (await q(`SELECT count(*)::int n FROM ${qi(t)}`))[0].n;
    console.log(`  ${t.padEnd(40)} ${String(n).padStart(6)} of ${String(all).padStart(6)}${n === all ? '  (all rows in table)' : ''}`);
  }
  console.log(`\nMixed rows (test rows that also reference NON-test data): ${mixed.length ? '\n  ' + mixed.join('\n  ') : 'none'}`);
  console.log(`\nGuard triggers that block DELETE and would be disabled inside the transaction only (${blockers.length}):`);
  blockers.forEach((b) => console.log(`  ${b.tbl}.${b.tgname}`));

  if (!EXECUTE) {
    await c.query('ROLLBACK');
    console.log('\nDRY RUN — nothing deleted. Re-run with --execute to delete.');
    return c.end();
  }
  if (mixed.length) {
    await c.query('ROLLBACK');
    throw new Error('mixed rows found -- refusing to delete; nothing was changed');
  }

  try {
    for (const b of blockers) await c.query(`ALTER TABLE ${qi(b.tbl)} DISABLE TRIGGER ${qi(b.tgname)}`);
    let deleted = 0;
    for (const t of order) {
      const r = await c.query(`DELETE FROM ${qi(t)} WHERE ctid = ANY (ARRAY(SELECT rid FROM _cl WHERE tbl=$1))`, [t]);
      deleted += r.rowCount;
    }
    for (const b of blockers) await c.query(`ALTER TABLE ${qi(b.tbl)} ENABLE TRIGGER ${qi(b.tgname)}`);
    const still = await q(
      `SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        WHERE c.relname = ANY($1) AND t.tgname = ANY($2) AND t.tgenabled = 'D'`,
      [blockers.map((b) => b.tbl), blockers.map((b) => b.tgname)]);
    if (still[0].n) throw new Error(`${still[0].n} trigger(s) still disabled -- rolling back`);
    if (deleted !== total) throw new Error(`deleted ${deleted} but planned ${total} -- rolling back`);
    await c.query('COMMIT');
    console.log(`\nCOMMITTED: deleted ${deleted} rows; all ${blockers.length} guard triggers re-enabled.`);
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('\nROLLED BACK — nothing deleted, triggers unchanged:', e.message);
    process.exitCode = 1;
  }
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
