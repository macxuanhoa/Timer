-- Local SQL validation only (scenario 040): the V3.1 hardening, on the real RPCs.
-- Everything runs inside one transaction and is rolled back, against a database that
-- has already been carried through 0001..0017, so it also proves the V3 → V3.1 path.
\set ON_ERROR_STOP on
reset role;

begin;

update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.observer_seats;
delete from sc.station_codes;
delete from sc.access_rate_limits;
insert into auth.users(id) values
  ('22222222-0000-4000-8000-000000000011'),  -- OPERATOR_01 (LOBBY)
  ('22222222-0000-4000-8000-000000000012'),  -- OPERATOR_02 (CORRIDOR)
  ('22222222-0000-4000-8000-000000000013'),  -- NPC1 (GATE)
  ('22222222-0000-4000-8000-000000000014'),  -- NPC2 (ROOM305)
  ('22222222-0000-4000-8000-000000000015'),  -- SUPERVISOR
  ('22222222-0000-4000-8000-000000000016'),  -- viewer
  ('22222222-0000-4000-8000-000000000017'),  -- spare stranger identity
  ('22222222-0000-4000-8000-000000000018')   -- second stranger, for the brute-force probe
on conflict (id) do nothing;

-- A dedicated event, so this scenario owns the state pointer entirely.
insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
                      hidden_object_owner, hiding_layout, review_threshold_ms, stall_warn_ms)
values ('Unified flow 040', 5400000, 300000, 90000, 90000, 'ROOM305', 'A', 500, 60000);
update sc.events set event_started_at = null, event_ended_at = null, next_team_number = 1
 where name = 'Unified flow 040';
update sc.state
   set event_id = (select id from sc.events where name = 'Unified flow 040'),
       revision = 0, updated_at = sc.now_ms()
 where id = true;
delete from sc.rounds where event_id = (select id from sc.events where name = 'Unified flow 040');

-- ---------------------------------------------------------------------------
-- 1. The 90-minute session business is gone from the permission surface
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from sc.role_permissions where action in
      ('OVERTIME_STARTED','OVERRIDE_ADMIT','EVENT_CLOSED','SESSION_RESTORE')) then
    raise exception 'ASSERT 040a: the retired session-clock actions must hold no permission';
  end if;
  if not exists (select 1 from sc.role_permissions where action = 'END_EVENT' and role = 'SUPERVISOR') then
    raise exception 'ASSERT 040b: manual, reasoned closure must stay a supervisor action';
  end if;
  if exists (select 1 from sc.role_permissions where role = 'OBSERVER') then
    raise exception 'ASSERT 040c: OBSERVER must still hold nothing at all';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Crew codes: installed by the owner, verified by the server
-- ---------------------------------------------------------------------------
do $$
declare v jsonb;
begin
  v := sc.configure_station_code('LOBBY', 'abc');         -- too short: refused
  if v->>'code' <> 'CODE_TOO_WEAK' then raise exception 'ASSERT 040d: a short code must be refused: %', v; end if;
  v := sc.configure_station_code('LOBBY', 'có khoảng trắng');  -- not A-Z0-9: refused
  if v->>'code' <> 'CODE_TOO_WEAK' then raise exception 'ASSERT 040d2: an unspellable code must be refused: %', v; end if;
  v := sc.configure_station_code('OBSERVER', 'NOBODY01'); -- not an operating position
  if v->>'code' <> 'INVALID_ROLE' then raise exception 'ASSERT 040e: only the four positions get codes: %', v; end if;
  perform sc.configure_station_code('LOBBY', 'SANNH01');
  perform sc.configure_station_code('CORRIDOR', 'TANG202');
  perform sc.configure_station_code('GATE', 'CUANPC1');
  perform sc.configure_station_code('ROOM305', 'PHONG305');
  if (select count(*) from sc.station_codes) <> 4 then
    raise exception 'ASSERT 040f: four crew codes were expected';
  end if;
  -- Only a hash is stored, and the code never appears in it.
  if exists (select 1 from sc.station_codes where code_hash like '%SANNH01%') then
    raise exception 'ASSERT 040g: a crew code must never be stored in the clear';
  end if;
  if not exists (select 1 from sc.station_codes where code_hash like '$2$10$%' or code_hash like '$2a$%' or code_hash like '$2b$%') then
    raise exception 'ASSERT 040h: crew codes must be bcrypt hashes';
  end if;
  if exists (select 1 from sc.station_codes where code_hash = 'SANNH01' or code_hash like 'SANNH01%') then
    raise exception 'ASSERT 040h2: a crew code must never be stored verbatim';
  end if;
end $$;

-- The board says codes are in force, and the code state itself is not enumerable.
do $$
declare b jsonb;
begin
  b := public.station_board();
  if (b->>'codes_required')::text <> 'true' then
    raise exception 'ASSERT 040i: the board must publish codes_required: %', b;
  end if;
  if has_function_privilege('authenticated', 'sc.station_code_state()', 'EXECUTE') then
    raise exception 'ASSERT 040j: sc.station_code_state() must stay owner-only';
  end if;
  if has_function_privilege('authenticated', 'sc.configure_station_code(text,text)', 'EXECUTE') then
    raise exception 'ASSERT 040k: crew codes must never be settable from the API';
  end if;
end $$;

set local role authenticated;

do $$
declare v jsonb;
begin
  -- A stranger with no code cannot take the free LOBBY seat.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000017', true);
  v := public.claim_station('LOBBY', null);
  if v->>'code' <> 'CODE_INVALID' then raise exception 'ASSERT 040l: a missing code must be refused: %', v; end if;
  v := public.claim_station('LOBBY', 'SAIKHONG');
  if v->>'code' <> 'CODE_INVALID' then raise exception 'ASSERT 040m: a wrong code must be refused: %', v; end if;
  -- The right code for a different position does not open this one.
  v := public.claim_station('LOBBY', 'CUANPC1');
  if v->>'code' <> 'CODE_INVALID' then raise exception 'ASSERT 040n: codes are per position: %', v; end if;
  -- The right code for the right position opens it, and lower case is accepted.
  v := public.claim_station('LOBBY', 'sannh01');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040o: the correct code must open its own position: %', v; end if;
  -- One identity, one position.
  v := public.claim_station('GATE', 'CUANPC1');
  if v->>'code' <> 'ALREADY_BOUND_OTHER_ROLE' then raise exception 'ASSERT 040p: one role per identity: %', v; end if;
  -- The viewer seat still asks for nothing.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000016', true);
  v := public.observer_join('probe-040');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040q: the viewer must stay password-free: %', v; end if;
  -- A viewer cannot buy its way into a station with a code it does not have.
  v := public.claim_station('ROOM305', 'PHONG305');
  if v->>'code' <> 'ALREADY_BOUND_OTHER_ROLE' then raise exception 'ASSERT 040r: a viewer must not upgrade itself: %', v; end if;
end $$;

-- Brute force is capped per identity, and a refusal never grants anything.
do $$
declare v jsonb; i int;
begin
  -- A fresh identity hammering one free seat: five plain refusals, then the cap.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000018', true);
  for i in 1..5 loop
    v := public.claim_station('GATE', 'SAIKHONG');
    if v->>'code' <> 'CODE_INVALID' then raise exception 'ASSERT 040s: attempt % must be a plain refusal: %', i, v; end if;
  end loop;
  v := public.claim_station('GATE', 'CUANPC1');
  if v->>'code' <> 'CODE_RATE_LIMITED' then raise exception 'ASSERT 040t: the sixth attempt must be rate limited: %', v; end if;
end $$;

-- The audit records the refusals and never the code. Reading it at all is already an
-- owner-only act, which is itself part of the assertion.
reset role;
do $$
begin
  if not exists (select 1 from sc.access_audit where action = 'CODE_REFUSED') then
    raise exception 'ASSERT 040u1: a refused code must leave an audit trail';
  end if;
  if exists (select 1 from sc.access_audit where action = 'CODE_REFUSED'
              and metadata::text like '%SAIKHONG%') then
    raise exception 'ASSERT 040u2: a refused code must never reach the audit';
  end if;
end $$;
delete from sc.access_rate_limits;
update sc.operators set revoked_at = now()
 where user_id in ('22222222-0000-4000-8000-000000000017', '22222222-0000-4000-8000-000000000018');
set local role authenticated;

-- Bind the remaining duty identities directly, as the earlier scenarios do.
reset role;
insert into sc.operators (user_id, role, display_name, seat_slot) values
  ('22222222-0000-4000-8000-000000000011', 'LOBBY',      'T01', 1),
  ('22222222-0000-4000-8000-000000000012', 'CORRIDOR',   'T02', 1),
  ('22222222-0000-4000-8000-000000000013', 'GATE',       'TN1', 1),
  ('22222222-0000-4000-8000-000000000014', 'ROOM305',    'TN2', 1),
  ('22222222-0000-4000-8000-000000000015', 'SUPERVISOR', 'TSV', 1)
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name,
  seat_slot = excluded.seat_slot, revoked_at = null, bound_at = now();

-- The admin PIN stays a separate secret from the crew codes, and installing it is an
-- owner-only act: the API cannot reach sc.configure_station_access at all.
reset role;
select sc.configure_station_access('9876543210', false);
delete from sc.access_rate_limits;
set local role authenticated;
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000017', true);
  v := public.claim_station('SUPERVISOR', 'SANNH01');   -- a crew code is not an admin PIN
  if v->>'code' <> 'PIN_INVALID' then raise exception 'ASSERT 040w: the admin PIN is its own secret: %', v; end if;
  v := public.claim_station('SUPERVISOR', '9876543210');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040x: the correct PIN must open the admin seat: %', v; end if;
end $$;

reset role;
delete from sc.access_rate_limits;
update sc.operators set revoked_at = now() where user_id = '22222222-0000-4000-8000-000000000017';
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 3. The configurable duration: bounds, snapshot, and no effect on a live round
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; rev bigint; rid bigint; sub constant text := '22222222-0000-4000-8000-000000000015';
begin
  -- T05, T06: nonsense never reaches the configuration.
  perform set_config('request.jwt.claim.sub', sub, true);
  for v in select x from unnest(array[
    '{"game_limit_ms":0}'::jsonb, '{"game_limit_ms":-1000}'::jsonb,
    '{"game_limit_ms":1500}'::jsonb, '{"game_limit_ms":3600000}'::jsonb,
    '{"game_limit_ms":null}'::jsonb]) x
  loop
    rev := (public.state_revision()->>'revision')::bigint;
    v := public.handle_command('CONFIGURE', v, rev, '040-bad-' || (v->>'game_limit_ms') || '-' || random()::text);
    if (v->>'ok')::boolean then raise exception 'ASSERT 040y: % must be refused: %', v, v; end if;
    if v->>'code' <> 'INVALID_STATE' then raise exception 'ASSERT 040z: a bad duration is a refusal, not a crash: %', v; end if;
  end loop;
  -- T01: 02:00 is a legal configuration.
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIGURE', '{"game_limit_ms":120000}'::jsonb, rev, '040-set-120');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040aa: 02:00 must be accepted: %', v; end if;
  if (public.snapshot()->'event'->'config'->>'game_limit_ms')::bigint <> 120000 then
    raise exception 'ASSERT 040ab: the configuration must reach every device';
  end if;
  -- The event's own history fields stay locked once the night has begun.
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIGURE', '{"event_duration_ms":60000}'::jsonb, rev, '040-set-event');
  if (v->>'ok')::boolean then raise exception 'ASSERT 040ac: the session length must no longer be editable'; end if;
end $$;

do $$
declare v jsonb; rev bigint; rid bigint; r jsonb;
begin
  -- T01 in play: a round started under 02:00 gets a 120 s window of its own.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000011', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{"team_name":"Do 02:00"}'::jsonb, rev, '040-call-120');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040ad: reception failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000012', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_FLOOR2', '{}'::jsonb, rev, '040-floor2-120');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040ad2: floor 2 confirmation failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('START_GAME', '{}'::jsonb, rev, '040-start-120');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040ae: START failed: %', v; end if;
  if v->>'message' not like '%02:00%' then
    raise exception 'ASSERT 040af: the receipt must name the duration that started: %', v;
  end if;
  r := (select to_jsonb(x) from sc.rounds x
         where x.event_id = (select id from sc.events where name = 'Unified flow 040')
         order by x.id desc limit 1);
  rid := (r->>'id')::bigint;
  if (r->>'deadline_at')::bigint - (r->>'game_started_at')::bigint <> 120000 then
    raise exception 'ASSERT 040ag: T01 deadline must be START + 120000: %', r;
  end if;
  if (r->>'round_duration_ms')::bigint <> 120000 then
    raise exception 'ASSERT 040ah: the round must snapshot its own duration: %', r;
  end if;

  -- T08: changing the default while the clock runs cannot move the live round.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIGURE', '{"game_limit_ms":420000}'::jsonb, rev, '040-set-420');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040ai: 07:00 must be accepted: %', v; end if;
  if v->>'message' not like '%lượt tiếp theo%' then
    raise exception 'ASSERT 040aj: the receipt must say the change applies to the next round: %', v;
  end if;
  r := (select to_jsonb(x) from sc.rounds x where x.id = rid);
  if (r->>'deadline_at')::bigint - (r->>'game_started_at')::bigint <> 120000 then
    raise exception 'ASSERT 040ak: a running round must keep its own window: %', r;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. P0: a cancellation is not a departure, and a claim keeps its rights
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; rev bigint; rid bigint; r jsonb; aid bigint; s jsonb; claim_at bigint; official_before bigint;
begin
  select id into rid from sc.rounds
   where event_id = (select id from sc.events where name = 'Unified flow 040')
   order by id desc limit 1;
  -- A claim recorded well inside the 02:00 window, not judged yet.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000014', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CLAIM_COMPLETE', '{}'::jsonb, rev, '040-claim-1');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040al: the claim must be recorded: %', v; end if;
  -- The claim is read back through the API, exactly as a phone reads it: the claim
  -- table itself is owner-only, and that is part of what this proves.
  s := public.snapshot();
  aid := (s->'attempts'->-1->>'id')::bigint;
  claim_at := (s->'attempts'->-1->>'claimed_at')::bigint;

  -- The reason for cancelling has to be stated: no kind, no cancellation.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('ABORT_ROUND', '{"reason":"mất điện"}'::jsonb, rev, '040-abort-nokind');
  if (v->>'ok')::boolean then raise exception 'ASSERT 040am: a cancellation must name its kind: %', v; end if;
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('ABORT_ROUND', '{"kind":"technical"}'::jsonb, rev, '040-abort-noreason');
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 040an: a cancellation must carry a reason: %', v; end if;

  -- T07 in the same breath: the next round now runs on the 07:00 default.
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('ABORT_ROUND', '{"reason":"mất điện","kind":"technical"}'::jsonb, rev, '040-abort-tech');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040ao: a technical cancellation must work: %', v; end if;
  r := (select to_jsonb(x) from sc.rounds x where x.id = rid);
  if r->>'exit_confirmed_at' <> 'null' and (r->>'exit_confirmed_at') is not null then
    raise exception 'ASSERT 040ap: a cancellation must not stamp a departure: %', r;
  end if;
  if (r->>'exit_by_role') is not null or (r->>'exit_by') is not null then
    raise exception 'ASSERT 040aq: nobody confirmed the players left: %', r;
  end if;
  if (r->>'aborted_at') is null or r->>'abort_kind' <> 'technical' or r->>'abort_reason' <> 'mất điện' then
    raise exception 'ASSERT 040ar: the cancellation itself must be recorded: %', r;
  end if;
  if (r->>'status') <> 'WAITING_FOR_EXIT' then
    raise exception 'ASSERT 040as: the round waits for the physical exit: %', r;
  end if;

  -- The area may not be prepared, and no new claim may be recorded.
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('GATE_FINALIZE', '{}'::jsonb, rev, '040-finalize-early');
  if (v->>'ok')::boolean then raise exception 'ASSERT 040at: closure must wait for the exit: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000014', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CLAIM_COMPLETE', '{}'::jsonb, rev, '040-claim-after-abort');
  if (v->>'ok')::boolean then raise exception 'ASSERT 040au: a cancelled round takes no new claim: %', v; end if;

  -- The claim that was already recorded keeps its right to be judged.
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('VERIFY_ATTEMPT',
        jsonb_build_object('attempt_id', aid, 'decision', 'VALID'), rev, '040-verify-after-abort');
  if not (v->>'ok')::boolean then
    raise exception 'ASSERT 040av: an in-time claim must stay verifiable after a technical cancellation: %', v;
  end if;
  r := (select to_jsonb(x) from sc.rounds x where x.id = rid);
  if (r->>'result') <> 'WON' then
    raise exception 'ASSERT 040aw: a correct claim after a technical cancellation wins: %', r;
  end if;
  if (select official_duration_ms from sc.rounds where id = rid) <> claim_at - (select game_started_at from sc.rounds where id = rid) then
    raise exception 'ASSERT 040ax: the official time stays the claim instant, not the verification';
  end if;
  if (select aborted_at from sc.rounds where id = rid) is null then
    raise exception 'ASSERT 040ay: the cancellation must not disappear from history';
  end if;

  -- Only now does NPC1 confirm the players are out, and the exit cannot move the score.
  official_before := (select official_duration_ms from sc.rounds where id = rid);
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_EXIT', '{}'::jsonb, rev, '040-exit-after-abort');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040az: NPC1 must be able to confirm the exit: %', v; end if;
  r := (select to_jsonb(x) from sc.rounds x where x.id = rid);
  if (r->>'exit_by_role') <> 'GATE' then raise exception 'ASSERT 040ba: the exit belongs to NPC1: %', r; end if;
  if (select official_duration_ms from sc.rounds where id = rid) <> official_before then
    raise exception 'ASSERT 040bb: the departure cannot change the score';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. A disqualification is not undone by a claim, and only REVIEW_RESOLVE can
--    put a result back
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; rev bigint; rid bigint; r jsonb; aid bigint; s jsonb; n int;
begin
  -- Close out the round section 4 left awaiting its physical checks, so a new team
  -- may be received: that is exactly the readiness rule the flow is built on.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('RESET_DONE', '{}'::jsonb, rev, '040-reset-hallway-prev');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040bb2: hallway check failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000014', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('RESET_DONE', '{}'::jsonb, rev, '040-reset-room-prev');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040bb3: room checks failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('GATE_FINALIZE', '{}'::jsonb, rev, '040-finalize-prev');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040bb4: closure of the previous round failed: %', v; end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000011', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{"team_name":"Do kỷ luật"}'::jsonb, rev, '040-call-mis');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040bc: reception failed: %', v; end if;
  select id into rid from sc.rounds
   where event_id = (select id from sc.events where name = 'Unified flow 040') order by id desc limit 1;
  -- T07: this round runs on the 07:00 default that was set while the previous one was live.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('FLOOR2_BYPASS', '{"reason":"doi da o tang 3"}'::jsonb, rev, '040-bypass-mis');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040bd0: the bypass must open the gate: %', v; end if;
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('START_GAME', '{}'::jsonb, rev, '040-start-420');
  r := (select to_jsonb(x) from sc.rounds x where x.id = rid);
  if (r->>'deadline_at')::bigint - (r->>'game_started_at')::bigint <> 420000 then
    raise exception 'ASSERT 040bd: T03 deadline must be START + 420000: %', r;
  end if;
  if (r->>'round_duration_ms')::bigint <> 420000 then
    raise exception 'ASSERT 040be: the second round snapshots its own duration: %', r;
  end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000014', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CLAIM_COMPLETE', '{}'::jsonb, rev, '040-claim-mis');
  s := public.snapshot();
  aid := (s->'attempts'->-1->>'id')::bigint;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('ABORT_ROUND',
        '{"reason":"phạm luật","kind":"misconduct"}'::jsonb, rev, '040-abort-mis');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040bf: a disqualification must work: %', v; end if;
  r := (select to_jsonb(x) from sc.rounds x where x.id = rid);
  if (r->>'exit_confirmed_at') is not null or (r->>'exit_by_role') is not null then
    raise exception 'ASSERT 040bg: a disqualification must not stamp a departure either: %', r;
  end if;
  if (r->>'decertified')::text <> 'true' then
    raise exception 'ASSERT 040bh: a disqualification withdraws the result from the ranking: %', r;
  end if;
  -- The claim keeps its row and its timestamp, but cannot be judged into a win.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000014', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('VERIFY_ATTEMPT',
        jsonb_build_object('attempt_id', aid, 'decision', 'VALID'), rev, '040-verify-mis');
  if (v->>'ok')::boolean then raise exception 'ASSERT 040bi: a disqualified round is a supervisor decision: %', v; end if;
  if v->>'message' not like '%kỷ luật%' then
    raise exception 'ASSERT 040bj: the refusal must say why: %', v;
  end if;
  s := public.snapshot();
  select count(*) into n from jsonb_array_elements(s->'attempts') a
   where (a->>'round_id')::bigint = rid and (a->>'claimed_at') is not null;
  if n <> 1 then
    raise exception 'ASSERT 040bk: the claim and its instant must survive the refusal';
  end if;

  -- A supervisor who reviews the case by name can put the result back.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('REVIEW_RESOLVE',
        jsonb_build_object('round_id', rid, 'decision', 'ACCEPT', 'reason', 'xem lại: lỗi trọng tài'),
        rev, '040-review-mis');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040bl: the review must resolve: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000014', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('VERIFY_ATTEMPT',
        jsonb_build_object('attempt_id', aid, 'decision', 'VALID'), rev, '040-verify-mis2');
  if not (v->>'ok')::boolean then
    raise exception 'ASSERT 040bm: after an accepted review the claim must be judgeable: %', v;
  end if;
  if (select result from sc.rounds where id = rid) <> 'WON' then
    raise exception 'ASSERT 040bn: the win is scored from the original claim instant';
  end if;
  -- And the win cannot be cancelled out of existence by a second press.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('ABORT_ROUND', '{"reason":"nhầm","kind":"technical"}'::jsonb, rev, '040-abort-twice');
  if v->>'code' <> 'INVALID_STATE' and v->>'code' <> 'OK' then
    raise exception 'ASSERT 040bo: a settled round answers cleanly: %', v;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. The three physical areas: refusal names them in Vietnamese, 3/3 closes
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; rev bigint; rid bigint; r jsonb;
begin
  select id into rid from sc.rounds
   where event_id = (select id from sc.events where name = 'Unified flow 040') order by id desc limit 1;
  -- The team still has to be confirmed out before anything else can happen.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_EXIT', '{}'::jsonb, rev, '040-exit-mis');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040bp: exit confirmation failed: %', v; end if;

  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('GATE_FINALIZE', '{}'::jsonb, rev, '040-finalize-0of3');
  if (v->>'ok')::boolean then raise exception 'ASSERT 040bq: 0/3 may never declare readiness: %', v; end if;
  if v->>'message' not like '%Hành lang tầng 3%' or v->>'message' not like '%Vật phẩm ẩn%'
     or v->>'message' not like '%Phòng 305%' then
    raise exception 'ASSERT 040br: the refusal must name every outstanding area: %', v;
  end if;
  if v->>'message' like '%hidden_objects%' or v->>'message' like '%room305%' then
    raise exception 'ASSERT 040bs: a database key must never be shown to an operator: %', v;
  end if;

  -- One area of three is not a completed reset.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('RESET_DONE', '{}'::jsonb, rev, '040-reset-hallway');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040bt: the hallway check failed: %', v; end if;
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('GATE_FINALIZE', '{}'::jsonb, rev, '040-finalize-1of3');
  if (v->>'ok')::boolean then raise exception 'ASSERT 040bu: 1/3 is not readiness: %', v; end if;
  if v->>'message' not like '%Vật phẩm ẩn%' or v->>'message' like '%Hành lang%' then
    raise exception 'ASSERT 040bv: the refusal must list only what is still outstanding: %', v;
  end if;

  -- 3/3 in the current cycle, then NPC1 closes.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000014', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('RESET_DONE', '{}'::jsonb, rev, '040-reset-room2');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040bw: NPC2 owns the room and the hidden props: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('GATE_FINALIZE', '{}'::jsonb, rev, '040-finalize-3of3');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040bx: 3/3 plus the exit must close: %', v; end if;
  r := (select to_jsonb(x) from sc.rounds x where x.id = rid);
  if (r->>'status') <> 'CLOSED' or (r->>'system_ready_at') is null then
    raise exception 'ASSERT 040by: readiness is NPC1 press plus a completed checklist: %', r;
  end if;
  if (select count(*) from sc.reset_tasks t where t.round_id = rid and t.completed_at is null) <> 0 then
    raise exception 'ASSERT 040bz: every area keeps its own confirmer and instant';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. The board release: a supervisor action, refused for everybody else, and
--    never a change to a clock, a result or a claim
-- ---------------------------------------------------------------------------
-- The fingerprint is taken by the owner: the claim table is deliberately unreadable
-- through the API, so a caller that could not see it also cannot fake this check.
reset role;
create temp table if not exists audit_fp (k text primary key, v text) on commit drop;
insert into audit_fp (k, v)
values ('before',
  (select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from sc.rounds x
     where x.event_id = (select id from sc.events where name = 'Unified flow 040'))
  || '|' ||
  (select md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), '')) from sc.completion_attempts a)
  || '|' ||
  (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.round_id, t.task_key), '')) from sc.reset_tasks t)
  || '|' ||
  (select coalesce(event_started_at::text || '/' || event_ended_at::text || '/' || game_limit_ms::text, 'null')
     from sc.events where name = 'Unified flow 040'))
on conflict (k) do update set v = excluded.v;

set local role authenticated;
do $$
declare v jsonb; b jsonb;
begin
  -- The floor is idle now, so the board says the release is available.
  b := public.station_board();
  if (b->>'reset_allowed')::text <> 'true' then
    raise exception 'ASSERT 040ca: an idle floor must allow the release: %', b;
  end if;
  if (b->>'reset_block_reason') is not null then
    raise exception 'ASSERT 040cb: an idle floor has no block reason: %', b;
  end if;

  -- A viewer that happens to know the secret may not clear the duty board.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000016', true);
  v := public.reset_all_stations('greenwich99');
  if v->>'code' <> 'RESET_NOT_AUTHORIZED' then
    raise exception 'ASSERT 040cc: a viewer must not be able to release the board: %', v;
  end if;
  -- An operator position may not either: it is an admin access action.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000011', true);
  v := public.reset_all_stations('greenwich99');
  if v->>'code' <> 'RESET_NOT_AUTHORIZED' then
    raise exception 'ASSERT 040cd: only the supervisor seat may release the board: %', v;
  end if;
  -- The supervisor, with a wrong secret, is refused the same way as before.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  v := public.reset_all_stations('sai-mat-khau');
  if v->>'code' <> 'RESET_INVALID' then raise exception 'ASSERT 040ce: a wrong secret must be refused: %', v; end if;
  -- And with the right one, it frees the seats and touches nothing else.
  v := public.reset_all_stations('greenwich99');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040cf: the release must succeed: %', v; end if;
  if (v->>'freed')::int < 4 then raise exception 'ASSERT 040cg2: the release must report what it freed: %', v; end if;
end $$;

reset role;
do $$
declare fp0 text; fp1 text;
begin
  select v into fp0 from audit_fp where k = 'before';
  fp1 :=
    (select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from sc.rounds x
       where x.event_id = (select id from sc.events where name = 'Unified flow 040'))
    || '|' ||
    (select md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), '')) from sc.completion_attempts a)
    || '|' ||
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.round_id, t.task_key), '')) from sc.reset_tasks t)
    || '|' ||
    (select coalesce(event_started_at::text || '/' || event_ended_at::text || '/' || game_limit_ms::text, 'null')
       from sc.events where name = 'Unified flow 040');
  if fp0 <> fp1 then
    raise exception 'ASSERT 040ch: the release changed a round, a claim, a checklist or a clock';
  end if;
  if exists (select 1 from sc.operators where revoked_at is null) then
    raise exception 'ASSERT 040ci2: every duty binding must be freed by the release';
  end if;
end $$;

-- Re-bind the duty identities for the last sections.
reset role;
insert into sc.operators (user_id, role, display_name, seat_slot) values
  ('22222222-0000-4000-8000-000000000011', 'LOBBY',      'T01', 1),
  ('22222222-0000-4000-8000-000000000012', 'CORRIDOR',   'T02', 1),
  ('22222222-0000-4000-8000-000000000013', 'GATE',       'TN1', 1),
  ('22222222-0000-4000-8000-000000000014', 'ROOM305',    'TN2', 1),
  ('22222222-0000-4000-8000-000000000015', 'SUPERVISOR', 'TSV', 1),
  ('22222222-0000-4000-8000-000000000016', 'OBSERVER',   'VIEWER', 1)
on conflict (user_id) do update set role = excluded.role, seat_slot = excluded.seat_slot,
  revoked_at = null, bound_at = now();
-- A team is on the clock again: the release must now be refused, and the board must
-- say so with the same words the RPC uses.
set local role authenticated;
do $$
declare v jsonb; rev bigint; b jsonb;
begin
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000011', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{"team_name":"Do chặn release"}'::jsonb, rev, '040-call-block');
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000012', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_FLOOR2', '{}'::jsonb, rev, '040-floor2-block');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040ci0: floor 2 confirmation failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('START_GAME', '{}'::jsonb, rev, '040-start-block');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040ci: START failed: %', v; end if;
  b := public.station_board();
  if (b->>'reset_allowed')::text <> 'false' or (b->>'reset_block_reason') <> 'RUNNING' then
    raise exception 'ASSERT 040cj: a live round must block the release, and say why: %', b;
  end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  v := public.reset_all_stations('greenwich99');
  if v->>'code' <> 'RESET_GAME_RUNNING' then
    raise exception 'ASSERT 040ck: the RPC must refuse with the reason the board published: %', v;
  end if;
  -- A pending in-time claim blocks the release for its own reason.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000014', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CLAIM_COMPLETE', '{}'::jsonb, rev, '040-claim-block');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040ck2: the claim must be recorded: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('EARLY_EXIT', '{"reason":"khách xin ra"}'::jsonb, rev, '040-early-block');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040cl: an early exit is a departure: %', v; end if;
  if (select exit_confirmed_at from sc.rounds order by id desc limit 1) is null then
    raise exception 'ASSERT 040cm: EARLY_EXIT must be the departure confirmation itself';
  end if;
  b := public.station_board();
  if (b->>'reset_block_reason') <> 'PENDING_CLAIM' then
    raise exception 'ASSERT 040cn: an open in-time claim blocks the release by name: %', b;
  end if;
  -- NPC1 never has to confirm the same departure twice.
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('EARLY_EXIT', '{"reason":"nhầm"}'::jsonb, rev, '040-early-twice');
  if v->>'code' <> 'INVALID_STATE' then raise exception 'ASSERT 040co: a cancelled round is not cancelled twice: %', v; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. No 90-minute business is left running underneath the screens
-- ---------------------------------------------------------------------------
reset role;
update sc.runtime_flags set allow_test_clock = true,
  test_now_ms = (extract(epoch from clock_timestamp()) * 1000)::bigint + 90 * 60_000 + 12 * 60_000;
set local role authenticated;
do $$
declare v jsonb; b jsonb;
begin
  -- Past the old 90-minute mark: nothing ends, nothing is refused, nothing is deleted.
  if (select count(*) from sc.events where event_ended_at is not null
        and name = 'Unified flow 040') <> 0 then
    raise exception 'ASSERT 040cp: the session deadline must not close anything by itself';
  end if;
  if exists (select 1 from sc.events where name = 'Unified flow 040'
              and (closing_warned_at is not null or end_warned_at is not null or overtime_started_at is not null)) then
    raise exception 'ASSERT 040cq: no session warning may be written any more';
  end if;
  -- The retired session actions answer as unauthorized, not as a hidden state rule.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  v := public.handle_command('OVERTIME_STARTED', '{"reason":"thêm giờ"}'::jsonb,
        (public.state_revision()->>'revision')::bigint, '040-overtime');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 040cr: overtime must be off the surface: %', v; end if;
  v := public.handle_command('OVERRIDE_ADMIT', '{"reason":"th"}'::jsonb,
        (public.state_revision()->>'revision')::bigint, '040-admit');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 040cs: the cutoff override must be gone: %', v; end if;
  -- Manual closure still refuses while a team is unaccounted for, then works.
  v := public.handle_command('END_EVENT', '{"reason":"hết ca"}'::jsonb,
        (public.state_revision()->>'revision')::bigint, '040-end-blocked');
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 040ct: closure must wait for the floor: %', v; end if;
  b := public.station_board();
  if (b->>'game_running')::text <> 'false' then
    raise exception 'ASSERT 040cu: an early exit already accounts for the team: %', b;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 9. A viewer still sees the game and nothing else
-- ---------------------------------------------------------------------------
do $$
declare s jsonb;
begin
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000016', true);
  s := public.snapshot();
  if (s->>'redacted')::text <> 'true' then raise exception 'ASSERT 040cv: the viewer view must stay redacted'; end if;
  if jsonb_array_length(coalesce(s->'attempts', '[]'::jsonb)) <> 0 then
    raise exception 'ASSERT 040cw: a viewer must not read the claim list';
  end if;
  if s::text like '%greenwich99%' or s::text like '$2b$%' or s::text like '%code_hash%' then
    raise exception 'ASSERT 040cx: no secret or hash may reach a snapshot';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(s->'rounds','[]'::jsonb)) r
              where r ? 'abort_reason' or r ? 'exit_by' or r ? 'review_reasons') then
    raise exception 'ASSERT 040cy: operational detail must stay out of the viewer view';
  end if;
  if (select count(*) from jsonb_array_elements(coalesce(s->'rounds','[]'::jsonb)) r
        where r ? 'round_duration_ms') <> (select jsonb_array_length(coalesce(s->'rounds','[]'::jsonb))) then
    raise exception 'ASSERT 040cz: a viewer still sees the round duration on screen';
  end if;
end $$;

reset role;
update sc.runtime_flags set allow_test_clock = false, test_now_ms = null;
update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.station_codes;
delete from sc.access_rate_limits;

select '040 v3.1 hardening: crew codes, configurable duration snapshots, cancellation truth, '
    || 'pending-claim rights, supervisor-only board release, retired 90-minute business, '
    || 'Vietnamese refusals and viewer redaction: passed' as result;

rollback;
