import { Client } from 'pg';
import request from 'supertest';
import { createHash } from 'crypto';
import {
  api, BASE, bridge, createItem, db, employeeIn, Fixtures, fails, ok, otherCompany, RUN, setupFixtures, tokenFor,
} from './helpers';

/**
 * Read/lookup endpoints added for the frontend (gaps found building the Engineer UI):
 *   G1  GET /my-jobs                              G9  GET /inspection-reports/:id/media
 *   G4  POST /uploads + GET /uploads/:id          G10 GET /material-requests/:id/catalogue
 *   G5  GET /masters/items?search=                G13 reviews[] on GET /jobs/:id/inspection-report
 * One job is driven BR-02 -> BR-03 through the live API; the new reads are asserted against it.
 */
describe('Frontend lookups (G1 / G4 / G5 / G9 / G10 / G13)', () => {
  let c: Client;
  let f: Fixtures;
  let otherEngineer: string;   // same company, not assigned
  let foreignPurchase: string; // company B
  const s: Record<string, any> = {};
  const P = () => f.purchase;
  const E = () => f.engineer;

  // 1x1 PNG
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const upload = async (actorId: string | null, buf: Buffer, filename: string, contentType: string) => {
    let r = request(BASE).post('/uploads');
    if (actorId) r = r.set('Authorization', `Bearer ${await tokenFor(actorId)}`);
    return r.attach('file', buf, { filename, contentType });
  };

  beforeAll(async () => {
    c = await db();
    f = await setupFixtures(c);
    otherEngineer = await employeeIn(c, f.companyId, 'ENG', 'ENGINEER', 'B');
    foreignPurchase = await employeeIn(c, await otherCompany(c), 'PUR', 'PURCHASE', 'LK');

    s.item = await createItem(f.purchase, true, `lookup-part`);
    s.draftItem = await createItem(f.purchase, false, `lookup-draft`);
    s.bridgeOk = await bridge(c, s.item, 'APPROVED');
    s.bridgePending = await bridge(c, s.draftItem, 'PENDING_APPROVAL');

    // BR-02: one JIN, 2-unit group, verify unit 1 -> job, assign to the fixture engineer.
    s.jin = ok(await api('post', '/inward-receipts', P(), {
      customer_id: f.customerId, receipt_at: new Date().toISOString(), receipt_channel: 'WALK_IN',
      customer_dc_number: `DC-LK-${RUN}`, priority: 'URGENT', priority_reason: 'lookup suite',
    }));
    const g = ok(await api('post', `/inward-receipts/${s.jin.id}/equipment-groups`, P(), { assembly_id: f.assemblyId, quantity_received: 2 }));
    const ex = ok(await api('post', `/equipment-groups/${g.id}/expand`, P(), { location_id: f.custodyLocationId, custodian_id: f.purchase }));
    s.unit = ex.units[0].id;
    ok(await api('post', `/equipment-units/${s.unit}/photos`, P(), { file_uri: `s3://it/lk-${s.unit}.jpg`, file_name: 'unit.jpg' }));
    s.job = ok(await api('post', `/equipment-units/${s.unit}/verify`, P())).job;
    ok(await api('post', `/jobs/${s.job.id}/assign`, P(), { engineer_id: f.engineer }));
  });
  afterAll(() => c?.end());

  // ============================================================== G1
  describe('G1 GET /my-jobs', () => {
    it('lists the job for the assigned engineer (PENDING custody) with list context', async () => {
      const rows = ok<any[]>(await api('get', '/my-jobs', E()));
      const row = rows.find((r) => r.id === s.job.id);
      expect(row).toBeDefined();
      expect(row.job_number).toBe(s.job.job_number);
      expect(row.current_assignment.engineer_id).toBe(f.engineer);
      expect(row.current_assignment.response).toBe('PENDING');
      expect(row.jin_number).toBe(s.jin.jin_number);
      expect(row.unit_number).toBe(1);
      expect(row.units_in_group).toBe(2);
      expect(row.assembly_id).toBe(f.assemblyId);
      expect(row.assembly_name).toMatch(/^IT Drive /);
      expect(row).not.toHaveProperty('__assignment_id');
    });

    it('status filter narrows; an invalid status is 400', async () => {
      const assigned = ok<any[]>(await api('get', '/my-jobs?status=ASSIGNED', E()));
      expect(assigned.every((r) => r.status === 'ASSIGNED')).toBe(true);
      const closed = ok<any[]>(await api('get', '/my-jobs?status=CLOSED', E()));
      expect(closed.find((r) => r.id === s.job.id)).toBeUndefined();
      fails(await api('get', '/my-jobs?status=NOPE', E()), 400);
      fails(await api('get', '/my-jobs?assignee=someone', E()), 400); // unknown params are rejected, not ignored
    });

    it('only the CURRENT assignee sees it; other roles are 403; no token is 401', async () => {
      const other = ok<any[]>(await api('get', '/my-jobs', otherEngineer));
      expect(other.find((r) => r.id === s.job.id)).toBeUndefined();
      fails(await api('get', '/my-jobs', P()), 403);
      fails(await api('get', '/my-jobs'), 401);
    });
  });

  // ============================================================== G4
  describe('G4 POST /uploads + GET /uploads/:id', () => {
    it('stores a PNG and returns a file_uri; the bytes read back identically', async () => {
      const res = await upload(E(), PNG, 'insp photo.png', 'image/png');
      const up = ok(res);
      expect(res.status).toBe(201);
      expect(up.file_uri).toBe(`/api/uploads/${up.id}`);
      expect(up.content_type).toBe('image/png');
      expect(up.size_bytes).toBe(String(PNG.length));
      expect(up.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
      expect(up).not.toHaveProperty('storage_key');
      s.upload = up;

      const got = await request(BASE).get(`/uploads/${up.id}`).set('Authorization', `Bearer ${await tokenFor(P())}`)
        .buffer(true).parse((r, cb) => { const b: Buffer[] = []; r.on('data', (d: Buffer) => b.push(d)); r.on('end', () => cb(null, Buffer.concat(b))); });
      expect(got.status).toBe(200);
      expect(got.headers['content-type']).toBe('image/png');
      expect(got.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.compare(got.body as Buffer, PNG)).toBe(0);

      const audit = await c.query(`SELECT count(*)::int n FROM activity_audit_log WHERE entity_table='file_uploads' AND entity_id=$1 AND action='FILE_UPLOADED'`, [up.id]);
      expect(audit.rows[0].n).toBe(1);
    });

    it('rejects content that does not match the declared type, and unsupported types', async () => {
      fails(await upload(E(), Buffer.from('<html><script>alert(1)</script></html>'), 'x.png', 'image/png'), 400, /does not match/);
      fails(await upload(E(), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg', 'image/svg+xml'), 400, /unsupported file type/);
      fails(await upload(E(), Buffer.alloc(0), 'empty.png', 'image/png'), 400);
    });

    it('needs a token; another company cannot read the file; unknown id is 404', async () => {
      fails(await upload(null, PNG, 'x.png', 'image/png'), 401);
      fails(await api('get', `/uploads/${s.upload.id}`, foreignPurchase), 403);
      fails(await api('get', `/uploads/00000000-0000-4000-8000-000000000000`, E()), 404);
    });

    it('file_uploads is append-only in the DB', async () => {
      const r = await c.query(`SELECT 1`).then(async () => {
        await c.query('BEGIN');
        try { await c.query(`UPDATE file_uploads SET original_name='x' WHERE id=$1`, [s.upload.id]); return ''; }
        catch (e) { return (e as Error).message; } finally { await c.query('ROLLBACK'); }
      });
      expect(r).toMatch(/append-only/);
    });
  });

  // ============================================================== G9 + G13 (+ BR-03 chain)
  describe('G9 media list + G13 review comments', () => {
    it('engineer records custody, inspects, attaches the uploaded photo, submits v0', async () => {
      ok(await api('post', `/jobs/${s.job.id}/custody-ack`, E(), {}));
      const sess = ok(await api('post', `/jobs/${s.job.id}/inspection-sessions`, E()));
      ok(await api('post', `/inspection-sessions/${sess.id}/stop`, E()));
      s.report = ok(await api('post', `/jobs/${s.job.id}/inspection-reports`, E()));
      s.media = ok(await api('post', `/inspection-reports/${s.report.id}/media`, E(), {
        media_type: 'PHOTO', file_uri: s.upload.file_uri, file_name: s.upload.original_name, customer_visible: true,
      }));
      ok(await api('post', `/inspection-reports/${s.report.id}/submit`, E(), {
        inspection_description: 'IGBT shorted', outcome: 'REPAIR_REQUIRED',
      }));
    });

    it('GET /inspection-reports/:id/media lists the photo (any role in the company); other company is 403', async () => {
      for (const actor of [E(), P()]) {
        const rows = ok<any[]>(await api('get', `/inspection-reports/${s.report.id}/media`, actor));
        expect(rows.map((m) => m.id)).toContain(s.media.id);
        const m = rows.find((x) => x.id === s.media.id);
        expect(m.file_uri).toBe(s.upload.file_uri);
        expect(m.customer_visible).toBe(true);
      }
      fails(await api('get', `/inspection-reports/${s.report.id}/media`, foreignPurchase), 403);
      fails(await api('get', `/inspection-reports/00000000-0000-4000-8000-000000000000/media`, E()), 404);
    });

    it("a RETURN's comment reaches the engineer on GET /jobs/:id/inspection-report", async () => {
      ok(await api('post', `/inspection-reports/${s.report.id}/review`, P(), { decision: 'RETURN', comment: `Need a photo of the gate driver ${RUN}` }));
      const rep = ok(await api('get', `/jobs/${s.job.id}/inspection-report`, E()));
      expect(rep.status).toBe('RETURNED');
      expect(rep.reviews).toHaveLength(1);
      expect(rep.reviews[0]).toMatchObject({ review_decision: 'RETURN', review_comment: `Need a photo of the gate driver ${RUN}`, reviewer_id: f.purchase });
      expect(rep.reviews[0].version_id).toBe(rep.versions[0].id);
    });

    it('resubmit + ACCEPT: reviews are ordered and point at their versions', async () => {
      ok(await api('post', `/inspection-reports/${s.report.id}/submit`, E(), {
        inspection_description: 'IGBT shorted; gate driver U7 photo added', outcome: 'REPAIR_REQUIRED', amendment_reason: 'gate driver photo',
      }));
      ok(await api('post', `/inspection-reports/${s.report.id}/review`, P(), { decision: 'ACCEPT' }));
      const rep = ok(await api('get', `/jobs/${s.job.id}/inspection-report`, E()));
      expect(rep.reviews.map((r: any) => r.review_decision)).toEqual(['RETURN', 'ACCEPT']);
      expect(rep.reviews[1].version_id).toBe(rep.versions[1].id);
    });
  });

  // ============================================================== G10
  describe('G10 GET /material-requests/:id/catalogue', () => {
    beforeAll(async () => {
      s.mr = ok(await api('post', `/jobs/${s.job.id}/material-requests`, E(), { priority: 'NORMAL' })).id;
    });

    it('returns APPROVED + active bridge rows with item_bridge_id and the master record; hides PENDING', async () => {
      const rows = ok<any[]>(await api('get', `/material-requests/${s.mr}/catalogue?search=${RUN}&limit=200`, E()));
      const okRow = rows.find((r) => r.item_bridge_id === s.bridgeOk);
      expect(okRow).toMatchObject({ br01_item_id: s.item, uom: 'NOS', master_status: 'ACTIVE' });
      expect(okRow.master_standard_name).toBe(`IT lookup-part ${RUN}`);
      expect(rows.find((r) => r.item_bridge_id === s.bridgePending)).toBeUndefined();
    });

    it('search matches the Item Master name; no match is empty; bad limit / unknown param are 400', async () => {
      const hit = ok<any[]>(await api('get', `/material-requests/${s.mr}/catalogue?search=${encodeURIComponent(`lookup-part ${RUN}`)}`, E()));
      expect(hit.map((r) => r.item_bridge_id)).toEqual([s.bridgeOk]);
      expect(ok<any[]>(await api('get', `/material-requests/${s.mr}/catalogue?search=zz-no-such-${RUN}`, E()))).toEqual([]);
      // LIKE wildcards are literal: '%' must not match everything.
      expect(ok<any[]>(await api('get', `/material-requests/${s.mr}/catalogue?search=%25`, E()))).toEqual([]);
      fails(await api('get', `/material-requests/${s.mr}/catalogue?limit=0`, E()), 400);
      fails(await api('get', `/material-requests/${s.mr}/catalogue?limit=201`, E()), 400);
      fails(await api('get', `/material-requests/${s.mr}/catalogue?foo=1`, E()), 400);
    });

    it('the returned item_bridge_id is accepted by POST /material-requests/:id/lines', async () => {
      const [row] = ok<any[]>(await api('get', `/material-requests/${s.mr}/catalogue?search=${encodeURIComponent(`lookup-part ${RUN}`)}`, E()));
      const line = ok(await api('post', `/material-requests/${s.mr}/lines`, E(), { item_bridge_id: row.item_bridge_id, quantity: 2 }));
      expect(line.uom_snapshot).toBe(row.uom);
    });

    it('company-scoped: another company is 403; unknown request is 404', async () => {
      fails(await api('get', `/material-requests/${s.mr}/catalogue`, foreignPurchase), 403);
      fails(await api('get', `/material-requests/00000000-0000-4000-8000-000000000000/catalogue`, E()), 404);
    });
  });

  describe('023 Item Master -> catalogue bridge sync (CLIENT-UNCONFIRMED rules)', () => {
    const catalogue = async (term: string) =>
      ok<any[]>(await api('get', `/material-requests/${s.mr}/catalogue?search=${encodeURIComponent(term)}`, E()));
    const bridgeRow = async (itemId: string) =>
      (await c.query(`SELECT * FROM br03_item_catalog_bridge WHERE br01_item_id=$1`, [itemId])).rows[0];

    it('an APPROVED item appears in the catalogue; a DRAFT one does not (synced, no manual insert)', async () => {
      const approved = await createItem(P(), true, `sync-approved`);
      const draft = await createItem(P(), false, `sync-draft`);
      const master = (await c.query(`SELECT item_code, base_uom FROM fdn_item_master WHERE id=$1`, [approved])).rows[0];

      const hit = await catalogue(`sync-approved ${RUN}`);
      expect(hit).toHaveLength(1);
      expect(hit[0]).toMatchObject({
        br01_item_id: approved, item_code: master.item_code, uom: master.base_uom,
        allows_fraction: false, qty_precision: 0, master_status: 'ACTIVE',
      });
      expect(await catalogue(`sync-draft ${RUN}`)).toEqual([]);
      expect(await bridgeRow(draft)).toMatchObject({ approval_status: 'PENDING_APPROVAL', is_active: true });
      s.syncDraft = draft;
    });

    it('approving the DRAFT item through the Masters API makes it requestable', async () => {
      ok(await api('post', `/masters/items/${s.syncDraft}/approve`, P()));
      expect((await catalogue(`sync-draft ${RUN}`)).map((r) => r.br01_item_id)).toEqual([s.syncDraft]);
    });

    it('ON_HOLD / INACTIVE / SUPERSEDED de-list the item (row kept, INACTIVE) and block new lines', async () => {
      for (const status of ['ON_HOLD', 'INACTIVE', 'SUPERSEDED']) {
        const item = await createItem(P(), true, `sync-${status.toLowerCase()}`);
        const bridgeId = (await bridgeRow(item)).id;
        await c.query(`UPDATE fdn_item_master SET status=$2 WHERE id=$1`, [item, status]);
        expect(await bridgeRow(item)).toMatchObject({ id: bridgeId, approval_status: 'INACTIVE', is_active: false });
        expect(await catalogue(`sync-${status.toLowerCase()} ${RUN}`)).toEqual([]);
        fails(await api('post', `/material-requests/${s.mr}/lines`, E(), { item_bridge_id: bridgeId, quantity: 1 }), 400);
      }
    });

    it('whole numbers only: a fractional quantity on a synced item is rejected', async () => {
      const [row] = await catalogue(`sync-approved ${RUN}`);
      fails(await api('post', `/material-requests/${s.mr}/lines`, E(), { item_bridge_id: row.item_bridge_id, quantity: 1.5 }), 400);
    });

    it('the bridge now has an FK to fdn_item_master', async () => {
      await expect(c.query(
        `INSERT INTO br03_item_catalog_bridge(br01_item_id,item_code,item_name,uom,approval_status)
         VALUES (gen_random_uuid(),$1,'orphan','NOS','APPROVED')`, [`IT-ORPHAN-${RUN}`],
      )).rejects.toThrow(/br03_item_catalog_bridge_item_fk/);
    });
  });

  // ============================================================== G5
  describe('G5 GET /masters/items?search=', () => {
    it('finds by name within the status; no search keeps the old behaviour', async () => {
      const hit = ok<any[]>(await api('get', `/masters/items?status=ACTIVE&search=${encodeURIComponent(`lookup-part ${RUN}`)}`, E()));
      expect(hit.map((i) => i.id)).toEqual([s.item]);
      // The DRAFT item is not ACTIVE, so an ACTIVE search for it is empty...
      expect(ok<any[]>(await api('get', `/masters/items?status=ACTIVE&search=${encodeURIComponent(`lookup-draft ${RUN}`)}`, E()))).toEqual([]);
      // ...and a DRAFT search finds it.
      expect(ok<any[]>(await api('get', `/masters/items?status=DRAFT&search=${encodeURIComponent(`lookup-draft ${RUN}`)}`, E())).map((i) => i.id)).toEqual([s.draftItem]);
      const plain = ok<any[]>(await api('get', '/masters/items?status=ACTIVE', E()));
      expect(plain.length).toBeLessThanOrEqual(50);
    });

    it('rejects an over-long search; a repeated search param is never a server error', async () => {
      fails(await api('get', `/masters/items?search=${'x'.repeat(101)}`, E()), 400);
      const dup = await api('get', `/masters/items?search=a&search=b`, E());
      expect([200, 400]).toContain(dup.status);
    });
  });
});
