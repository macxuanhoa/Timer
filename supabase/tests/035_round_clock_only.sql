-- Local SQL validation only. All setup and simulated commands roll back.
\set ON_ERROR_STOP on
reset role;

begin;

-- Use a dedicated event and two station identities so this case is independent
-- from the state left by the preceding migration scenarios.
update sc.operators set revoked_at = now() where revoked_at is null;
insert into auth.users(id) values
  ('11111111-0000-4000-8000-000000000001'),
  ('11111111-0000-4000-8000-000000000002')
on conflict (id) do nothing;
insert into sc.operators (user_id, role, display_name, seat_slot) values
  ('11111111-0000-4000-8000-000000000001', 'LOBBY', 'Test Lobby 035', 1),
  ('11111111-0000-4000-8000-000000000002', 'GATE', 'Test Gate 035', 1)
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name,
  seat_slot = excluded.seat_slot, revoked_at = null, bound_at = now();

insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
                       hidden_object_owner, hiding_layout, review_threshold_ms)
values ('Round clock only 035', 5400000, 300000, 90000, 90000, 'CORRIDOR', 'A', 100);
update sc.events
   set event_started_at = sc.now_ms() - duration_ms - 1,
       event_ended_at = null,
       overtime_started_at = null,
       closing_warned_at = null,
       end_warned_at = null
 where name = 'Round clock only 035';
update sc.state
   set event_id = (select id from sc.events where name = 'Round clock only 035'),
       revision = 0, updated_at = sc.now_ms()
 where id = true;

do $$
declare v_event sc.events; v_admission jsonb;
begin
  select e.* into v_event from sc.events e join sc.state s on s.event_id = e.id where s.id;
  v_admission := sc._admission(v_event, sc.now_ms(), 'dispatch');
  if (v_admission->>'allowed')::boolean is not true then
    raise exception 'ASSERT 035a: dispatch blocked after the stored event duration: %', v_admission;
  end if;
  v_admission := sc._admission(v_event, sc.now_ms(), 'start');
  if (v_admission->>'allowed')::boolean is not true then
    raise exception 'ASSERT 035b: game start blocked after the stored event duration: %', v_admission;
  end if;
  v_event.event_ended_at := sc.now_ms();
  v_admission := sc._admission(v_event, sc.now_ms(), 'dispatch');
  if v_admission->>'code' <> 'EVENT_ENDED' then
    raise exception 'ASSERT 035c: explicit closure did not stop dispatch: %', v_admission;
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-0000-4000-8000-000000000001', true);

do $$
declare v jsonb; v_revision bigint;
begin
  v_revision := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('CALL_TEAM', '{}'::jsonb, v_revision, 'clockless-call');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 035d: CALL_TEAM failed: %', v; end if;

  v_revision := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('SET_TEAM_NAME', '{"team_name":"Team After 90"}'::jsonb, v_revision, 'clockless-name');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 035e: team name edit failed: %', v; end if;

  perform set_config('request.jwt.claim.sub', '11111111-0000-4000-8000-000000000002', true);
  v_revision := (public.state_revision()->>'revision')::bigint;
  v := public.handle_command('START_GAME', '{}'::jsonb, v_revision, 'clockless-start');
  if not (v->>'ok')::boolean then raise exception 'ASSERT 035f: START_GAME failed: %', v; end if;

  -- Snapshot calls tick; no legacy warning/overtime fields may be written.
  v := public.snapshot();
  if v->'event'->>'event_ended_at' is not null
     or v->'event'->>'overtime_started_at' is not null
     or v->'event'->>'closing_warned_at' is not null
     or v->'event'->>'end_warned_at' is not null then
    raise exception 'ASSERT 035g: snapshot changed legacy timing fields: %', v->'event';
  end if;
  if v->'rounds'->-1->>'team_name' <> 'Team After 90'
     or v->'rounds'->-1->>'game_started_at' is null then
    raise exception 'ASSERT 035h: round workflow did not remain operational: %', v->'rounds'->-1;
  end if;
end $$;

rollback;
reset role;
select '035 no event deadline; 5-minute round workflow and explicit closure preserved' as result;
