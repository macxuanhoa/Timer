-- Local test DB only. A team label typed after the team was already called used
-- to live only in the browser: the pencil opened an input, but no command wrote
-- anything, so every other phone kept showing TEAM #003 with no name. This file
-- proves SET_TEAM_NAME is a normal revisioned, permission-checked, idempotent and
-- audited command, and that a label submitted with CALL_TEAM is normalised too.
\set ON_ERROR_STOP on
reset role;
create function pg_temp.check_access(ok boolean, detail text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'ASSERT: %', detail; end if; end $$;

-- Own roster and event: this file must not depend on the phase 034 left behind.
update sc.operators set revoked_at = now() where revoked_at is null;
insert into auth.users(id) values
  ('ffffffff-0000-4000-8000-000000000001'),
  ('ffffffff-0000-4000-8000-000000000002'),
  ('ffffffff-0000-4000-8000-000000000003')
on conflict (id) do nothing;
insert into sc.operators (user_id, role, display_name, seat_slot) values
  ('ffffffff-0000-4000-8000-000000000001', 'LOBBY', 'Lan 035', 1),
  ('ffffffff-0000-4000-8000-000000000002', 'GATE', 'Hung 035', 1),
  ('ffffffff-0000-4000-8000-000000000003', 'SUPERVISOR', 'Mai 035', 1)
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name,
  seat_slot = excluded.seat_slot, revoked_at = null, bound_at = now();

insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
                       hidden_object_owner, hiding_layout, review_threshold_ms)
values ('Team label event', 5400000, 300000, 90000, 90000, 'CORRIDOR', 'A', 100);
update sc.state
   set event_id = (select max(id) from sc.events where name = 'Team label event'),
       revision = 0, updated_at = sc.now_ms()
 where id = true;

set role authenticated;

do $$
declare
  v jsonb;
  v_rev bigint;
  v_logs bigint;
  v_round sc.rounds;
  v_lobby text := 'ffffffff-0000-4000-8000-000000000001';
  v_gate  text := 'ffffffff-0000-4000-8000-000000000002';
  v_sup   text := 'ffffffff-0000-4000-8000-000000000003';
  v_event bigint;
  blocked boolean := false;
begin
  perform set_config('request.jwt.claim.sub', v_lobby, false);
  -- Resolve the event after the JWT claim is set: the state row is protected by
  -- operator-level RLS, so reading it earlier would yield NULL.
  select event_id into v_event from sc.state where id = true;
  select revision into v_rev from sc.events where id = v_event;
  v := public.handle_command('CALL_TEAM', jsonb_build_object('team_name', '  Ma   Tro  '), v_rev, 'team-label-call');
  perform pg_temp.check_access((v->>'ok')::boolean, 'dispatch with a draft label');
  select * into v_round from sc.rounds where event_id = v_event order by round_number desc limit 1;
  perform pg_temp.check_access(v_round.team_name = 'Ma Tro', 'dispatch label normalised');

  -- Correcting the label of the team already on the floor is the new command.
  select revision into v_rev from sc.events where id = v_event;
  v := public.handle_command('SET_TEAM_NAME', jsonb_build_object('team_name', 'Nhà Búp Bê'), v_rev, 'team-label-rename');
  perform pg_temp.check_access((v->>'ok')::boolean, 'rename acknowledged');
  perform pg_temp.check_access((v->>'revision')::bigint = v_rev + 1, 'rename bumps the shared revision');
  select * into v_round from sc.rounds where id = v_round.id;
  perform pg_temp.check_access(v_round.team_name = 'Nhà Búp Bê', 'rename stored in the round row');
  perform pg_temp.check_access((select revision from sc.state where id = true) = (v->>'revision')::bigint,
    'state pointer follows the rename');
  select count(*) into v_logs from sc.action_log where action = 'SET_TEAM_NAME';
  perform pg_temp.check_access(v_logs = 1, 'rename appends exactly one audit row');
  perform pg_temp.check_access((select actor_role = 'LOBBY' and metadata->>'team_name' = 'Nhà Búp Bê'
                                         and metadata->>'previous_team_name' = 'Ma Tro'
                                  from sc.action_log where action = 'SET_TEAM_NAME'),
    'audit row carries actor and both names');

  -- A retried tap is the same operation: no second write, no second bump.
  v := public.handle_command('SET_TEAM_NAME', jsonb_build_object('team_name', 'Nhà Búp Bê'), v_rev, 'team-label-rename');
  perform pg_temp.check_access((v->>'ok')::boolean and (v->>'message') = 'ĐÃ GHI NHẬN TRƯỚC ĐÓ', 'retry is idempotent');
  perform pg_temp.check_access((select revision from sc.events where id = v_event) = v_rev + 1, 'retry did not bump');
  perform pg_temp.check_access((select count(*) from sc.action_log where action = 'SET_TEAM_NAME') = 1, 'retry wrote no log row');

  -- A stale phone may not rename over a newer state.
  v := public.handle_command('SET_TEAM_NAME', jsonb_build_object('team_name', 'Quá Cũ'), v_rev - 1, 'team-label-stale');
  perform pg_temp.check_access(v->>'code' = 'STALE_REVISION', 'stale rename refused');
  perform pg_temp.check_access((select team_name from sc.rounds where id = v_round.id) = 'Nhà Búp Bê', 'stale rename changed nothing');

  -- Only the two stations that may dispatch a team may label it.
  perform set_config('request.jwt.claim.sub', v_gate, false);
  select revision into v_rev from sc.events where id = v_event;
  v := public.handle_command('SET_TEAM_NAME', jsonb_build_object('team_name', 'GATE gán'), v_rev, 'team-label-gate');
  perform pg_temp.check_access(v->>'code' = 'PERMISSION_DENIED', 'GATE cannot rename');

  -- A supervisor may correct the label too, and an empty string erases it.
  perform set_config('request.jwt.claim.sub', v_sup, false);
  v := public.handle_command('SET_TEAM_NAME', jsonb_build_object('team_name', 'SUP sửa'), v_rev, 'team-label-sup');
  perform pg_temp.check_access((v->>'ok')::boolean, 'supervisor may rename');
  select revision into v_rev from sc.events where id = v_event;
  v := public.handle_command('SET_TEAM_NAME', jsonb_build_object('team_name', ''), v_rev, 'team-label-clear');
  perform pg_temp.check_access((v->>'ok')::boolean, 'empty label clears');
  perform pg_temp.check_access((select team_name is null from sc.rounds where id = v_round.id), 'cleared name is null');

  -- Malformed values are refused before any write.
  select revision into v_rev from sc.events where id = v_event;
  v := public.handle_command('SET_TEAM_NAME', jsonb_build_object('team_name', repeat('x', 41)), v_rev, 'team-label-long');
  perform pg_temp.check_access(v->>'code' = 'INVALID_STATE', 'overlong label refused');
  v := public.handle_command('SET_TEAM_NAME', '{}'::jsonb, v_rev, 'team-label-missing');
  perform pg_temp.check_access(v->>'code' = 'INVALID_STATE', 'missing label refused');
  v := public.handle_command('SET_TEAM_NAME', jsonb_build_object('team_name', 42), v_rev, 'team-label-type');
  perform pg_temp.check_access(v->>'code' = 'INVALID_STATE', 'non-string label refused');

  -- The wrapper is internal: a browser must not be able to skip the public API.
  blocked := false;
  begin
    perform sc._handle_command_internal('SET_TEAM_NAME', '{}'::jsonb, 0, 'direct');
  exception when insufficient_privilege then blocked := true;
  end;
  perform pg_temp.check_access(blocked, 'internal handler is not callable by authenticated');
end $$;

-- No active round means there is nothing to label. Readiness is a direct table
-- write here only because the test harness owns the database; the browser can
-- never do this — every write below goes through the RPC again.
reset role;
update sc.rounds set status = 'GATE_CLEARED'
 where id = (select max(id) from sc.rounds where event_id = (select event_id from sc.state where id = true));
set role authenticated;

do $$
declare
  v jsonb;
  v_rev bigint;
  v_event bigint;
begin
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000001', false);
  select event_id into v_event from sc.state where id = true;
  select revision into v_rev from sc.events where id = v_event;
  v := public.handle_command('SET_TEAM_NAME', jsonb_build_object('team_name', 'Không có đội'), v_rev, 'team-label-idle');
  perform pg_temp.check_access(v->>'code' = 'INVALID_STATE', 'rename without an active round refused');
end $$;

select '035 team labels are normalised, persisted, synced, idempotent, audited and permission-checked: passed' as result;
