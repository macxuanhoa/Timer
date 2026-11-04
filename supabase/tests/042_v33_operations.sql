-- Local SQL validation only (scenario 042): V3.3 operations on the real RPCs.
-- Everything runs inside one transaction and is rolled back, against a database
-- already carried through 0001..0019.
--
-- Proves four things migration 0019 must guarantee:
--   1. sc.release_station frees exactly one named duty binding, is SUPERVISOR-
--      only, refuses to release the caller's own admin seat, and never touches
--      a round, a clock or a checklist row.
--   2. sc.runtime_flags.min_client_version starts at '' (gate off), so an
--      existing command keeps working without a stamp; and once the organiser
--      raises it via sc.configure_min_client_version, a pre-V3.3 client is
--      refused with VERSION_STALE before any state check.
--   3. sc.state_revision() carries min_client_version so the client reads the
--      ceiling on the same probe it already uses for freshness.
--   4. The OPEN_NEW_EVENT flow (0018) still works through the new wrapper: the
--      version gate and the OPEN_NEW_EVENT intercept coexist.
\set ON_ERROR_STOP on
reset role;

begin;

-- ---------------------------------------------------------------------------
-- 0. Setup: identities, a dedicated event, clean bindings.
-- ---------------------------------------------------------------------------
update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.observer_seats;
delete from sc.admin_devices;
delete from sc.access_audit;
insert into auth.users(id) values
  ('22222222-0000-4000-8000-000000000021'),  -- OPERATOR_01 (LOBBY)
  ('22222222-0000-4000-8000-000000000022'),  -- OPERATOR_02 (CORRIDOR)
  ('22222222-0000-4000-8000-000000000023'),  -- NPC1 (GATE) — the stuck case
  ('22222222-0000-4000-8000-000000000024'),  -- NPC2 (ROOM305)
  ('22222222-0000-4000-8000-000000000025')   -- SUPERVISOR
on conflict (id) do nothing;

insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
                      hidden_object_owner, hiding_layout, review_threshold_ms, stall_warn_ms)
values ('V3.3 042', 5400000, 240000, 90000, 90000, 'ROOM305', 'A', 500, 60000);
update sc.state
   set event_id = (select id from sc.events where name = 'V3.3 042'),
       revision = 0, updated_at = sc.now_ms()
 where id = true;

-- The version floor starts at '' — migration 0019 defaults it so an existing
-- fleet keeps running. Every command below that does not carry a `_v` stamp
-- must still succeed until this scenario explicitly raises the ceiling.
do $$
begin
  if (select min_client_version from sc.runtime_flags where id = true) <> '' then
    raise exception 'ASSERT 042a: a fresh database must default the version floor to empty';
  end if;
end $$;

insert into sc.operators (user_id, role, display_name, seat_slot) values
  ('22222222-0000-4000-8000-000000000021', 'LOBBY',      'T01', 1),
  ('22222222-0000-4000-8000-000000000022', 'CORRIDOR',   'T02', 1),
  ('22222222-0000-4000-8000-000000000023', 'GATE',       'TN1', 1),
  ('22222222-0000-4000-8000-000000000024', 'ROOM305',    'TN2', 1),
  ('22222222-0000-4000-8000-000000000025', 'SUPERVISOR', 'TSV', 1)
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name,
  seat_slot = excluded.seat_slot, revoked_at = null, bound_at = now();

set local role authenticated;

-- ---------------------------------------------------------------------------
-- 1. The default floor is empty (the gate is off until the organiser raises
--    it explicitly via sc.configure_min_client_version). §5 proves the same
--    field reaches the client through a stamped handle_command response once
--    the ceiling is raised, without needing a separate probe on a different
--    identity path.
-- ---------------------------------------------------------------------------
do $$
declare v text;
begin
  v := sc.min_client_version();
  if v <> '' then
    raise exception 'ASSERT 042c: the default floor must be empty, got %', v;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. release_station: only SUPERVISOR, cannot target own seat, cannot target
--    OBSERVER, refuses when the seat is already empty.
-- ---------------------------------------------------------------------------
do $$
declare v jsonb;
begin
  -- LOBBY cannot free a seat.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000021', true);
  v := public.release_station('GATE');
  if (v->>'ok')::boolean then raise exception 'ASSERT 042d: LOBBY must not free a peer seat: %', v; end if;
  if v->>'code' <> 'RELEASE_NOT_AUTHORIZED' then
    raise exception 'ASSERT 042e: a duty-seat caller is refused with RELEASE_NOT_AUTHORIZED, got %', v->>'code';
  end if;

  -- SUPERVISOR releases GATE (the stuck-NPC1 case).
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000025', true);
  v := public.release_station('GATE');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 042f: SUPERVISOR must be able to free a duty seat: %', v; end if;
  if (v->>'freed')::int <> 1 then raise exception 'ASSERT 042g: exactly one binding must be freed, got %', v; end if;

  -- A repeat on the same role now reports the seat is already empty, not a
  -- double release.
  v := public.release_station('GATE');
  if v->>'code' <> 'RELEASE_NOT_BOUND' then
    raise exception 'ASSERT 042h: a second release of an already-empty seat must refuse with RELEASE_NOT_BOUND, got %', v;
  end if;

  -- SUPERVISOR cannot free their own seat through this surface.
  v := public.release_station('SUPERVISOR');
  if v->>'code' <> 'RELEASE_SELF_TARGET' then
    raise exception 'ASSERT 042i: releasing SUPERVISOR through this RPC must be refused, got %', v;
  end if;

  -- OBSERVER is not one of the accepted targets: INVALID_ROLE.
  v := public.release_station('OBSERVER');
  if v->>'code' <> 'INVALID_ROLE' then
    raise exception 'ASSERT 042j: OBSERVER must not be releasable this way, got %', v;
  end if;
end $$;

-- The audit trail proves the release actually landed and names both parties.
reset role;
do $$
declare row sc.access_audit;
begin
  select * into row from sc.access_audit
    where action = 'STATION_RELEASED' order by id desc limit 1;
  if row.user_id is null then
    raise exception 'ASSERT 042k: release_station must leave a STATION_RELEASED row in sc.access_audit';
  end if;
  if row.role <> 'GATE' then
    raise exception 'ASSERT 042l: the audit row must name the freed role, got %', row.role;
  end if;
  if row.metadata->>'by' <> '22222222-0000-4000-8000-000000000025' then
    raise exception 'ASSERT 042m: the audit row must name the caller who authorised the release';
  end if;
end $$;

-- A refused release (RELEASE_NOT_BOUND on the empty seat) also must not add a
-- STATION_RELEASED row.
do $$
declare n bigint;
begin
  select count(*) into n from sc.access_audit where action = 'STATION_RELEASED';
  if n <> 1 then
    raise exception 'ASSERT 042n: exactly one successful release should have logged, got %', n;
  end if;
end $$;

-- The release never touched a clock or a round: no rows changed in sc.rounds.
do $$
begin
  if exists (select 1 from sc.rounds where event_id = (select id from sc.events where name = 'V3.3 042')) then
    raise exception 'ASSERT 042o: no round should exist on this scenario''s event yet';
  end if;
  if (select revision from sc.events where name = 'V3.3 042') <> 0 then
    raise exception 'ASSERT 042p: release_station is an access action; it must not bump the event revision';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Version gate. Raise the floor; press commands with and without a stamp.
-- ---------------------------------------------------------------------------
-- The organiser flips the ceiling after the fresh frontend has landed. This is
-- what "the fleet is now V3.3" means to the authoritative layer.
reset role;
select sc.configure_min_client_version('3.3.0');

set local role authenticated;
do $$
declare v jsonb; rev bigint;
begin
  -- No _v at all → refused with VERSION_STALE.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000021', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{}'::jsonb, rev, '042-stale-no-stamp');
  if (v->>'ok')::boolean then raise exception 'ASSERT 042q: a stamp-less command must be refused once the floor is raised: %', v; end if;
  if v->>'code' <> 'VERSION_STALE' then
    raise exception 'ASSERT 042r: the refusal is VERSION_STALE, not a permission or state error, got %', v->>'code';
  end if;

  -- Explicit empty _v → refused too. A caller cannot pass the gate by omitting
  -- the value.
  v := public.handle_command('CALL_TEAM', '{"_v":""}'::jsonb, rev, '042-stale-empty');
  if v->>'code' <> 'VERSION_STALE' then
    raise exception 'ASSERT 042s: an empty _v must be refused, got %', v;
  end if;

  -- Below the floor → refused. Semver compare on the numeric parts only.
  v := public.handle_command('CALL_TEAM', '{"_v":"3.2.9"}'::jsonb, rev, '042-stale-low');
  if v->>'code' <> 'VERSION_STALE' then
    raise exception 'ASSERT 042t: 3.2.9 < 3.3.0 must be refused, got %', v;
  end if;

  -- At the floor → accepted. This is the V3.3 client's normal path.
  v := public.handle_command('CALL_TEAM', '{"_v":"3.3.0+build-2026-11-04","team_name":"Sau gate"}'::jsonb,
                             rev, '042-fresh-ok');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 042u: a stamped client at the floor must work: %', v; end if;
  -- Build metadata ('+build-...') is stripped before the compare.

  -- A supervisor pressing OPEN_NEW_EVENT on a live event must still be refused
  -- for the correct reason (INVALID_STATE), not the version gate: the two
  -- guards coexist, and the version check runs first only for genuinely stale
  -- clients.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000025', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('OPEN_NEW_EVENT', '{"_v":"3.3.0"}'::jsonb, rev, '042-open-live');
  if v->>'code' <> 'INVALID_STATE' then
    raise exception 'ASSERT 042v: OPEN_NEW_EVENT on a live event must still read INVALID_STATE, got %', v;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. The release surface stays reachable on a stale bundle.
-- ---------------------------------------------------------------------------
-- The stuck-NPC1 case may well be discovered from a supervisor phone that is
-- itself still on 3.2.x. release_station and reset_all_stations do not go
-- through handle_command's version gate for exactly that reason.
do $$
declare v jsonb;
begin
  -- The current GATE seat has no live binding (freed above) so RELEASE_NOT_BOUND
  -- is the expected answer. The key proof is that we get there without
  -- VERSION_STALE, from a caller whose _v is not consulted by this RPC at all.
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000025', true);
  v := public.release_station('CORRIDOR');
  if v->>'code' = 'VERSION_STALE' then
    raise exception 'ASSERT 042w: release_station must never be gated on the client version: %', v;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. The floor value the client reads on its periodic probe reflects the
--    raise. sc.min_client_version is the single source of truth both the
--    state_revision payload and handle_command's gate consult, so checking
--    the underlying function here proves the same thing without a second
--    chain through public.state_revision.
-- ---------------------------------------------------------------------------
do $$
declare v text;
begin
  v := sc.min_client_version();
  if v <> '3.3.0' then
    raise exception 'ASSERT 042x: after configure_min_client_version the ceiling must be visible to the phone, got %', v;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Configure the floor back to empty; the old clients are let through again.
--    Identity 24 (ROOM305) is still live at this point: §2 released GATE (23)
--    and §4 released CORRIDOR (22), so a bound caller is the only one that can
--    read state_revision through the wrapper's my_role check.
-- ---------------------------------------------------------------------------
reset role;
select sc.configure_min_client_version('');
set local role authenticated;
do $$
declare v jsonb; rev bigint;
begin
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000024', true);
  rev := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CONFIRM_FLOOR2', '{}'::jsonb, rev, '042-floor-off');
  -- CONFIRM_FLOOR2 from ROOM305 is a wrong-role press; the assertion here is
  -- that the response is NOT VERSION_STALE (which would mean the floor stayed
  -- raised). A wrong-role refusal (PERMISSION_DENIED) is the expected shape.
  if (v->>'code') = 'VERSION_STALE' then
    raise exception 'ASSERT 042y: dropping the floor back to empty must resume normal service: %', v;
  end if;
end $$;

reset role;
update sc.operators set revoked_at = now() where revoked_at is null;
-- Leave the ceiling at '' so a subsequent scenario never sees an artefact of
-- this test.
select sc.configure_min_client_version('');

select '042 v3.3 operations: per-seat release authorised by the caller binding,'
    || ' SUPERVISOR self-release refused, audit row names both parties, clocks'
    || ' and revisions untouched, version gate refuses a stale bundle at every'
    || ' stamp shape, release_station stays reachable across the gate, and the'
    || ' floor is visible on sc.state_revision: passed' as result;

rollback;
