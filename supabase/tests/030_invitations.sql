-- SCREAM CONTROL — Room 305 · V2 · PASS 5
-- Invitation links: anonymous identity → device-bound operator role, one live
-- device per role, no takeover of an occupied station, the five-seat board and
-- its link lock, and the privilege boundary around the whole thing.
-- Run with:  npm run test:sql
--
-- Every failing expectation raises an exception, so a clean run means the
-- production SQL refuses the same things the brief says it must refuse.

\set ON_ERROR_STOP on

-- ------------------------------------------------------------------- seeding
-- A project that has just applied the invitation migration has no live binding.
update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.invitations;

insert into auth.users (id) values
  ('aaaaaaaa-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-000000000002'),
  ('aaaaaaaa-0000-4000-8000-000000000003'),
  ('aaaaaaaa-0000-4000-8000-000000000004'),
  ('aaaaaaaa-0000-4000-8000-000000000005'),
  ('aaaaaaaa-0000-4000-8000-000000000006'),
  ('aaaaaaaa-0000-4000-8000-000000000007')
on conflict (id) do nothing;

-- Minted exactly like scripts/mint-invites.mjs: only the SHA-256 of a 256-bit
-- token is stored, and the invitation carries the station it may bind.
insert into sc.invitations (role, mode, token_hash, label, expires_at) values
  ('LOBBY',      'claim',    extensions.digest('lobby-8b1f4c2e9a7d6f30b5c8e1a4d7f0b3c6a9e2', 'sha256'), 'Lan',  now() + interval '30 days'),
  ('GATE',       'claim',    extensions.digest('gate-4c7a0e3b9d2f5a8c1e4b7d0f3a6c9e2015b8', 'sha256'), 'Hung', now() + interval '30 days'),
  ('CORRIDOR',   'claim',    extensions.digest('corridor-9d2f5a8c1e4b7d0f3a6c9e2b5d8f1a40e7c3', 'sha256'), 'Ngoc', now() + interval '30 days'),
  ('ROOM305',    'claim',    extensions.digest('room305-3f6a9c2e5b8d1f4a7c0e3b6d9f2a5c8014e7', 'sha256'), 'Tuan', now() + interval '30 days'),
  ('SUPERVISOR', 'claim',    extensions.digest('supervisor-7c0e3b6d9f2a5c8e1b4d7f0a3c6e9b2d5f10', 'sha256'), 'Mai', now() + interval '30 days'),
  -- a replacement phone for GATE, mints by the organiser only
  ('GATE',       'reassign', extensions.digest('gate-reassign-1a4d7f0b3c6a9e2d5b8f1c4e7a0d3b6c92', 'sha256'), 'Hung', now() + interval '1 day'),
  -- spare links the organiser would re-issue later (still unused at test time)
  ('LOBBY',      'claim',    extensions.digest('lobby-spare-2c5a8d1f4b7e0a3c6f9b2d5e8a1c4f7b09', 'sha256'), 'Lan B', now() + interval '30 days'),
  ('GATE',       'claim',    extensions.digest('gate-spare-7d0f3b6c9a2e5f8b1d4a7c0e3b6f9a2d58', 'sha256'), 'Hung B', now() + interval '30 days'),
  ('ROOM305',    'claim',    extensions.digest('room305-spare-6e9c2a5f8b1d4f7a0c3e6b9d2f5a8c1e04b7', 'sha256'), 'Tuan B', now() + interval '30 days');

insert into sc.invitations (role, mode, token_hash, label, expires_at, revoked_at) values
  ('ROOM305', 'claim', extensions.digest('expired-111111111111111111111111111111111111', 'sha256'), 'Old', now() - interval '1 day', null),
  ('ROOM305', 'claim', extensions.digest('revoked-222222222222222222222222222222222222', 'sha256'), 'Gone', now() + interval '30 days', now());

-- Test-only: act as one anonymous device with a given token.
create or replace function sc.test_redeem(p_uid uuid, p_token text, p_device text default 'device-a')
returns jsonb
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('request.jwt.claims',
                     jsonb_build_object('sub', p_uid::text, 'is_anonymous', true)::text, false);
  return sc.redeem_invitation(p_token, p_device);
end $$;

create or replace function sc.test_as(p_uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claim.sub', p_uid::text, false);
  select set_config('request.jwt.claims',
                    jsonb_build_object('sub', p_uid::text, 'is_anonymous', true)::text, false);
$$;

grant execute on function sc.test_redeem(uuid, text, text) to authenticated;
grant execute on function sc.test_as(uuid) to authenticated;

-- --------------------------------------------------------------- the session
set role authenticated;

do $$
declare
  v_lob  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  v_gat  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000002';
  v_rep  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000003';
  v_sup  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000004';
  v_cor  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000006';
  v_rom  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000007';
  v_tok_lobby    constant text := 'lobby-8b1f4c2e9a7d6f30b5c8e1a4d7f0b3c6a9e2';
  v_tok_gate     constant text := 'gate-4c7a0e3b9d2f5a8c1e4b7d0f3a6c9e2015b8';
  v_tok_corridor constant text := 'corridor-9d2f5a8c1e4b7d0f3a6c9e2b5d8f1a40e7c3';
  v_tok_room305  constant text := 'room305-3f6a9c2e5b8d1f4a7c0e3b6d9f2a5c8014e7';
  v_tok_gate_new constant text := 'gate-reassign-1a4d7f0b3c6a9e2d5b8f1c4e7a0d3b6c92';
  v_tok_lobby_spare constant text := 'lobby-spare-2c5a8d1f4b7e0a3c6f9b2d5e8a1c4f7b09';
  v_tok_gate_spare  constant text := 'gate-spare-7d0f3b6c9a2e5f8b1d4a7c0e3b6f9a2d58';
  v_tok_room_spare  constant text := 'room305-spare-6e9c2a5f8b1d4f7a0c3e6b9d2f5a8c1e04b7';
  v_tok_sup      constant text := 'supervisor-7c0e3b6d9f2a5c8e1b4d7f0a3c6e9b2d5f10';
  v jsonb; v_board jsonb; v_role text; v_name text; v_device text; v_anon boolean; v_rows int;
begin
  -- == 1. a link binds exactly one role, and bootstraps the event =========
  v := sc.test_redeem(v_lob, v_tok_lobby, 'pixel-lobby');
  if v->>'ok' <> 'true' or v->>'code' <> 'BOUND' or v->>'role' <> 'LOBBY' then
    raise exception 'ASSERT 1a failed: %', v;
  end if;
  if (v->>'event_id') is null then
    raise exception 'ASSERT 1b failed: no event id in %', v;
  end if;
  select role into v_role from sc.operators where user_id = v_lob;
  select display_name into v_name from sc.operators where user_id = v_lob;
  if v_role <> 'LOBBY' or v_name <> 'Lan' then
    raise exception 'ASSERT 1c failed: role % name %', v_role, v_name;
  end if;
  if sc.my_role() <> 'LOBBY' then
    raise exception 'ASSERT 1d failed: my_role is %', sc.my_role();
  end if;

  select device_id, is_anonymous into v_device, v_anon from sc.operators where user_id = v_lob;
  if v_device <> 'pixel-lobby' or v_anon is not true then
    raise exception 'ASSERT 1e failed: device % anonymous %', v_device, v_anon;
  end if;
  if (sc.whoami()->>'role') <> 'LOBBY' then
    raise exception 'ASSERT 1f failed: whoami %', sc.whoami();
  end if;
  if (sc.whoami()->>'user_id') <> v_lob::text then
    raise exception 'ASSERT 1g failed: whoami user mismatch %', sc.whoami();
  end if;

  -- == 2. the same phone reopening its own link is idempotent ============
  v := sc.test_redeem(v_lob, v_tok_lobby, 'pixel-lobby');
  if v->>'code' <> 'ALREADY_BOUND' or v->>'role' <> 'LOBBY' then
    raise exception 'ASSERT 2 failed: %', v;
  end if;

  -- == 3. a second phone cannot take a role that is already live ==========
  v := sc.test_redeem(v_gat, v_tok_lobby_spare, 'pixel-gate');
  if v->>'code' <> 'ROLE_TAKEN' then
    raise exception 'ASSERT 3 failed: %', v;
  end if;
  select count(*) into v_rows from sc.operators where user_id = v_gat;
  if v_rows <> 0 then
    raise exception 'ASSERT 3b failed: a refused redemption still wrote a row';
  end if;
  -- RLS-scoped proof: the refused phone itself resolves no role at all.
  perform sc.test_as(v_gat);
  if sc.my_role() is not null then
    raise exception 'ASSERT 3c failed: a refused phone resolves %', sc.my_role();
  end if;

  -- == 4. a bound device can never promote itself ========================
  v := sc.test_redeem(v_gat, v_tok_gate, 'pixel-gate');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'GATE' then
    raise exception 'ASSERT 4 failed: %', v;
  end if;
  v := sc.test_redeem(v_gat, v_tok_lobby, 'pixel-gate');
  if v->>'code' <> 'ALREADY_BOUND_OTHER_ROLE' then
    raise exception 'ASSERT 4b failed: %', v;
  end if;
  v := sc.test_redeem(v_gat, v_tok_sup, 'pixel-gate');
  if v->>'code' <> 'ALREADY_BOUND_OTHER_ROLE' then
    raise exception 'ASSERT 4c failed: a GATE phone reached SUPERVISOR: %', v;
  end if;
  if sc.my_role() <> 'GATE' then
    raise exception 'ASSERT 4d failed: role changed to %', sc.my_role();
  end if;

  -- == 5. unknown, expired and revoked links are all refused =============
  v := sc.test_redeem(v_rep, 'not-a-real-token-0000000000000000000000000000', 'pixel-rep');
  if v->>'code' <> 'INVITATION_INVALID' then
    raise exception 'ASSERT 5a failed: %', v;
  end if;
  v := sc.test_redeem(v_rep, 'expired-111111111111111111111111111111111111', 'pixel-rep');
  if v->>'code' <> 'INVITATION_INVALID' then
    raise exception 'ASSERT 5b failed: %', v;
  end if;
  v := sc.test_redeem(v_rep, 'revoked-222222222222222222222222222222222222', 'pixel-rep');
  if v->>'code' <> 'INVITATION_INVALID' then
    raise exception 'ASSERT 5c failed: %', v;
  end if;
  v := sc.test_redeem(v_rep, '', 'pixel-rep');
  if v->>'code' <> 'INVITATION_INVALID' then
    raise exception 'ASSERT 5d failed: empty token accepted: %', v;
  end if;

  -- == 5e. a spent link is single use: another device gets nothing =========
  v := sc.test_redeem(v_rep, v_tok_lobby, 'pixel-rep');
  if v->>'code' <> 'INVITATION_INVALID' then
    raise exception 'ASSERT 5e (replayed link) failed: %', v;
  end if;
  select count(*) into v_rows from sc.operators where user_id = v_rep;
  if v_rows <> 0 then
    raise exception 'ASSERT 5f failed: a replayed link still wrote a binding';
  end if;
  if sc.my_role() is not null then
    raise exception 'ASSERT 5g failed: the replaying phone resolves %', sc.my_role();
  end if;

  -- == 6. a live station cannot be taken over by any link =================
  -- GATE is on duty on v_gat. Neither the replacement link nor a spare claim
  -- link may evict it: the station stays red until its own phone releases it.
  v := sc.test_redeem(v_rep, v_tok_gate_new, 'pixel-rep');
  if v->>'code' <> 'ROLE_TAKEN' then
    raise exception 'ASSERT 6a failed: a replacement link evicted a live station: %', v;
  end if;
  v := sc.test_redeem(v_rep, v_tok_gate_spare, 'pixel-rep');
  if v->>'code' <> 'ROLE_TAKEN' then
    raise exception 'ASSERT 6b failed: a spare claim link evicted a live station: %', v;
  end if;
  select count(*) into v_rows from sc.operators where user_id = v_rep;
  if v_rows <> 0 then
    raise exception 'ASSERT 6c failed: a refused takeover still wrote a row';
  end if;
  if sc.my_role() is not null then
    raise exception 'ASSERT 6cc failed: the refused takeover phone resolves %', sc.my_role();
  end if;
  perform sc.test_as(v_gat);
  if sc.my_role() <> 'GATE' then
    raise exception 'ASSERT 6d failed: the phone on duty lost its station to a link';
  end if;

  -- == 7. only the phone on duty frees its seat ===========================
  perform sc.test_as(v_rep);
  v := sc.release_device();
  if v->>'code' <> 'NOT_BOUND' then
    raise exception 'ASSERT 7a failed: an unbound phone released a station: %', v;
  end if;
  perform sc.test_as(v_gat);
  if sc.my_role() <> 'GATE' then
    raise exception 'ASSERT 7b failed: an unbound release dropped the live binding';
  end if;
  -- its own phone may still free it (ĐỔI MÁY), and a fresh link binds it again
  v := sc.release_device();
  if v->>'code' <> 'RELEASED' or v->>'role' <> 'GATE' then
    raise exception 'ASSERT 7c failed: %', v;
  end if;
  if sc.my_role() is not null then
    raise exception 'ASSERT 7d failed: a released device still resolves a role';
  end if;
  -- a spent link is still spent; a freshly minted one binds the freed seat
  v := sc.test_redeem(v_gat, v_tok_gate, 'pixel-gate');
  if v->>'code' <> 'INVITATION_INVALID' then
    raise exception 'ASSERT 7e failed: a spent claim link re-bound a phone: %', v;
  end if;
  v := sc.test_redeem(v_gat, v_tok_gate_spare, 'pixel-gate');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'GATE' then
    raise exception 'ASSERT 7f failed: a freed seat refused a fresh link: %', v;
  end if;

  -- == 8. SUPERVISOR is reachable only through its own link ==============
  v := sc.test_redeem(v_sup, v_tok_sup, 'pixel-sup');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'SUPERVISOR' then
    raise exception 'ASSERT 8a failed: %', v;
  end if;
  perform sc.test_as(v_lob);
  v := sc.handle_command('END_EVENT', '{"reason":"test"}'::jsonb, 0, 'lobby-end');
  if v->>'code' <> 'PERMISSION_DENIED' then
    raise exception 'ASSERT 8b failed: LOBBY could end the event: %', v;
  end if;
  perform sc.test_as(v_sup);
  v := sc.handle_command('END_EVENT', '{"reason":"test"}'::jsonb, 0, 'sup-end');
  if v->>'code' = 'PERMISSION_DENIED' then
    raise exception 'ASSERT 8c failed: SUPERVISOR was refused its own action: %', v;
  end if;

  -- == 8b. the remaining station links bind only their own role ===========
  v := sc.test_redeem(v_cor, v_tok_corridor, 'pixel-corridor');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'CORRIDOR' then
    raise exception 'ASSERT 8d failed: %', v;
  end if;
  v := sc.test_redeem(v_rom, v_tok_room305, 'pixel-room305');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'ROOM305' then
    raise exception 'ASSERT 8e failed: %', v;
  end if;

  -- == 8c. each station has exactly the rights its role grants =============
  perform sc.test_as(v_lob);
  v := sc.handle_command('START_GAME', '{}'::jsonb, 0, 'lobby-start');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 8f (LOBBY START) failed: %', v; end if;
  v := sc.handle_command('GAME_STOP', '{}'::jsonb, 0, 'lobby-stop');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 8g (LOBBY STOP) failed: %', v; end if;
  v := sc.handle_command('PUZZLE_COMPLETE', '{}'::jsonb, 0, 'lobby-complete');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 8h (LOBBY COMPLETE) failed: %', v; end if;
  v := sc.handle_command('GAME_RESET', '{}'::jsonb, 0, 'lobby-reset');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 8i (LOBBY RESET) failed: %', v; end if;

  perform sc.test_as(v_gat);
  v := sc.handle_command('START_GAME', '{}'::jsonb, 0, 'gate-start');
  if v->>'code' = 'PERMISSION_DENIED' then raise exception 'ASSERT 8j (GATE START) failed: %', v; end if;
  v := sc.handle_command('GAME_STOP', '{}'::jsonb, 0, 'gate-stop');
  if v->>'code' = 'PERMISSION_DENIED' then raise exception 'ASSERT 8k (GATE STOP) failed: %', v; end if;
  v := sc.handle_command('CALL_TEAM', '{}'::jsonb, 0, 'gate-call');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 8l (GATE CALL) failed: %', v; end if;
  v := sc.handle_command('PUZZLE_COMPLETE', '{}'::jsonb, 0, 'gate-complete');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 8m (GATE COMPLETE) failed: %', v; end if;
  v := sc.handle_command('END_EVENT', '{"reason":"test"}'::jsonb, 0, 'gate-end');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 8n (GATE END) failed: %', v; end if;

  perform sc.test_as(v_cor);
  v := sc.handle_command('HALLWAY_PROGRESS', '{}'::jsonb, 0, 'corridor-hall');
  if v->>'code' = 'PERMISSION_DENIED' then raise exception 'ASSERT 8o (CORRIDOR hallway) failed: %', v; end if;
  v := sc.handle_command('START_GAME', '{}'::jsonb, 0, 'corridor-start');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 8p (CORRIDOR START) failed: %', v; end if;
  v := sc.handle_command('GAME_STOP', '{}'::jsonb, 0, 'corridor-stop');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 8q (CORRIDOR STOP) failed: %', v; end if;

  perform sc.test_as(v_rom);
  v := sc.handle_command('PUZZLE_COMPLETE', '{}'::jsonb, 0, 'room-complete');
  if v->>'code' = 'PERMISSION_DENIED' then raise exception 'ASSERT 8r (ROOM COMPLETE) failed: %', v; end if;
  v := sc.handle_command('START_GAME', '{}'::jsonb, 0, 'room-start');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 8s (ROOM START) failed: %', v; end if;
  v := sc.handle_command('CALL_TEAM', '{}'::jsonb, 0, 'room-call');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 8t (ROOM CALL) failed: %', v; end if;

  perform sc.test_as(v_sup);
  v := sc.handle_command('GAME_RESET', '{}'::jsonb, 0, 'sup-reset');
  if v->>'code' = 'PERMISSION_DENIED' then raise exception 'ASSERT 8u (SUP RESET) failed: %', v; end if;
  v := sc.handle_command('REVIEW_RESOLVE', '{"round_id":"0","decision":"ACCEPT","reason":"test"}'::jsonb, 0, 'sup-review');
  if v->>'code' = 'PERMISSION_DENIED' then raise exception 'ASSERT 8v (SUP REVIEW) failed: %', v; end if;

  -- == 8w. all five stations on duty: the board is red and the links lock ==
  v_board := public.station_board();
  if (v_board->>'capacity')::int <> 5 or (v_board->>'occupied')::int <> 5 then
    raise exception 'ASSERT 8w failed: board %', v_board;
  end if;
  if (v_board->>'locked')::boolean is not true then
    raise exception 'ASSERT 8x failed: a full board was not locked: %', v_board;
  end if;
  if exists (select 1 from jsonb_array_elements(v_board->'stations') s
              where (s->>'occupied')::boolean is not true) then
    raise exception 'ASSERT 8y failed: a full board still shows a free station: %', v_board;
  end if;

  -- == 8z. a sixth phone is locked out, even holding a live link ==========
  v := sc.test_redeem(v_rep, v_tok_gate_new, 'pixel-rep');
  if v->>'code' <> 'STATIONS_LOCKED' then
    raise exception 'ASSERT 8z failed: a sixth phone joined a full board: %', v;
  end if;
  select count(*) into v_rows from sc.operators where user_id = v_rep;
  if v_rows <> 0 then
    raise exception 'ASSERT 8aa failed: a locked-out phone still wrote a binding';
  end if;
  -- and the server agrees it holds nothing, independent of RLS
  if public.whoami() is not null then
    raise exception 'ASSERT 8aa2 failed: the locked-out phone resolved a station: %', public.whoami();
  end if;

  -- == 8ab. the lock never touches a phone that is already on duty ========
  -- counted through the board: it is SECURITY DEFINER, whereas sc.operators is
  -- not readable across users under RLS
  if ((public.station_board()->>'occupied')::int) <> 5 then
    raise exception 'ASSERT 8ab failed: % live bindings after a refused sixth phone',
      public.station_board()->>'occupied';
  end if;
  v := sc.test_redeem(v_lob, v_tok_lobby, 'pixel-lobby');
  if v->>'code' <> 'ALREADY_BOUND' or v->>'role' <> 'LOBBY' then
    raise exception 'ASSERT 8ac failed: a bound phone lost its station to the lock: %', v;
  end if;
  v := sc.test_redeem(v_lob, v_tok_gate_new, 'pixel-lobby');
  if v->>'code' <> 'ALREADY_BOUND_OTHER_ROLE' then
    raise exception 'ASSERT 8ad failed: a bound phone switched stations while locked: %', v;
  end if;
  perform sc.test_as(v_gat);
  if sc.my_role() <> 'GATE' then
    raise exception 'ASSERT 8ae failed: GATE lost its station while the board is locked';
  end if;

  -- == 9. an unbound anonymous phone cannot read or command the state ======
  perform sc.test_as('aaaaaaaa-0000-4000-8000-000000000005');
  begin
    perform public.snapshot();
    raise exception 'ASSERT 9a failed: an unbound phone read the snapshot';
  exception when others then
    if sqlerrm not like '%PERMISSION_DENIED%' then raise; end if;
  end;
  v := public.handle_command('START_GAME', '{}'::jsonb, 0, 'unbound-http');
  if v->>'code' <> 'PERMISSION_DENIED' then
    raise exception 'ASSERT 9b failed: an unbound phone issued an HTTP command: %', v;
  end if;

  -- == 9c. a released phone fails closed on the browser-facing API too =====
  perform sc.test_as(v_rom);
  v := sc.release_device();
  if v->>'code' <> 'RELEASED' or v->>'role' <> 'ROOM305' then
    raise exception 'ASSERT 9c failed: %', v;
  end if;
  v := public.handle_command('START_GAME', '{}'::jsonb, 0, 'released-http');
  if v->>'code' <> 'PERMISSION_DENIED' then
    raise exception 'ASSERT 9d failed: a released phone reached the HTTP command: %', v;
  end if;
  begin
    perform sc.operation_status('released-http');
    raise exception 'ASSERT 9e failed: a released phone read its operation status';
  exception when others then
    if sqlerrm not like '%PERMISSION_DENIED%' then raise; end if;
  end;

  -- == 12. releasing one seat unlocks that seat, not the whole board ======
  v_board := public.station_board();
  if (v_board->>'locked')::boolean then
    raise exception 'ASSERT 12a failed: the board stayed locked after a release: %', v_board;
  end if;
  if (v_board->>'occupied')::int <> 4 then
    raise exception 'ASSERT 12b failed: occupied % after a release', v_board->>'occupied';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_board->'stations') s
                  where s->>'role' = 'ROOM305' and (s->>'occupied')::boolean is false) then
    raise exception 'ASSERT 12c failed: ROOM305 stayed red after its release: %', v_board;
  end if;
  -- a fresh link binds the freed station...
  v := sc.test_redeem(v_rep, v_tok_room_spare, 'pixel-rep');
  if v->>'code' <> 'BOUND' or v->>'role' <> 'ROOM305' then
    raise exception 'ASSERT 12d failed: a freed seat refused a fresh phone: %', v;
  end if;
  -- ...and five on duty locks every link again
  v_board := public.station_board();
  if (v_board->>'locked')::boolean is not true then
    raise exception 'ASSERT 12e failed: a refilled board was not locked: %', v_board;
  end if;
end $$;

-- ------------------------------------------------------- privilege boundary
reset role;

do $$
begin
  if has_function_privilege('anon', 'public.redeem_invitation(text,text)', 'EXECUTE') then
    raise exception 'ASSERT 10a failed: anon can redeem invitations';
  end if;
  if has_function_privilege('anon', 'sc.handle_command(text,jsonb,bigint,text)', 'EXECUTE') then
    raise exception 'ASSERT 10b failed: anon can issue commands';
  end if;
  if not has_function_privilege('authenticated', 'public.redeem_invitation(text,text)', 'EXECUTE') then
    raise exception 'ASSERT 10c failed: an anonymous session cannot redeem';
  end if;
  if has_table_privilege('authenticated', 'sc.invitations', 'SELECT')
     or has_table_privilege('authenticated', 'sc.invitations', 'INSERT') then
    raise exception 'ASSERT 10d failed: clients can read the invitation table';
  end if;
  if has_table_privilege('authenticated', 'sc.operators', 'INSERT')
     or has_table_privilege('authenticated', 'sc.operators', 'UPDATE') then
    raise exception 'ASSERT 10e failed: clients can write their own role';
  end if;
  if has_function_privilege('anon', 'public.handle_command(text,jsonb,bigint,text)', 'EXECUTE') then
    raise exception 'ASSERT 10g failed: anon can issue commands through the public wrapper';
  end if;
  if not has_function_privilege('authenticated', 'public.handle_command(text,jsonb,bigint,text)', 'EXECUTE') then
    raise exception 'ASSERT 10h failed: a bound session cannot use the public command wrapper';
  end if;
  if has_function_privilege('authenticated', 'sc._handle_command_internal(text,jsonb,bigint,text)', 'EXECUTE') then
    raise exception 'ASSERT 10i failed: the internal command entry point is callable';
  end if;
  -- the board is public (station roles only) but its sc helper stays internal
  if not has_function_privilege('anon', 'public.station_board()', 'EXECUTE') then
    raise exception 'ASSERT 10j failed: an anonymous phone cannot read the station board';
  end if;
  if not has_function_privilege('authenticated', 'public.station_board()', 'EXECUTE') then
    raise exception 'ASSERT 10k failed: a bound phone cannot read the station board';
  end if;
  if has_function_privilege('authenticated', 'sc.station_board()', 'EXECUTE') then
    raise exception 'ASSERT 10l failed: the internal board helper is callable';
  end if;
  -- Nothing internal may stay callable from a browser session.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'sc'
       and (p.proname like '\_%' escape '\' or p.proname in ('tick', 'operator_states'))
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception 'ASSERT 10f failed: an internal sc helper is still callable';
  end if;
end $$;

-- == 11. an empty database gets its event and state on first redemption ====
do $$
declare v_event bigint; v_state int;
begin
  delete from sc.state;
  v_event := sc._ensure_event();
  select count(*) into v_state from sc.state where id = true;
  if v_state <> 1 then
    raise exception 'ASSERT 11a failed: state was not recreated';
  end if;
  if v_event <> (select event_id from sc.state where id = true) then
    raise exception 'ASSERT 11b failed: state points at another event';
  end if;
end $$;

-- == 13. the board is the one thing an anonymous phone may read ============
set role anon;
do $$
declare b jsonb;
begin
  b := public.station_board();
  if jsonb_array_length(b->'stations') <> 5 then
    raise exception 'ASSERT 13a failed: anonymous board %', b;
  end if;
  if (b->>'capacity')::int <> 5 or (b->>'occupied')::int <> 5 then
    raise exception 'ASSERT 13b failed: anonymous board %', b;
  end if;
  -- it carries station roles only: no names, devices or tokens
  if exists (select 1 from jsonb_array_elements(b->'stations') s
              where s ? 'display_name' or s ? 'device_id') then
    raise exception 'ASSERT 13c failed: the board leaks operator details: %', b;
  end if;
end $$;
reset role;

-- ============================================================== invitations
select '030 invitations: binds, refusals, no takeover, board, link lock, privilege boundary — all asserted' as result;
