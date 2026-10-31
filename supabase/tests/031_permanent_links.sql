-- SCREAM CONTROL — Room 305 · V2 · PASS 6
-- Permanent, reusable station links (migration 0007).
--
-- Runs after 030 against the same throwaway Postgres. It proves the model the
-- organisers asked for: five links that never expire, are never spent, and are
-- reusable whenever their station is free — while the SEAT stays exclusive, the
-- second phone is refused with the official sentence, no link can evict a phone
-- on duty, and nothing releases a station on its own.
--
-- Every failing expectation raises, so a clean run means the production SQL
-- behaves exactly like this.

\set ON_ERROR_STOP on

-- ------------------------------------------------------------------- seeding
reset role;
update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.invitations;

insert into auth.users (id) values
  ('bbbbbbbb-0000-4000-8000-000000000001'),
  ('bbbbbbbb-0000-4000-8000-000000000002'),
  ('bbbbbbbb-0000-4000-8000-000000000003'),
  ('bbbbbbbb-0000-4000-8000-000000000004'),
  ('bbbbbbbb-0000-4000-8000-000000000005'),
  ('bbbbbbbb-0000-4000-8000-000000000006'),
  ('bbbbbbbb-0000-4000-8000-000000000007'),
  ('bbbbbbbb-0000-4000-8000-000000000008')
on conflict (id) do nothing;

-- The five permanent links, plus a second LOBBY link (must never take over) and
-- a GATE link carrying a date in the past (must still work: 0007 has no expiry).
insert into sc.invitations (role, mode, token_hash, label, expires_at) values
  ('LOBBY',      'claim', extensions.digest('perm-lobby-3f9c2a5e8b1d4f7a0c3e6b9d2f5a8c10e4', 'sha256'), 'Lan',      null),
  ('GATE',       'claim', extensions.digest('perm-gate-7a0c3e6b9d2f5a8c1e4b7d0f3a6c9e2015', 'sha256'), 'Hung',     null),
  ('CORRIDOR',   'claim', extensions.digest('perm-corridor-1e4b7d0f3a6c9e2b5d8f1a40e7c3b6d92', 'sha256'), 'Ngoc', null),
  ('ROOM305',    'claim', extensions.digest('perm-room305-5d8f1a40e7c3b6d9f2a5c8e1b4d7f0a3c', 'sha256'), 'Tuan', null),
  ('SUPERVISOR', 'claim', extensions.digest('perm-sup-9f2a5c8e1b4d7f0a3c6e9b2d5f1a4c7e0b', 'sha256'), 'Mai',      null),
  ('LOBBY',      'claim', extensions.digest('perm-lobby2-2b5d8f1a40e7c3b6d9f2a5c8e1b4d7f0a3', 'sha256'), 'Lan B', null),
  ('GATE',       'claim', extensions.digest('perm-gate-old-6c9e2b5d8f1a40e7c3b6d9f2a5c8e1b4d7', 'sha256'), 'Legacy date', now() - interval '1 day');

insert into sc.invitations (role, mode, token_hash, label, expires_at, revoked_at) values
  ('SUPERVISOR', 'claim', extensions.digest('perm-sup-revoked-40e7c3b6d9f2a5c8e1b4d7f0a3c6e9b2d5', 'sha256'), 'Burned', null, now());

-- test_as / test_redeem were created by 030 and are still granted.
set role authenticated;

do $$
declare
  v_a constant uuid := 'bbbbbbbb-0000-4000-8000-000000000001';
  v_b constant uuid := 'bbbbbbbb-0000-4000-8000-000000000002';
  v_c constant uuid := 'bbbbbbbb-0000-4000-8000-000000000003';
  v_d constant uuid := 'bbbbbbbb-0000-4000-8000-000000000004';
  v_e constant uuid := 'bbbbbbbb-0000-4000-8000-000000000005';
  v_f constant uuid := 'bbbbbbbb-0000-4000-8000-000000000006';
  v_g constant uuid := 'bbbbbbbb-0000-4000-8000-000000000007';
  v_tok_lobby     constant text := 'perm-lobby-3f9c2a5e8b1d4f7a0c3e6b9d2f5a8c10e4';
  v_tok_lobby2    constant text := 'perm-lobby2-2b5d8f1a40e7c3b6d9f2a5c8e1b4d7f0a3';
  v_tok_gate      constant text := 'perm-gate-7a0c3e6b9d2f5a8c1e4b7d0f3a6c9e2015';
  v_tok_gate_old  constant text := 'perm-gate-old-6c9e2b5d8f1a40e7c3b6d9f2a5c8e1b4d7';
  v_tok_corridor  constant text := 'perm-corridor-1e4b7d0f3a6c9e2b5d8f1a40e7c3b6d92';
  v_tok_room      constant text := 'perm-room305-5d8f1a40e7c3b6d9f2a5c8e1b4d7f0a3c';
  v_tok_sup       constant text := 'perm-sup-9f2a5c8e1b4d7f0a3c6e9b2d5f1a4c7e0b';
  v_tok_sup_dead  constant text := 'perm-sup-revoked-40e7c3b6d9f2a5c8e1b4d7f0a3c6e9b2d5';
  v jsonb; v_board jsonb; v_role text; v_round int;
begin
  -- == P1. first join: the link binds and is NOT spent ======================
  v := sc.test_redeem(v_a, v_tok_lobby, 'perm-A');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'LOBBY' then
    raise exception 'ASSERT P1 failed: %', v;
  end if;
  if sc.my_role() <> 'LOBBY' then raise exception 'ASSERT P1b failed: %', sc.my_role(); end if;

  -- == P2. second phone, same link, sealed with the official sentence =======
  v := sc.test_redeem(v_b, v_tok_lobby, 'perm-B');
  if v->>'code' <> 'ROLE_TAKEN' or v->>'message' <> 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG' then
    raise exception 'ASSERT P2 failed: %', v;
  end if;
  if sc.my_role() is not null then
    raise exception 'ASSERT P2b failed: the refused phone resolves %', sc.my_role();
  end if;

  -- == P3. a SECOND link for the same station cannot take over either =======
  v := sc.test_redeem(v_b, v_tok_lobby2, 'perm-B');
  if v->>'code' <> 'ROLE_TAKEN' or v->>'message' <> 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG' then
    raise exception 'ASSERT P3 failed: %', v;
  end if;

  -- == P4. a bound phone cannot promote itself with another station's link ===
  perform sc.test_as(v_a);
  v := sc.test_redeem(v_a, v_tok_sup, 'perm-A');
  if v->>'code' <> 'ALREADY_BOUND_OTHER_ROLE' then
    raise exception 'ASSERT P4 failed: %', v;
  end if;
  if sc.my_role() <> 'LOBBY' then raise exception 'ASSERT P4b failed: role became %', sc.my_role(); end if;

  -- == P5. release: the seat frees, the link stays valid ====================
  v := sc.release_device();
  if v->>'code' <> 'RELEASED' or v->>'role' <> 'LOBBY' then
    raise exception 'ASSERT P5 failed: %', v;
  end if;
  if sc.my_role() is not null then raise exception 'ASSERT P5b failed: released phone keeps a role'; end if;
  begin
    perform sc.snapshot();
    raise exception 'ASSERT P5c failed: a released phone read the snapshot';
  exception when others then
    if sqlerrm not like '%PERMISSION_DENIED%' then raise; end if;
  end;
  v := sc.handle_command('GAME_STOP', '{}'::jsonb, 0, 'perm-released');
  if v->>'code' <> 'PERMISSION_DENIED' then
    raise exception 'ASSERT P5d failed: a released phone still commanded: %', v;
  end if;

  -- == P6. the SAME link is reused by the other phone =======================
  v := sc.test_redeem(v_b, v_tok_lobby, 'perm-B');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'LOBBY' then
    raise exception 'ASSERT P6 failed: the same link did not work after release: %', v;
  end if;

  -- == P7. multiple reuse cycles, alternating phones, same token ============
  for v_round in 1..3 loop
    perform sc.test_as(v_b);
    v := sc.release_device();
    if v->>'code' <> 'RELEASED' then raise exception 'ASSERT P7a failed: %', v; end if;
    v := sc.test_redeem(v_a, v_tok_lobby, 'perm-A');
    if v->>'code' <> 'BOUND' then raise exception 'ASSERT P7b (cycle %) failed: %', v_round, v; end if;
    perform sc.test_as(v_a);
    v := sc.release_device();
    if v->>'code' <> 'RELEASED' then raise exception 'ASSERT P7c failed: %', v; end if;
    v := sc.test_redeem(v_b, v_tok_lobby, 'perm-B');
    if v->>'code' <> 'BOUND' then raise exception 'ASSERT P7d (cycle %) failed: %', v_round, v; end if;
  end loop;

  -- == P8. a legacy date in the past does not block a permanent link ========
  v := sc.test_redeem(v_c, v_tok_gate_old, 'perm-C');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'GATE' then
    raise exception 'ASSERT P8 failed: a past expiry blocked the link: %', v;
  end if;
  v := sc.test_redeem(v_c, v_tok_gate, 'perm-C');
  if v->>'code' <> 'ALREADY_BOUND' or v->>'role' <> 'GATE' then
    raise exception 'ASSERT P8b failed: %', v;
  end if;

  -- == P9. five stations live, board accurate, sixth phone refused ==========
  v := sc.test_redeem(v_d, v_tok_corridor, 'perm-D');
  if v->>'code' <> 'BOUND' then raise exception 'ASSERT P9a failed: %', v; end if;
  v := sc.test_redeem(v_e, v_tok_room, 'perm-E');
  if v->>'code' <> 'BOUND' then raise exception 'ASSERT P9b failed: %', v; end if;
  v := sc.test_redeem(v_f, v_tok_sup, 'perm-F');
  if v->>'code' <> 'BOUND' then raise exception 'ASSERT P9c failed: %', v; end if;

  v_board := public.station_board();
  if (v_board->>'occupied')::int <> 5 or (v_board->>'locked')::boolean is not true then
    raise exception 'ASSERT P9d failed: board %', v_board;
  end if;
  if exists (select 1 from jsonb_array_elements(v_board->'stations') s where (s->>'occupied')::boolean is not true) then
    raise exception 'ASSERT P9e failed: a seat is reported free: %', v_board;
  end if;

  -- Sixth phone, LOBBY link, full board: still the official sentence.
  v := sc.test_redeem(v_g, v_tok_lobby, 'perm-G');
  if v->>'code' <> 'ROLE_TAKEN' or v->>'message' <> 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG' then
    raise exception 'ASSERT P9f failed: %', v;
  end if;
  if sc.my_role() is not null then raise exception 'ASSERT P9g failed: the sixth phone holds %', sc.my_role(); end if;
  v := sc.test_redeem(v_g, v_tok_sup_dead, 'perm-G');
  if v->>'code' <> 'INVITATION_INVALID' then
    raise exception 'ASSERT P9h failed: a revoked link was accepted: %', v;
  end if;
  if (public.station_board()->>'occupied')::int <> 5 then
    raise exception 'ASSERT P9i failed: a refused phone changed the board';
  end if;

  -- == P10. the five phones on duty are untouched by the refusals ==========
  for v_role in select unnest(array['LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR']) loop
    perform sc.test_as(case v_role
      when 'LOBBY' then v_b when 'GATE' then v_c when 'CORRIDOR' then v_d
      when 'ROOM305' then v_e else v_f end);
    if sc.my_role() <> v_role then
      raise exception 'ASSERT P10 failed: % lost its seat', v_role;
    end if;
    if (sc.snapshot()->>'revision') is null then
      raise exception 'ASSERT P10b failed: % cannot read the event', v_role;
    end if;
  end loop;

  -- == P11. cross-role refusals still come from role_permissions ============
  perform sc.test_as(v_b);
  v := sc.handle_command('END_EVENT', '{"reason":"x"}'::jsonb, 0, 'perm-lobby-end');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT P11a failed: %', v; end if;
  perform sc.test_as(v_c);
  v := sc.handle_command('CONFIGURE', '{"prep_allowance_ms":90000}'::jsonb, 0, 'perm-gate-config');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT P11b failed: %', v; end if;
  v := sc.handle_command('CALL_TEAM', '{}'::jsonb, 0, 'perm-gate-call');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT P11c failed: %', v; end if;
  perform sc.test_as(v_f);
  v := sc.handle_command('REVIEW_RESOLVE', '{"round_id":"0","decision":"ACCEPT","reason":"x"}'::jsonb, 0, 'perm-sup-review');
  if v->>'code' = 'PERMISSION_DENIED' then
    raise exception 'ASSERT P11d failed: SUPERVISOR was refused its own action: %', v;
  end if;

  -- == P12. session revocation mid-shift, then the link works again =========
  perform sc.test_as(v_d);
  v := sc.release_device();
  if v->>'code' <> 'RELEASED' or v->>'role' <> 'CORRIDOR' then
    raise exception 'ASSERT P12a failed: %', v;
  end if;
  v := sc.handle_command('HALLWAY_PROGRESS', '{}'::jsonb, 0, 'perm-corridor-revoked');
  if v->>'code' <> 'PERMISSION_DENIED' then
    raise exception 'ASSERT P12b failed: a revoked session still commanded: %', v;
  end if;
  if (public.station_board()->>'occupied')::int <> 4 then
    raise exception 'ASSERT P12c failed: the board did not free CORRIDOR';
  end if;
  v := sc.test_redeem(v_d, v_tok_corridor, 'perm-D');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'CORRIDOR' then
    raise exception 'ASSERT P12d failed: the same link did not restore the seat: %', v;
  end if;

  -- == P13. releasing a phone does not touch the link row at all ===========
  perform sc.test_as(v_a); -- unbound since P7
  v := sc.test_redeem(v_a, v_tok_lobby2, 'perm-A');
  if v->>'code' <> 'ROLE_TAKEN' then
    raise exception 'ASSERT P13 failed: the second LOBBY link bypassed the seat: %', v;
  end if;
end $$;

-- ===================== catalog truth: permanent semantics, no auto-release ===
reset role;

do $$
declare
  v_state record;
  v_src text;
  v_new record;
  v_blocked boolean := false;
begin
  -- The permanent LOBBY link: ACTIVE, NEVER EXPIRES, only "last bound" recorded.
  select revoked_at, expires_at, claimed_at into v_state
    from sc.invitations where label = 'Lan' order by created_at desc limit 1;
  if v_state.revoked_at is not null then
    raise exception 'ASSERT Q1 failed: the permanent link was revoked by redemption';
  end if;
  if v_state.expires_at is not null then
    raise exception 'ASSERT Q2 failed: the permanent link carries an expiry %', v_state.expires_at;
  end if;
  if v_state.claimed_at is null then
    raise exception 'ASSERT Q3 failed: the last bind was not recorded for audit';
  end if;

  -- The legacy-dated link still bound, and is still ACTIVE.
  select revoked_at, expires_at, claimed_at into v_state
    from sc.invitations where label = 'Legacy date';
  if v_state.revoked_at is not null then raise exception 'ASSERT Q4 failed: legacy link was revoked'; end if;
  if v_state.expires_at is null then raise exception 'ASSERT Q5 failed: seeding lost the legacy date'; end if;
  if v_state.claimed_at is null then raise exception 'ASSERT Q6 failed: legacy-dated link never bound'; end if;

  -- Burned rows stay burned: 0007 must never resurrect a test token.
  select revoked_at into v_state from sc.invitations where label = 'Burned';
  if v_state.revoked_at is null then
    raise exception 'ASSERT Q7 failed: a revoked link came back to life';
  end if;

  -- Redemption must not contain any consumption or expiry logic.
  select prosrc into v_src from pg_proc where proname = 'redeem_invitation' and pronamespace = 'sc'::regnamespace;
  if v_src is null then raise exception 'ASSERT Q8 failed: redeem_invitation missing'; end if;
  if v_src like '%revoked_at = now()%' then
    raise exception 'ASSERT Q9 failed: redemption still revokes the link';
  end if;
  if v_src like '%expires_at%' then
    raise exception 'ASSERT Q10 failed: redemption still looks at expiry';
  end if;
  if v_src not like '%pg_advisory_xact_lock(30501)%' then
    raise exception 'ASSERT Q11 failed: the redemption lock is gone';
  end if;

  -- Nothing but release_device may retire a binding: no TTL, no heartbeat.
  if exists (
    select 1 from pg_proc
     where pronamespace = 'sc'::regnamespace
       and proname <> 'release_device'
       and prosrc like '%revoked_at = now()%'
  ) then
    raise exception 'ASSERT Q12 failed: another function retires bindings on its own';
  end if;

  -- One live device per role is a database constraint, not just a check.
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'sc' and indexname = 'operators_one_active_per_role'
       and indexdef like '%UNIQUE%' and indexdef like '%revoked_at IS NULL%'
  ) then
    raise exception 'ASSERT Q13 failed: the partial unique index is missing';
  end if;
  if (select count(*) from sc.operators where revoked_at is null) <> 5 then
    raise exception 'ASSERT Q14 failed: expected five live seats, found %',
      (select count(*) from sc.operators where revoked_at is null);
  end if;

  -- A concurrent insert for an occupied station is refused by the index itself.
  begin
    insert into sc.operators (user_id, role, display_name)
    values ('bbbbbbbb-0000-4000-8000-000000000008', 'LOBBY', 'Storm');
  exception when unique_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERT Q15 failed: a second live LOBBY binding was accepted';
  end if;
  if exists (select 1 from sc.operators where user_id = 'bbbbbbbb-0000-4000-8000-000000000008') then
    raise exception 'ASSERT Q16 failed: the refused insert left a row behind';
  end if;

  raise notice 'permanent links ok · 5 live seats · link rows untouched by redemption';
end $$;

select '031 permanent links: reuse, exclusive seat, no takeover, no auto-release — all asserted' as result;
