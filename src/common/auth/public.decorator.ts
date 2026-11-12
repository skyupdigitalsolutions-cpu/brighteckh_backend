import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opt a route/controller OUT of the global JwtAuthGuard. Use only for routes
 * that must work without a session: login/refresh/logout, health, and the
 * dev-only dashboard (which is itself disabled in production).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
