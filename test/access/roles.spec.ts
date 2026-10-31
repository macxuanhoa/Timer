import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const { Pool } = createRequire(import.meta.url)('pg');
// Deliberately fixed to loopback + a test-only database, never production env.
const pool = new Pool({ host: '127.0.0.1', port: 55436, database: 'sc305_access', user: 'postgres', password: 'postgres', max: 16 });
const PIN = '9876543210';
const roles = ['LOBBY','GATE','CORRIDOR','ROOM305'];
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
};
async function rpc(uid: string | null, name: string, body: Record<string,unknown> = {}) {
  if (!queries[name]) throw new Error('Unknown RPC');
  const args = name === 'claim_station' ? [body.p_role,body.p_pin] : name === 'handle_command' ?
    [body.p_action,body.p_meta,body.p_expected_revision,body.p_idempotency_key] : name === 'operation_status' ?
    [body.p_idempotency_key] : name === 'redeem_invitation' ? [body.p_token,body.p_device_id] : [];
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
  return {context,page, uid:()=>uid, offline:(x:boolean)=>{offline=x;}, blockBoard:(x:boolean)=>{boardBlocked=x;}, dropRelease:()=>{releaseDropAfterCommit=true;} };
}
async function claim(p: Awaited<ReturnType<typeof phone>>, role: string) {
  await p.page.getByTestId('station-'+role).click();
  if (role === 'SUPERVISOR') {
    await p.page.getByLabel('PIN quản trị',{exact:true}).fill(PIN);
    await p.page.getByRole('button',{name:'VÀO GIÁM SÁT'}).click();
  }
  await expect(p.page.getByTestId('dashboard')).toBeVisible();
}
test.beforeEach(async () => {
  await pool.query('update sc.operators set revoked_at=now() where revoked_at is null');
  await pool.query('select sc.configure_station_access($1,false)',[PIN]);
});
test.afterEach(async()=>{await Promise.all(contexts.splice(0).map(c=>c.close()));});
test.afterAll(async()=>{await pool.end();});

for (const role of roles) test(role+': root → claim → dashboard; occupied → release → replacement',async({browser})=>{
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
test('SUPERVISOR requires PIN, accepts two phones, refuses the third',async({browser})=>{
  const a=await phone(browser),b=await phone(browser),c=await phone(browser);
  await a.page.getByTestId('station-SUPERVISOR').click();
  await a.page.getByLabel('PIN quản trị',{exact:true}).fill('1111111111');
  await a.page.getByRole('button',{name:'VÀO GIÁM SÁT'}).click();
  await expect(a.page.getByRole('alert').last()).toHaveText('PIN KHÔNG ĐÚNG');
  await a.page.getByLabel('PIN quản trị',{exact:true}).fill(PIN);
  await a.page.getByRole('button',{name:'VÀO GIÁM SÁT'}).click();
  await expect(a.page.getByTestId('dashboard')).toBeVisible();
  await expect(b.page.getByTestId('station-SUPERVISOR')).toContainText('1/2');
  await claim(b,'SUPERVISOR');
  await expect(c.page.getByTestId('station-SUPERVISOR')).toContainText('2/2');
  await expect(c.page.getByTestId('station-SUPERVISOR')).toBeDisabled();
  expect((await rpc(await identity(),'claim_station',{p_role:'SUPERVISOR',p_pin:PIN})).code).toBe('ROLE_TAKEN');
  await a.page.getByTestId('return-home').click();
  await expect(c.page.getByTestId('station-SUPERVISOR')).toBeEnabled();
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
  expect((await rpc(a.uid(),'handle_command',{p_action:'GAME_STOP',p_meta:{},p_expected_revision:0,p_idempotency_key:randomUUID()})).code).toBe('PERMISSION_DENIED');
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
test('stale occupancy becomes neutral and disabled, reconnect refetches; old link cannot grant a role',async({browser})=>{
  const a=await phone(browser); a.blockBoard(true);
  await expect(a.page.getByTestId('station-GATE')).toHaveAttribute('data-state','unknown');
  await expect(a.page.getByTestId('station-GATE')).toBeDisabled();
  a.blockBoard(false); await expect(a.page.getByTestId('station-GATE')).toBeEnabled();
  await a.page.goto('/i/'+ 'x'.repeat(43));
  await expect(a.page.getByTestId('scream-home')).toBeVisible(); await expect(a.page).toHaveURL('http://127.0.0.1:5177/');
  await expect(a.page.getByTestId('station-GATE')).toBeEnabled();
  await a.page.screenshot({path:'shots/single-url-home.png',fullPage:true});
});
test('real parallel PostgreSQL transactions enforce last NPC slot, supervisor slot, same-identity exclusivity',async()=>{
  const ids=await Promise.all(Array.from({length:10},()=>identity()));
  let results=await Promise.all(ids.map(uid=>rpc(uid,'claim_station',{p_role:'GATE',p_pin:null})));
  expect(results.filter(r=>r.ok)).toHaveLength(1); expect(results.filter(r=>r.code==='ROLE_TAKEN')).toHaveLength(9);
  await rpc(await identity(),'claim_station',{p_role:'SUPERVISOR',p_pin:PIN});
  results=await Promise.all((await Promise.all(Array.from({length:8},()=>identity()))).map(uid=>rpc(uid,'claim_station',{p_role:'SUPERVISOR',p_pin:PIN})));
  expect(results.filter(r=>r.ok)).toHaveLength(1);
  const same=await identity(); results=await Promise.all(['CORRIDOR','ROOM305'].map(p_role=>rpc(same,'claim_station',{p_role,p_pin:null})));
  expect(results.filter(r=>r.ok)).toHaveLength(1); expect(results.filter(r=>r.code==='ALREADY_BOUND_OTHER_ROLE')).toHaveLength(1);
});

test('post-migration workflow cycles, failed round STOP, timeout, role/state guards and supervisor idempotency',async()=>{
  const ids:Record<string,string>={};
  for (const role of [...roles,'SUPERVISOR','SUPERVISOR2']) {
    ids[role]=await identity();
    const p_role=role==='SUPERVISOR2'?'SUPERVISOR':role;
    expect((await rpc(ids[role],'claim_station',{p_role,p_pin:p_role==='SUPERVISOR'?PIN:null})).ok).toBe(true);
  }
  const act=async(role:string,action:string,meta:Record<string,unknown>={},key=randomUUID())=>{
    const rev=await rpc(ids[role],'state_revision');
    return rpc(ids[role],'handle_command',{p_action:action,p_meta:meta,p_expected_revision:rev.revision,p_idempotency_key:key});
  };
  expect((await act('CORRIDOR','START_GAME')).code).toBe('PERMISSION_DENIED');
  expect((await act('GATE','START_GAME')).code).toBe('INVALID_STATE');
  const key=randomUUID();
  expect((await act('SUPERVISOR','CONFIGURE',{reset_target_ms:90000},key)).ok).toBe(true);
  const before=await pool.query('select count(*)::int n from sc.action_log');
  expect((await act('SUPERVISOR','CONFIGURE',{reset_target_ms:90000},key)).ok).toBe(true);
  expect((await pool.query('select count(*)::int n from sc.action_log')).rows[0].n).toBe(before.rows[0].n);
  expect((await act('SUPERVISOR2','CONFIGURE',{reset_target_ms:90000},key)).ok).toBe(true);
  expect((await pool.query('select count(*)::int n from sc.action_log')).rows[0].n).toBe(before.rows[0].n+1);
  for (const outcome of ['WON','NO_PUZZLE','TIMEOUT']) {
    expect((await act('LOBBY','CALL_TEAM')).ok).toBe(true);
    expect((await act('LOBBY','CALL_TEAM')).ok).toBe(false);
    expect((await act('GATE','START_GAME')).ok).toBe(true);
    if (outcome==='WON') {
      expect((await act('ROOM305','ROOM_REACHED')).ok).toBe(true);
      expect((await act('ROOM305','PUZZLE_COMPLETE')).ok).toBe(true);
    }
    if (outcome==='TIMEOUT') {
      await pool.query('update sc.runtime_flags set allow_test_clock=true');
      await pool.query("select set_config('request.jwt.claim.sub',$1,false)",[ids.SUPERVISOR]);
      // Set only the isolated test clock; production never enables this flag.
      await pool.query("update sc.runtime_flags set test_now_ms=(extract(epoch from clock_timestamp())*1000)::bigint+301000");
    }
    expect((await act('GATE','GAME_STOP')).ok).toBe(true);
    const snap=await rpc(ids.GATE,'snapshot');
    expect(snap.rounds.at(-1).outcome).toBe(outcome);
    expect((await act('GATE','GATE_FINALIZE')).ok).toBe(false);
    expect((await act('CORRIDOR','RESET_DONE')).ok).toBe(true);
    expect((await act('ROOM305','RESET_DONE')).ok).toBe(true);
    expect((await act('GATE','GATE_FINALIZE')).ok).toBe(true);
  }
  expect((await act('LOBBY','CALL_TEAM')).ok).toBe(true);
  const snap=await rpc(ids.GATE,'snapshot');
  expect(snap.rounds.length).toBe(4); expect(snap.event.event_started_at).not.toBeNull();
  expect(snap.rounds.filter((r:{outcome:string})=>r.outcome==='WON')).toHaveLength(1);
});
