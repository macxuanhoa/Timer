-- SCREAM CONTROL — Room 305 · V2 · PASS 1 authoritative RPCs
-- All state transitions, permission checks and timestamps happen here, inside
-- PostgreSQL. The browser never supplies a timestamp for an authoritative value.

-- ------------------------------------------------------------------ time
-- Server time in epoch milliseconds, from clock_timestamp() (the true server
-- clock, not the transaction start). A test override exists only when the
-- operator explicitly enables sc.runtime_flags.allow_test_clock.
create or replace function sc.now_ms() returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare v bigint;
begin
  select case when f.allow_test_clock and f.test_now_ms is not null
              then f.test_now_ms
              else (extract(epoch from clock_timestamp()) * 1000)::bigint
         end
    into v
    from sc.runtime_flags f where f.id = true;
  return coalesce(v, (extract(epoch from clock_timestamp()) * 1000)::bigint);
end $$;

-- Test harness only (requirement 20). Refuses unless allow_test_clock is true.
create or replace function sc.set_test_clock(p_mode text, p_ms bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_flags sc.runtime_flags; v_role text;
begin
  v_role := sc.my_role();
  if v_role is distinct from 'SUPERVISOR' then
    raise exception 'PERMISSION_DENIED';
  end if;
  select * into v_flags from sc.runtime_flags where id = true;
  if not v_flags.allow_test_clock then
    raise exception 'TEST CLOCK DISABLED';
  end if;
  update sc.runtime_flags
     set test_now_ms = case
         when p_mode = 'off' then null
         when p_mode = 'set' then p_ms
         when p_mode = 'advance' then coalesce(v_flags.test_now_ms, sc.now_ms()) + p_ms
         else null end
   where id = true;
  return sc.now_ms();
end $$;

-- ---------------------------------------------------------------- result
create or replace function sc._result(
  p_ok boolean, p_code text, p_message text, p_revision bigint, p_now bigint,
  p_requires_override boolean default null
) returns jsonb
language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'ok', p_ok, 'code', p_code, 'message', p_message,
    'revision', p_revision, 'server_now_ms', p_now,
    'requires_override', p_requires_override));
$$;

-- ------------------------------------------------------------ admission
-- Mirrors src/shared/machine.ts exactly: the event needs the full game limit
-- plus the preparation allowance for a dispatch, and only the game limit for a
-- start. Below zero, no override exists at all. The very first dispatch is what
-- anchors the 90-minute timeline, so it never waits for a separate start step.
create or replace function sc._admission(p_event sc.events, p_now bigint, p_kind text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_remaining bigint; v_required bigint;
begin
  if p_event.event_started_at is null then
    return jsonb_build_object('allowed', true, 'override_possible', false, 'code', 'ALLOWED',
                              'requires_override', false, 'message', 'Đội đầu tiên — đồng hồ 90:00 chạy từ lúc này',
                              'remaining_ms', p_event.duration_ms, 'required_ms', null,
                              'revision', p_event.revision, 'server_now_ms', p_now);
  end if;
  if p_event.event_ended_at is not null then
    return jsonb_build_object('allowed', false, 'override_possible', false, 'code', 'EVENT_ENDED',
                              'requires_override', false, 'message', 'SỰ KIỆN ĐÃ KẾT THÚC',
                              'remaining_ms', null, 'required_ms', null,
                              'revision', p_event.revision, 'server_now_ms', p_now);
  end if;
  v_remaining := p_event.event_started_at + p_event.duration_ms - p_now;
  v_required  := case when p_kind = 'dispatch'
                      then p_event.game_limit_ms + p_event.prep_allowance_ms
                      else p_event.game_limit_ms end;
  if v_remaining <= 0 then
    -- hard stop: no override exists once the event clock is exhausted
    return jsonb_build_object('allowed', false, 'override_possible', false, 'code', 'TIME_EXHAUSTED',
                              'requires_override', false, 'message', 'SẮP KẾT THÚC — KHÔNG NHẬN ĐỘI MỚI',
                              'remaining_ms', v_remaining, 'required_ms', v_required,
                              'revision', p_event.revision, 'server_now_ms', p_now);
  end if;
  if v_remaining < v_required then
    return jsonb_build_object(
      'allowed', false, 'code', 'OVERRIDE_ALLOWED', 'override_possible', true,
      'requires_override', true,
      'remaining_ms', v_remaining, 'required_ms', v_required,
      'message', case when p_kind = 'dispatch' then 'SẮP KẾT THÚC — KHÔNG NHẬN ĐỘI MỚI'
                      else 'CÒN DƯỚI 5 PHÚT' end,
      'revision', p_event.revision, 'server_now_ms', p_now);
  end if;
  return jsonb_build_object(
    'allowed', true, 'code', 'ALLOWED', 'override_possible', false, 'requires_override', false,
    'remaining_ms', v_remaining, 'required_ms', v_required,
    'message', 'Đủ thời gian', 'revision', p_event.revision, 'server_now_ms', p_now);
end $$;

-- --------------------------------------------------------------- logging
-- One immutable, server-timestamped history row per committed action.
create or replace function sc._commit(
  p_event sc.events, p_action text, p_round sc.rounds,
  p_from text, p_to text, p_idempotency text, p_meta jsonb, p_message text, p_now bigint,
  p_actor_role text default null, p_actor_id text default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_revision bigint;
begin
  update sc.events set revision = revision + 1 where id = p_event.id returning revision into v_revision;
  update sc.state set revision = v_revision, updated_at = p_now where id = true;
  insert into sc.action_log (event_id, round_id, team_number, action, actor_role, actor_id,
                             from_state, to_state, at_ms, revision, idempotency_key, metadata)
  values (p_event.id,
          case when p_round.id is null then null else p_round.id end,
          case when p_round.id is null then null else p_round.team_number end,
          p_action,
          coalesce(p_actor_role, sc.my_role()),
          coalesce(p_actor_id, ((select auth.uid())::text)),
          p_from, p_to, p_now, v_revision, p_idempotency,
          jsonb_strip_nulls(p_meta || jsonb_build_object('detail_text', p_message)));
  return v_revision;
end $$;

-- Flag a prize-relevant dispute. The original numbers are never rewritten.
create or replace function sc._review(p_round_id bigint, p_reason text)
returns void language sql security definer set search_path = '' as $$
  update sc.rounds
     set needs_review = true,
         review_resolved_at = null,
         review_reasons = (select array_agg(distinct r) from unnest(review_reasons || p_reason) r)
   where id = p_round_id;
$$;

-- ============================================================ handle_command
create or replace function sc.handle_command(
  p_action text,
  p_meta jsonb default '{}'::jsonb,
  p_expected_revision bigint default 0,
  p_idempotency_key text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role    text;
  v_uid     uuid := (select auth.uid());
  v_now     bigint;
  v_press   bigint;
  v_delay   bigint;
  v_event   sc.events;
  v_round   sc.rounds;
  v_state   sc.state;
  v_adm     jsonb;
  v_message text;
  v_to      text;
  v_from    text;
  v_missing int;
  v_done    int;
  v_duration bigint;
  v_first   boolean;
  v_revision bigint;
begin
  select role into v_role from sc.operators where user_id = v_uid;
  if v_role is null then
    return sc._result(false, 'PERMISSION_DENIED', 'TÀI KHOẢN CHƯA ĐƯỢC PHÂN QUYỀN VỊ TRÍ', 0, sc.now_ms());
  end if;

  -- one shared game state: serialise writers instead of letting two phones race
  perform pg_advisory_xact_lock(30500);

  if not exists (select 1 from sc.role_permissions where action = p_action and role = v_role) then
    return sc._result(false, 'PERMISSION_DENIED', v_role || ' KHÔNG ĐƯỢC PHÉP ' || p_action, 0, sc.now_ms());
  end if;

  select * into v_state from sc.state where id = true;
  select * into v_event from sc.events where id = v_state.event_id;
  v_now := sc.now_ms();

  -- idempotency: a retried tap returns the original result and writes nothing
  if exists (select 1 from sc.action_log
             where actor_id = v_uid::text and action = p_action and idempotency_key = p_idempotency_key) then
    return sc._result(true, 'OK', 'ĐÃ GHI NHẬN TRƯỚC ĐÓ', v_event.revision, v_now);
  end if;

  if p_expected_revision <> v_event.revision then
    return sc._result(false, 'STALE_REVISION',
                      'Trạng thái đã thay đổi (bản ' || v_event.revision || '). Đang đồng bộ lại…',
                      v_event.revision, v_now);
  end if;

  select * into v_round from sc.rounds
   where event_id = v_event.id and status <> 'GATE_CLEARED'
   order by round_number desc limit 1;
  v_from := coalesce(v_round.status, 'NONE');

  if p_action = 'CONFIGURE' then
    if v_event.event_started_at is not null and
       (p_meta ? 'event_duration_ms' or p_meta ? 'game_limit_ms' or p_meta ? 'start_team_number' or p_meta ? 'event_name') then
      return sc._result(false, 'INVALID_STATE', 'Không đổi được thời lượng sau khi sự kiện đã chạy', v_event.revision, v_now);
    end if;
    update sc.events set
      name                = coalesce(p_meta->>'event_name', name),
      duration_ms         = coalesce((p_meta->>'event_duration_ms')::bigint, duration_ms),
      game_limit_ms       = coalesce((p_meta->>'game_limit_ms')::bigint, game_limit_ms),
      prep_allowance_ms   = coalesce((p_meta->>'prep_allowance_ms')::bigint, prep_allowance_ms),
      reset_target_ms     = case when p_meta ? 'reset_target_ms'
                                 then nullif((p_meta->>'reset_target_ms'), '')::bigint else reset_target_ms end,
      hidden_object_owner = coalesce(p_meta->>'hidden_object_owner', hidden_object_owner),
      start_team_number   = coalesce((p_meta->>'start_team_number')::int, start_team_number),
      next_team_number    = case when v_event.event_started_at is null
                                 then coalesce((p_meta->>'start_team_number')::int, next_team_number)
                                 else next_team_number end
     where id = v_event.id
     returning * into v_event;
    v_revision := sc._commit(v_event, p_action, null, v_from, null, p_idempotency_key, p_meta, 'Đã cập nhật cấu hình sự kiện', v_now);
    return sc._result(true, 'OK', 'Đã lưu cấu hình', v_revision, v_now);

  elsif p_action = 'START_EVENT' then
    -- Retired: the 90-minute timeline opens on the first team dispatch, so a
    -- stale client pressing the old button can never move the clock.
    return sc._result(false, 'UNKNOWN_ACTION', 'Đồng hồ 90:00 mở bằng lần gọi đội đầu tiên', v_event.revision, v_now);

  elsif p_action = 'CALL_TEAM' then
    if v_event.event_ended_at is not null then
      return sc._result(false, 'INVALID_STATE', 'SỰ KIỆN ĐÃ KẾT THÚC', v_event.revision, v_now);
    end if;
    if v_round.id is not null then
      return sc._result(false, 'INVALID_STATE', 'Vẫn còn đội chưa hoàn tất', v_event.revision, v_now);
    end if;
    -- The first team to go upstairs is what starts the fixed 90-minute timeline.
    v_first := v_event.event_started_at is null;
    if v_first then
      update sc.events set event_started_at = v_now where id = v_event.id returning * into v_event;
    end if;
    v_adm := sc._admission(v_event, v_now, 'dispatch');
    if not (v_adm->>'allowed')::boolean then
      if not coalesce((v_adm->>'override_possible')::boolean, false)
         or not coalesce((p_meta->>'override')::boolean, false)
         or coalesce(p_meta->>'reason', '') = '' then
        return sc._result(false, 'BLOCKED', v_adm->>'message', v_event.revision, v_now,
                          coalesce((v_adm->>'requires_override')::boolean, false));
      end if;
    end if;
    insert into sc.rounds (event_id, round_number, team_number, team_name, status, stage, called_at,
                           created_revision, admission_override, hiding_layout)
    values (v_event.id,
            (select count(*) from sc.rounds where event_id = v_event.id) + 1,
            v_event.next_team_number,
            nullif(p_meta->>'team_name',''),
            'LOBBY_CALL', 1, v_now, v_event.revision + 1,
            not (v_adm->>'allowed')::boolean,
            v_event.hiding_layout)
    returning * into v_round;
    update sc.events set next_team_number = next_team_number + 1 where id = v_event.id returning * into v_event;
    insert into sc.reset_tasks (round_id, task_key, required_role) values
      (v_round.id, 'hidden_objects', v_event.hidden_object_owner),
      (v_round.id, 'hallway', 'CORRIDOR'),
      (v_round.id, 'room', 'ROOM305');
    v_revision := sc._commit(v_event, p_action, v_round, v_from, 'LOBBY_CALL', p_idempotency_key,
                             jsonb_build_object('remaining_ms', (v_adm->>'remaining_ms')::bigint,
                                                'required_ms', (v_adm->>'required_ms')::bigint,
                                                'reason', nullif(p_meta->>'reason',''),
                                                'event_clock_started', case when v_first then true else null end,
                                                'deadline_ms', case when v_first
                                                                    then v_now + v_event.duration_ms else null end,
                                                'override', case when not (v_adm->>'allowed')::boolean then true else null end),
                             case when v_first
                                  then 'Đã gọi đội #' || lpad(v_round.team_number::text, 3, '0') || ' · đồng hồ 90:00 chạy từ đây'
                                  else 'Đã gọi đội #' || lpad(v_round.team_number::text, 3, '0') end, v_now);
    return sc._result(true, 'OK', 'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' đang lên tầng', v_revision, v_now);

  elsif p_action = 'TEAM_UPSTAIRS' then
    if v_round.id is null then
      return sc._result(false, 'INVALID_STATE', 'Không có lượt chơi đang hoạt động', v_event.revision, v_now);
    end if;
    if v_round.status <> 'LOBBY_CALL' then
      return sc._result(true, 'OK', 'Trạng thái đã được ghi nhận', v_event.revision, v_now);
    end if;
    update sc.rounds set status = 'TEAM_PREPARING' where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_from, 'TEAM_PREPARING', p_idempotency_key, '{}'::jsonb,
                             'Đội đang lên cầu thang', v_now);
    return sc._result(true, 'OK', 'Đội đang lên tầng', v_revision, v_now);

  elsif p_action = 'START_GAME' then
    if v_round.id is null then
      return sc._result(false, 'INVALID_STATE', 'Không có lượt chơi đang hoạt động', v_event.revision, v_now);
    end if;
    if v_round.game_started_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Đồng hồ trận đã chạy', v_event.revision, v_now);
    end if;
    if v_round.status not in ('LOBBY_CALL','TEAM_PREPARING') then
      return sc._result(false, 'INVALID_STATE', 'Không thể bắt đầu trận từ trạng thái này', v_event.revision, v_now);
    end if;
    v_adm := sc._admission(v_event, v_now, 'start');
    if not (v_adm->>'allowed')::boolean then
      if not coalesce((v_adm->>'override_possible')::boolean, false)
         or not coalesce((p_meta->>'override')::boolean, false)
         or coalesce(p_meta->>'reason', '') = '' then
        return sc._result(false, 'BLOCKED', v_adm->>'message', v_event.revision, v_now,
                          coalesce((v_adm->>'requires_override')::boolean, false));
      end if;
      update sc.rounds set admission_override = true where id = v_round.id returning * into v_round;
    end if;
    update sc.rounds
       set status = 'GAME_STARTED', stage = greatest(stage, 2),
           game_started_at = v_now, game_anchor_ms = v_now, game_elapsed_ms = 0
     where id = v_round.id returning * into v_round;
    -- Transport diagnostics only: the official timestamp stays the server value.
    v_press := nullif(p_meta#>>'{_press,press_ms}','')::bigint;
    if v_press is not null then
      v_delay := greatest(0, v_now - v_press);
      update sc.rounds
         set start_press_ms = v_press, start_transport_ms = v_delay
       where id = v_round.id returning * into v_round;
      if v_delay > v_event.review_threshold_ms then
        perform sc._review(v_round.id, 'START_TRANSPORT');
      end if;
    end if;
    v_revision := sc._commit(v_event, p_action, v_round, v_from, 'GAME_STARTED', p_idempotency_key,
                             jsonb_build_object('prep_ms', v_now - v_round.called_at,
                                                'remaining_ms', (v_adm->>'remaining_ms')::bigint,
                                                'start_transport_ms', v_delay,
                                                'reason', nullif(p_meta->>'reason',''),
                                                'override', case when not (v_adm->>'allowed')::boolean then true else null end),
                             'Bắt đầu trận đội #' || lpad(v_round.team_number::text, 3, '0'), v_now);
    return sc._result(true, 'OK', 'Đồng hồ 5:00 đang chạy', v_revision, v_now);

  elsif p_action in ('GAME_PAUSE', 'GAME_RESUME', 'GAME_RESET') then
    if v_round.id is null or v_round.game_started_at is null or v_round.game_stopped_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Không có đồng hồ 5:00 đang chạy', v_event.revision, v_now);
    end if;

    if p_action = 'GAME_PAUSE' then
      if v_round.game_anchor_ms is null then
        return sc._result(true, 'OK', '5:00 đang tạm dừng', v_event.revision, v_now);
      end if;
      v_duration := v_round.game_elapsed_ms + greatest(0, v_now - v_round.game_anchor_ms);
      update sc.rounds
         set game_elapsed_ms = v_duration, game_anchor_ms = null,
             game_pause_count = game_pause_count + 1
       where id = v_round.id returning * into v_round;
      v_revision := sc._commit(v_event, p_action, v_round, v_from, v_round.status, p_idempotency_key,
                               jsonb_build_object('banked_ms', v_duration,
                                                  'remaining_ms', v_event.game_limit_ms - v_duration,
                                                  'pause_count', v_round.game_pause_count),
                               'Tạm dừng đồng hồ 5:00 · 90:00 vẫn chạy', v_now);
      return sc._result(true, 'OK', 'TẠM DỪNG 5:00 · 90:00 vẫn chạy', v_revision, v_now);

    elsif p_action = 'GAME_RESUME' then
      if v_round.game_anchor_ms is not null then
        return sc._result(true, 'OK', 'Đồng hồ 5:00 đang chạy', v_event.revision, v_now);
      end if;
      update sc.rounds set game_anchor_ms = v_now where id = v_round.id returning * into v_round;
      v_revision := sc._commit(v_event, p_action, v_round, v_from, v_round.status, p_idempotency_key,
                               jsonb_build_object('remaining_ms', v_event.game_limit_ms - v_round.game_elapsed_ms,
                                                  'pause_count', v_round.game_pause_count),
                               'Chạy lại đồng hồ 5:00', v_now);
      return sc._result(true, 'OK', '5:00 chạy lại', v_revision, v_now);
    end if;

    -- GAME_RESET: a restart of the flexible window, which is a scoring decision.
    v_duration := v_round.game_elapsed_ms
                  + case when v_round.game_anchor_ms is null then 0 else greatest(0, v_now - v_round.game_anchor_ms) end;
    update sc.rounds
       set game_elapsed_ms = 0, game_anchor_ms = v_now,
           game_reset_count = game_reset_count + 1
     where id = v_round.id returning * into v_round;
    perform sc._review(v_round.id, 'GAME_RESET');
    v_revision := sc._commit(v_event, p_action, v_round, v_from, v_round.status, p_idempotency_key,
                             jsonb_build_object('discarded_ms', v_duration,
                                                'reset_count', v_round.game_reset_count,
                                                'pause_count', v_round.game_pause_count),
                             'RESET 5:00 · lần ' || v_round.game_reset_count, v_now);
    return sc._result(true, 'OK', 'ĐÃ RESET 5:00 · kết quả chờ SUPERVISOR xét', v_revision, v_now);

  elsif p_action = 'HALLWAY_PROGRESS' then
    if v_round.id is null or v_round.game_stopped_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Không có lượt chơi đang hoạt động', v_event.revision, v_now);
    end if;
    if v_round.status = 'GAME_STARTED' then
      update sc.rounds set status = 'CORRIDOR_ACTIVE', stage = greatest(stage, 3)
        where id = v_round.id returning * into v_round;
      v_revision := sc._commit(v_event, p_action, v_round, v_from, 'CORRIDOR_ACTIVE', p_idempotency_key, '{}'::jsonb,
                               'Đội đang tìm ở hành lang', v_now);
      return sc._result(true, 'OK', 'Đã ghi nhận hành lang', v_revision, v_now);
    end if;
    return sc._result(true, 'OK', 'Đã ghi nhận hành lang', v_event.revision, v_now);

  elsif p_action = 'ROOM_REACHED' then
    if v_round.id is null or v_round.game_stopped_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Không có lượt chơi đang hoạt động', v_event.revision, v_now);
    end if;
    if v_round.status in ('GAME_STARTED','CORRIDOR_ACTIVE') then
      update sc.rounds set status = 'ROOM_REACHED', stage = greatest(stage, 4)
        where id = v_round.id returning * into v_round;
      v_revision := sc._commit(v_event, p_action, v_round, v_from, 'ROOM_REACHED', p_idempotency_key, '{}'::jsonb,
                               'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' đã đến 305', v_now);
      return sc._result(true, 'OK', 'Đã ghi nhận đến phòng 305', v_revision, v_now);
    end if;
    return sc._result(true, 'OK', 'Đã ghi nhận đến phòng 305', v_event.revision, v_now);

  elsif p_action = 'PUZZLE_COMPLETE' then
    if v_round.id is null or v_round.game_stopped_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Không có lượt chơi đang hoạt động', v_event.revision, v_now);
    end if;
    if v_round.puzzle_completed_at is not null then
      return sc._result(true, 'OK', 'Trận đồ đã được xác nhận', v_event.revision, v_now);
    end if;
    -- explicitly does NOT stop the official clock
    update sc.rounds
       set puzzle_completed_at = v_now, status = 'PUZZLE_COMPLETED', stage = greatest(stage, 5)
     where id = v_round.id returning * into v_round;
    v_press := nullif(p_meta#>>'{_press,press_ms}','')::bigint;
    if v_press is not null and (v_now - v_press) > v_event.review_threshold_ms then
      perform sc._review(v_round.id, 'PUZZLE_TRANSPORT');
    end if;
    v_revision := sc._commit(v_event, p_action, v_round, v_from, 'PUZZLE_COMPLETED', p_idempotency_key,
                             jsonb_build_object('elapsed_ms', v_now - v_round.game_started_at,
                                                'press_transport_ms', case when v_press is null then null else v_now - v_press end),
                             'Trận đồ hoàn thành — đồng hồ vẫn chạy', v_now);
    return sc._result(true, 'OK', 'Trận đồ hoàn thành', v_revision, v_now);

  elsif p_action = 'RETURN_START' then
    if v_round.id is null or v_round.game_stopped_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Không có lượt chơi đang hoạt động', v_event.revision, v_now);
    end if;
    if v_round.status <> 'RETURNING' then
      update sc.rounds set status = 'RETURNING', stage = greatest(stage, 6)
        where id = v_round.id returning * into v_round;
      v_revision := sc._commit(v_event, p_action, v_round, v_from, 'RETURNING', p_idempotency_key, '{}'::jsonb,
                               'Đội đang quay lại cửa vào', v_now);
      return sc._result(true, 'OK', 'Đã ghi nhận đội quay lại', v_revision, v_now);
    end if;
    return sc._result(true, 'OK', 'Đã ghi nhận đội quay lại', v_event.revision, v_now);

  elsif p_action = 'GAME_STOP' then
    if v_round.id is null then
      return sc._result(false, 'INVALID_STATE', 'Không có lượt chơi đang hoạt động', v_event.revision, v_now);
    end if;
    if v_round.game_stopped_at is not null then
      return sc._result(true, 'OK', 'Đã chốt giờ: ' || v_round.official_duration_ms || ' ms', v_event.revision, v_now);
    end if;
    if v_round.game_started_at is null then
      return sc._result(false, 'INVALID_STATE', 'Trận chưa bắt đầu', v_event.revision, v_now);
    end if;
    v_duration := v_round.game_elapsed_ms
                  + case when v_round.game_anchor_ms is null then 0 else greatest(0, v_now - v_round.game_anchor_ms) end;
    update sc.rounds
       set game_stopped_at = v_now,
           exit_confirmed_at = v_now,
           game_elapsed_ms = v_duration,
           game_anchor_ms = null,
           official_duration_ms = v_duration,
           status = 'RESETTING',
           stage = greatest(stage, 7),
           outcome = case
               when v_duration > v_event.game_limit_ms then 'TIMEOUT'
               when puzzle_completed_at is null then 'NO_PUZZLE'
               else 'WON' end
     where id = v_round.id returning * into v_round;
    v_press := nullif(p_meta#>>'{_press,press_ms}','')::bigint;
    if v_press is not null then
      v_delay := greatest(0, v_now - v_press);
      update sc.rounds set stop_press_ms = v_press, stop_transport_ms = v_delay
       where id = v_round.id returning * into v_round;
      if v_delay > v_event.review_threshold_ms then
        perform sc._review(v_round.id, 'STOP_TRANSPORT');
      end if;
    end if;
    -- A finish within the review window of the limit is a dispute, not a fact.
    if abs(v_event.game_limit_ms - v_duration) <= v_event.review_threshold_ms then
      perform sc._review(v_round.id, 'CLOSE_FINISH');
    end if;
    v_revision := sc._commit(v_event, p_action, v_round, v_from, 'RESETTING', p_idempotency_key,
                             jsonb_build_object('official_duration_ms', v_duration,
                                                'outcome', v_round.outcome,
                                                'limit_ms', v_event.game_limit_ms,
                                                'game_reset_count', v_round.game_reset_count,
                                                'game_pause_count', v_round.game_pause_count,
                                                'stop_transport_ms', v_delay),
                             'Chốt giờ đội #' || lpad(v_round.team_number::text, 3, '0') || ': ' || v_duration || ' ms', v_now);
    return sc._result(true, 'OK', 'Kết quả: ' || v_round.outcome || ' ' || v_duration || ' ms', v_revision, v_now);

  elsif p_action = 'RESET_DONE' then
    if v_round.id is null or v_round.game_stopped_at is null then
      return sc._result(false, 'INVALID_STATE', 'Chưa tới giai đoạn reset', v_event.revision, v_now);
    end if;
    update sc.reset_tasks
       set completed_at = v_now, confirmed_by_role = v_role, confirmed_by = v_uid,
           cycle = v_round.reset_cycle,
           layout = case when task_key = 'hidden_objects' then v_event.hiding_layout else layout end,
           revision = v_event.revision + 1
     where round_id = v_round.id
       and completed_at is null
       and (required_role = v_role
            or (v_role = 'SUPERVISOR' and nullif(p_meta->>'task_key','') is not null
                and task_key = p_meta->>'task_key'));
    get diagnostics v_done = row_count;
    if v_done = 0 then
      return sc._result(true, 'OK', 'Không có tác vụ nào chờ xác nhận', v_event.revision, v_now);
    end if;
    select count(*) into v_missing from sc.reset_tasks
     where round_id = v_round.id and (completed_at is null or cycle <> v_round.reset_cycle);
    v_to := case when v_missing = 0 then 'RESET_CONFIRMED' else 'RESETTING' end;
    update sc.rounds set status = v_to, stage = greatest(stage, 7) where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_from, v_to, p_idempotency_key,
                             jsonb_build_object('tasks', (select jsonb_agg(task_key) from sc.reset_tasks
                                                           where round_id = v_round.id and completed_at = v_now),
                                                'cycle', v_round.reset_cycle,
                                                'layout', v_event.hiding_layout,
                                                'since_stop_ms', v_now - v_round.game_stopped_at),
                             v_role || ' xác nhận xong reset', v_now);
    return sc._result(true, 'OK', 'Đã ghi nhận reset', v_revision, v_now);

  elsif p_action = 'GATE_FINALIZE' then
    if v_round.id is null or v_round.game_stopped_at is null then
      return sc._result(false, 'INVALID_STATE', 'Chưa tới giai đoạn reset', v_event.revision, v_now);
    end if;
    select count(*) into v_missing from sc.reset_tasks
     where round_id = v_round.id and (completed_at is null or cycle <> v_round.reset_cycle);
    if v_missing > 0 then
      return sc._result(false, 'BLOCKED', 'Chưa xác nhận reset: còn ' || v_missing || ' tác vụ', v_event.revision, v_now);
    end if;
    update sc.rounds
       set gate_finalized_at = v_now, system_ready_at = v_now, status = 'GATE_CLEARED', stage = 9
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_from, 'GATE_CLEARED', p_idempotency_key,
                             jsonb_build_object('total_reset_ms', v_now - v_round.game_stopped_at),
                             'GATE xác nhận khu vực thông thoáng — SẴN SÀNG', v_now);
    return sc._result(true, 'OK', 'SẴN SÀNG nhận đội tiếp theo', v_revision, v_now);

  elsif p_action = 'SET_LAYOUT' then
    if p_meta->>'layout' not in ('A','B','C') then
      return sc._result(false, 'INVALID_STATE', 'Bố trí không hợp lệ (A/B/C)', v_event.revision, v_now);
    end if;
    if v_role <> 'SUPERVISOR' and v_role <> v_event.hidden_object_owner then
      return sc._result(false, 'PERMISSION_DENIED',
                        'Chỉ ' || v_event.hidden_object_owner || ' mới bố trí vật ẩn', v_event.revision, v_now);
    end if;
    update sc.events set hiding_layout = p_meta->>'layout' where id = v_event.id returning * into v_event;
    v_revision := sc._commit(v_event, p_action, v_round, v_from, null, p_idempotency_key,
                             jsonb_build_object('to', v_event.hiding_layout),
                             'Bố trí vật ẩn: ' || v_event.hiding_layout, v_now);
    return sc._result(true, 'OK', 'Đã chuẩn bị bố trí ' || v_event.hiding_layout, v_revision, v_now);

  elsif p_action = 'REOPEN_RESET' then
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do mở lại reset', v_event.revision, v_now);
    end if;
    select * into v_round from sc.rounds where id = (p_meta->>'round_id')::bigint;
    if not found then
      return sc._result(false, 'INVALID_STATE', 'Không tìm thấy lượt chơi', v_event.revision, v_now);
    end if;
    if v_round.game_stopped_at is null then
      return sc._result(false, 'INVALID_STATE', 'Lượt chơi không ở giai đoạn reset', v_event.revision, v_now);
    end if;
    -- Readiness may only be revoked while no newer team has been called.
    if v_round.status = 'GATE_CLEARED' and v_round.id <> (select max(id) from sc.rounds where event_id = v_event.id) then
      return sc._result(false, 'INVALID_STATE', 'Đã gọi đội mới — không thể mở lại reset cũ', v_event.revision, v_now);
    end if;
    update sc.reset_tasks
       set completed_at = null, confirmed_by_role = null, confirmed_by = null, layout = null,
           reopen_count = reopen_count + 1
     where round_id = v_round.id and completed_at is not null;
    update sc.rounds
       set reset_cycle = reset_cycle + 1, gate_finalized_at = null, system_ready_at = null, status = 'RESETTING'
     where id = v_round.id returning * into v_round;
    -- Put every task of the round onto the new cycle: a mark from the previous
    -- cycle can then never satisfy the current one.
    update sc.reset_tasks set cycle = v_round.reset_cycle where round_id = v_round.id;
    v_revision := sc._commit(v_event, p_action, v_round, v_from, 'RESETTING', p_idempotency_key,
                             jsonb_build_object('reason', p_meta->>'reason',
                                                'task', coalesce(nullif(p_meta->>'task_key',''),'all'),
                                                'cycle', v_round.reset_cycle),
                             'Mở lại reset đội #' || lpad(v_round.team_number::text, 3, '0') || ' · chu kỳ ' || v_round.reset_cycle,
                             v_now);
    return sc._result(true, 'OK', 'Cả ba bước reset phải xác nhận lại', v_revision, v_now);

  elsif p_action = 'REVIEW_RESOLVE' then
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do quyết định', v_event.revision, v_now);
    end if;
    if p_meta->>'decision' not in ('ACCEPT','REJECT') then
      return sc._result(false, 'INVALID_STATE', 'Quyết định không hợp lệ', v_event.revision, v_now);
    end if;
    select * into v_round from sc.rounds where id = (p_meta->>'round_id')::bigint;
    if not found then
      return sc._result(false, 'INVALID_STATE', 'Không tìm thấy lượt chơi', v_event.revision, v_now);
    end if;
    if not v_round.needs_review then
      return sc._result(false, 'INVALID_STATE', 'Lượt chơi không chờ xem xét', v_event.revision, v_now);
    end if;
    update sc.rounds
       set needs_review = false,
           review_resolved_at = v_now,
           decertified = (p_meta->>'decision' = 'REJECT')
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_from, v_round.status, p_idempotency_key,
                             jsonb_build_object('reason', p_meta->>'reason',
                                                'decision', p_meta->>'decision',
                                                'reasons', v_round.review_reasons,
                                                'official_duration_ms', v_round.official_duration_ms),
                             -- NOTE: `->>` shares precedence with `||`, so the
                             -- jsonb accessor must stay parenthesised.
                             'Xét kết quả đội #' || lpad(v_round.team_number::text, 3, '0') || ': ' || (p_meta->>'decision'),
                             v_now);
    return sc._result(true, 'OK',
                      case when p_meta->>'decision' = 'ACCEPT' then 'Đã xếp hạng kết quả'
                           else 'Kết quả bị loại khỏi bảng xếp hạng' end, v_revision, v_now);

  elsif p_action = 'END_EVENT' then
    if v_event.event_ended_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Sự kiện đã kết thúc', v_event.revision, v_now);
    end if;
    -- Controlled closure is an explicit, reasoned, audited decision.
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Cần nhập lý do đóng sự kiện sớm', v_event.revision, v_now);
    end if;
    if v_round.id is not null then
      return sc._result(false, 'BLOCKED',
                        case when v_round.game_stopped_at is null
                             then 'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' vẫn đang trong khu vực'
                             else 'Chưa hoàn tất reset cho đội hiện tại' end,
                        v_event.revision, v_now);
    end if;
    update sc.events set event_ended_at = v_now where id = v_event.id returning * into v_event;
    v_revision := sc._commit(v_event, p_action, null, v_from, 'ENDED', p_idempotency_key,
                             jsonb_build_object('overtime_ms',
                               greatest(0, v_now - (v_event.event_started_at + v_event.duration_ms))),
                             'SỰ KIỆN KẾT THÚC', v_now);
    return sc._result(true, 'OK', 'SỰ KIỆN KẾT THÚC', v_revision, v_now);

  elsif p_action = 'ABORT_ROUND' then
    if v_round.id is null then
      return sc._result(false, 'INVALID_STATE', 'Không có lượt chơi đang hoạt động', v_event.revision, v_now);
    end if;
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do dừng khẩn cấp', v_event.revision, v_now);
    end if;
    update sc.rounds
       set game_stopped_at    = coalesce(game_stopped_at, case when game_started_at is null then null else v_now end),
           exit_confirmed_at  = coalesce(exit_confirmed_at, case when game_started_at is null then null else v_now end),
           official_duration_ms = coalesce(official_duration_ms,
                                           case when game_started_at is null then null
                                                else game_elapsed_ms + case when game_anchor_ms is null then 0
                                                                            else greatest(0, v_now - game_anchor_ms) end end),
           game_elapsed_ms = case when game_started_at is null then game_elapsed_ms
                                  else game_elapsed_ms + case when game_anchor_ms is null then 0
                                                              else greatest(0, v_now - game_anchor_ms) end end,
           game_anchor_ms = null,
           aborted_at = v_now,
           outcome = 'ABORTED',
           status = 'RESETTING'
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_from, 'RESETTING', p_idempotency_key,
                             jsonb_build_object('reason', p_meta->>'reason'),
                             'DỪNG KHẨN CẤP đội #' || lpad(v_round.team_number::text, 3, '0'), v_now);
    return sc._result(true, 'OK', 'Đã dừng khẩn cấp — khu vực cần reset', v_revision, v_now);

  elsif p_action = 'CORRECT_ROUND' then
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do hiệu chỉnh', v_event.revision, v_now);
    end if;
    select * into v_round from sc.rounds where id = (p_meta->>'round_id')::bigint;
    if not found then
      return sc._result(false, 'INVALID_STATE', 'Không tìm thấy lượt chơi', v_event.revision, v_now);
    end if;
    if p_meta->>'field' not in ('game_started_at','game_stopped_at','puzzle_completed_at','exit_confirmed_at') then
      return sc._result(false, 'INVALID_STATE', 'Trường không được phép hiệu chỉnh', v_event.revision, v_now);
    end if;
    if v_round.system_ready_at is not null and p_meta->>'field' <> 'puzzle_completed_at' then
      return sc._result(false, 'INVALID_STATE', 'Lượt chơi đã đóng — không đổi mốc giờ sau khi SẴN SÀNG', v_event.revision, v_now);
    end if;
    -- An absent/null value_ms is an explicit undo (Scenario A), never a silent
    -- delete: the original value stays in the audit entry below.
    update sc.rounds
       set game_started_at     = case when p_meta->>'field' = 'game_started_at'
                                      then nullif(p_meta->>'value_ms','')::bigint else game_started_at end,
           game_stopped_at     = case when p_meta->>'field' = 'game_stopped_at'
                                      then nullif(p_meta->>'value_ms','')::bigint else game_stopped_at end,
           puzzle_completed_at = case when p_meta->>'field' = 'puzzle_completed_at'
                                      then nullif(p_meta->>'value_ms','')::bigint else puzzle_completed_at end,
           exit_confirmed_at   = case when p_meta->>'field' = 'exit_confirmed_at'
                                      then nullif(p_meta->>'value_ms','')::bigint else exit_confirmed_at end
     where id = v_round.id
     returning * into v_round;
    if v_round.game_started_at is not null and v_round.game_stopped_at is not null
       and v_round.game_reset_count = 0 and v_round.game_pause_count = 0 then
      update sc.rounds
         set official_duration_ms = greatest(0, v_round.game_stopped_at - v_round.game_started_at),
             outcome = case when v_round.aborted_at is not null then 'ABORTED'
                            when greatest(0, v_round.game_stopped_at - v_round.game_started_at) > v_event.game_limit_ms then 'TIMEOUT'
                            when v_round.puzzle_completed_at is null then 'NO_PUZZLE'
                            else 'WON' end
       where id = v_round.id returning * into v_round;
    end if;
    -- A manually corrected result is prize-relevant: it stays flagged until the
    -- supervisor records an explicit ACCEPT or REJECT.
    perform sc._review(v_round.id, 'CORRECTED');
    v_revision := sc._commit(v_event, p_action, v_round, v_from, v_round.status, p_idempotency_key,
                             jsonb_build_object('field', p_meta->>'field',
                                                'after_ms', nullif(p_meta->>'value_ms','')::bigint,
                                                'undone', p_meta->>'value_ms' is null or p_meta->>'value_ms' = '',
                                                'reason', p_meta->>'reason'),
                             'Hiệu chỉnh ' || (p_meta->>'field'), v_now);
    return sc._result(true, 'OK', 'Đã hiệu chỉnh · kết quả chờ xét lại', v_revision, v_now);
  end if;

  return sc._result(false, 'UNKNOWN_ACTION', 'Hành động không xác định', v_event.revision, v_now);
end $$;

-- Derived time boundaries: recorded only when a boundary is actually crossed,
-- so no countdown frame ever writes to the database.
create or replace function sc.tick() returns void
language plpgsql security definer set search_path = '' as $$
declare v_state sc.state; v_event sc.events; v_now bigint; v_round sc.rounds; v_remaining bigint;
begin
  if sc.my_role() is null then
    return;
  end if;
  select * into v_state from sc.state where id = true;
  select * into v_event from sc.events where id = v_state.event_id;
  if v_event.event_started_at is null or v_event.event_ended_at is not null then
    return;
  end if;
  v_now := sc.now_ms();
  v_remaining := v_event.event_started_at + v_event.duration_ms - v_now;
  select * into v_round from sc.rounds
    where event_id = v_event.id and status <> 'GATE_CLEARED'
    order by round_number desc limit 1;

  if v_remaining <= 0 then
    if v_round.id is not null then
      -- the 90-minute deadline passed with players inside: overtime is recorded,
      -- the round is NOT abandoned and the area is not marked ready.
      if v_event.overtime_started_at is null then
        update sc.events set overtime_started_at = v_now where id = v_event.id returning * into v_event;
        perform sc._commit(v_event, 'OVERTIME_STARTED', v_round, v_round.status, 'EVENT OVERTIME',
                           'auto:overtime:' || v_now, jsonb_build_object('auto', true, 'remaining_ms', v_remaining),
                           'EVENT OVERTIME', v_now, 'SUPERVISOR', 'system.clock');
      end if;
    end if;
    -- Past the deadline the fixed timeline is deliberately left running negative:
    -- closing the event is a human decision, never something the timer does.
    return;
  end if;

  if v_remaining <= 900000 and v_event.closing_warned_at is null then
    update sc.events set closing_warned_at = v_now where id = v_event.id returning * into v_event;
    perform sc._commit(v_event, 'CONFIGURE', null, null, 'CLOSING', 'auto:warn15:' || v_now,
                       jsonb_build_object('warning', '15m'), 'Còn 15 phút', v_now, 'SUPERVISOR', 'system.clock');
  elsif v_remaining <= 300000 and v_event.end_warned_at is null then
    update sc.events set end_warned_at = v_now where id = v_event.id returning * into v_event;
    perform sc._commit(v_event, 'CONFIGURE', null, null, 'CLOSING', 'auto:warn5:' || v_now,
                       jsonb_build_object('warning', '5m'), 'Còn 5 phút', v_now, 'SUPERVISOR', 'system.clock');
  end if;
end $$;

-- =============================================================== snapshot
-- Reads may settle a derived boundary (auto close / overtime), so this is a
-- volatile SECURITY DEFINER function rather than a plain view.
create or replace function sc.snapshot() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_state sc.state; v_event sc.events; v_now bigint;
begin
  if sc.my_role() is null then
    raise exception 'PERMISSION_DENIED';
  end if;
  perform sc.tick();
  select * into v_state from sc.state where id = true;
  select * into v_event from sc.events where id = v_state.event_id;
  v_now := sc.now_ms();
  return jsonb_build_object(
    'revision', v_event.revision,
    'server_now_ms', v_now,
    'event', jsonb_build_object(
      'id', v_event.id::text,
      'config', jsonb_build_object(
        'event_name', v_event.name,
        'event_duration_ms', v_event.duration_ms,
        'game_limit_ms', v_event.game_limit_ms,
        'prep_allowance_ms', v_event.prep_allowance_ms,
        'start_team_number', v_event.start_team_number,
        'reset_target_ms', v_event.reset_target_ms,
        'hidden_object_owner', v_event.hidden_object_owner,
        'hiding_layout', v_event.hiding_layout,
        'review_threshold_ms', v_event.review_threshold_ms,
        'stall_warn_ms', v_event.stall_warn_ms),
      'event_started_at', v_event.event_started_at,
      'event_ended_at', v_event.event_ended_at,
      'overtime_started_at', v_event.overtime_started_at,
      'closing_warned_at', v_event.closing_warned_at,
      'end_warned_at', v_event.end_warned_at,
      'next_team_number', v_event.next_team_number,
      'revision', v_event.revision),
    'rounds', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id::text, 'event_id', r.event_id::text, 'round_number', r.round_number,
        'team_number', r.team_number, 'team_name', r.team_name, 'status', r.status, 'stage', r.stage,
        'called_at', r.called_at, 'game_started_at', r.game_started_at,
        'game_anchor_ms', r.game_anchor_ms, 'game_elapsed_ms', r.game_elapsed_ms,
        'game_reset_count', r.game_reset_count, 'game_pause_count', r.game_pause_count,
        'game_stopped_at', r.game_stopped_at,
        'official_duration_ms', r.official_duration_ms, 'puzzle_completed_at', r.puzzle_completed_at,
        'exit_confirmed_at', r.exit_confirmed_at, 'gate_finalized_at', r.gate_finalized_at,
        'system_ready_at', r.system_ready_at, 'aborted_at', r.aborted_at, 'outcome', r.outcome,
        'admission_override', r.admission_override, 'hiding_layout', r.hiding_layout,
        'reset_cycle', r.reset_cycle, 'start_press_ms', r.start_press_ms, 'stop_press_ms', r.stop_press_ms,
        'start_transport_ms', r.start_transport_ms, 'stop_transport_ms', r.stop_transport_ms,
        'needs_review', r.needs_review, 'review_reasons', r.review_reasons,
        'review_resolved_at', r.review_resolved_at, 'decertified', r.decertified,
        'created_revision', r.created_revision)
        order by r.round_number)
      from sc.rounds r where r.event_id = v_event.id), '[]'::jsonb),
    'reset_tasks', coalesce((select jsonb_agg(jsonb_build_object(
        'round_id', t.round_id::text, 'task_key', t.task_key, 'required_role', t.required_role,
        'confirmed_by_role', t.confirmed_by_role, 'confirmed_by', t.confirmed_by,
        'completed_at', t.completed_at, 'cycle', t.cycle, 'reopen_count', t.reopen_count,
        'layout', t.layout, 'revision', t.revision) order by t.round_id, t.task_key)
      from sc.reset_tasks t
      join sc.rounds r on r.id = t.round_id where r.event_id = v_event.id), '[]'::jsonb),
    'operators', sc.operator_states(v_event.id),
    'log', coalesce((select jsonb_agg(jsonb_build_object(
        'seq', l.seq, 'event_id', l.event_id::text, 'round_id', l.round_id::text,
        'team_number', l.team_number, 'action', l.action, 'actor_role', l.actor_role,
        'actor_id', l.actor_id, 'from_state', l.from_state, 'to_state', l.to_state,
        'at_ms', l.at_ms, 'revision', l.revision, 'idempotency_key', l.idempotency_key,
        'metadata', l.metadata) order by l.seq desc)
      from (select * from sc.action_log a where a.event_id = v_event.id order by a.seq desc limit 400) l), '[]'::jsonb)
  );
end $$;

create or replace function sc.server_now_ms() returns bigint
language sql stable security definer set search_path = '' as $$ select sc.now_ms() $$;

-- Cheap freshness probe for the client's periodic authoritative verification.
create or replace function sc.state_revision() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_now bigint; v_result jsonb;
begin
  if sc.my_role() is null then
    raise exception 'PERMISSION_DENIED';
  end if;
  v_now := sc.now_ms();
  select jsonb_build_object('revision', s.revision, 'server_now_ms', v_now, 'event_id', e.id::text)
    into v_result
    from sc.state s join sc.events e on e.id = s.event_id
   where s.id = true;
  return v_result;
end $$;

-- Scenario G: “committed but the reply was lost”. Always returns exactly one
-- object: a missing row must read as found:false, never as SQL NULL.
create or replace function sc.operation_status(p_idempotency_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('found', true, 'action', l.action, 'at_ms', l.at_ms,
                               'revision', l.revision, 'round_id', l.round_id::text)
       from sc.action_log l
      where l.actor_id = ((select auth.uid())::text) and l.idempotency_key = p_idempotency_key
      limit 1),
    jsonb_build_object('found', false));
$$;

-- Build the operator readiness list from the append-only history.
create or replace function sc.operator_states(p_event_id bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'role', o.role, 'display_name', o.display_name,
      'last_action', l.action, 'last_action_at', l.at_ms,
      'last_detail', l.metadata->>'detail_text') order by o.ord), '[]'::jsonb)
    from (select r.role, r.ord,
                 (select o2.display_name from sc.operators o2 where o2.role = r.role limit 1) as display_name
          from unnest(array['LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR'])
               with ordinality as r(role, ord)) o
    left join lateral (
      select a.action, a.at_ms, a.metadata from sc.action_log a
       where a.event_id = p_event_id and a.actor_role = o.role and a.actor_id <> 'system.clock'
       order by a.seq desc limit 1) l on true
$$;

-- ------------------------------------------------------------- realtime
-- Only the single-row state pointer is published: it carries the revision.
do $$
begin
  alter publication supabase_realtime add table sc.state;
exception
  when undefined_object then
    raise notice 'publication supabase_realtime not present; enable Realtime in the dashboard';
  when duplicate_table then
    raise notice 'sc.state is already in supabase_realtime';
end $$;

grant execute on all functions in schema sc to authenticated;
revoke execute on function sc.set_test_clock(text, bigint) from public;
