-- SCREAM CONTROL — Room 305 · hardening validation (P0-01/05/06 + Scenario C/G).
-- Runs after 010_scenario.sql against the same local Postgres, on a fresh event.

\set ON_ERROR_STOP on

reset role;
insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
                       hidden_object_owner, hiding_layout, review_threshold_ms)
values ('Hardening event', 5400000, 300000, 90000, 90000, 'CORRIDOR', 'B', 500);

update sc.state
   set event_id = (select id from sc.events where name = 'Hardening event'),
       revision = 0,
       updated_at = sc.now_ms()
 where id = true;

set role authenticated;

do $$
declare
  v_sup constant uuid := '00000000-0000-0000-0000-000000000001';
  v_lob constant uuid := '00000000-0000-0000-0000-000000000002';
  v_gat constant uuid := '00000000-0000-0000-0000-000000000003';
  v_cor constant uuid := '00000000-0000-0000-0000-000000000004';
  v_rom constant uuid := '00000000-0000-0000-0000-000000000005';
  v jsonb; v_round jsonb; v_round_id bigint; v_snap jsonb; v_found boolean;
begin
  -- == 13. Scenario C: layout is prepared by the assigned operator ===========
  v := sc.act_as(v_rom, 'SET_LAYOUT', '{"layout":"C"}');
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 13a failed: %', v; end if;
  v := sc.act_as(v_cor, 'SET_LAYOUT', '{"layout":"C"}');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 13b failed: %', v; end if;

  -- The first dispatch anchors the 90:00, so no separate start press exists.
  v := sc.act_as(v_lob, 'CALL_TEAM');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 13d failed: %', v; end if;
  v_snap := sc.snapshot();
  if v_snap->'rounds'->0->>'hiding_layout' <> 'C' then
    raise exception 'ASSERT 13e (layout recorded with the team) failed: %', v_snap->'rounds'->0;
  end if;

  -- == 14. P0-01: press vs server commit is recorded, and disputes are flagged
  v := sc.act_as(v_gat, 'START_GAME');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 14a failed: %', v; end if;
  -- Always scope to the event this scenario drives: earlier events keep their rows.
  v_round_id := (select r.id from sc.rounds r join sc.state s on s.event_id = r.event_id
                  where s.id = true order by r.round_number desc limit 1);

  -- Simulate a STOP whose reply reached the server 1.5 s after the physical tap.
  perform set_config('request.jwt.claim.sub', v_gat::text, false);
  v := sc.handle_command('GAME_STOP',
        jsonb_build_object('_press', jsonb_build_object('press_ms', sc.now_ms() - 1500, 'rtt_ms', 1200)),
        (select revision from sc.events where id = (select event_id from sc.state where id = true)),
        'slow-stop-key');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 14b failed: %', v; end if;

  select to_jsonb(r) into v_round from sc.rounds r where id = v_round_id;
  if (v_round->>'stop_transport_ms')::bigint < 1400 then
    raise exception 'ASSERT 14c (transport delay recorded) failed: %', v_round->>'stop_transport_ms';
  end if;
  if (v_round->>'needs_review')::boolean is not true then
    raise exception 'ASSERT 14d (slow STOP must be disputed) failed';
  end if;
  if not exists (select 1 from sc.rounds where id = v_round_id and 'STOP_TRANSPORT' = any (review_reasons)) then
    raise exception 'ASSERT 14e (review reason) failed';
  end if;
  -- The official timestamp itself is the server value, never the invented press time.
  if (v_round->>'game_stopped_at')::bigint <> (v_round->>'exit_confirmed_at')::bigint then
    raise exception 'ASSERT 14f (authoritative stop instant) failed';
  end if;

  -- == 15. P0-06: reopening a reset revokes readiness and invalidates DONE marks
  v := sc.act_as(v_cor, 'RESET_DONE');           -- hallway + hidden objects
  if not (v->>'ok')::boolean then raise exception 'ASSERT 15a failed: %', v; end if;
  v := sc.act_as(v_rom, 'RESET_DONE');           -- room 305
  if not (v->>'ok')::boolean then raise exception 'ASSERT 15b failed: %', v; end if;
  if not exists (select 1 from sc.reset_tasks
                  where round_id = v_round_id and task_key = 'hidden_objects' and layout = 'C') then
    raise exception 'ASSERT 15c (layout stamped with the placement task) failed';
  end if;
  v := sc.act_as(v_gat, 'GATE_FINALIZE');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 15d failed: %', v; end if;

  -- a supervisor notices the mannequin was never reset
  v := sc.act_as(v_gat, 'REOPEN_RESET', jsonb_build_object('round_id', v_round_id::text, 'reason', 'Manocung chua dat'));
  if v->>'code' <> 'PERMISSION_DENIED' then raise exception 'ASSERT 15e (only supervisor reopens) failed: %', v; end if;
  v := sc.act_as(v_sup, 'REOPEN_RESET', jsonb_build_object('round_id', v_round_id::text));
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 15f (reopen needs a reason) failed: %', v; end if;
  v := sc.act_as(v_sup, 'REOPEN_RESET', jsonb_build_object('round_id', v_round_id::text, 'reason', 'Manocung chua dat'));
  if not (v->>'ok')::boolean then raise exception 'ASSERT 15g failed: %', v; end if;

  if exists (select 1 from sc.reset_tasks where round_id = v_round_id and completed_at is not null) then
    raise exception 'ASSERT 15h (old DONE marks survived the reopen) failed';
  end if;
  if (select reset_cycle from sc.rounds where id = v_round_id) <> 2 then
    raise exception 'ASSERT 15i (cycle did not advance) failed: %',
      (select reset_cycle from sc.rounds where id = v_round_id);
  end if;
  if (select system_ready_at from sc.rounds where id = v_round_id) is not null then
    raise exception 'ASSERT 15j (READY was not revoked) failed';
  end if;
  -- dispatch must now be blocked again
  v := sc.act_as(v_lob, 'CALL_TEAM');
  if v->>'code' <> 'INVALID_STATE' then raise exception 'ASSERT 15k (dispatch after reopen) failed: %', v; end if;

  -- re-confirm everything, then finalize
  v := sc.act_as(v_cor, 'RESET_DONE');
  v := sc.act_as(v_rom, 'RESET_DONE');
  v := sc.act_as(v_gat, 'GATE_FINALIZE');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 15l failed: %', v; end if;
  if (select count(*) from sc.reset_tasks where round_id = v_round_id and cycle <> 2) > 0 then
    raise exception 'ASSERT 15m (confirmations not tied to the current cycle) failed';
  end if;

  -- == 16. Scenario G: operation status resolves a lost response =============
  v := sc.act_as(v_lob, 'CALL_TEAM', '{}'::jsonb, 'probe-op-key');
  v := sc.act_as(v_lob, 'CALL_TEAM', '{}'::jsonb, 'probe-op-key'); -- replay: still one round
  if not (v->>'ok')::boolean then raise exception 'ASSERT 16a failed: %', v; end if;
  perform set_config('request.jwt.claim.sub', v_lob::text, false);
  v := sc.operation_status('probe-op-key');
  if (v->>'found')::boolean is not true then raise exception 'ASSERT 16b failed: %', v; end if;
  if v->>'action' <> 'CALL_TEAM' then raise exception 'ASSERT 16c failed: %', v; end if;
  if (select count(*) from sc.rounds r join sc.action_log l on l.round_id = r.id
        where l.idempotency_key = 'probe-op-key') <> 1 then
    raise exception 'ASSERT 16d (duplicate round from replay) failed';
  end if;
  v := sc.operation_status('never-used-key');
  if (v->>'found')::boolean is not false then raise exception 'ASSERT 16e failed: %', v; end if;

  -- == 17. state_revision is enough to detect drift without a full snapshot ===
  v := sc.state_revision();
  if (v->>'revision')::bigint <> (select revision from sc.events where id = (select event_id from sc.state where id = true)) then
    raise exception 'ASSERT 17a (revision drift) failed: %', v;
  end if;
  if (v->>'event_id') is null then raise exception 'ASSERT 17b failed: %', v; end if;

  -- == 18. P0-05: only an explicit supervisor decision ranks a disputed result
  if (select needs_review from sc.rounds where id = v_round_id) is not true then
    raise exception 'ASSERT 18a (dispute must survive finalize) failed: %',
      (select row_to_json(r) from sc.rounds r where r.id = v_round_id);
  end if;
  v := sc.act_as(v_sup, 'REVIEW_RESOLVE', jsonb_build_object('round_id', v_round_id::text, 'decision', 'ACCEPT'));
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 18b (decision needs a reason) failed: %', v; end if;
  v := sc.act_as(v_sup, 'REVIEW_RESOLVE',
        jsonb_build_object('round_id', v_round_id::text, 'decision', 'ACCEPT', 'reason', 'Da kiem tra video cua'));
  if not (v->>'ok')::boolean then raise exception 'ASSERT 18c failed: %', v; end if;
  if (select needs_review from sc.rounds where id = v_round_id) is not false then
    raise exception 'ASSERT 18d failed';
  end if;
  if (select review_resolved_at from sc.rounds where id = v_round_id) is null then
    raise exception 'ASSERT 18e (resolution timestamp) failed';
  end if;
  if (select decertified from sc.rounds where id = v_round_id) is not false then
    raise exception 'ASSERT 18f (accepted result must stay ranked) failed';
  end if;

  -- == 19. P0-07: controlled closure is explicit and reasoned ================
  v := sc.act_as(v_sup, 'END_EVENT');
  if v->>'code' <> 'BLOCKED' then raise exception 'ASSERT 19a (END_EVENT without reason) failed: %', v; end if;

  raise notice 'hardening scenario ok · last round % · cycle %',
    v_round_id, (select reset_cycle from sc.rounds where id = v_round_id);
end $$;

-- == 20. P0-03: the database itself refuses two simultaneous active rounds ====
reset role;
do $$
declare v_event bigint; v_failed boolean := false;
begin
  select event_id into v_event from sc.state where id = true;
  begin
    insert into sc.rounds (event_id, round_number, team_number, status, called_at)
    values (v_event, 800, 800, 'LOBBY_CALL', 1);
  exception when unique_violation then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'ASSERT 20 (single active round is not enforced by the database)';
  end if;
end $$;

select 'hardening: disputed-then-accepted rounds=' || count(*)
  from sc.rounds where review_resolved_at is not null;
select 'hardening: reset cycles seen=' || count(distinct reset_cycle) from sc.rounds;
