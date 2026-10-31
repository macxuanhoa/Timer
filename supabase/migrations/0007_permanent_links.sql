-- SCREAM CONTROL — Room 305 · V2 · permanent, reusable station links
--
-- The five station links are credentials for a STATION, not tickets for a phone.
-- They never expire, and they are never spent: any phone may use one whenever its
-- role is free. What is exclusive is the SEAT, not the link — the partial unique
-- index sc.operators_one_active_per_role keeps at most one live device per role,
-- and a link can never evict a phone that is already on duty.
--
-- Forward-only: 0001–0006 are already applied everywhere and stay untouched, so
-- nothing here may assume a fresh schema. Existing OPEN invitations are converted
-- in place — their hashes (and therefore their tokens) are not changed, so links
-- already handed out keep working. Revoked rows stay revoked on purpose: tokens
-- burned during earlier testing must not come back to life.

-- ------------------------------------------------------- links never expire
update sc.invitations
   set expires_at = null
 where revoked_at is null;

alter table sc.invitations alter column expires_at drop default;

comment on column sc.invitations.expires_at is
  'Legacy audit only. Permanent role links keep this NULL and 0007 redemption ignores it.';
comment on column sc.invitations.mode is
  'Legacy (claim/reassign). Since 0007 no link may take over a live seat, so the mode changes nothing.';

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

  -- A phone that already holds a seat keeps it, whatever link it opens. This is
  -- what makes a refresh, a PWA cold start or a re-scanned link harmless.
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

  -- The only link-level refusal left: an organiser revoked this link. Expiry is
  -- deliberately NOT checked — permanent links carry no date (see 0007 header).
  if v_inv.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'INVITATION_INVALID',
                              'message', 'LIÊN KẾT ĐÃ BỊ THU HỒI');
  end if;

  -- The seat is exclusive and is never taken from the phone that holds it, no
  -- matter which link (or which mode) is presented. This check runs BEFORE the
  -- capacity guard so an occupied station always answers with the official
  -- sentence, even when the board happens to be full.
  select * into v_holder from sc.operators
   where role = v_inv.role and revoked_at is null
   for update;
  if v_holder.user_id is not null then
    return jsonb_build_object('ok', false, 'code', 'ROLE_TAKEN',
                              'message', 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG');
  end if;

  -- Five seats, one each. Defence in depth: with five roles and one live device
  -- per role this can only answer if a role were ever left without a seat.
  select count(*) into v_live from sc.operators where revoked_at is null;
  if v_live >= 5 then
    return jsonb_build_object('ok', false, 'code', 'STATIONS_LOCKED',
                              'message', 'ĐÃ ĐỦ 5 VỊ TRÍ — KHÔNG CÒN VỊ TRÍ TRỐNG');
  end if;

  v_name := coalesce(nullif(btrim(v_inv.label), ''), v_inv.role);

  begin
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
  exception
    when unique_violation then
      -- Another phone won the seat between the holder check and this insert; the
      -- partial unique index is the last line of defence.
      return jsonb_build_object('ok', false, 'code', 'ROLE_TAKEN',
                                'message', 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG');
  end;

  -- Record the last bind for the audit trail only. The link itself stays ACTIVE:
  -- it is not spent, not revoked and still has no expiry.
  update sc.invitations
     set claimed_by = v_uid, claimed_at = now()
   where id = v_inv.id;

  v_event := sc._ensure_event();

  return jsonb_build_object('ok', true, 'code', 'BOUND', 'role', v_inv.role,
                            'display_name', v_name, 'event_id', v_event);
end $$;

-- ------------------------------------------------------------ client rights
-- `create or replace` keeps the OID, so the grant from 0004 and the public
-- wrapper from 0005 keep pointing at this function. Restating the grant is a
-- no-op when it already holds and documents that redemption stays callable by
-- an anonymous-but-signed-in phone.  Note that sc.station_board() stays internal
-- exactly as 0006 left it: browsers read the board through public.station_board.
grant execute on function sc.redeem_invitation(text, text) to authenticated;
