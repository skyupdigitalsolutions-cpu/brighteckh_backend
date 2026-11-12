import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { Role } from './roles.enum';

/**
 * Server-side role gate. Apply with @Roles(...) on controllers/routes.
 *
 * RULE (non-negotiable): identity + role come from the authenticated session,
 * NEVER from a body/query field. Hiding a button in the UI is not security —
 * every protected route is enforced here AND the DB triggers enforce ownership.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest();
    const user = req.user; // populated by your auth layer (JWT/session) — TODO wire up
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('Insufficient role for this action');
    }
    return true;
  }
}
