-- SCREAM CONTROL — Room 305 · V2 · PASS 4
-- Executable end-to-end validation of the authoritative RPCs (migrations 0001+0002).
-- Run with:  npm run test:sql   (see scripts/validate-sql.mjs)
-- Every failing expectation raises an exception, so a clean run means the
-- production SQL behaves exactly like the tested engine.

\set ON_ERROR_STOP on

-- ------------------------------------------------------------------- seeding
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'supervisor@scream305.local'),
  ('00000000-0000-0000-0000-000000000002', 'lobby@scream305.local'),
  ('00000000-0000-0000-0000-000000000003', 'gate@scream305.local'),
  ('00000000-0000-0000-0000-000000000004', 'corridor@scream305.local'),
  ('00000000-0000-0000-0000-000000000005', 'room305@scream305.local');

insert into sc.operators (user_id, role, display_name) values
  ('00000000-0000-0000-0000-000000000001', 'SUPERVISOR', 'Mai'),
  ('00000000-0000-0000-0000-000000000002', 'LOBBY', 'Lan'),
  ('00000000-0000-0000-0000-000000000003', 'GATE', 'Hung'),
  ('00000000-0000-0000-0000-000000000004', 'CORRIDOR', 'Ngoc'),
  ('00000000-0000-0000-0000-000000000005', 'ROOM305', 'Tuan');

insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms, hidden_object_owner)
values ('SQL validation event', 5400000, 300000, 90000, 90000, 'CORRIDOR');

insert into sc.state (id, event_id, revision, updated_at)
select true, id, 0, sc.now_ms() from sc.events limit 1;

-- Test-only helper: act as one operator using the current authoritative revision.
create or replace function sc.act_as(p_uid uuid, p_action text, p_meta jsonb default '{}'::jsonb,
                                     p_key text default null)
returns jsonb
language plpgsql as $$
declare v_rev bigint;
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  select revision into v_rev from sc.events where id = (select event_id from sc.state where id = true);
  return sc.handle_command(p_action, p_meta, v_rev,
                           coalesce(p_key, 'tap-' || md5(random()::text || clock_timestamp()::text)));
end $$;

-- ------------------------------------------------------------------- session
grant execute on function sc.act_as(uuid, text, jsonb, text) to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);

do $$
declare
  v_sup constant uuid := '00000000-0000-0000-0000-000000000001';
  v_lob constant uuid := '00000000-0000-0000-0000-000000000002';
  v_gat constant uuid := '00000000-0000-0000-0000-000000000003';
  v_cor constant uuid := '00000000-0000-0000-0000-000000000004';
  v_rom constant uuid := '00000000-0000-0000-0000-000000000005';
  v jsonb; v_snap jsonb; v_round jsonb; v_rev bigint; v_count int; v_dur bigint;
begin
  -- == 1. permissions are enforced inside the database ====================
  v := sc.act_as(v_lob, 'END_EVENT');
  if v->>'code' <> 'PERMISSION_DENIED' then
    raise exception 'ASSERT 1a failed: %', v;
  end if;

  -- the retired start button can never move the clock
  v := sc.act_as(v_sup, 'START_EVENT');
  if (v->>'ok')::boolean then raise exception 'ASSERT 1b (retired start) failed: %', v; end if;
  if (select event_started_at from sc.events limit 1) is not null then
    raise exception 'ASSERT 1c (no clock before the first team) failed';
  end if;

  -- == 2. full lifecycle through the correct operators =====================
  v := sc.act_as(v_cor, 'CALL_TEAM');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 2a failed: %', v; end if;
  v := sc.act_as(v_lob, 'CALL_TEAM', '{"team_name":"Ma Tro"}');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 2b failed: %', v; end if;
  -- the first dispatch is what anchors the fixed 90-minute timeline
  if (select event_started_at from sc.events limit 1) is null then
    raise exception 'ASSERT 2b-2 (dispatch anchors the 90:00) failed';
  end if;

  -- a second team cannot be called while the area is busy
  v := sc.act_as(v_lob, 'CALL_TEAM');
  if v->>'code' <> 'INVALID_STATE' then raise exception 'ASSERT 2c failed: %', v; end if;

  v := sc.act_as(v_gat, 'START_GAME');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 2d failed: %', v; end if;
  v_snap := sc.snapshot();
  v_round := v_snap->'rounds'->0;
  if v_round->>'status' <> 'GAME_STARTED' then raise exception 'ASSERT 2e failed: %', v_round; end if;
  if (v_round->>'called_at')::bigint > (v_round->>'game_started_at')::bigint then
    raise exception 'ASSERT 2f (preparation ordering) failed';
  end if;

  v := sc.act_as(v_rom, 'ROOM_REACHED');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 2g failed: %', v; end if;

  -- == 3. puzzle completion must not stop the clock ========================
  v := sc.act_as(v_gat, 'PUZZLE_COMPLETE');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 3a failed: %', v; end if;
  v := sc.act_as(v_rom, 'PUZZLE_COMPLETE');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 3b failed: %', v; end if;
  v_round := sc.snapshot()->'rounds'->0;
  -- ->> maps a JSON null to SQL NULL, which is what the snapshot emits
  if (v_round->>'game_stopped_at') is not null then
    raise exception 'ASSERT 3c (clock still running) failed: %', v_round;
  end if;
  if (v_round->>'puzzle_completed_at') is null then raise exception 'ASSERT 3d failed: %', v_round; end if;

  v := sc.act_as(v_rom, 'RETURN_START');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 3e failed: %', v; end if;

  -- == 3b. GATE may pause/resume the flexible 5:00; the 90:00 is untouched ==
  v := sc.act_as(v_cor, 'GAME_PAUSE');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 3f failed: %', v; end if;
  v := sc.act_as(v_gat, 'GAME_PAUSE');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 3g failed: %', v; end if;
  v_round := sc.snapshot()->'rounds'->0;
  if (v_round->>'game_anchor_ms') is not null then
    raise exception 'ASSERT 3h (paused game has no running anchor) failed: %', v_round;
  end if;
  if (v_round->>'game_pause_count')::int <> 1 then raise exception 'ASSERT 3i failed: %', v_round; end if;
  v := sc.act_as(v_gat, 'GAME_RESUME');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 3j failed: %', v; end if;
  if (sc.snapshot()->'rounds'->0->>'game_anchor_ms') is null then
    raise exception 'ASSERT 3k (resumed game runs from a fresh anchor) failed';
  end if;

  -- == 4. only GATE stops the official clock, exactly once ==================
  v := sc.act_as(v_cor, 'GAME_STOP');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 4a failed: %', v; end if;
  v := sc.act_as(v_gat, 'GAME_STOP');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 4b failed: %', v; end if;
  v_round := sc.snapshot()->'rounds'->0;
  v_dur := (v_round->>'official_duration_ms')::bigint;
  if v_dur is null or v_dur < 0 then raise exception 'ASSERT 4c failed: %', v_round; end if;
  if v_round->>'status' <> 'RESETTING' then raise exception 'ASSERT 4d (resets activate immediately) failed: %', v_round; end if;

  select count(*) into v_count from sc.action_log where action = 'GAME_STOP';
  if v_count <> 1 then raise exception 'ASSERT 4e (one stop record) failed: %', v_count; end if;

  -- == 5. readiness requires every reset task ==============================
  v := sc.act_as(v_gat, 'GATE_FINALIZE');
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 5a (finalize before resets) failed: %', v; end if;

  -- a role may not confirm another role's task
  v := sc.act_as(v_rom, 'RESET_DONE');           -- room task
  if not (v->>'ok')::boolean then raise exception 'ASSERT 5b failed: %', v; end if;
  v := sc.act_as(v_rom, 'RESET_DONE', '{"task_key":"hallway"}');
  if exists (select 1 from sc.reset_tasks where task_key = 'hallway' and completed_at is not null) then
    raise exception 'ASSERT 5c (cross-role reset confirmation) failed';
  end if;

  v := sc.act_as(v_cor, 'RESET_DONE');           -- hallway + hidden objects
  if not (v->>'ok')::boolean then raise exception 'ASSERT 5d failed: %', v; end if;
  v := sc.act_as(v_cor, 'RESET_DONE');           -- double tap changes nothing
  if not (v->>'ok')::boolean then raise exception 'ASSERT 5e failed: %', v; end if;

  select count(*) into v_count from sc.reset_tasks where completed_at is null;
  if v_count <> 0 then raise exception 'ASSERT 5f (tasks incomplete) failed: %', v_count; end if;
  v := sc.act_as(v_gat, 'GATE_FINALIZE');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 5g failed: %', v; end if;

  v_snap := sc.snapshot();
  if v_snap->'rounds'->0->>'status' <> 'GATE_CLEARED' then
    raise exception 'ASSERT 5h failed: %', v_snap->'rounds'->0;
  end if;
  if jsonb_array_length(v_snap->'rounds') <> 1 then raise exception 'ASSERT 5i failed'; end if;
  if (v_snap->'rounds'->0->>'system_ready_at')::bigint < (v_snap->'rounds'->0->>'game_stopped_at')::bigint then
    raise exception 'ASSERT 5j (reset ordering) failed';
  end if;

  -- == 6. idempotency: a retried tap never writes twice =====================
  select count(*) into v_count from sc.action_log;
  v := sc.act_as(v_lob, 'CALL_TEAM', '{"team_name":"Retry"}', 'fixed-idem-key');
  v := sc.act_as(v_lob, 'CALL_TEAM', '{"team_name":"Retry"}', 'fixed-idem-key');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 6a (replay must succeed) failed: %', v; end if;
  select count(*) into v_count from sc.action_log where idempotency_key = 'fixed-idem-key';
  if v_count <> 1 then raise exception 'ASSERT 6b (duplicate log rows) failed: %', v_count; end if;
  select count(*) into v_count from sc.rounds where team_number = 2;
  if v_count <> 1 then raise exception 'ASSERT 6c (duplicate round) failed: %', v_count; end if;

  -- == 7. optimistic concurrency ============================================
  perform set_config('request.jwt.claim.sub', v_gat::text, false);
  v := sc.handle_command('TEAM_UPSTAIRS', '{}'::jsonb, 0, 'stale-key');
  if v->>'code' <> 'STALE_REVISION' then raise exception 'ASSERT 7a failed: %', v; end if;

  -- == 7b. close the second round so the area is free for the cutoff tests ==
  v := sc.act_as(v_gat, 'START_GAME');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 7b failed: %', v; end if;
  -- a restarted 5:00 is counted and withheld from the ranking until reviewed
  v := sc.act_as(v_gat, 'GAME_RESET');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 7b-2 (game reset) failed: %', v; end if;
  if (select game_reset_count from sc.rounds order by round_number desc limit 1) <> 1 then
    raise exception 'ASSERT 7b-3 (reset counted) failed';
  end if;
  if not (select needs_review from sc.rounds order by round_number desc limit 1) then
    raise exception 'ASSERT 7b-4 (reset is prize-relevant) failed';
  end if;
  v := sc.act_as(v_gat, 'GAME_STOP');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 7c failed: %', v; end if;
  v := sc.act_as(v_cor, 'RESET_DONE');
  v := sc.act_as(v_rom, 'RESET_DONE');
  v := sc.act_as(v_gat, 'GATE_FINALIZE');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 7d failed: %', v; end if;
  if exists (select 1 from sc.rounds where status <> 'GATE_CLEARED') then
    raise exception 'ASSERT 7e (an area must never stay active after finalize) failed';
  end if;

  -- == 8. append-only history is complete ===================================
  select count(*) into v_count from sc.action_log
   where at_ms is null or revision is null or idempotency_key is null or actor_role is null;
  if v_count <> 0 then raise exception 'ASSERT 8a (incomplete history rows) failed: %', v_count; end if;
  select count(distinct action) into v_count from sc.action_log;
  if v_count < 9 then raise exception 'ASSERT 8b (too few recorded actions) failed: %', v_count; end if;
  v_snap := sc.snapshot();
  if (v_snap->>'revision')::bigint <> (v_snap->'event'->>'revision')::bigint then
    raise exception 'ASSERT 8c (revision mismatch) failed';
  end if;
  if jsonb_array_length(v_snap->'operators') <> 5 then raise exception 'ASSERT 8d failed'; end if;

  -- == 9. direct table writes are refused (RLS + grants fail closed) ========
  begin
    execute 'insert into sc.rounds (event_id, round_number, team_number, status, called_at)
             select id, 990, 990, ''LOBBY_CALL'', 1 from sc.events limit 1';
    raise exception 'ASSERT 9a failed: direct insert into sc.rounds was allowed';
  exception
    when insufficient_privilege then null;
  end;
  begin
    execute 'update sc.action_log set action = ''FORGED'' where seq = 1';
    raise exception 'ASSERT 9b failed: history is mutable';
  exception
    when insufficient_privilege then null;
  end;
end $$;

-- ===================== 10. admission cutoff on the controlled clock ========
reset role;
update sc.runtime_flags set allow_test_clock = true where id = true;
set role authenticated;

do $$
declare
  v_sup constant uuid := '00000000-0000-0000-0000-000000000001';
  v_lob constant uuid := '00000000-0000-0000-0000-000000000002';
  v_gat constant uuid := '00000000-0000-0000-0000-000000000003';
  v_cor constant uuid := '00000000-0000-0000-0000-000000000004';
  v_rom constant uuid := '00000000-0000-0000-0000-000000000005';
  v jsonb; v_start bigint; v_now bigint; v_left bigint;
begin
  v_start := (select event_started_at from sc.events limit 1);
  -- jump to 6 minutes before the deadline: less than limit + allowance (6m30s)
  perform set_config('request.jwt.claim.sub', v_sup::text, false);
  perform sc.set_test_clock('set', v_start + 5400000 - 360000);
  v := sc.act_as(v_lob, 'CALL_TEAM');
  if v->>'code' <> 'BLOCKED' or (v->>'requires_override')::boolean is distinct from true then
    raise exception 'ASSERT 10a (cutoff must block the lobby) failed: %', v;
  end if;
  if v->>'message' not like '%KHÔNG NHẬN ĐỘI MỚI%' then
    raise exception 'ASSERT 10b (cutoff message) failed: %', v;
  end if;

  -- an override needs an explicit reason and is audited
  v := sc.act_as(v_sup, 'CALL_TEAM', '{"override":true}');
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 10c (override without reason) failed: %', v; end if;
  v := sc.act_as(v_sup, 'CALL_TEAM', '{"override":true,"reason":"Khach dat truoc"}');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 10d failed: %', v; end if;
  if (select admission_override from sc.rounds order by round_number desc limit 1) is not true then
    raise exception 'ASSERT 10e (override flag) failed';
  end if;
  if not exists (select 1 from sc.action_log where action = 'CALL_TEAM' and metadata->>'reason' = 'Khach dat truoc') then
    raise exception 'ASSERT 10f (audit reason) failed';
  end if;

  -- starting the game below the 5-minute rule is refused too
  perform set_config('request.jwt.claim.sub', v_sup::text, false);
  perform sc.set_test_clock('advance', 90000);   -- 4m30s remaining
  v := sc.act_as(v_gat, 'START_GAME');
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 10g (start below limit) failed: %', v; end if;
  v := sc.act_as(v_sup, 'START_GAME', '{"override":true,"reason":"Ngoai le"}');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 10h failed: %', v; end if;

  -- == 11. the deadline passes with players inside → overtime, not abort ====
  perform set_config('request.jwt.claim.sub', v_sup::text, false);
  perform sc.set_test_clock('advance', 600000);  -- well past the deadline
  v := sc.snapshot();
  if (v->'event'->>'overtime_started_at') is null then
    raise exception 'ASSERT 11a (overtime recorded) failed: %', v->'event';
  end if;
  if (v->'event'->>'event_ended_at') is not null then
    raise exception 'ASSERT 11b (event must not close while a team is inside) failed: %', v->'event';
  end if;
  if v->>'revision' is null then raise exception 'ASSERT 11c failed'; end if;

  v := sc.act_as(v_sup, 'END_EVENT');
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 11d (controlled closure) failed: %', v; end if;

  -- GATE still escorts the team out and closes the round
  v := sc.act_as(v_gat, 'GAME_STOP');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 11e failed: %', v; end if;
  v_now := sc.now_ms();
  if (select outcome from sc.rounds order by round_number desc limit 1) not in ('TIMEOUT','NO_PUZZLE','WON') then
    raise exception 'ASSERT 11e2 (outcome computed server side) failed';
  end if;
  v := sc.act_as(v_cor, 'RESET_DONE');
  v := sc.act_as(v_rom, 'RESET_DONE');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 11f failed: %', v; end if;
  v := sc.act_as(v_gat, 'GATE_FINALIZE');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 11g failed: %', v; end if;

  -- == 12. the tick never closes the event; the supervisor does ============
  v := sc.snapshot();
  if (v->'event'->>'event_ended_at') is not null then
    raise exception 'ASSERT 12a (no automatic closure) failed: %', v->'event';
  end if;
  v := sc.act_as(v_lob, 'CALL_TEAM');
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 12b (no admission after the deadline) failed: %', v; end if;
  v := sc.act_as(v_sup, 'END_EVENT', '{"reason":"Het gio"}');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 12c (controlled closure) failed: %', v; end if;

  raise notice 'snapshot revision % · now % ms · overtime check passed',
    (v->>'revision'), v_now;
end $$;

reset role;
select 'SQL validation: rounds=' || count(*) from sc.rounds;
select 'SQL validation: history=' || count(*) from sc.action_log;
select 'SQL validation: last outcome=' || outcome from sc.rounds order by round_number desc limit 1;
