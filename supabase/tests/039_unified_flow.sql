-- Local SQL validation only (scenario 039): the unified V3 flow, end to end.
-- Everything here runs inside one transaction and is rolled back.
\set ON_ERROR_STOP on
reset role;

begin;

update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.observer_seats;
insert into auth.users(id) values
  ('22222222-0000-4000-8000-000000000001'),  -- OPERATOR_01 (LOBBY)
  ('22222222-0000-4000-8000-000000000002'),  -- OPERATOR_02 (CORRIDOR)
  ('22222222-0000-4000-8000-000000000003'),  -- NPC1 (GATE)
  ('22222222-0000-4000-8000-000000000004'),  -- NPC2 (ROOM305)
  ('22222222-0000-4000-8000-000000000005'),  -- SUPERVISOR
  ('22222222-0000-4000-8000-000000000006'),  -- viewer
  ('22222222-0000-4000-8000-000000000007'),  -- viewer 2 (retired claim)
  ('22222222-0000-4000-8000-000000000008')   -- spare identity for capacity checks
on conflict (id) do nothing;

insert into sc.operators (user_id, role, display_name, seat_slot) values
  ('22222222-0000-4000-8000-000000000001', 'LOBBY',      'T01', 1),
  ('22222222-0000-4000-8000-000000000002', 'CORRIDOR',   'T02', 1),
  ('22222222-0000-4000-8000-000000000003', 'GATE',       'TN1', 1),
  ('22222222-0000-4000-8000-000000000004', 'ROOM305',    'TN2', 1),
  ('22222222-0000-4000-8000-000000000005', 'SUPERVISOR', 'TSV', 1)
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name,
  seat_slot = excluded.seat_slot, revoked_at = null, bound_at = now();

-- A dedicated event, so this scenario owns the state pointer entirely.
insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
                      hidden_object_owner, hiding_layout, review_threshold_ms, stall_warn_ms)
values ('Unified flow 039', 5400000, 300000, 90000, 90000, 'ROOM305', 'A', 500, 60000);
update sc.events set event_started_at = null, event_ended_at = null, next_team_number = 1
 where name = 'Unified flow 039';
update sc.state
   set event_id = (select id from sc.events where name = 'Unified flow 039'),
       revision = 0, updated_at = sc.now_ms()
 where id = true;
delete from sc.rounds where event_id = (select id from sc.events where name = 'Unified flow 039');

-- The permission table is the V3 matrix, and OBSERVER holds nothing at all.
do $$
begin
  if exists (select 1 from sc.role_permissions where role = 'OBSERVER') then
    raise exception 'ASSERT 039perm: OBSERVER must hold no permission row';
  end if;
  if (select count(*) from sc.role_permissions where action = 'START_GAME') <> 1
     or not exists (select 1 from sc.role_permissions where action = 'START_GAME' and role = 'GATE') then
    raise exception 'ASSERT 039perm2: only NPC1 may start the countdown';
  end if;
  if exists (select 1 from sc.role_permissions where action in
      ('TEAM_UPSTAIRS','GAME_PAUSE','GAME_RESUME','GAME_RESET','HALLWAY_PROGRESS',
       'ROOM_REACHED','PUZZLE_COMPLETE','RETURN_START','GAME_STOP')) then
    raise exception 'ASSERT 039perm3: retired controls must have no authority';
  end if;
  if exists (select 1 from sc.role_permissions where action = 'CONFIRM_FLOOR2' and role <> 'CORRIDOR') then
    raise exception 'ASSERT 039perm4: only OPERATOR_02 confirms floor 2';
  end if;
end $$;

set local role authenticated;

-- ------------------------------------------------------------------ the flow
do $$
declare v jsonb; rev bigint; claim bigint; round jsonb;
begin
  -- 1. OPERATOR_01 receives the team. Nobody else may.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000003', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{}'::jsonb, rev, '039-call-gate');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 039a: NPC1 must not receive teams: %', v; end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000001', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{"team_name":"Phantom 05"}'::jsonb, rev, '039-call');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039b: reception failed: %', v; end if;
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{}'::jsonb, rev, '039-call-again');
  if v->>'code' <> 'INVALID_STATE' then raise exception 'ASSERT 039c: a second team must be refused: %', v; end if;

  -- 2. Only OPERATOR_02 confirms the physical arrival; the clock is untouched.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000004', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_FLOOR2', '{}'::jsonb, rev, '039-f2-by-npc2');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 039d: NPC2 must not confirm floor 2: %', v; end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000002', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_FLOOR2', '{}'::jsonb, rev, '039-f2');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039e: floor 2 confirmation failed: %', v; end if;

  -- 3. Only NPC1 starts, and the deadline is stored with the start.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000002', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('START_GAME', '{}'::jsonb, rev, '039-start-by-02');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 039f: OPERATOR_02 must not start: %', v; end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000003', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('START_GAME', '{}'::jsonb, rev, '039-start');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039g: START failed: %', v; end if;
  round := public.snapshot()->'rounds'->-1;
  if round->>'status' <> 'RUNNING' or (round->>'deadline_at')::bigint
       <> (round->>'game_started_at')::bigint + 300000 then
    raise exception 'ASSERT 039h: the deadline is not start + 300 s: %', round;
  end if;
  if round->>'started_by_role' <> 'GATE' then raise exception 'ASSERT 039i: NPC1 must own the start: %', round; end if;

  -- 4. The retired buttons are refused: no permission row exists for them, so they
  -- never reach the workflow at all (UNKNOWN_ACTION is the other honest answer).
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000003', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('GAME_STOP', '{}'::jsonb, rev, '039-retired');
  if (v->>'ok')::boolean or v->>'code' not in ('UNKNOWN_ACTION','PERMISSION_DENIED') then
    raise exception 'ASSERT 039j: a retired STOP must not pass: %', v;
  end if;
  v := public.handle_command('GAME_PAUSE', '{}'::jsonb, rev, '039-retired-pause');
  if (v->>'ok')::boolean or v->>'code' not in ('UNKNOWN_ACTION','PERMISSION_DENIED') then
    raise exception 'ASSERT 039k: the countdown must not pause: %', v;
  end if;
  -- The clock is untouched by both refusals.
  if (public.snapshot()->'rounds'->-1->>'status') <> 'RUNNING' then
    raise exception 'ASSERT 039k2: a refused press changed the clock';
  end if;

  -- 5. NPC2 records a claim; the countdown keeps running.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000003', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CLAIM_COMPLETE', '{}'::jsonb, rev, '039-claim-by-npc1');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 039l: only NPC2 may record a claim: %', v; end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000004', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CLAIM_COMPLETE', '{}'::jsonb, rev, '039-claim-1');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039m: claim failed: %', v; end if;
  claim := (select (public.snapshot()->'attempts'->-1->>'id')::bigint);
  round := public.snapshot()->'rounds'->-1;
  if round->>'status' <> 'RUNNING' then raise exception 'ASSERT 039n: the clock stopped on a claim: %', round; end if;

  -- The claim is rejected: its row stays, its timestamp stays, play continues.
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('VERIFY_ATTEMPT',
        jsonb_build_object('attempt_id', claim, 'decision', 'INVALID'), rev, '039-invalid');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039o: rejecting a claim failed: %', v; end if;
  if public.snapshot()->'attempts'->-1->>'status' <> 'INVALID' then
    raise exception 'ASSERT 039p: the rejected claim was not kept';
  end if;

  -- A second, correct claim: the official time is that claim's own instant.
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CLAIM_COMPLETE', '{}'::jsonb, rev, '039-claim-2');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039q: second claim failed: %', v; end if;
  round := public.snapshot()->'rounds'->-1;
  claim := (select (public.snapshot()->'attempts'->-1->>'id')::bigint);
  -- Scenario B, written as data rather than as a command: the announcement landed 95 s
  -- into the round, and NPC2 is still at the arrangement when the 300 s run out.
  reset role;
  update sc.rounds
     set game_started_at = sc.now_ms() - 100000, deadline_at = sc.now_ms() - 1
   where id = (round->>'id')::bigint;
  update sc.completion_attempts
     set claimed_at = sc.now_ms() - 5000, elapsed_ms = 95000, remaining_ms = 4999, in_time = true
   where id = claim;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000004', true);

  -- Past the deadline with an open eligible claim: provisional, never a failure. The
  -- stored row still says RUNNING; the derived phase is what makes the difference.
  if (public.snapshot()->'rounds'->-1->>'status') <> 'RUNNING' then
    raise exception 'ASSERT 039r: stored status must stay RUNNING for the derivation';
  end if;
  -- The internal helper is not callable by a station, so the same derivation is read
  -- back through the public snapshot the client actually consumes.
  reset role;
  if (select sc._derive(r, sc.now_ms())->>'result' from sc.rounds r
       where r.id = (round->>'id')::bigint) <> 'PENDING_VALIDATION' then
    raise exception 'ASSERT 039r2: an open in-time claim must not read as TIME UP';
  end if;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000004', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('VERIFY_ATTEMPT',
        jsonb_build_object('attempt_id', claim, 'decision', 'VALID'), rev, '039-valid');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039s: validating the in-time claim failed: %', v; end if;
  round := public.snapshot()->'rounds'->-1;
  if round->>'result' <> 'WON' then raise exception 'ASSERT 039t: the win was not finalised: %', round; end if;
  -- 95 s of play, not the 100 s that had elapsed when NPC2 finally pressed.
  if (round->>'official_duration_ms')::bigint <> 95000 then
    raise exception 'ASSERT 039u: the score is not the claim instant: %', round;
  end if;
  -- The verification delay is audited apart, and never becomes the score.
  reset role;
  if (select (l.metadata->>'verification_delay_ms')::bigint > 0
        from sc.action_log l where l.action = 'VERIFY_ATTEMPT' order by l.seq desc limit 1) is not true then
    raise exception 'ASSERT 039v: the verification delay was not audited';
  end if;
  set local role authenticated;
end $$;

-- ------------------------------------------- expiry, late claims and the exit race
do $$
declare v jsonb; rev bigint; claim bigint; round jsonb; r_id bigint;
begin
  -- Round 1 of the previous block is already WON and waiting for its exit. It is closed
  -- the way the flow closes it, rather than deleted: the audit must keep every row.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000003', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_EXIT', '{}'::jsonb, rev, '039b-exit-1');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039v2: closing the first team failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000004', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('RESET_DONE', '{}'::jsonb, rev, '039b-room-1');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039v3: room 305 reset failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000003', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('RESET_DONE', '{}'::jsonb, rev, '039b-hall-1');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039v4: hallway reset failed: %', v; end if;
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('GATE_FINALIZE', '{}'::jsonb, rev, '039b-close-1');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039v5: closure of the first team failed: %', v; end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000001', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{}'::jsonb, rev, '039b-call');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039w: reception failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000002', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_FLOOR2', '{}'::jsonb, rev, '039b-f2');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039x: floor 2 failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000003', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('START_GAME', '{}'::jsonb, rev, '039b-start');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039y: start failed: %', v; end if;

  -- NPC1 bypasses floor 2 on the next team instead, and floor 2 stays unconfirmed.
  reset role;
  update sc.rounds set deadline_at = sc.now_ms() - 1
   where event_id = (select id from sc.events where name = 'Unified flow 039');
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000004', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CLAIM_COMPLETE', '{}'::jsonb, rev, '039b-late');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039z: a late claim must still be recorded: %', v; end if;
  claim := (select (public.snapshot()->'attempts'->-1->>'id')::bigint);
  if (public.snapshot()->'attempts'->-1->>'status') <> 'LATE' then
    raise exception 'ASSERT 039aa: a claim at or after the deadline is not LATE';
  end if;
  v := public.handle_command('VERIFY_ATTEMPT',
        jsonb_build_object('attempt_id', claim, 'decision', 'VALID'),
        (public.state_revision()->>'revision')::bigint, '039b-late-valid');
  if (v->>'ok')::boolean then raise exception 'ASSERT 039ab: a late claim cannot create a win: %', v; end if;

  -- Expiry with no eligible claim is TIME UP, and the exit keeps the result.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000003', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_EXIT', '{}'::jsonb, rev, '039b-exit');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039ac: exit confirmation failed: %', v; end if;
  round := public.snapshot()->'rounds'->-1;
  if round->>'result' <> 'TIME_UP' then raise exception 'ASSERT 039ad: TIME UP was not settled: %', round; end if;
  if round->>'official_duration_ms' is not null then
    raise exception 'ASSERT 039ae: a timed-out round must carry no winning time: %', round;
  end if;
  if round->>'exit_by_role' <> 'GATE' then raise exception 'ASSERT 039af: NPC1 must own the exit: %', round; end if;
  -- Closure needs the physical checks, and nobody else may close it.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000004', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('GATE_FINALIZE', '{}'::jsonb, rev, '039b-close-by-npc2');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 039ag: only NPC1 may close: %', v; end if;
  v := public.handle_command('RESET_DONE', '{}'::jsonb, rev, '039b-room');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039ah: room 305 reset failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000003', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('RESET_DONE', '{}'::jsonb, rev, '039b-hall');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039ai: hallway reset failed: %', v; end if;
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('GATE_FINALIZE', '{}'::jsonb, rev, '039b-close');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039aj: closure failed: %', v; end if;
  round := public.snapshot()->'rounds'->-1;
  if round->>'status' <> 'CLOSED' then raise exception 'ASSERT 039ak: the round did not close: %', round; end if;
  if (select count(*) from sc.rounds where event_id = (select id from sc.events where name = 'Unified flow 039')
        and status <> 'CLOSED') <> 0 then
    raise exception 'ASSERT 039al: a closed round still counts as active';
  end if;
  r_id := (round->>'id')::bigint;
  -- The claim history of the closed round stays visible to a station for dispute
  -- review (a viewer's copy of the same array is empty, asserted further below).
  if not exists (select 1 from jsonb_array_elements(public.snapshot()->'attempts') a
                  where (a->>'round_id')::bigint = r_id and a->>'status' = 'LATE') then
    raise exception 'ASSERT 039am: the late claim was not preserved';
  end if;

  -- A fresh team inherits nothing from the previous one.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000001', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{}'::jsonb, rev, '039b-next');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039an: the next team was refused: %', v; end if;
  round := public.snapshot()->'rounds'->-1;
  if round->>'game_started_at' is not null or round->>'deadline_at' is not null
     or round->>'result' <> 'IN_PROGRESS' or round->>'status' <> 'WAITING_FLOOR2_CONFIRMATION' then
    raise exception 'ASSERT 039ao: the new team inherited the previous session: %', round;
  end if;
  if (select count(*) from jsonb_array_elements(public.snapshot()->'attempts') a
        where (a->>'round_id')::bigint = (round->>'id')::bigint) <> 0 then
    raise exception 'ASSERT 039ap: claims leaked into the new round';
  end if;

  -- Now the bypass branch: NPC1 skips floor 2, and a late 02 press is refused safely.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000004', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('FLOOR2_BYPASS', '{"reason":"nhầm"}'::jsonb, rev, '039b-bypass-by-npc2');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 039aq: only NPC1 may bypass: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000003', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('FLOOR2_BYPASS', '{}'::jsonb, rev, '039b-bypass-noreason');
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 039ar: a bypass needs a reason: %', v; end if;
  v := public.handle_command('FLOOR2_BYPASS', '{"reason":"Đội đã ở tầng 3"}'::jsonb, rev, '039b-bypass');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039as: bypass failed: %', v; end if;
  round := public.snapshot()->'rounds'->-1;
  if round->>'floor2_confirmed_at' is not null then
    raise exception 'ASSERT 039at: a bypass must never read as a floor-2 confirmation: %', round;
  end if;
  if round->>'floor2_bypassed_by_role' <> 'GATE' or round->'floor2_bypass_reason' #>> '{}' <> 'Đội đã ở tầng 3' then
    if round->>'floor2_bypass_reason' <> 'Đội đã ở tầng 3' then
      raise exception 'ASSERT 039au: the bypass reason was not audited: %', round;
    end if;
  end if;
  -- The stale OPERATOR_02 press is refused and the flow does not revert.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000002', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_FLOOR2', '{}'::jsonb, rev, '039b-stale-f2');
  if v->>'code' <> 'INVALID_STATE' then raise exception 'ASSERT 039av: a stale floor-2 confirmation must be refused: %', v; end if;
  round := public.snapshot()->'rounds'->-1;
  if round->>'status' <> 'READY_AT_FLOOR3' then
    raise exception 'ASSERT 039aw: the refused press reverted the workflow: %', round;
  end if;
  -- From here NPC1 may start, so the bypass did not trap the game.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000003', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('START_GAME', '{}'::jsonb, rev, '039b-start-after-bypass');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039ax: the game could not continue after a bypass: %', v; end if;

  -- Emergency departure: reasoned, non-success, and it never fakes a time.
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('EARLY_EXIT', '{}'::jsonb, rev, '039b-early-noreason');
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 039ay: an early exit needs a reason: %', v; end if;
  v := public.handle_command('EARLY_EXIT', '{"reason":"Khách cần y tế"}'::jsonb, rev, '039b-early');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039az: early exit failed: %', v; end if;
  round := public.snapshot()->'rounds'->-1;
  if round->>'result' <> 'ABORTED' or round->>'official_duration_ms' is not null then
    raise exception 'ASSERT 039ba: an abort must carry no winning time: %', round;
  end if;
  if round->>'exit_confirmed_at' is null then
    raise exception 'ASSERT 039bb: an early exit is the confirmed departure: %', round;
  end if;
  -- A claim can no longer turn an aborted round into a win.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000004', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CLAIM_COMPLETE', '{}'::jsonb, rev, '039b-claim-after-abort');
  if v->>'code' <> 'INVALID_STATE' then raise exception 'ASSERT 039bc: an aborted round must not accept claims: %', v; end if;
end $$;

-- ------------------------------------------------------------------ the observer
do $$
declare v jsonb; i int; uid text;
begin
  -- A viewer claims without any password, on an identity that holds nothing.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000006', true);
  v := public.observer_join('viewer-039');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039oa: observer join failed: %', v; end if;
  if v->>'role' <> 'OBSERVER' then raise exception 'ASSERT 039ob: wrong seat: %', v; end if;

  -- Refreshing re-uses the same seat instead of consuming another one.
  v := public.observer_join('viewer-039');
  if v->>'code' <> 'ALREADY_BOUND' then raise exception 'ASSERT 039oc: a refresh must reuse its seat: %', v; end if;
  v := public.observer_beat('viewer-039');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039od: heartbeat failed: %', v; end if;

  -- The viewer sees the game and none of the operating record.
  v := public.snapshot();
  if v->>'redacted' <> 'true' then raise exception 'ASSERT 039oe: the viewer snapshot is not redacted'; end if;
  if (select count(*) from jsonb_array_elements(v->'log')) <> 0 then
    raise exception 'ASSERT 039of: a viewer must not read the action log';
  end if;
  if (select count(*) from jsonb_array_elements(v->'attempts')) <> 0 then
    raise exception 'ASSERT 039og: a viewer must not read the claim list';
  end if;
  if (select count(*) from jsonb_array_elements(v->'operators')) <> 0 then
    raise exception 'ASSERT 039oh: a viewer must not learn who is on duty';
  end if;
  if exists (select 1 from jsonb_array_elements(v->'rounds') r where r ? 'received_by' or r ? 'exit_reason') then
    raise exception 'ASSERT 039oi: operator identity fields reached a viewer';
  end if;
  if not (v->'event'->'config' ? 'game_limit_ms') then
    raise exception 'ASSERT 039oj: a viewer cannot render the countdown without the limit';
  end if;
  if v->'event'->'config' ? 'hiding_layout' then
    raise exception 'ASSERT 039ok: the hidden-object layout reached a viewer';
  end if;

  -- Every command is refused as read-only, whatever the action.
  foreach uid in array array['CALL_TEAM','START_GAME','CLAIM_COMPLETE','VERIFY_ATTEMPT',
                             'CONFIRM_EXIT','GATE_FINALIZE','RESET_DONE','SET_TEAM_NAME'] loop
    v := public.handle_command(uid, '{}'::jsonb, (public.state_revision()->>'revision')::bigint, '039-viewer-' || uid);
    if v->>'code' <> 'READ_ONLY' then raise exception 'ASSERT 039ol: viewer press % was not refused read-only: %', uid, v; end if;
  end loop;

  -- The public board reports the ten-seat capacity separately from the stations.
  reset role;
  v := public.station_board();
  set local role authenticated;
  if (v->>'board_version')::int <> 2 or (v->>'observer_capacity')::int <> 10 then
    raise exception 'ASSERT 039om: board v2 shape missing: %', v;
  end if;
  if (v->>'observer_devices')::int < 1 then raise exception 'ASSERT 039on: the live seat is not counted: %', v; end if;
  if (v->>'device_capacity')::int <> 6 then raise exception 'ASSERT 039oo: observer seats must not add operator seats: %', v; end if;

  -- Eleven viewers: the eleventh is refused, and the refusal is data, not an error.
  reset role;
  for i in 1..9 loop
    insert into auth.users(id) values (('33333333-0000-4000-8000-00000000000' || i)::uuid);
    insert into sc.operators(user_id, role, display_name, seat_slot)
    values (('33333333-0000-4000-8000-00000000000' || i)::uuid, 'OBSERVER', 'v' || i, i + 1);
    insert into sc.observer_seats(user_id, seen_at) values (('33333333-0000-4000-8000-00000000000' || i)::uuid, now());
  end loop;
  insert into auth.users(id) values ('33333333-0000-4000-8000-000000000099');
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000099', true);
  v := public.observer_join('viewer-overflow');
  if v->>'code' <> 'OBSERVER_FULL' then raise exception 'ASSERT 039op: the eleventh viewer was not refused: %', v; end if;
  if (v->>'capacity')::int <> 10 then raise exception 'ASSERT 039oq: refusal must state the capacity: %', v; end if;

  -- Leaving releases the seat for somebody else.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000006', true);
  v := public.observer_leave();
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039or: leaving failed: %', v; end if;
  reset role;
  if exists (select 1 from sc.observer_seats where user_id = '22222222-0000-4000-8000-000000000006') then
    raise exception 'ASSERT 039os: the seat survived the leave';
  end if;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000099', true);
  v := public.observer_join('viewer-overflow');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039ot: a freed seat was not reusable: %', v; end if;
end $$;

-- A bound station can never promote itself to a viewer.
do $$
declare v jsonb;
begin
  -- This identity already holds the SUPERVISOR binding above.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000005', true);
  v := public.observer_join('cross-role');
  if v->>'code' <> 'ALREADY_BOUND_OTHER_ROLE' then
    raise exception 'ASSERT 039ov: a station must not take a viewer seat: %', v;
  end if;
  -- A bound station cannot take a viewer seat through either entry point: one identity
  -- holds one role, and switching means releasing first. This is the client-side
  -- "route change grants nothing" rule, enforced in the database.
  v := public.claim_station('OBSERVER', null);
  if v->>'code' <> 'ALREADY_BOUND_OTHER_ROLE' then
    raise exception 'ASSERT 039ou: a station must not claim a viewer seat either: %', v;
  end if;
  -- And an unbound phone may take the open seat without any PIN at all. The capacity
  -- block above filled all ten seats, so the spectators are cleared first - as the
  -- presence sweep would do once their hearts stop beating.
  reset role;
  update sc.operators set revoked_at = now() where role = 'OBSERVER' and revoked_at is null;
  delete from sc.observer_seats;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000008', true);
  v := public.claim_station('OBSERVER', null);
  if not (v->>'ok')::boolean then raise exception 'ASSERT 039ow: the open seat needs no PIN: %', v; end if;
  if v->>'role' <> 'OBSERVER' then raise exception 'ASSERT 039ox: wrong role granted: %', v; end if;
end $$;

rollback;
reset role;
select '039 unified flow: reception, floor 2, bypass, claim/verify scoring, expiry races, exit, closure and observer capacity' as result;
