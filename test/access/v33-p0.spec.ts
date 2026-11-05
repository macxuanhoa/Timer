import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const { Pool } = createRequire(import.meta.url)('pg');
// Loopback + a test-only database, never production env (same contract as roles.spec.ts).
const pool = new Pool({ host: '127.0.0.1', port: 55436, database: 'sc305_access', user: 'postgres', password: 'postgres', max: 8 });
const contexts: BrowserContext[] = [];

async function identity() {
  const uid = randomUUID(); await pool.query('insert into auth.users(id) values($1)', [uid]); return uid;
}
async function allowAdmin(uid: string) {
  await pool.query('insert into sc.admin_devices(user_id, note) values($1,$2) on conflict (user_id) do nothing', [uid, 'v33-test']);
}
const queries: Record<string, string> = {
  station_board: 'select public.station_board() as result',
  whoami: 'select public.whoami() as result',
  state_revision: 'select public.state_revision() as result',
  min_client_version: 'select public.min_client_version() as result',
  claim_station: 'select public.claim_station($1) as result',
  release_device: 'select public.release_device() as result',
  snapshot: 'select public.snapshot() as result',
  server_now_ms: 'select public.server_now_ms() as result',
  operation_status: 'select public.operation_status($1) as result',
  handle_command: 'select public.handle_command($1,$2,$3,$4) as result',
  release_station: 'select public.release_station($1) as result',
};
async function rpc(uid: string | null, name: string, body: Record<string, unknown> = {}) {
  if (!queries[name]) throw new Error('Unknown RPC');
  const args = name === 'claim_station' || name === 'release_station' ? [body.p_role]
    : name === 'handle_command' ? [body.p_action, body.p_meta, body.p_expected_revision, body.p_idempotency_key]
    : name === 'operation_status' ? [body.p_idempotency_key] : [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",
      [uid ?? '', JSON.stringify({ sub: uid, is_anonymous: true })]);
    await client.query(uid ? 'set local role authenticated' : 'set local role anon');
    const { rows } = await client.query(queries[name], args);
    await client.query('commit'); return rows[0].result;
  } catch (err) { await client.query('rollback'); throw err; } finally { client.release(); }
}
const revision = async () => Number((await pool.query('select revision from sc.events where id=(select event_id from sc.state where id=true)')).rows[0].revision);

/**
 * A phone whose Supabase traffic is served by the local RPC harness — the same
 * transport roles.spec.ts uses, plus one lever this file needs: `hangSnapshot`
 * reproduces the production symptom exactly (the socket opens and never answers)
 * so the store's bounded-settle behaviour can be proven in a real browser.
 */
async function phone(browser: Browser, transport: { hangSnapshot: boolean } = { hangSnapshot: false }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  contexts.push(context);
  let uid: string | null = null;
  await context.route('https://access-test.invalid/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/auth/v1/signup') {
      uid = await identity();
      const jwt = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url') + '.' +
        Buffer.from(JSON.stringify({ sub: uid, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated', is_anonymous: true })).toString('base64url') + '.test';
      await route.fulfill({ json: { access_token: jwt, refresh_token: randomUUID(), token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: uid, aud: 'authenticated', role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } } }); return;
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').at(-1)!;
      // The field symptom: an authoritative read that never settles.
      if (name === 'snapshot' && transport.hangSnapshot) return;
      try {
        const result = await rpc(uid, name, route.request().postDataJSON() ?? {});
        await route.fulfill({ json: result });
      } catch (e) { await route.fulfill({ status: 403, json: { message: String(e), code: '42501' } }); }
      return;
    }
    await route.fulfill({ status: 404, json: { message: 'Local transport only' } });
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5177/');
  await expect(page.getByTestId('station-count')).toHaveText(/\d\/6/, { timeout: 20_000 });
  return { context, page, uid: () => uid, transport };
}

test.describe.serial('V3.3 P0 — stuck-sync recovery, real event state, supervisor handoff', () => {
  test.afterEach(async () => {
    for (const c of contexts.splice(0)) await c.close();
  });

  test.beforeEach(async () => {
    await pool.query('update sc.operators set revoked_at = now() where revoked_at is null');
    await pool.query('delete from sc.observer_seats');
    await pool.query('delete from sc.admin_devices');
    // One private event per case; the pointer is moved back before it is removed,
    // because sc.state references it.
    await pool.query(`update sc.rounds set status='CLOSED' where status <> 'CLOSED'`);
    const { rows } = await pool.query(`insert into sc.events (name, game_limit_ms, hidden_object_owner, hiding_layout)
      values ('v33-' || extract(epoch from now())::bigint || '-' || floor(random()*1e9)::text, 300000, 'ROOM305', 'A') returning id`);
    await pool.query('update sc.state set event_id=$1, revision=0, updated_at=sc.now_ms() where id=true', [rows[0].id]);
  });

  test.afterAll(async () => {
    // Drop the private events in dependency order: audit and claims reference
    // rounds, rounds reference the event, and sc.state references it too.
    const { rows } = await pool.query("select id from sc.events where name like 'v33-%'");
    for (const r of rows) {
      await pool.query('delete from sc.action_log where event_id=$1', [r.id]);
      await pool.query('delete from sc.completion_attempts where round_id in (select id from sc.rounds where event_id=$1)', [r.id]);
      await pool.query('delete from sc.reset_tasks where round_id in (select id from sc.rounds where event_id=$1)', [r.id]);
      await pool.query('delete from sc.rounds where event_id=$1', [r.id]);
      await pool.query('delete from sc.state where event_id=$1', [r.id]);
      await pool.query('delete from sc.events where id=$1', [r.id]);
    }
    await pool.query('select sc._ensure_event()');
    await pool.query("select sc.configure_min_client_version('')");
    await pool.end();
  });

  test('a hung snapshot read lands on the Vietnamese failure state with a working retry, not an endless spinner', async ({ browser }) => {
    const p = await phone(browser, { hangSnapshot: true });
    // The board answers (station_board is its own RPC), so the seat is claimable;
    // only the authoritative event read is dead — the exact production shape.
    await p.page.getByTestId('station-LOBBY').click();
    await expect(p.page.getByTestId('booting-state')).toHaveText('KHÔNG ĐỌC ĐƯỢC TRẠNG THÁI MÁY CHỦ', { timeout: 45_000 });
    await expect(p.page.getByTestId('booting-cause')).toContainText('Kiểm tra Wi-Fi');
    await expect(p.page.getByTestId('booting-retry')).toBeVisible();
    // Recovery, the other half of the contract: the transport answers again and
    // the same phone heals in place — no cache clearing, no manual reload.
    p.transport.hangSnapshot = false;
    await p.page.getByTestId('booting-retry').click();
    await expect(p.page.getByTestId('dashboard')).toBeVisible({ timeout: 45_000 });
    await expect(p.page.getByTestId('connection')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });
  });

  test('the picker names the real event state: an ended night is announced, not confused with a sync stall', async ({ browser }) => {
    await pool.query('update sc.events set event_ended_at = sc.now_ms() where id = (select event_id from sc.state where id=true)');
    const board = await rpc(null, 'station_board');
    expect(board.event_ended_at).not.toBeNull();
    expect(board.board_version).toBe(3);                                   // contract preserved
    expect(board.stations.find((s: { role: string }) => s.role === 'OBSERVER').capacity).toBe(10);
    const p = await phone(browser);
    await expect(p.page.getByTestId('home-event-closed')).toContainText('SỰ KIỆN ĐÃ KẾT THÚC');
    await expect(p.page.getByTestId('home-event-closed')).toContainText('MỞ SỰ KIỆN MỚI');
  });

  test('SUPERVISOR opens the new night; every read after the handoff names the open event', async ({ browser }) => {
    await pool.query('update sc.events set event_ended_at = sc.now_ms(), event_started_at = 1 where id = (select event_id from sc.state where id=true)');
    const closedId = (await pool.query('select id from sc.events where id=(select event_id from sc.state where id=true)')).rows[0].id;
    const supUid = await identity(); await allowAdmin(supUid);
    // The admin seat itself must be held before the handoff command is accepted —
    // the caller's live binding is the credential for OPEN_NEW_EVENT as for every
    // other supervisor action.
    expect((await rpc(supUid, 'claim_station', { p_role: 'SUPERVISOR' })).ok).toBe(true);
    const opened = await rpc(supUid, 'handle_command', {
      p_action: 'OPEN_NEW_EVENT', p_meta: { _v: '3.3.0', event_name: 'v33 night 2' },
      p_expected_revision: await revision(), p_idempotency_key: 'v33-open-' + randomUUID(),
    });
    expect(opened).toMatchObject({ ok: true });
    const after = await rpc(null, 'station_board');
    expect(Number(after.event_id)).not.toBe(Number(closedId));
    expect(after.event_ended_at).toBeNull();
    expect(after.event_next_team_number).toBe(1);
    // History survives the handoff: the closed row keeps its end instant.
    const kept = await pool.query('select event_ended_at is not null as ended from sc.events where id=$1', [closedId]);
    expect(kept.rows[0].ended).toBe(true);
    // A brand-new phone sees the open night: no closed banner, the board is live.
    const p = await phone(browser);
    await expect(p.page.getByTestId('home-event-closed')).toHaveCount(0);
    await expect(p.page.getByTestId('station-LOBBY')).toBeEnabled({ timeout: 20_000 });
  });

  test('release_station frees exactly one stuck seat and leaves the others bound', async () => {
    const lobbyUid = await identity(); const gateUid = await identity(); const supUid = await identity();
    await allowAdmin(supUid);
    expect((await rpc(lobbyUid, 'claim_station', { p_role: 'LOBBY' })).ok).toBe(true);
    expect((await rpc(gateUid, 'claim_station', { p_role: 'GATE' })).ok).toBe(true);
    expect((await rpc(supUid, 'claim_station', { p_role: 'SUPERVISOR' })).ok).toBe(true);
    // A duty seat cannot free a peer; only the admin binding can.
    expect((await rpc(lobbyUid, 'release_station', { p_role: 'GATE' })).code).toBe('RELEASE_NOT_AUTHORIZED');
    expect((await rpc(supUid, 'release_station', { p_role: 'GATE' })).ok).toBe(true);
    const board = await rpc(null, 'station_board');
    const seat = (role: string) => board.stations.find((s: { role: string }) => s.role === role) as
      { role: string; devices: number; capacity: number; occupied: boolean };
    const live = await pool.query('select role, user_id, revoked_at is null as live from sc.operators order by role');
    const diag = () => JSON.stringify({ stations: board.stations, live: live.rows });
    expect(seat('GATE').devices, diag()).toBe(0);       // freed — the stuck NPC1 case
    expect(seat('LOBBY').devices, diag()).toBe(1);     // untouched
    // The admin seat keeps its own device: capacity is 2, so `occupied` stays
    // false with one holder; the device counter is the honest assertion.
    expect(seat('SUPERVISOR').devices, diag()).toBe(1); // untouched — no board-wide sweep needed
    // The freed identity can take its own seat back.
    expect((await rpc(gateUid, 'claim_station', { p_role: 'GATE' })).ok).toBe(true);
  });

  test('an outdated bundle is refused by the server floor and never reaches a business rule', async () => {
    await pool.query("select sc.configure_min_client_version('3.3.0')");
    try {
      const uid = await identity();
      expect((await rpc(uid, 'claim_station', { p_role: 'LOBBY' })).ok).toBe(true);
      // A pre-V3.3 command carries no stamp: VERSION_STALE, and no state written.
      const noStamp = await rpc(uid, 'handle_command', { p_action: 'CALL_TEAM', p_meta: {}, p_expected_revision: await revision(), p_idempotency_key: 'v33-nostamp' });
      expect(noStamp.code).toBe('VERSION_STALE');
      expect(noStamp.ok).toBe(false);
      const rounds = await pool.query('select count(*)::int as n from sc.rounds where event_id=(select event_id from sc.state where id=true)');
      expect(rounds.rows[0].n).toBe(0);
      // The escape hatches sit deliberately outside the gate: a stale supervisor
      // can still unstick a seat.
      const supUid = await identity(); await allowAdmin(supUid);
      expect((await rpc(supUid, 'claim_station', { p_role: 'SUPERVISOR' })).ok).toBe(true);
      expect((await rpc(supUid, 'release_station', { p_role: 'LOBBY' })).ok).toBe(true);
      // A stamped V3.3 client passes and the night opens normally.
      expect((await rpc(uid, 'claim_station', { p_role: 'LOBBY' })).ok).toBe(true);
      const ok = await rpc(uid, 'handle_command', { p_action: 'CALL_TEAM', p_meta: { _v: '3.3.0+b' }, p_expected_revision: await revision(), p_idempotency_key: 'v33-stamped' });
      expect(ok.ok).toBe(true);
      // public.min_client_version() answers with no session at all — that is how a
      // phone learns it is stale before it claims anything.
      expect(await rpc(null, 'min_client_version')).toBe('3.3.0');
    } finally {
      await pool.query("select sc.configure_min_client_version('')");
    }
  });
});
