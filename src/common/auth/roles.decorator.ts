import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension, ApiForbiddenResponse } from '@nestjs/swagger';
import { Role } from './roles.enum';
import { ErrorResponse } from '../swagger/api-docs';

export const ROLES_KEY = 'roles';

/**
 * Sets the role metadata RolesGuard enforces (unchanged behaviour), and also
 * documents it in OpenAPI as `x-roles` + a 403 response so UI designers can see
 * which role each screen/action belongs to.
 */
export const Roles = (...roles: Role[]) =>
  applyDecorators(
    SetMetadata(ROLES_KEY, roles),
    ApiExtension('x-roles', roles),
    ApiForbiddenResponse({ description: `Requires role: ${roles.join(' | ')}`, type: ErrorResponse }),
  );
