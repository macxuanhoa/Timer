-- Local SQL validation only (scenario 041): OPEN_NEW_EVENT on the real RPCs.
-- Everything runs inside one transaction and is rolled back, against a database
-- already carried through 0001..0018.
--
-- The scenario proves four things:
--   1. The action is registered on the same permission surface END_EVENT uses;
--      nothing else about V3.1 §7.2 changed.
--   2. Only SUPERVISOR may press it, and only after the event is closed and every
--      round of the closed event is CLOSED — a stale phone or a duty seat is told
--      so without any side effect.
--   3. A press creates a fresh sc.events row that inherits the operational
--      configuration, moves the pointer, and starts the sequence at team #001.
--   4. Every row of the closed event — the event row, its rounds, its completion
--      attempts, its reset tasks and its action_log entries — stays exactly where
--      it was. The state pointer moved; nothing else did.
--
-- Note on roles: sc.completion_attempts has an RLS policy but no GRANT SELECT
-- for authenticated (0016 §6 — the claim list is reachable only through
-- sc.snapshot). Any assertion about the CLOSED event's claim rows after the
-- pointer moves therefore runs as the owner, with reset role/set local role
-- around each block, exactly the pattern 040 uses for its fingerprint check.
\set ON_ERROR_STOP on
reset role;

begin;

-- ---------------------------------------------------------------------------
-- 0. Setup: identities, an owned event, and a clean state pointer.
-- ---------------------------------------------------------------------------
update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.observer_seats;
delete from sc.admin_devices;
insert into auth.users(id) values
  ('22222222-0000-4000-8000-000000000011'),  -- OPERATOR_01 (LOBBY)
  ('22222222-0000-4000-8000-000000000012'),  -- OPERATOR_02 (CORRIDOR)
  ('22222222-0000-4000-8000-000000000013'),  -- NPC1 (GATE)
  ('22222222-0000-4000-8000-000000000014'),  -- NPC2 (ROOM305)
  ('22222222-0000-4000-8000-000000000015')   -- SUPERVISOR
on conflict (id) do nothing;

-- A dedicated event so this scenario owns the pointer entirely. The name is
-- distinct so the "history is preserved" assertion can pin the exact rows
-- belonging to the closed event.
insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
                      hidden_object_owner, hiding_layout, review_threshold_ms, stall_warn_ms)
values ('Open-new 041', 5400000, 240000, 90000, 90000, 'ROOM305', 'B', 500, 60000);
update sc.state
   set event_id = (select id from sc.events where name = 'Open-new 041'),
       revision = 0, updated_at = sc.now_ms()
 where id = true;

-- ---------------------------------------------------------------------------
-- 1. The action is registered on the permission surface END_EVENT uses.
--    Read as the migration-owner role, because sc.role_permissions is RLS-
--    protected and only exposes itself to a bound operator identity — the
--    bindings that would let authenticated read them are inserted below.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from sc.role_permissions
                  where action = 'OPEN_NEW_EVENT' and role = 'SUPERVISOR') then
    raise exception 'ASSERT 041a: OPEN_NEW_EVENT must be a supervisor action';
  end if;
  if exists (select 1 from sc.role_permissions
              where action = 'OPEN_NEW_EVENT' and role <> 'SUPERVISOR') then
    raise exception 'ASSERT 041b: no duty seat or viewer may open a new event';
  end if;
end $$;

-- Bind the crew directly, so the sections below speak about commands only.
insert into sc.operators (user_id, role, display_name, seat_slot) values
  ('22222222-0000-4000-8000-000000000011', 'LOBBY',      'T01', 1),
  ('22222222-0000-4000-8000-000000000012', 'CORRIDOR',   'T02', 1),
  ('22222222-0000-4000-8000-000000000013', 'GATE',       'TN1', 1),
  ('22222222-0000-4000-8000-000000000014', 'ROOM305',    'TN2', 1),
  ('22222222-0000-4000-8000-000000000015', 'SUPERVISOR', 'TSV', 1)
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name,
  seat_slot = excluded.seat_slot, revoked_at = null, bound_at = now();

-- Owner-scoped fingerprint helper. Sections that need to inspect the closed
-- event's claim rows after the pointer moved use this; authenticated reads of
-- sc.completion_attempts have no grant, by design.
create temp table audit_fp_041 (k text primary key, v text) on commit drop;

set local role authenticated;

-- ---------------------------------------------------------------------------
-- 2. Refusal paths that must write absolutely nothing.
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; rev bigint; ev_before bigint; rev_state bigint; sub text;
begin
  select event_id into ev_before from sc.state where id = true;
  select revision into rev_state from sc.state where id = true;

  -- 2a. LOBBY cannot press it even if the event were closed (it is not).
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000011', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('OPEN_NEW_EVENT', '{}'::jsonb, rev, '041-lobby-refuse');
  if (v->>'ok')::boolean then raise exception 'ASSERT 041c: LOBBY must not open an event: %', v; end if;
  if v->>'code' <> 'PERMISSION_DENIED' then
    raise exception 'ASSERT 041d: a duty seat refusal is PERMISSION_DENIED, not a silent no-op: %', v;
  end if;
  -- 2b. NPC1, NPC2 and OPERATOR_02 all fail closed the same way.
  foreach sub in array array[
      '22222222-0000-4000-8000-000000000012',
      '22222222-0000-4000-8000-000000000013',
      '22222222-0000-4000-8000-000000000014']
  loop
    perform set_config('request.jwt.claim.sub', sub, true);
    rev := (public.state_revision()->>'revision')::bigint;
    v := public.handle_command('OPEN_NEW_EVENT', '{}'::jsonb, rev, '041-duty-refuse-' || sub);
    if v->>'code' <> 'PERMISSION_DENIED' then
      raise exception 'ASSERT 041e: duty seat must be refused: %', v;
    end if;
  end loop;

  -- 2c. SUPERVISOR refuses while the event is still live (event_ended_at is null).
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('OPEN_NEW_EVENT', '{}'::jsonb, rev, '041-live-refuse');
  if (v->>'ok')::boolean then raise exception 'ASSERT 041f: OPEN_NEW_EVENT must refuse on a live event: %', v; end if;
  if v->>'code' <> 'INVALID_STATE' then
    raise exception 'ASSERT 041g: a live event refuses with INVALID_STATE, not a permission error: %', v;
  end if;

  -- None of the refusals above moved the state pointer or wrote a revision bump.
  if (select event_id from sc.state where id = true) <> ev_before then
    raise exception 'ASSERT 041h: a refused OPEN_NEW_EVENT must not repoint the state';
  end if;
  if (select revision from sc.state where id = true) <> rev_state then
    raise exception 'ASSERT 041i: a refused OPEN_NEW_EVENT must not bump the revision';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Play one complete round and close the event.
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; rev bigint; rid bigint; aid bigint;
begin
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000011', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{"team_name":"Ca 1 doi 1"}'::jsonb, rev, '041-call');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041j: reception failed: %', v; end if;
  select id into rid from sc.rounds
    where event_id = (select event_id from sc.state where id = true)
    order by id desc limit 1;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000012', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_FLOOR2', '{}'::jsonb, rev, '041-floor2');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041k: floor 2 confirm failed: %', v; end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('START_GAME', '{}'::jsonb, rev, '041-start');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041l: START failed: %', v; end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000014', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CLAIM_COMPLETE', '{}'::jsonb, rev, '041-claim');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041m: claim failed: %', v; end if;
  -- Read the attempt id back through public.snapshot(), the only sanctioned
  -- path a client has to the claim table.
  select (a->>'id')::bigint into aid
    from jsonb_array_elements(public.snapshot()->'attempts') a
   where (a->>'round_id')::bigint = rid
   order by (a->>'id')::bigint desc limit 1;
  if aid is null then raise exception 'ASSERT 041m2: the recorded claim must be readable through the snapshot'; end if;
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('VERIFY_ATTEMPT',
        jsonb_build_object('attempt_id', aid, 'decision', 'VALID'), rev, '041-verify');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041n: verify failed: %', v; end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_EXIT', '{}'::jsonb, rev, '041-exit');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041o: exit failed: %', v; end if;
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('RESET_DONE', '{}'::jsonb, rev, '041-reset-hallway');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041p: hallway check failed: %', v; end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000014', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('RESET_DONE', '{}'::jsonb, rev, '041-reset-room');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041q: room checks failed: %', v; end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('GATE_FINALIZE', '{}'::jsonb, rev, '041-finalize');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041r: finalize failed: %', v; end if;

  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('END_EVENT', '{"reason":"hết ca"}'::jsonb, rev, '041-end');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041s: END_EVENT failed: %', v; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Fingerprint the closed event as the owner: rounds + claims + checklist +
--    audit + event row, all under the closed event's id. The reopen assertion
--    below compares against this exact fingerprint.
-- ---------------------------------------------------------------------------
reset role;
insert into audit_fp_041 (k, v)
values ('closed',
  (select id from sc.events where name = 'Open-new 041')::text || '|' ||
  coalesce((select md5(string_agg(to_jsonb(x)::text, '|' order by x.id))
              from sc.rounds x
             where x.event_id = (select id from sc.events where name = 'Open-new 041')), '') || '|' ||
  coalesce((select md5(string_agg(to_jsonb(a)::text, '|' order by a.id))
              from sc.completion_attempts a
              join sc.rounds r on r.id = a.round_id
             where r.event_id = (select id from sc.events where name = 'Open-new 041')), '') || '|' ||
  coalesce((select md5(string_agg(to_jsonb(t)::text, '|' order by t.round_id, t.task_key))
              from sc.reset_tasks t
              join sc.rounds r on r.id = t.round_id
             where r.event_id = (select id from sc.events where name = 'Open-new 041')), '') || '|' ||
  (select coalesce(max(seq), 0)::text from sc.action_log
      where event_id = (select id from sc.events where name = 'Open-new 041')));

set local role authenticated;

-- ---------------------------------------------------------------------------
-- 5. OPEN_NEW_EVENT on a closed event: the happy path.
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; rev bigint;
begin
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('OPEN_NEW_EVENT', '{"event_name":"Ca 2"}'::jsonb, rev, '041-open');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041v: OPEN_NEW_EVENT failed: %', v; end if;
  if v->>'message' <> 'ĐÃ MỞ SỰ KIỆN MỚI' then
    raise exception 'ASSERT 041w: the receipt is a plain Vietnamese sentence, got %', v->>'message';
  end if;
  -- The snapshot a phone reads next reports the fresh event: zero rounds, no
  -- claims, phase PRE_EVENT.
  v := public.snapshot();
  if jsonb_array_length(coalesce(v->'rounds','[]'::jsonb)) <> 0 then
    raise exception 'ASSERT 041ai: the fresh event shows no rounds';
  end if;
  if (v->>'phase') <> 'PRE_EVENT' then
    raise exception 'ASSERT 041ak: a fresh event reads PRE_EVENT, got %', v->>'phase';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Verify history preserved: the closed event's fingerprint is intact, the
--    state pointer moved to a fresh sc.events row, and that row inherited the
--    operational configuration while starting clocks and the team sequence at
--    zero.
-- ---------------------------------------------------------------------------
reset role;
do $$
declare
  ev_closed bigint; ev_new bigint; fp_then text; fp_now text;
begin
  -- The pointer moved to a fresh event id.
  select id into ev_closed from sc.events where name = 'Open-new 041';
  select event_id into ev_new from sc.state where id = true;
  if ev_new = ev_closed then
    raise exception 'ASSERT 041x: the state pointer must move to a fresh event';
  end if;
  -- The closed event is untouched: still ended, still the same name, and the
  -- exact same fingerprint of rounds/claims/checklist/audit 041 froze before
  -- the press.
  if (select event_ended_at from sc.events where id = ev_closed) is null then
    raise exception 'ASSERT 041y: the closed event must remain closed';
  end if;
  if (select name from sc.events where id = ev_closed) <> 'Open-new 041' then
    raise exception 'ASSERT 041z: the closed event''s name must not be rewritten';
  end if;
  select v into fp_then from audit_fp_041 where k = 'closed';
  fp_now :=
    ev_closed::text || '|' ||
    coalesce((select md5(string_agg(to_jsonb(x)::text, '|' order by x.id))
                from sc.rounds x where x.event_id = ev_closed), '') || '|' ||
    coalesce((select md5(string_agg(to_jsonb(a)::text, '|' order by a.id))
                from sc.completion_attempts a
                join sc.rounds r on r.id = a.round_id
               where r.event_id = ev_closed), '') || '|' ||
    coalesce((select md5(string_agg(to_jsonb(t)::text, '|' order by t.round_id, t.task_key))
                from sc.reset_tasks t
                join sc.rounds r on r.id = t.round_id
               where r.event_id = ev_closed), '') || '|' ||
    (select coalesce(max(seq), 0)::text from sc.action_log where event_id = ev_closed);
  if fp_then <> fp_now then
    raise exception 'ASSERT 041ae: OPEN_NEW_EVENT rewrote the closed event''s history: %', fp_now;
  end if;
  -- The new event inherited the operational configuration and reset every clock
  -- and the team sequence.
  if (select name from sc.events where id = ev_new) <> 'Ca 2' then
    raise exception 'ASSERT 041aa: the fresh event name override must land';
  end if;
  if (select game_limit_ms from sc.events where id = ev_new)
     <> (select game_limit_ms from sc.events where id = ev_closed) then
    raise exception 'ASSERT 041ab: the fresh event inherits the round window';
  end if;
  if (select hiding_layout from sc.events where id = ev_new) <> 'B'
     or (select hidden_object_owner from sc.events where id = ev_new) <> 'ROOM305' then
    raise exception 'ASSERT 041ac: layout and hidden-object owner carry forward';
  end if;
  if exists (select 1 from sc.events where id = ev_new
               and (event_started_at is not null or event_ended_at is not null
                    or next_team_number <> 1)) then
    raise exception 'ASSERT 041ad: a fresh event has no clocks and starts at team #001';
  end if;
  -- The pointer row still resolves to exactly one event; no orphan, no duplicate.
  if (select count(*) from sc.state where id = true) <> 1 then
    raise exception 'ASSERT 041ad2: sc.state must keep exactly one pointer row';
  end if;
end $$;

set local role authenticated;

-- ---------------------------------------------------------------------------
-- 7. The fresh event is immediately playable: OPERATOR_01 receives the first
--    team of the new night, and it lands on team #001 of the new event.
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; rev bigint; ev_new bigint;
begin
  select event_id into ev_new from sc.state where id = true;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000011', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{"team_name":"Ca 2 doi 1"}'::jsonb, rev, '041-call-2');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041al: reception on the new event failed: %', v; end if;
  if (select team_number from sc.rounds where event_id = ev_new order by id desc limit 1) <> 1 then
    raise exception 'ASSERT 041am: the new event restarts the sequence at #001';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Idempotency: the same tap that lands twice opens exactly one event.
--    We close the fresh event first (abort → exit → reset → finalize → end),
--    then press OPEN_NEW_EVENT twice with the same key.
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; rev bigint;
begin
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('ABORT_ROUND',
        jsonb_build_object('reason','dành cho lượt idempotency','kind','technical'),
        rev, '041-abort-idem');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041an: cancel for the retry probe failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_EXIT', '{}'::jsonb, rev, '041-exit-idem');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041ao: exit for the retry probe failed: %', v; end if;
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('RESET_DONE', '{}'::jsonb, rev, '041-hall-idem');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041ap: hallway for the retry probe failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000014', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('RESET_DONE', '{}'::jsonb, rev, '041-room-idem');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041aq: room for the retry probe failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000013', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('GATE_FINALIZE', '{}'::jsonb, rev, '041-fin-idem');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041ar: finalize for the retry probe failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('END_EVENT', '{"reason":"dùng cho retry"}'::jsonb, rev, '041-end-idem');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041as: close for the retry probe failed: %', v; end if;
end $$;

do $$
declare v jsonb; rev bigint; ev_first bigint; ev_second bigint;
begin
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000015', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('OPEN_NEW_EVENT', '{}'::jsonb, rev, '041-open-idem');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041at: first OPEN_NEW_EVENT failed: %', v; end if;
  select event_id into ev_first from sc.state where id = true;
  -- The retry uses the current revision of the fresh event, because the first
  -- press already advanced past the closed one.
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('OPEN_NEW_EVENT', '{}'::jsonb, rev, '041-open-idem');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 041au: the retry must be accepted as idempotent, got %', v; end if;
  select event_id into ev_second from sc.state where id = true;
  if ev_first <> ev_second then
    raise exception 'ASSERT 041av: the retry must not open a second event (% vs %)', ev_first, ev_second;
  end if;
end $$;

reset role;
update sc.operators set revoked_at = now() where revoked_at is null;

select '041 open new event: SUPERVISOR-only handoff after END_EVENT, permission '
    || 'surface, refusal paths, config inheritance, history preservation and '
    || 'idempotent retry: passed' as result;

rollback;
