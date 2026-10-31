-- SCREAM CONTROL — Room 305 · V2 · the five-seat board
--
-- Joining is capacity-aware in three steps:
--   1. the invitation gate reads sc.station_board() and paints every station
--      red (on duty) or green (free);
--   2. redeem_invitation refuses a station that already has a phone, in every
--      mode — a link can never evict a phone that is on duty;
--   3. once all five stations are on duty every link is locked for new phones.
--
-- A phone that already holds a seat is resolved before any of that: it keeps
-- its station even when the board is full, so the lock only ever refuses new
-- devices and never disturbs the five operators who are already working.

-- ---------------------------------------------------------------- the board
-- Public by design: it names stations, never people, tokens or invitations.
-- Anonymous phones call it before they hold a session, which is the whole
-- point — the gate has to show the board before a link is opened.
create or replace function sc.station_board()
returns jsonb
language sql stable security definer set search_path = '' as $$
  with seats as (
    select r.role, r.ord,
           (o.user_id is not null) as occupied
      from unnest(array['LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR'])
           with ordinality as r(role, ord)
      left join sc.operators o
             on o.role = r.role and o.revoked_at is null
  )
  select jsonb_build_object(
    'capacity', 5,
    'occupied', count(*) filter (where s.occupied),
    'locked',   count(*) filter (where s.occupied) >= 5,
    'stations', jsonb_agg(
      jsonb_build_object('role', s.role, 'occupied', s.occupied) order by s.ord)
  )
    from seats s;
$$;

-- --------------------------------------------------------------- redemption
create or replace function sc.redeem_invitation(p_token text, p_device_id text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := (select auth.uid());
  v_inv    sc.invitations;
  v_bound  sc.operators;
  v_holder sc.operators;
  v_live   int;
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

  if v_inv.id is null then
    return jsonb_build_object('ok', false, 'code', 'INVITATION_INVALID',
                              'message', 'LIÊN KẾT KHÔNG HỢP LỆ');
  end if;

  -- A phone that is already on duty keeps its station whatever this link says.
  -- This runs before every capacity check, so a full board or a spent link can
  -- never evict one of the five phones that are already working.
  select * into v_bound from sc.operators where user_id = v_uid and revoked_at is null;
  if v_bound.user_id is not null then
    if v_bound.role <> v_inv.role then
      -- A bound device can never promote itself by opening another station link.
      return jsonb_build_object('ok', false, 'code', 'ALREADY_BOUND_OTHER_ROLE',
                                'message', 'MÁY NÀY ĐANG TRỰC ' || v_bound.role);
    end if;
    v_event := sc._ensure_event();
    return jsonb_build_object('ok', true, 'code', 'ALREADY_BOUND', 'role', v_bound.role,
                              'display_name', v_bound.display_name, 'event_id', v_event);
  end if;

  -- A spent link is indistinguishable from a revoked one to a new device: this
  -- is what makes the token single-use and re-issuing the only way forward.
  if v_inv.revoked_at is not null
     or (v_inv.expires_at is not null and v_inv.expires_at <= now()) then
    return jsonb_build_object('ok', false, 'code', 'INVITATION_INVALID',
                              'message', 'LIÊN KẾT ĐÃ DÙNG HOẶC HẾT HIỆU LỰC');
  end if;

  -- All five stations on duty: the links are locked for new phones.
  select count(*) into v_live from sc.operators where revoked_at is null;
  if v_live >= 5 then
    return jsonb_build_object('ok', false, 'code', 'STATIONS_LOCKED',
                              'message', 'ĐÃ ĐỦ 5 VỊ TRÍ — LIÊN KẾT ĐÃ KHÓA');
  end if;

  -- No takeover, in any mode: a live station is freed only by its own phone
  -- (ĐỔI MÁY) or by the organiser from the database
  -- (mint-invites --release ROLE, or --role ROLE --reassign which frees then mints).
  -- 'reassign' is therefore an organiser-side intent recorded on the link, never a
  -- privilege the holder of a link can exercise against a phone that is on duty.
  select * into v_holder from sc.operators
   where role = v_inv.role and revoked_at is null
   for update;
  if v_holder.user_id is not null then
    return jsonb_build_object('ok', false, 'code', 'ROLE_TAKEN',
                              'message', 'VỊ TRÍ NÀY ĐANG TRỰC Ở MÁY KHÁC');
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

  -- Every link is one-shot, in both modes: once it has bound a device it is
  -- revoked, so it cannot be handed on, replayed or re-bound by a stranger.
  update sc.invitations set revoked_at = now() where id = v_inv.id;

  v_event := sc._ensure_event();

  return jsonb_build_object('ok', true, 'code', 'BOUND', 'role', v_inv.role,
                            'display_name', v_name, 'event_id', v_event);
end $$;

-- ------------------------------------------------------------ client rights
-- The board is the only sc helper a browser may call directly, because the
-- public wrapper delegates to it; every other helper stays internal.
revoke execute on function sc.station_board() from public;
revoke execute on function sc.station_board() from authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function sc.station_board() from anon';
  end if;
end $$;

create or replace function public.station_board() returns jsonb
language sql security definer set search_path = '' as
$$ select sc.station_board() $$;

revoke all on function public.station_board() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.station_board() to anon';
  end if;
end $$;
grant execute on function public.station_board() to authenticated;
