import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AuthService, RequestContext } from './auth.service';
import { LoginDto, RefreshDto } from './dto/auth.dto';
import { LogoutResponse, MeResponse, TokenPairResponse } from './dto/auth.responses';
import { Public } from '../../common/auth/public.decorator';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { AuthUser } from '../../common/auth/auth.types';
import { ApiStdErrors, BEARER_SCHEME, ErrorResponse } from '../../common/swagger/api-docs';

const ctxOf = (req: FastifyRequest): RequestContext => ({
  ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined,
});

@ApiTags('Auth')
@ApiStdErrors()
@Controller('auth')
export class AuthController {
  constructor(private readonly svc: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Log in with login_id + password',
    description: 'Returns a short-lived access token (JWT) and a single-use refresh token. Role and company '
      + 'come from the employee record, never from the request. Every attempt (success or failure) is audited in auth_events.',
  })
  @ApiOkResponse({ type: TokenPairResponse })
  @ApiUnauthorizedResponse({ description: 'Wrong login or password, or inactive account (same message for all)', type: ErrorResponse })
  login(@Body() dto: LoginDto, @Req() req: FastifyRequest) {
    return this.svc.login(dto, ctxOf(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair (rotation)',
    description: 'The presented refresh token is revoked and a new one returned. Re-using an already-rotated token '
      + 'revokes the whole login chain. Role/company are re-read from the employee record.',
  })
  @ApiOkResponse({ type: TokenPairResponse })
  @ApiUnauthorizedResponse({ description: 'Unknown, expired, revoked or re-used refresh token, or inactive account', type: ErrorResponse })
  refresh(@Body() dto: RefreshDto, @Req() req: FastifyRequest) {
    return this.svc.refresh(dto, ctxOf(req));
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revoke a refresh token',
    description: 'Ends the session for refresh purposes. Access tokens are stateless and stay valid until they expire '
      + '(JWT_ACCESS_TTL_SECONDS); clients should discard theirs.',
  })
  @ApiOkResponse({ type: LogoutResponse })
  logout(@Body() dto: RefreshDto, @Req() req: FastifyRequest) {
    return this.svc.logout(dto, ctxOf(req));
  }

  @Get('me')
  @ApiBearerAuth(BEARER_SCHEME)
  @ApiOperation({ summary: 'Current user (from the access token, confirmed against the employee record)' })
  @ApiOkResponse({ type: MeResponse })
  @ApiUnauthorizedResponse({ description: 'Missing/invalid/expired access token, or account inactive', type: ErrorResponse })
  me(@CurrentActor() user: AuthUser & { token_exp?: number }) {
    return this.svc.me(user);
  }
}
