import { randomUUID } from 'crypto';
import { Client } from 'pg';
import {
  api, balances, createItem, db, dbRejects, Fixtures, fails, idem, ok, otherCompany, setupFixtures,
} from './helpers';

/**
 * Foundation ledger invariants (fdn_post_movement / fdn_reserve via /api/inventory).
 * A fresh item per run means every balance starts at exactly 0.
 */
describe('Inventory ledger integrity', () => {
  let c: Client;
  let f: Fixtures;
  let item: string;
  const ref = randomUUID();

  const post = (path: string, body: object, key = idem()) =>
    api('post', `/inventory/${path}`, f.purchase, body, { 'Idempotency-Key': key });
  const base = () => ({ company_id: f.companyId, item_id: item, uom: 'NOS', reference_id: ref });

  beforeAll(async () => {
    c = await db();
    f = await setupFixtures(c);
    item = await createItem(f.purchase, true, 'ledger');
  });
  afterAll(() => c?.end());

  it('receipt -> issue -> consume balances exactly (stock is conserved)', async () => {
    ok(await post('receipts', { ...base(), qty: 10, to_location_id: f.loc.MAIN_STORE }));
    ok(await post('issues', { ...base(), qty: 4, from_location_id: f.loc.MAIN_STORE, to_location_id: f.loc.ENGINEER_HELD }));
    ok(await post('consumptions', { ...base(), qty: 3, from_location_id: f.loc.ENGINEER_HELD, to_location_id: f.loc.CONSUMED }));

    const b = await balances(f.companyId, item, f.purchase);
    expect(b).toMatchObject({ main: 6, held: 1, consumed: 3, allocatable: 6 });
    expect(b.main + b.held + b.consumed).toBe(10);
  });

  it('idempotent retry with the same key does not double-post', async () => {
    const key = idem();
    const body = { ...base(), qty: 2, to_location_id: f.loc.MAIN_STORE };
    const first = ok(await post('receipts', body, key));
    const retry = ok(await post('receipts', body, key));

    expect(retry.transaction_id).toBe(first.transaction_id);
    expect((await balances(f.companyId, item, f.purchase)).main).toBe(8); // 6 + 2, not 6 + 4
    const journal = (await c.query(
      `SELECT count(*)::int AS n FROM fdn_inventory_journal WHERE idempotency_key=$1`, [key],
    )).rows[0].n;
    expect(journal).toBe(1);
  });

  it('oversell is blocked with 409 and leaves balances untouched', async () => {
    const before = await balances(f.companyId, item, f.purchase);
    fails(await post('issues', {
      ...base(), qty: before.main + 1, from_location_id: f.loc.MAIN_STORE, to_location_id: f.loc.ENGINEER_HELD,
    }), 409, /INSUFFICIENT_STOCK/);
    fails(await post('consumptions', {
      ...base(), qty: before.held + 1, from_location_id: f.loc.ENGINEER_HELD, to_location_id: f.loc.CONSUMED,
    }), 409, /INSUFFICIENT_STOCK/);
    expect(await balances(f.companyId, item, f.purchase)).toEqual(before);
  });

  it('reservation drops allocatable but not on-hand; over-reserve is 409', async () => {
    const before = await balances(f.companyId, item, f.purchase); // main 8, allocatable 8
    const r = ok(await post('reservations', { ...base(), qty: 5 }));
    expect(r.allocatable_after).toBe(before.allocatable - 5);

    const after = await balances(f.companyId, item, f.purchase);
    expect(after.main).toBe(before.main);
    expect(after.allocatable).toBe(before.allocatable - 5);

    fails(await post('reservations', { ...base(), qty: after.allocatable + 1 }), 409, /INSUFFICIENT_STOCK/);
  });

  it('unapproved (DRAFT) items cannot be transacted', async () => {
    const draft = await createItem(f.purchase, false, 'draft');
    fails(await post('receipts', { ...base(), item_id: draft, qty: 1, to_location_id: f.loc.MAIN_STORE }),
      400, /MISSING_ITEM_APPROVAL/);
  });

  it('journal is append-only at the DB layer', async () => {
    const msg = await dbRejects(c, `UPDATE fdn_inventory_journal SET qty=qty+1 WHERE item_id=$1`, [item]);
    expect(msg).toMatch(/append_only/);
  });

  it('company scoping: a company-A user passing company B\'s id gets 403 on every company_id endpoint', async () => {
    const companyB = await otherCompany(c);
    expect(companyB).not.toBe(f.companyId);
    const asB = () => ({ ...base(), company_id: companyB });
    const journalB = async () => (await c.query(
      `SELECT count(*)::int n FROM fdn_inventory_journal WHERE company_id=$1`, [companyB])).rows[0].n;
    const before = await balances(f.companyId, item, f.purchase);
    const journalBefore = await journalB();

    // Body company_id: all six ledger writes.
    const moves: [string, object][] = [
      ['receipts', { qty: 1, to_location_id: f.loc.MAIN_STORE }],
      ['reservations', { qty: 1 }],
      ['issues', { qty: 1, from_location_id: f.loc.MAIN_STORE, to_location_id: f.loc.ENGINEER_HELD }],
      ['consumptions', { qty: 1, from_location_id: f.loc.ENGINEER_HELD, to_location_id: f.loc.CONSUMED }],
      ['returns', { qty: 1, from_location_id: f.loc.ENGINEER_HELD, to_location_id: f.loc.MAIN_STORE }],
      ['supplier-returns', { qty: 1, from_location_id: f.loc.QUARANTINE, to_location_id: f.loc.SUPPLIER_RETURN }],
    ];
    for (const [path, extra] of moves) {
      fails(await post(path, { ...asB(), ...extra }), 403, /company_id does not match/);
    }
    // Query company_id: both reads.
    fails(await api('get', `/inventory/availability?company_id=${companyB}&item_id=${item}`, f.purchase), 403);
    fails(await api('get', `/inventory/journal?company_id=${companyB}`, f.purchase), 403);
    // Repeated query param can't smuggle B in next to A.
    fails(await api('get', `/inventory/journal?company_id=${f.companyId}&company_id=${companyB}`, f.purchase), 403);

    // Nothing was written anywhere, and company A's balances are untouched.
    expect(await journalB()).toBe(journalBefore);
    expect(await balances(f.companyId, item, f.purchase)).toEqual(before);

    // Control: the identical request with the user's own company still succeeds.
    ok(await post('receipts', { ...base(), qty: 1, to_location_id: f.loc.MAIN_STORE }));
    expect((await balances(f.companyId, item, f.purchase)).main).toBe(before.main + 1);
  });

  // Security fix (19 Nov 2026): master approval and stock-movement writes had NO role check. RolesGuard runs before the
  // service, so a non-Purchase role is 403 even for an unknown id, while Purchase reaches the service (404).
  describe('role guards: approval + stock-movement writes are PURCHASE-only', () => {
    const NON_PURCHASE = () => [
      ['ENGINEER', f.engineer], ['SALES', f.sales], ['STORES_QUALITY', f.stores], ['FINANCE', f.finance], ['MANAGEMENT', f.mgmt],
    ] as const;

    it('item approval: every non-Purchase role is 403 and the item stays DRAFT; Purchase approves it', async () => {
      const draft = await createItem(f.purchase, false, 'guard-item');
      for (const [role, actor] of NON_PURCHASE()) {
        const r = await api('post', `/masters/items/${draft}/approve`, actor);
        expect([role, r.status]).toEqual([role, 403]);
      }
      expect((await c.query(`SELECT status FROM fdn_item_master WHERE id=$1`, [draft])).rows[0].status).toBe('DRAFT');
      expect(ok(await api('post', `/masters/items/${draft}/approve`, f.purchase)).status).toBe('ACTIVE');
    });

    it('assembly approval: every non-Purchase role is 403; Purchase passes the guard (404 for an unknown id)', async () => {
      const unknown = randomUUID();
      for (const [role, actor] of NON_PURCHASE()) {
        const r = await api('post', `/masters/assemblies/${unknown}/approve`, actor);
        expect([role, r.status]).toEqual([role, 403]);
      }
      fails(await api('post', `/masters/assemblies/${unknown}/approve`, f.purchase), 404);
    });

    it('every inventory write is 403 for non-Purchase roles and posts nothing', async () => {
      const before = await balances(f.companyId, item, f.purchase);
      const journal = async () => Number((await c.query(
        `SELECT count(*) FROM fdn_inventory_journal WHERE item_id=$1`, [item])).rows[0].count);
      const j0 = await journal();
      const writes: [string, object][] = [
        ['receipts', { ...base(), qty: 1, to_location_id: f.loc.MAIN_STORE }],
        ['reservations', { ...base(), qty: 1 }],
        ['issues', { ...base(), qty: 1, from_location_id: f.loc.MAIN_STORE, to_location_id: f.loc.ENGINEER_HELD }],
        ['consumptions', { ...base(), qty: 1, from_location_id: f.loc.ENGINEER_HELD, to_location_id: f.loc.CONSUMED }],
        ['returns', { ...base(), qty: 1, from_location_id: f.loc.ENGINEER_HELD, to_location_id: f.loc.MAIN_STORE }],
        ['supplier-returns', { ...base(), qty: 1, from_location_id: f.loc.QUARANTINE, to_location_id: f.loc.SUPPLIER_RETURN }],
      ];
      for (const [path, body] of writes) {
        for (const [role, actor] of NON_PURCHASE()) {
          const r = await api('post', `/inventory/${path}`, actor, body, { 'Idempotency-Key': idem() });
          expect([path, role, r.status]).toEqual([path, role, 403]);
        }
      }
      expect(await journal()).toBe(j0);
      expect(await balances(f.companyId, item, f.purchase)).toEqual(before);
    });
  });
});
