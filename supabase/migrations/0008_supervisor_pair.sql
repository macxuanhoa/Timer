-- SCREAM CONTROL — Room 305 · V2 · SUPERVISOR may be staffed by two devices
--
-- Official model stays "one live device per role" for LOBBY, GATE, CORRIDOR and
-- ROOM305. SUPERVISOR is the single exception: the organiser and an assistant
-- may both hold the SUPERVISOR seat, opening the SAME permanent link. Nothing
-- else changes: a link still never evicts a live device, the board is still the
-- five stations, and every other station still accepts exactly one phone.
--
-- Why a seat slot instead of a trigger: a partial UNIQUE index on (role, slot)
-- keeps the limit enforceable inside the same transaction that binds, so two
-- simultaneous redemptions cannot both take the last SUPERVISOR slot. Non
-- supervisor rows are pinned to slot 1 by a CHECK, so their limit stays one.
--
-- Forward-only: 0001–0007 are already applied and stay untouched.

-- ------------------------------------------------------------ seat slots
alter table sc.operators add column if not exists seat_slot smallint not null default 1;
update sc.operators set seat_slot = 1 where seat_slot is null;

comment on column sc.operators.seat_slot is
  'Seat within a role. Always 1 except SUPERVISOR, which may hold slots 1 and 2.';

alter table sc.operators drop constraint if exists operators_seat_slot_range;
alter table sc.operators add constraint operators_seat_slot_range
  check (seat_slot in (1, 2) and (seat_slot = 1 or role = 'SUPERVISOR'));

-- Replaces the one-row-per-role index with the same guarantee, plus slot 2 for
-- SUPERVISOR only. Same name on purpose: nothing else references the old shape.
drop index if exists sc.operators_one_active_per_role;
create unique index operators_one_active_per_role
  on sc.operators (role, seat_slot) where revoked_at is null;

-- ------------------------------------------------------------------ board
-- A second SUPERVISOR row must not turn the five-seat board into six seats, so
-- occupancy is aggregated per role. `devices` is additive (1, or 2 for a double
-- staffed SUPERVISOR); the existing `occupied`/`locked` contract is unchanged.
create or replace function sc.station_board()
returns jsonb
language sql stable security definer set search_path = '' as $$
  with seats as (
    select r.role, r.ord,
           (count(o.user_id) > 0) as occupied,
           count(o.user_id)::int  as devices
      from unnest(array['LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR'])
           with ordinality as r(role, ord)
      left join sc.operators o
             on o.role = r.role and o.revoked_at is null
     group by r.role, r.ord
  )
  select jsonb_build_object(
    'capacity', 5,
    'occupied', count(*) filter (where s.occupied),
    'locked',   count(*) filter (where s.occupied) >= 5,
    'stations', jsonb_agg(
      jsonb_build_object('role', s.role, 'occupied', s.occupied, 'devices', s.devices) order by s.ord)
  )
    from seats s;
$$;

-- ------------------------------------------------------------- redemption
create or replace function sc.redeem_invitation(p_token text, p_device_id text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := (select auth.uid());
  v_inv    sc.invitations;
  v_bound  sc.operators;
  v_holder sc.operators;
  v_live   int;
  v_sup    int;
  v_slot   smallint;
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

  -- One redemption at a time: two phones opening the same link can never both win.
  perform pg_advisory_xact_lock(30501);

  select * into v_inv from sc.invitations
   where token_hash = extensions.digest(p_token, 'sha256')
   for update;

  if v_inv.id is null then
    return jsonb_build_object('ok', false, 'code', 'INVITATION_INVALID',
                              'message', 'LIÊN KẾT KHÔNG HỢP LỆ');
  end if;

  -- A phone that already holds a seat keeps it, whatever link it opens.
  select * into v_bound from sc.operators where user_id = v_uid and revoked_at is null;
  if v_bound.user_id is not null then
    if v_bound.role <> v_inv.role then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_BOUND_OTHER_ROLE',
                                'message', 'MÁY NÀY ĐANG TRỰC ' || v_bound.role);
    end if;
    v_event := sc._ensure_event();
    return jsonb_build_object('ok', true, 'code', 'ALREADY_BOUND', 'role', v_bound.role,
                              'display_name', v_bound.display_name, 'event_id', v_event);
  end if;

  -- The only link-level refusal left: an organiser revoked this link.
  if v_inv.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'INVITATION_INVALID',
                              'message', 'LIÊN KẾT ĐÃ BỊ THU HỒI');
  end if;

  if v_inv.role = 'SUPERVISOR' then
    -- The only role that may be double staffed: two live seats, no eviction.
    select count(*) into v_sup from sc.operators
     where role = 'SUPERVISOR' and revoked_at is null;
    if v_sup >= 2 then
      return jsonb_build_object('ok', false, 'code', 'ROLE_TAKEN',
                                'message', 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG');
    end if;
    select min(s) into v_slot
      from (values (1::smallint), (2::smallint)) as slots(s)
     where s not in (select seat_slot from sc.operators
                      where role = 'SUPERVISOR' and revoked_at is null);
  else
    -- Every other station stays single: no link may evict the phone on duty.
    select * into v_holder from sc.operators
     where role = v_inv.role and revoked_at is null
     for update;
    if v_holder.user_id is not null then
      return jsonb_build_object('ok', false, 'code', 'ROLE_TAKEN',
                                'message', 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG');
    end if;
    v_slot := 1;
  end if;

  -- Six devices at most: four single-staffed stations plus two supervisors.
  -- Placed AFTER the seat checks so an occupied station always answers with the
  -- official sentence; with six roles' worth of devices this is unreachable.
  select count(*) into v_live from sc.operators where revoked_at is null;
  if v_live >= 6 then
    return jsonb_build_object('ok', false, 'code', 'STATIONS_LOCKED',
                              'message', 'ĐÃ ĐỦ 5 VỊ TRÍ — KHÔNG CÒN VỊ TRÍ TRỐNG');
  end if;

  v_name := coalesce(nullif(btrim(v_inv.label), ''), v_inv.role);

  begin
    insert into sc.operators (user_id, role, display_name, revoked_at, bound_at, device_id, is_anonymous, seat_slot)
    values (v_uid, v_inv.role, v_name, null, now(), left(coalesce(p_device_id, ''), 80),
            sc._is_anonymous_caller(), v_slot)
    on conflict (user_id) do update
       set role         = excluded.role,
           display_name = excluded.display_name,
           revoked_at   = null,
           bound_at     = now(),
           device_id    = excluded.device_id,
           is_anonymous = excluded.is_anonymous,
           seat_slot    = excluded.seat_slot;
  exception
    when unique_violation then
      -- Another phone took the last slot between the check and this insert.
      return jsonb_build_object('ok', false, 'code', 'ROLE_TAKEN',
                                'message', 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG');
  end;

  -- Record the last bind for the audit trail only. The link itself stays ACTIVE.
  update sc.invitations
     set claimed_by = v_uid, claimed_at = now()
   where id = v_inv.id;

  v_event := sc._ensure_event();

  return jsonb_build_object('ok', true, 'code', 'BOUND', 'role', v_inv.role,
                            'display_name', v_name, 'event_id', v_event);
end $$;

-- `create or replace` keeps the OID, so the 0004 grant and the 0005 wrapper
-- keep pointing here. Restated for clarity; a no-op when it already holds.
grant execute on function sc.redeem_invitation(text, text) to authenticated;
