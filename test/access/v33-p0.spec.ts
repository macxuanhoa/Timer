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
  station_admin: 'select public.station_admin() as result',
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
async function phone(
  browser: Browser,
  transport: { hangSnapshot: boolean; noStationAdmin?: boolean } = { hangSnapshot: false },
  /** '/admin' for an organiser device: the retained admin is a route, not a tile. */
  path = '/',
) {
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
      // Today's Production: migration 0021 is not applied yet, so the roster RPC
      // is simply not in the schema cache. PostgREST says PGRST202.
      if (name === 'station_admin' && transport.noStationAdmin) {
        await route.fulfill({ status: 404, json: {
          code: 'PGRST202',
          message: `Could not find the function public.${name} without parameters in the schema cache`,
        } });
        return;
      }
      try {
        const result = await rpc(uid, name, route.request().postDataJSON() ?? {});
        await route.fulfill({ json: result });
      } catch (e) { await route.fulfill({ status: 403, json: { message: String(e), code: '42501' } }); }
      return;
    }
    await route.fulfill({ status: 404, json: { message: 'Local transport only' } });
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5177' + path);
  await expect(page.getByTestId('station-count')).toHaveText(/\d\/6/, { timeout: 20_000 });
  return { context, page, uid: () => uid, transport };
}

/** An organiser phone: /admin, allow-listed mid-session, then into the dashboard.
 *  This is the exact chain the brief demands work — login SUPERVISOR → see the
 *  seat management → free one seat. */
async function adminPhone(
  browser: Browser,
  transport: { hangSnapshot: boolean; noStationAdmin?: boolean } = { hangSnapshot: false },
) {
  const a = await phone(browser, transport, '/admin');
  await expect(a.page.getByTestId('admin-panel')).toBeVisible();
  await allowAdmin(a.uid()!);
  await a.page.getByTestId('home-admin-open').click();
  await expect(a.page.getByTestId('dashboard')).toBeVisible({ timeout: 25_000 });
  return a;
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

  test('an already-connected phone adopts the new event_id with no reload and no cache clearing', async ({ browser }) => {
    // The production requirement is explicit: after a successful handoff the
    // devices must pick up the new event on their own. A phone is connected and
    // looking at the closed night before the supervisor acts.
    await pool.query('update sc.events set event_ended_at = sc.now_ms(), event_started_at = 1, next_team_number = 7 where id = (select event_id from sc.state where id=true)');
    const closedId = (await pool.query('select id from sc.events where id=(select event_id from sc.state where id=true)')).rows[0].id;
    const supUid = await identity(); await allowAdmin(supUid);
    expect((await rpc(supUid, 'claim_station', { p_role: 'SUPERVISOR' })).ok).toBe(true);

    const p = await phone(browser);
    await p.page.getByTestId('station-LOBBY').click();
    await expect(p.page.getByTestId('dashboard')).toBeVisible();
    await expect(p.page.getByTestId('event-ended-card')).toContainText('SỰ KIỆN ĐÃ KẾT THÚC');
    const beforeEvent = await p.page.getByTestId('dashboard').getAttribute('data-revision');
    void beforeEvent;

    // The handoff happens after the phone is already open. Nothing touches it.
    const opened = await rpc(supUid, 'handle_command', {
      p_action: 'OPEN_NEW_EVENT', p_meta: { _v: '3.3.0', event_name: 'v33 adopted night' },
      p_expected_revision: await revision(), p_idempotency_key: 'v33-adopt-' + randomUUID(),
    });
    expect(opened).toMatchObject({ ok: true });

    // The open phone must cross to the new event by itself: the ended card
    // disappears and the lobby CTA returns, on the store's own verification tick.
    await expect(p.page.getByTestId('event-ended-card')).toHaveCount(0, { timeout: 30_000 });
    await expect(p.page.getByTestId('primary-action')).toHaveText('NHẬN ĐỘI & CHO LÊN TẦNG 2', { timeout: 30_000 });
    // And it is genuinely the new event, not the old one re-labelled.
    const snap = await rpc(await p.uid() as string, 'snapshot');
    expect(Number(snap.event.id)).not.toBe(Number(closedId));
    expect(snap.event.event_ended_at).toBeNull();
    expect(snap.event.next_team_number).toBe(1);
    await expect(p.page.getByTestId('team-identity')).toBeVisible();
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

  // -------------------------------------------------------------------------
  // The third production blocker: "Không tìm thấy chức năng GIẢI PHÓNG VỊ TRÍ
  // mặc dù NPC1 đang ĐÃ ĐỦ NGƯỜI." These cases drive the real rendered admin
  // surface in a browser, not the RPC, because the complaint was about a control
  // nobody could find.
  // -------------------------------------------------------------------------

  test('a supervisor signs in and immediately sees QUẢN LÝ VỊ TRÍ, naming the device stuck on NPC1', async ({ browser }) => {
    // Each case opens two real browsers against the RPC harness; under a serial
    // full-suite run that is slower than the 90 s default.
    test.setTimeout(180_000);
    const gateUid = await identity();
    expect((await rpc(gateUid, 'claim_station', { p_role: 'GATE' })).ok).toBe(true);
    await pool.query('update sc.operators set display_name=$1 where user_id=$2', ['NPC1 bo may', gateUid]);

    const a = await adminPhone(browser);
    // One tap from the dashboard header — no menu hunting, no buried accordion.
    await a.page.getByTestId('open-seat-management').click();
    await expect(a.page.getByTestId('seat-management')).toBeVisible({ timeout: 20_000 });
    await expect(a.page.getByTestId('seat-management')).toContainText('QUẢN LÝ VỊ TRÍ');

    // The seat reads as held, and says who holds it. Before migration 0021 no
    // screen could answer this at all.
    await expect(a.page.getByTestId('seat-row-GATE')).toContainText('ĐANG GIỮ');
    await expect(a.page.getByTestId('seat-holder-GATE')).toContainText('NPC1 bo may');
    await expect(a.page.getByTestId('seat-holder-GATE')).toContainText(gateUid.slice(0, 8));
    // The button speaks the operator's vocabulary, not an internal code name.
    await expect(a.page.getByTestId('seat-release-GATE')).toHaveText('GIẢI PHÓNG NPC 1');
    // An empty seat is reported as empty rather than offering a phantom release.
    await expect(a.page.getByTestId('seat-state-ROOM305')).toHaveText('CÒN TRỐNG');
  });

  test('two taps free NPC1 only, and the picker opens that seat for the next phone', async ({ browser }) => {
    test.setTimeout(180_000);
    const gateUid = await identity(); const lobbyUid = await identity();
    expect((await rpc(gateUid, 'claim_station', { p_role: 'GATE' })).ok).toBe(true);
    expect((await rpc(lobbyUid, 'claim_station', { p_role: 'LOBBY' })).ok).toBe(true);

    const a = await adminPhone(browser);
    await a.page.getByTestId('open-seat-management').click();
    await expect(a.page.getByTestId('seat-release-GATE')).toBeEnabled({ timeout: 20_000 });

    // Step one arms, and the panel explains what the second tap will do.
    await a.page.getByTestId('seat-release-GATE').click();
    await expect(a.page.getByTestId('seat-mgmt-armed')).toContainText('NPC 1 · CỬA TẦNG 3');
    await expect(a.page.getByTestId('seat-release-GATE')).toHaveText('XÁC NHẬN GIẢI PHÓNG NPC 1');

    // Step two commits.
    await a.page.getByTestId('seat-release-GATE').click();
    await expect(a.page.getByTestId('seat-mgmt-result')).toContainText('ĐÃ GIẢI PHÓNG NPC 1', { timeout: 20_000 });

    const board = await rpc(null, 'station_board');
    const seat = (role: string) => board.stations.find((s: { role: string }) => s.role === role) as
      { role: string; devices: number };
    expect(seat('GATE').devices).toBe(0);   // the stuck seat is back
    // A per-seat release must never sweep the board.
    expect(seat('LOBBY').devices).toBe(1);
    // The audit trail names both parties, so the night can be reconstructed.
    const audit = await pool.query(
      "select metadata->>'by' as by from sc.access_audit where action='STATION_RELEASED' order by id desc limit 1");
    expect(audit.rows[0]?.by).toBe(a.uid());

    // A different phone now finds the seat claimable, with no cache clearing.
    const p = await phone(browser);
    await expect(p.page.getByTestId('station-GATE')).toBeEnabled({ timeout: 20_000 });
  });

  test('the panel will not free NPC1 while a team is inside, and says why in Vietnamese', async ({ browser }) => {
    test.setTimeout(180_000);
    const lobbyUid = await identity(); const corridorUid = await identity(); const gateUid = await identity();
    for (const [uid, role] of [[lobbyUid, 'LOBBY'], [corridorUid, 'CORRIDOR'], [gateUid, 'GATE']] as const) {
      expect((await rpc(uid, 'claim_station', { p_role: role })).ok).toBe(true);
    }
    // Put a real team on the clock: the case where freeing NPC1 would strand it.
    const press = async (uid: string, action: string, key: string) => {
      const res = await rpc(uid, 'handle_command', {
        p_action: action, p_meta: { _v: '3.3.0' }, p_expected_revision: await revision(), p_idempotency_key: key,
      });
      expect(res, action).toMatchObject({ ok: true });
    };
    await press(lobbyUid, 'CALL_TEAM', 'seatmg-call');
    await press(corridorUid, 'CONFIRM_FLOOR2', 'seatmg-floor2');
    await press(gateUid, 'START_GAME', 'seatmg-start');

    const a = await adminPhone(browser);
    await a.page.getByTestId('open-seat-management').click();
    await expect(a.page.getByTestId('seat-mgmt-floor')).toContainText('ĐANG CÓ ĐỘI TRONG KHU VỰC', { timeout: 20_000 });
    await expect(a.page.getByTestId('seat-release-GATE')).toBeDisabled();
    await expect(a.page.getByTestId('seat-release-GATE')).toHaveText('KHÔNG ĐƯỢC — ĐANG CÓ LƯỢT');
    // The database refuses for the same reason, so the UI is never ahead of it.
    const refused = await rpc(a.uid(), 'release_station', { p_role: 'GATE' });
    expect(refused.code).toBe('FLOOR_BUSY');
    // Every floor seat is protected the same way: a live round needs all of them,
    // and half a rescue would strand the team just as badly.
    await expect(a.page.getByTestId('seat-release-ROOM305')).toBeDisabled();
    await expect(a.page.getByTestId('seat-release-CORRIDOR')).toBeDisabled();
    // The admin seat is never offered for release on this surface at all.
    await expect(a.page.getByTestId('seat-release-SUPERVISOR')).toHaveCount(0);
    // And the held device is still named, so the supervisor knows who to call.
    await expect(a.page.getByTestId('seat-holder-GATE')).toContainText(gateUid.slice(0, 8));
    const stillHeld = await rpc(null, 'station_board');
    expect(stillHeld.stations.find((s: { role: string }) => s.role === 'GATE').devices).toBe(1);
  });

  test('with migration 0021 not applied yet, the panel still frees the stuck seat', async ({ browser }) => {
    // This is Production as it stands right now: release_station exists since
    // 0019, station_admin does not exist at all. The missing roster must degrade
    // to an unnamed seat list, never to a dead end — the whole complaint was that
    // the operator could not free NPC1.
    test.setTimeout(180_000);
    const gateUid = await identity();
    expect((await rpc(gateUid, 'claim_station', { p_role: 'GATE' })).ok).toBe(true);

    const a = await adminPhone(browser, { hangSnapshot: false, noStationAdmin: true });
    await a.page.getByTestId('open-seat-management').click();
    await expect(a.page.getByTestId('seat-management')).toBeVisible({ timeout: 20_000 });
    // Every seat is still listed, and the honest note says the roster is missing.
    await expect(a.page.getByTestId('seat-row-ROOM305')).toBeVisible();
    await expect(a.page.getByTestId('seat-mgmt-degraded')).toContainText('Không đọc được danh sách thiết bị');
    // Presence still comes through: the snapshot names which seats are bound, so
    // NPC1 is not falsely reported as free.
    await expect(a.page.getByTestId('seat-state-GATE')).toContainText('ĐANG GIỮ');
    await expect(a.page.getByTestId('seat-state-ROOM305')).toHaveText('CÒN TRỐNG');
    // No holder names are invented when the server cannot supply them.
    await expect(a.page.getByTestId('seat-holder-GATE')).toHaveCount(0);

    await a.page.getByTestId('seat-release-GATE').click();
    await a.page.getByTestId('seat-release-GATE').click();
    await expect(a.page.getByTestId('seat-mgmt-result')).toContainText('ĐÃ GIẢI PHÓNG NPC 1', { timeout: 20_000 });

    const board = await rpc(null, 'station_board');
    expect(board.stations.find((s: { role: string }) => s.role === 'GATE').devices).toBe(0);
    const p = await phone(browser);
    await expect(p.page.getByTestId('station-GATE')).toBeEnabled({ timeout: 20_000 });
  });
});
