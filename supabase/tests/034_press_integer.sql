-- Local test DB only. Browsers send a fractional press instant: the calibrated
-- epoch-ms estimate comes from performance.now(), so it looks like
-- 1730000000123.75. A bare text::bigint cast rejects that value, and because the
-- cast sits inside handle_command the whole transaction rolls back — nothing is
-- logged, the phone is told "CHƯA ĐƯỢC GHI NHẬN", and every retry fails the same
-- way. The press instant is diagnostic only and must never be able to abort it.
\set ON_ERROR_STOP on
reset role;
create function pg_temp.check_access(ok boolean, detail text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'ASSERT: %', detail; end if; end $$;

-- Own roster and event: this file must not depend on the phase 033 left behind.
update sc.operators set revoked_at = now() where revoked_at is null;
insert into auth.users(id) values
  ('eeeeeeee-0000-4000-8000-000000000001'),
  ('eeeeeeee-0000-4000-8000-000000000002')
on conflict (id) do nothing;
insert into sc.operators (user_id, role, display_name, seat_slot) values
  ('eeeeeeee-0000-4000-8000-000000000001', 'LOBBY', 'Lan 034', 1),
  ('eeeeeeee-0000-4000-8000-000000000002', 'GATE', 'Hung 034', 1)
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name,
  seat_slot = excluded.seat_slot, revoked_at = null, bound_at = now();

insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms,
                       hidden_object_owner, hiding_layout, review_threshold_ms)
values ('Press instant event', 5400000, 300000, 90000, 90000, 'CORRIDOR', 'A', 100);
update sc.state
   set event_id = (select max(id) from sc.events where name = 'Press instant event'),
       revision = 0, updated_at = sc.now_ms()
 where id = true;

set role authenticated;

do $$
declare
  v jsonb;
  v_rev bigint;
  v_tap numeric;
  v_round sc.rounds;
begin
  -- Exactly what the browser puts on the wire: a press a quarter second ago,
  -- carrying the fractional part of a performance.now()-derived estimate.
  perform set_config('request.jwt.claim.sub', 'eeeeeeee-0000-4000-8000-000000000001', false);
  select revision into v_rev from sc.events where id = (select event_id from sc.state where id = true);
  v_tap := sc.now_ms()::numeric - 250.75;
  v := public.handle_command('CALL_TEAM',
         jsonb_build_object('_press', jsonb_build_object('press_ms', v_tap,
                            'local_press_ms', sc.now_ms(), 'rtt_ms', 42.5)),
         v_rev, 'press-integer-call');
  perform pg_temp.check_access((v->>'ok')::boolean, 'dispatch with a fractional press instant');

  perform set_config('request.jwt.claim.sub', 'eeeeeeee-0000-4000-8000-000000000002', false);
  select revision into v_rev from sc.events where id = (select event_id from sc.state where id = true);
  v_tap := sc.now_ms()::numeric - 250.75;
  v := public.handle_command('START_GAME',
         jsonb_build_object('_press', jsonb_build_object('press_ms', v_tap,
                            'local_press_ms', sc.now_ms(), 'rtt_ms', 42.5)),
         v_rev, 'press-integer-start');
  perform pg_temp.check_access((v->>'ok')::boolean, 'START_GAME with a fractional press instant');
  perform pg_temp.check_access((v->>'message') = 'Đồng hồ 5:00 đang chạy', 'start acknowledged');

  -- The stored instant is the truncated press, and the transport delay derived
  -- from it still flags a slow START for review.
  select * into v_round from sc.rounds where event_id = (select event_id from sc.state where id = true)
   order by round_number desc limit 1;
  perform pg_temp.check_access(v_round.status = 'GAME_STARTED', 'round started');
  perform pg_temp.check_access(v_round.start_press_ms is not null, 'press instant stored');
  perform pg_temp.check_access(v_round.start_press_ms between trunc(v_tap) - 50 and trunc(v_tap) + 1000,
    format('press instant %s is the truncated tap %s', v_round.start_press_ms, trunc(v_tap)));
  perform pg_temp.check_access(v_round.start_transport_ms between 200 and 2000,
    format('transport %s reflects the 250 ms tap', v_round.start_transport_ms));
  perform pg_temp.check_access(v_round.needs_review and 'START_TRANSPORT' = any(v_round.review_reasons),
    'slow press flagged for review');

  -- A malformed press is dropped, never allowed to block the command.
  select revision into v_rev from sc.events where id = (select event_id from sc.state where id = true);
  v := public.handle_command('GAME_STOP',
         jsonb_build_object('_press', jsonb_build_object('press_ms', 'garbage')),
         v_rev, 'press-integer-garbage');
  perform pg_temp.check_access((v->>'ok')::boolean, 'malformed press still commits the stop');
  perform pg_temp.check_access(
    (select stop_press_ms is null from sc.rounds
      where event_id = (select event_id from sc.state where id = true)
      order by round_number desc limit 1), 'malformed press discarded, not stored');

  -- The 0010 authority guard must survive the rewritten funnel.
  perform pg_temp.check_access((public.release_device()->>'ok')::boolean, 'gate releases its seat');
  v := public.handle_command('GAME_PAUSE', '{}'::jsonb, v_rev, 'press-integer-released');
  perform pg_temp.check_access(v->>'code' = 'PERMISSION_DENIED', 'a released seat still fails closed');
end $$;

select '034 fractional press instants are accepted, truncated and never abort a command: passed' as result;
