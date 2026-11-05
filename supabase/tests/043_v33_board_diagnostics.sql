-- Local SQL validation only (scenario 043): V3.3 board diagnostics.
-- Migration 0020 extends the public station_board with the event's real state
-- and the version floor, and adds public.min_client_version() as a session-free
-- read. Both must hold three promises:
--   * the fields the V3.2 and V3.3 pickers validate are byte-identical to the
--     0017 board (board_version 3, capacity_max per seat, the same counters), so
--     no client ever distrusts the payload and wedges at "ĐANG ĐỒNG BỘ";
--   * the event fields answer "is the night really closed?" with no session at
--     all, which is exactly the read support needs on Production;
--   * the fields follow OPEN_NEW_EVENT, so a phone that polls the board instead
--     of holding a websocket still sees the handoff within its next read.
-- Read-only against hosted data semantics; everything here rolls back.
\set ON_ERROR_STOP on
reset role;

begin;

-- ---------------------------------------------------------------------------
-- 0. Bindings and one owned event.
-- ---------------------------------------------------------------------------
update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.observer_seats;
delete from sc.admin_devices;
insert into auth.users(id) values
  ('22222222-0000-4000-8000-000000000031'),  -- OPERATOR_01 (LOBBY)
  ('22222222-0000-4000-8000-000000000035')   -- SUPERVISOR
on conflict (id) do nothing;

insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
                      hidden_object_owner, hiding_layout, review_threshold_ms, stall_warn_ms)
values ('Board 043', 5400000, 240000, 90000, 90000, 'ROOM305', 'A', 500, 60000);
update sc.state
   set event_id = (select id from sc.events where name = 'Board 043'),
       revision = 0, updated_at = sc.now_ms()
 where id = true;

insert into sc.operators (user_id, role, display_name, seat_slot) values
  ('22222222-0000-4000-8000-000000000031', 'LOBBY',      'T01', 1),
  ('22222222-0000-4000-8000-000000000035', 'SUPERVISOR', 'TSV', 1)
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name,
  seat_slot = excluded.seat_slot, revoked_at = null, bound_at = now();

-- ---------------------------------------------------------------------------
-- 1. station_board keeps its validated contract and adds the new fields.
--    Read as the board owner: the shape must match what the Home picker checks
--    (board_version >= 2, device_capacity 6, observer_capacity 10, and each
--    seat's capacity equal to the client's own SEAT_CAPACITY table).
-- ---------------------------------------------------------------------------
do $$
declare b jsonb; seat jsonb;
begin
  b := public.station_board();
  if (b->>'board_version')::int <> 3 then
    raise exception 'ASSERT 043a: board_version must stay 3 so existing pickers trust it, got %', b->>'board_version';
  end if;
  if (b->>'device_capacity')::int <> 6 or (b->>'capacity')::int <> 5 then
    raise exception 'ASSERT 043b: the operator counters must be unchanged, got %', b;
  end if;
  if (b->>'observer_capacity')::int <> 10 then
    raise exception 'ASSERT 043c: the observer capacity must be unchanged, got %', b->>'observer_capacity';
  end if;
  -- The seats array must still describe every role with its client-expected
  -- capacity, because Home.tsx refuses to trust a board that does not.
  for seat in select jsonb_array_elements(b->'stations')
  loop
    if not (
         (seat->>'role' in ('LOBBY','CORRIDOR','GATE','ROOM305') and seat->>'capacity' = '1')
      or (seat->>'role' = 'SUPERVISOR' and seat->>'capacity' = '2')
      or (seat->>'role' = 'OBSERVER'   and seat->>'capacity' = '10')
    ) then
      raise exception 'ASSERT 043d: seat % carries capacity % instead of the contract value',
        seat->>'role', seat->>'capacity';
    end if;
  end loop;
  -- The V3.3 additions.
  if b->>'min_client_version' is null then
    raise exception 'ASSERT 043e: the board must carry the version floor (empty string counts as present)';
  end if;
  if b->>'event_id' is null then
    raise exception 'ASSERT 043f: the board must name the event the state pointer holds';
  end if;
  if (b->>'event_id')::bigint <> (select id from sc.events where name = 'Board 043') then
    raise exception 'ASSERT 043g: the board must follow the state pointer';
  end if;
  if b->>'event_name' <> 'Board 043' then
    raise exception 'ASSERT 043h: the board must publish the event name, got %', b->>'event_name';
  end if;
  if b ? 'event_ended_at' and jsonb_typeof(b->'event_ended_at') <> 'null' then
    raise exception 'ASSERT 043i: an open night must report event_ended_at as null, got %', b->'event_ended_at';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. public.min_client_version() answers without any session at all — that is
--    the whole point: a phone must be able to ask "am I stale?" before it
--    claims a seat, where state_revision is operator-only.
-- ---------------------------------------------------------------------------
do $$
begin
  -- No jwt claim set: this is the anon path the pre-claim probe takes.
  if public.min_client_version() <> '' then
    raise exception 'ASSERT 043j: the floor must read empty before the organiser raises it, got %', public.min_client_version();
  end if;
end $$;

reset role;
select sc.configure_min_client_version('3.3.0');
do $$
begin
  if public.min_client_version() <> '3.3.0' then
    raise exception 'ASSERT 043k: the session-free floor read must follow configure_min_client_version, got %', public.min_client_version();
  end if;
  if public.station_board()->>'min_client_version' <> '3.3.0' then
    raise exception 'ASSERT 043l: the board must carry the same floor the picker compares against';
  end if;
end $$;
select sc.configure_min_client_version('');

-- ---------------------------------------------------------------------------
-- 3. The board follows the handoff: after OPEN_NEW_EVENT the next board read
--    names the NEW event and the closed one is no longer pointed at. A phone
--    that only ever polls station_board therefore stops showing "SỰ KIỆN ĐÃ
--    KẾT THÚC" on its next read, with no cache clearing involved.
-- ---------------------------------------------------------------------------
reset role;
update sc.events set event_ended_at = sc.now_ms()
 where id = (select id from sc.events where name = 'Board 043');

set local role authenticated;
do $$
declare v jsonb; b jsonb; closed bigint;
begin
  perform set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000035', true);
  closed := (select id from sc.events where name = 'Board 043');
  -- While the night is closed, the board says so — this is the string the picker
  -- shows instead of an unexplained spinner.
  b := public.station_board();
  if jsonb_typeof(b->'event_ended_at') = 'null' then
    raise exception 'ASSERT 043m: a closed night must publish event_ended_at, got %', b;
  end if;
  v := public.handle_command('OPEN_NEW_EVENT', '{"_v":"3.3.0","event_name":"Board 043 night 2"}'::jsonb,
        (select revision from sc.events where id = closed), '043-open');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 043n: OPEN_NEW_EVENT failed: %', v; end if;
  b := public.station_board();
  if (b->>'event_id')::bigint = closed then
    raise exception 'ASSERT 043o: the board must move to the fresh event after the handoff';
  end if;
  if b->>'event_name' <> 'Board 043 night 2' then
    raise exception 'ASSERT 043p: the board must publish the new event name, got %', b->>'event_name';
  end if;
  if jsonb_typeof(b->'event_ended_at') <> 'null' then
    raise exception 'ASSERT 043q: the fresh event must read open again, got %', b->'event_ended_at';
  end if;
  if (b->>'event_next_team_number')::int <> 1 then
    raise exception 'ASSERT 043r: the fresh event restarts the team sequence at #001, got %', b->>'event_next_team_number';
  end if;
end $$;

-- The closed event keeps its row and its ended stamp: the board moved, history did
-- not change.
reset role;
do $$
declare closed bigint;
begin
  select id into closed from sc.events where name = 'Board 043';
  if closed is null then raise exception 'ASSERT 043s: the closed event row must still exist'; end if;
  if (select event_ended_at from sc.events where id = closed) is null then
    raise exception 'ASSERT 043t: the closed event must still report its end instant';
  end if;
end $$;

reset role;
update sc.operators set revoked_at = now() where revoked_at is null;
select sc.configure_min_client_version('');

select '043 v3.3 board diagnostics: station_board keeps its validated contract and '
    || 'adds the real event state and the version floor, public.min_client_version() '
    || 'answers with no session at all, and the board follows OPEN_NEW_EVENT while the '
    || 'closed event row survives untouched: passed' as result;

rollback;
