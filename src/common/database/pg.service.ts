import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';

/**
 * Raw pg pool. USE THIS for anything that must run inside a transaction or that
 * calls a plpgsql function (counter allocation, equipment-group expansion, job
 * creation, stock moves). Prisma is for plain typed reads/writes only.
 */
@Injectable()
export class PgService implements OnModuleInit, OnModuleDestroy {
  private pool!: Pool;
  private readonly log = new Logger(PgService.name);

  onModuleInit() {
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    // An idle pooled connection can be dropped by the server/pooler (e.g. Neon:
    // ECONNRESET). pg emits that as an 'error' event on the pool; with no listener
    // Node treats it as fatal and the whole API process exits. Log it instead --
    // the pool discards that client and opens a fresh one on the next query.
    // (Errors on an in-flight query still reject that query's promise as usual.)
    this.pool.on('error', (err) => {
      this.log.warn(`idle pg client error (connection discarded, pool continues): ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  query<T extends QueryResultRow = any>(text: string, params?: any[]) {
    return this.pool.query<T>(text, params);
  }

  /**
   * Run fn inside a READ ONLY transaction: Postgres rejects any INSERT/UPDATE/DELETE
   * (and any function that writes) with 'cannot execute ... in a read-only transaction'.
   * Used by BR-10 reports so reporting can never mutate source data.
   */
  async readOnly<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Run fn inside a single BEGIN/COMMIT; auto-ROLLBACK on throw. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
