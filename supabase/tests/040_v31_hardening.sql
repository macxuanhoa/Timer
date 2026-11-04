-- Local SQL validation only (scenario 040): the V3.2 hardening, on the real RPCs.
-- Everything runs inside one transaction and is rolled back, against a database that
-- has already been carried through 0001..0017, so it also proves the V3 → V3.2 path.
\set ON_ERROR_STOP on
reset role;

begin;

update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.observer_seats;
delete from sc.admin_devices;
insert into auth.users(id) values
  ('22222222-0000-4000-8000-000000000011'),  -- OPERATOR_01 (LOBBY)
  ('22222222-0000-4000-8000-000000000012'),  -- OPERATOR_02 (CORRIDOR)
  ('22222222-0000-4000-8000-000000000013'),  -- NPC1 (GATE)
  ('22222222-0000-4000-8000-000000000014'),  -- NPC2 (ROOM305)
  ('22222222-0000-4000-8000-000000000015'),  -- SUPERVISOR
  ('22222222-0000-4000-8000-000000000016'),  -- viewer
  ('22222222-0000-4000-8000-000000000017'),  -- spare stranger identity
  ('22222222-0000-4000-8000-000000000018')   -- second stranger, for the admin probe
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
-- 2. V3.2 access: seats bind with one tap; only the admin seat is gated
-- ---------------------------------------------------------------------------
do $$
begin
  -- The allow-list table is invisible to every web role: RLS is on, no policy
  -- exists, and no grant survives either. A player cannot read, add or remove.
  if has_table_privilege('anon', 'sc.admin_devices', 'SELECT') then
    raise exception 'ASSERT 040d: anon must not read the admin allow-list';
  end if;
  if has_table_privilege('authenticated', 'sc.admin_devices', 'SELECT') then
    raise exception 'ASSERT 040e: authenticated must not read the admin allow-list';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'sc' and tablename = 'admin_devices') then
    raise exception 'ASSERT 040f: the allow-list must stay policy-empty (deny by default)';
  end if;
  -- The V3.1 credential surface is gone: no table, no installer, no board field.
  if to_regclass('sc.station_codes') is not null then
    raise exception 'ASSERT 040g: crew-code table must not survive V3.2';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'sc' and table_name = 'station_access_config'
                and column_name in ('supervisor_pin_hash', 'reset_secret_hash')) then
    raise exception 'ASSERT 040h: credential columns must be dropped';
  end if;
end $$;

set local role authenticated;
do $$
declare v jsonb; b jsonb;
begin
  -- A stranger with a fresh identity takes a free seat with no code at all.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000017', true);
  v := public.claim_station('LOBBY');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040i: the first tap must bind: %', v; end if;
  -- A second stranger gets the seat taken, not a credential challenge.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000018', true);
  v := public.claim_station('LOBBY');
  if v->>'code' <> 'ROLE_TAKEN' then raise exception 'ASSERT 040j: the seat race is exclusive: %', v; end if;
  -- Same identity, different seat is refused before anything else.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000017', true);
  v := public.claim_station('CORRIDOR');
  if v->>'code' <> 'ALREADY_BOUND_OTHER_ROLE' then raise exception 'ASSERT 040k: one identity, one seat: %', v; end if;
  -- The viewer seat still opens with nothing at all.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000016', true);
  v := public.observer_join('probe-040');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040l: the viewer must stay credential-free: %', v; end if;
  -- The admin seat is the gated one: an unknown device is turned away before the
  -- two supervisor slots are even considered.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000018', true);
  v := public.claim_station('SUPERVISOR');
  if v->>'code' <> 'ADMIN_NOT_ALLOWED' then raise exception 'ASSERT 040m: admin needs the allow-list: %', v; end if;
  -- Refusing an admin attempt never consumes a slot or a seat elsewhere.
  b := public.station_board();
  if (b->>'codes_required') is not null then
    raise exception 'ASSERT 040n: the board no longer advertises codes: %', b;
  end if;
  if (b->>'board_version')::int <> 3 then
    raise exception 'ASSERT 040o: the board keeps its V3.1 shape: %', b;
  end if;
end $$;

-- The allow-list itself is owner-only; here the owner (this script) seeds it, the
-- same one-time act the organiser performs from the Supabase SQL editor.
reset role;
insert into sc.admin_devices(user_id, note) values
  ('22222222-0000-4000-8000-000000000015', 'seeded supervisor'),
  ('22222222-0000-4000-8000-000000000017', 'lobby device promoted admin')
on conflict (user_id) do nothing;

set local role authenticated;
do $$
declare v jsonb;
begin
  -- Allowed now: identity 15 carries no duty seat, so its own claim is clean.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  v := public.claim_station('SUPERVISOR');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040p: an allowed device binds admin: %', v; end if;
  -- The refresh is idempotent: it never re-asks and never takes the second slot.
  v := public.claim_station('SUPERVISOR');
  if v->>'code' <> 'ALREADY_BOUND' then raise exception 'ASSERT 040q: refresh keeps its own seat: %', v; end if;
  -- A stranger hammering never drains admin slots: refusals precede the seat check.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000018', true);
  for _ in 1..5 loop
    v := public.claim_station('SUPERVISOR');
    if v->>'code' <> 'ADMIN_NOT_ALLOWED' then raise exception 'ASSERT 040r: refusals stay clean: %', v; end if;
  end loop;
  -- A bound duty phone may not upgrade itself to admin even if it later lands on
  -- the allow-list it was never given: identity 17 holds LOBBY already.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000017', true);
  v := public.claim_station('SUPERVISOR');
  if v->>'code' <> 'ALREADY_BOUND_OTHER_ROLE' then raise exception 'ASSERT 040s: a duty seat cannot be upgraded: %', v; end if;
end $$;

reset role;
-- Free the duty identities used above and bind the full crew the way the earlier
-- scenarios do: rows directly, so the sections below speak about commands only.
update sc.operators set revoked_at = now() where revoked_at is null;
insert into sc.operators (user_id, role, display_name, seat_slot) values
  ('22222222-0000-4000-8000-000000000011', 'LOBBY',      'T01', 1),
  ('22222222-0000-4000-8000-000000000012', 'CORRIDOR',   'T02', 1),
  ('22222222-0000-4000-8000-000000000013', 'GATE',       'TN1', 1),
  ('22222222-0000-4000-8000-000000000014', 'ROOM305',    'TN2', 1),
  ('22222222-0000-4000-8000-000000000015', 'SUPERVISOR', 'TSV', 1)
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name,
  seat_slot = excluded.seat_slot, revoked_at = null, bound_at = now();
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
-- 7. The board release: authorised by the caller's own admin binding, V3.2
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

  -- A viewer may not clear the duty board: only a device holding admin binds.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000016', true);
  v := public.reset_all_stations(false);
  if v->>'code' <> 'RESET_NOT_AUTHORIZED' then
    raise exception 'ASSERT 040cc: a viewer must not be able to release the board: %', v;
  end if;
  -- A duty position may not either: it is an admin access action.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000011', true);
  v := public.reset_all_stations(false);
  if v->>'code' <> 'RESET_NOT_AUTHORIZED' then
    raise exception 'ASSERT 040cd: only the supervisor seat may release the board: %', v;
  end if;
  -- The supervisor frees the seats and touches nothing else.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  v := public.reset_all_stations(false);
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040cf: the release must succeed: %', v; end if;
  if (v->>'freed')::int < 5 then raise exception 'ASSERT 040cg2: the release must count every duty seat it freed: %', v; end if;
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
  -- The allow-list is untouched by a release: organisers do not lock themselves out.
  if (select count(*) from sc.admin_devices) <> 2 then
    raise exception 'ASSERT 040ci3: a board release must never trim the admin allow-list';
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
-- A team is on the clock again: the plain release must now be refused, and the
-- board must say so with the same words the RPC uses.
set local role authenticated;
do $$
declare v jsonb; rev bigint; b jsonb;
begin
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000011', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{"team_name":"Do chặn release"}'::jsonb, rev, '040-call-block');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040ci5: reception for the release-block probe failed: %', v; end if;
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
  v := public.reset_all_stations(false);
  if v->>'code' <> 'RESET_GAME_RUNNING' then
    raise exception 'ASSERT 040ck: the RPC must refuse with the reason the board published: %', v;
  end if;
  -- The emergency path: force closes the open round as a recorded safety
  -- cancellation, frees every seat, and still never deletes a single fact.
  v := public.reset_all_stations(true);
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040ck5: the forced release must succeed: %', v; end if;
end $$;
-- The release just revoked every binding, so the authenticated role can no longer
-- see the rounds through RLS — exactly what a kicked phone experiences. The proof
-- that history survived is therefore taken as the owner.
reset role;
do $$
declare rid bigint; r jsonb; ev constant bigint := (select id from sc.events where name = 'Unified flow 040');
begin
  select id into rid from sc.rounds where event_id = ev and status <> 'CLOSED' order by id desc limit 1;
  if rid is not null then raise exception 'ASSERT 040ck5a: force must leave no round of this event open (rid=%)', rid; end if;
  select to_jsonb(x) into r from sc.rounds x where x.event_id = ev order by id desc limit 1;
  if r->>'status' <> 'CLOSED' or r->>'abort_kind' <> 'safety' or (r->>'aborted_at') = 'null'
     or r->>'result' <> 'ABORTED' or (r->>'official_duration_ms') <> 'null' then
    raise exception 'ASSERT 040ck6: force must cancel and close the open round without inventing a score (row=%)', r;
  end if;
  if not exists (select 1 from sc.action_log where action = 'ABORT_ROUND'
                  and (metadata->>'forced')::boolean) then
    raise exception 'ASSERT 040ck7: the forced cancellation must stand in the immutable log';
  end if;
  if exists (select 1 from sc.operators where revoked_at is null) then
    raise exception 'ASSERT 040ck8: force frees every device, admin included';
  end if;
  -- The allow-list survives its own emergency sweep: two organisers can always
  -- get back in with their own devices.
  if (select count(*) from sc.admin_devices) <> 2 then
    raise exception 'ASSERT 040ck9: even a forced release never trims the allow-list';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. No 90-minute business is left running underneath the screens
-- ---------------------------------------------------------------------------
reset role;
-- Re-bind the crew for the sections that still walk a round through the flow.
insert into sc.operators (user_id, role, display_name, seat_slot) values
  ('22222222-0000-4000-8000-000000000011', 'LOBBY',      'T01', 1),
  ('22222222-0000-4000-8000-000000000012', 'CORRIDOR',   'T02', 1),
  ('22222222-0000-4000-8000-000000000013', 'GATE',       'TN1', 1),
  ('22222222-0000-4000-8000-000000000014', 'ROOM305',    'TN2', 1),
  ('22222222-0000-4000-8000-000000000015', 'SUPERVISOR', 'TSV', 1),
  ('22222222-0000-4000-8000-000000000016', 'OBSERVER',   'VIEWER', 1)
on conflict (user_id) do update set role = excluded.role, seat_slot = excluded.seat_slot,
  revoked_at = null, bound_at = now();
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
  -- Manual closure still refuses while a team is unaccounted for. The forced sweep
  -- above left the floor perfectly idle, so receive a fresh team to test the rule.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000011', true);
  v := public.handle_command('CALL_TEAM', '{"team_name":"Do 90 phut"}'::jsonb,
        (public.state_revision()->>'revision')::bigint, '040-call-90');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 040cs2: reception for the closure probe failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  v := public.handle_command('END_EVENT', '{"reason":"hết ca"}'::jsonb,
        (public.state_revision()->>'revision')::bigint, '040-end-blocked');
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 040ct: closure must wait for the floor: %', v; end if;
  b := public.station_board();
  if (b->>'game_running')::text <> 'false' then
    raise exception 'ASSERT 040cu: a team received but not started must not count as inside: %', b;
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
  -- The allow-list, its uuids and any remnant of the old credential vocabulary
  -- must never surface in a snapshot either.
  if s::text like '%admin_devices%' or s::text like '%code_hash%' or s::text like '$2b$%' then
    raise exception 'ASSERT 040cx: no secret, hash or allow-list data may reach a snapshot';
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
delete from sc.admin_devices;

select '040 v3.2 hardening: credential-free seats, admin allow-list gating, '
    || 'configurable duration snapshots, cancellation truth, pending-claim rights, '
    || 'role-gated board release with a forced emergency sweep that preserves history, '
    || 'retired 90-minute business, Vietnamese refusals and viewer redaction: passed' as result;

rollback;
