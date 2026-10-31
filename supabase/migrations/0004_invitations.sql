-- SCREAM CONTROL — Room 305 · V2 · operator access without accounts
--
-- Five station links replace the five email/password users. A link carries a
-- 256-bit random token and only its SHA-256 is stored; opening it signs the
-- phone in anonymously (Supabase Anonymous Sign-ins) and exchanges the token
-- for one row in sc.operators — the same row every RPC already authorises on.
--
-- One role is bound to one device at a time. A replacement phone uses a
-- 'reassign' link, or the old phone releases itself from the dashboard.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------- operator bindings
alter table sc.operators
  add column if not exists revoked_at   timestamptz,
  add column if not exists bound_at     timestamptz not null default now(),
  add column if not exists device_id    text,
  add column if not exists is_anonymous boolean not null default false;

-- The email/password accounts are superseded by invitation links. Retire
-- whatever was bound to a real account so the five links start from a clean
-- slate (a no-op on a project that never created operator rows).
do $$
declare v_count int;
begin
  update sc.operators set revoked_at = now() where revoked_at is null;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice 'retired % account-based operator binding(s)', v_count;
  end if;
end $$;

-- The database itself guarantees at most one live device per role.
create unique index if not exists operators_one_active_per_role
  on sc.operators (role) where revoked_at is null;

-- ------------------------------------------------------------- invitations
-- Clients never touch this table: it is written and read only inside the
-- SECURITY DEFINER functions below, and RLS is on with no policies at all.
create table if not exists sc.invitations (
  id         uuid primary key default gen_random_uuid(),
  role       text not null check (role in ('LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR')),
  mode       text not null default 'claim' check (mode in ('claim','reassign')),
  token_hash bytea not null unique,
  label      text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  claimed_by uuid references auth.users (id) on delete set null,
  claimed_at timestamptz,
  revoked_at timestamptz
);

create index if not exists invitations_live_role_idx
  on sc.invitations (role) where revoked_at is null;

alter table sc.invitations enable row level security;
revoke all on sc.invitations from public;
revoke all on sc.invitations from authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on sc.invitations from anon';
  end if;
end $$;

-- --------------------------------------------------- role resolution (live)
-- A released or replaced device keeps its row for the audit trail but stops
-- resolving to a role, so every RPC it calls fails closed.
create or replace function sc.my_role() returns text
language sql stable security definer set search_path = '' as
$$ select role from sc.operators where user_id = (select auth.uid()) and revoked_at is null $$;

create or replace function sc.is_operator() returns boolean
language sql stable security definer set search_path = '' as
$$ select exists (select 1 from sc.operators where user_id = (select auth.uid()) and revoked_at is null) $$;

-- Anonymous sessions carry is_anonymous = true; recorded for the audit trail.
create or replace function sc._is_anonymous_caller() returns boolean
language sql stable security definer set search_path = '' as
$$ select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) $$;

drop policy if exists operators_self on sc.operators;
create policy operators_self on sc.operators for select to authenticated
  using (user_id = (select auth.uid()) and revoked_at is null);

-- ------------------------------------------------------------ event bootstrap
-- Requirement 11: the first phone to redeem a link also makes sure the single
-- event session and the state pointer exist, exactly as the schema expects.
create or replace function sc._ensure_event() returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_rev bigint;
begin
  select id, revision into v_id, v_rev from sc.events order by id desc limit 1;
  if v_id is null then
    insert into sc.events default values returning id, revision into v_id, v_rev;
    raise notice 'created the default event session';
  end if;
  if not exists (select 1 from sc.state where id = true) then
    insert into sc.state (id, event_id, revision, updated_at)
    values (true, v_id, coalesce(v_rev, 0), sc.now_ms());
    raise notice 'created the single-row state for event %', v_id;
  end if;
  return v_id;
end $$;

-- ------------------------------------------------------------- redemption
-- Exchanges one invitation token for one device-bound operator binding.
-- Everything the caller learns is in the returned jsonb; the token hash, the
-- invitation id and the other stations never leave the database.
create or replace function sc.redeem_invitation(p_token text, p_device_id text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := (select auth.uid());
  v_inv    sc.invitations;
  v_bound  sc.operators;
  v_holder sc.operators;
  v_name   text;
  v_event  bigint;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
                              'message', 'THIẾT BỊ CHƯA ĐƯỢC ĐĂNG NHẬP ẨN DANH');
  end if;
  if p_token is null or length(p_token) not between 32 and 128 then
    return jsonb_build_object('ok', false, 'code', 'INVITATION_INVALID',
                              'message', 'LIÊN KẾT KHÔNG HỢP LỆ');
  end if;

  -- Serialise redemptions: two phones opening the same link must not both win.
  perform pg_advisory_xact_lock(30501);

  select * into v_inv from sc.invitations
   where token_hash = extensions.digest(p_token, 'sha256')
   for update;

  if v_inv.id is null or v_inv.revoked_at is not null
     or (v_inv.expires_at is not null and v_inv.expires_at <= now()) then
    return jsonb_build_object('ok', false, 'code', 'INVITATION_INVALID',
                              'message', 'LIÊN KẾT ĐÃ HẾT HIỆU LỰC');
  end if;

  select * into v_bound from sc.operators where user_id = v_uid and revoked_at is null;
  if v_bound.user_id is not null then
    if v_bound.role <> v_inv.role then
      -- A bound device can never promote itself by opening another station link.
      return jsonb_build_object('ok', false, 'code', 'ALREADY_BOUND_OTHER_ROLE',
                                'message', 'MÁY NÀY ĐANG TRỰC ' || v_bound.role);
    end if;
    update sc.invitations
       set claimed_by = coalesce(claimed_by, v_uid), claimed_at = coalesce(claimed_at, now())
     where id = v_inv.id;
    v_event := sc._ensure_event();
    return jsonb_build_object('ok', true, 'code', 'ALREADY_BOUND', 'role', v_bound.role,
                              'display_name', v_bound.display_name, 'event_id', v_event);
  end if;

  select * into v_holder from sc.operators
   where role = v_inv.role and revoked_at is null
   for update;
  if v_holder.user_id is not null then
    if v_inv.mode <> 'reassign' then
      return jsonb_build_object('ok', false, 'code', 'ROLE_TAKEN',
                                'message', 'VỊ TRÍ NÀY ĐANG TRỰC Ở MÁY KHÁC');
    end if;
    -- Controlled reassignment: the replacement phone retires the old binding.
    update sc.operators set revoked_at = now() where user_id = v_holder.user_id;
  end if;

  v_name := coalesce(nullif(btrim(v_inv.label), ''), v_inv.role);

  insert into sc.operators (user_id, role, display_name, revoked_at, bound_at, device_id, is_anonymous)
  values (v_uid, v_inv.role, v_name, null, now(), left(coalesce(p_device_id, ''), 80),
          sc._is_anonymous_caller())
  on conflict (user_id) do update
     set role         = excluded.role,
         display_name = excluded.display_name,
         revoked_at   = null,
         bound_at     = now(),
         device_id    = excluded.device_id,
         is_anonymous = excluded.is_anonymous;

  update sc.invitations
     set claimed_by = v_uid, claimed_at = now()
   where id = v_inv.id;

  -- A replacement link is one-shot: it must not be able to bounce the role
  -- between two phones after the hand-over has happened.
  if v_inv.mode = 'reassign' then
    update sc.invitations set revoked_at = now() where id = v_inv.id;
  end if;

  v_event := sc._ensure_event();

  return jsonb_build_object('ok', true, 'code', 'BOUND', 'role', v_inv.role,
                            'display_name', v_name, 'event_id', v_event);
end $$;

-- --------------------------------------------------------------- release
-- The old phone gives its station up before the replacement opens the link.
create or replace function sc.release_device() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED', 'message', 'CHƯA ĐĂNG NHẬP');
  end if;
  update sc.operators set revoked_at = now()
   where user_id = v_uid and revoked_at is null
   returning role into v_role;
  return jsonb_build_object('ok', true,
                            'code', case when v_role is null then 'NOT_BOUND' else 'RELEASED' end,
                            'role', v_role);
end $$;

-- ---------------------------------------------------------------- whoami
create or replace function sc.whoami() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('user_id', o.user_id, 'role', o.role,
                            'display_name', o.display_name,
                            'device_id', o.device_id, 'is_anonymous', o.is_anonymous,
                            'bound_at', o.bound_at)
    from sc.operators o
   where o.user_id = (select auth.uid()) and o.revoked_at is null;
$$;

-- ---------------------------------------------- role changes are revocable
-- handle_command resolves the operator row inline (0002) and knows nothing
-- about a released device, so it is renamed and wrapped: the revocation guard
-- runs first and the original body stays untouched, unreachable from a client.
alter function sc.handle_command(text, jsonb, bigint, text) rename to _handle_command_internal;

create or replace function sc.handle_command(
  p_action text,
  p_meta jsonb default '{}'::jsonb,
  p_expected_revision bigint default 0,
  p_idempotency_key text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if sc.my_role() is null then
    return sc._result(false, 'PERMISSION_DENIED', 'TÀI KHOẢN CHƯA ĐƯỢC PHÂN QUYỀN VỊ TRÍ', 0, sc.now_ms());
  end if;
  return sc._handle_command_internal(p_action, p_meta, p_expected_revision, p_idempotency_key);
end $$;

-- A released phone must also stop resolving its own write acknowledgements:
-- every operator-facing entry point fails closed once the binding is gone.
create or replace function sc.operation_status(p_idempotency_key text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if sc.my_role() is null then
    raise exception 'PERMISSION_DENIED';
  end if;
  return (
    select coalesce(
      (select jsonb_build_object('found', true, 'action', l.action, 'at_ms', l.at_ms,
                                 'revision', l.revision, 'round_id', l.round_id::text)
         from sc.action_log l
        where l.actor_id = ((select auth.uid())::text) and l.idempotency_key = p_idempotency_key
        limit 1),
      jsonb_build_object('found', false)));
end $$;

-- The station strip must never show the name of a replaced phone.
create or replace function sc.operator_states(p_event_id bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'role', o.role, 'display_name', o.display_name,
      'last_action', l.action, 'last_action_at', l.at_ms,
      'last_detail', l.metadata->>'detail_text') order by o.ord), '[]'::jsonb)
    from (select r.role, r.ord,
                 (select o2.display_name from sc.operators o2
                   where o2.role = r.role and o2.revoked_at is null limit 1) as display_name
          from unnest(array['LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR'])
               with ordinality as r(role, ord)) o
    left join lateral (
      select a.action, a.at_ms, a.metadata from sc.action_log a
       where a.event_id = p_event_id and a.actor_role = o.role and a.actor_id <> 'system.clock'
       order by a.seq desc limit 1) l on true
$$;

-- ------------------------------------------------------------ client rights
-- Clients get the operator API and nothing else: the internal helpers
-- (_commit, _review, tick, operator_states, …) stay callable only from inside
-- the SECURITY DEFINER functions, so an anonymous sign-in cannot forge log
-- rows or review decisions by calling them directly.
revoke execute on all functions in schema sc from public;
revoke execute on all functions in schema sc from authenticated;

grant execute on function sc.handle_command(text, jsonb, bigint, text) to authenticated;
grant execute on function sc.snapshot()                              to authenticated;
grant execute on function sc.server_now_ms()                         to authenticated;
grant execute on function sc.state_revision()                        to authenticated;
grant execute on function sc.operation_status(text)                  to authenticated;
grant execute on function sc.now_ms()                                to authenticated;
grant execute on function sc.my_role()                               to authenticated;
grant execute on function sc.is_operator()                           to authenticated;
grant execute on function sc.set_test_clock(text, bigint)            to authenticated;
grant execute on function sc.whoami()                                to authenticated;
grant execute on function sc.redeem_invitation(text, text)           to authenticated;
grant execute on function sc.release_device()                        to authenticated;
