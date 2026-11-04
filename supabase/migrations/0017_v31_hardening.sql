-- =============================================================================
-- 0017 — V3.1 hardening: cancellation truth, crew codes, configurable countdown
-- =============================================================================
-- Scope of this migration, in the order the brief asks for it:
--
--   IV  P0  ABORT_ROUND stops inventing a physical departure, and a claim recorded
--           before the deadline keeps its right to be verified.
--   V   P1  V3.2: the four operating positions bind with no credential at all —
--           opening the link and tapping a free seat is the whole ritual. Only the
--           retained admin is gated: a device must appear in sc.admin_devices, and
--           that allow-list is readable and writable by the owner alone.
--   VI  P1  The board release is a supervisor action with a server-side role check
--           instead of a typed secret, reads one authoritative floor predicate, and
--           grows an emergency force path that cancels an open round before sweeping.
--   VII     The 90-minute session clock is retired from the operating surface; the
--           round duration becomes configurable and is snapshotted per round.
--   X   P2  Refusal messages name the real areas in Vietnamese instead of enum keys.
--
-- Forward-only and history-preserving: no table or column is dropped, no timestamp
-- of a started or closed round is rewritten, and every retired value stays readable.
-- Applied to a fresh database (0001→0017) and to a database already carrying V3
-- (0001→0016→0017) it must produce the same behaviour.

select pg_advisory_xact_lock(30501);

-- ---------------------------------------------------------------------------
-- 1. Round facts added by V3.1
-- ---------------------------------------------------------------------------
-- `round_duration_ms` is the duration the round was STARTed with. It is written
-- once, at START, and never again: from then on the round owns its own window even
-- if the supervisor changes the default five minutes later (§7.5).
alter table sc.rounds add column if not exists round_duration_ms bigint;
-- A cancellation now records WHY, and the reason decides whether an outstanding
-- claim can still become a win (§4.4).
alter table sc.rounds add column if not exists abort_kind text;
alter table sc.rounds add column if not exists abort_reason text;

-- Backfill only what the row already proves. A round that has both instants gets the
-- window it actually ran; nothing here invents a duration for a round that never
-- started, and no existing deadline is touched.
update sc.rounds
   set round_duration_ms = deadline_at - game_started_at
 where round_duration_ms is null
   and deadline_at is not null
   and game_started_at is not null
   and deadline_at > game_started_at;

-- Rounds that history already records as cancelled keep a non-disqualifying kind:
-- the old ABORT_ROUND said nothing about misconduct, so it must not retroactively
-- strip a team of a result it could still be judged for.
update sc.rounds
   set abort_kind = 'safety',
       abort_reason = coalesce(abort_reason, exit_reason)
 where aborted_at is not null and abort_kind is null;

alter table sc.rounds drop constraint if exists rounds_round_duration_ms_check;
alter table sc.rounds add constraint rounds_round_duration_ms_check
  check (round_duration_ms is null or (round_duration_ms between 1000 and 3599000));
alter table sc.rounds drop constraint if exists rounds_abort_kind_check;
alter table sc.rounds add constraint rounds_abort_kind_check
  check (abort_kind is null or abort_kind in ('technical','safety','misconduct'));
alter table sc.rounds drop constraint if exists rounds_abort_reason_length_check;
alter table sc.rounds add constraint rounds_abort_reason_length_check
  check (abort_reason is null or char_length(abort_reason) between 1 and 200);

-- ---------------------------------------------------------------------------
-- 2. Bounds for the configurable duration, stated once for every layer
-- ---------------------------------------------------------------------------
-- 00:01 … 59:59, whole seconds. The UI mirrors these limits, and the command handler
-- refuses anything else before a value can reach a round (T05, T06).
create or replace function sc._duration_ok(p_ms bigint) returns boolean
language sql immutable security definer set search_path = '' as $$
  select p_ms is not null and p_ms >= 1000 and p_ms <= 3599000 and p_ms % 1000 = 0
$$;

-- MM:SS for the messages an operator reads, so no refusal ever quotes a millisecond
-- count or an enum back at them (§10.2).
create or replace function sc._fmt_ms(p_ms bigint) returns text
language sql immutable security definer set search_path = '' as $$
  select lpad(floor(coalesce(p_ms, 0) / 60000)::int::text, 2, '0') || ':' ||
         lpad(floor((coalesce(p_ms, 0) % 60000) / 1000)::int::text, 2, '0')
$$;

-- The position's own name, never its database key, in operator-facing text.
create or replace function sc._role_short(p_role text) returns text
language sql immutable security definer set search_path = '' as $$
  select case p_role when 'LOBBY' then '01' when 'CORRIDOR' then '02'
                     when 'GATE' then 'NPC 1' when 'ROOM305' then 'NPC 2'
                     when 'SUPERVISOR' then 'Quản trị' when 'OBSERVER' then 'Người theo dõi'
                     else coalesce(p_role, '—') end
$$;

-- The three physical areas by their Vietnamese names, in one sentence.
create or replace function sc._task_names(p_keys text[]) returns text
language sql immutable security definer set search_path = '' as $$
  select string_agg(case k when 'hidden_objects' then 'Vật phẩm ẩn'
                           when 'hallway' then 'Hành lang tầng 3'
                           when 'room' then 'Phòng 305'
                           else k end, ', ' order by array_position(
             array['hallway','hidden_objects','room'], k))
    from unnest(coalesce(p_keys, array[]::text[])) k
$$;

-- The lifecycle status as the operator reads it, never the enum (§10.2). Anything
-- outside the authoritative flow falls back to the neutral "chưa rõ trạng thái" so a
-- historical row can never print its raw status key on the phone.
create or replace function sc._status_vn(p_status text) returns text
language sql immutable security definer set search_path = '' as $$
  select case p_status
    when 'WAITING_FLOOR2_CONFIRMATION' then 'Đã nhận đội · chờ xác nhận tầng 2'
    when 'READY_AT_FLOOR3'             then 'Đội sắp bắt đầu'
    when 'RUNNING'                     then 'Đồng hồ lượt chơi đang chạy'
    when 'TIME_EXPIRED_PENDING_VALIDATION' then 'Hết giờ · đang chờ xác minh mốc hợp lệ'
    when 'WAITING_FOR_EXIT'            then 'Chờ đội rời tầng 3'
    when 'EXIT_CONFIRMED'              then 'Đội đã rời tầng 3 · đang reset'
    when 'CLOSED'                      then 'Lượt chơi đã đóng'
    when 'ABORTED'                     then 'Đã hủy khẩn cấp'
    else 'chưa rõ trạng thái' end
$$;

-- The attempt decision in words, so no refusal ever quotes PENDING / VALID / INVALID /
-- LATE back at the operator.
create or replace function sc._attempt_status_vn(p_status text) returns text
language sql immutable security definer set search_path = '' as $$
  select case p_status
    when 'PENDING' then 'chờ kiểm tra'
    when 'VALID'   then 'chính xác'
    when 'INVALID' then 'chưa đúng'
    when 'LATE'    then 'đến muộn'
    else 'không rõ' end
$$;

-- The action name as the operator sees it. Used only where the raw enum would have
-- reached a refusal message; every stored log row still keeps its action type so the
-- audit stays machine-readable.
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
    when 'ABORT_ROUND'      then 'Hủy lượt chơi'
    when 'CORRECT_ROUND'    then 'Hiệu chỉnh mốc thời gian'
    else 'thao tác không rõ' end
$$;

-- The correctable field in Vietnamese, so the audit line never spells
-- `exit_confirmed_at` on the operator's screen.
create or replace function sc._field_vn(p_field text) returns text
language sql immutable security definer set search_path = '' as $$
  select case p_field
    when 'game_started_at'     then 'mốc bắt đầu lượt chơi'
    when 'deadline_at'         then 'mốc hết giờ'
    when 'exit_confirmed_at'   then 'mốc đội rời tầng 3'
    when 'floor2_confirmed_at' then 'mốc xác nhận tầng 2'
    else p_field end
$$;

revoke all on function sc._status_vn(text), sc._attempt_status_vn(text),
  sc._action_vn(text), sc._field_vn(text)
  from public, anon, authenticated;

create or replace function sc._round_limit_ms(v_round sc.rounds) returns bigint
language sql stable security definer set search_path = '' as $$
  -- The duration the round runs on: its own snapshot, then the window it stored,
  -- then the event default for rows that carry neither.
  select coalesce(
    v_round.round_duration_ms,
    case when v_round.deadline_at is not null and v_round.game_started_at is not null
              and v_round.deadline_at > v_round.game_started_at
         then v_round.deadline_at - v_round.game_started_at end,
    (select game_limit_ms from sc.events e where e.id = v_round.event_id),
    300000)
$$;

revoke all on function sc._duration_ok(bigint), sc._round_limit_ms(sc.rounds),
  sc._fmt_ms(bigint), sc._role_short(text), sc._task_names(text[])
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. V3.2 access model: open seats, one gated admin route
-- ---------------------------------------------------------------------------
-- The four operating positions and the viewer seat need no credential. Slot
-- exclusivity below is enforced by the advisory lock plus the seat_slot search, so
-- two phones can never hold the same position. The admin seat is the only thing
-- still gated: a device may bind it only when its uuid appears in sc.admin_devices.
-- Players never read or write that table; not even SELECT is granted beyond owner.
create table if not exists sc.admin_devices (
  user_id    uuid primary key,
  note       text,
  created_at timestamptz not null default now()
);
alter table sc.admin_devices enable row level security;
-- No policies at all: RLS with an empty policy set hides every row from every
-- non-owner role, and there is no grant to fall back on either. Reading the list
-- through the API is impossible by construction; the /admin bootstrap screen shows
-- the device its own uuid (from the auth token, not from this table) so the
-- organiser can paste it into the SQL editor once.
revoke all on sc.admin_devices from public, anon, authenticated;

-- The only path any client has to the allow-list: a boolean, never the rows.
create or replace function sc.is_admin_device(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and exists (select 1 from sc.admin_devices a where a.user_id = p_user_id)
$$;
revoke all on function sc.is_admin_device(uuid) from public, anon;
grant execute on function sc.is_admin_device(uuid) to authenticated;

-- V3.1 credentials are withdrawn: the crew-code table, the rate limiter that
-- guarded brute force, and every function that installed a secret. The audit trail
-- (sc.access_audit) stays — it is history, and history is never deleted.
drop function if exists public.claim_station(text, text);
drop function if exists sc.claim_station(text, text);
drop function if exists public.reset_all_stations(text);
drop function if exists sc.reset_all_stations(text);
drop function if exists sc.configure_station_code(text, text);
drop function if exists sc.station_code_state();
drop function if exists sc.configure_station_access(text, boolean);
drop function if exists public.configure_station_access(text, boolean);
drop function if exists sc.configure_station_reset(text);
drop function if exists public.configure_station_reset(text);
drop table if exists sc.station_codes;
drop table if exists sc.access_rate_limits;
-- The credential columns on the config row go too: nothing reads them any more,
-- and keeping them would invite a stale secret to be trusted by a future code path.
alter table sc.station_access_config drop column if exists supervisor_pin_hash;
alter table sc.station_access_config drop column if exists pin_version;
alter table sc.station_access_config drop column if exists reset_secret_hash;
alter table sc.station_access_config drop column if exists reset_version;

-- ---------------------------------------------------------------------------
-- 4. The 90-minute session business is retired from the permission surface
-- ---------------------------------------------------------------------------
-- These four actions existed only to serve the event-level deadline. They already
-- had no phase in which they could run, so removing the rows changes no reachable
-- behaviour; it only stops them being offered at all (§7.1). END_EVENT stays: manual,
-- reasoned, safety-gated closure is still a supervisor's job (§7.2).
delete from sc.role_permissions
 where action in ('OVERTIME_STARTED','OVERRIDE_ADMIT','EVENT_CLOSED','SESSION_RESTORE');

-- The historical columns keep their values for tracing, and nothing reads them as a
-- deadline any more: sc._derive and the shared machine both work from the round only.
-- ---- copied from 0016 (lines 332..410) then rewritten for V3.2 ----
-- One tap binds a seat. No code, no PIN: the advisory lock plus the seat_slot
-- search below is what makes “one device, one position” real, and a refresh of an
-- already-bound phone short-circuits before anything else is considered. The single
-- exception is SUPERVISOR: that seat belongs to the organiser allow-list.
create or replace function sc.claim_station(p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_bound sc.operators;
  v_capacity int;
  v_slot smallint;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if p_role is null or p_role not in ('LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR','OBSERVER') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ROLE');
  end if;
  perform pg_advisory_xact_lock(30501);
  select * into v_bound from sc.operators where user_id = v_uid and revoked_at is null;
  if v_bound.user_id is not null then
    if v_bound.role <> p_role then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_BOUND_OTHER_ROLE');
    end if;
    -- Same identity, same seat: a refresh never consumes another viewer slot.
    if p_role = 'OBSERVER' then
      insert into sc.observer_seats(user_id, viewer_id, seen_at)
      values (v_uid, null, now())
      on conflict (user_id) do update set seen_at = now();
    end if;
    return jsonb_build_object('ok', true, 'code', 'ALREADY_BOUND', 'role', v_bound.role);
  end if;
  -- The admin seat is the one position a stranger may not take, even by accident:
  -- the uuid has to have been placed on the allow-list by the owner first. Checked
  -- before the seat search so a refused attempt never consumes a supervisor slot.
  if p_role = 'SUPERVISOR' and not sc.is_admin_device(v_uid) then
    insert into sc.access_audit(user_id, role, action) values (v_uid, p_role, 'ADMIN_REFUSED');
    return jsonb_build_object('ok', false, 'code', 'ADMIN_NOT_ALLOWED');
  end if;
  v_capacity := case p_role when 'SUPERVISOR' then 2 when 'OBSERVER' then 10 else 1 end;
  -- A viewer must not be locked out by a stale seat, so abandoned seats go first.
  if p_role = 'OBSERVER' then
    perform sc._observer_sweep();
  end if;
  select min(s)::smallint into v_slot from generate_series(1, v_capacity) s
   where not exists (select 1 from sc.operators o
                     where o.role = p_role and o.seat_slot = s and o.revoked_at is null);
  if v_slot is null then
    return jsonb_build_object('ok', false,
      'code', case when p_role = 'OBSERVER' then 'OBSERVER_FULL' else 'ROLE_TAKEN' end,
      'capacity', v_capacity);
  end if;
  insert into sc.operators(user_id, role, display_name, revoked_at, bound_at, device_id, is_anonymous, seat_slot)
  values (v_uid, p_role, p_role, null, now(), v_uid::text, sc._is_anonymous_caller(), v_slot)
  on conflict(user_id) do update set role = excluded.role, display_name = excluded.display_name,
    revoked_at = null, bound_at = now(), device_id = excluded.device_id,
    is_anonymous = excluded.is_anonymous, seat_slot = excluded.seat_slot;
  insert into sc.access_audit(user_id, role, action) values(v_uid, p_role, 'CLAIMED');
  if p_role = 'OBSERVER' then
    insert into sc.observer_seats(user_id, viewer_id, seen_at)
    values (v_uid, null, now())
    on conflict (user_id) do update set seen_at = now();
  end if;
  -- Deliberately no _ensure_event(), tick(), state write or timer action.
  return jsonb_build_object('ok', true, 'code', 'CLAIMED', 'role', p_role, 'seat', v_slot);
end $$;

-- ---- copied from 0016 (lines 472..516) then edited for V3.1 ----
-- One predicate decides whether the floor is idle enough to release the board, and
-- both the public board and the release RPC read it, so the button the operator sees
-- and the answer PostgreSQL gives can never disagree (§6.2 item 11).
create or replace function sc._floor_block_reason() returns text
language sql stable security definer set search_path = '' as $$
  select case
    -- The floor is idle: every round of this event is closed.
    when not exists (select 1 from sc.rounds r join sc.state st on st.id
                      where r.event_id = st.event_id and r.status <> 'CLOSED') then null
    -- A team is on the clock, or is inside and has not been confirmed out. This also
    -- covers a cancelled round, because only NPC1 can say the players have left.
    when exists (select 1 from sc.rounds r join sc.state st on st.id
                  where r.event_id = st.event_id and r.status <> 'CLOSED'
                    and r.game_started_at is not null and r.exit_confirmed_at is null) then 'RUNNING'
    -- Somebody still has to judge a claim that was recorded in time: releasing the
    -- board would take the seat away from the person who owes that decision.
    when exists (select 1 from sc.rounds r join sc.state st on st.id
                       join sc.completion_attempts a on a.round_id = r.id
                  where r.event_id = st.event_id and r.status <> 'CLOSED'
                    and a.status = 'PENDING' and r.deadline_at is not null
                    and a.claimed_at < r.deadline_at) then 'PENDING_CLAIM'
    -- The team is out but the area is not put back and closed yet: the physical
    -- checks are still owed by floor-3 staff.
    else 'RESET_OPEN' end
$$;

revoke all on function sc._floor_block_reason() from public, anon, authenticated;

create or replace function sc.station_board() returns jsonb
language sql stable security definer set search_path = '' as $$
  with seats as (
    select r.role, r.ord, r.capacity,
           -- The viewer seat is counted from live presence, not from a binding row:
           -- a spectator holds a seat while it is watching, and the count is the same
           -- number the presence endpoints report.
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
    -- The round's window belongs to the round: from BẮT ĐẦU until the team is
    -- confirmed out. The board release is an access action and never runs over it.
    'game_running', exists (select 1 from sc.rounds r join sc.state st on st.id
      where r.event_id = st.event_id and r.status <> 'CLOSED'
        and r.game_started_at is not null and r.exit_confirmed_at is null),
    'reset_allowed', sc._floor_block_reason() is null,
    'reset_block_reason', sc._floor_block_reason(),
    'stations', jsonb_agg(jsonb_build_object('role', role, 'capacity', capacity_max,
      'devices', devices, 'occupied', devices >= capacity_max) order by ord))
  from seats;
$$;

-- ---- copied from 0016 (lines 523..576) then edited for V3.1 ----
create or replace function sc._derive(v_round sc.rounds, p_now bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit    bigint;
  v_deadline bigint;
  v_pending  int;
  v_live     text;
  v_result   text;
  v_validated boolean;
begin
  -- The duration this round runs on is the round's own, not the current default:
  -- a 07:00 round keeps 07:00 even after the supervisor sets 03:00 for the next team.
  v_limit := sc._round_limit_ms(v_round);
  if v_round.deadline_at is not null then
    v_deadline := v_round.deadline_at;
  elsif v_round.game_started_at is null then
    v_deadline := null;
  elsif v_round.game_stopped_at is not null then
    v_deadline := v_round.game_started_at + v_limit;
  else
    -- A row written before this release has no stored deadline: reconstruct the time
    -- it actually had left from the retired flexible-window fields, without granting
    -- or taking away a millisecond.
    v_deadline := p_now + greatest(0, v_limit - v_round.game_elapsed_ms
      - case when v_round.game_anchor_ms is null then 0
             else greatest(0, p_now - v_round.game_anchor_ms) end);
  end if;

  v_live := v_round.status;
  if v_live = 'RUNNING' and v_deadline is not null and p_now >= v_deadline then
    select count(*) into v_pending from sc.completion_attempts a
     where a.round_id = v_round.id and a.status = 'PENDING' and a.claimed_at < v_deadline;
    v_live := case when v_pending > 0 then 'TIME_EXPIRED_PENDING_VALIDATION' else 'WAITING_FOR_EXIT' end;
  end if;

  v_validated := v_round.validated_attempt_id is not null
    or exists (select 1 from sc.completion_attempts a
                where a.round_id = v_round.id and a.status = 'VALID');

  if v_round.aborted_at is not null then
    if v_round.abort_kind = 'misconduct' then
      -- A disqualification is not undone by a claim that happens to exist: only a
      -- supervisor's named REVIEW_RESOLVE can put the result back (§4.4).
      v_result := case when v_validated and v_round.review_resolved_at is not null
                         and not v_round.decertified then 'WON' else 'ABORTED' end;
    else
      -- A technical or safety cancellation stops the clock, but the players' claim
      -- keeps its right to be judged and to win on its own recorded instant.
      v_result := case when v_validated then 'WON' else 'ABORTED' end;
    end if;
  elsif v_validated then
    v_result := 'WON';
  elsif v_round.result in ('WON','ABORTED','TIME_UP') then
    v_result := v_round.result;
  elsif v_round.game_started_at is null then
    v_result := 'IN_PROGRESS';
  elsif v_deadline is null or p_now < v_deadline then
    v_result := 'IN_PROGRESS';
  else
    select count(*) into v_pending from sc.completion_attempts a
     where a.round_id = v_round.id and a.status = 'PENDING' and a.claimed_at < v_deadline;
    v_result := case when v_pending > 0 then 'PENDING_VALIDATION' else 'TIME_UP' end;
  end if;

  return jsonb_build_object('live', v_live, 'result', v_result,
                            'deadline', v_deadline, 'limit', v_limit);
end $$;

-- ---- copied from 0016 (lines 581..608) then edited for V3.1 ----
create or replace function sc._phase_allows(p_action text, p_live text, p_result text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_action
    -- No round in play is the only legal moment to receive a team.
    when 'CALL_TEAM'      then p_live is null
    when 'CONFIRM_FLOOR2' then p_live = 'WAITING_FLOOR2_CONFIRMATION'
    when 'FLOOR2_BYPASS'  then p_live = 'WAITING_FLOOR2_CONFIRMATION'
    when 'START_GAME'     then p_live = 'READY_AT_FLOOR3'
    -- A late claim is still recordable as information; it just cannot win.
    when 'CLAIM_COMPLETE' then p_live in ('RUNNING','TIME_EXPIRED_PENDING_VALIDATION','WAITING_FOR_EXIT')
    -- A decision may still land after the clock, after the team has left, and after a
    -- non-disqualifying cancellation — but never as a new claim (§4.4).
    when 'VERIFY_ATTEMPT' then p_live in ('RUNNING','TIME_EXPIRED_PENDING_VALIDATION','WAITING_FOR_EXIT','EXIT_CONFIRMED')
    when 'CONFIRM_EXIT'   then p_live in ('WAITING_FOR_EXIT','TIME_EXPIRED_PENDING_VALIDATION')
    when 'EARLY_EXIT'     then p_live in ('RUNNING','TIME_EXPIRED_PENDING_VALIDATION','WAITING_FOR_EXIT')
    when 'RESET_DONE'     then p_live = 'EXIT_CONFIRMED'
    when 'GATE_FINALIZE'  then p_live = 'EXIT_CONFIRMED'
    -- Props are prepared between teams or during the reset, never on the clock.
    when 'SET_LAYOUT'     then p_live in (null,'WAITING_FLOOR2_CONFIRMATION','READY_AT_FLOOR3','EXIT_CONFIRMED')
    -- Session data is frozen while the countdown runs.
    when 'SET_TEAM_NAME'  then p_live in ('WAITING_FLOOR2_CONFIRMATION','READY_AT_FLOOR3')
    when 'ABORT_ROUND'    then p_live in ('WAITING_FLOOR2_CONFIRMATION','READY_AT_FLOOR3','RUNNING','TIME_EXPIRED_PENDING_VALIDATION')
    -- Admin recovery, disputes and closure work on any round, always reasoned.
    when 'REOPEN_RESET' then true when 'REVIEW_RESOLVE' then true
    when 'END_EVENT' then true when 'CORRECT_ROUND' then true when 'CONFIGURE' then true
    else false end
    -- A settled win is immutable. A cancellation is not: it stops the clock, and it
    -- still owes the players a judgement on any claim recorded before the deadline,
    -- unless that cancellation was a disqualification (checked in the handler, which
    -- is the only place that can see the kind) (§4.4).
    and not (p_result = 'WON' and p_action in ('VERIFY_ATTEMPT','CLAIM_COMPLETE'))
    and not (p_action = 'CLAIM_COMPLETE' and p_result = 'ABORTED');
$$;

-- ---- copied from 0016 (lines 611..1204) then edited for V3.1 ----
create or replace function sc._handle_command_internal(
  p_action text,
  p_meta jsonb default '{}'::jsonb,
  p_expected_revision bigint default 0,
  p_idempotency_key text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role     text;
  v_uid      uuid := (select auth.uid());
  v_now      bigint;
  v_press    bigint;
  v_delay    bigint;
  v_event    sc.events;
  v_round    sc.rounds;
  v_state    sc.state;
  v_der      jsonb;
  v_live     text;
  v_result   text;
  v_deadline bigint;
  v_limit    bigint;
  v_name     text;
  v_seq      int;
  v_attempt  sc.completion_attempts;
  v_missing  int;
  v_done     int;
  v_official bigint;
  v_message  text;
  v_first    boolean;
  v_revision bigint;
begin
  select role into v_role from sc.operators where user_id = v_uid and revoked_at is null;
  if v_role is null then
    return sc._result(false, 'PERMISSION_DENIED', 'TÀI KHOẢN CHƯA ĐƯỢC PHÂN QUYỀN VỊ TRÍ', 0, sc.now_ms());
  end if;
  -- A viewer has no operational authority at all, whatever it sends.
  if v_role = 'OBSERVER' then
    return sc._result(false, 'READ_ONLY', 'NGƯỜI THEO DÕI CHỈ XEM ĐƯỢC', 0, sc.now_ms());
  end if;

  -- one shared game state: serialise writers instead of letting two phones race
  perform pg_advisory_xact_lock(30500);

  if not exists (select 1 from sc.role_permissions where action = p_action and role = v_role) then
    return sc._result(false, 'PERMISSION_DENIED',
      sc._role_short(v_role) || ' không được phép: ' || sc._action_vn(p_action), 0, sc.now_ms());
  end if;

  select * into v_state from sc.state where id = true;
  select * into v_event from sc.events where id = v_state.event_id;
  v_now := sc.now_ms();

  -- idempotency: a retried tap returns the original result and writes nothing
  if exists (select 1 from sc.action_log
             where actor_id = v_uid::text and action = p_action and idempotency_key = p_idempotency_key) then
    return sc._result(true, 'OK', 'ĐÃ GHI NHẬN TRƯỚC ĐÓ', v_event.revision, v_now);
  end if;

  -- A phone that is merely behind is told so before any state question, so its
  -- client resynchronises instead of reporting a refused transition.
  if p_expected_revision <> v_event.revision then
    return sc._result(false, 'STALE_REVISION',
                      'Trạng thái đã thay đổi (bản ' || v_event.revision || '). Đang đồng bộ lại…',
                      v_event.revision, v_now);
  end if;

  select * into v_round from sc.rounds
   where event_id = v_event.id and status <> 'CLOSED'
   order by round_number desc limit 1;
  v_der := sc._derive(v_round, v_now);
  v_live := nullif(v_der->>'live', 'null');
  v_result := v_der->>'result';
  v_deadline := nullif(v_der->>'deadline', 'null')::bigint;
  v_limit := (v_der->>'limit')::bigint;
  if v_round.id is null and v_live is null and p_action not in ('CALL_TEAM', 'CONFIGURE', 'END_EVENT', 'REVIEW_RESOLVE', 'CORRECT_ROUND', 'REOPEN_RESET') then
    return sc._result(false, 'INVALID_STATE', 'Không có lượt chơi đang hoạt động', v_event.revision, v_now);
  end if;
  if not sc._phase_allows(p_action, v_live, v_result) then
    return sc._result(false, 'INVALID_STATE',
      'Giai đoạn hiện tại không nhận thao tác này ('
        || case when v_live is null then 'chưa có đội' else sc._status_vn(v_live) end || ')',
      v_event.revision, v_now);
  end if;

  if p_action = 'CONFIGURE' then
    -- V3.1 §7.4: the round duration is a supervisor configuration that may change at
    -- any moment, including while a team is on the clock. It only ever applies to the
    -- NEXT round, because a started round carries its own snapshot, so no live clock
    -- can be moved by this call. The event's own history fields stay locked.
    if v_event.event_started_at is not null and
       (p_meta ? 'start_team_number' or p_meta ? 'event_name') then
      return sc._result(false, 'INVALID_STATE', 'Không đổi được dữ liệu sự kiện sau khi ca đã chạy', v_event.revision, v_now);
    end if;
    -- The session length is retired: it is no longer editable at all, so nothing can
    -- bring a 90-minute deadline back into the operating surface (§7.1, §9.1).
    if p_meta ? 'event_duration_ms' then
      return sc._result(false, 'INVALID_STATE',
        'Sự kiện không còn thời lượng phiên để cấu hình', v_event.revision, v_now);
    end if;
    if p_meta ? 'game_limit_ms' and not sc._duration_ok((p_meta->>'game_limit_ms')::bigint) then
      return sc._result(false, 'INVALID_STATE',
        'Thời lượng lượt chơi hợp lệ từ 00:01 đến 59:59, tính theo giây', v_event.revision, v_now);
    end if;
    if p_meta ? 'hidden_object_owner' and p_meta->>'hidden_object_owner' not in ('GATE','ROOM305') then
      return sc._result(false, 'INVALID_STATE', 'Chủ vật ẩn phải là NPC 1 hoặc NPC 2', v_event.revision, v_now);
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
    v_revision := sc._commit(v_event, p_action, null, 'NONE', null, p_idempotency_key, p_meta,
      case when p_meta ? 'game_limit_ms'
           then 'Đã đặt thời lượng lượt chơi mặc định ' || sc._fmt_ms((p_meta->>'game_limit_ms')::bigint)
           else 'Đã cập nhật cấu hình sự kiện' end, v_now);
    return sc._result(true, 'OK',
      case when p_meta ? 'game_limit_ms' and v_round.game_started_at is not null
           then 'ĐÃ LƯU · ' || sc._fmt_ms((p_meta->>'game_limit_ms')::bigint) || ' · Áp dụng từ lượt tiếp theo'
           when p_meta ? 'game_limit_ms'
           then 'ĐÃ LƯU · ' || sc._fmt_ms((p_meta->>'game_limit_ms')::bigint)
           else 'Đã lưu cấu hình' end, v_revision, v_now);

  elsif p_action = 'CALL_TEAM' then
    if v_event.event_ended_at is not null then
      return sc._result(false, 'INVALID_STATE', 'SỰ KIỆN ĐÃ KẾT THÚC', v_event.revision, v_now);
    end if;
    if v_round.id is not null then
      return sc._result(false, 'INVALID_STATE',
        'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' vẫn chưa hoàn tất', v_event.revision, v_now);
    end if;
    -- Record the first reception for event history; it has no timer effect.
    v_first := v_event.event_started_at is null;
    if v_first then
      update sc.events set event_started_at = v_now where id = v_event.id returning * into v_event;
    end if;
    v_name := nullif(regexp_replace(btrim(coalesce(p_meta->>'team_name', '')), '[[:space:]]+', ' ', 'g'), '');
    if v_name is not null and length(v_name) > 40 then
      return sc._result(false, 'INVALID_STATE', 'Tên đội tối đa 40 ký tự', v_event.revision, v_now);
    end if;
    insert into sc.rounds (event_id, round_number, team_number, team_name, status, stage, called_at,
                           received_by_role, received_by, created_revision, result, admission_override, hiding_layout)
    values (v_event.id,
            (select count(*) from sc.rounds where event_id = v_event.id) + 1,
            v_event.next_team_number, v_name,
            'WAITING_FLOOR2_CONFIRMATION', 1, v_now,
            v_role, v_uid, v_event.revision + 1, 'IN_PROGRESS',
            coalesce((p_meta->>'override')::boolean, false) and coalesce(p_meta->>'reason','') <> '',
            v_event.hiding_layout)
    returning * into v_round;
    update sc.events set next_team_number = next_team_number + 1 where id = v_event.id returning * into v_event;
    insert into sc.reset_tasks (round_id, task_key, required_role) values
      (v_round.id, 'hidden_objects', v_event.hidden_object_owner),
      (v_round.id, 'hallway', 'GATE'),
      (v_round.id, 'room', 'ROOM305');
    v_revision := sc._commit(v_event, p_action, v_round, 'NONE', 'WAITING_FLOOR2_CONFIRMATION', p_idempotency_key,
                             jsonb_build_object('team_name', v_round.team_name,
                                                'override', case when coalesce((p_meta->>'override')::boolean, false) then true else null end,
                                                'event_clock_started', case when v_first then true else null end),
                             'Đã nhận đội #' || lpad(v_round.team_number::text, 3, '0') || ' và cho lên tầng 2', v_now);
    return sc._result(true, 'OK', 'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' đã được cho lên tầng 2', v_revision, v_now);

  elsif p_action = 'CONFIRM_FLOOR2' then
    if v_round.floor2_confirmed_at is not null then
      return sc._result(true, 'OK', 'Đã xác nhận tầng 2 trước đó', v_event.revision, v_now);
    end if;
    -- A stale tap after NPC1 bypassed floor 2 is refused safely: the workflow does
    -- not revert and no fabricated confirmation is written.
    if v_round.floor2_bypassed_at is not null then
      return sc._result(false, 'INVALID_STATE',
                        'NPC 1 đã bỏ qua xác nhận tầng 2 — thao tác này không còn hiệu lực',
                        v_event.revision, v_now);
    end if;
    update sc.rounds set status = 'READY_AT_FLOOR3', stage = greatest(stage, 2),
           floor2_confirmed_at = v_now, floor2_confirmed_by_role = v_role, floor2_confirmed_by = v_uid
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, 'WAITING_FLOOR2_CONFIRMATION', 'READY_AT_FLOOR3',
                             p_idempotency_key, jsonb_build_object('operator', v_role),
                             'Đã nhận đội đến tầng 2 — đang được hướng dẫn lên tầng 3', v_now);
    return sc._result(true, 'OK', 'Đội sắp bắt đầu — NPC 1 có thể bấm BẮT ĐẦU', v_revision, v_now);

  elsif p_action = 'FLOOR2_BYPASS' then
    if coalesce(p_meta->>'reason', '') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do bỏ qua tầng 2', v_event.revision, v_now);
    end if;
    if v_round.floor2_confirmed_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Tầng 2 đã được xác nhận — không cần bỏ qua', v_event.revision, v_now);
    end if;
    if v_round.game_started_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Trận đã bắt đầu', v_event.revision, v_now);
    end if;
    update sc.rounds set status = 'READY_AT_FLOOR3', stage = greatest(stage, 2),
           floor2_bypassed_at = v_now, floor2_bypassed_by_role = v_role,
           floor2_bypassed_by = v_uid, floor2_bypass_reason = p_meta->>'reason'
     where id = v_round.id returning * into v_round;
    perform sc._review(v_round.id, 'FLOOR2_BYPASS');
    v_revision := sc._commit(v_event, p_action, v_round, 'WAITING_FLOOR2_CONFIRMATION', 'READY_AT_FLOOR3',
                             p_idempotency_key,
                             jsonb_build_object('bypassed_by', v_role, 'reason', p_meta->>'reason',
                                                'floor2_confirmed', false),
                             'Bỏ qua xác nhận tầng 2 cho đội #' || lpad(v_round.team_number::text, 3, '0'), v_now);
    return sc._result(true, 'OK', 'ĐÃ BỎ QUA TẦNG 2 — đội sẵn sàng ở tầng 3', v_revision, v_now);

  elsif p_action = 'START_GAME' then
    if v_round.floor2_confirmed_at is null and v_round.floor2_bypassed_at is null then
      return sc._result(false, 'INVALID_STATE', 'Chưa xác nhận đội ở tầng 3', v_event.revision, v_now);
    end if;
    if v_round.game_started_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Đồng hồ trận đã chạy', v_event.revision, v_now);
    end if;
    update sc.rounds set status = 'RUNNING', stage = greatest(stage, 3),
           game_started_at = v_now, deadline_at = v_now + v_limit,
           round_duration_ms = v_limit,
           started_by_role = v_role, started_by = v_uid
     where id = v_round.id returning * into v_round;
    -- Transport diagnostics only: the authoritative instant stays the server value.
    v_press := nullif(p_meta#>>'{_press,press_ms}', '')::bigint;
    if v_press is not null then
      v_delay := greatest(0, v_now - v_press);
      update sc.rounds set start_press_ms = v_press, start_transport_ms = v_delay
       where id = v_round.id returning * into v_round;
      if v_delay > v_event.review_threshold_ms then
        perform sc._review(v_round.id, 'START_TRANSPORT');
      end if;
    end if;
    v_revision := sc._commit(v_event, p_action, v_round, 'READY_AT_FLOOR3', 'RUNNING', p_idempotency_key,
                             jsonb_build_object('prep_ms', v_now - v_round.called_at,
                                                'deadline_at', v_round.deadline_at,
                                                'round_duration_ms', v_limit,
                                                'start_transport_ms', v_delay),
                             'Bắt đầu ' || sc._fmt_ms(v_limit) || ' cho đội #'
                               || lpad(v_round.team_number::text, 3, '0'), v_now);
    return sc._result(true, 'OK', 'ĐÃ BẮT ĐẦU ' || sc._fmt_ms(v_limit) || ' — màn hình đã khoá', v_revision, v_now);

  elsif p_action = 'CLAIM_COMPLETE' then
    if v_deadline is null then
      return sc._result(false, 'INVALID_STATE', 'Trận chưa bắt đầu', v_event.revision, v_now);
    end if;
    select coalesce(max(seq), 0) + 1 into v_seq from sc.completion_attempts where round_id = v_round.id;
    v_press := nullif(p_meta#>>'{_press,press_ms}', '')::bigint;
    v_delay := case when v_press is null then null else greatest(0, v_now - v_press) end;
    insert into sc.completion_attempts (round_id, event_id, seq, claimed_at, elapsed_ms, remaining_ms,
                                        in_time, status, claimed_by_role, claimed_by,
                                        claim_press_ms, claim_transport_ms, revision)
    values (v_round.id, v_event.id, v_seq, v_now,
            greatest(0, v_now - coalesce(v_round.game_started_at, v_now)), v_deadline - v_now,
            v_now < v_deadline,
            case when v_now < v_deadline then 'PENDING' else 'LATE' end,
            v_role, v_uid, v_press, v_delay, v_event.revision + 1)
    returning * into v_attempt;
    -- The countdown deliberately keeps running: a claim may be wrong and nobody knows
    -- that yet, so only the claim instant is recorded here.
    if v_attempt.status = 'LATE' then
      perform sc._review(v_round.id, 'LATE_CLAIM');
    elsif coalesce(v_delay, 0) > v_event.review_threshold_ms then
      perform sc._review(v_round.id, 'CLAIM_TRANSPORT');
    end if;
    v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_live, p_idempotency_key,
                             jsonb_build_object('attempt_id', v_attempt.id, 'claimed_at', v_now,
                                                'elapsed_ms', v_attempt.elapsed_ms,
                                                'remaining_ms', v_attempt.remaining_ms,
                                                'in_time', v_attempt.in_time,
                                                'press_transport_ms', v_delay),
                             'Lần ' || v_seq || ' — ghi nhận báo hoàn thành lúc '
                               || lpad((v_attempt.elapsed_ms / 60000)::text, 2, '0') || ':'
                               || lpad(((v_attempt.elapsed_ms % 60000) / 1000)::text, 2, '0'), v_now);
    return sc._result(true, 'OK',
      case when v_attempt.in_time
           then 'LẦN ' || v_seq || ' — ĐANG KIỂM TRA, đồng hồ vẫn chạy'
           else 'LẦN ' || v_seq || ' — GHI NHẬN SAU HẾT GIỜ (không thành thắng)' end,
      v_revision, v_now);

  elsif p_action = 'VERIFY_ATTEMPT' then
    select * into v_attempt from sc.completion_attempts
     where id = nullif(p_meta->>'attempt_id', '')::bigint and round_id = v_round.id;
    if not found then
      return sc._result(false, 'INVALID_STATE', 'Không tìm thấy lần báo hoàn thành', v_event.revision, v_now);
    end if;
    if v_attempt.status not in ('PENDING', 'LATE') then
      return sc._result(true, 'OK',
                        'Lần ' || v_attempt.seq || ' đã được chốt: ' || sc._attempt_status_vn(v_attempt.status),
                        v_event.revision, v_now);
    end if;
    if p_meta->>'decision' = 'INVALID' then
      -- Only this attempt closes: the timestamp, the countdown and the history stay.
      update sc.completion_attempts
         set status = 'INVALID', verified_by_role = v_role, verified_by = v_uid,
             verified_at = v_now, decision_note = nullif(p_meta->>'note', ''), revision = v_event.revision + 1
       where id = v_attempt.id;
      v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_live, p_idempotency_key,
                               jsonb_build_object('attempt_id', v_attempt.id, 'claimed_at', v_attempt.claimed_at,
                                                  'decision', 'INVALID'),
                               'Lần ' || v_attempt.seq || ' — CHƯA ĐÚNG, đội tiếp tục chơi', v_now);
      return sc._result(true, 'OK',
        'LẦN ' || v_attempt.seq || ' CHƯA ĐÚNG — đồng hồ vẫn chạy', v_revision, v_now);
    end if;
    if coalesce(p_meta->>'decision', '') <> 'VALID' then
      return sc._result(false, 'INVALID_STATE', 'Quyết định không hợp lệ', v_event.revision, v_now);
    end if;
    -- A disqualification is a supervisor decision, never an NPC2 verification: the
    -- claim keeps its row and its timestamp, and only a named REVIEW_RESOLVE can put
    -- the result back afterwards (§4.4).
    if v_round.aborted_at is not null and v_round.abort_kind = 'misconduct'
       and not (v_round.review_resolved_at is not null and not v_round.decertified) then
      return sc._result(false, 'INVALID_STATE',
        'Lượt chơi đã bị hủy vì kỷ luật — Quản trị viên phải xét lại kết quả',
        v_event.revision, v_now);
    end if;
    -- The eligibility boundary, stated once: a claim at or after the deadline cannot
    -- create a winning result, however correct the arrangement turns out to be.
    if not v_attempt.in_time then
      return sc._result(false, 'INVALID_STATE',
        'Lần ' || v_attempt.seq || ' được ghi nhận sau hết giờ — không thể thành kết quả thắng',
        v_event.revision, v_now);
    end if;
    -- Atomic finalization: the official time is the claim's own instant.
    v_official := greatest(0, v_attempt.claimed_at - coalesce(v_round.game_started_at, v_attempt.claimed_at));
    update sc.completion_attempts
       set status = 'VALID', verified_by_role = v_role, verified_by = v_uid,
           verified_at = v_now, decision_note = nullif(p_meta->>'note', ''), revision = v_event.revision + 1
     where id = v_attempt.id;
    update sc.rounds
       set status = case when exit_confirmed_at is null then 'WAITING_FOR_EXIT' else status end,
           stage = greatest(stage, case when exit_confirmed_at is null then 4 else 5 end),
           result = 'WON',
           official_duration_ms = v_official,
           validated_attempt_id = v_attempt.id,
           puzzle_completed_at = v_attempt.claimed_at
     where id = v_round.id returning * into v_round;
    if abs(v_limit - v_official) <= v_event.review_threshold_ms then
      perform sc._review(v_round.id, 'CLOSE_FINISH');
    end if;
    v_revision := sc._commit(v_event, p_action, v_round, v_live, v_round.status, p_idempotency_key,
                             jsonb_build_object('attempt_id', v_attempt.id, 'decision', 'VALID',
                                                'claimed_at', v_attempt.claimed_at,
                                                'official_duration_ms', v_official,
                                                'verified_at', v_now,
                                                'verification_delay_ms', v_now - v_attempt.claimed_at),
                             'Lần ' || v_attempt.seq || ' — CHÍNH XÁC. Kết quả chính thức '
                               || sc._fmt_ms(v_official), v_now);
    return sc._result(true, 'OK', 'THÀNH CÔNG — chờ đội rời tầng 3', v_revision, v_now);

  elsif p_action = 'CONFIRM_EXIT' then
    if v_round.exit_confirmed_at is not null then
      return sc._result(true, 'OK', 'Đã xác nhận đội rời tầng 3', v_event.revision, v_now);
    end if;
    -- The team is never detained by the software: an unresolved claim stays open and
    -- the departure is still recorded, with the result settled on the row here.
    update sc.rounds set status = 'EXIT_CONFIRMED', stage = greatest(stage, 5),
           exit_confirmed_at = v_now, exit_by_role = v_role, exit_by = v_uid,
           result = coalesce(v_result, 'IN_PROGRESS')
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_live, 'EXIT_CONFIRMED', p_idempotency_key,
                             jsonb_build_object('exited_at', v_now, 'result', v_round.result,
                                                'official_duration_ms', v_round.official_duration_ms,
                                                'pending_validation',
                                                  exists (select 1 from sc.completion_attempts a
                                                           where a.round_id = v_round.id and a.status = 'PENDING'
                                                             and a.claimed_at < coalesce(v_deadline, 0))),
                             'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' đã rời tầng 3', v_now);
    return sc._result(true, 'OK',
      case when exists (select 1 from sc.completion_attempts a
                         where a.round_id = v_round.id and a.status = 'PENDING'
                           and a.claimed_at < coalesce(v_deadline, 0))
           then 'ĐÃ GHI NHẬN RỜI KHU VỰC · KẾT QUẢ VẪN CHỜ NPC 2 XÁC MINH'
           else 'ĐÃ GHI NHẬN RỜI KHU VỰC — khu vực cần reset' end, v_revision, v_now);

  elsif p_action = 'EARLY_EXIT' then
    if coalesce(p_meta->>'reason', '') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do kết thúc sớm', v_event.revision, v_now);
    end if;
    if v_result = 'WON' then
      return sc._result(false, 'INVALID_STATE',
                        'Kết quả đã chốt THÀNH CÔNG — dùng XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3',
                        v_event.revision, v_now);
    end if;
    -- A round that has already been cancelled by the supervisor is not cancelled
    -- twice: NPC1 only confirms the departure with XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3.
    if v_round.aborted_at is not null then
      return sc._result(false, 'INVALID_STATE',
                        'Lượt chơi đã bị hủy — NPC 1 dùng XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3',
                        v_event.revision, v_now);
    end if;
    -- A guarded exception at the gate. NPC1 stands at the door, so this press IS the
    -- confirmation that the players are out, and no second press is asked for. It
    -- never fabricates a successful completion time, and it is recorded as a safety
    -- cancellation so a claim already recorded before the deadline keeps its right to
    -- be judged (§4.3, §4.4).
    update sc.rounds
       set status = 'EXIT_CONFIRMED', stage = greatest(stage, 5),
           game_stopped_at = coalesce(game_stopped_at, case when game_started_at is null then null else v_now end),
           official_duration_ms = case when game_started_at is null then official_duration_ms else null end,
           exit_confirmed_at = coalesce(exit_confirmed_at, v_now),
           exit_by_role = v_role, exit_by = v_uid, exit_reason = p_meta->>'reason',
           aborted_at = v_now, abort_kind = 'safety',
           result = case when v_result = 'WON' then 'WON' else 'ABORTED' end,
           outcome = case when v_result = 'WON' then 'WON' else 'ABORTED' end
     where id = v_round.id returning * into v_round;
    perform sc._review(v_round.id, 'ROUND_ABORTED');
    v_revision := sc._commit(v_event, p_action, v_round, v_live, 'EXIT_CONFIRMED', p_idempotency_key,
                             jsonb_build_object('reason', p_meta->>'reason', 'kind', 'safety',
                                                'result', v_round.result,
                                                'elapsed_ms', case when v_round.game_started_at is null then null
                                                                  else v_now - v_round.game_started_at end),
                             'KẾT THÚC SỚM đội #' || lpad(v_round.team_number::text, 3, '0') || ' · An toàn · y tế', v_now);
    return sc._result(true, 'OK',
      case when v_round.result = 'WON'
           then 'ĐÃ RỜI KHU VỰC · KẾT QUẢ CHÍNH THỨC ' || sc._fmt_ms(v_round.official_duration_ms)
           else 'LƯỢT CHƠI ĐÃ HỦY — không có kết quả thắng' end, v_revision, v_now);

  elsif p_action = 'RESET_DONE' then
    update sc.reset_tasks
       set completed_at = v_now, confirmed_by_role = v_role, confirmed_by = v_uid,
           cycle = v_round.reset_cycle,
           layout = case when task_key = 'hidden_objects' then v_event.hiding_layout else layout end,
           revision = v_event.revision + 1
     where round_id = v_round.id
       and (completed_at is null or cycle <> v_round.reset_cycle)
       and required_role = v_role;
    get diagnostics v_done = row_count;
    if v_done = 0 then
      return sc._result(true, 'OK', 'Không có tác vụ nào chờ xác nhận', v_event.revision, v_now);
    end if;
    v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_round.status, p_idempotency_key,
                             jsonb_build_object('tasks', (select jsonb_agg(task_key) from sc.reset_tasks
                                                           where round_id = v_round.id and completed_at = v_now),
                                                'cycle', v_round.reset_cycle,
                                                'layout', v_event.hiding_layout,
                                                'since_exit_ms', case when v_round.exit_confirmed_at is null then null
                                                                     else v_now - v_round.exit_confirmed_at end),
                             sc._role_short(v_role) || ' xác nhận xong: '
                               || sc._task_names(array(
                                    select task_key from sc.reset_tasks
                                     where round_id = v_round.id and completed_at = v_now)), v_now);
    return sc._result(true, 'OK', 'Đã ghi nhận reset', v_revision, v_now);

  elsif p_action = 'GATE_FINALIZE' then
    if v_round.exit_confirmed_at is null then
      return sc._result(false, 'BLOCKED', 'NPC 1 chưa xác nhận đội rời tầng 3', v_event.revision, v_now);
    end if;
    if v_result in ('IN_PROGRESS', 'PENDING_VALIDATION') then
      return sc._result(false, 'BLOCKED',
                        'Kết quả trận chưa chốt — NPC 2 cần xác minh lần báo hoàn thành', v_event.revision, v_now);
    end if;
    select count(*) into v_missing from sc.reset_tasks
     where round_id = v_round.id and (completed_at is null or cycle <> v_round.reset_cycle);
    if v_missing > 0 then
      return sc._result(false, 'BLOCKED',
        'Chưa thể sẵn sàng: '
          || sc._task_names(array(select task_key from sc.reset_tasks
                                   where round_id = v_round.id
                                     and (completed_at is null or cycle <> v_round.reset_cycle)))
          || ' chưa được xác nhận.', v_event.revision, v_now);
    end if;
    update sc.rounds set status = 'CLOSED', stage = 6, result = v_result,
           gate_finalized_at = v_now, finalized_by_role = v_role, system_ready_at = v_now
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, 'EXIT_CONFIRMED', 'CLOSED', p_idempotency_key,
                             jsonb_build_object('total_reset_ms', v_now - v_round.exit_confirmed_at,
                                                'result', v_round.result,
                                                'official_duration_ms', v_round.official_duration_ms,
                                                'cycle', v_round.reset_cycle),
                             'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' đã đóng · SẴN SÀNG nhận đội tiếp theo', v_now);
    return sc._result(true, 'OK', 'SẴN SÀNG nhận đội tiếp theo', v_revision, v_now);

  elsif p_action = 'SET_LAYOUT' then
    if coalesce(p_meta->>'layout', '') not in ('A','B','C') then
      return sc._result(false, 'INVALID_STATE', 'Bố trí không hợp lệ (A/B/C)', v_event.revision, v_now);
    end if;
    if v_role <> 'SUPERVISOR' and v_role <> v_event.hidden_object_owner then
      return sc._result(false, 'PERMISSION_DENIED',
                        'Chỉ ' || sc._role_short(v_event.hidden_object_owner) || ' mới bố trí vật ẩn', v_event.revision, v_now);
    end if;
    update sc.events set hiding_layout = p_meta->>'layout' where id = v_event.id returning * into v_event;
    v_revision := sc._commit(v_event, p_action, v_round, v_live, null, p_idempotency_key,
                             jsonb_build_object('to', v_event.hiding_layout),
                             'Bố trí vật ẩn: ' || v_event.hiding_layout, v_now);
    return sc._result(true, 'OK', 'Đã chuẩn bị bố trí ' || v_event.hiding_layout, v_revision, v_now);

  elsif p_action = 'SET_TEAM_NAME' then
    if jsonb_typeof(p_meta->'team_name') is distinct from 'string' then
      return sc._result(false, 'INVALID_STATE', 'Thiếu tên đội', v_event.revision, v_now);
    end if;
    v_name := nullif(regexp_replace(btrim(p_meta->>'team_name'), '[[:space:]]+', ' ', 'g'), '');
    if length(v_name) > 40 then
      return sc._result(false, 'INVALID_STATE', 'Tên đội tối đa 40 ký tự', v_event.revision, v_now);
    end if;
    if v_round.team_name is not distinct from v_name then
      return sc._result(true, 'OK', 'Tên đội không thay đổi', v_event.revision, v_now);
    end if;
    v_message := v_round.team_name;
    update sc.rounds set team_name = v_name where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_round.status, p_idempotency_key,
                             jsonb_build_object('team_name', v_name, 'previous_team_name', v_message),
                             case when v_name is null then 'Đã xoá tên đội #' || lpad(v_round.team_number::text, 3, '0')
                                  else 'Đặt tên đội #' || lpad(v_round.team_number::text, 3, '0') || ': ' || v_name end,
                             v_now);
    return sc._result(true, 'OK', case when v_name is null then 'Đã xoá tên đội'
                                       else 'Đã đặt tên đội: ' || v_name end, v_revision, v_now);

  elsif p_action = 'REOPEN_RESET' then
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do mở lại reset', v_event.revision, v_now);
    end if;
    select * into v_round from sc.rounds where id = (p_meta->>'round_id')::bigint;
    if not found then
      return sc._result(false, 'INVALID_STATE', 'Không tìm thấy lượt chơi', v_event.revision, v_now);
    end if;
    if v_round.status <> 'CLOSED' and v_round.exit_confirmed_at is null then
      return sc._result(false, 'INVALID_STATE', 'Lượt chơi không ở giai đoạn reset', v_event.revision, v_now);
    end if;
    if v_round.status = 'CLOSED' and v_round.id <> (select max(id) from sc.rounds where event_id = v_event.id) then
      return sc._result(false, 'INVALID_STATE', 'Đã gọi đội mới — không thể mở lại reset cũ', v_event.revision, v_now);
    end if;
    update sc.reset_tasks
       set completed_at = null, confirmed_by_role = null, confirmed_by = null, layout = null,
           reopen_count = reopen_count + 1
     where round_id = v_round.id and completed_at is not null;
    update sc.rounds
       set reset_cycle = reset_cycle + 1, gate_finalized_at = null, finalized_by_role = null,
           system_ready_at = null, status = 'EXIT_CONFIRMED'
     where id = v_round.id returning * into v_round;
    update sc.reset_tasks set cycle = v_round.reset_cycle where round_id = v_round.id;
    perform sc._review(v_round.id, 'RESET_REOPENED');
    v_revision := sc._commit(v_event, p_action, v_round, v_round.status, 'EXIT_CONFIRMED', p_idempotency_key,
                             jsonb_build_object('reason', p_meta->>'reason',
                                                'task', coalesce(nullif(p_meta->>'task_key',''),'all'),
                                                'cycle', v_round.reset_cycle),
                             'Mở lại reset đội #' || lpad(v_round.team_number::text, 3, '0') || ' · chu kỳ ' || v_round.reset_cycle,
                             v_now);
    return sc._result(true, 'OK', 'Tất cả bước reset phải xác nhận lại', v_revision, v_now);

  elsif p_action = 'REVIEW_RESOLVE' then
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do quyết định', v_event.revision, v_now);
    end if;
    if coalesce(p_meta->>'decision', '') not in ('ACCEPT','REJECT') then
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
       set needs_review = false, review_resolved_at = v_now,
           decertified = (p_meta->>'decision' = 'REJECT')
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_round.status, p_idempotency_key,
                             jsonb_build_object('reason', p_meta->>'reason', 'decision', p_meta->>'decision',
                                                'reasons', v_round.review_reasons,
                                                'official_duration_ms', v_round.official_duration_ms),
                             'Xét kết quả đội #' || lpad(v_round.team_number::text, 3, '0') || ': '
                               || case p_meta->>'decision' when 'ACCEPT' then 'chấp nhận'
                                       when 'REJECT' then 'loại bỏ' else 'không rõ' end,
                             v_now);
    return sc._result(true, 'OK',
                      case when p_meta->>'decision' = 'ACCEPT' then 'Đã xếp hạng kết quả'
                           else 'Kết quả bị loại khỏi bảng xếp hạng' end, v_revision, v_now);

  elsif p_action = 'END_EVENT' then
    if v_event.event_ended_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Sự kiện đã kết thúc', v_event.revision, v_now);
    end if;
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Cần nhập lý do đóng sự kiện sớm', v_event.revision, v_now);
    end if;
    if v_round.id is not null then
      return sc._result(false, 'BLOCKED',
                        case when v_round.exit_confirmed_at is null and v_round.game_started_at is not null
                             then 'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' vẫn đang trong khu vực'
                             else 'Chưa hoàn tất reset và đóng lượt chơi hiện tại' end,
                        v_event.revision, v_now);
    end if;
    update sc.events set event_ended_at = v_now where id = v_event.id returning * into v_event;
    v_revision := sc._commit(v_event, p_action, null, 'NONE', 'ENDED', p_idempotency_key,
                             jsonb_build_object('overtime_ms', 0), 'SỰ KIỆN KẾT THÚC', v_now);
    return sc._result(true, 'OK', 'SỰ KIỆN KẾT THÚC', v_revision, v_now);

  elsif p_action = 'ABORT_ROUND' then
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do dừng khẩn cấp', v_event.revision, v_now);
    end if;
    -- The reason for cancelling decides what happens to an outstanding claim, so it
    -- has to be stated explicitly instead of being inferred (§4.4).
    if coalesce(p_meta->>'kind', '') not in ('technical','safety','misconduct') then
      return sc._result(false, 'INVALID_STATE',
        'Chọn loại hủy: Sự cố kỹ thuật, An toàn · y tế hoặc Kỷ luật', v_event.revision, v_now);
    end if;
    if v_round.aborted_at is not null then
      return sc._result(true, 'OK', 'Lượt chơi đã bị hủy trước đó', v_event.revision, v_now);
    end if;
    -- P0 (§4.2): cancelling a round says nothing about where the players are standing.
    -- No exit_confirmed_at, no exit_by, no exit_by_role is written here — NPC1 still
    -- has to press XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3 before the area may be prepared, so a
    -- remote cancellation can never open the floor for the next team by itself.
    update sc.rounds
       set status = 'WAITING_FOR_EXIT',
           stage = greatest(stage, 4),
           game_stopped_at = coalesce(game_stopped_at, case when game_started_at is null then null else v_now end),
           abort_kind = p_meta->>'kind', abort_reason = p_meta->>'reason', aborted_at = v_now,
           official_duration_ms = case
             when p_meta->>'kind' = 'misconduct' then official_duration_ms
             when game_started_at is null then official_duration_ms else null end,
           result = case
             when p_meta->>'kind' = 'misconduct' then 'ABORTED'
             when validated_attempt_id is not null
                  or exists (select 1 from sc.completion_attempts a
                               where a.round_id = sc.rounds.id and a.status = 'VALID') then 'WON'
             else 'ABORTED' end,
           outcome = case
             when p_meta->>'kind' = 'misconduct' then 'ABORTED'
             when validated_attempt_id is not null
                  or exists (select 1 from sc.completion_attempts a
                               where a.round_id = sc.rounds.id and a.status = 'VALID') then 'WON'
             else 'ABORTED' end,
           decertified = case when p_meta->>'kind' = 'misconduct' then true else decertified end
     where id = v_round.id returning * into v_round;
    perform sc._review(v_round.id, 'ROUND_ABORTED');
    v_revision := sc._commit(v_event, p_action, v_round, v_live, v_round.status, p_idempotency_key,
                             jsonb_build_object('reason', p_meta->>'reason', 'kind', p_meta->>'kind',
                                                'result', v_round.result,
                                                'pending_validation',
                                                  exists (select 1 from sc.completion_attempts a
                                                           where a.round_id = v_round.id and a.status = 'PENDING'
                                                             and a.claimed_at < coalesce(v_deadline, 0))),
                             'HỦY LƯỢT đội #' || lpad(v_round.team_number::text, 3, '0')
                               || ' · ' || case p_meta->>'kind'
                                   when 'technical' then 'Sự cố kỹ thuật'
                                   when 'safety' then 'An toàn · y tế'
                                   else 'Kỷ luật · vi phạm luật chơi' end, v_now);
    return sc._result(true, 'OK',
      'LƯỢT CHƠI ĐÃ HỦY — NPC 1 vẫn cần xác nhận đội đã rời tầng 3', v_revision, v_now);

  elsif p_action = 'CORRECT_ROUND' then
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do hiệu chỉnh', v_event.revision, v_now);
    end if;
    select * into v_round from sc.rounds where id = (p_meta->>'round_id')::bigint;
    if not found then
      return sc._result(false, 'INVALID_STATE', 'Không tìm thấy lượt chơi', v_event.revision, v_now);
    end if;
    -- The claim rows are deliberately absent from this list: correcting a score means
    -- recording the decision against the right attempt, never rewriting a claim.
    if coalesce(p_meta->>'field', '') not in ('game_started_at','deadline_at','exit_confirmed_at','floor2_confirmed_at') then
      return sc._result(false, 'INVALID_STATE', 'Trường không được phép hiệu chỉnh', v_event.revision, v_now);
    end if;
    v_message := nullif(p_meta->>'value_ms', '');
    update sc.rounds
       set game_started_at     = case when p_meta->>'field' = 'game_started_at'
                                      then v_message::bigint else game_started_at end,
           deadline_at         = case when p_meta->>'field' = 'deadline_at' then v_message::bigint
                                      when p_meta->>'field' = 'game_started_at' and v_message is not null
                                      then v_message::bigint + v_limit else deadline_at end,
           exit_confirmed_at   = case when p_meta->>'field' = 'exit_confirmed_at'
                                      then v_message::bigint else exit_confirmed_at end,
           floor2_confirmed_at = case when p_meta->>'field' = 'floor2_confirmed_at'
                                      then v_message::bigint else floor2_confirmed_at end
     where id = v_round.id returning * into v_round;
    -- A duration was scored from a claim, so re-derive it from the corrected start
    -- instead of trusting a wall-clock recomputation.
    if p_meta->>'field' = 'game_started_at' and v_round.validated_attempt_id is not null then
      update sc.rounds
         set official_duration_ms = greatest(0, (select a.claimed_at from sc.completion_attempts a
                                                  where a.id = v_round.validated_attempt_id) - v_round.game_started_at)
       where id = v_round.id returning * into v_round;
    end if;
    perform sc._review(v_round.id, 'CORRECTED');
    v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_round.status, p_idempotency_key,
                             jsonb_build_object('field', p_meta->>'field',
                                                'after_ms', v_message::bigint,
                                                'undone', v_message is null,
                                                'reason', p_meta->>'reason'),
                             'Hiệu chỉnh ' || sc._field_vn(p_meta->>'field'), v_now);
    return sc._result(true, 'OK', 'Đã hiệu chỉnh · kết quả chờ xét lại', v_revision, v_now);

  elsif p_action in ('TEAM_UPSTAIRS','GAME_PAUSE','GAME_RESUME','GAME_RESET','HALLWAY_PROGRESS',
                     'ROOM_REACHED','PUZZLE_COMPLETE','RETURN_START','GAME_STOP','START_EVENT') then
    -- Retired controls: a stale client gets an explanation instead of a silent success
    -- that would move the state machine twice.
    return sc._result(false, 'UNKNOWN_ACTION',
                      'Thao tác này không còn trong quy trình hiện tại', v_event.revision, v_now);
  end if;

  return sc._result(false, 'UNKNOWN_ACTION', 'Hành động không xác định', v_event.revision, v_now);
end $$;

-- ---- copied from 0016 (lines 1211..1250) then edited for V3.1 ----
create or replace function sc._redact(p jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  with rounds as (
    select jsonb_agg(r - 'received_by' - 'received_by_role'
                       - 'floor2_confirmed_by' - 'floor2_confirmed_by_role'
                       - 'floor2_bypassed_by' - 'floor2_bypassed_by_role' - 'floor2_bypass_reason'
                       - 'started_by' - 'started_by_role'
                       - 'exit_by' - 'exit_by_role' - 'exit_reason'
                       - 'abort_reason'
                       - 'finalized_by_role'
                       - 'start_press_ms' - 'stop_press_ms'
                       - 'start_transport_ms' - 'stop_transport_ms'
                       - 'needs_review' - 'review_reasons' - 'review_resolved_at' - 'decertified'
                       - 'hiding_layout' - 'admission_override'
                       - 'game_anchor_ms' - 'game_elapsed_ms'
                       - 'game_reset_count' - 'game_pause_count'
                       - 'validated_attempt_id'
                       - 'reset_cycle' - 'created_revision'
                     order by ((r->>'round_number')::int)) as v
      from jsonb_array_elements(coalesce(p->'rounds', '[]'::jsonb)) r
  )
  select jsonb_set(
           jsonb_set(
             jsonb_set(
               jsonb_set(
                 jsonb_set(
                   jsonb_set(
                     jsonb_set(p, '{rounds}', coalesce((select v from rounds), '[]'::jsonb)),
                     '{log}', '[]'::jsonb),
                   '{operators}', '[]'::jsonb),
                 '{reset_tasks}', '[]'::jsonb),
               '{attempts}', '[]'::jsonb),
             '{event}',
             jsonb_set(
               p->'event', '{config}',
               (select coalesce(jsonb_object_agg(c.key, c.value), '{}'::jsonb)
                  from jsonb_each(p->'event'->'config') c
                 where c.key in ('event_name','event_duration_ms','game_limit_ms','prep_allowance_ms','reset_target_ms'))),
             true),
           '{redacted}', 'true'::jsonb, true);
$$;

-- ---- copied from 0016 (lines 1254..1360) then edited for V3.1 ----
create or replace function sc.snapshot() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_state sc.state; v_event sc.events; v_now bigint; v_role text; v_result jsonb;
begin
  v_role := sc.my_role();
  if v_role is null then
    raise exception 'PERMISSION_DENIED';
  end if;
  perform sc.tick();
  select * into v_state from sc.state where id = true;
  select * into v_event from sc.events where id = v_state.event_id;
  v_now := sc.now_ms();
  v_result := jsonb_build_object(
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
    -- One row per round, split across two objects because jsonb_build_object caps at
    -- 100 arguments and a round now carries its own reception, handover, start, score
    -- and exit facts.
    'rounds', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id::text, 'event_id', r.event_id::text, 'round_number', r.round_number,
        'team_number', r.team_number, 'team_name', r.team_name, 'status', r.status, 'stage', r.stage,
        'called_at', r.called_at,
        'received_by_role', r.received_by_role, 'received_by', r.received_by::text,
        'floor2_confirmed_at', r.floor2_confirmed_at,
        'floor2_confirmed_by_role', r.floor2_confirmed_by_role,
        'floor2_confirmed_by', r.floor2_confirmed_by::text,
        'floor2_bypassed_at', r.floor2_bypassed_at,
        'floor2_bypassed_by_role', r.floor2_bypassed_by_role,
        'floor2_bypassed_by', r.floor2_bypassed_by::text,
        'floor2_bypass_reason', r.floor2_bypass_reason,
        'game_started_at', r.game_started_at,
        'started_by_role', r.started_by_role, 'started_by', r.started_by::text,
        'round_duration_ms', r.round_duration_ms,
        'deadline_at', r.deadline_at,
        'game_anchor_ms', r.game_anchor_ms, 'game_elapsed_ms', r.game_elapsed_ms,
        'game_reset_count', r.game_reset_count, 'game_pause_count', r.game_pause_count,
        'game_stopped_at', r.game_stopped_at
      ) || jsonb_build_object(
        'official_duration_ms', r.official_duration_ms,
        'validated_attempt_id', r.validated_attempt_id::text,
        'puzzle_completed_at', r.puzzle_completed_at,
        'exit_confirmed_at', r.exit_confirmed_at,
        'exit_by_role', r.exit_by_role, 'exit_by', r.exit_by::text, 'exit_reason', r.exit_reason,
        'aborted_at', r.aborted_at, 'abort_kind', r.abort_kind, 'abort_reason', r.abort_reason,
        'gate_finalized_at', r.gate_finalized_at, 'finalized_by_role', r.finalized_by_role,
        'system_ready_at', r.system_ready_at,
        'result', r.result, 'outcome', r.outcome,
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
        'confirmed_by_role', t.confirmed_by_role, 'confirmed_by', t.confirmed_by::text,
        'completed_at', t.completed_at, 'cycle', t.cycle, 'reopen_count', t.reopen_count,
        'layout', t.layout, 'revision', t.revision) order by t.round_id, t.task_key)
      from sc.reset_tasks t
      join sc.rounds r on r.id = t.round_id where r.event_id = v_event.id), '[]'::jsonb),
    -- Every claim of the event, so each station can show the attempt list with its own
    -- timestamps. The viewer's copy of this array is emptied by sc._redact().
    'attempts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id::text, 'round_id', a.round_id::text, 'seq', a.seq,
        'claimed_at', a.claimed_at, 'elapsed_ms', a.elapsed_ms, 'remaining_ms', a.remaining_ms,
        'in_time', a.in_time, 'status', a.status,
        'claimed_by_role', a.claimed_by_role, 'claimed_by', a.claimed_by::text,
        'verified_by_role', a.verified_by_role, 'verified_by', a.verified_by::text,
        'verified_at', a.verified_at, 'decision_note', a.decision_note,
        'claim_press_ms', a.claim_press_ms, 'claim_transport_ms', a.claim_transport_ms,
        'revision', a.revision) order by a.round_id, a.claimed_at)
      from sc.completion_attempts a
      join sc.rounds r on r.id = a.round_id where r.event_id = v_event.id), '[]'::jsonb),
    'operators', sc.operator_states(v_event.id),
    'log', coalesce((select jsonb_agg(jsonb_build_object(
        'seq', l.seq, 'event_id', l.event_id::text, 'round_id', l.round_id::text,
        'team_number', l.team_number, 'action', l.action, 'actor_role', l.actor_role,
        'actor_id', l.actor_id, 'from_state', l.from_state, 'to_state', l.to_state,
        'at_ms', l.at_ms, 'revision', l.revision, 'idempotency_key', l.idempotency_key,
        'metadata', l.metadata) order by l.seq desc)
      from (select * from sc.action_log a where a.event_id = v_event.id order by a.seq desc limit 400) l), '[]'::jsonb)
  );
  if v_role = 'OBSERVER' then
    return sc._redact(v_result);
  end if;
  return v_result;
end $$;


-- ---------------------------------------------------------------------------
-- 6. The board release: authorised by the caller's own admin binding, V3.2
-- ---------------------------------------------------------------------------
-- There is no secret any more: only a device currently holding the SUPERVISOR seat
-- may sweep the board, and that check is the same role lookup every other command
-- already makes. The normal path refuses while the floor is unfinished, reading the
-- one predicate the public board publishes so the button and the RPC can never
-- disagree. The emergency path (force) first closes any still-open round as a
-- recorded safety cancellation — history is written, never deleted — and only then
-- frees the seats. Neither path ever touches a score, a claim or a checklist.
create or replace function sc.reset_all_stations(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
  v_now bigint;
  v_freed int;
  v_block text;
  v_event sc.events;
  v_open sc.rounds;
  v_rows int;
  v_revision bigint := 0;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  perform pg_advisory_xact_lock(30501);
  v_now := sc.now_ms();
  select role into v_role from sc.operators where user_id = v_uid and revoked_at is null;
  if v_role is distinct from 'SUPERVISOR' then
    insert into sc.access_audit(user_id, role, action)
      values (v_uid, v_role, 'RESET_NOT_AUTHORIZED');
    return jsonb_build_object('ok', false, 'code', 'RESET_NOT_AUTHORIZED');
  end if;
  v_block := sc._floor_block_reason();
  if v_block is not null and not coalesce(p_force, false) then
    insert into sc.access_audit(user_id, role, action, metadata) values
      (v_uid, v_role, 'RESET_BLOCKED_FLOOR', jsonb_build_object('reason', v_block));
    return jsonb_build_object('ok', false, 'code',
      case v_block when 'RUNNING' then 'RESET_GAME_RUNNING'
                   when 'PENDING_CLAIM' then 'RESET_PENDING_CLAIM'
                   else 'RESET_AREA_OPEN' end,
      'block_reason', v_block);
  end if;
  select * into v_event from sc.events
   where id = (select event_id from sc.state where id = true);
  -- Emergency path: every still-open round is accounted for before the seats go.
  -- A round that already holds a validated win keeps its result and its official
  -- time; anything unresolved becomes a recorded safety cancellation. Both land in
  -- the immutable action log with the supervisor as author, exactly like a press.
  if v_block is not null and p_force then
    for v_open in select * from sc.rounds
                   where event_id = v_event.id and status <> 'CLOSED' order by id loop
      update sc.rounds
         set aborted_at       = coalesce(aborted_at, v_now),
             abort_kind       = coalesce(abort_kind, 'safety'),
             abort_reason     = coalesce(abort_reason, 'Emergency reset'),
             exit_confirmed_at = coalesce(exit_confirmed_at, v_now),
             exit_by_role     = coalesce(exit_by_role, v_role),
             exit_by          = coalesce(exit_by, v_uid),
             status = 'CLOSED', stage = greatest(stage, 6),
             result  = case when validated_attempt_id is not null or result = 'WON'
                            then 'WON' else 'ABORTED' end,
             outcome = case when validated_attempt_id is not null or result = 'WON'
                            then 'WON' else 'ABORTED' end,
             system_ready_at = v_now
       where id = v_open.id returning * into v_open;
      if v_open.result <> 'WON' then
        perform sc._review(v_open.id, 'ROUND_ABORTED');
      end if;
      v_revision := sc._commit(v_event, 'ABORT_ROUND', v_open, 'WAITING_FOR_EXIT', 'CLOSED',
        'emergency-reset-' || v_open.id || '-' || v_now,
        jsonb_build_object('reason', coalesce(v_open.abort_reason, 'Emergency reset'),
                           'kind', coalesce(v_open.abort_kind, 'safety'),
                           'forced', true),
        'GIẢI PHÓNG KHẨN CẤP · đội #' || lpad(v_open.team_number::text, 3, '0') || ' đã đóng lượt',
        v_now, v_role, v_uid::text);
    end loop;
  end if;
  update sc.operators set revoked_at = now() where revoked_at is null;
  get diagnostics v_rows = row_count;
  v_freed := v_rows;
  -- Presence rows are live seats, not history: the sweep clears them, and the TTL
  -- machinery lets a viewer that stays connected simply take its seat again.
  delete from sc.observer_seats;
  insert into sc.access_audit(user_id, role, action, metadata) values
    (v_uid, v_role, 'STATIONS_RESET',
     jsonb_build_object('freed', v_freed, 'forced', coalesce(p_force, false)));
  if v_revision > 0 then
    update sc.events set revision = revision + 1 where id = v_event.id returning revision into v_revision;
    update sc.state set revision = v_revision, updated_at = v_now where id = true;
  end if;
  return jsonb_build_object('ok', true, 'code', 'STATIONS_RESET', 'freed', v_freed,
                            'revision', v_revision);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Grants for the surface this release adds or reshapes
-- ---------------------------------------------------------------------------
-- The two client-facing RPCs change shape, so the public wrappers are rebuilt here.
-- claim_station is open by design; reset_all_stations stays authenticated-only, and
-- inside PostgreSQL it is the caller's own SUPERVISOR binding that authorises it.
create or replace function public.claim_station(p_role text) returns jsonb
language sql security definer set search_path = '' as $$ select sc.claim_station(p_role) $$;
revoke all on function public.claim_station(text) from public, anon;
grant execute on function public.claim_station(text) to authenticated;

create or replace function public.reset_all_stations(p_force boolean default false) returns jsonb
language sql security definer set search_path = '' as $$ select sc.reset_all_stations(p_force) $$;
revoke all on function public.reset_all_stations(boolean) from public, anon;
grant execute on function public.reset_all_stations(boolean) to authenticated;

-- observer_join (0016) called the two-parameter claim internally; retarget it at
-- the V3.2 signature. The presence bookkeeping and the capacity answer are
-- unchanged, and the seat still opens with no credential of any kind.
create or replace function public.observer_join(p_viewer_id text) returns jsonb
language sql security definer set search_path = '' as $$
  select sc.claim_station('OBSERVER') ||
         (select jsonb_build_object('devices', count(*), 'capacity', 10)
            from sc.observer_seats s
            join sc.operators o on o.user_id = s.user_id and o.revoked_at is null and o.role = 'OBSERVER'
           where s.seen_at > now() - sc._observer_ttl())
$$;
revoke all on function public.observer_join(text) from public, anon;
grant execute on function public.observer_join(text) to authenticated;

revoke all on function sc.claim_station(text), sc.reset_all_stations(boolean)
  from public, anon, authenticated;
revoke all on function sc._floor_block_reason() from public, anon, authenticated;

notify pgrst, 'reload schema';