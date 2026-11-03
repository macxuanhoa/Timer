-- Local test DB only. Migration 0015 boundary: the board reset is an access
-- action, never a workflow action. It refuses to run over a live 5:00, it never
-- touches the round or the physical checklist, and GIÁM SÁT confirms no reset.
\set ON_ERROR_STOP on
reset role;
create function pg_temp.check_access(ok boolean, detail text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'ASSERT: %', detail; end if; end $$;

delete from sc.access_rate_limits;
update sc.operators set revoked_at = now() where revoked_at is null;
insert into auth.users(id) select ('bbbbbbbb-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid
from generate_series(1,6) i on conflict do nothing;
insert into sc.operators (user_id, role, display_name, seat_slot) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'LOBBY',      'Lan 038', 1),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'GATE',       'Hung 038', 1),
  ('bbbbbbbb-0000-4000-8000-000000000003', 'CORRIDOR',   'Ngoc 038', 1),
  ('bbbbbbbb-0000-4000-8000-000000000004', 'ROOM305',    'Tuan 038', 1),
  ('bbbbbbbb-0000-4000-8000-000000000005', 'SUPERVISOR', 'Mai 038', 1)
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name,
  seat_slot = excluded.seat_slot, revoked_at = null, bound_at = now();

-- Own session, so no earlier scenario can block dispatch with a closed event.
insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
                       hidden_object_owner, hiding_layout, review_threshold_ms)
values ('Reset guard event', 5400000, 300000, 90000, 90000, 'CORRIDOR', 'A', 100);
update sc.state set event_id = (select max(id) from sc.events where name = 'Reset guard event'),
  revision = 0, updated_at = sc.now_ms() where id = true;

select sc.configure_station_access('9876543210', false);
select sc.configure_station_reset('greenwich99');
select pg_temp.check_access((select sum(devices) from public.station_occupancy) = 5, 'five stations bound');
select pg_temp.check_access(not exists (select 1 from sc.role_permissions
  where action = 'RESET_DONE' and role = 'SUPERVISOR'), '0015 removed supervisor reset confirmation');

set role authenticated;

-- A live clock: the board reset must be refused, and refuse without changing a thing.
do $$
declare v jsonb; v_rev bigint; v_event bigint; v_round sc.rounds;
begin
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000001', false);
  select event_id into v_event from sc.state where id = true;
  select revision into v_rev from sc.events where id = v_event;
  perform pg_temp.check_access((public.handle_command('CALL_TEAM','{}'::jsonb,v_rev,'g-call')->>'ok')::boolean, 'dispatch');
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', false);
  select revision into v_rev from sc.events where id = v_event;
  perform pg_temp.check_access((public.handle_command('START_GAME','{}'::jsonb,v_rev,'g-start')->>'ok')::boolean, '5:00 running');
  select * into v_round from sc.rounds where event_id = v_event order by id desc limit 1;
  perform pg_temp.check_access(v_round.game_stopped_at is null, 'window open');

  perform pg_temp.check_access((public.station_board()->>'game_running')::boolean, 'board publishes the live window');
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000006', false);
  v := public.reset_all_stations('greenwich99');
  perform pg_temp.check_access(v->>'code' = 'RESET_GAME_RUNNING', 'sweep refused while a team is on the clock');
  -- The public board is the only occupancy view an operator may read: sc.operators
  -- is row-protected by RLS, so counting it here would only count the caller.
  perform pg_temp.check_access((select sum(devices) from public.station_occupancy) = 5, 'refusal freed no station');
  -- Read the round back as an operator: sc.rounds is row-protected, and the
  -- unbound organiser's own claim would legitimately see nothing.
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', false);
  perform pg_temp.check_access((select game_stopped_at is null from sc.rounds where id = v_round.id), 'refusal did not stop the clock');
  perform pg_temp.check_access((select status from sc.rounds where id = v_round.id) = 'GAME_STARTED', 'refusal left the milestone');

  -- A wrong secret never reveals that a game is running.
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000005', false);
  perform pg_temp.check_access(public.reset_all_stations('greenwich98')->>'code' = 'RESET_INVALID', 'wrong secret stays wrong');
end $$;

-- GATE closes the clock. The window is over, so the sweep is allowed — and it
-- still changes nothing about the round or the pending physical checklist.
do $$
declare v jsonb; v_rev bigint; v_event bigint; v_round sc.rounds; v_duration bigint;
begin
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', false);
  select event_id into v_event from sc.state where id = true;
  select revision into v_rev from sc.events where id = v_event;
  perform pg_temp.check_access((public.handle_command('GAME_STOP','{}'::jsonb,v_rev,'g-stop')->>'ok')::boolean, 'gate chốt giờ');
  select * into v_round from sc.rounds where event_id = v_event order by id desc limit 1;
  v_duration := v_round.official_duration_ms;
  select revision into v_rev from sc.events where id = v_event;
  perform pg_temp.check_access(not (public.station_board()->>'game_running')::boolean, 'board shows the window closed');

  -- GIÁM SÁT may not confirm a physical reset any more.
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000005', false);
  v := public.handle_command('RESET_DONE', jsonb_build_object('task_key','hallway'), v_rev, 'g-sup-reset');
  perform pg_temp.check_access(v->>'code' = 'PERMISSION_DENIED', 'supervisor cannot confirm a reset');
  perform pg_temp.check_access((select completed_at is null from sc.reset_tasks
    where round_id = v_round.id and task_key = 'hallway'), 'supervisor press marked nothing');

  -- Stash the revision in a session GUC while an operator may still read it:
  -- after the sweep no binding survives, and the public views go silent.
  perform set_config('guard.rev_before',
    (select revision::text from sc.events where id = v_event), false);
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000006', false);
  v := public.reset_all_stations('greenwich99');
  perform pg_temp.check_access((v->>'ok')::boolean and (v->>'freed')::int = 5, 'sweep runs once the clock is closed');
end $$;

-- After the sweep nobody holds a binding, so the preserved workflow rows are read
-- as the database owner here; the browser could not have written them anyway.
reset role;
select pg_temp.check_access((select status = 'RESETTING' and game_stopped_at is not null
    and official_duration_ms = game_stopped_at - game_started_at and aborted_at is null
    and system_ready_at is null
  from sc.rounds where id = (select max(id) from sc.rounds)), 'sweep preserved the closed result exactly');
select pg_temp.check_access((select count(*) = 3 from sc.reset_tasks
    where round_id = (select max(id) from sc.rounds)) and
  (select count(*) = 0 from sc.reset_tasks
    where round_id = (select max(id) from sc.rounds) and completed_at is not null),
  'sweep auto-completed no physical check');
select pg_temp.check_access((select revision from sc.events where id = (select event_id from sc.state where id = true))
  = current_setting('guard.rev_before')::bigint, 'sweep wrote no event state');
set role authenticated;

-- Freed seats are re-claimable, and a new team still cannot enter until the
-- three areas have really been confirmed by their own staff.
do $$
declare v jsonb; v_rev bigint; v_event bigint;
begin
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000001', false);
  select event_id into v_event from sc.state where id = true;
  perform pg_temp.check_access((public.claim_station('LOBBY',null)->>'ok')::boolean, 'replacement LOBBY claims');
  select revision into v_rev from sc.events where id = v_event;
  v := public.handle_command('CALL_TEAM','{}'::jsonb,v_rev,'g-early-call');
  perform pg_temp.check_access(not (v->>'ok')::boolean, 'next team blocked while areas are unchecked');
  perform pg_temp.check_access(v->>'code' = 'INVALID_STATE', 'blocked as an unfinished round is active');

  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000003', false);
  perform pg_temp.check_access((public.claim_station('CORRIDOR',null)->>'ok')::boolean, 'replacement CORRIDOR claims');
  select revision into v_rev from sc.events where id = v_event;
  perform pg_temp.check_access((public.handle_command('RESET_DONE','{}'::jsonb,v_rev,'g-cor')->>'ok')::boolean, 'hallway + hidden objects');
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000004', false);
  perform pg_temp.check_access((public.claim_station('ROOM305',null)->>'ok')::boolean, 'replacement ROOM305 claims');
  select revision into v_rev from sc.events where id = v_event;
  perform pg_temp.check_access((public.handle_command('RESET_DONE','{}'::jsonb,v_rev,'g-rom')->>'ok')::boolean, 'room 305');

  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', false);
  perform pg_temp.check_access((public.claim_station('GATE',null)->>'ok')::boolean, 'replacement GATE claims');
  select revision into v_rev from sc.events where id = v_event;
  perform pg_temp.check_access((public.handle_command('GATE_FINALIZE','{}'::jsonb,v_rev,'g-final')->>'ok')::boolean, 'gate clears the area');

  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000001', false);
  select revision into v_rev from sc.events where id = v_event;
  perform pg_temp.check_access((public.handle_command('CALL_TEAM','{}'::jsonb,v_rev,'g-next')->>'ok')::boolean, 'only then the next team');
end $$;

reset role;
select pg_temp.check_access((select count(*) = 1 from sc.access_audit where action = 'STATIONS_RESET'
  and user_id = 'bbbbbbbb-0000-4000-8000-000000000006'), 'the one allowed sweep is audited');
select pg_temp.check_access((select count(*) = 1 from sc.access_audit where action = 'RESET_BLOCKED_GAME'),
  'the live-clock refusal is audited');
select '038 board reset guard: live-clock refusal, supervisor rights removed, result and checklist preserved: passed' as result;
