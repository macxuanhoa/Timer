-- Local SQL validation only (scenario 045): the identity shape Production
-- actually uses, proving migration 0022.
--
-- Scenario 044 drives station_admin while setting `request.jwt.claim.sub`, the
-- legacy per-claim GUC the local stub happens to understand. Supabase does not
-- publish that GUC; it publishes `request.jwt.claims` (the decoded token) and
-- expects auth.uid() to resolve the subject from it. That difference is exactly
-- how 0021 shipped a supervisor report that answered NOT_AUTHENTICATED in
-- Production while every local test passed.
--
-- So this scenario sets ONLY the claims JSON — no legacy GUC at all — and then
-- proves:
--   1. the SUPERVISOR gets the roster, with the holder's name and the idle-floor
--      verdict (auth.uid() resolved through the claims fallback);
--   2. a duty caller is still refused with RELEASE_NOT_AUTHORIZED, so the fix
--      widened the identity source without widening the authorisation;
--   3. release_station, which has always used auth.uid(), resolves the same
--      caller from the same token and frees the seat;
--   4. the roster reflects the release afterwards.
--
-- Everything runs in one transaction and rolls back.

reset role;

begin;

-- ---------------------------------------------------------------------------
-- 0. Setup: a dedicated event, one supervisor and three duty seats.
-- ---------------------------------------------------------------------------
update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.observer_seats;
delete from sc.admin_devices;

insert into auth.users(id) values
  ('44444444-0000-4000-8000-000000000021'),  -- LOBBY (duty caller)
  ('44444444-0000-4000-8000-000000000023'),  -- GATE (NPC1, the stuck seat)
  ('44444444-0000-4000-8000-000000000025')   -- SUPERVISOR
on conflict (id) do nothing;

insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
                      hidden_object_owner, hiding_layout, review_threshold_ms, stall_warn_ms)
values ('V3.3 045', 5400000, 240000, 90000, 90000, 'ROOM305', 'A', 500, 60000);
update sc.state
   set event_id = (select id from sc.events where name = 'V3.3 045'),
       revision = 0, updated_at = sc.now_ms()
 where id = true;

insert into sc.operators (user_id, role, display_name, seat_slot, bound_at) values
  ('44444444-0000-4000-8000-000000000021', 'LOBBY',      'L-045', 1, now() - interval '12 minutes'),
  ('44444444-0000-4000-8000-000000000023', 'GATE',       'NPC1-045', 1, now() - interval '12 minutes'),
  ('44444444-0000-4000-8000-000000000025', 'SUPERVISOR', 'BTC-045', 1, now() - interval '12 minutes')
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name,
  seat_slot = excluded.seat_slot, revoked_at = null, bound_at = excluded.bound_at;

set local role authenticated;

do $$
declare
  v jsonb;
  g jsonb;
begin
  -- The Production token shape: only the decoded claims JSON exists. If the
  -- function still read `request.jwt.claim.sub`, v_caller would be null here.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '44444444-0000-4000-8000-000000000025',
                       'role', 'authenticated', 'is_anonymous', true)::text, true);

  v := public.station_admin();
  if not (v->>'ok')::boolean then
    raise exception 'ASSERT 045a: the supervisor must be recognised from the claims JSON: %', v;
  end if;
  if v->>'code' <> 'STATION_ADMIN_OK' then
    raise exception 'ASSERT 045b: expected STATION_ADMIN_OK, got %', v->>'code';
  end if;
  if v->>'floor_block_reason' is not null then
    raise exception 'ASSERT 045c: the floor is idle, got %', v->>'floor_block_reason';
  end if;

  select s into g from jsonb_array_elements(v->'stations') s where s->>'role' = 'GATE';
  if g is null then
    raise exception 'ASSERT 045d: GATE is missing from the roster: %', v->'stations';
  end if;
  if (g->>'devices')::int <> 1 then
    raise exception 'ASSERT 045e: NPC1 must still read as held, got %', g;
  end if;
  if g->'holders'->0->>'display_name' is distinct from 'NPC1-045' then
    raise exception 'ASSERT 045f: the holder name must come through, got %', g->'holders';
  end if;
  if (g->>'releasable')::boolean is not true then
    raise exception 'ASSERT 045g: an idle floor makes GATE releasable: %', g;
  end if;

  -- A duty caller with the same claims shape is still refused: the identity
  -- source was fixed, the authorisation was not loosened.
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '44444444-0000-4000-8000-000000000021',
                       'role', 'authenticated', 'is_anonymous', true)::text, true);
  v := public.station_admin();
  if (v->>'ok')::boolean or v->>'code' <> 'RELEASE_NOT_AUTHORIZED' then
    raise exception 'ASSERT 045h: a duty caller must be refused, got %', v;
  end if;

  -- Back to the supervisor: release_station resolves the same token and the
  -- stuck seat actually frees through the production-shaped identity.
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '44444444-0000-4000-8000-000000000025',
                       'role', 'authenticated', 'is_anonymous', true)::text, true);
  v := public.release_station('GATE');
  if not (v->>'ok')::boolean or (v->>'freed')::int <> 1 then
    raise exception 'ASSERT 045i: the supervisor must free exactly NPC1, got %', v;
  end if;

  v := public.station_admin();
  select s into g from jsonb_array_elements(v->'stations') s where s->>'role' = 'GATE';
  if (g->>'devices')::int <> 0 then
    raise exception 'ASSERT 045j: GATE must read free after the release, got %', g;
  end if;
  -- The other seats were not swept.
  select s into g from jsonb_array_elements(v->'stations') s where s->>'role' = 'LOBBY';
  if (g->>'devices')::int <> 1 then
    raise exception 'ASSERT 045k: a per-seat release must not touch LOBBY, got %', g;
  end if;

  raise notice '045 v3.3 station_admin identity: passed';
end $$;

rollback;
