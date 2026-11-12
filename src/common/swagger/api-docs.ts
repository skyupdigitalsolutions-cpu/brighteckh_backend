import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiBearerAuth, ApiHeader, ApiNotFoundResponse, ApiProperty, ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/** OpenAPI security scheme name for the JWT access token (see JwtAuthGuard, /auth/login). */
export const BEARER_SCHEME = 'bearer';

/** NestJS default error body (no custom exception filter is installed). */
export class ErrorResponse {
  @ApiProperty({ example: 400 }) statusCode!: number;
  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description: 'Human-readable message; an array of field errors for DTO validation failures',
    example: 'job belongs to another company',
  })
  message!: string | string[];
  @ApiProperty({ example: 'Bad Request', required: false }) error?: string;
}

/**
 * Route/controller needs `Authorization: Bearer <access token>`. Role and
 * company come from the token, which the server issued from `employees` at
 * login/refresh -- never from the request body.
 */
export const ApiAuth = () =>
  applyDecorators(
    ApiBearerAuth(BEARER_SCHEME),
    ApiUnauthorizedResponse({ description: 'Missing, invalid or expired access token', type: ErrorResponse }),
  );

/** Standard 400/404 error docs for routes that take a path id / validated body. */
export const ApiStdErrors = () =>
  applyDecorators(
    ApiBadRequestResponse({ description: 'Validation or business-rule failure (including a malformed :id)', type: ErrorResponse }),
    ApiNotFoundResponse({ description: 'Referenced record not found', type: ErrorResponse }),
  );

/** Inventory ledger writes are idempotent on this header. */
export const ApiIdempotencyKey = () =>
  ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated unique key (e.g. UUID). Re-sending the same key returns the original posting instead of moving stock twice.',
  });
