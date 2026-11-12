import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthUser } from './auth.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Global guard, runs right after JwtAuthGuard (APP_GUARD order in AuthModule).
 * The token's company is the source of truth: if an authenticated request
 * carries `company_id` in its body or query string and that value is a
 * different company, reject with 403 before any handler/service runs.
 *
 * Covers every current endpoint that accepts company_id (inventory) and any
 * future one automatically.
 *  - Public routes (no req.user) are skipped.
 *  - Only UUID-shaped values are compared; a malformed company_id still reaches
 *    validation and gets the same 400 as before (behaviour unchanged).
 *  - Repeated query params (?company_id=a&company_id=b) are all checked.
 */
@Injectable()
export class CompanyScopeGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const user: AuthUser | undefined = req.user;
    if (!user) return true; // @Public() route -- nothing to scope against

    const supplied = [...values(req.body?.company_id), ...values(req.query?.company_id)];
    for (const v of supplied) {
      if (typeof v === 'string' && UUID_RE.test(v) && v.toLowerCase() !== user.company_id.toLowerCase()) {
        throw new ForbiddenException('company_id does not match the company of the authenticated user');
      }
    }
    return true;
  }
}

function values(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
