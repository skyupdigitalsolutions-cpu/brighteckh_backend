import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AccessClaims, AuthUser, JWT_AUDIENCE, JWT_ISSUER } from './auth.types';

/**
 * Global guard (registered as APP_GUARD in AuthModule): every route requires a
 * valid access token unless marked @Public(). Verifies the HS256 signature,
 * expiry, issuer and audience, then populates req.user from the token claims.
 *
 * Stateless by design: role/company were resolved from `employees` when the
 * token was issued, so a role change or deactivation takes effect at the next
 * refresh (access tokens are short-lived). RolesGuard runs after this, unchanged.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    if (!match) throw new UnauthorizedException('Authorization: Bearer <access token> required');

    let claims: AccessClaims;
    try {
      claims = this.jwt.verify<AccessClaims>(match[1], {
        algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException('invalid or expired access token');
    }
    if (claims.typ !== 'access' || !claims.sub || !claims.role || !claims.company_id) {
      throw new UnauthorizedException('invalid access token');
    }

    const user: AuthUser & { token_exp?: number } = {
      id: claims.sub, role: claims.role, company_id: claims.company_id, companyId: claims.company_id,
      token_exp: (claims as AccessClaims & { exp?: number }).exp,
    };
    req.user = user;
    return true;
  }
}
