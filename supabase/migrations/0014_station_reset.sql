-- 0014: One-tap station board reset behind a server-side organiser secret.
-- Frees every occupied station (all six seats) without touching event data.
-- Forward-only; the secret is stored only as a bcrypt hash, never in the client.
select pg_advisory_xact_lock(30501);

alter table sc.station_access_config
  add column reset_secret_hash text,
  add column reset_version bigint not null default 0;

-- Owner-only configuration; never exposed through PostgREST. NULL disables the
-- reset button. Rotation clears pending refusals but revokes no duty device.
-- The secret is free-form text, so the PIN's digit rule deliberately does not apply.
create function sc.configure_station_reset(p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(30501);
  if p_secret is not null and (char_length(p_secret) < 10 or char_length(p_secret) > 64) then
    raise exception 'Reset secret must contain 10 to 64 characters';
  end if;
  update sc.station_access_config set
    reset_secret_hash = case when p_secret is null then null else extensions.crypt(p_secret, extensions.gen_salt('bf', 10)) end,
    reset_version = reset_version + 1, updated_at = now() where id;
  delete from sc.access_rate_limits where key like 'reset:%';
  insert into sc.access_audit(action, metadata) values ('RESET_CONFIGURED',
    jsonb_build_object('enabled', p_secret is not null));
end $$;

-- The only destructive access action: every live binding is revoked at once.
-- Authority, not occupancy, is what this removes — no event, round, reset task or
-- action log row is touched, and every freed phone lands on the station picker.
create function sc.reset_all_stations(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_hash text;
  v_version bigint;
  v_person_attempts int;
  v_global_attempts int;
  v_freed int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  -- Shared with claim, release, PIN administration and commands: a concurrent
  -- claim can neither slip in uncounted nor survive the sweep.
  perform pg_advisory_xact_lock(30501);
  select reset_secret_hash, reset_version into v_hash, v_version from sc.station_access_config where id;
  if v_hash is null then
    return jsonb_build_object('ok', false, 'code', 'RESET_NOT_CONFIGURED');
  end if;
  -- Counted per identity and globally, so rotating anonymous sessions cannot buy
  -- unlimited guesses. A reset is rare, so the global window is tighter than the PIN's.
  delete from sc.access_rate_limits where window_start < now() - interval '15 minutes';
  select attempts into v_person_attempts from sc.access_rate_limits where key = 'reset:' || v_uid::text;
  select attempts into v_global_attempts from sc.access_rate_limits where key = 'reset:global';
  if coalesce(v_person_attempts, 0) >= 5 or coalesce(v_global_attempts, 0) >= 10 then
    return jsonb_build_object('ok', false, 'code', 'RESET_RATE_LIMITED');
  end if;
  insert into sc.access_rate_limits(key, window_start, attempts)
  values ('reset:' || v_uid::text, now(), 1), ('reset:global', now(), 1)
  on conflict (key) do update set attempts = sc.access_rate_limits.attempts + 1;
  -- bcrypt against the stored hash: the secret itself never leaves this call.
  if p_secret is null or char_length(p_secret) > 64 or extensions.crypt(p_secret, v_hash) <> v_hash then
    insert into sc.access_audit(user_id, action) values (v_uid, 'RESET_REFUSED');
    return jsonb_build_object('ok', false, 'code', 'RESET_INVALID');
  end if;
  delete from sc.access_rate_limits where key = 'reset:' || v_uid::text;
  update sc.operators set revoked_at = now() where revoked_at is null;
  get diagnostics v_freed = row_count;
  insert into sc.access_audit(user_id, action, metadata) values
    (v_uid, 'STATIONS_RESET', jsonb_build_object('freed', v_freed, 'secret_version', v_version));
  -- The occupancy trigger already refreshed and bumped every affected station,
  -- so boards update on their own. Deliberately no _ensure_event(), tick() or state write.
  return jsonb_build_object('ok', true, 'code', 'STATIONS_RESET', 'freed', v_freed);
end $$;

create function public.reset_all_stations(p_secret text) returns jsonb
language sql security definer set search_path = '' as $$ select sc.reset_all_stations(p_secret) $$;
revoke all on function public.reset_all_stations(text) from public, anon;
grant execute on function public.reset_all_stations(text) to authenticated;
revoke all on function sc.reset_all_stations(text), sc.configure_station_reset(text)
  from public, anon, authenticated;
notify pgrst, 'reload schema';
