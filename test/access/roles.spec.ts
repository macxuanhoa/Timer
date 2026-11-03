import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const { Pool } = createRequire(import.meta.url)('pg');
// Deliberately fixed to loopback + a test-only database, never production env.
const pool = new Pool({ host: '127.0.0.1', port: 55436, database: 'sc305_access', user: 'postgres', password: 'postgres', max: 16 });
const PIN = '9876543210';
const RESET = 'greenwich99';
/** V3.1 §5: one crew code per operating position, installed as a bcrypt hash. */
const CODES: Record<string, string> = { LOBBY: 'SANNH01', CORRIDOR: 'TANG202', GATE: 'CUANPC1', ROOM305: 'PHONG305' };
const STATIONS = ['LOBBY', 'CORRIDOR', 'GATE', 'ROOM305'];
const contexts: BrowserContext[] = [];

async function identity() {
  const uid = randomUUID(); await pool.query('insert into auth.users(id) values($1)',[uid]); return uid;
}
const queries: Record<string,string> = {
  station_board: 'select public.station_board() as result', whoami: 'select public.whoami() as result',
  claim_station: 'select public.claim_station($1,$2) as result', release_device: 'select public.release_device() as result',
  snapshot: 'select public.snapshot() as result', state_revision: 'select public.state_revision() as result',
  server_now_ms: 'select public.server_now_ms() as result', operation_status: 'select public.operation_status($1) as result',
  handle_command: 'select public.handle_command($1,$2,$3,$4) as result',
  redeem_invitation: 'select public.redeem_invitation($1,$2) as result',
  reset_all_stations: 'select public.reset_all_stations($1) as result',
  observer_join: 'select public.observer_join($1) as result',
  observer_beat: 'select public.observer_beat($1) as result',
  observer_leave: 'select public.observer_leave() as result',
};
async function rpc(uid: string | null, name: string, body: Record<string,unknown> = {}) {
  if (!queries[name]) throw new Error('Unknown RPC');
  const args = name === 'claim_station' ? [body.p_role,body.p_pin] : name === 'handle_command' ?
    [body.p_action,body.p_meta,body.p_expected_revision,body.p_idempotency_key] : name === 'operation_status' ?
    [body.p_idempotency_key] : name === 'redeem_invitation' ? [body.p_token,body.p_device_id] :
    name === 'reset_all_stations' ? [body.p_secret] :
    name === 'observer_join' || name === 'observer_beat' ? [body.p_viewer_id ?? null] : [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",
      [uid ?? '', JSON.stringify({sub:uid,is_anonymous:true})]);
    await client.query(uid ? 'set local role authenticated' : 'set local role anon');
    const { rows } = await client.query(queries[name], args);
    await client.query('commit'); return rows[0].result;
  } catch (err) { await client.query('rollback'); throw err; }
  finally { client.release(); }
}
async function phone(browser: Browser) {
  const context = await browser.newContext({ viewport: { width:390,height:844 }, serviceWorkers:'block' });
  contexts.push(context);
  let uid: string | null = null;
  let offline = false;
  let boardBlocked = false;
  let releaseDropAfterCommit = false;
  await context.route('https://access-test.invalid/**', async route => {
    if (offline || (boardBlocked && route.request().url().endsWith('/station_board'))) { await route.abort('internetdisconnected'); return; }
    const url = new URL(route.request().url());
    if (url.pathname === '/auth/v1/signup') {
      uid = await identity();
      const jwt = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+
        Buffer.from(JSON.stringify({sub:uid,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated',is_anonymous:true})).toString('base64url')+'.test';
      await route.fulfill({json:{ access_token:jwt,refresh_token:randomUUID(),token_type:'bearer',expires_in:3600,
        expires_at:Math.floor(Date.now()/1000)+3600,user:{id:uid,aud:'authenticated',role:'authenticated',is_anonymous:true,app_metadata:{},user_metadata:{},created_at:new Date().toISOString()} }}); return;
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').at(-1)!;
      try {
        const result = await rpc(uid, name, route.request().postDataJSON() ?? {});
        if (name === 'release_device' && releaseDropAfterCommit) { releaseDropAfterCommit=false; await route.abort(); return; }
        await route.fulfill({json:result});
      } catch (e) { await route.fulfill({status:403,json:{message:String(e),code:'42501'}}); }
      return;
    }
    await route.fulfill({status:404,json:{message:'Local transport only'}});
  });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('station-count')).toHaveText(/\d\/6/);
  return {context,page, uid:()=>uid, offline:(x:boolean)=>{offline=x;}, blockBoard:(x:boolean)=>{boardBlocked=x;}, dropRelease:()=>{releaseDropAfterCommit=true;}};
}

/**
 * A station is a tap and its crew code. The retained admin is not: it is reached
 * from the quiet management line and authenticates with its own PIN, while the
 * viewing seat asks for nothing at all (V3.1 §5.2).
 */
async function boundRole(p: Awaited<ReturnType<typeof phone>>) {
  return pool.query('select role from sc.operators where user_id=$1 and revoked_at is null', [p.uid()]);
}

/**
 * The viewer seat is taken by the presence call the page fires on mount, so the
 * binding lands an instant after the screen appears. Authority probes have to wait
 * for the server-side row rather than assume it.
 */
async function waitBound(p: Awaited<ReturnType<typeof phone>>, role: string) {
  await expect.poll(async () => (await boundRole(p)).rows[0]?.role).toBe(role);
}

async function claim(p: Awaited<ReturnType<typeof phone>>, role: string, code?: string) {
  if (role === 'SUPERVISOR') {
    await p.page.getByTestId('home-admin-open').click();
    await p.page.getByLabel('PIN quản trị',{exact:true}).fill(PIN);
    await p.page.getByRole('button',{name:'VÀO QUẢN TRỊ'}).click();
    await expect(p.page.getByTestId('dashboard')).toBeVisible();
    return;
  }
  await p.page.getByTestId('station-'+role).click();
  if (role === 'OBSERVER') {
    await expect(p.page.getByTestId('observer')).toBeVisible();
    await waitBound(p, 'OBSERVER');
    return;
  }
  // The picker now asks for the position's crew code before it will claim the seat.
  await p.page.getByLabel('Mã vị trí',{exact:true}).fill(code ?? CODES[role]);
  await p.page.getByTestId('home-code-confirm').click();
  await expect(p.page.getByTestId('dashboard')).toBeVisible();
}

async function act(uid: string | null, action: string, meta: Record<string, unknown> = {}, key = randomUUID()) {
  const rev = await rpc(uid,'state_revision');
  return rpc(uid,'handle_command',{p_action:action,p_meta:meta,p_expected_revision:rev.revision,p_idempotency_key:key});
}

test.beforeEach(async () => {
  await pool.query('update sc.operators set revoked_at=now() where revoked_at is null');
  await pool.query('delete from sc.observer_seats');
  // Each case owns the event pointer, so a previous case can leave a round closed
  // rather than still occupying the floor.
  await pool.query("update sc.rounds set status='CLOSED' where status <> 'CLOSED'");
  await pool.query('select sc.configure_station_access($1,false)',[PIN]);
  await pool.query('select sc.configure_station_reset($1)',[RESET]);
  for (const [role, code] of Object.entries(CODES)) await pool.query('select sc.configure_station_code($1,$2)',[role,code]);
});
test.afterEach(async()=>{await Promise.all(contexts.splice(0).map(c=>c.close()));});
test.afterAll(async()=>{await pool.end();});

for (const role of STATIONS) test(role+': root → claim → dashboard; occupied → release → replacement',async({browser})=>{
  const a=await phone(browser), b=await phone(browser);
  await expect(a.page.locator('input')).toHaveCount(0);
  await claim(a,role);
  await expect(b.page.getByTestId('station-'+role)).toBeDisabled();
  await expect(b.page.getByTestId('station-'+role)).toHaveAttribute('data-state','full');
  const uid=await identity(); expect((await rpc(uid,'claim_station',{p_role:role,p_pin:null})).code).toBe('ROLE_TAKEN');
  await a.page.getByTestId('return-home').click();
  await expect(a.page.getByTestId('scream-home')).toBeVisible();
  await expect(b.page.getByTestId('station-'+role)).toBeEnabled();
  await claim(b,role);
});

test('the picker shows four stations plus the open viewer seat, never the admin',async({browser})=>{
  const a=await phone(browser);
  await expect(a.page.locator('.home-station')).toHaveCount(5);
  await expect(a.page.getByTestId('station-OBSERVER')).toHaveAttribute('data-kind','observer');
  await expect(a.page.getByTestId('station-SUPERVISOR')).toHaveCount(0);
  await expect(a.page.getByTestId('observer-count')).toHaveText(/\/10/);
  // The viewer seat opens with no password and no challenge of any kind.
  await claim(a,'OBSERVER');
  await expect(a.page.getByTestId('observer')).toBeVisible();
  // The identity that the browser signed in with is the one holding the seat.
  const seat = await boundRole(a);
  expect(seat.rows.length).toBe(1);
  expect(seat.rows[0].role).toBe('OBSERVER');
  // Beating for its own seat is the proof the server resolves this identity as the
  // viewer it bound, which is also what keeps a refresh on the same seat.
  expect((await rpc(a.uid(),'observer_beat',{p_viewer_id:'probe'})).ok).toBe(true);
});

test('SUPERVISOR requires PIN, accepts two phones, refuses the third',async({browser})=>{
  const a=await phone(browser);
  await a.page.getByTestId('home-admin-open').click();
  await a.page.getByLabel('PIN quản trị',{exact:true}).fill('1111111111');
  await a.page.getByRole('button',{name:'VÀO QUẢN TRỊ'}).click();
  await expect(a.page.getByRole('alert').last()).toHaveText('PIN KHÔNG ĐÚNG');
  await a.page.getByLabel('PIN quản trị',{exact:true}).fill(PIN);
  await a.page.getByRole('button',{name:'VÀO QUẢN TRỊ'}).click();
  await expect(a.page.getByTestId('dashboard')).toBeVisible();
  // The retained admin is off the board by design, so its occupancy is server-side.
  expect((await rpc(await identity(),'claim_station',{p_role:'SUPERVISOR',p_pin:PIN})).ok).toBe(true);
  expect((await rpc(await identity(),'claim_station',{p_role:'SUPERVISOR',p_pin:PIN})).code).toBe('ROLE_TAKEN');
  expect((await rpc(await identity(),'claim_station',{p_role:'SUPERVISOR',p_pin:PIN})).code).toBe('ROLE_TAKEN');
  await a.page.getByTestId('return-home').click();
  expect((await rpc(await identity(),'claim_station',{p_role:'SUPERVISOR',p_pin:PIN})).ok).toBe(true);
});

test('a viewer is read-only in the database, whatever it sends',async({browser})=>{
  const v=await phone(browser); await claim(v,'OBSERVER');
  const before = await rpc(v.uid(),'state_revision');
  for (const action of ['CALL_TEAM','CONFIRM_FLOOR2','START_GAME','CLAIM_COMPLETE','VERIFY_ATTEMPT','CONFIRM_EXIT','GATE_FINALIZE','SET_TEAM_NAME']) {
    const res = await act(v.uid(), action);
    expect(res.code, action).toBe('READ_ONLY');
  }
  expect((await rpc(v.uid(),'state_revision')).revision).toBe(before.revision);
  // What a viewer may see, and what it must never see. The database returns stored
  // rows only, so the public shape is the event, the rounds and the revision.
  const snap = await rpc(v.uid(),'snapshot');
  expect(snap.redacted).toBe(true);
  expect(snap.log).toEqual([]);
  expect(snap.attempts).toEqual([]);
  expect(snap.operators).toEqual([]);
  expect(snap.reset_tasks).toEqual([]);
  expect(snap.revision).toBeDefined();
  expect(Array.isArray(snap.rounds)).toBe(true);
  expect(String(snap.event.config.game_limit_ms)).toBe('300000');
  expect(snap.event.config.hiding_layout).toBeUndefined();
  // A viewer's copy of a round carries no operator identity at all.
  if (snap.rounds.length) {
    expect(snap.rounds[0].received_by).toBeUndefined();
    expect(snap.rounds[0].review_reasons).toBeUndefined();
  }
});

test('ten viewers fit, the eleventh is refused, and a seat survives a refresh',async({browser})=>{
  const seats = await Promise.all(Array.from({length:10}, async () => {
    const p = await phone(browser);
    await claim(p,'OBSERVER');
    return p;
  }));
  expect((await rpc(seats[0].uid(),'observer_join',{p_viewer_id:'v-0'})).code).toBe('ALREADY_BOUND');
  const board = await rpc(null,'station_board');
  expect(Number(board.observer_devices)).toBe(10);
  expect(Number(board.observer_capacity)).toBe(10);
  // The eleventh is a refusal, not an error, and it states the capacity.
  const late = await rpc(await identity(),'observer_join',{p_viewer_id:'v-late'});
  expect(late.code).toBe('OBSERVER_FULL');
  expect(late.capacity).toBe(10);
  // A phone that stopped beating gives its seat back; the audience is not locked out
  // by an abandoned browser.
  await pool.query("update sc.observer_seats set seen_at = now() - interval '60 seconds' where user_id=$1",[seats[3].uid()]);
  const rejoin = await rpc(await identity(),'observer_join',{p_viewer_id:'v-new'});
  expect(rejoin.ok).toBe(true);
  // A station can never take a viewer seat, and a viewer can never take a station.
  expect((await rpc(seats[0].uid(),'claim_station',{p_role:'GATE',p_pin:null})).code).toBe('ALREADY_BOUND_OTHER_ROLE');
  const station = await phone(browser); await claim(station,'GATE');
  expect((await rpc(station.uid(),'observer_join',{p_viewer_id:'x'})).code).toBe('ALREADY_BOUND_OTHER_ROLE');
});

test('refresh, new PWA tab and legacy deep link restore exactly one binding; revocation returns Home',async({browser})=>{
  const a=await phone(browser); await claim(a,'GATE');
  await a.page.reload(); await expect(a.page.getByTestId('role-tag')).toHaveText('NPC 1');
  const second=await a.context.newPage(); await second.goto('/i/'+ 'x'.repeat(43));
  await expect(second.getByTestId('role-tag')).toHaveText('NPC 1'); await expect(second).toHaveURL('http://127.0.0.1:5177/');
  const board=await rpc(null,'station_board'); expect(board.devices).toBe(1);
  expect((await rpc(a.uid(),'claim_station',{p_role:'CORRIDOR',p_pin:null})).code).toBe('ALREADY_BOUND_OTHER_ROLE');
  await pool.query('update sc.operators set revoked_at=now() where user_id=$1',[a.uid()]);
  await expect(a.page.getByTestId('scream-home')).toBeVisible();
  expect((await rpc(a.uid(),'handle_command',{p_action:'CONFIRM_EXIT',p_meta:{},p_expected_revision:0,p_idempotency_key:randomUUID()})).code).toBe('PERMISSION_DENIED');
});

test('offline release keeps dashboard and occupancy; a lost committed reply is safely retried',async({browser})=>{
  const a=await phone(browser), b=await phone(browser); await claim(a,'GATE');
  a.offline(true); await a.page.getByTestId('return-home').click();
  await expect(a.page.getByTestId('release-error')).toBeVisible();
  await expect(a.page.getByTestId('dashboard')).toBeVisible();
  await expect(b.page.getByTestId('station-GATE')).toBeDisabled();
  a.offline(false); a.dropRelease(); await a.page.getByTestId('return-home').click();
  await expect(a.page.getByTestId('release-error')).toBeVisible();
  await a.page.getByTestId('return-home').click(); await expect(a.page.getByTestId('scream-home')).toBeVisible();
  await expect(b.page.getByTestId('station-GATE')).toBeEnabled();
});

test('supervisor releases the board; a wrong secret, a stranger or a live floor keeps every seat', async ({browser}) => {
  const lobby=await phone(browser); await claim(lobby,'LOBBY');
  const corridor=await phone(browser); await claim(corridor,'CORRIDOR');
  const gate=await phone(browser); await claim(gate,'GATE');
  const room=await phone(browser); await claim(room,'ROOM305');
  const sup=await phone(browser); await claim(sup,'SUPERVISOR');
  const spare=await identity();
  expect((await rpc(spare,'claim_station',{p_role:'SUPERVISOR',p_pin:PIN})).ok).toBe(true);
  const picker=await phone(browser);
  await expect(picker.page.getByTestId('station-count')).toHaveText('6/6');

  // A team on the clock: a stranger with the secret is refused before the secret
  // matters, and the supervisor is refused because the floor is not idle (§6.1-6.2).
  expect((await act(lobby.uid(),'CALL_TEAM')).ok).toBe(true);
  expect((await act(corridor.uid(),'CONFIRM_FLOOR2')).ok).toBe(true);
  expect((await act(gate.uid(),'START_GAME')).ok).toBe(true);
  expect((await rpc(lobby.uid(),'reset_all_stations',{p_secret:RESET})).code).toBe('RESET_NOT_AUTHORIZED');
  expect((await rpc(sup.uid(),'reset_all_stations',{p_secret:RESET})).code).toBe('RESET_GAME_RUNNING');
  await expect(picker.page.getByTestId('home-floor-busy')).toContainText('NPC 1 chưa xác nhận rời tầng 3');
  // The release is no longer a control on the picker at all.
  await expect(picker.page.getByTestId('home-reset-open')).toHaveCount(0);
  expect((await rpc(lobby.uid(),'whoami'))?.role).toBe('LOBBY');

  // The guarded early exit IS the departure; the area still has to be closed out
  // before the floor counts as idle.
  expect((await act(gate.uid(),'EARLY_EXIT',{reason:'Don ca'})).ok).toBe(true);
  const exited = await rpc(gate.uid(),'snapshot');
  expect(exited.rounds.at(-1).result).toBe('ABORTED');
  expect(exited.rounds.at(-1).exit_confirmed_at).not.toBeNull();
  expect((await rpc(sup.uid(),'reset_all_stations',{p_secret:RESET})).code).toBe('RESET_AREA_OPEN');
  expect((await act(gate.uid(),'RESET_DONE')).ok).toBe(true);
  expect((await act(room.uid(),'RESET_DONE')).ok).toBe(true);
  expect((await act(gate.uid(),'GATE_FINALIZE')).ok).toBe(true);
  expect((await rpc(sup.uid(),'reset_all_stations',{p_secret:'sai-mat-khau-12345'})).code).toBe('RESET_INVALID');

  // The control lives in the admin sheet of a supervisor phone: hidden by default,
  // peekable, and a placeholder value is what the screenshot ever captures.
  await sup.page.getByTestId('open-details').click();
  await sup.page.getByTestId('section-admin').locator('summary').click();
  const secretField = sup.page.getByLabel('Mật khẩu giải phóng bảng',{exact:true});
  await expect(secretField).toHaveAttribute('type','password');
  await sup.page.getByTestId('release-peek').click();
  await expect(sup.page.getByTestId('release-peek')).toHaveAttribute('aria-pressed','true');
  await secretField.fill('mat-khau-demo');
  await expect(secretField).toHaveValue('mat-khau-demo');
  await sup.page.screenshot({path:'shots/admin-release-peek.png'});
  await sup.page.getByTestId('release-peek').click();
  await expect(secretField).toHaveAttribute('type','password');
  await expect(secretField).toHaveValue('mat-khau-demo');

  await secretField.fill('greenwich98');
  await sup.page.getByTestId('release-confirm').click();
  await expect(sup.page.getByTestId('release-result')).toHaveText('MẬT KHẨU RESET KHÔNG ĐÚNG');
  await expect(picker.page.getByTestId('station-count')).toHaveText('6/6');
  await expect(gate.page.getByTestId('dashboard')).toBeVisible();

  const fingerprint = async () => (await pool.query(
    "select md5(coalesce(string_agg(to_jsonb(r)::text,'|' order by r.id),'')) || md5(coalesce(string_agg(to_jsonb(a)::text,'|' order by a.id),'')) as h " +
    'from sc.rounds r cross join sc.completion_attempts a')).rows[0].h as string;
  const before = await pool.query('select count(*)::int n from sc.rounds');
  const beforeClaims = await pool.query('select count(*)::int n from sc.completion_attempts');
  const beforeFp = await fingerprint();

  await secretField.fill(RESET);
  await sup.page.screenshot({path:'shots/admin-release-secret.png'});
  await sup.page.getByTestId('release-confirm').click();
  await expect(picker.page.getByTestId('station-count')).toHaveText('0/6');
  await picker.page.screenshot({path:'shots/admin-release-free-board.png'});
  await expect(picker.page.getByTestId('station-GATE')).toBeEnabled();
  // Every duty phone loses authority on its own recheck and lands back on the picker.
  for (const p of [lobby,gate]) await expect(p.page.getByTestId('scream-home')).toBeVisible();
  expect((await rpc(spare,'whoami'))).toBeNull();
  // An identity the release just unbound has no authority left: Postgres refuses the
  // read itself, so the phone cannot even ask for a revision.
  await expect(act(gate.uid(),'CONFIRM_EXIT')).rejects.toThrow('PERMISSION_DENIED');
  expect((await rpc(sup.uid(),'release_device')).code).toBe('NOT_BOUND');
  // The release is access-only: no round, claim, clock or result moved.
  expect(await fingerprint()).toBe(beforeFp);
  expect((await pool.query('select count(*)::int n from sc.rounds')).rows[0].n).toBe(before.rows[0].n);
  expect((await pool.query('select count(*)::int n from sc.completion_attempts')).rows[0].n).toBe(beforeClaims.rows[0].n);
  const closed = await pool.query('select status, result, official_duration_ms from sc.rounds order by id desc limit 1');
  expect(closed.rows[0].status).toBe('CLOSED');
  expect(closed.rows[0].result).toBe('ABORTED');
  expect(closed.rows[0].official_duration_ms).toBeNull();

  // A new crew claims with its crew code and still has to walk the real checklist:
  // OPERATOR_02 owns no physical check, and closure needs both floor-3 confirmations.
  const cor=await identity(); const rom=await identity(); const gat2=await identity();
  expect((await rpc(cor,'claim_station',{p_role:'CORRIDOR',p_pin:null})).code).toBe('CODE_INVALID');
  for (const [uid,role] of [[cor,'CORRIDOR'],[rom,'ROOM305'],[gat2,'GATE']] as [string,string][]) {
    expect((await rpc(uid,'claim_station',{p_role:role,p_pin:CODES[role]})).ok).toBe(true);
  }
  // CORRIDOR never owns a physical reset (§5.3): the permission layer refuses it
  // before any state question. GATE and ROOM305 hold the reset right, but the round
  // they would confirm is already CLOSED by GATE_FINALIZE above, so the guard
  // refuses them at the phase layer. Reset must never be a way to reopen history
  // (§5.3 "Không dùng reset làm thay đổi thời gian/kết quả").
  expect((await act(cor,'RESET_DONE')).code).toBe('PERMISSION_DENIED');
  expect((await act(gat2,'RESET_DONE')).code).toBe('INVALID_STATE');
  expect((await act(rom,'RESET_DONE')).code).toBe('INVALID_STATE');
});

test('the release is inert without a secret, refuses guesses and repeats safely', async () => {
  const gate=await identity();
  expect((await rpc(gate,'claim_station',{p_role:'GATE',p_pin:CODES.GATE})).ok).toBe(true);
  const sup=await identity();
  expect((await rpc(sup,'claim_station',{p_role:'SUPERVISOR',p_pin:PIN})).ok).toBe(true);
  // A stranger holding the secret is not a supervisor: the role answer comes first.
  await pool.query('select sc.configure_station_reset(null)');
  expect((await rpc(gate,'reset_all_stations',{p_secret:'whatever-value'})).code).toBe('RESET_NOT_AUTHORIZED');
  expect((await rpc(sup,'reset_all_stations',{p_secret:'whatever-value'})).code).toBe('RESET_NOT_CONFIGURED');
  await pool.query('select sc.configure_station_reset($1)',[RESET]);
  expect((await rpc(sup,'reset_all_stations',{p_secret:'Greenwich99'})).code).toBe('RESET_INVALID');
  expect((await rpc(sup,'whoami'))?.role).toBe('SUPERVISOR');
  expect((await rpc(sup,'reset_all_stations',{p_secret:RESET})).freed).toBe(2);
  expect(await rpc(sup,'whoami')).toBeNull();
  expect(await rpc(gate,'whoami')).toBeNull();
  // A repeat release on an empty board still unbinds every live operator row,
  // including the caller itself (§5.3 "Không dùng reset làm thay đổi thời gian").
  // That is the same convention the earlier release in this test asserts: sup's own
  // seat counted in `freed:2` on line 370, so a caller who then rebinds and repeats
  // sees exactly its own binding counted here.
  const sup2=await identity();
  expect((await rpc(sup2,'claim_station',{p_role:'SUPERVISOR',p_pin:PIN})).ok).toBe(true);
  expect((await rpc(sup2,'reset_all_stations',{p_secret:RESET})).freed).toBe(1);
  expect((await rpc(await identity(),'claim_station',{p_role:'GATE',p_pin:CODES.GATE})).ok).toBe(true);
});

test('crew codes guard the four operating positions and never the viewing seat', async ({browser}) => {
  // The picker says a code is in force, and asks for it before it will claim a seat.
  const a=await phone(browser);
  await expect(a.page.getByTestId('station-GATE')).toBeEnabled();
  await a.page.getByTestId('station-GATE').click();
  await expect(a.page.getByLabel('Mã vị trí',{exact:true})).toBeVisible();
  // A wrong code is refused in words an operator understands, and stays on the picker.
  await a.page.getByLabel('Mã vị trí',{exact:true}).fill('SANNH01');   // the lobby code
  await a.page.getByTestId('home-code-confirm').click();
  await expect(a.page.getByTestId('home-error')).toHaveText('SAI MÃ VỊ TRÍ');
  await expect(a.page.getByTestId('dashboard')).toHaveCount(0);
  // The right code for the right position opens it, and the seat is then held.
  await a.page.getByLabel('Mã vị trí',{exact:true}).fill(CODES.GATE);
  await a.page.getByTestId('home-code-confirm').click();
  await expect(a.page.getByTestId('dashboard')).toBeVisible();
  await expect(a.page.getByTestId('role-tag')).toHaveText('NPC 1');
  // The same identity cannot buy a second position with a second code.
  expect((await rpc(a.uid(),'claim_station',{p_role:'LOBBY',p_pin:CODES.LOBBY})).code).toBe('ALREADY_BOUND_OTHER_ROLE');
  // A refresh does not ask for the code again: the binding is what authorises.
  await a.page.reload();
  await expect(a.page.getByTestId('role-tag')).toHaveText('NPC 1');
  // The viewing seat still opens with nothing at all, and a viewer cannot upgrade.
  const v=await phone(browser); await claim(v,'OBSERVER');
  expect((await rpc(v.uid(),'claim_station',{p_role:'ROOM305',p_pin:CODES.ROOM305})).code).toBe('ALREADY_BOUND_OTHER_ROLE');
  // Brute force is capped per identity, and the code never reaches the audit trail.
  const x=await identity();
  for (let i=0;i<5;i++) expect((await rpc(x,'claim_station',{p_role:'LOBBY',p_pin:'SAIKHONG'})).code).toBe('CODE_INVALID');
  expect((await rpc(x,'claim_station',{p_role:'LOBBY',p_pin:CODES.LOBBY})).code).toBe('CODE_RATE_LIMITED');
  const leaked = await pool.query("select count(*)::int n from sc.access_audit where metadata::text like '%SAIKHONG%' or metadata::text like '%SANNH01%'");
  expect(leaked.rows[0].n).toBe(0);
  // No hash, and no code, is readable through the API.
  const hashes = await pool.query("select count(*)::int n from sc.station_codes where code_hash = any($1)", [[Object.values(CODES)]]);
  expect(hashes.rows[0].n).toBe(0);
  const granted = await pool.query(
    "select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace " +
    "where ns.nspname in ('sc','public') and p.proname in ('configure_station_code','station_code_state') " +
    "and has_function_privilege('authenticated', p.oid, 'execute')");
  expect(granted.rows[0].n).toBe(0);
  const board = await rpc(null,'station_board');
  expect(board.codes_required).toBe(true);
  expect(String(board.board_version)).toBe('3');
});

test('stale occupancy becomes neutral and disabled, reconnect refetches; old link cannot grant a role', async({browser})=>{
  const a=await phone(browser); a.blockBoard(true);
  await expect(a.page.getByTestId('station-GATE')).toHaveAttribute('data-state','unknown');
  await expect(a.page.getByTestId('station-GATE')).toBeDisabled();
  a.blockBoard(false); await expect(a.page.getByTestId('station-GATE')).toBeEnabled();
  await a.page.goto('/i/'+ 'x'.repeat(43));
  await expect(a.page.getByTestId('scream-home')).toBeVisible(); await expect(a.page).toHaveURL('http://127.0.0.1:5177/');
  await expect(a.page.getByTestId('station-GATE')).toBeEnabled();
  await a.page.screenshot({path:'shots/single-url-home.png',fullPage:true});
});

test('real parallel PostgreSQL transactions enforce last NPC slot, supervisor slot, viewer seat and identity exclusivity',async()=>{
  const ids=await Promise.all(Array.from({length:10},()=>identity()));
  // V3.1 §5: every operating seat is guarded by a crew code, so a parallel claim
  // test has to present the code. Without it every call fails at `CODE_INVALID`
  // before reaching the seat-slot race this test is meant to observe.
  let results=await Promise.all(ids.map(uid=>rpc(uid,'claim_station',{p_role:'GATE',p_pin:CODES.GATE})));
  expect(results.filter(r=>r.ok)).toHaveLength(1); expect(results.filter(r=>r.code==='ROLE_TAKEN')).toHaveLength(9);
  await rpc(await identity(),'claim_station',{p_role:'SUPERVISOR',p_pin:PIN});
  results=await Promise.all((await Promise.all(Array.from({length:8},()=>identity()))).map(uid=>rpc(uid,'claim_station',{p_role:'SUPERVISOR',p_pin:PIN})));
  expect(results.filter(r=>r.ok)).toHaveLength(1);
  const same=await identity(); results=await Promise.all(['CORRIDOR','ROOM305'].map(p_role=>rpc(same,'claim_station',{p_role,p_pin:CODES[p_role]})));
  expect(results.filter(r=>r.ok)).toHaveLength(1); expect(results.filter(r=>r.code==='ALREADY_BOUND_OTHER_ROLE')).toHaveLength(1);
  // Ten viewing seats are claimed by twenty simultaneous phones: exactly ten win.
  const viewers=await Promise.all(Array.from({length:20},()=>identity()));
  const seats=await Promise.all(viewers.map((uid,i)=>rpc(uid,'observer_join',{p_viewer_id:'v'+i})));
  expect(seats.filter(s=>s.ok)).toHaveLength(10);
  expect(seats.filter(s=>s.code==='OBSERVER_FULL')).toHaveLength(10);
});

test('post-migration workflow: one flow, one claim-based score, guarded exceptions',async()=>{
  const ids:Record<string,string>={};
  for (const role of [...STATIONS,'SUPERVISOR','OBSERVER']) {
    ids[role]=await identity();
    if (role === 'OBSERVER') {
      // The viewing seat is taken through the presence endpoint, with no credential.
      expect((await rpc(ids[role],'observer_join',{p_viewer_id:'probe'})).ok).toBe(true);
    } else {
      expect((await rpc(ids[role],'claim_station',{p_role:role,p_pin:role==='SUPERVISOR'?PIN:CODES[role]})).ok).toBe(true);
    }
  }

  expect((await act(ids.CORRIDOR,'START_GAME')).code).toBe('PERMISSION_DENIED');
  expect((await act(ids.GATE,'START_GAME')).code).toBe('INVALID_STATE');
  // A viewer is refused before anything else is even considered.
  expect((await act(ids.OBSERVER,'CALL_TEAM')).code).toBe('READ_ONLY');
  const key=randomUUID();
  expect((await act(ids.SUPERVISOR,'CONFIGURE',{reset_target_ms:90000},key)).ok).toBe(true);
  const before=await pool.query('select count(*)::int n from sc.action_log');
  expect((await act(ids.SUPERVISOR,'CONFIGURE',{reset_target_ms:90000},key)).ok).toBe(true);
  expect((await pool.query('select count(*)::int n from sc.action_log')).rows[0].n).toBe(before.rows[0].n);

  // Only OPERATOR_01 may receive, and only one team may be in play.
  expect((await act(ids.CORRIDOR,'CALL_TEAM')).code).toBe('PERMISSION_DENIED');
  expect((await act(ids.ROOM305,'CLAIM_COMPLETE')).code).toBe('INVALID_STATE');

  for (const branch of ['WON','TIME_UP','ABORTED'] as const) {
    const lobby=ids.LOBBY;
    expect((await act(lobby,'CALL_TEAM')).ok).toBe(true);
    expect((await act(lobby,'CALL_TEAM')).ok).toBe(false);
    // Nobody but OPERATOR_02 confirms the second floor, and nothing else started.
    expect((await act(ids.GATE,'CONFIRM_FLOOR2')).code).toBe('PERMISSION_DENIED');
    expect((await act(ids.CORRIDOR,'CONFIRM_FLOOR2')).ok).toBe(true);
    expect((await act(ids.CORRIDOR,'START_GAME')).code).toBe('PERMISSION_DENIED');
    expect((await act(ids.GATE,'START_GAME')).ok).toBe(true);

    if (branch === 'WON') {
      expect((await act(ids.GATE,'CLAIM_COMPLETE')).code).toBe('PERMISSION_DENIED');
      expect((await act(ids.ROOM305,'CLAIM_COMPLETE')).ok).toBe(true);
      let claim = (await rpc(ids.GATE,'snapshot')).attempts.at(-1);
      // A rejected claim keeps its row and its timestamp; play continues.
      expect((await act(ids.ROOM305,'VERIFY_ATTEMPT',{attempt_id:claim.id,decision:'INVALID'})).ok).toBe(true);
      expect((await act(ids.ROOM305,'CLAIM_COMPLETE')).ok).toBe(true);
      claim = (await rpc(ids.GATE,'snapshot')).attempts.at(-1);
      expect((await act(ids.ROOM305,'VERIFY_ATTEMPT',{attempt_id:claim.id,decision:'VALID'})).ok).toBe(true);
      // A decided round is immutable: the same announcement cannot be judged twice,
      // which is what stops a later press from rewriting the score.
      expect((await act(ids.ROOM305,'VERIFY_ATTEMPT',{attempt_id:claim.id,decision:'INVALID'})).code).toBe('INVALID_STATE');
      await pool.query('update sc.runtime_flags set allow_test_clock=true');
      await pool.query("select set_config('request.jwt.claim.sub',$1,false)",[ids.SUPERVISOR]);
      await pool.query("update sc.runtime_flags set test_now_ms=(extract(epoch from clock_timestamp())*1000)::bigint+1");
      const won = (await rpc(ids.GATE,'snapshot')).rounds.at(-1);
      expect(won.result).toBe('WON');
      expect(Number(won.official_duration_ms)).toBeGreaterThanOrEqual(0);
      // The score is the claim instant, so it cannot equal the exit instant.
      expect(won.validated_attempt_id).toBe(claim.id);
      // Departure is a second, separate event: recording it cannot move the score.
      expect((await act(ids.GATE,'CONFIRM_EXIT')).ok).toBe(true);
      const wonOut = (await rpc(ids.GATE,'snapshot')).rounds.at(-1);
      expect(wonOut.status).toBe('EXIT_CONFIRMED');
      expect(wonOut.exit_by_role).toBe('GATE');
      expect(wonOut.official_duration_ms).toBe(won.official_duration_ms);
      expect(wonOut.result).toBe('WON');
    }
    if (branch === 'TIME_UP') {
      // Let the window lapse with nobody pressing anything: derived, not scheduled.
      await pool.query('update sc.runtime_flags set allow_test_clock=true');
      await pool.query("select set_config('request.jwt.claim.sub',$1,false)",[ids.SUPERVISOR]);
      await pool.query("update sc.runtime_flags set test_now_ms=(extract(epoch from clock_timestamp())*1000)::bigint+301000");
      const late = await act(ids.ROOM305,'CLAIM_COMPLETE');
      expect(late.ok).toBe(true);
      const claim = (await rpc(ids.GATE,'snapshot')).attempts.at(-1);
      expect(claim.in_time).toBe(false);
      expect(claim.status).toBe('LATE');
      expect((await act(ids.ROOM305,'VERIFY_ATTEMPT',{attempt_id:claim.id,decision:'VALID'})).ok).toBe(false);
      // Until somebody settles the round the stored verdict stays provisional: the
      // verdict itself is derived from the stored deadline by every device.
      const hanging = (await rpc(ids.GATE,'snapshot')).rounds.at(-1);
      expect(hanging.deadline_at).not.toBeNull();
      expect(hanging.official_duration_ms).toBeNull();
      // Letting the team out settles the derived verdict and changes nothing else.
      expect((await act(ids.GATE,'CONFIRM_EXIT')).ok).toBe(true);
      const timedOut = (await rpc(ids.GATE,'snapshot')).rounds.at(-1);
      expect(timedOut.result).toBe('TIME_UP');
      expect(timedOut.official_duration_ms).toBeNull();
    }
    if (branch === 'ABORTED') {
      expect((await act(ids.GATE,'EARLY_EXIT',{})).code).toBe('BLOCKED');
      expect((await act(ids.GATE,'EARLY_EXIT',{reason:'Khách cần y tế'})).ok).toBe(true);
      const aborted = (await rpc(ids.GATE,'snapshot')).rounds.at(-1);
      expect(aborted.result).toBe('ABORTED');
      expect(aborted.official_duration_ms).toBeNull();
    }

    const snap=await rpc(ids.ROOM305,'snapshot');
    expect((await act(ids.GATE,'GATE_FINALIZE')).ok).toBe(false);
    expect((await act(ids.GATE,'RESET_DONE')).ok).toBe(true);
    expect((await act(ids.ROOM305,'RESET_DONE')).ok).toBe(true);
    expect((await act(ids.GATE,'GATE_FINALIZE')).ok).toBe(true);
    expect(snap.rounds.at(-1).status).not.toBe('CLOSED'); // read before the closes above
  }
  // V3.1 §12.4 P0, proved on the production RPCs: a supervisor cancellation is not a
  // departure, and a claim recorded before the deadline keeps its right to be judged.
  expect((await act(ids.LOBBY,'CALL_TEAM')).ok).toBe(true);
  expect((await act(ids.CORRIDOR,'CONFIRM_FLOOR2')).ok).toBe(true);
  expect((await act(ids.GATE,'START_GAME')).ok).toBe(true);
  expect((await act(ids.ROOM305,'CLAIM_COMPLETE')).ok).toBe(true);
  const pending = (await rpc(ids.GATE,'snapshot')).attempts.at(-1);
  expect((await act(ids.SUPERVISOR,'ABORT_ROUND',{reason:'mat dien'})).code).toBe('INVALID_STATE');
  expect((await act(ids.SUPERVISOR,'ABORT_ROUND',{reason:'mat dien',kind:'technical'})).ok).toBe(true);
  const cancelled = (await rpc(ids.GATE,'snapshot')).rounds.at(-1);
  expect(cancelled.exit_confirmed_at).toBeNull();
  expect(cancelled.exit_by_role).toBeNull();
  expect(cancelled.abort_kind).toBe('technical');
  // The floor is not open for the next team, and the area is not ready, until NPC1
  // says the players are out.
  expect((await act(ids.LOBBY,'CALL_TEAM')).code).toBe('INVALID_STATE');
  expect((await act(ids.GATE,'GATE_FINALIZE')).code).toBe('INVALID_STATE');
  // No new claim on a cancelled round; the recorded one is still judgeable.
  expect((await act(ids.ROOM305,'CLAIM_COMPLETE')).code).toBe('INVALID_STATE');
  expect((await act(ids.ROOM305,'VERIFY_ATTEMPT',{attempt_id:pending.id,decision:'VALID'})).ok).toBe(true);
  const rescued = (await rpc(ids.GATE,'snapshot')).rounds.at(-1);
  expect(rescued.result).toBe('WON');
  expect(rescued.aborted_at).not.toBeNull();
  expect(Number(rescued.official_duration_ms)).toBe(
    Number(pending.claimed_at) - Number(rescued.game_started_at));
  expect((await act(ids.GATE,'CONFIRM_EXIT')).ok).toBe(true);
  expect((await act(ids.GATE,'RESET_DONE')).ok).toBe(true);
  expect((await act(ids.ROOM305,'RESET_DONE')).ok).toBe(true);
  expect((await act(ids.GATE,'GATE_FINALIZE')).ok).toBe(true);

  expect((await act(ids.LOBBY,'CALL_TEAM')).ok).toBe(true);
  const snap=await rpc(ids.GATE,'snapshot');
  // Two wins in the ledger: the loop's WON branch and the claim rescued after a
  // cancellation, each scored from its own claim instant.
  expect(snap.rounds.filter((r:{result:string})=>r.result==='WON')).toHaveLength(2);
  expect(snap.rounds.every((r:{status:string})=>r.status!=='RUNNING')).toBe(true);
  expect(snap.event.event_started_at).not.toBeNull();
  // A viewer never appears in the operator readiness list. The list is the five duty
  // roles in the order the server publishes them, so compare the set, not the order.
  expect(snap.operators.map((o:{role:string})=>o.role).sort()).toEqual(
    ['CORRIDOR','GATE','LOBBY','ROOM305','SUPERVISOR']);
});
