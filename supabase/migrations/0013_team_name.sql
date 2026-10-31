-- 0013: the optional team label is a real, revisioned command.
--
-- 0012 kept a SET_TEAM_NAME branch inside the authoritative body. This forward
-- wrapper makes the label contract explicit and identical on both backends:
-- CALL_TEAM labels are trimmed, collapsed and bounded before dispatch, and
-- SET_TEAM_NAME is the one command that corrects the team on the floor.
--
-- Before this migration the pencil in the app only opened a text box: a name
-- typed after a team had been called never reached Postgres, so the other phones
-- kept showing TEAM #003 with no label. A name typed before CALL_TEAM already
-- travelled inside that command's metadata, but nothing normalised or bounded it.
--
-- SET_TEAM_NAME takes the same advisory lock as every other command, checks the
-- same server-side permission table, rejects a stale revision, is idempotent per
-- key and appends one audit row. The 0012 dispatch body stays untouched: this
-- forward wrapper handles the label and delegates every other workflow to it.

select pg_advisory_xact_lock(30501);

insert into sc.role_permissions (action, role) values
  ('SET_TEAM_NAME', 'LOBBY'),
  ('SET_TEAM_NAME', 'SUPERVISOR')
on conflict do nothing;

-- Same rename-and-wrap pattern as 0004: the original implementation keeps its
-- behaviour and stays unreachable except through this wrapper.
alter function sc._handle_command_internal(text, jsonb, bigint, text)
  rename to _handle_command_internal_v1;

create function sc._handle_command_internal(
  p_action text,
  p_meta jsonb default '{}'::jsonb,
  p_expected_revision bigint default 0,
  p_idempotency_key text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_meta     jsonb := coalesce(p_meta, '{}'::jsonb);
  v_role     text := sc.my_role();
  v_name     text;
  v_now      bigint;
  v_state    sc.state;
  v_event    sc.events;
  v_round    sc.rounds;
  v_before   text;
  v_revision bigint;
begin
  -- Only labels pass through this wrapper. Every other action keeps its original
  -- implementation, permissions, revision check and idempotency behaviour.
  if p_action not in ('CALL_TEAM', 'SET_TEAM_NAME') then
    return sc._handle_command_internal_v1(p_action, p_meta, p_expected_revision, p_idempotency_key);
  end if;

  if v_role is null then
    return sc._result(false, 'PERMISSION_DENIED', 'TÀI KHOẢN CHƯA ĐƯỢC PHÂN QUYỀN VỊ TRÍ', 0, sc.now_ms());
  end if;
  if not exists (select 1 from sc.role_permissions where action = p_action and role = v_role) then
    return sc._result(false, 'PERMISSION_DENIED', v_role || ' KHÔNG ĐƯỢC PHÉP ' || p_action, 0, sc.now_ms());
  end if;

  -- A dispatch may omit the label; a correction must say what the label becomes,
  -- and an explicit empty string erases it. Spaces are collapsed exactly like the
  -- engine does, so both backends store the same name.
  if v_meta ? 'team_name' then
    if jsonb_typeof(v_meta->'team_name') <> 'string' then
      return sc._result(false, 'INVALID_STATE', 'Tên đội không hợp lệ', 0, sc.now_ms());
    end if;
    v_name := btrim(regexp_replace(v_meta->>'team_name', '\s+', ' ', 'g'));
    if length(v_name) > 40 then
      return sc._result(false, 'INVALID_STATE', 'Tên đội tối đa 40 ký tự', 0, sc.now_ms());
    end if;
    v_meta := jsonb_set(v_meta, '{team_name}', to_jsonb(v_name), true);
  elsif p_action = 'SET_TEAM_NAME' then
    return sc._result(false, 'INVALID_STATE', 'Thiếu tên đội', 0, sc.now_ms());
  end if;

  if p_action = 'CALL_TEAM' then
    return sc._handle_command_internal_v1(p_action, v_meta, p_expected_revision, p_idempotency_key);
  end if;

  select * into v_state from sc.state where id = true;
  select * into v_event from sc.events where id = v_state.event_id;
  v_now := sc.now_ms();

  -- Exactly the 0002 contract: a retried tap returns the original result and
  -- writes nothing, and a stale phone may never overwrite a newer state.
  if exists (select 1 from sc.action_log
             where actor_id = ((select auth.uid())::text) and action = p_action
               and idempotency_key = p_idempotency_key) then
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
  if v_round.id is null then
    return sc._result(false, 'INVALID_STATE', 'Không có lượt chơi đang hoạt động', v_event.revision, v_now);
  end if;

  v_before := v_round.team_name;
  if v_before is not distinct from nullif(v_name, '') then
    return sc._result(true, 'OK', 'Tên đội không thay đổi', v_event.revision, v_now);
  end if;

  update sc.rounds set team_name = nullif(v_name, '') where id = v_round.id returning * into v_round;

  v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_round.status,
                           p_idempotency_key,
                           jsonb_build_object('team_name', v_round.team_name,
                                              'previous_team_name', v_before),
                           case when v_round.team_name is null
                                then 'Đã xoá tên đội #' || lpad(v_round.team_number::text, 3, '0')
                                else 'Đặt tên đội #' || lpad(v_round.team_number::text, 3, '0') || ': ' || v_round.team_name end,
                           v_now);
  return sc._result(true, 'OK',
                    case when v_round.team_name is null then 'Đã xoá tên đội'
                         else 'Đã đặt tên đội: ' || v_round.team_name end,
                    v_revision, v_now);
end $$;

-- 0004 revoked every internal helper from the client roles; a newly created
-- function is executable by PUBLIC by default, so close that door again.
revoke all on function sc._handle_command_internal(text, jsonb, bigint, text)
  from public, anon, authenticated;
revoke all on function sc._handle_command_internal_v1(text, jsonb, bigint, text)
  from public, anon, authenticated;
