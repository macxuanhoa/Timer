-- =============================================================================
-- Migration 0021 — V3.3 P0: seat management a supervisor can actually use
-- -----------------------------------------------------------------------------
-- Third production blocker: "NPC1 ĐÃ ĐỦ NGƯỜI but there is no GIẢI PHÓNG VỊ TRÍ."
-- Two separate things were wrong, and both are fixed here rather than in the
-- client, because the operator's question is a data question:
--
--   1. Nothing anywhere answered WHO is holding a seat. `sc.operators` RLS only
--      lets a device read its own row, so the six tiles could ever report a
--      count. sc.station_admin() is a SECURITY DEFINER read that names each
--      holder (device id, chosen name, how long bound, last action) alongside
--      the floor-block reason, and refuses anybody who is not holding an
--      unrevoked SUPERVISOR binding right now.
--   2. The brief asks that a seat not be freed while a round is live if the
--      business says so. 0019 deliberately had no floor predicate at all,
--      because "NPC1 walked off mid-round" is the case the tool exists for —
--      but that also let a supervisor drop NPC1 out of a live round, leaving
--      the players inside with nobody able to confirm them out. So the guard is
--      narrow and reuses sc._floor_block_reason(), the exact value the board
--      already publishes (the button and PostgreSQL can never disagree):
--        RUNNING        a team is on the clock, or inside and not confirmed out
--        PENDING_CLAIM  a recorded claim still owes its judgement
--      both refuse a release with FLOOR_BUSY. A queued round or one that is out
--      with the area not closed yet does NOT refuse: freeing the seat is how the
--      next operator takes over, and cancelling a live round stays the whole-
--      board emergency reset's exclusive job.
--   3. Refusals are audited, so "we pressed it and nothing happened" is a
--      queryable fact.
--
-- The public-facing contract of release_station is unchanged: same one text
-- argument, same codes (RELEASE_NOT_AUTHORIZED / INVALID_ROLE /
-- RELEASE_SELF_TARGET / RELEASE_NOT_BOUND / RELEASED + freed), it still frees
-- every live binding of the named duty role, and it still never goes through
-- handle_command's version gate, so a supervisor on a stale bundle can rescue
-- the night.
--
-- Append-only, forward-only. No data, history, clock or binding is touched by
-- this migration itself.
-- =============================================================================

set search_path = pg_catalog, public;

-- ---------------------------------------------------------------------------
-- 1. one privileged read: who holds each seat, and is a release safe right now
-- ---------------------------------------------------------------------------
create or replace function sc.station_admin() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_caller uuid;
  v_block  text;
  v_event  bigint;
begin
  v_caller := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  if v_caller is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  -- Deliberately stricter than sc.is_admin(): this report names OTHER people's
  -- devices, so the caller must be holding a live SUPERVISOR binding right now.
  if not exists (select 1 from sc.operators o
                  where o.user_id = v_caller and o.role = 'SUPERVISOR'
                    and o.revoked_at is null) then
    return jsonb_build_object('ok', false, 'code', 'RELEASE_NOT_AUTHORIZED');
  end if;
  -- Read once, so the reply's own verdict cannot disagree with the release RPC
  -- that is called a moment later from the same screen.
  v_block := sc._floor_block_reason();
  v_event := (select event_id from sc.state where id = true);

  return (
    with seats as (
      select r.role, r.ord, r.capacity,
             coalesce(jsonb_agg(jsonb_build_object(
               'user_id',        o.user_id,
               'seat_slot',      o.seat_slot,
               'display_name',   nullif(o.display_name, ''),
               'bound_at_ms',    (extract(epoch from o.bound_at) * 1000)::bigint,
               'held_ms',        (extract(epoch from now() - o.bound_at) * 1000)::bigint,
               -- `sc.operators` keeps no last-action column: the history table is
               -- the only truth, and this is the same source the snapshot's
               -- operator strip already reads.
               'last_action',    l.action,
               'last_action_ms', l.at_ms
             ) order by o.seat_slot) filter (where o.user_id is not null), '[]'::jsonb) as holders
      from (
        values ('LOBBY'::text, 1, 1), ('CORRIDOR', 2, 1), ('GATE', 3, 1),
               ('ROOM305', 4, 1), ('SUPERVISOR', 5, 2)
      ) r(role, ord, capacity)
      left join sc.operators o
        on o.role::text = r.role and o.revoked_at is null
      left join lateral (
        select a.action, a.at_ms from sc.action_log a
         where a.actor_id = o.user_id::text and a.event_id = v_event
         order by a.seq desc limit 1
      ) l on true
      group by r.role, r.ord, r.capacity
    )
    select jsonb_build_object(
      'ok',                 true,
      'code',               'STATION_ADMIN_OK',
      'revision',           (select revision from sc.events where id = v_event),
      'server_time_ms',     sc.now_ms(),
      -- The one value that decides whether a seat may be freed right now; the
      -- client greys out the button from this, never from its own guess.
      'floor_block_reason', v_block,
      'stations', jsonb_agg(jsonb_build_object(
        'role',       s.role,
        'capacity',   s.capacity,
        'devices',    jsonb_array_length(s.holders),
        'holders',    s.holders,
        -- The caller's own admin seat is reported but never offered here: this
        -- surface refuses it (0019) because giving up an admin seat is the plain
        -- "Về màn hình chọn vị trí" action, not a rescue.
        'releasable', s.role <> 'SUPERVISOR'
                      and coalesce(v_block, '') not in ('RUNNING', 'PENDING_CLAIM')
      ) order by s.ord)
    )
    from seats s
  );
end $$;

-- Viewer presence is deliberately not repeated here: `sc.station_board()`
-- already counts it from live heartbeats and Home reads that, so one source of
-- truth stays responsible for the 0/10 figure.

revoke all on function sc.station_admin() from public, anon, authenticated;

create or replace function public.station_admin() returns jsonb
language sql security definer set search_path = '' as $$ select sc.station_admin() $$;
revoke all on function public.station_admin() from public, anon;
grant  execute on function public.station_admin() to authenticated;
grant  execute on function sc.station_admin() to authenticated;

comment on function sc.station_admin() is
  'V3.3 seat management: holders per duty seat plus the live floor-block reason; SUPERVISOR-only.';

-- ---------------------------------------------------------------------------
-- 2. release_station: same contract as 0019, plus the narrow live-round guard
-- ---------------------------------------------------------------------------
create or replace function sc.release_station(p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := (select auth.uid());
  v_role   text;
  v_target text := upper(btrim(coalesce(p_role, '')));
  v_freed  int := 0;
  v_block  text;
  v_row    sc.operators;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  perform pg_advisory_xact_lock(30501);
  select role into v_role from sc.operators where user_id = v_uid and revoked_at is null;
  if v_role is distinct from 'SUPERVISOR' then
    insert into sc.access_audit(user_id, role, action)
      values (v_uid, v_role, 'RELEASE_NOT_AUTHORIZED');
    return jsonb_build_object('ok', false, 'code', 'RELEASE_NOT_AUTHORIZED');
  end if;
  if v_target not in ('LOBBY','CORRIDOR','GATE','ROOM305','SUPERVISOR') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ROLE');
  end if;
  if v_target = 'SUPERVISOR' then
    return jsonb_build_object('ok', false, 'code', 'RELEASE_SELF_TARGET');
  end if;

  -- V3.3 business guard. The seat itself is not the problem; a team still on
  -- the floor is. Refusing here is what keeps "giải phóng vị trí" from turning
  -- into an undocumented way of cancelling a live round.
  v_block := sc._floor_block_reason();
  if v_block in ('RUNNING', 'PENDING_CLAIM') then
    insert into sc.access_audit(user_id, role, action, metadata) values
      (v_uid, v_role, 'RELEASE_REFUSED',
       jsonb_build_object('target', v_target, 'reason', v_block));
    return jsonb_build_object('ok', false, 'code', 'FLOOR_BUSY',
                              'target', v_target, 'reason', v_block);
  end if;

  for v_row in
      select * from sc.operators
       where role = v_target and revoked_at is null
       order by seat_slot
  loop
    update sc.operators set revoked_at = now()
      where user_id = v_row.user_id and revoked_at is null;
    delete from sc.observer_seats where user_id = v_row.user_id;
    v_freed := v_freed + 1;
    insert into sc.access_audit(user_id, role, action, metadata) values
      (v_row.user_id, v_row.role, 'STATION_RELEASED',
       jsonb_build_object('by', v_uid, 'target', v_target));
  end loop;
  if v_freed = 0 then
    return jsonb_build_object('ok', false, 'code', 'RELEASE_NOT_BOUND', 'target', v_target);
  end if;
  return jsonb_build_object('ok', true, 'code', 'RELEASED', 'target', v_target, 'freed', v_freed);
end $$;

comment on function sc.release_station(text) is
  'V3.3 frees the live bindings of one duty role for the calling supervisor; refused with FLOOR_BUSY while a team is on the clock or a claim awaits judgement, and every refusal is audited.';

-- The public shim already exists since 0019 and resolves sc.release_station by
-- signature, so it now picks up the guard with no new grant to audit.
