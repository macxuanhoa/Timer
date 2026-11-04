-- =============================================================================
-- 0018 — Mở sự kiện mới có kiểm soát (SUPERVISOR) sau khi END_EVENT
-- =============================================================================
-- Scope
--
--   The V3.1 flow ends an event with an explicit, reasoned END_EVENT and every
--   downstream rule locks behind `event_ended_at is not null`: CALL_TEAM refuses,
--   START_GAME refuses, and every station reads the "SỰ KIỆN ĐÃ KẾT THÚC" screen.
--   Nothing in the schema or the RPC surface reopens it, so a new shift on the
--   same physical room either reuses the closed event (impossible, the RPCs refuse)
--   or has to touch SQL by hand (breaks the audit chain and the V3.2 no-direct-write
--   rule the whole release rests on).
--
--   This migration adds the missing action OPEN_NEW_EVENT. It is:
--     - SUPERVISOR only, in the same way END_EVENT is SUPERVISOR only;
--     - gated on the closed event (event_ended_at is not null) and on every round
--       of the closed event being 'CLOSED' — the same preconditions END_EVENT itself
--       required before it wrote the end stamp;
--     - history-preserving. The closed event row, its rounds, its completion
--       attempts, its reset tasks and every row of sc.action_log that references
--       them stay exactly where they were. Nothing is deleted, nothing is rewritten;
--       the pointer sc.state simply moves to a fresh sc.events row.
--
-- Forward-only. Applied on top of 0001..0017 with or without an already-closed
-- event, it changes no reachable behaviour until a supervisor actually presses
-- the new button.

select pg_advisory_xact_lock(30501);

-- ---------------------------------------------------------------------------
-- 1. Register the action on the same permission surface END_EVENT uses
-- ---------------------------------------------------------------------------
-- sc.handle_command consults this table before the phase gate runs. Registering
-- the row keeps the refusal wording ("Quản trị không được phép: …") honest for
-- every non-supervisor seat, and lets sc._action_vn translate the name on any
-- log row that lands here from an older PWA cache.
insert into sc.role_permissions (action, role)
values ('OPEN_NEW_EVENT', 'SUPERVISOR')
on conflict (action, role) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The Vietnamese name for the audit trail
-- ---------------------------------------------------------------------------
-- Rebuilt wholesale from 0017 §3 so the CASE chain stays in one place; the only
-- change is one new WHEN arm. Retired names still resolve, so an old log row
-- still prints a Vietnamese label next to a fresh OPEN_NEW_EVENT row.
create or replace function sc._action_vn(p_action text) returns text
language sql immutable security definer set search_path = '' as $$
  select case p_action
    when 'CALL_TEAM'        then 'Nhận đội và cho lên tầng 2'
    when 'CONFIRM_FLOOR2'   then 'Xác nhận đội đã đến tầng 2'
    when 'FLOOR2_BYPASS'    then 'Bỏ qua xác nhận tầng 2'
    when 'START_GAME'       then 'Bắt đầu lượt chơi'
    when 'CLAIM_COMPLETE'   then 'Ghi nhận báo hoàn thành'
    when 'VERIFY_ATTEMPT'   then 'Xác minh lần báo hoàn thành'
    when 'CONFIRM_EXIT'     then 'Xác nhận đội đã rời tầng 3'
    when 'EARLY_EXIT'       then 'Kết thúc sớm / rời khu vực'
    when 'RESET_DONE'       then 'Đã reset xong'
    when 'GATE_FINALIZE'    then 'Chốt khu vực sẵn sàng'
    when 'SET_LAYOUT'       then 'Chọn bố trí vật ẩn'
    when 'SET_TEAM_NAME'    then 'Đặt tên đội'
    when 'CONFIGURE'        then 'Cập nhật cấu hình'
    when 'REOPEN_RESET'     then 'Mở lại một bước reset'
    when 'REVIEW_RESOLVE'   then 'Xét lại kết quả tranh chấp'
    when 'END_EVENT'        then 'Đóng sự kiện'
    when 'OPEN_NEW_EVENT'   then 'Mở sự kiện mới'
    when 'ABORT_ROUND'      then 'Hủy lượt chơi'
    when 'CORRECT_ROUND'    then 'Hiệu chỉnh mốc thời gian'
    else 'thao tác không rõ' end
$$;

revoke all on function sc._action_vn(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The command: intercepted in the wrapper, so _handle_command_internal
--    keeps the exact 0017 body it shipped with.
-- ---------------------------------------------------------------------------
-- The wrapper is the natural place because OPEN_NEW_EVENT does not operate on
-- the event _handle_command_internal is about to read from sc.state: it replaces
-- that pointer with a fresh row. Everything else — the advisory lock, the
-- released-seat refusal, and the fractional-press normalisation 0011 introduced —
-- is preserved by keeping the wrapper's preamble and only branching on the new
-- action before falling through.
--
-- Preconditions, all enforced inside PostgreSQL so an old cached PWA cannot skip
-- them:
--   - the caller has a live binding and that binding is SUPERVISOR;
--   - the caller's revision matches sc.state.revision (a stale phone is told so);
--   - the current event is closed (event_ended_at is not null);
--   - every round of the closed event is CLOSED, matching the same invariant
--     END_EVENT demanded before it wrote the end stamp;
--   - idempotency: a retry of the same actor+key returns the original answer
--     without touching the state.
--
-- On success the fresh sc.events row inherits the closed event's operational
-- configuration (round duration, prep allowance, reset target, hidden-object
-- owner, hiding layout, review threshold, stall warning) so a new shift starts
-- exactly where the last one left off. Every clock field starts null, and the
-- team sequence starts at #001 again — the new event is a new night.
-- The event's name may be overridden with p_meta->>'event_name'; otherwise the
-- closed event's name carries forward.
--
-- History is untouched by construction: the previous event row, its rounds, its
-- completion attempts, its reset tasks and its action_log entries all remain in
-- place. Only sc.state.event_id moves.
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
  v_uid   uuid;
  v_role  text;
  v_now   bigint;
  v_state sc.state;
  v_old   sc.events;
  v_new   sc.events;
  v_rev   bigint;
  v_name  text;
begin
  -- Preamble is verbatim 0011: the shared advisory lock, the released-seat check,
  -- and the fractional-press normalisation. Only after these does OPEN_NEW_EVENT
  -- branch off.
  perform pg_advisory_xact_lock(30501);
  if sc.my_role() is null then
    return sc._result(false, 'PERMISSION_DENIED', 'VỊ TRÍ ĐÃ ĐƯỢC THU HỒI', 0, sc.now_ms());
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
    -- A retry of the same tap returns the original commit; must be checked before
    -- any revision comparison so the second call after a lost reply still reads
    -- "ĐÃ GHI NHẬN TRƯỚC ĐÓ" against the new event it opened.
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
      nullif(regexp_replace(btrim(coalesce(v_meta->>'event_name', '')), '[[:space:]]+', ' ', 'g'), ''),
      v_old.name);
    -- Fresh event row inherits the operational configuration of the closed one;
    -- the name is either the supervisor's override or the closed event's name.
    -- Every clock stays null, the team sequence restarts at #001, and revision
    -- starts at 0 so _commit's bump-to-1 is the new event's first recorded state.
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
    -- The pointer moves; nothing else about the closed event changes.
    update sc.state set event_id = v_new.id, revision = 0, updated_at = v_now where id = true;
    -- _commit writes revision 1 on the new event and the matching action_log row,
    -- so the OPEN_NEW_EVENT audit entry belongs to the new event's history — that
    -- is exactly how the SQL snapshot filters it back onto the operator's phone.
    v_rev := sc._commit(v_new, p_action, null, 'ENDED', 'NONE', p_idempotency_key,
                        jsonb_build_object(
                          'previous_event_id', v_old.id,
                          'previous_event_name', v_old.name,
                          'previous_event_ended_at', v_old.event_ended_at),
                        'Đã mở sự kiện mới', v_now);
    return sc._result(true, 'OK', 'ĐÃ MỞ SỰ KIỆN MỚI', v_rev, v_now);
  end if;

  return sc._handle_command_internal(p_action, v_meta, p_expected_revision, p_idempotency_key);
end $$;

-- The public wrapper keeps the same signature; only its body changed.
create or replace function public.handle_command(
  p_action text, p_meta jsonb, p_expected_revision bigint, p_idempotency_key text
) returns jsonb
language sql security definer set search_path = '' as
$$ select sc.handle_command(p_action, coalesce(p_meta, '{}'::jsonb), p_expected_revision, p_idempotency_key) $$;

revoke all on function public.handle_command(text, jsonb, bigint, text) from public;
grant execute on function public.handle_command(text, jsonb, bigint, text) to authenticated;
grant execute on function sc.handle_command(text, jsonb, bigint, text) to authenticated;

notify pgrst, 'reload schema';
