# Brightech JMS — Build Guide for Claude Code

You are building the backend for **Brightech Job Management System**, an ERP for a
Bengaluru industrial-electronics **repair + sales** company. Stack is locked:
**NestJS (Fastify adapter) + PostgreSQL + Prisma-as-client**. Read this whole file
before writing code. These rules are not suggestions.

---

## 0. Golden rules (break these = broken system)

1. **SQL owns the schema. Prisma does not.** Tables, triggers and plpgsql functions
   live in `db/migrations/*.sql`. Prisma is a *generated typed client only*.
   - NEVER run `prisma migrate`, `prisma db push`, or let Prisma create/alter tables.
   - To change schema: write a NEW numbered SQL migration, then `npm run db:sync`.
   - `npm run db:sync` = migrate → `prisma db pull` → `prisma generate`.
2. **Transactions for anything multi-row or function-backed.** Counter allocation,
   equipment-group expansion, job creation, custody moves, stock moves — each runs
   inside `PgService.tx()`. Use the DB's plpgsql functions; don't reimplement them in TS.
3. **Auth is server-side, always.** Identity + role come from the authenticated
   session, NEVER from a request body/query. Apply `@Roles(...)` + `RolesGuard` on every
   protected route. The DB triggers also enforce ownership — both layers, not one.
4. **Never invent business rules.** If a rule isn't in this file or the DB, STOP and
   flag it as an open decision. Do not guess pricing, approvals, or numbering.
5. **Don't touch the migration SQL files.** `001`/`002` are client-reviewed. Corrections
   go in new migrations, never by editing these.
6. **Local DB only for build.** Never point this at Brightech's real server. The schema
   is "fresh empty staging only" — running it on a populated DB is forbidden.

---

## 1. Setup (run once)

```bash
cp .env.example .env
npm install
npm run db:up         # Docker Postgres on localhost:5433
npm run db:migrate    # 001 integrated BR01-05 (91 tbl) + 003 foundation (F1 masters + F2 ledger)
npm run db:pull       # introspect -> prisma/schema.prisma
npm run db:generate   # typed client
npm run start:dev     # GET http://localhost:3000/api/health -> { status: ok, db: up }
```

If health returns `db: up`, the foundation works. Then build modules in order.

---

## 2. Build order (strict)

Migration 003 now delivers the **Foundation** (F1 masters + F2 inventory ledger) that
was missing — built + live-tested. Build the API modules incrementally:

1. **Masters** module — DONE (src/modules/masters): Item + Assembly master, approve, BOM.
2. **Inventory** module — DONE (src/modules/inventory): the single-writer ledger.
3. **BR-02** module — inward → Job ID → assignment → SLA.
4. **BR-03** module — custody → inspection → material requirement.
5. **BR-04/05/06/07** write paths — now UNBLOCKED: call the inventory API (never touch
   balances directly).
6. **BR-08** (dispatch / challan / invoice / payment / closure) — DONE, migrations
   013/014, src/modules/br08. See §4d. Working calendar — DONE, migration 012,
   src/modules/calendar. See §4e.
7. **BR-09** (after-sales / warranty) — DONE, migrations 015/016, src/modules/br09 +
   BR-02 `POST /jobs/:id/repeat-link`. See §4f.
8. **BR-10** (management MIS + RBAC) — DONE, migration 017, src/modules/br10. See §4g.
9. **BR-11** (Sales & Supply / direct product sales) — DONE, migrations 018/019, src/modules/br11
   + BR-06 SALES_ORDER routes + BR-08 PRODUCT_SALES routes. See §4h.

Each module: `*.module.ts`, `*.controller.ts`, `*.service.ts`, DTOs with
`class-validator`. Services use `PgService.tx()` for writes, `PrismaService` for
plain reads. Wire each module into `app.module.ts` as you finish it.

---

## 3. BR-02 API (build first)

Domain: one **inward receipt (JIN)** holds one or more **equipment groups** (an
assembly + qty); each group **expands** into N **equipment units**; each **verified**
unit gets one **Job ID** (per legal entity). Then assign an engineer. SLA timers run
off the working calendar.

Rules baked into the DB — respect them, don't fight them:
- **One Job ID per physical unit.** Never create Job IDs anywhere but here.
- **JIN and Job numbers are immutable** and allocated from per-company counters via a
  plpgsql function inside a transaction. Reject any caller-supplied number.
- **Photo-before-verify:** a unit cannot be verified without its inspection photo.
- **Company scoping:** every job-owning row must prove `(company_id, job_id)` belong
  together (triggers enforce; your DTOs must pass both).
- Warranty return = a NEW JIN + NEW Job with a repeat-link to the original.

Endpoints (suggested; confirm fields against introspected schema):
- `POST /inward-receipts` (PURCHASE) — create JIN header.
- `POST /inward-receipts/:id/equipment-groups` (PURCHASE) — add assembly + qty.
- `POST /equipment-groups/:id/expand` (PURCHASE) — tx: create N units.
- `POST /equipment-units/:id/verify` (PURCHASE) — tx: photo-gated → allocate Job ID.
- `POST /jobs/:id/assign` (PURCHASE) — assign engineer.
- `GET  /inward-receipts/:id`, `GET /jobs/:id` — detail reads (Prisma).

## 4. BR-03 API (build second)

Domain: engineer accepts custody → inspection session (time tracked) → versioned
inspection report → Purchase accepts/returns the report → engineer submits a
**material requirement** (parts + qty) **straight to Purchase**.

Rules baked into the DB:
- **Material request has NO approval gate.** Engineer submits → it lands in Purchase's
  inbox (`DRAFT → SUBMITTED → PROCESSING`). Do not build an approval step. The only
  review is on the *inspection report*.
- **Prereq chain:** material request is blocked unless a Purchase-ACCEPTED inspection
  version exists for that job, by the current accepted engineer.
- **Material lines require APPROVED items only** (via the item-catalog bridge).
- **Engineer edit-lock:** 1 working hour after submit, OR the moment Purchase starts
  processing — whichever first. After lock, changes go through a change-request that
  Purchase reviews. (Timer needs the working calendar — see blockers.)

Endpoints (suggested):
- `POST /jobs/:id/custody-ack` (ENGINEER)
- `POST /jobs/:id/inspection-sessions` + start/pause/resume/stop (ENGINEER)
- `POST /inspection-reports` / `:id/submit` (ENGINEER); `:id/review` (PURCHASE: accept/return)
- `POST /material-requests` / `:id/lines` / `:id/submit` (ENGINEER)
- `POST /material-requests/:id/change-requests` (ENGINEER) + review (PURCHASE)

---

## 4b. Foundation (F1 masters + F2 ledger) — migration 003

**Single-writer rule (non-negotiable):** ALL stock movement goes through the DB
function `fdn_post_movement` via the inventory API. BR-04/05/06/07 are consumers —
they NEVER update `fdn_inventory_balances` directly. The journal is append-only; the
balances are materialised under row lock inside the function; every call is idempotent
on its `idempotency_key`.

Inventory API (src/modules/inventory), all require `Authorization: Bearer <JWT>`; writes also `Idempotency-Key`
(auth: migration 011 + src/modules/auth — global JwtAuthGuard, `@Public()` opts out; see /api/docs "Auth"):
- `GET  /api/inventory/availability?company_id=&item_id=` → allocatable + per-location balances
- `POST /api/inventory/receipts`        (BR-06 GRN accepted line → MAIN/QUARANTINE)
- `POST /api/inventory/reservations`    (BR-05 job reservation; reduces allocatable)
- `POST /api/inventory/issues`          (BR-07 MAIN → ENGINEER_HELD)
- `POST /api/inventory/consumptions`    (BR-07 ENGINEER_HELD → CONSUMED)
- `POST /api/inventory/returns`         (BR-07 ENGINEER_HELD → MAIN after Purchase verify)
- `POST /api/inventory/supplier-returns`(BR-06 QUARANTINE → SUPPLIER_RETURN)
- `GET  /api/inventory/journal?company_id=&reference_id=` → traceability

Masters API (src/modules/masters): `POST /api/masters/items|assemblies`,
`/items/:id/approve`, `/assemblies/:id/approve`, `/assemblies/:id/bom`, `GET` lists.
Item/Assembly **code + class are immutable after insert** (trigger). Only APPROVED/ACTIVE
items can be transacted. Seed `fdn_code_dictionary` (from BR-01A workbook) before creating items.

**Still client-pending (don't hardcode):** working calendars, per-company role-code
activation, BR-08 invoice specifics. Items/suppliers seed as DRAFT → approved by authorised staff.

## 4c. BR-07 (repair/test/dispatch release) — migrations 009/010, src/modules/br07

Built + live-tested. No BR-07 draft schema existed; 009 is new (not client-reviewed).
- Issue converts ONE whole COMMITTED BR-05 reservation (ledger can't partially decrement
  a reservation), then closes the ledger reservation `CONSUMED` via
  `InventoryService.consumeReservation` so allocatable isn't double-counted.
  `br05_material_reservations` stays `COMMITTED` (its enum has no ISSUED value).
- Issue-row counters (consumed + returned + return-pending ≤ issued) are trigger-only.
- Test results are immutable; review/return-verify/dispatch-release check
  `role_code='PURCHASE'` in the DB as well as RolesGuard.
- Test-start SLA targets are data (`br07_test_sla_targets`); since migration 012
  `sla_instances.due_at = br07_test_sla_due(...)` from the working calendar and test start
  closes the clock as MET/BREACHED. Clock starts at repair-report submission, stops at
  test-cycle start. (NULL due_at only for a company with no active calendar.)
- `service_jobs.status` untouched (no approved repair/test enum values). No BR-08 rows.

**OPEN DECISIONS (BR-07, flagged, not resolved):**
1. Who issues material — built as PURCHASE only; Stores may need it.
2. Two-fail review cadence — built conservatively: once ≥2 fails, EVERY later FAIL needs
   its own Purchase review before the next cycle (vs one review after the 2nd fail).
3. Review decision `STOP` blocks further repair/test/handoff but has no downstream path
   (return-unrepaired / BER / scrap) — undefined.
4. Handoff does not block on unreconciled engineer-held material; it only snapshots
   `outstanding_engineer_held_qty`.
5. A FAIL does not force a new repair-report version before the next cycle.

## 4d. BR-08 (dispatch → DC → POD → invoice → payment → closure) — migrations 013/014, src/modules/br08

Built + live-tested. Rules are CLIENT-CONFIRMED (5 Nov 2026); items marked † were decided
with the client in the build session.
- Entities/prefixes are config on `legal_entities` (`doc_prefix`, `gstin`, `state_code`,
  address, bank): BLR = Brightech Industrial Automation Pvt Ltd / `BIAPL` / Karnataka 29;
  CHN = Brightech Engineering / `BE`. Prefix/state/GSTIN freeze once any BR-08 document exists.
  Admin edits via `PUT /api/br08/entity-profile` (SYSTEM_ADMIN). Invoicing is blocked until
  GSTIN, address and bank name/account/IFSC are filled.
- Numbering: per company, per Indian FY (Apr–Mar), `br08_fy_counters` + `br08_next_doc_number`,
  assigned by DB triggers (never caller-supplied): INV `BIAPL/496/26-27`, DC
  `417/BIAPL/NA/2026-27`, CN `CN/BIAPL/12/26-27` †.
- Dispatch batch + Job Work DC + POD: **PURCHASE** †. Dispatch is customer-owned equipment —
  NOTHING is posted to the inventory ledger. Jobs need a BR-07 dispatch release; one customer
  per batch; DC is issued in the same tx that marks the batch DISPATCHED.
- Tax invoice: **FINANCE** only. At-or-after dispatch (job must be in a DISPATCHED batch), not
  payment-first. One invoice may cover several dispatched jobs of ONE customer †; each job on
  at most one live invoice. Lines = snapshot of the job's current AUTHORISED BR-05 authorisation
  → accepted BR-04 quote revision lines † (Finance cannot edit amounts). Invoice date = today
  (server); due date = date + credit days (customer `credit_days`, default 30, overridable per
  invoice and stored on it). 3 print copies via `GET /invoices/:id/print`.
- GST computed server-side: place of supply = customer `state_code`; same as entity state →
  CGST 9% + SGST 9%, else IGST 18%. Rates + HSN/SAC (default 998732) in `br08_gst_rate_config`
  (default row + optional per-quote-line-type override). Tax per line, half-up to the paisa;
  header = sum of lines. Money in integer paise.
- D6: invoice blocked unless customer AND assembly are both APPROVED (build fn + DB trigger).
  Customer GSTIN + state required † (unregistered customers blocked — see open decisions).
- Issued invoices are immutable: content frozen by trigger; child rows only insertable in the
  creating transaction; status/paid amount move only via allocation/credit-note triggers.
- Payments: **FINANCE** records receipts and allocates (partial supported; cannot exceed
  receipt unallocated or invoice balance). When an invoice reaches PAID, its live jobs move to
  `service_jobs.status='CLOSED'` in the same tx † (+ job_status_history).
- Credit note: **FINANCE** raises + approves in one step. Full cancellation of one invoice;
  reasons `WARRANTY_FAILURE` (failed job must be on the invoice, within 3 months of that job's
  POD date †) or `INVOICE_CORRECTION`. Paid amounts are reversed back to the receipts (customer
  credit); jobs are released from the invoice. BR-09 hook: optional `warranty_return_job_id`
  (must be a BR-02 repeat of the failed job).
- Waiver / no-charge closure: **SALES** only; job must not be on a live invoice; closes the job.

**OPEN DECISIONS (BR-08, flagged, not resolved):**
1. Quote total composition (CLAUDE.md §5) — a quote revision with non-zero revision-level
   `freight_charge` or `inspection_fee_pre_tax` is BLOCKED from invoicing (not silently dropped),
   and so is an authorisation whose amount ≠ quote-lines total (partial acceptance). Needs sign-off.
2. Unregistered (no-GSTIN) customers cannot be invoiced.
3. All quote line types use the default HSN 998732 @ 18%. MATERIAL lines (spare parts) may
   need a goods HSN/rate — add rows to `br08_gst_rate_config` once Finance confirms.
4. Credit notes are full-value only; no partial credit note. Money reversed by a credit note
   sits as unallocated customer credit on the receipt — refund / adjustment process undefined.
5. A job closed by full payment stays CLOSED if its invoice is later cancelled by an
   INVOICE_CORRECTION credit note; it can be re-invoiced, but there is no "reopen" status.
6. TDS deducted by customers is not modelled: a short-paid invoice never reaches PAID, so its
   jobs never auto-close. Needs a Finance rule (TDS allocation / write-off).
7. Waiver has no dispatch prerequisite; returning a waived, never-released unit has no DC path
   (ties to BR-07 open decision 3 — STOP has no downstream path).
8. CHN state code seeded as 33 (Tamil Nadu) from the site name — confirm. No GSTIN/bank seeded
   for either company. "NA" in the DC number is copied literally from the client sample.
9. Round-off to the nearest rupee is NOT applied (invoice total is exact to the paisa).

## 4f. BR-09 (after-sales / warranty) — migrations 015/016, src/modules/br09 (+ BR-02 repeat link)

Built + live-tested. **No BR-09 draft SQL package exists** (the "19 proposed tables" the
register mentions were never delivered). Sources: the BR-09 Rev01 client decision register
(30 recorded responses, SOP "CLIENT REVIEW – NOT APPROVED", embedded in
`Brightech_UI_Design_Handoff/.../BR09_Warranty_prototype.html`) + client decisions in the
build session (†). Schema is new.
- Flow: Sales registers a case (`ASC-<CODE>-000001`, continuous per company, 09A-03) with
  the original Job if known; else it sits in the unmatched queue and Purchase matches it once
  (09A-02). Matching snapshots the original job's BR-08 invoice (live, else latest), POD date
  and warranty status. Sales acknowledges / communicates (09A-06, 09C-04); Purchase starts review.
- Repeat return: NEW JIN + Job through the normal BR-02 inward → verify, then
  `POST /jobs/:id/repeat-link` (PURCHASE, new BR-02 endpoint, `br02_link_repeat_job`) writes
  `job_repeat_links` (R01/R02…, original + previous job resolved by the DB; same customer;
  original must have been dispatched; new job created after that dispatch) (09B-01/10).
  BR-09 only attaches that job to the case — it never creates Job IDs, posts stock, invoices,
  or closes jobs.
- Engineer technical assessment on the repeat job (current accepted engineer; outcomes per
  09B-05). Coverage outcomes (WARRANTY_REPAIR / GOODWILL / REPLACEMENT / REFUND_REVIEW) need
  an assessment — dates never approve a claim (09B-06). WARRANTY_REPAIR requires IN_WARRANTY.
- Warranty status = 3 months from the original job's POD date † (same rule as BR-08), advisory.
- REFUND_REVIEW creates a `br09_credit_note_requests` row (REQUESTED); FINANCE fulfils it via
  `br09_fulfil_credit_note_request`, which inserts the **BR-08** credit note (all BR-08
  triggers apply: Finance, 3-month window, invoice cancel, payment reversal) with
  `warranty_return_job_id` = the case's latest repeat job, or declines with a reason †.
- Case closure: PURCHASE (09C-06) with a reason, a Sales RESOLUTION communication after the
  outcome, goodwill approved / CN request resolved, and for repair outcomes every repeat job
  dispatched back (BR-08). No decision needed only if nothing was returned (09A-10). Closing
  a case NEVER touches service_jobs — separate from BR-08 paid-job closure.
- Case SLA clocks (acknowledgement / initial assessment / resolution) use the 012 calendar via
  `br09_sla_targets` — **UNSEEDED** † (P05/P06), so `due_at` is NULL until Brightech sets targets.
- Analytics views: repeat failures, root cause, goodwill, feedback (`GET /support-analytics`).

**CLIENT-UNCONFIRMED authorities (same pattern as DOFA):** `br09_authority_config`
(`CLAIM_DECISION`, `GOODWILL_APPROVAL`) is **unseeded**, so claim decisions and goodwill approvals
are **blocked** until a SYSTEM_ADMIN assigns a role (`PUT /support-config/authorities`). The
register only *suggests* Purchase Executive for claims (09C-02); goodwill authority and limits are
unassigned (09B-08, P02/P03). The code picks no approver. The integrity suite assigns PURCHASE
temporarily and restores the empty config afterwards.

**Migration 020 (12 Nov 2026, gaps found against the official BR-09 Rev01 SQL — that SQL is NOT applied):**
- `br09_case_evidence` (CUSTOMER_PHOTO / CUSTOMER_VIDEO / CUSTOMER_EMAIL / ORIGINAL_INVOICE / DELIVERY_POD / TEST_RECORD),
  linked to the case and optionally a claim decision of the same case; Sales or Purchase; append-only; open cases only
  (ON_HOLD included); `received_at` never in the future. `POST /support-cases/:id/evidence`.
- `REFUND_REPLACEMENT_REVIEW` authority in `br09_authority_config` (**UNSEEDED = blocked, CLIENT-UNCONFIRMED**) +
  `br09_refund_replacement_reviews` (append-only). A REPLACEMENT or REFUND_REVIEW decision needs an APPROVED review:
  the Finance credit-note request is now raised on review APPROVAL (no longer on the decision), closure is blocked
  until approved, and a REJECTED review lets the decision be replaced. `POST /support-cases/:id/refund-replacement-review`.
- Case statuses `ON_HOLD` and `CANCELLED` (Purchase only, reason required). Both only from REGISTERED/UNDER_REVIEW
  (+ ON_HOLD → CANCELLED) and only while NO claim decision and NO credit-note request exists. ON_HOLD resumes only to
  the status it was held from; closing needs resume first. CANCELLED is terminal (all child writes rejected) and
  stops all case SLA clocks. `POST /support-cases/:id/hold|resume|cancel`.

**OPEN DECISIONS (BR-09, flagged, not resolved):**
9. (020) Who may hold/cancel: built as PURCHASE only (Sales may need to cancel a duplicate it registered).
10. (020) Cancellation is also refused once a repeat job (returned unit) is linked — conservative; not in the brief.
11. (020) ON_HOLD does NOT pause case SLA clocks (no pause rule defined; the official SQL also leaves it pending).
12. (020) No maker-checker between the claim decider and the refund/replacement reviewer (same as goodwill);
    the same person can do both if both authorities map to their role.
13. (020) Engineers cannot record evidence (TEST_RECORD comes from Sales/Purchase); evidence is file references only.
14. Still open from the reconciliation: pre-arrival return tracking, goodwill scope/cost, BR-03 report link on the
    assessment, resolution-action / commercial-link records, communication send-status, warranty-terms evidence.
1. Warranty-term conflict: register 09A-07 says "per accepted quotation/invoice, no default
   period" and BPD CFG-76 says a 90-day default; built to the BR-08 client-confirmed 3 months from
   POD. There is no per-quote/invoice warranty field anywhere.
2. Free warranty repair has no customer authority: BR-05 release (needed before BR-06/BR-07
   material issue) requires a customer PO/Job Order/email, so a free repeat repair cannot get
   material through the ledger today. The free repeat job closes via the BR-08 Sales waiver †.
3. REPLACEMENT has no dispatch path: BPD says a free replacement ships on a delivery challan
   (BT/DC series), but BR-08 only dispatches BR-07-released customer units. REPLACEMENT closure
   currently requires only the resolution communication.
4. Refund outside warranty: a credit-note request is always raised as BR-08 `WARRANTY_FAILURE`,
   so BR-08 rejects it after 3 months from POD. Refund of an out-of-warranty unit is undefined.
5. Customer acknowledgement before closure (P09/P14) is not required; only a sent RESOLUTION
   communication is.
6. Return freight responsibility (09B-02, P10), RCA escalation threshold/owner (P13) and
   supplier warranty claims (BPD P-50 RM-11) are not modelled.
7. One current decision per case; it can be replaced only after a goodwill REJECTED or a CN
   request DECLINED. No maker-checker between decider and goodwill approver (not specified).
8. Case number format `ASC-<CODE>-000001` follows the JIN/JOB/MR/QT/PO convention; the client
   has not specified one.

## 4g. BR-10 (management MIS + RBAC) — migration 017, src/modules/br10

Built + live-tested. **No BR-10 SQL draft exists.** Sources: the BR-10 Rev01 prototype
(`Brightech_UI_Design_Handoff/.../BR10_Management_MIS_prototype.html`: 30 client decisions,
role catalogue, 20-row permission proposal, P01–P15, tests T01–T30; all "NOT APPROVED") +
build-session client decisions (†).
- **Read-only contract:** reports are SELECT/GROUP BY run inside `PgService.readOnly()`
  (`BEGIN TRANSACTION READ ONLY`, so Postgres rejects any write). BR-10 writes only `br10_*`
  tables (+ `activity_audit_log` for governance actions). The suite proves source tables'
  counts + md5 checksums are unchanged across every report and export.
- **No second role system:** `employees.role_code` stays the identity. `br10_role_catalogue` maps
  R_* → existing codes; a binding is rejected unless the employee's role_code matches.
- **Entitlement, server-side, at every call** (`Br10AccessService`): active employee → ACTIVE
  `br10_role_bindings` → `br10_permission_matrix` (proposal, verbatim) allows data class + action
  → ACTIVE named-employee `br10_report_grants` row for (report, VIEW|EXPORT, company) → row
  scope (union): COMPANY / CUSTOMERS (Sales, explicit `br10_sales_customer_assignments` †) /
  JOBS (engineer's current assignments, no customer fields) / SELF. Every denial →
  `br10_report_access_log` (append-only) + 403. Revocation applies on the next call.
- **Grants start INACTIVE, never auto-granted, no self-grant.** SYSTEM_ADMIN creates them. The DB
  derives the required approvals: STANDARD (SYSTEM_ADMIN, own company); FINANCIAL for
  MARGIN_PROFIT / RECEIVABLES / AUDIT; CROSS_COMPANY when the target company ≠ the employee's.
  FINANCIAL and CROSS_COMPANY come from the **data-owner company's configured authoriser** †
  (`br10_authority_config`, **UNSEEDED = blocked, CLIENT-UNCONFIRMED**). Independent approvers
  are required, and SYSTEM_ADMIN can never authorise FINANCIAL (T08). VIEW ≠ EXPORT.
- Masking: `br10_column_masks` (EXPORT or ALWAYS) is applied before CSV/XLSX/PDF †; every export
  is logged with actor, company set, row scope, filters, SHA-256 filter checksum, format and rows.
- Reports: SERVICE_PIPELINE, QUALITY_WARRANTY, SLA_MONITOR (OPERATIONS); PROCUREMENT_SUMMARY,
  INVENTORY_POSITION (PROCUREMENT); RECEIVABLES_AGING (RECEIVABLES); RECEIVABLE_STATUS (Sales
  tier, no amounts); JOB_PROFITABILITY (MARGIN_PROFIT: authorised value, invoiced taxable,
  job-linked supplier PO cost, **provisional margin labelled UNVERIFIED** † with the formula
  returned); ENGINEER_PERFORMANCE (SELF); ACCESS_AUDIT (AUDIT). Missing sources return NULL plus
  a readiness reason (SUPPLIER_MASTER_PENDING, DRAFT, PENDING_CONFIG), never a zero. Supplier
  cost / PO value appear ONLY in JOB_PROFITABILITY.
- Cross-company: `?companies=a,b`, each company needs its own ACTIVE grant (R_MGMT_GROUP rows
  only). This is a separate parameter, not `company_id`, so CompanyScopeGuard's own-company rule
  is unchanged for every other module.

**Migration 021 (12 Nov 2026, gap found against the official BR-10 Rev01 SQL — that SQL is NOT applied):**
- Data class `PII_CUSTOMER`. A `PII_CUSTOMER` row in `br10_report_catalogue` is an ENTITLEMENT (not runnable —
  `GET /mis/reports/PII_CUSTOMER` is 400), granted through the normal named-grant flow (INACTIVE → approvals, no
  self-grant). The grantee needs an ACTIVE role-mapped binding (no matrix row is used for PII).
- Mask scope `applies_to='PII'`: `customer_name` / `customer_gstin` are masked **on screen and in exports** unless the
  viewer holds an ACTIVE PII_CUSTOMER grant for that action (VIEW = screen, EXPORT = exports) on EVERY company in the
  request (`br10_pii_unmasked`, checked at every call; revocation is immediate). Report responses carry
  `scope.pii_unmasked`.

**OPEN DECISIONS (BR-10, flagged, not resolved):**
9. (021) Who authorises PII access is CLIENT-UNCONFIRMED: built as STANDARD (SYSTEM_ADMIN of the grantee company)
   + CROSS_COMPANY for another company — not the FINANCIAL authoriser and no dedicated PII authority.
10. (021) Multi-company requests unmask only if PII is granted for every requested company (all-or-nothing).
11. (021) PII set = customer name + GSTIN only; contact details, addresses and email are not in any BR-10 report today.
12. Still open from the reconciliation: role-catalogue/matrix approval layer, grant expiry + justification,
    run/export evidence (hashes, failed runs), data-quality register, column allow-lists (plus §4g item 7).
1. Role naming: R_MGMT_COMPANY and R_MGMT_GROUP both map to MANAGEMENT (the group difference
   is only the cross-company grant). R_AUDITOR has no existing role_code and **cannot be bound**.
   STORES_QUALITY and EXTERNAL_COORD have no R_* code, so they get no BR-10 access.
2. Permission matrix gaps (built verbatim, deny-by-default): R_MGMT_COMPANY has no PROCUREMENT
   row, R_FINANCE_EXEC has no OPERATIONS row, and no role has an inventory-specific class
   (INVENTORY_POSITION is under PROCUREMENT).
3. FINANCIAL_GRANT / CROSS_COMPANY_GRANT authoriser roles (P06/P07) are unassigned. The AUDIT
   class uses the FINANCIAL authoriser.
4. Margin basis (P10): the provisional formula excludes labour, stock issued and freight; it is
   UNVERIFIED.
5. Masking / retention policy (P07/10C-08): only a minimal PII set is masked on export
   (customer name, GSTIN, audit filters); there is no retention rule.
6. Aging buckets (NOT_DUE / 1-30 / 31-60 / 61-90 / 90+) are not client-confirmed.
7. Not built: REVIEW action / review action items (10C-06), KPI alerts and escalation
   recipients (10C-03/04, P11), review cadence (10C-05, P12), KPI validation workflow
   (10C-10, P13; all reports stay `kpi_status=DRAFT`), scheduled historical extracts (10A-08).
8. Supplier-level KPIs and lead time stay null (SUPPLIER_MASTER_PENDING / DRAFT: 10B-02/08).

## 4h. BR-11 (Sales & Supply: enquiry → quote → SO → reserve → outward → POD → billing → closure) — migrations 018/019, src/modules/br11

Built + live-tested. Source: BR-11 Rev01 package (10 Nov 2026, CLIENT REVIEW / NOT APPROVED: 29
accepted recommendations + 11B-02 "Suggest"; `~/Downloads/BR11_Rev01_Complete_Package.zip`). **The
package's SQL was NOT applied**: it targets doc schemas (`br08_invoice_drafts`, `br08_invoice_accounting_posts`,
`br06_supplier_po_lines`, a `purchase_purpose` CHECK) that do not exist here. 018 is reconciled against the
live schema (header of 018 has the mapping table). 019 = Prisma relation fix (same pattern as 004/010).
- **Ownership:** BR-11 owns only sale orders + fulfilment records. Stock = fdn_* ledger via InventoryService;
  supplier PO = BR-06; invoice/receipt/credit note = BR-08; audit = `activity_audit_log`. No BR-11 counter,
  ledger, billing-handoff or procurement-link table (the doc's `br11_billing_handoffs` /
  `br11_sales_procurement_links` / `br11_company_document_counters` / `br11_audit_events` were dropped as
  duplicates). BR-11 never writes `service_jobs` (11C-01); a sold unit back for repair = new BR-02 JIN/Job.
- **Numbering:** shared `company_number_counters` (number_kind widened to varchar(6)): `SE-`, `SQ-`, `SO-`,
  `SOUT-<CODE>-000001`, continuous, no FY reset (11A-08, 11C-05). SO number assigned at verification.
- **Roles:** SALES = enquiry, quote send + customer responses, draft SO + authorisation evidence, change
  requests. PURCHASE = priced quote revisions (create/issue), SO verification (11B-01), order payment terms,
  reservations, sourcing + SALES_ORDER PO, outward/pick/dispatch/POD, change-request decisions, closure.
  FINANCE = advance confirmation against a BR-08 receipt, product invoices. SYSTEM_ADMIN = policy config.
  All checked by RolesGuard AND by `br08_has_role` in the DB triggers.
- **Products** = `fdn_item_master` items (APPROVED/ACTIVE at quote issue + invoice), never `assemblies`
  (customer equipment, 11A-04). Prices are integer paise pre-tax, typed by Purchase; SO lines snapshot the
  issued quote line (Sales cannot send a price). Issued revisions + lines and verified SO lines are immutable.
- **Reservation (11B-04/05):** request → `fdn_reserve` (ref `BR11_SALES_RESERVATION`) → CONFIRMED; the DB
  verifies CONFIRMED against the real ledger row. Idempotent on the client `Idempotency-Key`. Outward ships
  ONE whole reservation per line (ledger can't partially decrement — same as BR-07). Dispatch posts
  `fdn_post_movement` ISSUE MAIN_STORE → (no destination) ref `BR11_SALE_ISSUE`, then consumes the reservation.
  Dispatch needs pick verification + a packing PHOTO per line (11C-02), pre-checked before any ledger post.
- **Statuses are derived:** POD evidence → line/order PART_DELIVERED/DELIVERED; approved CANCELLATION → CANCELLED;
  closure review → CLOSED. Direct status updates are rejected by trigger.
- **BR-06 SALES_ORDER:** `br06_supplier_purchase_orders.purchase_purpose` ADDED (default CUSTOMER_JOB; the
  column/constraint did not exist) + `br06_po_purpose_source_check`; repair columns relaxed to purpose-conditional.
  `br06_sales_sourcing_authorisations` (one exact SO line, offer + comparison evidence, rank; rank>1 needs MD
  evidence like BR-04). PO lines = offer XOR sourcing authorisation (`br06_po_line_source_check`). Same PO series,
  release, GRN and ledger receipt. Repair PO path unchanged.
- **BR-08 PRODUCT_SALES:** `br08_invoices.invoice_type` ADDED (REPAIR default). `br08_sales_invoice_sources` +
  `br08_invoice_sales_lines`; `br08_issue_sales_invoice` inserts into the SAME `br08_invoices` (Finance-only,
  INV series, immutability, GST maths, receipts, allocations, INVOICE_CORRECTION credit note). Repair job/lines
  cannot attach to a product invoice. Issue is idempotent on `Idempotency-Key`. `br08_check_invoice_totals`
  replaced with a type branch (REPAIR branch unchanged).
- **Closure (11C-09):** Purchase; DB computes every flag: all live lines POD-delivered = invoiced = accepted,
  ≥1 live invoice, and all invoices PAID if policy requires.

**CLIENT-UNCONFIRMED (hook built, unconfigured = BLOCKED, never defaulted):**
- 11C-07 invoice trigger — `br11_company_policies.invoice_trigger` (ADVANCE / DISPATCH / DELIVERY; MILESTONE has
  no schedule model and stays blocked). Unset ⇒ product invoicing blocked.
- 11C-09 payment before closure — `requires_full_payment_for_closure`. Unset ⇒ closure blocked.
- P-12 product GST — `br08_gst_rate_config` row `quote_line_type='PRODUCT_SALE'` (unseeded; NO fallback to the
  repair SAC 998732). HSN = item `hsn_tax` if valid, else the config HSN. One rate for all products.
- 11B-02 advance — NO blanket advance. Per-order `br11_order_payment_conditions` (NOT_REQUIRED / FIXED_AMOUNT /
  PERCENTAGE / FULL + evidence). No terms ⇒ reservation and sourcing blocked; required advance ⇒ Finance must link
  a BR-08 receipt covering `required_amount_paise` (Purchase enters it from the terms; no % basis is computed).
- 11A-05 discount/margin bands — not enforced; BR-04's 10% rule NOT applied. `list_unit_price_paise` is display only.
The integrity suite sets these temporarily and restores them afterwards.

**OPEN DECISIONS (BR-11, flagged, not resolved):**
1. Outward / pick / packing / POD / tracking built as PURCHASE (mirrors BR-08 dispatch); Stores may need them.
   Reservation requests also PURCHASE only.
2. No saleable flag on `fdn_item_master` (only `fdn_assembly_master.saleable`, which the ledger can't stock):
   any APPROVED/ACTIVE item can be sold.
3. Supplier master: `supplier_id` (fdn_suppliers) optional, supplier name snapshot required — no supplier
   approval flow exists (same as repair PO). MD approver for non-L1 is any employee (role not validated, like BR-04).
4. GRN for a SALES_ORDER PO goes to general MAIN_STORE stock; it is not auto-reserved for that order.
5. Change requests: only APPROVED CANCELLATION changes data, and only if nothing is shipped, invoiced, reserved or on
   a live supplier PO (P-05 thresholds/refunds pending). PRICE/QTY/SUBSTITUTION/etc. are recorded decisions only —
   a new quote revision + order is required. No maker-checker between requester and decider.
6. Short delivery (POD qty < shipped) and FAILED/DAMAGED records have no follow-up path; such a line never reaches
   DELIVERED, so the order cannot close. Commercial sales returns / product warranty credit are undefined
   (11C-10, P-13): WARRANTY_FAILURE credit notes stay repair-only; product invoices use INVOICE_CORRECTION.
7. Closure "reconciled" interpreted as delivered = invoiced = accepted on every live line.
8. A SO must use the latest ISSUED, unexpired revision (checked at creation and verification). One SO per invoice.
9. Advance receipt reuse: a BR-08 receipt can back several orders' advances only up to its amount. Recorded terms are
   immutable (no amendment path).
10. Intercompany transfers (11B-07, P-14), reminder cadence (11C-08, P-06), BR-10 sales MIS report: not built.
11. Number formats `SE/SQ/SO/SOUT-<CODE>-000001` follow the house convention; the doc proposed 7 digits.

## 4i. Frontend lookups + uploads — migrations 022/023, src/modules/uploads (+ BR-02/BR-03/Masters reads)

Additive read endpoints for gaps found building the Engineer UI (12 Nov 2026). No existing table changed;
existing routes behave as before (two gained optional data: `search` param, `reviews[]` field). Tests:
`test/lookups.e2e-spec.ts`.
- G1 `GET /my-jobs?status=` (ENGINEER): jobs whose CURRENT assignment is the caller (incl. PENDING custody), with
  JIN, unit n of m, serial/make/model and the `assemblies` name. CRITICAL→URGENT→NORMAL, newest first, max 500.
- G4 `POST /uploads` (multipart, field `file`, any role) → `file_uri = /api/uploads/<id>`; `GET /uploads/:id` streams
  bytes to the same company only. Types: jpeg/png/webp/heic/heif/mp4/mov/pdf; declared type must match the bytes
  (no SVG/HTML). `file_uploads` (022) is append-only + uploader-in-company trigger; bytes on disk under `UPLOAD_DIR`
  (default `./storage/uploads`, git-ignored), `UPLOAD_MAX_BYTES` default 25 MB. Existing media endpoints still accept
  ANY `file_uri` — they do not require an upload row.
- G9 `GET /inspection-reports/:id/media`. There is NO BR-07 media table, so no repair equivalent exists.
- G10 `GET /material-requests/:id/catalogue?search=&limit=`: bridge rows the line trigger accepts (APPROVED + active)
  with `item_bridge_id` + the Item Master row.
- G13 `GET /jobs/:id/inspection-report` now also returns `reviews[]` (Purchase ACCEPT/RETURN + comment).
- G5 `GET /masters/items?search=` (optional; without it the query is unchanged).

**OPEN DECISIONS (lookups, flagged, not resolved):**
1. ~~Bridge has no writer~~ — addressed by migration 023 (below), with CLIENT-UNCONFIRMED rules.
2. Uploaded files live on the API host's disk; no retention/backup/virus-scan policy, no object storage.
3. Media endpoints don't verify that `file_uri` points at a `file_uploads` row of the same company (would change
   existing behaviour).

**Migration 023 — Item Master → catalogue bridge sync (12 Nov 2026):**
- `trg_br03_sync_item_bridge` (AFTER INSERT / UPDATE OF status, standard_name, base_uom on `fdn_item_master`) upserts
  the item's `br03_item_catalog_bridge` row (code, name, UOM, status). The trigger is the ONLY writer of the bridge;
  never insert bridge rows by hand (test fixtures read the synced row via `bridge()` in `test/helpers.ts`).
- Existing items were backfilled. The bridge now has the FK `br03_item_catalog_bridge_item_fk → fdn_item_master(id)`.
- Bridge rows are never deleted (many tables reference them); a de-listed item's row becomes `INACTIVE`.
- Changing an item's `base_uom` updates the bridge UOM, so an existing material line with the old `uom_snapshot`
  can no longer be edited (the line trigger compares them). Changing UOM on a live item is a BR-01B governance question.

**CLIENT-UNCONFIRMED (built with developer defaults; Brightech must confirm — same pattern as DOFA/authorities):**
1. **Status mapping** (mirrors the ledger's APPROVED/ACTIVE rule, `br03_bridge_status_for()`): Item Master
   APPROVED/ACTIVE → bridge APPROVED (requestable); DRAFT/UNDER_REVIEW → PENDING_APPROVAL (not yet);
   ON_HOLD/INACTIVE/SUPERSEDED → INACTIVE + `is_active=false` (not requestable). Bridge REJECTED is never produced.
2. **Whole-number quantities only:** synced rows get `allows_fraction=false`, `qty_precision=0`. Item Master has no
   fraction/precision field; adding one needs **BR-01B owner sign-off** (then a migration + sync change). The sync
   never overwrites these two columns on an existing row.
3. **No "request a new item" workflow:** an uncatalogued part is handled outside the system — the engineer asks
   Purchase, Purchase creates + approves it in the Item Master, and it syncs. The UI shows an empty-catalogue note
   ("Part not listed? Ask Purchase to add it to the Item Master.").

**Purchase desk reads — migration 024, src/modules/purchase-desk (13 Nov 2026):** additive read endpoints for the
Purchase UI (G14–G22, B-1..B-3, C1-1, C2-1/2). Tests: `test/purchase-reads.e2e-spec.ts`. 024 only adds 3 indexes on
`activity_audit_log` (it had none; the overview and job last-activity read it). All company-scoped from the token.
- Every list/lookup is paginated: `?page=1&page_size=25` (max 100) + `search` → `{ rows, total, page, page_size }`.
  Enum filters take comma-separated DB values (`status=REGISTERED,VERIFYING`). Unknown params are 400.
- `GET /inward-receipts` (PURCHASE, MANAGEMENT): status, priority, `month=YYYY-MM` (receipt_at, company tz), search
  (JIN, customer, DC no.). Rows add customer_name/code, groups_count, units_received (Σ group qty), units_total, units_verified.
- `GET /jobs` (PURCHASE, MANAGEMENT): status, priority, `engineer_id=<uuid>|unassigned`, search (job, JIN, serial,
  make, model, assembly, customer). Rows add JIN, unit n of m, equipment, customer, current engineer id/name, response,
  `last_activity_at` = latest of job/assignment timestamps and audit rows whose entity_id or top-level after_state.job_id is the job.
- `GET /rfqs` (PURCHASE only, like `/rfqs/:id`): status, job_id, search; job_id/job_number + lines/invites/offers counts, no prices.
  `GET /rfqs/:id` gained `job_id`, `job_number`, `sources[]` (shortage → stock-check line → stock check → MR) and
  `item_code`/`item_name` on lines.
- `GET /quotes` (PURCHASE, MANAGEMENT): status (matched on the LATEST revision), job_id, search; latest revision status +
  revised_pre_tax/tax/freight. No reference/procurement offer ids.
- `GET /lookups/customers` (PURCHASE, SALES; default status PENDING_APPROVAL,APPROVED; no contact/GST fields),
  `/lookups/engineers` (PURCHASE; active ENGINEERs + open_jobs/pending_custody), `/lookups/employees?role=` (PURCHASE;
  active), `/lookups/assemblies` (PURCHASE; the shared `assemblies` table, not fdn_assembly_master),
  `/lookups/custody-locations` (PURCHASE; active), `/lookups/item-bridge` (PURCHASE; ids or search required). All take `ids=`.
- `GET /equipment-units/:id/photos` (any role in the company, like the receipt detail). `GET /inward-receipts/:id` units
  gained `job_id`/`job_number` (null before verification).
- `PATCH /equipment-units/:id` (PURCHASE): serial_number, observed_make/model, reported_fault, physical_condition,
  accessories; only while verification_status is PENDING/ON_HOLD; audit `BR02_UNIT_DETAILS_UPDATED` (changed fields only).
- `GET /jobs/:id/progress` (PURCHASE, MANAGEMENT): 10 derived stages (ASSIGNED, CUSTODY, INSPECTION, REPORT_REVIEW, MATERIAL,
  QUOTE, AUTHORISATION, PO_GRN, REPAIR_TEST, DISPATCH_INVOICE), each with status done/current/pending/blocked, `at`,
  `source` and its exact `rule` (also in job-progress.service.ts), plus every job_assignments row with names.
  Current = first not-done stage after the last done one; blocked = that stage while the job is ON_HOLD/CANCELLED, or
  REPAIR_TEST after a BR-07 STOP. QUOTE "sent" comes from the BR04_QUOTE_SENT audit row (revisions have no sent_at).
- `GET /overview/purchase` (PURCHASE, MANAGEMENT; read-only tx; "today"/week in the active calendar's timezone, default
  Asia/Kolkata): verify_units {awaiting = PENDING units, receipts_with_pending_units, verified_today}; assign_engineers
  {unassigned = open jobs with no current assignment, assigned_today = assignment rows incl. reassignments};
  review_reports {awaiting_review = SUBMITTED, returned = RETURNED, reviewed_today = ACCEPT/RETURN reviews};
  jobs_by_status (open statuses, zeros included); engineer_workload (active engineers, max 50) + engineers_total;
  intake_this_week Mon–Sat {units_received = Σ group qty of JINs received that day, units_verified}; latest_activity
  (10 audit rows, actor name, no before/after state). Raw counts only — no targets/denominators.
- OpenAPI name collisions fixed (schemas are keyed by class name; runtime unchanged): BR-04 `QuoteLineDto` →
  `RepairQuoteLineDto`, BR-05 `QuoteResponseDto` → `RepairQuoteResponseDto`, inventory `ReserveDto` →
  `InventoryReserveDto`, BR-09 `AuthorityStatus` → `SupportAuthorityStatus` (BR-10/11 keep the old names).

**OPEN DECISIONS (Purchase desk reads, flagged, not resolved):**
1. Unit details editable only before verification (PENDING/ON_HOLD); after a Job ID exists there is no correction path.
2. List roles kept no wider than the matching detail reads: register/jobs/quotes = PURCHASE + MANAGEMENT, RFQs = PURCHASE.
   Sales has no quote list (may need one scoped to quotes released to them); job progress excludes ENGINEER/SALES.
3. `inward_receipts.receipt_status` is never advanced by any API (always REGISTERED); the register shows it as stored.
4. Job progress has no "skipped" state: a stage with no record (e.g. no supplier PO because stock covered it, or
   no material for NO_FAULT_FOUND) shows `pending`. PO_GRN done needs every non-cancelled job PO to have a GRN.
5. Overview intake week is fixed Mon–Sat (client calendar); Sunday receipts are not shown.
6. Not built: G23 notifications, G24 global search, RFQ history/cancel/COMPARED (C2-3..5).

**Job-tab gaps — migration 025 (data only) + reads (14 Nov 2026):** found smoke-testing the Purchase job tabs. Tests in
`test/flow.e2e-spec.ts` (BR-05 / BR-06 / BR-07 sections).
- `GET /jobs/:id/material-requests` (PURCHASE, MANAGEMENT): the job's MRs newest first with lines + change requests.
  Lines add `item_code`/`item_name` and `fulfilment` {allocatable_now = ledger `fdn_allocatable(company, item)` (the
  BR-04/BR-05 read, company-wide), reserved_quantity = Σ COMMITTED BR-05 reservations of the line's recheck lines,
  issued / consumed / returned_quantity = Σ BR-07 issues made from those reservations}. Read time only; nothing stored.
  Replaces the inbox filter + per-MR fetch the UI used. `GET /material-requests` is unchanged.
- `GET /jobs/:id/quote-responses` and `/jobs/:id/order-allocations` rows add `source_br04_quote_revision_id`
  (= br05_quote_revision_refs.source_br04_quote_id), `quote_id`, `quote_number`, `revision_no` (0-based, as stored).
  The existing `quote_revision_id` / `accepted_quote_revision_id` are BR-05 ref ids, NOT BR-04 revision ids.
- `GET /quotes/:id` revisions add `assigned_sales_id`, `released_to_sales_by_id`, `released_to_sales_at` from
  `br04_quote_sales_handoffs` (null until that revision is released). Names via `/lookups/employees`.
- **PO → RECEIVED (rule CONFIRMED by the product owner 14 Nov 2026, "all qty posted"):** `POST /grn-lines/:id/post`
  moves an ACKNOWLEDGED / SHIPPED PO to RECEIVED once EVERY PO line has posted GRN quantity (accepted + rejected +
  held, all GRNs) >= ordered quantity; same transaction as the disposition, PO row locked, audit `BR06_PO_RECEIVED`.
  Partial receipts leave the status unchanged. A RECEIVED PO takes no further GRN (createGrn already required
  ACKNOWLEDGED/SHIPPED). `CLOSED` is still never set (no rule). Migration 025 applies the rule once to POs that were
  already fully posted (audit `BR06_PO_RECEIVED_BACKFILL`, actor NULL); idempotent, no schema change.

## 4e. Working calendar — migration 012, src/modules/calendar

Client-confirmed: both companies Mon–Sat; Mon–Fri 09:30–18:30, Sat 09:30–16:00; lunch
13:30–14:15 excluded; holidays added by SYSTEM_ADMIN as announced (no preset list).
- `working_calendar_day_rules` (per ISO weekday, with break) is authoritative; one active
  calendar per company; `cal_seed_client_calendar()` seeds it (migration + dev seed).
- `cal_add_working_minutes` (lunch/Sunday/holidays count zero) and `cal_add_working_days`
  (same clock time on the Nth next working day †, start normalised to the next working
  instant, clamped to the target day's close — e.g. Fri 17:00 + 1 day = Sat 16:00).
- Wired: BR-03 edit-lock = `br03_self_edit_deadline()` (1 working hour); BR-07 test-start SLA.
- Only FUTURE holidays can be removed (DB trigger). API: `GET /calendars/current`,
  `GET /calendars/working-time`, `POST /calendars/holidays`, `POST /calendars/holidays/:id/remove`.

## 5. Blockers — do NOT build past BR-03 without these

From the integration audit (31 Oct 2026). These are missing/unconfirmed; building on
them = rework:
- **BR-01 canonical masters not delivered:** real Item Master, Supplier Master,
  Customer Contact Master. BR-03 uses a *bridge/status cache*, not the authoritative
  table. Get the real master schemas before BR-04/05 writes.
- **Inventory/stock ledger not delivered.** Every "stock check" in BR-04/05 is a
  *snapshot that posts nothing*. No committed reservation exists. Needs BR-06.
- ~~Working calendars unset~~ — RESOLVED 5 Nov 2026 (migration 012, §4e). Holidays still
  need to be entered by an admin as they are announced.
- **Supplier-PO financial authority (DOFA) unset.** Keep supplier-PO release blocked.
- **Quote total composition** (fee/freight/partial-sum rules) pending sign-off.

## 6. Confirmed commercial decisions (for when BR-04/05 unblock)
- Pricing: no formula; Purchase picks any supplier quote as reference, applies any %,
  **types final customer price manually**. Store reference + procurement offer; hide
  supplier cost from customer.
- Valid supplier quote: Purchase marks valid manually (supplier only quotes what was asked).
- Assembly quotation: **full component breakup** shown to customer.
- RFQ: **separate enquiry per job** (no cross-job grouping).
- Invoice after customer PO, travels with material at delivery; **30-day credit**
  (per-customer, default 30); dispatch allowed before payment.
- Masters: quotation allowed on Pending customer/assembly; **invoice blocked** until
  both are Approved. Customer authority = PO **or** Job Order **or** verified email.

**OPEN DECISION — discount ceiling conflict (flagged, not resolved):**
`br04_customer_quote_revisions` (migration 001, constraint `..._check4`) blocks any
quote revision more than 10% below the original authorised price unless an explicit
`higher_discount_approved_by_id` + `higher_discount_approved_at` + `higher_discount_reason`
is recorded. That 10% figure comes from the migration-001 *draft* schema (file marked
"NOT APPROVED / CLIENT REVIEW / DEVELOPER PROPOSAL") and conflicts with the pricing
rule above — "applies any %" implies no fixed threshold. The BR-04 API (`reviseQuote`)
does **not** auto-fill the approval fields; it requires the caller to explicitly supply
an approver + reason, and returns a clear 400 if a >10% discount is attempted without
them — but it does not decide whether the threshold itself should exist. Confirm with
Brightech whether to (a) keep the 10% gate with a real second-approver role, or
(b) drop the constraint entirely to match "no fixed threshold." Until confirmed, a
revision below -10% is blocked unless Purchase names an explicit approver (who is
currently not validated for any particular role/authority).

## 7. Conventions
- `/api` global prefix. DTO validation on every input. snake_case in DB, camelCase in TS
  (Prisma maps it). Timestamps in UTC. Money in integer paise or `numeric` — match the schema.
- Put a `who/when/before/after` audit row on every significant write (audit table exists).
