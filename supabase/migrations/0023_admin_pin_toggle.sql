-- Home admin circle: PIN grants this identity a live SUPERVISOR binding.
-- release_device() revokes the binding and its server permissions.
-- SCREAM CONTROL 0023 (reviewed security patch; NO embedded PIN).
-- Apply only inside a single transaction with a transaction-local
-- bcrypt hash set through set_config('sc0023.pin_hash', hash, true).
-- Never run this file alone and never commit the release batch containing a hash.
-- Precondition: explicit transaction, reviewed state and migration ledger.
DO $sc0023_pin_guard$
DECLARE
  v_hash text := current_setting('sc0023.pin_hash', true);
BEGIN
  IF v_hash IS NULL OR v_hash !~ '^\$2a\$12\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION '0023 blocked: missing or invalid transaction-local bcrypt PIN hash';
  END IF;
END
$sc0023_pin_guard$;

select pg_advisory_xact_lock(30501);
-- 0017 retired these PIN fields and the limiter. Restore them before use.
alter table sc.station_access_config
  add column if not exists supervisor_pin_hash text,
  add column if not exists pin_version bigint not null default 0;
create table if not exists sc.access_rate_limits (
  key text primary key,
  window_start timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0)
);
alter table sc.access_rate_limits enable row level security;
revoke all on sc.access_rate_limits from public, anon, authenticated;
update sc.station_access_config set
  supervisor_pin_hash = current_setting('sc0023.pin_hash', true),
  pin_version = pin_version + 1, updated_at = now() where id;

-- Revoke only pre-existing live SUPERVISOR sessions. Other roles and rounds
-- remain untouched. An existing admin must reauthenticate with the NEW PIN.
update sc.operators
   set revoked_at = now()
 where role::text = 'SUPERVISOR' and revoked_at is null;

DO $sc0023_supervisor_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM sc.operators WHERE role::text = 'SUPERVISOR' AND revoked_at IS NULL) THEN
    RAISE EXCEPTION '0023 blocked: an old SUPERVISOR binding survived revocation';
  END IF;
END
$sc0023_supervisor_guard$;

-- The migration ledger must never be writable by app/browser roles.
-- This revokes the inherited TRUNCATE/TRIGGER/MAINTAIN etc. from anon and
-- authenticated while keeping postgres ownership for the transactional ledger write.
revoke all on table public._sc_migrations from public, anon, authenticated;


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
  -- A fresh admin claim always requires the PIN overload, even for a device
  -- that appears on the historical allow-list. No-PIN calls consume no seat.
  if p_role = 'SUPERVISOR' then
    insert into sc.access_audit(user_id, role, action) values (v_uid, p_role, 'ADMIN_REFUSED');
    return jsonb_build_object('ok', false, 'code', 'PIN_REQUIRED');
  end if;
  v_capacity := case p_role when 'OBSERVER' then 10 else 1 end;
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


create or replace function sc.claim_admin(p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_bound sc.operators;
  v_hash text;
  v_slot smallint;
  v_person int;
  v_global int;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED'); end if;
  perform pg_advisory_xact_lock(30501);
  select * into v_bound from sc.operators where user_id = v_uid and revoked_at is null;
  if v_bound.user_id is not null then
    return jsonb_build_object('ok', v_bound.role = 'SUPERVISOR',
      'code', case when v_bound.role = 'SUPERVISOR' then 'ALREADY_BOUND' else 'ALREADY_BOUND_OTHER_ROLE' end,
      'role', v_bound.role);
  end if;
  select supervisor_pin_hash into v_hash from sc.station_access_config where id;
  if v_hash is null then return jsonb_build_object('ok', false, 'code', 'PIN_NOT_CONFIGURED'); end if;
  delete from sc.access_rate_limits where window_start < now() - interval '15 minutes';
  select attempts into v_person from sc.access_rate_limits where key = 'admin:' || v_uid::text;
  select attempts into v_global from sc.access_rate_limits where key = 'admin:global';
  if coalesce(v_person, 0) >= 5 or coalesce(v_global, 0) >= 30 then
    return jsonb_build_object('ok', false, 'code', 'PIN_RATE_LIMITED');
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{6,12}$' or extensions.crypt(p_pin, v_hash) <> v_hash then
    insert into sc.access_rate_limits(key, window_start, attempts)
    values ('admin:' || v_uid::text, now(), 1), ('admin:global', now(), 1)
    on conflict(key) do update set attempts = sc.access_rate_limits.attempts + 1;
    insert into sc.access_audit(user_id, role, action) values (v_uid, 'SUPERVISOR', 'PIN_REFUSED');
    return jsonb_build_object('ok', false, 'code', 'PIN_INVALID');
  end if;
  select min(s)::smallint into v_slot from generate_series(1, 2) s
   where not exists (select 1 from sc.operators where role = 'SUPERVISOR' and seat_slot = s and revoked_at is null);
  if v_slot is null then return jsonb_build_object('ok', false, 'code', 'ROLE_TAKEN'); end if;
  insert into sc.operators(user_id, role, display_name, revoked_at, bound_at, device_id, is_anonymous, seat_slot)
  values (v_uid, 'SUPERVISOR', 'Quản trị', null, now(), v_uid::text, sc._is_anonymous_caller(), v_slot)
  on conflict(user_id) do update set role = excluded.role, display_name = excluded.display_name,
    revoked_at = null, bound_at = now(), device_id = excluded.device_id,
    is_anonymous = excluded.is_anonymous, seat_slot = excluded.seat_slot;
  delete from sc.access_rate_limits where key = 'admin:' || v_uid::text;
  insert into sc.access_audit(user_id, role, action) values (v_uid, 'SUPERVISOR', 'ADMIN_PIN_CLAIMED');
  return jsonb_build_object('ok', true, 'code', 'CLAIMED', 'role', 'SUPERVISOR');
end $$;

create or replace function public.claim_station(p_role text, p_pin text) returns jsonb
language sql security definer set search_path = '' as $$
  select case when p_role = 'SUPERVISOR' then sc.claim_admin(p_pin) else sc.claim_station(p_role) end
$$;
revoke all on function sc.claim_admin(text), sc.claim_station(text) from public, anon, authenticated;
revoke all on function public.claim_station(text, text) from public, anon;
grant execute on function public.claim_station(text, text) to authenticated;
notify pgrst, 'reload schema';
