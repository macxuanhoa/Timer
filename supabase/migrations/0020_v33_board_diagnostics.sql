-- =============================================================================
-- 0020 — V3.3 P0 diagnostics: event state on the public board, session-free
--          version floor, and an owner-only SQL rescue for OPEN_NEW_EVENT.
-- =============================================================================
-- Two field symptoms this closes:
--
--   1. A phone that cannot read the event claims nothing and shows "ĐANG ĐỒNG BỘ"
--      with no reason. station_board is the one RPC reachable without any binding
--      (0016 §8), so carrying the event's real state on that payload lets the
--      picker say the truth — "ca trực đã đóng, chờ Quản trị mở sự kiện mới" —
--      instead of a spinner that never resolves. It also gives support a
--      read-only way to verify the Production event state without a session.
--   2. Deciding "am I on an old bundle?" currently needs state_revision, which
--      401s for an unbound identity. public.min_client_version() answers the
--      question pre-claim, on the same anon surface the picker already calls.
--
-- The rescue block at the bottom is documentation, not code: the organiser can
-- hand the room to the next shift from the Supabase SQL editor when no phone is
-- available, driving the SAME handle_command path the button uses, so the audit
-- row and the idempotency bookkeeping are identical. It is commented out here —
-- applying this migration changes no event state by itself.

-- ---------------------------------------------------------------------------
-- 1. station_board: + event state + the version floor. board_version stays 3:
--    every field the V3.2 client validates is unchanged, and the additions are
--    purely informational, so an old bundle keeps working against the new shape.
-- ---------------------------------------------------------------------------
create or replace function sc.station_board() returns jsonb
language sql stable security definer set search_path = '' as $$
  with seats as (
    select r.role, r.ord, r.capacity,
           case when r.role = 'OBSERVER'
                then (select count(*) from sc.observer_seats s
                        join sc.operators o on o.user_id = s.user_id
                       and o.revoked_at is null and o.role = 'OBSERVER'
                       where s.seen_at > now() - sc._observer_ttl())
                else count(o.user_id)::int end      as devices,
           max(r.capacity)::int                     as capacity_max
      from (values ('LOBBY', 1, 1), ('GATE', 2, 1), ('CORRIDOR', 3, 1),
                  ('ROOM305', 4, 1), ('SUPERVISOR', 5, 2), ('OBSERVER', 6, 10))
           r(role, ord, capacity)
      left join sc.operators o
             on o.role = r.role and o.revoked_at is null and r.role <> 'OBSERVER'
     group by r.role, r.ord, r.capacity
  ), operators as (
    select coalesce(sum(capacity), 0)::int as device_capacity, coalesce(sum(devices), 0)::int as devices
      from seats where role <> 'OBSERVER'
  ), occupied as (
    select count(*) filter (where devices > 0) as n from seats where role <> 'OBSERVER'
  ), ev as (
    -- The event the state pointer names right now. One row, read as the board
    -- owner so a phone with no session can still see whether the night is open.
    select e.id, e.name, e.next_team_number, e.event_started_at, e.event_ended_at
      from sc.state s join sc.events e on e.id = s.event_id
     where s.id = true
  )
  select jsonb_build_object(
    'board_version', 3,
    'capacity', 5,
    'device_capacity', (select device_capacity from operators),
    'devices', (select devices from operators),
    'occupied', (select n from occupied),
    'locked', (select devices from operators) >= (select device_capacity from operators),
    'observer_capacity', 10,
    'observer_devices', (select devices from seats where role = 'OBSERVER'),
    'full', (select devices from operators) >= (select device_capacity from operators),
    'game_running', exists (select 1 from sc.rounds r join sc.state st on st.id
      where r.event_id = st.event_id and r.status <> 'CLOSED'
        and r.game_started_at is not null and r.exit_confirmed_at is null),
    'reset_allowed', sc._floor_block_reason() is null,
    'reset_block_reason', sc._floor_block_reason(),
    -- V3.3 P0: the truth the picker shows so "ĐANG ĐỒNG BỘ" and "the night is
    -- closed" are never confused, and the floor a phone compares its own bundle
    -- against before it claims a seat.
    'min_client_version', sc.min_client_version(),
    'event_id', (select id::text from ev),
    'event_name', (select name from ev),
    'event_started_at', (select event_started_at from ev),
    'event_ended_at', (select event_ended_at from ev),
    'event_next_team_number', (select next_team_number from ev),
    -- The stations array keeps the exact 0017 shape (capacity_max per role, the
    -- whole select aggregated over seats): the Home picker validates each seat's
    -- capacity against its expected value and refuses to trust a board that does
    -- not describe every seat faithfully.
    'stations', jsonb_agg(jsonb_build_object('role', role, 'capacity', capacity_max,
      'devices', devices, 'occupied', devices >= capacity_max) order by ord))
  from seats;
$$;

-- ---------------------------------------------------------------------------
-- 2. Session-free floor read for the pre-claim boot probe. The bound path keeps
--    reading it on state_revision; an unbound phone reads it here, exactly like
--    station_board, so an outdated PWA learns to update before it grabs a seat.
-- ---------------------------------------------------------------------------
create or replace function public.min_client_version() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(min_client_version, '') from sc.runtime_flags where id = true
$$;
revoke all on function public.min_client_version() from public;
grant  execute on function public.min_client_version() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Board refresh. station_occupancy serves the realtime hint the picker
--    listens to; the event fields are read live inside station_board(), so no
--    new materialisation is needed — but an event transition must still nudge
--    subscribers, and OPEN_NEW_EVENT already bumps sc.state, which the phones
--    poll. Nothing further to wire.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. OWNER-ONLY RESCUE (run from the Supabase SQL editor, never from a browser).
--    Same handle_command path as the button; audit and idempotency identical.
--    Commented out by design: applying the migration changes no event state.
--
--   begin;
--   select set_config('request.jwt.claim.sub',
--     (select user_id::text from sc.operators
--       where role = 'SUPERVISOR' and revoked_at is null limit 1), true);
--   select public.handle_command('OPEN_NEW_EVENT',
--     jsonb_build_object('_v', '3.3.0', 'event_name', 'Tối 05/11'),
--     (select revision from sc.events where id = (select event_id from sc.state where id = true)),
--     'sql-rescue-' || extract(epoch from now())::bigint::text);
--   commit;
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';
