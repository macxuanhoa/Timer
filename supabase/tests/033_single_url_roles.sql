-- Local test DB only. Prior scenarios remain historical migration tests.
\set ON_ERROR_STOP on
reset role;
create function pg_temp.check_access(ok boolean, detail text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'ASSERT: %', detail; end if; end $$;

-- The migration must preserve the active roster left by 032.
select pg_temp.check_access((select sum(devices) from public.station_occupancy) =
  (select count(*) from sc.operators where revoked_at is null), 'migration preserved occupancy');
update sc.operators set revoked_at = now() where revoked_at is null;
select sc.configure_station_access('9876543210', false);
insert into auth.users(id) select ('dddddddd-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid
from generate_series(1,12) i on conflict do nothing;
create temporary table access_event_baseline as
select (select count(*) from sc.events) as events, (select count(*) from sc.rounds) as rounds,
       (select count(*) from sc.action_log) as logs, (select jsonb_agg(to_jsonb(s)) from sc.state s) as state,
       (select jsonb_agg(to_jsonb(e)) from sc.events e) as event_rows;

do $$
declare v jsonb; r text; i int := 0;
begin
  perform set_config('request.jwt.claim.sub', '', false);
  perform pg_temp.check_access(public.claim_station('GATE', null)->>'code' = 'NOT_AUTHENTICATED', 'unsigned claim');
  foreach r in array array['LOBBY','GATE','CORRIDOR','ROOM305'] loop
    i := i+1;
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-' || lpad(i::text,12,'0'), false);
    perform pg_temp.check_access((public.claim_station(r,null)->>'ok')::boolean, 'claim ' || r);
    perform pg_temp.check_access(public.claim_station(r,null)->>'code' = 'ALREADY_BOUND', 'idempotent claim');
    perform pg_temp.check_access(public.claim_station('SUPERVISOR','9876543210')->>'code' = 'ALREADY_BOUND_OTHER_ROLE', 'one identity one role');
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-000000000009', false);
    perform pg_temp.check_access(public.claim_station(r,null)->>'code' = 'ROLE_TAKEN', 'capacity ' || r);
  end loop;
  perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000005',false);
  perform pg_temp.check_access(public.claim_station('HACK',null)->>'code' = 'INVALID_ROLE', 'unknown role');
  perform pg_temp.check_access(public.claim_station('SUPERVISOR',null)->>'code' = 'PIN_INVALID', 'missing PIN');
  perform pg_temp.check_access(public.claim_station('SUPERVISOR','1111111111')->>'code' = 'PIN_INVALID', 'wrong PIN');
  perform pg_temp.check_access((public.claim_station('SUPERVISOR','9876543210')->>'ok')::boolean, 'supervisor one');
  perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000006',false);
  perform pg_temp.check_access((public.claim_station('SUPERVISOR','9876543210')->>'ok')::boolean, 'supervisor two');
  perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000007',false);
  perform pg_temp.check_access(public.claim_station('SUPERVISOR','9876543210')->>'code' = 'ROLE_TAKEN', 'third supervisor');
  v := public.station_board();
  perform pg_temp.check_access((v->>'devices')::int = 6 and (v->>'locked')::boolean, 'six slots full');
  perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000002',false);
  perform pg_temp.check_access(public.whoami()->>'role' = 'GATE', 'whoami restore');
  perform pg_temp.check_access((public.release_device()->>'ok')::boolean, 'release');
  perform pg_temp.check_access(public.whoami() is null, 'release removes authority');
  perform pg_temp.check_access(public.handle_command('GAME_STOP','{}',0,'released')->>'code' = 'PERMISSION_DENIED', 'released cannot act');
  perform pg_temp.check_access(public.release_device()->>'code' = 'NOT_BOUND', 'retry lost release reply');
  perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000009',false);
  perform pg_temp.check_access((public.claim_station('GATE',null)->>'ok')::boolean, 'replacement immediately claims');
  perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000005',false);
  perform public.release_device();
end $$;

-- Capacity and release are entirely separate from event state and timer data.
select pg_temp.check_access(b.events = (select count(*) from sc.events) and
 b.rounds = (select count(*) from sc.rounds) and b.logs = (select count(*) from sc.action_log) and
 b.state = (select jsonb_agg(to_jsonb(s)) from sc.state s) and
 b.event_rows = (select jsonb_agg(to_jsonb(e)) from sc.events e), 'claim/release leave all event data intact')
from access_event_baseline b;

-- Rate limiting is durable across RPC transactions; rotating UID cannot bypass global cap.
do $$
declare i int;
begin
 perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000007',false);
 for i in 1..5 loop
   perform pg_temp.check_access(public.claim_station('SUPERVISOR','1111111111')->>'code' = 'PIN_INVALID', 'PIN counted');
 end loop;
 perform pg_temp.check_access(public.claim_station('SUPERVISOR','9876543210')->>'code' = 'PIN_RATE_LIMITED', 'correct PIN cannot bypass lockout');
 update sc.access_rate_limits set attempts = 30 where key = 'global';
 perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000008',false);
 perform pg_temp.check_access(public.claim_station('SUPERVISOR','9876543210')->>'code' = 'PIN_RATE_LIMITED', 'global identity cycling limit');
end $$;
select sc.configure_station_access('8765432109', false);
select pg_temp.check_access((select count(*) = 1 from sc.operators where role='SUPERVISOR' and revoked_at is null), 'PIN rotation preserves duty phones');
do $$ begin
 perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000008',false);
 perform pg_temp.check_access(public.claim_station('SUPERVISOR','9876543210')->>'code'='PIN_INVALID', 'old PIN revoked');
 perform pg_temp.check_access((public.claim_station('SUPERVISOR','8765432109')->>'ok')::boolean, 'new PIN');
end $$;
select sc.configure_station_access(null, true);
select pg_temp.check_access((select count(*) = 0 from sc.operators where role='SUPERVISOR' and revoked_at is null), 'explicit supervisor revocation');

-- Test the actual browser privilege boundary, not just owner-issued function calls.
set role authenticated;
do $$
declare blocked boolean := false;
begin
 begin perform public.redeem_invitation(repeat('x',43),'spoof'); exception when insufficient_privilege then blocked := true; end;
 if not blocked then raise exception 'legacy public grant remains'; end if;
 blocked := false;
 begin perform sc.claim_station('SUPERVISOR','8765432109'); exception when insufficient_privilege then blocked := true; end;
 if not blocked then raise exception 'internal claim exposed'; end if;
 blocked := false;
 begin perform sc.configure_station_access('1234567890',true); exception when insufficient_privilege then blocked := true; end;
 if not blocked then raise exception 'PIN administration exposed'; end if;
 blocked := false;
 begin update public.station_occupancy set devices=0; exception when insufficient_privilege then blocked := true; end;
 if not blocked then raise exception 'occupancy writable'; end if;
 blocked := false;
 begin perform * from sc.station_access_config; exception when insufficient_privilege then blocked := true; end;
 if not blocked then raise exception 'PIN hash readable'; end if;
end $$;
set role anon;
select count(*) from public.station_occupancy;
reset role;
select pg_temp.check_access((select exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='station_occupancy')), 'Realtime publication');
select pg_temp.check_access((select supervisor_pin_hash is null from sc.station_access_config), 'PIN disabled');
select '033 role claims, capacity, identity, release, preservation, PIN rotation/rate limit, RLS: passed' as result;
