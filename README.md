# Brightech JMS — Backend

NestJS (Fastify) + PostgreSQL + Prisma-as-client. See **CLAUDE.md** for the full build
guide, rules and API contracts.

## Quick start
```bash
cp .env.example .env
npm install
npm run db:up        # Docker Postgres @ localhost:5433
npm run db:migrate   # 001 integrated BR01-05 + 003 foundation (masters + inventory ledger)
npm run db:sync      # introspect + generate Prisma client
npm run start:dev    # http://localhost:3000/api/health
```

## What's included
- `db/migrations/001_integrated_fresh_staging_rev01.sql` — client's integrated BR01-05 schema (91 tables, 41 triggers, overlay guards baked in)
- `db/migrate.ts` — raw-SQL migration runner (Prisma never owns schema)
- Nest bootstrap, pg+Prisma database module, role guard, health check
- `src/modules/br02`, `src/modules/br03` — build these (contracts in CLAUDE.md)

## Status
Foundation DONE: migration 003 adds F1 masters (Item/Assembly) + F2 inventory ledger
(single-writer, append-only journal, materialised balances, idempotent, live-tested).
Modules built: src/modules/masters, src/modules/inventory. Build next: BR-02, BR-03.
BR-04/05/06/07 now call the inventory API. BR-08 invoicing pending client decisions.
