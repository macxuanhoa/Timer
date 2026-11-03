-- 0015: The board reset is an access action only — never a workflow action.
-- It may not run while a team is on the 5:00 clock, and the physical reset
-- checklist belongs to the area staff alone.
select pg_advisory_xact_lock(30501);

-- 1) Three physical checks, three responsible stations: CORRIDOR (hallway),
-- ROOM305 (room) and GATE when it owns the hidden objects. GIÁM SÁT confirms
-- nothing — it never enters a corridor or a room to move props.
delete from sc.role_permissions where action = 'RESET_DONE' and role = 'SUPERVISOR';

-- 2) Publish one extra public flag so the picker can grey the board reset out
-- while a round is live. Counters and this flag only: no name, no device, no
-- timestamp. The window is open from BẮT ĐẦU until CHỐT GIỜ, which covers a
-- pause and overtime — exactly when the crew inside must not be disturbed.
create or replace function sc.station_board() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'capacity', 5, 'device_capacity', sum(capacity), 'devices', sum(devices),
    'occupied', count(*) filter (where devices > 0), 'locked', sum(devices) >= sum(capacity),
    'game_running', exists (select 1 from sc.rounds r join sc.state s on s.id
      where r.event_id = s.event_id and r.game_started_at is not null and r.game_stopped_at is null),
    'stations', jsonb_agg(jsonb_build_object('role', role, 'capacity', capacity,
      'devices', devices, 'occupied', devices >= capacity)
      order by array_position(array['LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR'], role)))
  from public.station_occupancy;
$$;

-- 3) The sweep stays access-only, and refuses to run over a live clock. A round
-- is never stopped, closed or re-opened here: that is GATE's CHỐT GIỜ or the
-- separate KẾT THÚC SỚM / HỦY LƯỢT action, both of which keep their history.
create or replace function sc.reset_all_stations(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_hash text;
  v_version bigint;
  v_person_attempts int;
  v_global_attempts int;
  v_freed int;
  v_running boolean;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  perform pg_advisory_xact_lock(30501);
  select reset_secret_hash, reset_version into v_hash, v_version from sc.station_access_config where id;
  if v_hash is null then
    return jsonb_build_object('ok', false, 'code', 'RESET_NOT_CONFIGURED');
  end if;
  delete from sc.access_rate_limits where window_start < now() - interval '15 minutes';
  select attempts into v_person_attempts from sc.access_rate_limits where key = 'reset:' || v_uid::text;
  select attempts into v_global_attempts from sc.access_rate_limits where key = 'reset:global';
  if coalesce(v_person_attempts, 0) >= 5 or coalesce(v_global_attempts, 0) >= 10 then
    return jsonb_build_object('ok', false, 'code', 'RESET_RATE_LIMITED');
  end if;
  insert into sc.access_rate_limits(key, window_start, attempts)
  values ('reset:' || v_uid::text, now(), 1), ('reset:global', now(), 1)
  on conflict (key) do update set attempts = sc.access_rate_limits.attempts + 1;
  if p_secret is null or char_length(p_secret) > 64 or extensions.crypt(p_secret, v_hash) <> v_hash then
    insert into sc.access_audit(user_id, action) values (v_uid, 'RESET_REFUSED');
    return jsonb_build_object('ok', false, 'code', 'RESET_INVALID');
  end if;
  -- Only a correct secret is allowed to learn what the board is doing.
  delete from sc.access_rate_limits where key = 'reset:' || v_uid::text;
  select exists (select 1 from sc.rounds r join sc.state s on s.id
    where r.event_id = s.event_id and r.game_started_at is not null and r.game_stopped_at is null)
    into v_running;
  if v_running then
    insert into sc.access_audit(user_id, action, metadata) values
      (v_uid, 'RESET_BLOCKED_GAME', jsonb_build_object('secret_ok', true));
    return jsonb_build_object('ok', false, 'code', 'RESET_GAME_RUNNING');
  end if;
  update sc.operators set revoked_at = now() where revoked_at is null;
  get diagnostics v_freed = row_count;
  insert into sc.access_audit(user_id, action, metadata) values
    (v_uid, 'STATIONS_RESET', jsonb_build_object('freed', v_freed, 'secret_version', v_version));
  -- Deliberately nothing else: no tick, no round write, no reset task write, no
  -- event row. The pending checklist of the previous team survives this sweep.
  return jsonb_build_object('ok', true, 'code', 'STATIONS_RESET', 'freed', v_freed);
end $$;
notify pgrst, 'reload schema';
