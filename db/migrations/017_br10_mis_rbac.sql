-- 017_br10_mis_rbac.sql
--
-- BR-10: management MIS / reporting + the RBAC permission layer.
--
-- Sources: BR-10 Rev01 prototype (Brightech_UI_Design_Handoff/.../BR10_Management_MIS_prototype.html):
-- 30 recorded client decisions, the proposed role catalogue, the 20-row permission
-- proposal, pending items P01-P15 and acceptance tests T01-T30 -- all "CLIENT
-- REVIEW / NOT APPROVED". No BR-10 SQL draft exists; this schema is new.
-- Build-session client decisions (5 Nov 2026): restricted grants need a separately
-- configured authoriser (unseeded = blocked); Sales scope = explicit assignments;
-- margin = components + provisional (UNVERIFIED) margin; exports CSV/XLSX/PDF.
--
-- READ-ONLY CONTRACT: BR-10 writes ONLY to the br10_* tables created here. No
-- trigger, function or view in this file writes to any BR-02..09 table. Reports
-- are run by the API inside READ ONLY transactions.
--
-- NOT a second role system: employees.role_code (PURCHASE / ENGINEER / SALES /
-- FINANCE / MANAGEMENT / SYSTEM_ADMIN ...) stays the identity the JWT carries.
-- The proposed R_* codes are a lookup that MAPS onto those codes; a binding is only
-- allowed when the employee's own role_code matches the mapping.

-- ==============================================================================
-- Role catalogue (proposal) mapped onto existing role codes.
CREATE TABLE br10_role_catalogue (
  role_code varchar(20) PRIMARY KEY CHECK (role_code ~ '^R_[A-Z_]+$'),
  title varchar(80) NOT NULL,
  default_scope varchar(40) NOT NULL,
  purpose text NOT NULL,
  maps_to_role_code varchar(40) CHECK (maps_to_role_code IN
    ('PURCHASE','ENGINEER','SALES','STORES_QUALITY','EXTERNAL_COORD','FINANCE','MANAGEMENT','SYSTEM_ADMIN')),
  is_provisional boolean NOT NULL DEFAULT false
);
INSERT INTO br10_role_catalogue VALUES
 ('R_PURCHASE_EXEC','Purchase Executive','COMPANY','Operations and procurement; finance only through separate approved grants','PURCHASE',false),
 ('R_SALES_EXEC','Sales Executive','COMPANY_ASSIGNED','Operational subset, customer communications and assigned customer payment-follow-up status','SALES',false),
 ('R_SERVICE_ENG','Service Engineer','ASSIGNED_JOBS','Own assignments, technical work and own performance metrics','ENGINEER',false),
 ('R_MGMT_COMPANY','Company Manager','COMPANY','Company operational and approved management metrics','MANAGEMENT',false),
 ('R_MGMT_GROUP','Group Management','GRANTED_COMPANIES','Consolidated permitted-company reporting only after cross-company grant','MANAGEMENT',false),
 ('R_FINANCE_EXEC','Finance / Accounts (provisional)','COMPANY','Accounting/receivables and approved financial analysis; finance team role not yet confirmed','FINANCE',true),
 -- No existing role_code for an auditor: unbindable until the client defines one (flagged).
 ('R_AUDITOR','Internal Auditor (provisional)','COMPANY','Masked compliance and export audit; no source writes',NULL,true),
 ('R_TECH_ADMIN','Technical Administrator','CONFIG','System configuration; no default access to confidential finance/PII','SYSTEM_ADMIN',false);

-- Permission proposal, verbatim. grant_type: ROLE_DEFAULT = "Allowed after activation";
-- RESTRICTED = "Separate restricted grant" (needs the configured authoriser);
-- DENIED = never grantable. Anything not listed is denied.
CREATE TABLE br10_permission_matrix (
  role_code varchar(20) NOT NULL REFERENCES br10_role_catalogue(role_code),
  data_class varchar(24) NOT NULL CHECK (data_class IN
    ('OPERATIONS','PROCUREMENT','MARGIN_PROFIT','RECEIVABLES','RECEIVABLE_STATUS','ENGINEER_PERFORMANCE','AUDIT','CONFIG')),
  row_scope varchar(24) NOT NULL CHECK (row_scope IN
    ('COMPANY','ASSIGNED_OR_CUSTOMER','ASSIGNED_CUSTOMER','ASSIGNED_JOBS','SELF','GRANTED_COMPANIES','NONE')),
  allowed_actions text[] NOT NULL,
  grant_type varchar(14) NOT NULL CHECK (grant_type IN ('ROLE_DEFAULT','RESTRICTED','DENIED')),
  note text,
  PRIMARY KEY (role_code, data_class)
);
INSERT INTO br10_permission_matrix VALUES
 ('R_PURCHASE_EXEC','OPERATIONS','COMPANY','{VIEW,EXPORT,REVIEW}','ROLE_DEFAULT','Job drilldown and purchase workflows; mask nonessential PII'),
 ('R_PURCHASE_EXEC','PROCUREMENT','COMPANY','{VIEW,EXPORT}','ROLE_DEFAULT','Supplier PO, RFQ, GRN'),
 ('R_PURCHASE_EXEC','MARGIN_PROFIT','COMPANY','{VIEW,EXPORT}','RESTRICTED','No default margin permission despite PO authority'),
 ('R_PURCHASE_EXEC','RECEIVABLES','COMPANY','{VIEW,EXPORT}','RESTRICTED','Payment follow-up authority distinct from ledger write'),
 ('R_SALES_EXEC','OPERATIONS','ASSIGNED_OR_CUSTOMER','{VIEW}','ROLE_DEFAULT','Only customer-facing jobs and assigned accounts'),
 ('R_SALES_EXEC','RECEIVABLE_STATUS','ASSIGNED_CUSTOMER','{VIEW}','ROLE_DEFAULT','Due date, invoice/payment status only; no margin or full bank data'),
 ('R_SALES_EXEC','MARGIN_PROFIT','NONE','{}','DENIED','No profit/margin by default'),
 ('R_SERVICE_ENG','OPERATIONS','ASSIGNED_JOBS','{VIEW}','ROLE_DEFAULT','Assigned jobs; masked customer fields'),
 ('R_SERVICE_ENG','ENGINEER_PERFORMANCE','SELF','{VIEW}','ROLE_DEFAULT','Only own time and workload'),
 ('R_SERVICE_ENG','RECEIVABLES','NONE','{}','DENIED','No financial customer balances'),
 ('R_MGMT_COMPANY','OPERATIONS','COMPANY','{VIEW,EXPORT,REVIEW}','ROLE_DEFAULT','Company-specific operational KPI'),
 ('R_MGMT_COMPANY','MARGIN_PROFIT','COMPANY','{VIEW,EXPORT}','RESTRICTED','Require confidential-finance approval'),
 ('R_MGMT_COMPANY','RECEIVABLES','COMPANY','{VIEW,EXPORT}','RESTRICTED','Require confidential-finance approval'),
 ('R_MGMT_GROUP','OPERATIONS','GRANTED_COMPANIES','{VIEW,EXPORT,REVIEW}','RESTRICTED','Separate cross-company grant; no implied cross-company entitlement'),
 ('R_MGMT_GROUP','MARGIN_PROFIT','GRANTED_COMPANIES','{VIEW,EXPORT}','RESTRICTED','Separate financial and cross-company grants; two independent approvals'),
 ('R_FINANCE_EXEC','RECEIVABLES','COMPANY','{VIEW,EXPORT}','RESTRICTED','Provisional role, pending organisation mapping'),
 ('R_FINANCE_EXEC','MARGIN_PROFIT','COMPANY','{VIEW,EXPORT}','RESTRICTED','Requires activation and confidential-finance grant'),
 ('R_AUDITOR','AUDIT','COMPANY','{VIEW,EXPORT}','RESTRICTED','Export is masked and audited'),
 ('R_TECH_ADMIN','CONFIG','COMPANY','{VIEW,REVIEW}','ROLE_DEFAULT','Administer policies; cannot self-grant finance'),
 ('R_TECH_ADMIN','MARGIN_PROFIT','NONE','{}','DENIED','No finance privilege from technical-admin role');

-- Restricted data classes need a FINANCIAL approval (P07) regardless of role.
CREATE OR REPLACE FUNCTION br10_is_financial_class(p_class text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT p_class IN ('MARGIN_PROFIT','RECEIVABLES','AUDIT'); $$;

-- Report catalogue. kpi_status DRAFT: no business/technical validator named (10C-10, P13).
CREATE TABLE br10_report_catalogue (
  report_code varchar(32) PRIMARY KEY,
  title varchar(120) NOT NULL,
  data_class varchar(24) NOT NULL,
  description text NOT NULL,
  kpi_status varchar(12) NOT NULL DEFAULT 'DRAFT' CHECK (kpi_status IN ('DRAFT','VALIDATED')),
  CHECK (data_class IN ('OPERATIONS','PROCUREMENT','MARGIN_PROFIT','RECEIVABLES','RECEIVABLE_STATUS','ENGINEER_PERFORMANCE','AUDIT','CONFIG'))
);
INSERT INTO br10_report_catalogue(report_code,title,data_class,description) VALUES
 ('SERVICE_PIPELINE','Service pipeline & engineer workload','OPERATIONS','BR-02 job status + BR-03/05/07/08 milestones, repeat flag, assigned engineer; Job ID drill-down'),
 ('QUALITY_WARRANTY','Quality & warranty analytics','OPERATIONS','Repeat-job rate (BR-02 repeat links), BR-09 complaint types, technical outcomes, goodwill, feedback'),
 ('SLA_MONITOR','SLA monitoring','OPERATIONS','BR-02/07 sla_instances and BR-09 case clocks by module, event, priority and state'),
 ('PROCUREMENT_SUMMARY','Procurement performance','PROCUREMENT','Supplier POs by status, acknowledgement delay, GRN accepted/rejected/held; supplier-level KPIs pending Supplier Master'),
 ('INVENTORY_POSITION','Inventory position','PROCUREMENT','Authoritative ledger balances by location role (fdn_inventory_balances) and open reservations'),
 ('RECEIVABLES_AGING','Receivables & aging','RECEIVABLES','Posted BR-08 invoices with outstanding balance, confirmed allocations only, aged by due date'),
 ('RECEIVABLE_STATUS','Customer receivable status','RECEIVABLE_STATUS','Invoice number, due date, payment status and days overdue -- no amounts'),
 ('JOB_PROFITABILITY','Job profitability (provisional)','MARGIN_PROFIT','Authorised quote value, invoiced taxable value, job-linked supplier PO cost and an UNVERIFIED provisional margin'),
 ('ENGINEER_PERFORMANCE','Engineer performance (self)','ENGINEER_PERFORMANCE','Own active/completed assignments and recorded inspection/repair time'),
 ('ACCESS_AUDIT','Report access & export audit','AUDIT','BR-10 report access/export log and source-module audit activity counts');

-- ==============================================================================
-- CLIENT-UNCONFIRMED authorisers for restricted grants (unseeded = blocked).
CREATE TABLE br10_authority_config (
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  authority_kind varchar(20) NOT NULL CHECK (authority_kind IN ('FINANCIAL_GRANT','CROSS_COMPANY_GRANT')),
  approver_role_code varchar(40) CHECK (approver_role_code IN
    ('PURCHASE','ENGINEER','SALES','STORES_QUALITY','EXTERNAL_COORD','FINANCE','MANAGEMENT','SYSTEM_ADMIN')),
  note text,
  updated_by_id uuid REFERENCES employees(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, authority_kind)
);

CREATE OR REPLACE FUNCTION br10_is_admin(p_company uuid, p_employee uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT br08_has_role(p_company, p_employee, 'SYSTEM_ADMIN'); $$;

-- ==============================================================================
-- Employee <-> R_* role binding. Starts INACTIVE; SYSTEM_ADMIN activates; never self.
CREATE TABLE br10_role_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  employee_id uuid NOT NULL,
  role_code varchar(20) NOT NULL REFERENCES br10_role_catalogue(role_code),
  status varchar(10) NOT NULL DEFAULT 'INACTIVE' CHECK (status IN ('INACTIVE','ACTIVE','REVOKED')),
  note text,
  created_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_by_id uuid,
  activated_at timestamptz,
  revoked_by_id uuid,
  revoked_at timestamptz,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, created_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, activated_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, revoked_by_id) REFERENCES employees(company_id, id),
  CHECK (status = 'INACTIVE' OR (activated_by_id IS NOT NULL AND activated_at IS NOT NULL)),
  CHECK ((status = 'REVOKED') = (revoked_by_id IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_br10_binding_live ON br10_role_bindings(employee_id, role_code) WHERE status <> 'REVOKED';

CREATE OR REPLACE FUNCTION br10_guard_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_maps text; v_emp_role text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br10_is_admin(NEW.company_id, NEW.created_by_id) THEN
      RAISE EXCEPTION 'BR10: only SYSTEM_ADMIN can create a role binding';
    END IF;
    IF NEW.status <> 'INACTIVE' THEN RAISE EXCEPTION 'BR10: every binding starts INACTIVE (explicit activation required)'; END IF;
    IF NEW.created_by_id = NEW.employee_id THEN RAISE EXCEPTION 'BR10: no self-binding'; END IF;
    SELECT maps_to_role_code INTO v_maps FROM br10_role_catalogue WHERE role_code=NEW.role_code;
    IF v_maps IS NULL THEN
      RAISE EXCEPTION 'BR10: % has no existing role_code mapping (CLIENT-UNCONFIRMED) and cannot be bound', NEW.role_code;
    END IF;
    SELECT role_code INTO v_emp_role FROM employees WHERE id=NEW.employee_id AND company_id=NEW.company_id AND is_active;
    IF v_emp_role IS DISTINCT FROM v_maps THEN
      RAISE EXCEPTION 'BR10: % maps to role_code %, but the employee is % -- BR-10 does not create a second role system',
        NEW.role_code, v_maps, COALESCE(v_emp_role,'inactive/unknown');
    END IF;
    NEW.created_at := now(); NEW.activated_by_id := NULL; NEW.activated_at := NULL;
    NEW.revoked_by_id := NULL; NEW.revoked_at := NULL;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','activated_by_id','activated_at','revoked_by_id','revoked_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','activated_by_id','activated_at','revoked_by_id','revoked_at']) THEN
    RAISE EXCEPTION 'BR10: binding identity is immutable';
  END IF;
  IF NEW.status = OLD.status THEN RAISE EXCEPTION 'BR10: binding status unchanged'; END IF;
  IF OLD.status = 'INACTIVE' AND NEW.status = 'ACTIVE' THEN
    IF NOT br10_is_admin(NEW.company_id, NEW.activated_by_id) THEN RAISE EXCEPTION 'BR10: only SYSTEM_ADMIN activates a binding'; END IF;
    IF NEW.activated_by_id = NEW.employee_id THEN RAISE EXCEPTION 'BR10: no self-activation'; END IF;
    NEW.activated_at := now();
  ELSIF NEW.status = 'REVOKED' AND OLD.status IN ('INACTIVE','ACTIVE') THEN
    IF NOT br10_is_admin(NEW.company_id, NEW.revoked_by_id) THEN RAISE EXCEPTION 'BR10: only SYSTEM_ADMIN revokes a binding'; END IF;
    NEW.revoked_at := now();
    IF OLD.status = 'INACTIVE' THEN NEW.activated_by_id := NEW.revoked_by_id; NEW.activated_at := now(); END IF;
  ELSE
    RAISE EXCEPTION 'BR10: illegal binding transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br10_binding BEFORE INSERT OR UPDATE ON br10_role_bindings
  FOR EACH ROW EXECUTE FUNCTION br10_guard_binding();
CREATE TRIGGER trg_br10_binding_nodelete BEFORE DELETE ON br10_role_bindings
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- ==============================================================================
-- Per-report, per-action, per-target-company grants to a NAMED employee.
-- Required approvals are derived when the grant is created:
--   STANDARD   (role-default class, own company)  -> SYSTEM_ADMIN of the grantee's company
--   FINANCIAL  (MARGIN_PROFIT / RECEIVABLES / AUDIT) -> configured FINANCIAL_GRANT authoriser
--   CROSS_COMPANY (target company <> employee company) -> configured CROSS_COMPANY_GRANT
--              authoriser of the TARGET company (the data owner)
-- Each approver must differ from the grantee and from each other (independent approvals).
-- The grant is ACTIVE only when every required approval is recorded.
CREATE TABLE br10_report_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  employee_id uuid NOT NULL,
  report_code varchar(32) NOT NULL REFERENCES br10_report_catalogue(report_code),
  action varchar(8) NOT NULL CHECK (action IN ('VIEW','EXPORT')),
  target_company_id uuid NOT NULL REFERENCES legal_entities(id),
  required_approvals text[] NOT NULL DEFAULT '{}',
  status varchar(10) NOT NULL DEFAULT 'INACTIVE' CHECK (status IN ('INACTIVE','ACTIVE','REVOKED')),
  note text,
  created_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  revoked_by_id uuid,
  revoked_at timestamptz,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, created_by_id) REFERENCES employees(company_id, id),
  CHECK ((status = 'ACTIVE') = (activated_at IS NOT NULL AND revoked_at IS NULL) OR status = 'REVOKED'),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL AND revoked_by_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_br10_grant_live ON br10_report_grants(employee_id, report_code, action, target_company_id)
  WHERE status <> 'REVOKED';

CREATE TABLE br10_grant_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES br10_report_grants(id),
  approval_kind varchar(14) NOT NULL CHECK (approval_kind IN ('STANDARD','FINANCIAL','CROSS_COMPANY')),
  approver_company_id uuid NOT NULL REFERENCES legal_entities(id),
  approved_by_id uuid NOT NULL,
  approver_role_code varchar(40) NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (grant_id, approval_kind),
  FOREIGN KEY (approver_company_id, approved_by_id) REFERENCES employees(company_id, id)
);

-- Does the employee's ACTIVE binding set allow (data_class, action) for this target company?
-- Returns the permitting matrix row's grant_type, or NULL if nothing allows it.
CREATE OR REPLACE FUNCTION br10_matrix_allows(p_employee uuid, p_class text, p_action text, p_cross boolean)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN bool_or(m.grant_type='ROLE_DEFAULT') THEN 'ROLE_DEFAULT' ELSE max(m.grant_type) END
    FROM br10_role_bindings b
    JOIN employees e ON e.id=b.employee_id AND e.is_active
    JOIN br10_role_catalogue rc ON rc.role_code=b.role_code AND rc.maps_to_role_code=e.role_code
    JOIN br10_permission_matrix m ON m.role_code=b.role_code AND m.data_class=p_class
   WHERE b.employee_id=p_employee AND b.status='ACTIVE' AND m.grant_type<>'DENIED'
     AND p_action = ANY(m.allowed_actions)
     AND (NOT p_cross OR m.row_scope='GRANTED_COMPANIES')
   HAVING count(*) > 0;
$$;

CREATE OR REPLACE FUNCTION br10_guard_grant()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_class text; v_type text; v_cross boolean; v_req text[] := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br10_is_admin(NEW.company_id, NEW.created_by_id) THEN RAISE EXCEPTION 'BR10: only SYSTEM_ADMIN can create a report grant'; END IF;
    IF NEW.status <> 'INACTIVE' THEN RAISE EXCEPTION 'BR10: every grant starts INACTIVE (explicit activation required)'; END IF;
    IF NEW.created_by_id = NEW.employee_id THEN RAISE EXCEPTION 'BR10: no self-grant'; END IF;
    SELECT data_class INTO v_class FROM br10_report_catalogue WHERE report_code=NEW.report_code;
    v_cross := NEW.target_company_id <> NEW.company_id;
    v_type := br10_matrix_allows(NEW.employee_id, v_class, NEW.action, v_cross);
    IF v_type IS NULL THEN
      RAISE EXCEPTION 'BR10: no ACTIVE role binding of this employee permits % on % (%)%', NEW.action, NEW.report_code, v_class,
        CASE WHEN v_cross THEN ' for another company' ELSE '' END;
    END IF;
    IF br10_is_financial_class(v_class) THEN v_req := v_req || 'FINANCIAL'::text; END IF;
    IF v_cross THEN v_req := v_req || 'CROSS_COMPANY'::text; END IF;
    IF cardinality(v_req) = 0 THEN v_req := ARRAY['STANDARD']; END IF;
    NEW.required_approvals := v_req;
    NEW.created_at := now(); NEW.activated_at := NULL; NEW.revoked_at := NULL; NEW.revoked_by_id := NULL;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','activated_at','revoked_by_id','revoked_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','activated_at','revoked_by_id','revoked_at']) THEN
    RAISE EXCEPTION 'BR10: grant identity is immutable';
  END IF;
  IF OLD.status = 'REVOKED' THEN RAISE EXCEPTION 'BR10: a revoked grant stays revoked'; END IF;
  IF NEW.status = 'ACTIVE' AND OLD.status = 'INACTIVE' THEN
    IF pg_trigger_depth() < 2 THEN RAISE EXCEPTION 'BR10: a grant becomes ACTIVE only when its required approvals are recorded'; END IF;
    NEW.activated_at := now();
  ELSIF NEW.status = 'REVOKED' THEN
    IF NOT (br10_is_admin(NEW.company_id, NEW.revoked_by_id) OR br10_is_admin(NEW.target_company_id, NEW.revoked_by_id)) THEN
      RAISE EXCEPTION 'BR10: only SYSTEM_ADMIN (grantee or data-owner company) revokes a grant';
    END IF;
    NEW.revoked_at := now();
  ELSIF NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'BR10: illegal grant transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br10_grant BEFORE INSERT OR UPDATE ON br10_report_grants
  FOR EACH ROW EXECUTE FUNCTION br10_guard_grant();
CREATE TRIGGER trg_br10_grant_nodelete BEFORE DELETE ON br10_report_grants
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

CREATE OR REPLACE FUNCTION br10_guard_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g br10_report_grants%ROWTYPE; v_role text; v_class text;
BEGIN
  SELECT * INTO g FROM br10_report_grants WHERE id=NEW.grant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BR10: grant not found'; END IF;
  IF g.status <> 'INACTIVE' THEN RAISE EXCEPTION 'BR10: grant is already %', g.status; END IF;
  IF NOT (NEW.approval_kind = ANY(g.required_approvals)) THEN
    RAISE EXCEPTION 'BR10: this grant does not need a % approval (needs %)', NEW.approval_kind, g.required_approvals;
  END IF;
  IF NEW.approved_by_id IN (g.employee_id) THEN RAISE EXCEPTION 'BR10: no self-approval of a grant'; END IF;
  IF EXISTS (SELECT 1 FROM br10_grant_approvals WHERE grant_id=g.id AND approved_by_id=NEW.approved_by_id) THEN
    RAISE EXCEPTION 'BR10: approvals must be independent (one person cannot give two approvals)';
  END IF;
  IF NEW.approval_kind = 'STANDARD' THEN
    IF NEW.approver_company_id <> g.company_id OR NOT br10_is_admin(g.company_id, NEW.approved_by_id) THEN
      RAISE EXCEPTION 'BR10: STANDARD activation is by SYSTEM_ADMIN of the grantee company';
    END IF;
    NEW.approver_role_code := 'SYSTEM_ADMIN';
  ELSE
    -- Financial and cross-company authority belong to the data-owner (target) company.
    IF NEW.approver_company_id <> g.target_company_id THEN
      RAISE EXCEPTION 'BR10: % approval must come from the data-owner company', NEW.approval_kind;
    END IF;
    SELECT approver_role_code INTO v_role FROM br10_authority_config
     WHERE company_id=g.target_company_id
       AND authority_kind = CASE NEW.approval_kind WHEN 'FINANCIAL' THEN 'FINANCIAL_GRANT' ELSE 'CROSS_COMPANY_GRANT' END;
    IF v_role IS NULL THEN
      RAISE EXCEPTION 'BR10: CLIENT-UNCONFIRMED -- no % authoriser role is configured for the data-owner company', NEW.approval_kind;
    END IF;
    IF NOT br08_has_role(g.target_company_id, NEW.approved_by_id, v_role) THEN
      RAISE EXCEPTION 'BR10: % approval requires the configured authoriser role %', NEW.approval_kind, v_role;
    END IF;
    -- T08: the technical admin can never authorise finance, even if configured.
    IF NEW.approval_kind = 'FINANCIAL' AND br10_is_admin(g.target_company_id, NEW.approved_by_id) THEN
      RAISE EXCEPTION 'BR10: SYSTEM_ADMIN (technical admin) cannot authorise financial access (T08)';
    END IF;
    NEW.approver_role_code := v_role;
  END IF;
  NEW.approved_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION br10_apply_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g br10_report_grants%ROWTYPE;
BEGIN
  SELECT * INTO g FROM br10_report_grants WHERE id=NEW.grant_id;
  IF NOT EXISTS (SELECT unnest(g.required_approvals)
                 EXCEPT SELECT approval_kind FROM br10_grant_approvals WHERE grant_id=g.id) THEN
    UPDATE br10_report_grants SET status='ACTIVE' WHERE id=g.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_br10_approval BEFORE INSERT ON br10_grant_approvals
  FOR EACH ROW EXECUTE FUNCTION br10_guard_approval();
CREATE TRIGGER trg_br10_approval_apply AFTER INSERT ON br10_grant_approvals
  FOR EACH ROW EXECUTE FUNCTION br10_apply_approval();
CREATE TRIGGER trg_br10_approval_append_only BEFORE UPDATE OR DELETE ON br10_grant_approvals
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- ==============================================================================
-- Sales <-> customer assignments (row scope for Sales). INACTIVE -> ACTIVE (admin) -> REVOKED.
CREATE TABLE br10_sales_customer_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  employee_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'INACTIVE' CHECK (status IN ('INACTIVE','ACTIVE','REVOKED')),
  created_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_by_id uuid,
  activated_at timestamptz,
  revoked_by_id uuid,
  revoked_at timestamptz,
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id),
  FOREIGN KEY (company_id, created_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, activated_by_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, revoked_by_id) REFERENCES employees(company_id, id),
  CHECK (status = 'INACTIVE' OR (activated_by_id IS NOT NULL AND activated_at IS NOT NULL)),
  CHECK ((status = 'REVOKED') = (revoked_by_id IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_br10_sales_assignment_live ON br10_sales_customer_assignments(employee_id, customer_id)
  WHERE status <> 'REVOKED';

CREATE OR REPLACE FUNCTION br10_guard_sales_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT br10_is_admin(NEW.company_id, NEW.created_by_id) THEN RAISE EXCEPTION 'BR10: only SYSTEM_ADMIN assigns customers to Sales'; END IF;
    IF NOT br08_has_role(NEW.company_id, NEW.employee_id, 'SALES') THEN RAISE EXCEPTION 'BR10: customer assignments are for Sales employees'; END IF;
    IF NEW.status <> 'INACTIVE' THEN RAISE EXCEPTION 'BR10: every assignment starts INACTIVE'; END IF;
    NEW.created_at := now(); NEW.activated_by_id := NULL; NEW.activated_at := NULL;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','activated_by_id','activated_at','revoked_by_id','revoked_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','activated_by_id','activated_at','revoked_by_id','revoked_at']) THEN
    RAISE EXCEPTION 'BR10: assignment identity is immutable';
  END IF;
  IF OLD.status = 'INACTIVE' AND NEW.status = 'ACTIVE' THEN
    IF NOT br10_is_admin(NEW.company_id, NEW.activated_by_id) OR NEW.activated_by_id = NEW.employee_id THEN
      RAISE EXCEPTION 'BR10: SYSTEM_ADMIN (not the assignee) activates an assignment';
    END IF;
    NEW.activated_at := now();
  ELSIF NEW.status = 'REVOKED' AND OLD.status <> 'REVOKED' THEN
    IF NOT br10_is_admin(NEW.company_id, NEW.revoked_by_id) THEN RAISE EXCEPTION 'BR10: only SYSTEM_ADMIN revokes an assignment'; END IF;
    NEW.revoked_at := now();
    IF OLD.status = 'INACTIVE' THEN NEW.activated_by_id := NEW.revoked_by_id; NEW.activated_at := now(); END IF;
  ELSE
    RAISE EXCEPTION 'BR10: illegal assignment transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_br10_sales_assignment BEFORE INSERT OR UPDATE ON br10_sales_customer_assignments
  FOR EACH ROW EXECUTE FUNCTION br10_guard_sales_assignment();
CREATE TRIGGER trg_br10_sales_assignment_nodelete BEFORE DELETE ON br10_sales_customer_assignments
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();

-- ==============================================================================
-- Column masking policy (10C-08 / T20). Actual policy pending (P07): seeded with the
-- minimum PII / bank columns the reports return. EXPORT = masked in exports;
-- ALWAYS = masked in on-screen results and exports.
CREATE TABLE br10_column_masks (
  report_code varchar(32) NOT NULL REFERENCES br10_report_catalogue(report_code),
  column_name varchar(60) NOT NULL,
  applies_to varchar(8) NOT NULL CHECK (applies_to IN ('EXPORT','ALWAYS')),
  mask_rule varchar(8) NOT NULL CHECK (mask_rule IN ('REDACT','PARTIAL')),
  note text,
  PRIMARY KEY (report_code, column_name)
);
INSERT INTO br10_column_masks VALUES
 ('SERVICE_PIPELINE','customer_name','EXPORT','PARTIAL','PII minimisation in exports'),
 ('RECEIVABLES_AGING','customer_gstin','EXPORT','PARTIAL','Tax identifier'),
 ('RECEIVABLES_AGING','customer_name','EXPORT','PARTIAL','PII minimisation in exports'),
 ('RECEIVABLE_STATUS','customer_name','EXPORT','PARTIAL','PII minimisation in exports'),
 ('JOB_PROFITABILITY','customer_name','EXPORT','PARTIAL','PII minimisation in exports'),
 ('ACCESS_AUDIT','filters','EXPORT','REDACT','Filter payloads may contain identifiers');

-- ==============================================================================
-- Access / export audit (10C-07, T01, T21, T28): append-only, including denials.
CREATE TABLE br10_report_access_log (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES legal_entities(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  report_code varchar(32) REFERENCES br10_report_catalogue(report_code),
  action varchar(8) NOT NULL CHECK (action IN ('VIEW','EXPORT')),
  outcome varchar(8) NOT NULL CHECK (outcome IN ('ALLOWED','DENIED')),
  export_format varchar(6) CHECK (export_format IN ('csv','xlsx','pdf')),
  scope_company_ids uuid[] NOT NULL DEFAULT '{}',
  row_scope varchar(24),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  filter_checksum char(64),
  row_count integer,
  denial_reason text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (outcome = 'ALLOWED' OR denial_reason IS NOT NULL)
);
CREATE INDEX idx_br10_access_company ON br10_report_access_log(company_id, occurred_at DESC);
CREATE TRIGGER trg_br10_access_log_append_only BEFORE UPDATE OR DELETE ON br10_report_access_log
  FOR EACH ROW EXECUTE FUNCTION fdn_block_mutation();
