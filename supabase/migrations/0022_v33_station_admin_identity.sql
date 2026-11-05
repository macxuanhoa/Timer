-- =============================================================================
-- Migration 0022 — V3.3 P0 hotfix: station_admin must read the caller the way
-- Supabase actually presents it
-- -----------------------------------------------------------------------------
-- 0021 shipped station_admin() with this line:
--
--   v_caller := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
--
-- On the local validation harness that works, because the harness sets the
-- legacy per-claim GUC itself. On Supabase it does not: PostgREST publishes the
-- decoded token as `request.jwt.claims` (JSON) and auth.uid() is the supported
-- accessor that falls back to it. The live symptom is precise and was reproduced
-- against Production before this file existed:
--
--   release_station('GATE')  with a valid anonymous session ->
--     {"ok":false,"code":"RELEASE_NOT_AUTHORIZED"}      auth.uid() resolved
--   station_admin()          with the same session ->
--     {"ok":false,"code":"NOT_AUTHENTICATED"}           the GUC was empty
--
-- A supervisor would therefore never receive the roster: the panel would fall
-- back to the unnamed seat list forever, and the "who holds NPC1" question —
-- the entire reason 0021 exists — would stay unanswered in Production.
--
-- The fix is one line, and it is the same identity source release_station,
-- handle_command, claim_station and every other RPC already use. Nothing else
-- about the report changes: same signature, same payload, same SUPERVISOR-only
-- authorisation, same grants. Forward-only; no table and no row is touched.
-- =============================================================================

set search_path = pg_catalog, public;

create or replace function sc.station_admin() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_caller uuid;
  v_block  text;
  v_event  bigint;
begin
  -- auth.uid() is the platform accessor: it reads the authenticated subject and
  -- falls back to the decoded `request.jwt.claims` payload. Reading the legacy
  -- `request.jwt.claim.sub` GUC directly (as 0021 did) is not portable — it is
  -- empty under Supabase's PostgREST, which made every real supervisor look
  -- anonymous.
  v_caller := (select auth.uid());
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

comment on function sc.station_admin() is
  'V3.3 seat management: holders per duty seat plus the live floor-block reason; SUPERVISOR-only. Resolves the caller through auth.uid() (0022) so Supabase PostgREST can authorise it.';

-- create-or-replace preserves the existing ACL, but re-assert it explicitly so a
-- reader of this file sees the whole surface and no grant is left implicit.
revoke all on function sc.station_admin() from public, anon;
grant  execute on function sc.station_admin() to authenticated;

notify pgrst, 'reload schema';
