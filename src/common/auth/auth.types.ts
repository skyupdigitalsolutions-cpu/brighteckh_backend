/** Claims inside an access token. Role + company are copied from `employees` at login/refresh. */
export interface AccessClaims {
  sub: string;          // employees.id
  role: string;         // employees.role_code
  company_id: string;   // employees.company_id
  typ: 'access';
}

/**
 * What JwtAuthGuard puts on req.user. `companyId` mirrors `company_id` so the
 * existing BR-02..07 services (which read actor.companyId) work unchanged.
 */
export interface AuthUser {
  id: string;
  role: string;
  company_id: string;
  companyId: string;
}

export const JWT_ISSUER = 'brightech-jms';
export const JWT_AUDIENCE = 'brightech-jms-api';
