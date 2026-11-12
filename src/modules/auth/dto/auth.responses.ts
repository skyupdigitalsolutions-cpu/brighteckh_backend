import { ApiProperty } from '@nestjs/swagger';

export class AuthUserProfile {
  @ApiProperty({ format: 'uuid', description: 'employees.id' }) id!: string;
  @ApiProperty({ example: 'DEMO-PUR' }) employee_code!: string;
  @ApiProperty({ example: 'Demo Purchase Exec' }) full_name!: string;
  @ApiProperty({
    enum: ['PURCHASE', 'ENGINEER', 'SALES', 'STORES_QUALITY', 'EXTERNAL_COORD', 'FINANCE', 'MANAGEMENT', 'SYSTEM_ADMIN'],
    description: 'From employees.role_code at token issue time',
  })
  role!: string;
  @ApiProperty({ format: 'uuid', description: 'From employees.company_id at token issue time' }) company_id!: string;
}

/** POST /auth/login and POST /auth/refresh */
export class TokenPairResponse {
  @ApiProperty({ enum: ['Bearer'] }) token_type!: string;
  @ApiProperty({ description: 'JWT (HS256). Send as `Authorization: Bearer <access_token>`' }) access_token!: string;
  @ApiProperty({ type: 'integer', example: 900, description: 'Access token lifetime in seconds' }) expires_in!: number;
  @ApiProperty({ description: 'Opaque, single-use. Exchange at /auth/refresh before refresh_expires_at; a new one is returned each time' })
  refresh_token!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) refresh_expires_at!: string;
  @ApiProperty({ type: AuthUserProfile }) user!: AuthUserProfile;
}

/** POST /auth/logout */
export class LogoutResponse {
  @ApiProperty({ description: 'true if an active refresh token was revoked; false if it was unknown/already revoked (same response either way, no information leak)' })
  revoked!: boolean;
}

/** GET /auth/me */
export class MeResponse extends AuthUserProfile {
  @ApiProperty({ example: 'DEMO-PUR' }) login_id!: string;
  @ApiProperty({ type: 'string', format: 'date-time', description: 'Access token expiry' }) token_expires_at!: string;
}
