-- SCREAM CONTROL — Room 305 · V2 · the board states its own capacity
--
-- 0008 is already applied on every environment, so it stays byte-identical and
-- this forward migration only extends the public board payload. Nothing is
-- removed or renamed: `capacity`, `occupied`, `locked` and each station's
-- `role`/`occupied`/`devices` keep exactly the meaning 0006–0008 gave them.
--
-- Why it matters: the gate has to show "SUPERVISOR 1/2" and refuse only at 2/2,
-- and five single-seat stations must refuse at 1/1. If the frontend hardcodes
-- those numbers, the day the database limit and the picture on the phone stop
-- agreeing, nobody notices until a phone is wrongly turned away. With the limits
-- coming from the same function that enforces them, the board cannot lie.

create or replace function sc.station_board()
returns jsonb
language sql stable security definer set search_path = '' as $$
  with seats as (
    select r.role, r.ord,
           case when r.role = 'SUPERVISOR' then 2 else 1 end as capacity,
           (count(o.user_id) > 0) as occupied,
           count(o.user_id)::int  as devices
      from unnest(array['LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR'])
           with ordinality as r(role, ord)
      left join sc.operators o
             on o.role = r.role and o.revoked_at is null
     group by r.role, r.ord
  )
  select jsonb_build_object(
    'capacity', 5,
    'device_capacity', (select sum(s.capacity) from seats s),
    'devices', (select count(*) from sc.operators where revoked_at is null),
    'occupied', count(*) filter (where s.occupied),
    'locked',   count(*) filter (where s.occupied) >= 5,
    'full',     count(*) filter (where s.devices < s.capacity) = 0,
    'stations', jsonb_agg(jsonb_build_object(
      'role', s.role, 'capacity', s.capacity, 'occupied', s.occupied, 'devices', s.devices
    ) order by s.ord)
  )
    from seats s;
$$;

-- `create or replace` keeps the OID, so 0006's grants on sc.station_board()
-- (revoked: internal) and on public.station_board() (anon + authenticated) are
-- untouched. The public wrapper keeps pointing here for the same reason.
