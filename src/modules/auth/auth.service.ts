import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { QueryResult } from 'pg';
import { PgService } from '../../common/database/pg.service';
import { AccessClaims, AuthUser, JWT_AUDIENCE, JWT_ISSUER } from '../../common/auth/auth.types';
import { LoginDto, RefreshDto } from './dto/auth.dto';

export interface RequestContext { ip?: string; userAgent?: string }

/** Either PgService or a tx PoolClient -- the only call shape used here. */
interface Queryable { query(text: string, params?: unknown[]): Promise<QueryResult<any>> }

interface EmployeeRow {
  employee_id: string; employee_code: string; full_name: string; role_code: string; company_id: string;
  emp_active: boolean; cred_active: boolean; login_id: string;
}

const INVALID_LOGIN = 'invalid login or password';
const INVALID_REFRESH = 'invalid or expired refresh token';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly log = new Logger(AuthService.name);
  private readonly accessTtl: number;
  private readonly refreshTtlDays: number;
  private readonly bcryptCost: number;
  /** Compared against when the login_id is unknown, so response time doesn't reveal which logins exist. */
  private dummyHash = '';

  constructor(private readonly pg: PgService, private readonly jwt: JwtService, cfg: ConfigService) {
    this.accessTtl = Number(cfg.get('JWT_ACCESS_TTL_SECONDS') ?? 900);
    this.refreshTtlDays = Number(cfg.get('JWT_REFRESH_TTL_DAYS') ?? 7);
    this.bcryptCost = Number(cfg.get('BCRYPT_COST') ?? 12);
  }

  async onModuleInit() {
    this.dummyHash = await bcrypt.hash(randomBytes(16).toString('hex'), this.bcryptCost);
  }

  // ---------------------------------------------------------------- login

  async login(dto: LoginDto, ctx: RequestContext) {
    const emp = await this.findByLogin(this.pg, dto.login_id);
    // Always run bcrypt, even for unknown logins (timing-safe against login enumeration).
    const passwordOk = await bcrypt.compare(dto.password, emp ? (await this.hashFor(emp.employee_id)) : this.dummyHash);

    const reason = !emp ? 'UNKNOWN_LOGIN'
      : !passwordOk ? 'BAD_PASSWORD'
        : !emp.cred_active ? 'CREDENTIAL_INACTIVE'
          : !emp.emp_active ? 'EMPLOYEE_INACTIVE'
            : null;
    if (reason) {
      // Committed on its own: the failure must be audited even though the request fails.
      await this.event(this.pg, 'LOGIN_FAILED', ctx, { login: dto.login_id, emp, reason });
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    return this.pg.tx(async (client) => {
      const refresh = await this.issueRefresh(client, emp!.employee_id, randomUUID());
      await this.event(client, 'LOGIN_SUCCESS', ctx, { login: dto.login_id, emp });
      return this.tokenPair(emp!, refresh);
    });
  }

  // ---------------------------------------------------------------- refresh (rotating)

  async refresh(dto: RefreshDto, ctx: RequestContext) {
    // The tx always COMMITS (so revocations + audit rows persist); a rejection is
    // returned as data and thrown only after commit.
    const outcome = await this.pg.tx(async (client) => {
      const t = (await client.query(
        `SELECT * FROM auth_refresh_tokens WHERE token_hash=$1 FOR UPDATE`, [sha256(dto.refresh_token)],
      )).rows[0];
      if (!t) {
        await this.event(client, 'REFRESH_REJECTED', ctx, { reason: 'UNKNOWN_TOKEN' });
        return { error: INVALID_REFRESH };
      }
      const emp = await this.findByEmployeeId(client, t.employee_id);

      if (t.revoked_at) {
        if (t.revoked_reason === 'ROTATED') {
          // An already-rotated token was presented again: treat the chain as stolen.
          await client.query(
            `UPDATE auth_refresh_tokens SET revoked_at=now(), revoked_reason='REUSE_DETECTED'
              WHERE family_id=$1 AND revoked_at IS NULL`, [t.family_id],
          );
          await this.event(client, 'REFRESH_REUSE_DETECTED', ctx, { emp, reason: 'ROTATED_TOKEN_REUSED' });
        } else {
          await this.event(client, 'REFRESH_REJECTED', ctx, { emp, reason: `REVOKED_${t.revoked_reason}` });
        }
        return { error: INVALID_REFRESH };
      }
      if (new Date(t.expires_at) <= new Date()) {
        await this.event(client, 'REFRESH_REJECTED', ctx, { emp, reason: 'EXPIRED' });
        return { error: INVALID_REFRESH };
      }
      if (!emp || !emp.emp_active || !emp.cred_active) {
        await client.query(
          `UPDATE auth_refresh_tokens SET revoked_at=now(), revoked_reason='LOGOUT' WHERE id=$1`, [t.id],
        );
        await this.event(client, 'REFRESH_REJECTED', ctx, { emp, reason: 'INACTIVE' });
        return { error: INVALID_REFRESH };
      }

      const next = await this.issueRefresh(client, emp.employee_id, t.family_id);
      await client.query(
        `UPDATE auth_refresh_tokens SET revoked_at=now(), revoked_reason='ROTATED', replaced_by_id=$2 WHERE id=$1`,
        [t.id, next.id],
      );
      await this.event(client, 'REFRESH', ctx, { emp });
      // Role/company re-read from employees here, so changes apply from this refresh on.
      return { result: this.tokenPair(emp, next) };
    });
    if ('error' in outcome) throw new UnauthorizedException(outcome.error);
    return outcome.result;
  }

  // ---------------------------------------------------------------- logout

  async logout(dto: RefreshDto, ctx: RequestContext) {
    return this.pg.tx(async (client) => {
      const t = (await client.query(
        `UPDATE auth_refresh_tokens SET revoked_at=now(), revoked_reason='LOGOUT'
          WHERE token_hash=$1 AND revoked_at IS NULL RETURNING employee_id`, [sha256(dto.refresh_token)],
      )).rows[0];
      if (t) await this.event(client, 'LOGOUT', ctx, { emp: await this.findByEmployeeId(client, t.employee_id) });
      return { revoked: !!t };
    });
  }

  // ---------------------------------------------------------------- me

  async me(user: AuthUser & { token_exp?: number }) {
    const emp = await this.findByEmployeeId(this.pg, user.id);
    if (!emp || !emp.emp_active || !emp.cred_active) throw new UnauthorizedException('account is inactive');
    return {
      id: emp.employee_id, employee_code: emp.employee_code, full_name: emp.full_name,
      role: emp.role_code, company_id: emp.company_id, login_id: emp.login_id,
      token_expires_at: user.token_exp ? new Date(user.token_exp * 1000).toISOString() : null,
    };
  }

  // ---------------------------------------------------------------- credential provisioning (seed only)

  /**
   * Create a login for an employee if it has none. Never overwrites an existing
   * credential and never returns the password or hash. Used by the dev seed only;
   * there is deliberately no HTTP endpoint for setting passwords yet (open decision).
   */
  async ensureCredential(client: Queryable, employeeId: string, loginId: string, password: string): Promise<boolean> {
    const hash = await bcrypt.hash(password, this.bcryptCost);
    const r = await client.query(
      `INSERT INTO employee_credentials (employee_id, login_id, password_hash) VALUES ($1,$2,$3)
       ON CONFLICT (employee_id) DO NOTHING`, [employeeId, loginId, hash],
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------- internals

  private tokenPair(emp: EmployeeRow, refresh: { token: string; expiresAt: Date }) {
    const claims: AccessClaims = { sub: emp.employee_id, role: emp.role_code, company_id: emp.company_id, typ: 'access' };
    const access = this.jwt.sign(claims, {
      algorithm: 'HS256', expiresIn: this.accessTtl, issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
    });
    return {
      token_type: 'Bearer',
      access_token: access,
      expires_in: this.accessTtl,
      refresh_token: refresh.token,
      refresh_expires_at: refresh.expiresAt.toISOString(),
      user: {
        id: emp.employee_id, employee_code: emp.employee_code, full_name: emp.full_name,
        role: emp.role_code, company_id: emp.company_id,
      },
    };
  }

  private async issueRefresh(client: Queryable, employeeId: string, familyId: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshTtlDays * 86_400_000);
    const r = await client.query(
      `INSERT INTO auth_refresh_tokens (employee_id, family_id, token_hash, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [employeeId, familyId, sha256(token), expiresAt],
    );
    return { id: r.rows[0].id as string, token, expiresAt };
  }

  private async hashFor(employeeId: string): Promise<string> {
    const r = await this.pg.query(`SELECT password_hash FROM employee_credentials WHERE employee_id=$1`, [employeeId]);
    return r.rows[0].password_hash;
  }

  private async findByLogin(q: Queryable, loginId: string): Promise<EmployeeRow | null> {
    const r = await q.query(
      `SELECT c.employee_id, c.login_id, c.is_active AS cred_active, e.is_active AS emp_active,
              e.employee_code, e.full_name, e.role_code, e.company_id
         FROM employee_credentials c JOIN employees e ON e.id=c.employee_id
        WHERE lower(c.login_id)=lower($1)`, [loginId.trim()],
    );
    return r.rows[0] ?? null;
  }

  private async findByEmployeeId(q: Queryable, employeeId: string): Promise<EmployeeRow | null> {
    const r = await q.query(
      `SELECT c.employee_id, c.login_id, c.is_active AS cred_active, e.is_active AS emp_active,
              e.employee_code, e.full_name, e.role_code, e.company_id
         FROM employee_credentials c JOIN employees e ON e.id=c.employee_id
        WHERE c.employee_id=$1`, [employeeId],
    );
    return r.rows[0] ?? null;
  }

  private async event(
    q: Queryable, type: string, ctx: RequestContext,
    o: { login?: string; emp?: EmployeeRow | null; reason?: string },
  ) {
    try {
      await q.query(
        `INSERT INTO auth_events (event_type, login_id_attempted, employee_id, company_id, reason, ip_address, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [type, o.login?.slice(0, 120) ?? o.emp?.login_id ?? null, o.emp?.employee_id ?? null, o.emp?.company_id ?? null,
          o.reason ?? null, ctx.ip?.slice(0, 64) ?? null, ctx.userAgent?.slice(0, 300) ?? null],
      );
    } catch (e) {
      // Inside a tx this rethrows (atomic with the action); standalone failure-audit errors are logged loudly.
      this.log.error(`auth_events insert failed (${type}): ${(e as Error).message}`);
      throw e;
    }
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
