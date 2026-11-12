-- ============================================================================
-- 011 AUTH: credentials, refresh tokens, auth event log
-- ----------------------------------------------------------------------------
-- NEW (not client-reviewed). Additive only: no existing table or column is
-- altered. Replaces the interim X-Actor-Id header with JWT login.
--
-- Principles (same as ActorGuard had):
--   * role + company come from `employees` at login/refresh, never the request.
--   * passwords are stored ONLY as bcrypt hashes (CHECK enforces the format, so
--     a plain-text password cannot be written even by mistake).
--   * refresh tokens are stored ONLY as SHA-256 hashes (the raw token is shown
--     to the client once and never persisted).
--   * auth events are append-only (same fdn_block_mutation guard as the ledger).
-- ============================================================================

-- One login identity per employee. login_id defaults to employee_code at seed
-- time; it may later be an email (case-insensitive unique).
CREATE TABLE employee_credentials (
  employee_id          uuid PRIMARY KEY REFERENCES employees(id),
  login_id             varchar(120) NOT NULL CHECK (length(btrim(login_id)) > 0),
  password_hash        text NOT NULL CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'),
  is_active            boolean NOT NULL DEFAULT true,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX employee_credentials_login_id_ci ON employee_credentials (lower(login_id));
CREATE TRIGGER trg_employee_credentials_touch BEFORE UPDATE ON employee_credentials
  FOR EACH ROW EXECUTE FUNCTION fdn_touch_updated_at();

-- Opaque refresh tokens, rotated on every use. family_id groups a login's chain
-- so re-use of an already-rotated token can revoke the whole chain.
CREATE TABLE auth_refresh_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  family_id       uuid NOT NULL,
  token_hash      char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  varchar(30) CHECK (revoked_reason IN ('ROTATED','LOGOUT','REUSE_DETECTED')),
  replaced_by_id  uuid REFERENCES auth_refresh_tokens(id),
  CHECK (expires_at > issued_at),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX auth_refresh_tokens_employee ON auth_refresh_tokens (employee_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_refresh_tokens_family ON auth_refresh_tokens (family_id);

-- Append-only auth audit. Separate from activity_audit_log because a failed
-- login for an unknown login_id has no company_id / entity_id (both NOT NULL there).
CREATE TABLE auth_events (
  id                  bigserial PRIMARY KEY,
  event_type          varchar(30) NOT NULL CHECK (event_type IN
                        ('LOGIN_SUCCESS','LOGIN_FAILED','REFRESH','REFRESH_REJECTED','REFRESH_REUSE_DETECTED','LOGOUT')),
  login_id_attempted  varchar(120),
  employee_id         uuid REFERENCES employees(id),
  company_id          uuid REFERENCES legal_entities(id),
  reason              varchar(60),
  ip_address          varchar(64),
  user_agent          varchar(300),
  occurred_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_employee ON auth_events (employee_id, occurred_at DESC);
CREATE INDEX auth_events_login ON auth_events (lower(login_id_attempted), occurred_at DESC);
CREATE TRIGGER trg_auth_events_append_only BEFORE UPDATE OR DELETE ON auth_events
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

COMMENT ON TABLE employee_credentials IS 'Login identity per employee. password_hash is bcrypt only (CHECK). Role/company are NOT stored here: always read from employees.';
COMMENT ON TABLE auth_refresh_tokens IS 'Opaque refresh tokens, SHA-256 hashed, rotated on use; family_id revoked on re-use.';
COMMENT ON TABLE auth_events IS 'Append-only audit of login attempts, refreshes and logouts.';
