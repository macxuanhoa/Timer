-- 0010: Single root URL, atomic role claims and server-only supervisor PIN.
-- Forward-only; existing bindings and all event data remain intact.
select pg_advisory_xact_lock(30501);

create table sc.station_access_config (
  id boolean primary key default true check (id),
  supervisor_pin_hash text,
  pin_version bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into sc.station_access_config(id) values (true);

create table sc.access_rate_limits (
  key text primary key,
  window_start timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0)
);
create table sc.access_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  role text,
  action text not null,
  metadata jsonb not null default '{}'::jsonb
);
alter table sc.station_access_config enable row level security;
alter table sc.access_rate_limits enable row level security;
alter table sc.access_audit enable row level security;
revoke all on sc.station_access_config, sc.access_rate_limits, sc.access_audit from public, anon, authenticated;

-- Only anonymous occupancy counters are public. No identity/device/PIN data.
create table public.station_occupancy (
  role text primary key check (role in ('LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR')),
  capacity smallint not null check (capacity = case when role = 'SUPERVISOR' then 2 else 1 end),
  devices smallint not null check (devices >= 0 and devices <= capacity),
  revision bigint not null default 0
);
alter table public.station_occupancy enable row level security;
revoke all on public.station_occupancy from public, anon, authenticated;
grant select on public.station_occupancy to anon, authenticated;
create policy occupancy_read on public.station_occupancy for select to anon, authenticated using (true);
insert into public.station_occupancy(role, capacity, devices)
select r, case when r = 'SUPERVISOR' then 2 else 1 end,
       (select count(*) from sc.operators o where o.role = r and o.revoked_at is null)
from unnest(array['LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR']) r;

create function sc._refresh_station_occupancy() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.station_occupancy s
     set devices = (select count(*) from sc.operators o where o.role = s.role and o.revoked_at is null),
         revision = revision + 1
   where s.role in (case when TG_OP <> 'DELETE' then NEW.role end,
                    case when TG_OP <> 'INSERT' then OLD.role end);
  return null;
end $$;
create trigger operators_occupancy after insert or update or delete on sc.operators
for each row execute function sc._refresh_station_occupancy();
alter publication supabase_realtime add table public.station_occupancy;

create or replace function sc.station_board() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'capacity', 5, 'device_capacity', sum(capacity), 'devices', sum(devices),
    'occupied', count(*) filter (where devices > 0), 'locked', sum(devices) >= sum(capacity),
    'stations', jsonb_agg(jsonb_build_object('role', role, 'capacity', capacity,
      'devices', devices, 'occupied', devices >= capacity)
      order by array_position(array['LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR'], role)))
  from public.station_occupancy;
$$;

-- Owner-only administrative API; never exposed through PostgREST.
-- NULL disables new supervisor claims. Rotation keeps existing duty phones unless
-- the organiser explicitly asks to revoke them. No secret enters an audit row.
create function sc.configure_station_access(p_pin text, p_revoke_supervisors boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(30501);
  if p_pin is not null and p_pin !~ '^[0-9]{8,12}$' then
    raise exception 'PIN must contain 8 to 12 digits';
  end if;
  update sc.station_access_config set
    supervisor_pin_hash = case when p_pin is null then null else extensions.crypt(p_pin, extensions.gen_salt('bf', 10)) end,
    pin_version = pin_version + 1, updated_at = now() where id;
  delete from sc.access_rate_limits;
  if p_revoke_supervisors then
    update sc.operators set revoked_at = now() where role = 'SUPERVISOR' and revoked_at is null;
  end if;
  insert into sc.access_audit(action, metadata) values ('PIN_CONFIGURED',
    jsonb_build_object('enabled', p_pin is not null, 'revoke_supervisors', p_revoke_supervisors));
end $$;

create function sc.claim_station(p_role text, p_pin text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_bound sc.operators;
  v_capacity int;
  v_slot smallint;
  v_hash text;
  v_person_attempts int;
  v_global_attempts int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if p_role is null or p_role not in ('LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ROLE');
  end if;
  -- Shared with release, PIN administration and commands. A user cannot race two
  -- different roles; the PK(user_id) and unique(role,seat_slot) also enforce this.
  perform pg_advisory_xact_lock(30501);
  select * into v_bound from sc.operators where user_id = v_uid and revoked_at is null;
  if v_bound.user_id is not null then
    if v_bound.role <> p_role then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_BOUND_OTHER_ROLE');
    end if;
    return jsonb_build_object('ok', true, 'code', 'ALREADY_BOUND', 'role', v_bound.role);
  end if;
  v_capacity := case when p_role = 'SUPERVISOR' then 2 else 1 end;
  select min(s)::smallint into v_slot from generate_series(1, v_capacity) s
   where not exists (select 1 from sc.operators o
                     where o.role = p_role and o.seat_slot = s and o.revoked_at is null);
  if v_slot is null then
    return jsonb_build_object('ok', false, 'code', 'ROLE_TAKEN');
  end if;
  if p_role = 'SUPERVISOR' then
    select supervisor_pin_hash into v_hash from sc.station_access_config where id;
    if v_hash is null then
      return jsonb_build_object('ok', false, 'code', 'PIN_NOT_CONFIGURED');
    end if;
    -- Persist refusals by returning JSON, never raising after incrementing.
    -- Global limit bounds brute force even when anonymous identities are rotated.
    delete from sc.access_rate_limits where window_start < now() - interval '15 minutes';
    select attempts into v_person_attempts from sc.access_rate_limits where key = v_uid::text;
    select attempts into v_global_attempts from sc.access_rate_limits where key = 'global';
    if coalesce(v_person_attempts, 0) >= 5 or coalesce(v_global_attempts, 0) >= 30 then
      return jsonb_build_object('ok', false, 'code', 'PIN_RATE_LIMITED');
    end if;
    insert into sc.access_rate_limits(key, window_start, attempts)
    values (v_uid::text, now(), 1), ('global', now(), 1)
    on conflict (key) do update set attempts = sc.access_rate_limits.attempts + 1;
    if p_pin is null or length(p_pin) > 12 or p_pin !~ '^[0-9]{8,12}$'
       or extensions.crypt(p_pin, v_hash) <> v_hash then
      insert into sc.access_audit(user_id, role, action) values (v_uid, p_role, 'PIN_REFUSED');
      return jsonb_build_object('ok', false, 'code', 'PIN_INVALID');
    end if;
    delete from sc.access_rate_limits where key = v_uid::text;
  end if;
  insert into sc.operators(user_id, role, display_name, revoked_at, bound_at, device_id, is_anonymous, seat_slot)
  values (v_uid, p_role, p_role, null, now(), v_uid::text, sc._is_anonymous_caller(), v_slot)
  on conflict(user_id) do update set role = excluded.role, display_name = excluded.display_name,
    revoked_at = null, bound_at = now(), device_id = excluded.device_id,
    is_anonymous = excluded.is_anonymous, seat_slot = excluded.seat_slot;
  insert into sc.access_audit(user_id, role, action) values(v_uid, p_role, 'CLAIMED');
  -- Deliberately no _ensure_event(), tick(), state write or timer action.
  return jsonb_build_object('ok', true, 'code', 'CLAIMED', 'role', p_role);
end $$;

create or replace function sc.release_device() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  perform pg_advisory_xact_lock(30501);
  update sc.operators set revoked_at = now()
   where user_id = v_uid and revoked_at is null returning role into v_role;
  if v_role is not null then
    insert into sc.access_audit(user_id, role, action) values(v_uid, v_role, 'RELEASED');
  end if;
  return jsonb_build_object('ok', true, 'code', case when v_role is null then 'NOT_BOUND' else 'RELEASED' end);
end $$;

-- Once release commits, an old command cannot pass the binding check. Workflow,
-- revision checks and idempotency stay in the original authoritative body.
create or replace function sc.handle_command(p_action text, p_meta jsonb default '{}'::jsonb,
  p_expected_revision bigint default 0, p_idempotency_key text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(30501);
  if sc.my_role() is null then
    return sc._result(false, 'PERMISSION_DENIED', 'VỊ TRÍ ĐÃ ĐƯỢC THU HỒI', 0, sc.now_ms());
  end if;
  return sc._handle_command_internal(p_action, p_meta, p_expected_revision, p_idempotency_key);
end $$;

-- Old tokens can never grant authority again, including through an old cached PWA.
create or replace function sc.redeem_invitation(p_token text, p_device_id text default null) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('ok', false, 'code', 'INVITATIONS_DISABLED');
$$;
revoke all on function sc.redeem_invitation(text, text) from public, anon, authenticated;
revoke all on function public.redeem_invitation(text, text) from public, anon, authenticated;

create function public.claim_station(p_role text, p_pin text) returns jsonb
language sql security definer set search_path = '' as $$ select sc.claim_station(p_role, p_pin) $$;
revoke all on function public.claim_station(text, text) from public, anon;
grant execute on function public.claim_station(text, text) to authenticated;
revoke all on function sc.claim_station(text, text), sc.configure_station_access(text, boolean),
  sc._refresh_station_occupancy() from public, anon, authenticated;
notify pgrst, 'reload schema';
