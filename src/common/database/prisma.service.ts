import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';

/**
 * Lazy Prisma client. Nothing in the kit uses it yet (all modules use PgService
 * raw for transactions + plpgsql functions). We load it lazily so the app still
 * boots if `npm run db:sync` (prisma generate) hasn't been run. Once generated,
 * use `prisma.client` for typed reads.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PrismaService');
  client: any = null;

  async onModuleInit() {
    try {
      const mod = await import('@prisma/client');
      this.client = new mod.PrismaClient();
      await this.client.$connect();
      this.log.log('Prisma client connected');
    } catch {
      this.log.warn('Prisma client not generated — run `npm run db:sync`. Raw PgService still works.');
    }
  }
  async onModuleDestroy() { try { await this.client?.$disconnect?.(); } catch { /* noop */ } }
}
