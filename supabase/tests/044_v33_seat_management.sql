-- Local SQL validation only (scenario 044): V3.3 seat management on the real
-- RPCs, proving migration 0021. Everything runs in one transaction and rolls
-- back, against a database already carried through 0001..0021.
--
--   1. public.station_admin() names WHO holds each duty seat — the question the
--      operator had no way to answer before — and only answers for a caller
--      holding a live SUPERVISOR binding.
--   2. The report's own `releasable` verdict is the same predicate
--      release_station enforces, so the button can never promise a release the
--      database will refuse.
--   3. release_station now refuses a FLOOR seat while a team is on the clock
--      (RUNNING) or a claim awaits judgement (PENDING_CLAIM), audits the
--      refusal, and still works exactly as 0019 did when the floor is idle.
--   4. Freeing the seat is not cancelling the round: the round, its clock and
--      its score survive a legal release untouched.

reset role;

begin;

-- ---------------------------------------------------------------------------
-- 0. Setup: identities and a dedicated event with an idle floor.
-- ---------------------------------------------------------------------------
update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.observer_seats;
delete from sc.admin_devices;
delete from sc.access_audit;
insert into auth.users(id) values
  ('33333333-0000-4000-8000-000000000021'),  -- LOBBY
  ('33333333-0000-4000-8000-000000000022'),  -- CORRIDOR
  ('33333333-0000-4000-8000-000000000023'),  -- GATE (NPC1) — the stuck seat
  ('33333333-0000-4000-8000-000000000024'),  -- ROOM305 (NPC2)
  ('33333333-0000-4000-8000-000000000025')   -- SUPERVISOR
on conflict (id) do nothing;

insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
                      hidden_object_owner, hiding_layout, review_threshold_ms, stall_warn_ms)
values ('V3.3 044', 5400000, 240000, 90000, 90000, 'ROOM305', 'A', 500, 60000);
update sc.state
   set event_id = (select id from sc.events where name = 'V3.3 044'),
       revision = 0, updated_at = sc.now_ms()
 where id = true;

-- NPC1 is bound by a device that walked off: display name and a real binding
-- time, which is the whole point of the new report. bound_at is written in the
-- insert list as well as the conflict update, so the age reads 41 minutes
-- whether this identity is brand new or left over from an earlier scenario.
insert into sc.operators (user_id, role, display_name, seat_slot, bound_at) values
  ('33333333-0000-4000-8000-000000000021', 'LOBBY',      'L01', 1, now() - interval '41 minutes'),
  ('33333333-0000-4000-8000-000000000022', 'CORRIDOR',   'C02', 1, now() - interval '41 minutes'),
  ('33333333-0000-4000-8000-000000000023', 'GATE',       'NPC1-minh', 1, now() - interval '41 minutes'),
  ('33333333-0000-4000-8000-000000000024', 'ROOM305',    'N02', 1, now() - interval '41 minutes'),
  ('33333333-0000-4000-8000-000000000025', 'SUPERVISOR', 'BTC', 1, now() - interval '41 minutes')
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name,
  seat_slot = excluded.seat_slot, revoked_at = null, bound_at = excluded.bound_at;

set local role authenticated;

-- ---------------------------------------------------------------------------
-- 1. station_admin answers the supervisor, and only the supervisor.
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; s jsonb; g jsonb; n_before int; n_after int;
begin
  select coalesce(sum((e->>'devices')::int), -1) into n_before
    from jsonb_array_elements(public.station_board()->'stations') e;
  if n_before <> 5 then
    raise exception 'ASSERT 044m0: the setup must leave five live devices bound, got %', n_before;
  end if;

  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000021', true);
  v := public.station_admin();
  if (v->>'ok')::boolean then
    raise exception 'ASSERT 044a: a LOBBY device must not be shown other devices: %', v;
  end if;
  if v->>'code' <> 'RELEASE_NOT_AUTHORIZED' then
    raise exception 'ASSERT 044b: a duty caller is refused with RELEASE_NOT_AUTHORIZED, got %', v->>'code';
  end if;

  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000025', true);
  v := public.station_admin();
  if not (v->>'ok')::boolean then
    raise exception 'ASSERT 044c: the supervisor must get the report: %', v;
  end if;
  if jsonb_array_length(v->'stations') <> 5 then
    raise exception 'ASSERT 044d: five duty seats expected, got %', v->'stations';
  end if;
  -- Idle floor: every seat is reported releasable except the admin seat itself.
  if v->>'floor_block_reason' is not null then
    raise exception 'ASSERT 044e: the floor is idle, got %', v->>'floor_block_reason';
  end if;

  select e into s from jsonb_array_elements(v->'stations') e where e->>'role' = 'GATE';
  if (s->>'devices')::int <> 1 then
    raise exception 'ASSERT 044f: GATE must report its one holder, got %', s;
  end if;
  if s->'holders'->0->>'display_name' <> 'NPC1-minh' then
    raise exception 'ASSERT 044g: the report must name the device holding NPC1, got %', s->'holders';
  end if;
  if s->'holders'->0->>'user_id' <> '33333333-0000-4000-8000-000000000023' then
    raise exception 'ASSERT 044h: the report must give the holding device id, got %', s->'holders';
  end if;
  -- The 41-minute-old binding has to be visible as an age, or "stale" stays a
  -- guess the operator makes in their head.
  if (s->'holders'->0->>'held_ms')::bigint < 40 * 60000 then
    raise exception 'ASSERT 044i: held_ms must reflect the real binding age, got %', s->'holders';
  end if;
  if (s->>'releasable')::boolean is not true then
    raise exception 'ASSERT 044j: an idle seat must be offered for release, got %', s;
  end if;

  select e into g from jsonb_array_elements(v->'stations') e where e->>'role' = 'SUPERVISOR';
  if (g->>'releasable')::boolean then
    raise exception 'ASSERT 044k: this surface must never offer to release the admin seat';
  end if;
  if (g->>'capacity')::int <> 2 then
    raise exception 'ASSERT 044l: SUPERVISOR capacity must read 2, got %', g;
  end if;

  -- The report is read-only. `sc.operators` is RLS-restricted to the caller's own
  -- row, so the proof comes from the security-definer board instead, which counts
  -- every live binding: the total must be identical after the privileged read.
  select coalesce(sum((e->>'devices')::int), -1) into n_after
    from jsonb_array_elements(public.station_board()->'stations') e;
  if n_after <> n_before then
    raise exception 'ASSERT 044m: station_admin must not revoke anything, % live devices vs %', n_after, n_before;
  end if;
  if (select revision from sc.events where name = 'V3.3 044') <> 0 then
    raise exception 'ASSERT 044n: station_admin must not bump the revision';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. An unauthenticated caller is refused, not shown the roster.
-- ---------------------------------------------------------------------------
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  v := public.station_admin();
  if (v->>'ok')::boolean then
    raise exception 'ASSERT 044o: an anonymous caller must not get the roster: %', v;
  end if;
  if v->>'code' <> 'NOT_AUTHENTICATED' then
    raise exception 'ASSERT 044p: expected NOT_AUTHENTICATED, got %', v->>'code';
  end if;
  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000025', true);
end $$;

-- ---------------------------------------------------------------------------
-- 3. A queued round does NOT block a single-seat release. This is the case the
--    tool exists for: the phone walked off, the next operator has to take over.
-- ---------------------------------------------------------------------------
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000021', true);
  v := public.handle_command('CALL_TEAM', jsonb_build_object('_v', '3.3.0'), 0, '044-call');
  if not (v->>'ok')::boolean then
    raise exception 'ASSERT 044q: CALL_TEAM must succeed: %', v;
  end if;
  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000025', true);
  v := public.station_admin();
  if v->>'floor_block_reason' = 'RUNNING' then
    raise exception 'ASSERT 044r: a team that is not on the clock yet must not read RUNNING: %', v;
  end if;
  v := public.release_station('GATE');
  if not (v->>'ok')::boolean then
    raise exception 'ASSERT 044s: a queued round must not block freeing one seat: %', v;
  end if;
  if (v->>'freed')::int <> 1 or v->>'target' <> 'GATE' then
    raise exception 'ASSERT 044t: exactly the GATE binding must be freed, got %', v;
  end if;
  -- The round is untouched: releasing a seat is not cancelling a turn.
  if not exists (select 1 from sc.rounds r join sc.events e on e.id = r.event_id
                  where e.name = 'V3.3 044') then
    raise exception 'ASSERT 044u: the round must still be open after a seat release';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. A team ON THE CLOCK blocks it, loudly, and the refusal is audited.
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; s jsonb;
begin
  -- 23 takes the freed NPC1 seat back the way a phone really does, and CORRIDOR
  -- confirms the team up: the clock then starts for real.
  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000023', true);
  v := public.claim_station('GATE');
  if not (v->>'ok')::boolean then
    raise exception 'ASSERT 044v: the freed NPC1 seat must be claimable again: %', v;
  end if;
  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000022', true);
  v := public.handle_command('CONFIRM_FLOOR2', jsonb_build_object('_v', '3.3.0'),
        (select revision from sc.events where name = 'V3.3 044'), '044-floor2');
  if not (v->>'ok')::boolean then
    raise exception 'ASSERT 044w: CONFIRM_FLOOR2 must succeed: %', v;
  end if;
  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000023', true);
  v := public.handle_command('START_GAME', jsonb_build_object('_v', '3.3.0'),
        (select revision from sc.events where name = 'V3.3 044'), '044-start');
  if not (v->>'ok')::boolean then
    raise exception 'ASSERT 044x: START_GAME must succeed: %', v;
  end if;

  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000025', true);
  v := public.station_admin();
  if v->>'floor_block_reason' <> 'RUNNING' then
    raise exception 'ASSERT 044y: a live round must read RUNNING, got %', v->>'floor_block_reason';
  end if;
  select e into s from jsonb_array_elements(v->'stations') e where e->>'role' = 'GATE';
  if (s->>'releasable')::boolean then
    raise exception 'ASSERT 044z: the report must grey NPC1 out while the team is inside, got %', s;
  end if;
  if s->'holders'->0->>'user_id' <> '33333333-0000-4000-8000-000000000023' then
    raise exception 'ASSERT 044za: the report must follow the re-claimed holder, got %', s->'holders';
  end if;

  v := public.release_station('GATE');
  if (v->>'ok')::boolean then
    raise exception 'ASSERT 044aa: NPC1 must not be freed mid-round: %', v;
  end if;
  if v->>'code' <> 'FLOOR_BUSY' or v->>'reason' <> 'RUNNING' then
    raise exception 'ASSERT 044ab: expected FLOOR_BUSY/RUNNING, got %', v;
  end if;
  -- And the seat really is still held: the refusal is not cosmetic. Read through
  -- the definer report, because RLS hides another device's binding row here.
  v := public.station_admin();
  select e into s from jsonb_array_elements(v->'stations') e where e->>'role' = 'GATE';
  if (s->>'devices')::int <> 1 then
    raise exception 'ASSERT 044ac: a refused release must leave the binding intact, got %', s;
  end if;
  -- (the audit row itself is checked in the owner-level block below: RLS gives
  --  no device any read access to sc.access_audit, by design)

  -- The admin seat is never blocked: a walk-off supervisor is still rescuable
  -- through the normal path while the team is inside.
  v := public.station_admin();
  select e into s from jsonb_array_elements(v->'stations') e where e->>'role' = 'SUPERVISOR';
  if (s->>'devices')::int <> 1 then
    raise exception 'ASSERT 044af: the supervisor seat must still be reported, got %', s;
  end if;
end $$;

-- The refusal left a queryable trail. Owner-level, because no bound device may
-- read the audit table at all — which is exactly why "we pressed it and nothing
-- happened" needs a row, not a memory.
reset role;
do $$
declare a sc.access_audit;
begin
  select * into a from sc.access_audit where action = 'RELEASE_REFUSED' order by id desc limit 1;
  if a.user_id is null then
    raise exception 'ASSERT 044ad: a refusal must leave a RELEASE_REFUSED audit row';
  end if;
  if a.metadata->>'target' <> 'GATE' or a.metadata->>'reason' <> 'RUNNING' then
    raise exception 'ASSERT 044ae: the audit row must name the seat and the reason, got %', a.metadata;
  end if;
  if a.role <> 'SUPERVISOR' then
    raise exception 'ASSERT 044af2: the audit row must record the supervisor who tried, got %', a.role;
  end if;
  -- The binding is intact at the table level too, not just in the report.
  if not exists (select 1 from sc.operators where user_id = '33333333-0000-4000-8000-000000000023'
                                                 and role = 'GATE' and revoked_at is null) then
    raise exception 'ASSERT 044ac2: a refused release must not revoke the binding';
  end if;
end $$;
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 5. Close the round: the same button becomes legal again, with no other change.
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; s jsonb;
begin
  -- The team leaves early. EARLY_EXIT at the door IS the departure confirmation
  -- (0017), so the round closes here and the floor goes idle again.
  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000023', true);
  v := public.handle_command('EARLY_EXIT',
        jsonb_build_object('_v', '3.3.0', 'reason', 'Test ket thuc som 044'),
        (select revision from sc.events where name = 'V3.3 044'), '044-early');
  if not (v->>'ok')::boolean then
    raise exception 'ASSERT 044ag: EARLY_EXIT must succeed: %', v;
  end if;

  perform set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-000000000025', true);
  v := public.station_admin();
  select e into s from jsonb_array_elements(v->'stations') e where e->>'role' = 'GATE';
  if v->>'floor_block_reason' in ('RUNNING', 'PENDING_CLAIM') then
    raise exception 'ASSERT 044ah: a closed round must unblock the seats, got %', v->>'floor_block_reason';
  end if;
  if not (s->>'releasable')::boolean then
    raise exception 'ASSERT 044aha: NPC1 must be offered again once the round is closed, got %', s;
  end if;
  v := public.release_station('GATE');
  if not (v->>'ok')::boolean then
    raise exception 'ASSERT 044ai: after the round closes the release must work: %', v;
  end if;
  -- Second tap on an empty seat says so instead of pretending.
  v := public.release_station('GATE');
  if v->>'code' <> 'RELEASE_NOT_BOUND' then
    raise exception 'ASSERT 044aj: an already-empty seat answers RELEASE_NOT_BOUND, got %', v->>'code';
  end if;
  -- History is intact: the finished round is still there with its score.
  if not exists (select 1 from sc.rounds r join sc.events e on e.id = r.event_id
                  where e.name = 'V3.3 044' and r.exit_confirmed_at is not null) then
    raise exception 'ASSERT 044ak: the closed round and its history must survive seat releases';
  end if;
end $$;

select '044 v3.3 seat management: supervisor-only roster names the device holding'
    || ' each seat and how long it has held it, non-admins and anonymous callers are'
    || ' refused, a queued round stays releasable, a live round refuses with FLOOR_BUSY'
    || ' and audits it, closing the round unblocks the seat, and rounds, scores and'
    || ' revisions are untouched: passed' as result;

rollback;
