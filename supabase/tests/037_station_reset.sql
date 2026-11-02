-- Local test DB only. Exercises migration 0014: the secret-gated board reset.
\set ON_ERROR_STOP on
reset role;
create function pg_temp.check_access(ok boolean, detail text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'ASSERT: %', detail; end if; end $$;

delete from sc.access_rate_limits;
update sc.operators set revoked_at = now() where revoked_at is null;
insert into auth.users(id) select ('eeeeeeee-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid
from generate_series(1,10) i on conflict do nothing;

-- The button is inert until an organiser installs a secret.
select sc.configure_station_reset(null);
do $$ begin
  perform set_config('request.jwt.claim.sub','eeeeeeee-0000-4000-8000-000000000001',false);
  perform pg_temp.check_access(public.reset_all_stations('anything-whatsoever')->>'code' = 'RESET_NOT_CONFIGURED', 'reset disabled');
end $$;
select sc.configure_station_access('9876543210', false);
select sc.configure_station_reset('greenwich99');

-- Staff the whole board: four single seats plus the supervisor pair.
do $$
declare r text; i int := 0;
begin
  foreach r in array array['LOBBY','GATE','CORRIDOR','ROOM305'] loop
    i := i+1;
    perform set_config('request.jwt.claim.sub', 'eeeeeeee-0000-4000-8000-' || lpad(i::text,12,'0'), false);
    perform pg_temp.check_access((public.claim_station(r,null)->>'ok')::boolean, 'claim ' || r);
  end loop;
  for i in 5..6 loop
    perform set_config('request.jwt.claim.sub', 'eeeeeeee-0000-4000-8000-' || lpad(i::text,12,'0'), false);
    perform pg_temp.check_access((public.claim_station('SUPERVISOR','9876543210')->>'ok')::boolean, 'supervisor ' || i);
  end loop;
  perform set_config('request.jwt.claim.sub', 'eeeeeeee-0000-4000-8000-000000000007', false);
  perform pg_temp.check_access(public.claim_station('GATE',null)->>'code' = 'ROLE_TAKEN', 'board is full');
end $$;
select pg_temp.check_access((select sum(devices) from public.station_occupancy) = 6, 'six seats occupied');

-- Scoring data is snapshotted so the sweep can be proven not to touch it.
create temporary table reset_baseline as
select (select count(*) from sc.events) as events, (select count(*) from sc.rounds) as rounds,
       (select count(*) from sc.action_log) as logs, (select count(*) from sc.reset_tasks) as tasks,
       (select jsonb_agg(to_jsonb(s)) from sc.state s) as state;

-- A wrong secret is refused, changes nothing, and is counted.
do $$
declare i int;
begin
  perform set_config('request.jwt.claim.sub','eeeeeeee-0000-4000-8000-000000000007',false);
  perform pg_temp.check_access(public.reset_all_stations(null)->>'code' = 'RESET_INVALID', 'missing secret');
  perform pg_temp.check_access(public.reset_all_stations('greenwi') ->>'code' = 'RESET_INVALID', 'short wrong secret');
  for i in 1..3 loop
    perform pg_temp.check_access(public.reset_all_stations('Greenwich99')->>'code' = 'RESET_INVALID', 'case matters');
  end loop;
  perform pg_temp.check_access(public.reset_all_stations('greenwich99')->>'code' = 'RESET_RATE_LIMITED', 'five attempts per identity');
  perform pg_temp.check_access((select sum(devices) from public.station_occupancy) = 6, 'refusals free nothing');
  -- Rotating identities cannot bypass the global window.
  update sc.access_rate_limits set attempts = 10 where key = 'reset:global';
  perform set_config('request.jwt.claim.sub','eeeeeeee-0000-4000-8000-000000000008',false);
  perform pg_temp.check_access(public.reset_all_stations('greenwich99')->>'code' = 'RESET_RATE_LIMITED', 'global cycling limit');
end $$;
select sc.configure_station_reset('greenwich99');

-- The correct secret frees every station, including the supervisor pair.
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claim.sub','eeeeeeee-0000-4000-8000-000000000009',false);
  v := public.reset_all_stations('greenwich99');
  perform pg_temp.check_access((v->>'ok')::boolean and (v->>'freed')::int = 6, 'reset frees all six seats');
  perform pg_temp.check_access(public.whoami() is null, 'kicked phone lost authority');
  perform set_config('request.jwt.claim.sub','eeeeeeee-0000-4000-8000-000000000001',false);
  perform pg_temp.check_access(public.whoami() is null, 'lobby kicked too');
  perform pg_temp.check_access(public.handle_command('GAME_STOP','{}',0,'kicked-by-reset')->>'code' = 'PERMISSION_DENIED', 'kicked phone cannot command');
  perform pg_temp.check_access(public.release_device()->>'code' = 'NOT_BOUND', 'kicked phone has nothing to release');
  -- A replacement can immediately restaff the board.
  perform pg_temp.check_access((public.claim_station('LOBBY',null)->>'ok')::boolean, 'seat reusable at once');
  perform pg_temp.check_access((public.station_board()->>'devices')::int = 1, 'board counts only the new claim');
  -- Repeating the reset is safe and reports the smaller sweep.
  perform set_config('request.jwt.claim.sub','eeeeeeee-0000-4000-8000-000000000010',false);
  perform pg_temp.check_access((public.reset_all_stations('greenwich99')->>'freed')::int = 1, 'second sweep counts one seat');
  perform pg_temp.check_access((public.reset_all_stations('greenwich99')->>'freed')::int = 0, 'empty board resets to zero');
end $$;

select pg_temp.check_access((select sum(devices) from public.station_occupancy) = 0 and
  (select bool_and(devices = 0) from public.station_occupancy), 'board reads every station free');
select pg_temp.check_access((select count(*) = 0 from sc.operators where revoked_at is null), 'no live binding survives');

-- Event data, rounds, tasks and the state pointer are untouched by an access sweep.
select pg_temp.check_access(b.events = (select count(*) from sc.events) and
  b.rounds = (select count(*) from sc.rounds) and
  b.logs = (select count(*) from sc.action_log) and
  b.tasks = (select count(*) from sc.reset_tasks) and
  b.state = (select jsonb_agg(to_jsonb(s)) from sc.state s), 'reset leaves all scoring data intact')
from reset_baseline b;

-- Every refusal and the sweep itself are recorded, without the secret.
select pg_temp.check_access((select count(*) = 5 from sc.access_audit where action = 'RESET_REFUSED'
  and user_id = 'eeeeeeee-0000-4000-8000-000000000007'), 'refusals audited');
select pg_temp.check_access((select count(*) = 3 from sc.access_audit where action = 'STATIONS_RESET'
  and user_id in ('eeeeeeee-0000-4000-8000-000000000009','eeeeeeee-0000-4000-8000-000000000010')
  and metadata ->> 'freed' in ('6','1','0')), 'sweeps audited with counts');
select pg_temp.check_access(not exists (select 1 from sc.access_audit where metadata::text like '%greenwich99%'),
  'no secret in the audit trail');

-- The browser privilege boundary: only the public wrapper is callable.
set role authenticated;
do $$
declare blocked boolean := false;
begin
  begin perform sc.reset_all_stations('greenwich99'); exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'internal reset exposed'; end if;
  blocked := false;
  begin perform sc.configure_station_reset('greenwich99'); exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'reset administration exposed'; end if;
  blocked := false;
  begin select reset_secret_hash from sc.station_access_config; exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'reset hash readable'; end if;
end $$;
-- An anonymous (unsigned) caller reaches neither wrapper.
set role anon;
do $$
declare blocked boolean := false;
begin
  begin perform public.reset_all_stations('greenwich99'); exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'unsigned caller may reset'; end if;
end $$;
reset role;
select pg_temp.check_access((select supervisor_pin_hash is not null and reset_secret_hash is not null
  from sc.station_access_config where id), 'both secrets configured');
select '037 board reset: secret gate, rate limits, full sweep, data preservation, audit, RLS: passed' as result;
