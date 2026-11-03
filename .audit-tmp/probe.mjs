#!/usr/bin/env node
/**
 * READ-ONLY pre-production audit harness (V3).
 *
 * Spins up a disposable local PostgreSQL 16 container, applies the auth stub plus
 * every migration 0001..0016 exactly as production would, then probes the behaviour
 * the six audit items ask about. It never reads .env.local, never connects to hosted
 * Supabase, never modifies the repository and removes its container at the end.
 *
 *   node .audit-tmp/probe.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const NAME = 'sc305-audit-probe';
const PORT = 55437;
const docker = (args, input) =>
  execFileSync('docker', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
const psql = (sql) =>
  docker(['exec', '-i', '-e', 'PGCLIENTENCODING=UTF8', NAME, 'psql', '-U', 'postgres', '-d', 'sc305_audit',
    '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-F', ' | '], sql);

try { docker(['rm', '-f', NAME]); } catch { /* only our own named container */ }
docker(['run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:5432`,
  '-e', 'POSTGRES_PASSWORD=postgres', 'postgres:16-alpine']);
for (let i = 0; i < 60; i++) {
  try { docker(['exec', NAME, 'pg_isready', '-U', 'postgres']); break; }
  catch { if (i === 59) throw new Error('audit container never became ready'); await new Promise(r => setTimeout(r, 500)); }
}
docker(['exec', NAME, 'createdb', '-U', 'postgres', 'sc305_audit']);
for (const f of ['supabase/tests/000_local_auth_stub.sql',
  ...readdirSync('supabase/migrations').sort().map(x => 'supabase/migrations/' + x)]) {
  psql(readFileSync(f, 'utf8'));
}
console.log('[migrations] 0001..0016 applied to sc305_audit');

const HELPERS = `
create schema audit;
create table audit.result (nr serial, item text, ok boolean, detail text);
create table audit.id (role text primary key, sub uuid);

create or replace function audit.note(p_item text, p_ok boolean, p_detail text) returns void
language sql as $$ insert into audit.result (item, ok, detail) values (p_item, p_ok, p_detail) $$;

create or replace function audit.as(p_sub uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_sub::text, 'is_anonymous', true)::text, true);
end $$;

create or replace function audit.rev() returns bigint
language plpgsql security definer set search_path = '' as $$
begin return (sc.state_revision()->>'revision')::bigint; end $$;

create or replace function audit.cmd(p_sub uuid, p_action text, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
begin
  perform audit.as(p_sub);
  return public.handle_command(p_action, p_meta, audit.rev(), md5(random()::text || clock_timestamp()::text));
end $$;

create or replace function audit.claim(p_sub uuid, p_role text, p_pin text default null)
returns jsonb language plpgsql as $$
begin perform audit.as(p_sub); return public.claim_station(p_role, p_pin); end $$;

create or replace function audit.obs(p_sub uuid, p_viewer text) returns jsonb language plpgsql as $$
begin perform audit.as(p_sub); return public.observer_join(p_viewer); end $$;

create or replace function audit.sweep(p_sub uuid, p_secret text) returns jsonb language plpgsql as $$
begin perform audit.as(p_sub); return public.reset_all_stations(p_secret); end $$;

create or replace function audit.reset(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin return public.reset_all_stations(p_secret); end $$;

create or replace function audit.r(p_id bigint) returns jsonb
language sql security definer set search_path = '' as $$ select to_jsonb(r) from sc.rounds r where id = p_id $$;
create or replace function audit.ev() returns jsonb
language sql security definer set search_path = '' as $$ select to_jsonb(e) from sc.events e order by id limit 1 $$;
create or replace function audit.tk(p_id bigint) returns text
language sql security definer set search_path = '' as $$
  select coalesce(string_agg(task_key || ':' || required_role || '=' || (completed_at is not null)::text
    || '/c' || cycle::text, ' ' order by task_key), '')
  from sc.reset_tasks where round_id = p_id $$;
create or replace function audit.at(p_id bigint) returns text
language sql security definer set search_path = '' as $$
  select coalesce(string_agg(seq::text || ':' || claimed_at::text || ':' || status, ' ' order by seq), '')
  from sc.completion_attempts where round_id = p_id $$;
create or replace function audit.derive(p_id bigint, p_now bigint) returns jsonb
language sql security definer set search_path = '' as $$
  select sc._derive(r, p_now) from sc.rounds r where id = p_id $$;
create or replace function audit.jump(p_ms bigint) returns bigint
language sql security definer set search_path = '' as $$
  update sc.runtime_flags set allow_test_clock = true,
    test_now_ms = greatest(coalesce(test_now_ms, 0), (extract(epoch from clock_timestamp()) * 1000)::bigint + p_ms)
  returning test_now_ms
$$;
-- Always move forward from wherever the authoritative clock currently sits.
create or replace function audit.ahead(p_ms bigint) returns bigint
language sql security definer set search_path = '' as $$
  update sc.runtime_flags set allow_test_clock = true,
    test_now_ms = coalesce(test_now_ms, (extract(epoch from clock_timestamp()) * 1000)::bigint) + p_ms
  returning test_now_ms
$$;
create or replace function audit.sub(p_role text) returns uuid
language sql as $$ select sub from audit.id where role = p_role $$;
create or replace function audit.last() returns bigint
language sql security definer set search_path = '' as $$ select max(id) from sc.rounds $$;
`;

const SETUP = `
select sc.configure_station_access('9876543210', false);
select sc.configure_station_reset('greenwich99');
select sc._ensure_event();
-- Before any station is bound: can a stranger with no credential take a free slot?
do $$
declare v uuid; res jsonb;
begin
  v := gen_random_uuid(); insert into auth.users(id) values (v);
  res := audit.claim(v, 'GATE', null);
  perform audit.note('A01.station-requires-credential', (res->>'ok')::boolean is not true,
    'identity la, khong mat khau, claim GATE dang TRONG -> ok=' || coalesce(res->>'ok','?')
    || ' code=' || coalesce(res->>'code','?') || ' seat=' || coalesce(res->>'seat','?'));
  res := audit.claim(v, 'CORRIDOR', null);
  perform audit.note('A01.one-role-per-identity', res->>'code' = 'ALREADY_BOUND_OTHER_ROLE', coalesce(res->>'code','?'));
  -- Free it again so the audit can bind its own NPC1.
  perform audit.as(v);
  res := public.release_device();
end $$;
insert into audit.id (role, sub)
select r.role, gen_random_uuid() from unnest(array['LOBBY','CORRIDOR','GATE','ROOM305','SUPERVISOR']) r(role);
insert into auth.users (id) select sub from audit.id;
do $$
declare r record; res jsonb;
begin
  for r in select role, sub from audit.id order by role loop
    res := audit.claim(r.sub, r.role, case when r.role = 'SUPERVISOR' then '9876543210' end);
    perform audit.note('SET.claim ' || r.role, (res->>'ok')::boolean, coalesce(res->>'code','?'));
  end loop;
end $$;
`;

const A01 = `
do $$
declare v uuid; res jsonb; n int;
begin
  -- 1. A stranger with no credential at all takes a free station (probed in SETUP,
  --     while GATE was still unclaimed).

  -- 3. The viewer seat asks for nothing, and is remembered in audit.id.
  v := gen_random_uuid(); insert into auth.users(id) values (v);
  res := audit.obs(v, 'probe-viewer');
  insert into audit.id (role, sub) values ('OBSERVER', v);
  perform audit.note('A01.observer-no-password', (res->>'ok')::boolean,
    coalesce(res->>'code','?') || ' devices=' || coalesce(res->>'devices','?'));

  -- 4. The retained admin still needs its PIN.
  v := gen_random_uuid(); insert into auth.users(id) values (v);
  res := audit.claim(v, 'SUPERVISOR', '1111111111');
  perform audit.note('A01.supervisor-pin-enforced', res->>'code' = 'PIN_INVALID', coalesce(res->>'code','?'));

  -- 5. anon cannot even reach the RPC (probed in A01b, because SET LOCAL ROLE
  --     has to happen in its own transaction).

  select count(*) into n from sc.role_permissions where role = 'OBSERVER';
  perform audit.note('A01.observer-zero-permissions', n = 0, 'role_permissions rows=' || n);
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname in ('sc','public')
     and p.proname in ('configure_station_access','configure_station_reset','reset_all_stations','_redact','_derive','_phase_allows','_observer_sweep')
     and has_function_privilege('authenticated', p.oid, 'execute');
  perform audit.note('A01.admin-and-internal-not-granted', n = 0, 'granted=' || n
    || ' [' || coalesce((select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
                 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                 where ns.nspname in ('sc','public')
                   and p.proname in ('configure_station_access','configure_station_reset','reset_all_stations','_redact','_derive','_phase_allows','_observer_sweep')
                   and has_function_privilege('authenticated', p.oid, 'execute')), '-') || ']');
end $$;
`;

const A01B = `
do $$
declare denied boolean := false; detail text := '';
begin
  begin
    execute 'set local role anon';
    perform public.claim_station('GATE', null);
  exception when insufficient_privilege then denied := true; detail := 'insufficient_privilege';
    when others then detail := SQLSTATE || ' ' || SQLERRM;
  end;
  execute 'reset role';
  perform audit.note('A01.anon-denied', denied, 'anon goi claim_station -> ' || detail);
end $$;
`;

const A02 = `
do $$
declare rid bigint; res jsonb;
begin
  -- Put the hidden props on NPC1 so 2/3 and 1/3 are both reachable.
  res := audit.cmd(audit.sub('SUPERVISOR'), 'CONFIGURE', '{"hidden_object_owner":"GATE"}'::jsonb);
  perform audit.note('A02.owner-gate', (res->>'ok')::boolean, coalesce(res->>'message','?'));

  res := audit.cmd(audit.sub('LOBBY'), 'CALL_TEAM', '{"team_name":"Do A02"}'::jsonb);
  rid := audit.last();
  res := audit.cmd(audit.sub('CORRIDOR'), 'CONFIRM_FLOOR2');
  res := audit.cmd(audit.sub('GATE'), 'START_GAME');
  perform audit.ahead(301_000);
  res := audit.cmd(audit.sub('GATE'), 'CONFIRM_EXIT');
  perform audit.note('A02.exit-confirmed', (res->>'ok')::boolean, coalesce(res->>'message','?'));
  perform audit.note('A02.three-tasks', (select count(*) from sc.reset_tasks where round_id = rid) = 3, audit.tk(rid));

  res := audit.cmd(audit.sub('GATE'), 'GATE_FINALIZE');
  perform audit.note('A02.blocked-0of3', res->>'code' = 'BLOCKED', coalesce(res->>'message','?'));
  res := audit.cmd(audit.sub('GATE'), 'RESET_DONE');
  res := audit.cmd(audit.sub('GATE'), 'GATE_FINALIZE');
  perform audit.note('A02.blocked-2of3', res->>'code' = 'BLOCKED', coalesce(res->>'message','?') || ' [' || audit.tk(rid) || ']');
  res := audit.cmd(audit.sub('ROOM305'), 'RESET_DONE');
  res := audit.cmd(audit.sub('GATE'), 'GATE_FINALIZE');
  perform audit.note('A02.finalize-3of3', (res->>'ok')::boolean, coalesce(res->>'message','?') || ' [' || audit.tk(rid) || ']');

  -- Reopen: a mark from the old cycle is outstanding again, and 1/3 is not enough.
  res := audit.cmd(audit.sub('SUPERVISOR'), 'REOPEN_RESET',
    jsonb_build_object('round_id', rid, 'reason', 'kiem toan mo lai reset'));
  perform audit.note('A02.reopen-allowed', (res->>'ok')::boolean, coalesce(res->>'message','?'));
  res := audit.cmd(audit.sub('ROOM305'), 'RESET_DONE');
  res := audit.cmd(audit.sub('GATE'), 'GATE_FINALIZE');
  perform audit.note('A02.blocked-1of3-after-reopen', res->>'code' = 'BLOCKED',
    coalesce(res->>'message','?') || ' [' || audit.tk(rid) || ']');
  res := audit.cmd(audit.sub('GATE'), 'RESET_DONE');
  res := audit.cmd(audit.sub('GATE'), 'GATE_FINALIZE');
  perform audit.note('A02.finalize-after-reopen', (res->>'ok')::boolean, coalesce(res->>'message','?'));
  perform audit.note('A02.round-closed', (select status from sc.rounds where id = rid) = 'CLOSED',
    (select status || ' ready=' || coalesce(system_ready_at::text,'null') from sc.rounds where id = rid));

  -- No next team while the previous one is still in the area.
  res := audit.cmd(audit.sub('LOBBY'), 'CALL_TEAM', '{"team_name":"Chong"}'::jsonb);
  res := audit.cmd(audit.sub('CORRIDOR'), 'CONFIRM_FLOOR2');
  res := audit.cmd(audit.sub('GATE'), 'START_GAME');
  res := audit.cmd(audit.sub('LOBBY'), 'CALL_TEAM', '{"team_name":"Do sau"}'::jsonb);
  perform audit.note('A02.next-team-blocked-mid-round', (res->>'ok')::boolean is not true,
    coalesce(res->>'code','?') || ' / ' || coalesce(res->>'message','?'));
end $$;
`;

const A03 = `
do $$
declare rid bigint; e0 jsonb; e1 jsonb; fp0 text; fp1 text; res jsonb; n int; r record;
begin
  e0 := audit.ev();
  fp0 := (select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from sc.rounds x)
      || (select md5(coalesce(string_agg(to_jsonb(y)::text, '|' order by y.id), '')) from sc.completion_attempts y);

  -- Close the round A02 left on the clock, then run a fresh one end to end.
  perform audit.ahead(301_000);
  res := audit.cmd(audit.sub('GATE'), 'EARLY_EXIT', '{"reason":"don ca kiem toan"}'::jsonb);
  res := audit.cmd(audit.sub('GATE'), 'RESET_DONE');
  res := audit.cmd(audit.sub('ROOM305'), 'RESET_DONE');
  res := audit.cmd(audit.sub('GATE'), 'GATE_FINALIZE');

  res := audit.cmd(audit.sub('LOBBY'), 'CALL_TEAM', '{"team_name":"Do A03"}'::jsonb);
  rid := audit.last();
  res := audit.cmd(audit.sub('CORRIDOR'), 'CONFIRM_FLOOR2');
  res := audit.cmd(audit.sub('GATE'), 'START_GAME');
  res := audit.cmd(audit.sub('ROOM305'), 'CLAIM_COMPLETE');
  perform audit.ahead(301_000);
  res := audit.cmd(audit.sub('GATE'), 'CONFIRM_EXIT');
  -- Settle the verdict, otherwise the round legitimately stays open and blocks the
  -- board sweep checked below.
  res := audit.cmd(audit.sub('ROOM305'), 'VERIFY_ATTEMPT',
    jsonb_build_object('attempt_id',
      (select id from sc.completion_attempts where round_id = rid order by seq desc limit 1), 'decision', 'VALID'));
  res := audit.cmd(audit.sub('GATE'), 'RESET_DONE');
  res := audit.cmd(audit.sub('ROOM305'), 'RESET_DONE');
  res := audit.cmd(audit.sub('GATE'), 'GATE_FINALIZE');

  e1 := audit.ev();
  perform audit.note('A03.event-clock-untouched-by-round',
    e0->>'event_started_at' = e1->>'event_started_at' and e1->>'event_ended_at' is null,
    'started ' || coalesce(e0->>'event_started_at','null') || ' -> ' || coalesce(e1->>'event_started_at','null'));
  perform audit.note('A03.durations-intact',
    (e1->>'duration_ms')::bigint = 5_400_000 and (e1->>'game_limit_ms')::bigint = 300_000,
    'event=' || coalesce(e1->>'duration_ms','?') || ' game=' || coalesce(e1->>'game_limit_ms','?'));
  perform audit.note('A03.deadline-is-300s',
    (select deadline_at - game_started_at from sc.rounds where id = rid) = 300_000,
    (select game_started_at || ' -> ' || deadline_at from sc.rounds where id = rid));

  -- The board sweep is access-only: fingerprint immediately before and after it.
  fp0 := (select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from sc.rounds x)
      || (select md5(coalesce(string_agg(to_jsonb(y)::text, '|' order by y.id), '')) from sc.completion_attempts y)
      || (select md5(coalesce(string_agg(to_jsonb(z)::text, '|' order by z.round_id, z.task_key), '')) from sc.reset_tasks z);
  e0 := audit.ev();
  res := audit.reset('greenwich99');
  perform audit.note('A03.sweep-ran', (res->>'ok')::boolean,
    'code=' || coalesce(res->>'code','?') || ' freed=' || coalesce(res->>'freed','?')
    || ' msg=' || coalesce(res->>'message','?'));
  -- The sweep revokes every binding, so put them back before the next sections.
  for r in select role, sub from audit.id loop
    res := audit.claim(r.sub, r.role, case when r.role = 'SUPERVISOR' then '9876543210' end);
  end loop;
  fp1 := (select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from sc.rounds x)
      || (select md5(coalesce(string_agg(to_jsonb(y)::text, '|' order by y.id), '')) from sc.completion_attempts y)
      || (select md5(coalesce(string_agg(to_jsonb(z)::text, '|' order by z.round_id, z.task_key), '')) from sc.reset_tasks z);
  e1 := audit.ev();
  perform audit.note('A03.sweep-keeps-clocks-and-results',
    e0->>'event_started_at' = e1->>'event_started_at' and e0->>'event_ended_at' = e1->>'event_ended_at'
      and fp0 = fp1,
    'rounds+claims+tasks ' || left(fp0, 10) || ' vs ' || left(fp1, 10)
      || ' | event ' || coalesce(e0->>'event_started_at','null') || ' vs ' || coalesce(e1->>'event_started_at','null'));

  -- 90:00 has no automatic behaviour anywhere.
  perform audit.ahead(90 * 60_000 + 600_000);
  select count(*) into n from sc.events where event_ended_at is not null;
  perform audit.note('A03.no-auto-session-end', n = 0, 'events with event_ended_at=' || n);
  select count(*) into n from sc.events
   where closing_warned_at is not null or end_warned_at is not null or overtime_started_at is not null;
  perform audit.note('A03.session-warning-stamps-dead', n = 0,
    'closing/end/overtime stamps=' || n);
  res := audit.cmd(audit.sub('LOBBY'), 'CALL_TEAM', '{"team_name":"Dang choi"}'::jsonb);
  res := audit.cmd(audit.sub('SUPERVISOR'), 'END_EVENT', '{"reason":""}'::jsonb);
  perform audit.note('A04.end-event-needs-reason', res->>'code' = 'BLOCKED', coalesce(res->>'message','?'));
  res := audit.cmd(audit.sub('SUPERVISOR'), 'END_EVENT', '{"reason":"thong ca"}'::jsonb);
  perform audit.note('A04.end-event-blocked-while-round-open', res->>'code' = 'BLOCKED', coalesce(res->>'message','?'));
end $$;
`;

const A03B = `
do $$
declare res jsonb; b jsonb; n int;
begin
  -- A round that finished the normal way (claim verified, exit confirmed, closed)
  -- never gets a game_stopped_at stamp. Check whether that freezes the board sweep.
  select count(*) into n from sc.rounds
   where status = 'CLOSED' and game_started_at is not null and game_stopped_at is null;
  perform audit.note('A03.closed-rounds-without-stopped-stamp', n = 0,
    'so round CLOSED ma game_stopped_at = null: ' || n);
  b := public.station_board();
  res := audit.sweep((select sub from audit.id where role = 'SUPERVISOR'), 'greenwich99');
  perform audit.note('A03.sweep-allowed-after-normal-finish', (res->>'ok')::boolean,
    'board game_running=' || coalesce(b->>'game_running','?')
    || ' | RPC=' || coalesce(res->>'code','?') || ' freed=' || coalesce(res->>'freed','?'));
  -- put the bindings back for whatever follows
  declare r record;
  begin
    for r in select role, sub from audit.id loop
      res := audit.claim(r.sub, r.role, case when r.role = 'SUPERVISOR' then '9876543210' end);
    end loop;
  end;
end $$;
`;

const A04 = `
do $$
declare actions text[] := array['REVIEW_RESOLVE','CORRECT_ROUND','REOPEN_RESET','ABORT_ROUND','END_EVENT','CONFIGURE'];
        a text; res jsonb; rid bigint; st bigint; dl bigint; nd bigint; att0 text; att1 text; n int;
begin
  for a in select unnest(actions) loop
    res := audit.cmd(audit.sub('OBSERVER'), a);
    perform audit.note('A04.observer-denied.' || a, res->>'code' = 'READ_ONLY', coalesce(res->>'code','?'));
    res := audit.cmd(audit.sub('ROOM305'), a);
    perform audit.note('A04.npc2-denied.' || a, res->>'code' = 'PERMISSION_DENIED', coalesce(res->>'code','?'));
    res := audit.cmd(audit.sub('LOBBY'), a);
    perform audit.note('A04.lobby-denied.' || a, res->>'code' = 'PERMISSION_DENIED', coalesce(res->>'code','?'));
  end loop;

  select id into rid from sc.rounds where game_started_at is not null order by id desc limit 1;
  res := audit.cmd(audit.sub('SUPERVISOR'), 'CONFIGURE', '{"game_limit_ms":60000}');
  perform audit.note('A04.configure-cannot-move-game-limit', (res->>'ok')::boolean is not true,
    coalesce(res->>'code','?') || ' / ' || coalesce(res->>'message','?'));
  res := audit.cmd(audit.sub('SUPERVISOR'), 'CONFIGURE', '{"event_duration_ms":1000}');
  perform audit.note('A04.configure-cannot-move-event-duration', (res->>'ok')::boolean is not true,
    coalesce(res->>'code','?') || ' / ' || coalesce(res->>'message','?'));

  res := audit.cmd(audit.sub('SUPERVISOR'), 'CORRECT_ROUND',
    jsonb_build_object('round_id', rid, 'field', 'game_started_at', 'value_ms', 1));
  perform audit.note('A04.correct-needs-reason', res->>'code' = 'BLOCKED', coalesce(res->>'message','?'));
  res := audit.cmd(audit.sub('SUPERVISOR'), 'CORRECT_ROUND',
    jsonb_build_object('round_id', rid, 'field', 'official_duration_ms', 'value_ms', 1, 'reason', 'thu'));
  perform audit.note('A04.correct-field-whitelist', (res->>'ok')::boolean is not true,
    coalesce(res->>'code','?') || ' / ' || coalesce(res->>'message','?'));
  res := audit.cmd(audit.sub('SUPERVISOR'), 'CORRECT_ROUND',
    jsonb_build_object('round_id', rid, 'field', 'claimed_at', 'value_ms', 1, 'reason', 'thu'));
  perform audit.note('A04.correct-cannot-touch-claims', (res->>'ok')::boolean is not true,
    coalesce(res->>'code','?') || ' / ' || coalesce(res->>'message','?'));

  att0 := audit.at(rid);
  select game_started_at, deadline_at into st, dl from sc.rounds where id = rid;
  res := audit.cmd(audit.sub('SUPERVISOR'), 'CORRECT_ROUND',
    jsonb_build_object('round_id', rid, 'field', 'game_started_at', 'value_ms', st + 5000, 'reason', 'muon 5s'));
  select deadline_at into nd from sc.rounds where id = rid;
  att1 := audit.at(rid);
  perform audit.note('A04.correct-moves-deadline-with-start',
    (res->>'ok')::boolean and nd = dl + 5000, dl || ' -> ' || nd);
  perform audit.note('A04.correct-leaves-claims-untouched', att0 = att1, att0 || '  ||  ' || att1);
  perform audit.note('A04.correct-flags-review', (select needs_review from sc.rounds where id = rid),
    (select coalesce(array_to_string(review_reasons,','),'') from sc.rounds where id = rid));
  res := audit.cmd(audit.sub('SUPERVISOR'), 'CORRECT_ROUND',
    jsonb_build_object('round_id', rid, 'field', 'game_started_at', 'value_ms', st, 'reason', 'tra lai'));

  res := audit.cmd(audit.sub('SUPERVISOR'), 'REVIEW_RESOLVE',
    jsonb_build_object('round_id', rid, 'decision', 'MAYBE', 'reason', 'thu sai'));
  perform audit.note('A04.review-decision-validated', (res->>'ok')::boolean is not true,
    coalesce(res->>'code','?') || ' / ' || coalesce(res->>'message','?'));
  res := audit.cmd(audit.sub('SUPERVISOR'), 'REVIEW_RESOLVE',
    jsonb_build_object('round_id', rid, 'decision', 'ACCEPT', 'reason', 'duyet'));
  perform audit.note('A04.review-resolve-accept', (res->>'ok')::boolean, coalesce(res->>'message','?'));
  res := audit.cmd(audit.sub('SUPERVISOR'), 'REVIEW_RESOLVE',
    jsonb_build_object('round_id', rid, 'decision', 'REJECT', 'reason', 'duyet lan nua'));
  perform audit.note('A04.review-resolve-needs-open-review', (res->>'ok')::boolean is not true,
    coalesce(res->>'code','?') || ' / ' || coalesce(res->>'message','?'));
  select count(*) into n from sc.action_log where action in ('CORRECT_ROUND','REVIEW_RESOLVE','REOPEN_RESET');
  perform audit.note('A04.admin-actions-audited', n >= 3, 'log rows=' || n);
  -- Dead admin surface that still has permission rows.
  res := audit.cmd(audit.sub('SUPERVISOR'), 'OVERTIME_STARTED', '{"reason":"muon gio"}'::jsonb);
  perform audit.note('A04.overtime-surface-inert', (res->>'ok')::boolean is not true,
    coalesce(res->>'code','?') || ' / ' || coalesce(res->>'message','?'));
  res := audit.cmd(audit.sub('SUPERVISOR'), 'OVERRIDE_ADMIT', '{"reason":"th"}'::jsonb);
  perform audit.note('A04.override-admit-inert', (res->>'ok')::boolean is not true,
    coalesce(res->>'code','?') || ' / ' || coalesce(res->>'message','?'));
end $$;
`;

const A05 = `
do $$
declare rid bigint; att text; res jsonb; j bigint;
begin
  /* Case 1 - claim in time, verified after the clock died and after the exit. */
  res := audit.cmd(audit.sub('LOBBY'), 'CALL_TEAM', '{"team_name":"Cho xet"}'::jsonb);
  rid := audit.last();
  res := audit.cmd(audit.sub('GATE'), 'FLOOR2_BYPASS', '{"reason":"doi da o tang 3"}'::jsonb);
  res := audit.cmd(audit.sub('GATE'), 'START_GAME');
  res := audit.cmd(audit.sub('ROOM305'), 'CLAIM_COMPLETE');
  j := audit.ahead(301_000);
  perform audit.note('A05.pending-validation-derived',
    (audit.derive(rid, j)->>'live') = 'TIME_EXPIRED_PENDING_VALIDATION',
    'live=' || coalesce(audit.derive(rid, j)->>'live','?') || ' result=' || coalesce(audit.derive(rid, j)->>'result','?'));
  res := audit.cmd(audit.sub('GATE'), 'CONFIRM_EXIT');
  perform audit.note('A05.exit-allowed-while-pending', (res->>'ok')::boolean, coalesce(res->>'message','?'));
  res := audit.cmd(audit.sub('GATE'), 'GATE_FINALIZE');
  perform audit.note('A05.closure-blocked-while-pending', res->>'code' = 'BLOCKED', coalesce(res->>'message','?'));
  res := audit.cmd(audit.sub('ROOM305'), 'VERIFY_ATTEMPT',
    jsonb_build_object('attempt_id',
      (select id from sc.completion_attempts where round_id = rid order by seq desc limit 1), 'decision', 'VALID'));
  perform audit.note('A05.late-verification-still-wins', (res->>'ok')::boolean, coalesce(res->>'message','?'));
  perform audit.note('A05.score-is-the-claim-instant',
    (select official_duration_ms from sc.rounds where id = rid) =
    (select a.claimed_at - r.game_started_at from sc.rounds r join sc.completion_attempts a on a.round_id = r.id
      where r.id = rid and a.status = 'VALID'),
    (select 'official=' || coalesce(official_duration_ms::text,'null') from sc.rounds where id = rid)
    || ' ' || audit.at(rid));

  /* Case 2 - NPC1's guarded early exit: the departure is stated by the action itself. */
  res := audit.cmd(audit.sub('GATE'), 'RESET_DONE');
  res := audit.cmd(audit.sub('ROOM305'), 'RESET_DONE');
  res := audit.cmd(audit.sub('GATE'), 'GATE_FINALIZE');
  res := audit.cmd(audit.sub('LOBBY'), 'CALL_TEAM', '{"team_name":"Roi som"}'::jsonb);
  rid := audit.last();
  res := audit.cmd(audit.sub('CORRIDOR'), 'CONFIRM_FLOOR2');
  res := audit.cmd(audit.sub('GATE'), 'START_GAME');
  res := audit.cmd(audit.sub('GATE'), 'EARLY_EXIT', '{"reason":"khach xin ra"}'::jsonb);
  perform audit.note('A05.early-exit-aborts',
    (select result from sc.rounds where id = rid) = 'ABORTED',
    'official=' || coalesce((select official_duration_ms::text from sc.rounds where id = rid), 'null'));
  perform audit.note('A05.early-exit-exit-by-gate',
    (select exit_by_role from sc.rounds where id = rid) = 'GATE',
    coalesce((select exit_by_role from sc.rounds where id = rid), 'null'));

  /* Case 3 - the supervisor's remote cancel must NOT invent a physical departure. */
  res := audit.cmd(audit.sub('GATE'), 'RESET_DONE');
  res := audit.cmd(audit.sub('ROOM305'), 'RESET_DONE');
  res := audit.cmd(audit.sub('GATE'), 'GATE_FINALIZE');
  res := audit.cmd(audit.sub('LOBBY'), 'CALL_TEAM', '{"team_name":"Bi huy"}'::jsonb);
  rid := audit.last();
  res := audit.cmd(audit.sub('CORRIDOR'), 'CONFIRM_FLOOR2');
  res := audit.cmd(audit.sub('GATE'), 'START_GAME');
  res := audit.cmd(audit.sub('ROOM305'), 'CLAIM_COMPLETE');
  att := audit.at(rid);
  res := audit.cmd(audit.sub('SUPERVISOR'), 'ABORT_ROUND', '{"reason":"can thiep tu xa"}'::jsonb);
  perform audit.note('A05.abort-sets-aborted',
    (res->>'ok')::boolean and (select result from sc.rounds where id = rid) = 'ABORTED',
    coalesce(res->>'message','?'));
  perform audit.note('A05.abort-must-not-stamp-exit',
    (select exit_confirmed_at from sc.rounds where id = rid) is null,
    'exit_confirmed_at=' || coalesce((select exit_confirmed_at::text from sc.rounds where id = rid), 'null')
    || ' exit_by_role=' || coalesce((select exit_by_role from sc.rounds where id = rid), 'null'));
  res := audit.cmd(audit.sub('ROOM305'), 'VERIFY_ATTEMPT',
    jsonb_build_object('attempt_id',
      (select id from sc.completion_attempts where round_id = rid order by seq desc limit 1), 'decision', 'VALID'));
  perform audit.note('A05.abort-keeps-pending-claim-verifiable', (res->>'ok')::boolean,
    coalesce(res->>'code','?') || ' / ' || coalesce(res->>'message','?') || ' claims: ' || att);
  res := audit.cmd(audit.sub('GATE'), 'GATE_FINALIZE');
  perform audit.note('A05.abort-still-needs-exit-or-reset', (res->>'ok')::boolean is not true,
    coalesce(res->>'code','?') || ' / ' || coalesce(res->>'message','?'));
  -- And can the flow still reach "ready for the next team" on that fabricated exit?
  res := audit.cmd(audit.sub('GATE'), 'RESET_DONE');
  res := audit.cmd(audit.sub('ROOM305'), 'RESET_DONE');
  res := audit.cmd(audit.sub('GATE'), 'GATE_FINALIZE');
  perform audit.note('A05.abort-needs-floor-exit-before-ready', (res->>'ok')::boolean is not true,
    'finalize sau ABORT (khong ai xac nhan roi khu vuc) -> ok=' || coalesce(res->>'ok','?')
    || ' status=' || coalesce((select status from sc.rounds where id = rid), '?'));
end $$;
`;

const A01C = `
do $$
declare res jsonb; n int;
begin
  -- Can a viewer wipe the duty board? The sweep is secret-gated, not role-gated.
  res := audit.sweep((select sub from audit.id where role = 'OBSERVER'), 'greenwich99');
  perform audit.note('A01.observer-cannot-sweep-board', (res->>'ok')::boolean is not true,
    'OBSERVER goi reset_all_stations -> ok=' || coalesce(res->>'ok','?')
    || ' freed=' || coalesce(res->>'freed','?') || ' code=' || coalesce(res->>'code','?'));
  select count(*) into n from sc.operators where revoked_at is null and role <> 'OBSERVER';
  perform audit.note('A01.bindings-after-probe', n = 5, 'bindings còn lại=' || n);
end $$;
`;

const REPORT = `
select nr || '. ' || item || ' :: ' || case when ok then 'PASS' else '**FAIL**' end || ' :: ' || coalesce(detail,'')
from audit.result order by nr;
`;

const lines = [];
for (const [label, sql] of [['helpers', HELPERS], ['setup', SETUP], ['A01', A01], ['A01b', A01B], ['A02', A02],
  ['A03', A03], ['A03b', A03B], ['A04', A04], ['A05', A05], ['A01c', A01C], ['report', REPORT]]) {
  try {
    const r = psql(sql);
    if (label === 'report') lines.push(r.trim());
    else console.log(`[${label}] ok`);
  } catch (err) {
    lines.push(`[${label}] SQL ERROR: ${String(err.message ?? err).split('\n').slice(0, 6).join(' / ')}`);
    break;
  }
}
console.log(lines.join('\n'));
try { docker(['rm', '-f', NAME]); console.log('\n[container removed]'); } catch { /* kept for inspection */ }
