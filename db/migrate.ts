/**
 * Raw-SQL migration runner.
 * Runs every file in db/migrations in filename order, inside ONE transaction each,
 * and records applied files in a _migrations table so re-runs are safe.
 *
 * WHY raw SQL (not Prisma migrate): the schema owns triggers + plpgsql functions
 * that Prisma cannot manage. SQL is the source of truth; Prisma is client-only.
 *
 * Usage: npm run db:migrate
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = new Client({ connectionString: url });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const applied = new Set(
    (await client.query('SELECT filename FROM _migrations')).rows.map((r) => r.filename),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`apply ${file} ...`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations(filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  ok  ${file}`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`FAILED ${file}:`, (e as Error).message);
      process.exit(1);
    }
  }

  await client.end();
  console.log('migrations done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
