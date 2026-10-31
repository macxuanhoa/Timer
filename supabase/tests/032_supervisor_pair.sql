-- SCREAM CONTROL — Room 305 · V2 · PASS 7
-- SUPERVISOR may be staffed by two devices on the SAME permanent link (0008).
-- Every other station keeps exactly one live device. Runs after 031.
--
-- Every failing expectation raises, so a clean run means the production SQL
-- enforces the exception exactly where it was asked for, and nowhere else.

\set ON_ERROR_STOP on

reset role;
update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.invitations;

insert into auth.users (id) values
  ('cccccccc-0000-4000-8000-000000000001'), ('cccccccc-0000-4000-8000-000000000002'),
  ('cccccccc-0000-4000-8000-000000000003'), ('cccccccc-0000-4000-8000-000000000004'),
  ('cccccccc-0000-4000-8000-000000000005'), ('cccccccc-0000-4000-8000-000000000006'),
  ('cccccccc-0000-4000-8000-000000000007'), ('cccccccc-0000-4000-8000-000000000008'),
  ('cccccccc-0000-4000-8000-000000000009')
on conflict (id) do nothing;

insert into sc.invitations (role, mode, token_hash, label, expires_at) values
  ('SUPERVISOR', 'claim', extensions.digest('pair-sup-7a0c3e6b9d2f5a8c1e4b7d0f3a6c9e2015', 'sha256'), 'Mai',  null),
  ('LOBBY',      'claim', extensions.digest('pair-lobby-3f9c2a5e8b1d4f7a0c3e6b9d2f5a8c10e4', 'sha256'), 'Lan',  null),
  ('GATE',       'claim', extensions.digest('pair-gate-1e4b7d0f3a6c9e2b5d8f1a40e7c3b6d92', 'sha256'), 'Hung', null),
  ('CORRIDOR',   'claim', extensions.digest('pair-corridor-5d8f1a40e7c3b6d9f2a5c8e1b4d7f0a3c', 'sha256'), 'Ngoc', null),
  ('ROOM305',    'claim', extensions.digest('pair-room-2b5d8f1a40e7c3b6d9f2a5c8e1b4d7f0a3c', 'sha256'), 'Tuan', null);

set role authenticated;

do $$
declare
  v_a constant uuid := 'cccccccc-0000-4000-8000-000000000001';
  v_b constant uuid := 'cccccccc-0000-4000-8000-000000000002';
  v_c constant uuid := 'cccccccc-0000-4000-8000-000000000003';
  v_d constant uuid := 'cccccccc-0000-4000-8000-000000000004';
  v_e constant uuid := 'cccccccc-0000-4000-8000-000000000005';
  v_f constant uuid := 'cccccccc-0000-4000-8000-000000000006';
  v_g constant uuid := 'cccccccc-0000-4000-8000-000000000007';
  v_h constant uuid := 'cccccccc-0000-4000-8000-000000000008';
  v_tok_sup   constant text := 'pair-sup-7a0c3e6b9d2f5a8c1e4b7d0f3a6c9e2015';
  v_tok_lobby constant text := 'pair-lobby-3f9c2a5e8b1d4f7a0c3e6b9d2f5a8c10e4';
  v_tok_gate  constant text := 'pair-gate-1e4b7d0f3a6c9e2b5d8f1a40e7c3b6d92';
  v_tok_cor   constant text := 'pair-corridor-5d8f1a40e7c3b6d9f2a5c8e1b4d7f0a3c';
  v_tok_room  constant text := 'pair-room-2b5d8f1a40e7c3b6d9f2a5c8e1b4d7f0a3c';
  v jsonb; v_board jsonb; v_slot smallint; v_count int; v_rev bigint; v_uid uuid;
begin
  -- == S1. first supervisor takes slot 1 =================================
  v := sc.test_redeem(v_a, v_tok_sup, 'sup-A');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'SUPERVISOR' then
    raise exception 'ASSERT S1 failed: %', v;
  end if;
  select seat_slot into v_slot from sc.operators where user_id = v_a;
  if v_slot <> 1 then raise exception 'ASSERT S1b failed: slot %', v_slot; end if;

  -- == S2. the SAME link admits a second supervisor, in slot 2 ============
  v := sc.test_redeem(v_b, v_tok_sup, 'sup-B');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'SUPERVISOR' then
    raise exception 'ASSERT S2 failed: the second supervisor was refused: %', v;
  end if;
  select seat_slot into v_slot from sc.operators where user_id = v_b;
  if v_slot <> 2 then raise exception 'ASSERT S2b failed: slot %', v_slot; end if;
  perform sc.test_as(v_a);
  if sc.my_role() <> 'SUPERVISOR' then raise exception 'ASSERT S2c failed: A lost its seat'; end if;
  perform sc.test_as(v_b);
  if sc.my_role() <> 'SUPERVISOR' then raise exception 'ASSERT S2d failed: B has no role'; end if;

  -- == S3. a third device is refused with the official sentence ==========
  v := sc.test_redeem(v_c, v_tok_sup, 'sup-C');
  if v->>'code' <> 'ROLE_TAKEN' or v->>'message' <> 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG' then
    raise exception 'ASSERT S3 failed: %', v;
  end if;
  if sc.my_role() is not null then raise exception 'ASSERT S3b failed: a third supervisor bound'; end if;

  -- == S4. both supervisors really hold SUPERVISOR rights ================
  foreach v_uid in array array[v_a, v_b] loop
    perform sc.test_as(v_uid);
    -- Use the live revision so the answer proves the role/reason path, not the
    -- optimistic-concurrency guard.
    v_rev := (sc.state_revision()->>'revision')::bigint;
    v := sc.handle_command('REVIEW_RESOLVE', '{"round_id":"0","decision":"ACCEPT","reason":"x"}'::jsonb, v_rev, 'pair-review-' || v_uid);
    if v->>'code' <> 'INVALID_STATE' then
      raise exception 'ASSERT S4 failed: % review answered %', v_uid, v;
    end if;
    v := sc.handle_command('END_EVENT', '{}'::jsonb, v_rev, 'pair-end-' || v_uid);
    if v->>'code' <> 'BLOCKED' then
      raise exception 'ASSERT S4b failed: END_EVENT without a reason answered %', v;
    end if;
  end loop;

  -- == S5. the board is still five stations, one of them double staffed ===
  v_board := public.station_board();
  if (v_board->>'capacity')::int <> 5 then raise exception 'ASSERT S5a failed: %', v_board; end if;
  if jsonb_array_length(v_board->'stations') <> 5 then
    raise exception 'ASSERT S5b failed: a double-staffed supervisor split the board: %', v_board;
  end if;
  if (v_board->>'occupied')::int <> 1 or (v_board->>'locked')::boolean is not false then
    raise exception 'ASSERT S5c failed: occupied must count stations: %', v_board;
  end if;
  if (v_board->'stations'->4->>'devices')::int <> 2 or (v_board->'stations'->4->>'occupied')::boolean is not true then
    raise exception 'ASSERT S5d failed: supervisor seat %', v_board->'stations'->4;
  end if;
  -- The board itself declares the capacity, so no client can guess it.
  if (v_board->'stations'->4->>'capacity')::int <> 2 then
    raise exception 'ASSERT S5e failed: SUPERVISOR capacity %', v_board->'stations'->4->>'capacity';
  end if;
  if exists (select 1 from jsonb_array_elements(v_board->'stations') s
              where s->>'role' <> 'SUPERVISOR' and (s->>'capacity')::int <> 1) then
    raise exception 'ASSERT S5f failed: a single-staffed station reports the wrong capacity: %', v_board->'stations';
  end if;
  if (v_board->>'device_capacity')::int <> 6 then
    raise exception 'ASSERT S5g failed: total device capacity %', v_board->>'device_capacity';
  end if;
  if (v_board->>'devices')::int <> 2 then
    raise exception 'ASSERT S5h failed: live devices %', v_board->>'devices';
  end if;

  -- == S6. every other station stays single ==============================
  v := sc.test_redeem(v_d, v_tok_lobby, 'lob-D');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'LOBBY' then raise exception 'ASSERT S6a failed: %', v; end if;
  v := sc.test_redeem(v_e, v_tok_lobby, 'lob-E');
  if v->>'code' <> 'ROLE_TAKEN' or v->>'message' <> 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG' then
    raise exception 'ASSERT S6b failed: LOBBY accepted a second device: %', v;
  end if;
  v_board := public.station_board();
  if (v_board->'stations'->0->>'devices')::int <> 1 then
    raise exception 'ASSERT S6c failed: LOBBY devices %', v_board->'stations'->0;
  end if;

  -- == S7. releasing one supervisor frees only that slot =================
  perform sc.test_as(v_a);
  v := sc.release_device();
  if v->>'code' <> 'RELEASED' or v->>'role' <> 'SUPERVISOR' then
    raise exception 'ASSERT S7a failed: %', v;
  end if;
  perform sc.test_as(v_b);
  if sc.my_role() <> 'SUPERVISOR' then
    raise exception 'ASSERT S7b failed: releasing one supervisor dropped the other';
  end if;
  if (public.station_board()->'stations'->4->>'devices')::int <> 1 then
    raise exception 'ASSERT S7c failed: supervisor devices %', public.station_board()->'stations'->4;
  end if;
  v := sc.test_redeem(v_a, v_tok_sup, 'sup-A');
  if v->>'code' <> 'BOUND' then raise exception 'ASSERT S7d failed: %', v; end if;
  select seat_slot into v_slot from sc.operators where user_id = v_a;
  if v_slot <> 1 then raise exception 'ASSERT S7e failed: returning phone took slot %', v_slot; end if;

  -- == S8. release both, two fresh phones take the two slots =============
  perform sc.test_as(v_a); v := sc.release_device();
  perform sc.test_as(v_b); v := sc.release_device();
  if v->>'code' <> 'RELEASED' then raise exception 'ASSERT S8a failed: %', v; end if;
  v := sc.test_redeem(v_f, v_tok_sup, 'sup-F');
  if v->>'code' <> 'BOUND' then raise exception 'ASSERT S8b failed: %', v; end if;
  v := sc.test_redeem(v_g, v_tok_sup, 'sup-G');
  if v->>'code' <> 'BOUND' then raise exception 'ASSERT S8c failed: the freed slot was not reusable: %', v; end if;

  -- == S9. five stations, six devices, still locked to newcomers =========
  v := sc.test_redeem(v_c, v_tok_gate, 'gate-C');
  if v->>'code' <> 'BOUND' then raise exception 'ASSERT S9a failed: %', v; end if;
  v := sc.test_redeem(v_e, v_tok_cor, 'cor-E');
  if v->>'code' <> 'BOUND' then raise exception 'ASSERT S9b failed: %', v; end if;
  v := sc.test_redeem(v_h, v_tok_room, 'rom-H');
  if v->>'code' <> 'BOUND' then raise exception 'ASSERT S9c failed: %', v; end if;

  -- Counted through the definer-side board: RLS shows a caller only its own row,
  -- so a direct count of sc.operators would always read 1 here.
  select coalesce(sum((s->>'devices')::int), 0) into v_count
    from jsonb_array_elements(public.station_board()->'stations') s;
  if v_count <> 6 then raise exception 'ASSERT S9d failed: % live devices', v_count; end if;
  v_board := public.station_board();
  if (v_board->>'occupied')::int <> 5 or (v_board->>'locked')::boolean is not true then
    raise exception 'ASSERT S9e failed: board %', v_board;
  end if;
  if (v_board->'stations'->4->>'devices')::int <> 2 then
    raise exception 'ASSERT S9f failed: supervisor devices %', v_board->'stations'->4;
  end if;
  if (v_board->>'devices')::int <> 6 then
    raise exception 'ASSERT S9f2 failed: board device count %', v_board->>'devices';
  end if;

  -- a seventh device is refused on a single-staffed station...
  perform sc.test_as(v_a);
  v := sc.test_redeem(v_a, v_tok_lobby, 'sev-A');
  if v->>'code' <> 'ROLE_TAKEN' or v->>'message' <> 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG' then
    raise exception 'ASSERT S9g failed: %', v;
  end if;
  -- ...and on the double-staffed one
  v := sc.test_redeem(v_a, v_tok_sup, 'sev-A-sup');
  if v->>'code' <> 'ROLE_TAKEN' or v->>'message' <> 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG' then
    raise exception 'ASSERT S9h failed: %', v;
  end if;

  -- all six live devices keep working while the board is full
  foreach v_uid in array array[v_d, v_c, v_e, v_h, v_f, v_g] loop
    perform sc.test_as(v_uid);
    if sc.my_role() is null then
      raise exception 'ASSERT S9i failed: % lost its seat on a full board', v_uid;
    end if;
    if (sc.snapshot()->>'revision') is null then
      raise exception 'ASSERT S9j failed: % cannot read the event', v_uid;
    end if;
  end loop;
end $$;

-- ======================= catalog truth for the SUPERVISOR exception =======
reset role;

do $$
declare v_blocked boolean; v_count int; v_uid uuid;
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'sc' and indexname = 'operators_one_active_per_role'
       and indexdef like '%UNIQUE%' and indexdef like '%role, seat_slot%' and indexdef like '%revoked_at IS NULL%'
  ) then
    raise exception 'ASSERT T1 failed: the (role, seat_slot) unique index is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'operators_seat_slot_range' and conrelid = 'sc.operators'::regclass
  ) then
    raise exception 'ASSERT T2 failed: the slot/role check constraint is missing';
  end if;

  select count(*) into v_count from sc.operators where role = 'SUPERVISOR' and revoked_at is null;
  if v_count <> 2 then raise exception 'ASSERT T3 failed: % live supervisors', v_count; end if;

  -- A third SUPERVISOR row is impossible even for the table owner.
  v_uid := 'cccccccc-0000-4000-8000-000000000009';
  v_blocked := false;
  begin
    insert into sc.operators (user_id, role, display_name, seat_slot)
    values (v_uid, 'SUPERVISOR', 'Third', 1);
  exception when unique_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'ASSERT T4 failed: a third supervisor was accepted'; end if;

  -- A non-supervisor row can never use slot 2.
  v_blocked := false;
  begin
    insert into sc.operators (user_id, role, display_name, seat_slot)
    values (v_uid, 'LOBBY', 'Slotted', 2);
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'ASSERT T5 failed: a LOBBY row used slot 2'; end if;
  if exists (select 1 from sc.operators where user_id = v_uid) then
    raise exception 'ASSERT T6 failed: a refused insert left a row';
  end if;

  -- 0007 rules are untouched by 0008: no consumption, no expiry.
  if exists (select 1 from sc.invitations where role = 'SUPERVISOR' and revoked_at is not null) then
    raise exception 'ASSERT T7 failed: the supervisor link was consumed by redemption';
  end if;
  if exists (select 1 from sc.invitations where expires_at is not null and revoked_at is null) then
    raise exception 'ASSERT T8 failed: an active link carries an expiry';
  end if;

  raise notice 'supervisor pair ok · 5 stations · 6 devices max · other roles single';
end $$;

select '032 supervisor pair: two devices on one link, other roles unchanged — all asserted' as result;
