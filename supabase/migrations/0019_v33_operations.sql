-- =============================================================================
-- 0019 — V3.3 operations: per-seat supervisor release + forced-update gate
-- =============================================================================
-- Two operator-facing blockers surfaced after V3.2 shipped:
--
--   1. A stale binding on one duty seat (NPC1 "đã đủ người" is the reported case)
--      cannot be freed by the current tools: the seat holder's own phone is
--      missing, and the whole-board sweep is refused by sc._floor_block_reason()
--      whenever the machine thinks a team is on the floor. The operator is stuck
--      with a full seat and no escape.
--
--   2. Every phone that installed the PWA earlier keeps running its cached
--      bundle after a deploy. The service worker's "prompt" flow is easy to
--      dismiss, so an old client stays on the floor alongside the new one. That
--      is what "version mismatch" reports are about: two bundles on two rules.
--
-- Migration 0019 addresses both. It is forward-only, does not drop anything,
-- and does not touch any row of sc.events / sc.rounds / sc.completion_attempts /
-- sc.reset_tasks / sc.action_log. History is untouched.
--
--   * sc.release_station(p_role) frees one named seat. SUPERVISOR only, and the
--     caller must hold a live SUPERVISOR binding — the same authorisation model
--     as sc.reset_all_stations since V3.2. It never stops a clock, closes a
--     round, or rewrites a claim; it revokes the chosen duty binding and drops
--     a sc.access_audit row naming both the caller and the freed identity.
--   * sc.runtime_flags.min_client_version stores the minimum bundle the
--     authoritative layer will accept. sc.handle_command refuses anything
--     stamped below it with VERSION_STALE before any other check runs, so a
--     stale phone cannot press its way into the shared state. The value reaches
--     the client through sc.state_revision() so an operator who simply opens
--     the app sees the update screen even before their first tap. Release
--     endpoints (release_station, reset_all_stations) stay open to a stale
--     client on purpose: the supervisor must always be able to unstick a stuck
--     seat, whatever bundle they happen to be running.
--   * Two small partial indexes back the queries the dashboard issues on every
--     read (the "one live round per event" probe and the "any outstanding
--     checklist task?" gate).

select pg_advisory_xact_lock(30501);

-- ---------------------------------------------------------------------------
-- 1. Runtime flag: the minimum bundle version the server will accept.
-- ---------------------------------------------------------------------------
alter table sc.runtime_flags
  add column if not exists min_client_version text not null default '';

-- Default is '' — the gate is off. The organiser flips the floor with
-- `select sc.configure_min_client_version('3.3.0');` AFTER the V3.3 frontend
-- has landed, so a partially-deployed fleet never sees a half-on gate.
-- Nothing here touches an already-running event.

create or replace function sc.configure_min_client_version(p_version text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_next text;
begin
  -- Owner-only surface. The grant block at the bottom of this migration revokes
  -- EXECUTE from public / anon / authenticated, so the only path to this
  -- function is a trusted SQL session (Supabase dashboard, the pooler as
  -- `postgres`, or scripts/db-push.ps1). A browser can reach neither the
  -- function nor the schema, so no additional role check is needed here — and
  -- adding one (a has_privs_of_role probe, or a supabase_admin role name that
  -- only exists on Supabase) just breaks the vanilla-Postgres validation
  -- container this migration is tested against.
  v_next := btrim(coalesce(p_version, ''));
  if v_next <> '' and v_next !~ '^\d+(\.\d+){0,2}$' then
    raise exception 'min_client_version must be empty or MAJOR[.MINOR[.PATCH]]';
  end if;
  update sc.runtime_flags set min_client_version = v_next where id = true;
  return v_next;
end $$;

create or replace function sc.min_client_version() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(min_client_version, '') from sc.runtime_flags where id = true
$$;
revoke all on function sc.configure_min_client_version(text) from public, anon, authenticated;
grant  execute on function sc.min_client_version() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. Three-part semver compare in pure SQL.
-- ---------------------------------------------------------------------------
-- Wire format is MAJOR.MINOR.PATCH with optional build metadata after a '+'
-- (dropped before comparison). Anything malformed is treated as 0.0.0 so a
-- stale client that cannot produce a version is refused rather than passed.
create or replace function sc._semver_parts(p_version text) returns int[]
language sql immutable as $$
  with t as (select split_part(coalesce(p_version, ''), '+', 1) as v)
  select array[
    coalesce(nullif((regexp_match(v, '^(\d+)'))[1], ''), '0')::int,
    coalesce(nullif((regexp_match(v, '^\d+\.(\d+)'))[1], ''), '0')::int,
    coalesce(nullif((regexp_match(v, '^\d+\.\d+\.(\d+)'))[1], ''), '0')::int
  ] from t
$$;

create or replace function sc._semver_lt(p_left text, p_right text) returns boolean
language sql immutable security definer set search_path = '' as $$
  select sc._semver_parts(p_left) < sc._semver_parts(p_right);
$$;

-- ---------------------------------------------------------------------------
-- 3. Per-seat supervisor release.
-- ---------------------------------------------------------------------------
-- Authorisation mirrors sc.reset_all_stations (V3.2): the caller's own live
-- SUPERVISOR binding is the credential. Refusal lands in sc.access_audit as
-- RELEASE_NOT_AUTHORIZED so a supervisor phone that was itself revoked does not
-- silently no-op.
--
-- Safety: releasing a duty seat while a team is on the floor is exactly the
-- stuck case this RPC exists to fix, so the floor predicate is NOT the gate
-- here. What is preserved instead:
--   * the release never touches a round, a claim, a checklist or a clock;
--   * it lands one sc.access_audit row per freed identity, naming both the
--     caller and the freed user_id, so "who freed NPC1, and when" answers
--     directly from the audit;
--   * it refuses OBSERVER (a stale viewer seat is swept by the heartbeat and
--     belongs in a different conversation than duty staffing);
--   * it refuses to release SUPERVISOR through this surface — the caller would
--     be locking themselves out mid-operation; the normal "Về màn hình chọn
--     vị trí" path stays the correct way to give up an admin seat;
--   * it returns RELEASE_NOT_BOUND when the target has no live binding, so a
--     double tap does not pretend to have freed something.
create or replace function sc.release_station(p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := (select auth.uid());
  v_role   text;
  v_target text := upper(btrim(coalesce(p_role, '')));
  v_freed  int := 0;
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

create or replace function public.release_station(p_role text) returns jsonb
language sql security definer set search_path = '' as $$ select sc.release_station(p_role) $$;
revoke all on function public.release_station(text) from public, anon;
grant  execute on function public.release_station(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. OPEN_NEW_EVENT body, hoisted into its own helper.
-- ---------------------------------------------------------------------------
-- Byte-for-byte the same contract 0018 shipped: same preconditions, same fresh
-- event shape, same Vietnamese receipt. Moving it out of the wrapper keeps the
-- version-gate branch readable while still letting the wrapper intercept the
-- action before _handle_command_internal reads the event pointer.
create or replace function sc._open_new_event_internal(
  p_meta jsonb,
  p_expected_revision bigint,
  p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_role  text;
  v_now   bigint;
  v_state sc.state;
  v_old   sc.events;
  v_new   sc.events;
  v_rev   bigint;
  v_name  text;
begin
  v_uid := (select auth.uid());
  select role into v_role from sc.operators where user_id = v_uid and revoked_at is null;
  if v_role is distinct from 'SUPERVISOR' then
    return sc._result(false, 'PERMISSION_DENIED',
      sc._role_short(v_role) || ' không được phép: ' || sc._action_vn('OPEN_NEW_EVENT'),
      0, sc.now_ms());
  end if;
  v_now := sc.now_ms();
  select * into v_state from sc.state where id = true;
  select * into v_old from sc.events where id = v_state.event_id;
  if exists (select 1 from sc.action_log
             where actor_id = v_uid::text and action = 'OPEN_NEW_EVENT'
               and idempotency_key = p_idempotency_key) then
    return sc._result(true, 'OK', 'ĐÃ GHI NHẬN TRƯỚC ĐÓ', v_old.revision, v_now);
  end if;
  if p_expected_revision <> v_old.revision then
    return sc._result(false, 'STALE_REVISION',
      'Trạng thái đã thay đổi (bản ' || v_old.revision || '). Đang đồng bộ lại…',
      v_old.revision, v_now);
  end if;
  if v_old.event_ended_at is null then
    return sc._result(false, 'INVALID_STATE',
      'Phải đóng sự kiện hiện tại trước khi mở sự kiện mới', v_old.revision, v_now);
  end if;
  if exists (select 1 from sc.rounds r
              where r.event_id = v_old.id and r.status <> 'CLOSED') then
    return sc._result(false, 'INVALID_STATE',
      'Vẫn còn lượt chơi chưa đóng trong sự kiện vừa kết thúc', v_old.revision, v_now);
  end if;
  v_name := coalesce(
    nullif(regexp_replace(btrim(coalesce(p_meta->>'event_name', '')), '[[:space:]]+', ' ', 'g'), ''),
    v_old.name);
  insert into sc.events (
      name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
      hidden_object_owner, hiding_layout, review_threshold_ms, stall_warn_ms,
      start_team_number, next_team_number,
      event_started_at, event_ended_at, overtime_started_at,
      closing_warned_at, end_warned_at, revision)
    values (
      v_name, v_old.duration_ms, v_old.game_limit_ms, v_old.prep_allowance_ms, v_old.reset_target_ms,
      v_old.hidden_object_owner, v_old.hiding_layout, v_old.review_threshold_ms, v_old.stall_warn_ms,
      1, 1,
      null, null, null,
      null, null,
      0)
    returning * into v_new;
  update sc.state set event_id = v_new.id, revision = 0, updated_at = v_now where id = true;
  v_rev := sc._commit(v_new, 'OPEN_NEW_EVENT', null, 'ENDED', 'NONE', p_idempotency_key,
                      jsonb_build_object(
                        'previous_event_id', v_old.id,
                        'previous_event_name', v_old.name,
                        'previous_event_ended_at', v_old.event_ended_at),
                      'Đã mở sự kiện mới', v_now);
  return sc._result(true, 'OK', 'ĐÃ MỞ SỰ KIỆN MỚI', v_rev, v_now);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Command wrapper with the forced-update gate + OPEN_NEW_EVENT intercept.
-- ---------------------------------------------------------------------------
-- Rebuilt from 0011 (press normalisation) and 0018 (OPEN_NEW_EVENT). The V3.3
-- branch adds the "stale client" refusal in front of everything else. The
-- stamp travels inside p_meta._v; a client that predates V3.3 sends no _v at
-- all and is refused the moment the organiser raises the floor. An empty _v is
-- also refused so a caller cannot pass the gate by omitting the stamp.
create or replace function sc.handle_command(
  p_action text,
  p_meta jsonb default '{}'::jsonb,
  p_expected_revision bigint default 0,
  p_idempotency_key text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_meta  jsonb := coalesce(p_meta, '{}'::jsonb);
  v_press bigint;
  v_min   text;
  v_self  text;
begin
  perform pg_advisory_xact_lock(30501);
  if sc.my_role() is null then
    return sc._result(false, 'PERMISSION_DENIED', 'VỊ TRÍ ĐÃ ĐƯỢC THU HỒI', 0, sc.now_ms());
  end if;

  v_min := sc.min_client_version();
  if v_min <> '' then
    v_self := v_meta->>'_v';
    if v_self is null or v_self = '' or sc._semver_lt(v_self, v_min) then
      return sc._result(false, 'VERSION_STALE',
        'PHIÊN BẢN ỨNG DỤNG ĐÃ CŨ — CẬP NHẬT TRƯỚC KHI TIẾP TỤC', 0, sc.now_ms());
    end if;
  end if;

  if jsonb_typeof(v_meta->'_press') = 'object' then
    begin
      v_press := trunc((v_meta#>>'{_press,press_ms}')::numeric)::bigint;
    exception when data_exception then
      v_press := null;
    end;
    v_meta := case when v_press is null
      then jsonb_set(v_meta, '{_press}', (v_meta->'_press') - 'press_ms', true)
      else jsonb_set(v_meta, '{_press,press_ms}', to_jsonb(v_press), true) end;
  end if;

  if p_action = 'OPEN_NEW_EVENT' then
    return sc._open_new_event_internal(v_meta, p_expected_revision, p_idempotency_key);
  end if;

  return sc._handle_command_internal(p_action, v_meta, p_expected_revision, p_idempotency_key);
end $$;

create or replace function public.handle_command(
  p_action text, p_meta jsonb, p_expected_revision bigint, p_idempotency_key text
) returns jsonb
language sql security definer set search_path = '' as
$$ select sc.handle_command(p_action, coalesce(p_meta, '{}'::jsonb), p_expected_revision, p_idempotency_key) $$;

revoke all on function public.handle_command(text, jsonb, bigint, text) from public;
grant  execute on function public.handle_command(text, jsonb, bigint, text) to authenticated;
grant  execute on function sc.handle_command(text, jsonb, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. state_revision carries the version floor alongside the revision.
-- ---------------------------------------------------------------------------
-- The client already polls state_revision on every VERIFY_INTERVAL_MS tick and
-- on boot, so threading the floor through that payload makes the forced-update
-- gate a "one RPC already in flight" concern rather than a second probe.
create or replace function sc.state_revision() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_now bigint; v_result jsonb;
begin
  if sc.my_role() is null then
    raise exception 'PERMISSION_DENIED';
  end if;
  v_now := sc.now_ms();
  select jsonb_build_object(
      'revision', s.revision,
      'server_now_ms', v_now,
      'event_id', e.id::text,
      'min_client_version', sc.min_client_version())
    into v_result
    from sc.state s join sc.events e on e.id = s.event_id
   where s.id = true;
  return v_result;
end $$;

create or replace function public.state_revision() returns jsonb
language sql stable security definer set search_path = '' as $$ select sc.state_revision() $$;
revoke all on function public.state_revision() from public;
grant  execute on function public.state_revision() to anon, authenticated;
grant  execute on function sc.state_revision() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Two small partial indexes that back every dashboard read.
-- ---------------------------------------------------------------------------
-- The "one live round per event" probe runs inside sc.handle_command and
-- sc.snapshot on every action. The existing rounds_event_idx covers the
-- (event_id, round_number) prefix; the partial index lets the "not CLOSED"
-- scan hit an index-only read without changing any historical query's plan.
create index if not exists rounds_live_idx
  on sc.rounds (event_id, round_number desc)
  where status <> 'CLOSED';

-- reset_tasks are joined through round_id in the snapshot, the END_EVENT gate
-- and the readiness check. The partial index covers "any outstanding task in
-- the current cycle", which is exactly what a phone reads before allowing a
-- new team to be received.
create index if not exists reset_tasks_open_idx
  on sc.reset_tasks (round_id, cycle)
  where completed_at is null;

-- ---------------------------------------------------------------------------
-- 8. Hygiene.
-- ---------------------------------------------------------------------------
revoke all on function sc.release_station(text) from public, anon, authenticated;
revoke all on function sc._open_new_event_internal(jsonb, bigint, text)
  from public, anon, authenticated;
revoke all on function sc._semver_parts(text), sc._semver_lt(text, text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
