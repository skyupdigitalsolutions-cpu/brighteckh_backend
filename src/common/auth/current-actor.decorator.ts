import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Pulls req.user (AuthUser) populated by the global JwtAuthGuard from the access token. */
export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().user;
});
