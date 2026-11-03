-- 0016: One authoritative operational flow (V3).
--
-- Forward-only and non-destructive: every event, round, reset task and action-log
-- row that already exists survives, keeps its own timestamps, and is read through the
-- new vocabulary. Nothing is dropped and no historical row is rewritten to a new
-- outcome. What changes is the *live* state machine, the permission table, and the
-- addition of a claim history plus the open observer seat.
--
--   01 (LOBBY) receives the team → 02 (CORRIDOR) confirms floor 2 → NPC1 (GATE)
--   starts the 300 s countdown → NPC2 (ROOM305) records and verifies completion
--   claims → NPC1 confirms the physical exit → the round closes for the next team.
--
-- The 5:00 window is no longer pausable, restartable or editable by any role, and
-- the corridor no longer drives progression. The official score is the validated
-- claim's own instant, never the verification time and never the exit time.

select pg_advisory_xact_lock(30501);

-- ---------------------------------------------------------------- 1. columns
alter table sc.rounds add column if not exists received_by_role        text;
alter table sc.rounds add column if not exists received_by             uuid references sc.operators (user_id);
alter table sc.rounds add column if not exists floor2_confirmed_at     bigint;
alter table sc.rounds add column if not exists floor2_confirmed_by_role text;
alter table sc.rounds add column if not exists floor2_confirmed_by     uuid references sc.operators (user_id);
-- A bypass is its own audited fact and is never written into floor2_confirmed_*.
alter table sc.rounds add column if not exists floor2_bypassed_at       bigint;
alter table sc.rounds add column if not exists floor2_bypassed_by_role  text;
alter table sc.rounds add column if not exists floor2_bypassed_by       uuid references sc.operators (user_id);
alter table sc.rounds add column if not exists floor2_bypass_reason     text;
alter table sc.rounds add column if not exists started_by_role          text;
alter table sc.rounds add column if not exists started_by               uuid references sc.operators (user_id);
-- The stored end of the 300 s window: a refresh, a sleep or a reconnect can never
-- restart or extend the countdown, because the deadline is data, not a timer.
alter table sc.rounds add column if not exists deadline_at              bigint;
alter table sc.rounds add column if not exists validated_attempt_id      bigint;
alter table sc.rounds add column if not exists exit_by_role             text;
alter table sc.rounds add column if not exists exit_by                  uuid references sc.operators (user_id);
alter table sc.rounds add column if not exists exit_reason               text;
alter table sc.rounds add column if not exists finalized_by_role         text;
-- Gameplay result, kept separate from the lifecycle so a phase change can never lose
-- it. PENDING_VALIDATION is provisional, not an irreversible failure.
alter table sc.rounds add column if not exists result                   text not null default 'IN_PROGRESS'
  check (result in ('IN_PROGRESS','PENDING_VALIDATION','WON','TIME_UP','ABORTED'));

-- ------------------------------------------------------- 2. completion claims
-- Append-only per-attempt history: an earlier claim is never overwritten, and the
-- claim instant is stored apart from the verification decision.
create table if not exists sc.completion_attempts (
  id                  bigint generated always as identity primary key,
  round_id            bigint not null references sc.rounds (id) on delete restrict,
  event_id            bigint not null references sc.events (id),
  -- 1-based within the round, for "Lần 1 — 03:42.35 — Chờ kiểm tra".
  seq                 int    not null check (seq >= 1),
  -- Server instant of the announcement. A client-submitted instant is diagnostic
  -- only and is never the official timestamp.
  claimed_at          bigint not null,
  elapsed_ms          bigint not null check (elapsed_ms >= 0),
  -- Signed remainder when the claim landed; negative means past the deadline.
  remaining_ms        bigint not null,
  -- claimed_at < deadline_at, recorded once at commit time.
  in_time             boolean not null,
  status              text   not null default 'PENDING'
                        check (status in ('PENDING','VALID','INVALID','LATE')),
  claimed_by_role     text   not null,
  claimed_by          uuid   references sc.operators (user_id),
  verified_by_role    text,
  verified_by         uuid   references sc.operators (user_id),
  verified_at         bigint,
  decision_note       text,
  claim_press_ms      bigint,
  claim_transport_ms  bigint,
  revision            bigint not null default 0,
  unique (round_id, seq)
);
create index if not exists completion_attempts_round_idx on sc.completion_attempts (round_id, claimed_at);

alter table sc.completion_attempts enable row level security;
-- No client SELECT at all: a claim list is reachable only through sc.snapshot(),
-- which withholds it from a viewer. Grants are deliberately not issued, and the
-- identity column has no usable sequence without table rights (0001 already revoked
-- every sequence in the schema from the client roles).
revoke all on sc.completion_attempts from public, anon, authenticated;
revoke all on sequence sc.completion_attempts_id_seq from public, anon, authenticated;

-- ------------------------------------------- 2b. widen every check before any write
-- Postgres validates a CHECK on each UPDATE, so the new vocabularies have to be
-- admitted before the live rows are moved onto them. Every retired value stays inside
-- the constraint, because historical rows keep it and must remain readable.
alter table sc.rounds drop constraint if exists rounds_status_check;
alter table sc.rounds add constraint rounds_status_check check (status in
  ('WAITING_FLOOR2_CONFIRMATION','READY_AT_FLOOR3','RUNNING','TIME_EXPIRED_PENDING_VALIDATION',
   'WAITING_FOR_EXIT','EXIT_CONFIRMED','CLOSED',
   'LOBBY_CALL','TEAM_PREPARING','GAME_STARTED','CORRIDOR_ACTIVE','ROOM_REACHED',
   'PUZZLE_COMPLETED','RETURNING','GAME_EXITED','RESETTING','RESET_CONFIRMED',
   'GATE_CLEARED','ABORTED'));

-- OBSERVER is a new identity; the hidden props move to the floor-3 staff. The retired
-- check is dropped before the data is normalised and re-created afterwards, because
-- the normalised value is exactly what the old check refused.
alter table sc.events drop constraint if exists events_hidden_object_owner_check;
-- The column default matters as much as the check: `sc._ensure_event()` creates the
-- next event from the defaults, so a retired default would abort the first insert.
alter table sc.events alter column hidden_object_owner set default 'ROOM305';
update sc.events set hidden_object_owner = 'ROOM305' where hidden_object_owner = 'CORRIDOR';
update sc.reset_tasks set required_role = 'GATE'
 where task_key = 'hallway' and required_role = 'CORRIDOR'
   and round_id in (select id from sc.rounds where status not in ('CLOSED','GATE_CLEARED'));
update sc.reset_tasks set required_role = 'ROOM305'
 where task_key = 'hidden_objects' and required_role = 'CORRIDOR'
   and round_id in (select id from sc.rounds where status not in ('CLOSED','GATE_CLEARED'));
alter table sc.events add constraint events_hidden_object_owner_check
  check (hidden_object_owner in ('GATE','ROOM305'));

alter table sc.operators drop constraint if exists operators_role_check;
alter table sc.operators add constraint operators_role_check
  check (role in ('LOBBY','CORRIDOR','GATE','ROOM305','SUPERVISOR','OBSERVER'));
alter table sc.role_permissions drop constraint if exists role_permissions_role_check;
alter table sc.role_permissions add constraint role_permissions_role_check
  check (role in ('LOBBY','CORRIDOR','GATE','ROOM305','SUPERVISOR','OBSERVER'));
alter table sc.reset_tasks drop constraint if exists reset_tasks_required_role_check;
alter table sc.reset_tasks add constraint reset_tasks_required_role_check
  check (required_role in ('LOBBY','CORRIDOR','GATE','ROOM305','SUPERVISOR','OBSERVER'));

-- ------------------------------------------------------- 3. the live rows keep their clock
-- The old partial index pins "one occupying round" to status <> 'GATE_CLEARED'; the
-- new vocabulary would break it mid-rewrite, so it is dropped first and rebuilt (and
-- therefore validated) as soon as the statuses are mapped. A migration is a single
-- administrative act, so the invariant is never observable as missing from outside.
-- The index lives in `sc`, so it has to be named with its schema: an unqualified name
-- resolves against search_path and would silently drop nothing.
drop index if exists sc.rounds_single_active;

-- A round that is still open is moved onto the new vocabulary. A round whose game
-- clock is running keeps exactly the time it had left: the deadline is derived from
-- the banked playing time of the retired flexible window, so nobody gains or loses a
-- millisecond because of the upgrade.
update sc.rounds set status = case status
    when 'LOBBY_CALL' then 'WAITING_FLOOR2_CONFIRMATION'
    when 'TEAM_PREPARING' then 'WAITING_FLOOR2_CONFIRMATION'
    when 'GAME_STARTED' then 'RUNNING'
    when 'CORRIDOR_ACTIVE' then 'RUNNING'
    when 'ROOM_REACHED' then 'RUNNING'
    when 'PUZZLE_COMPLETED' then 'RUNNING'
    when 'RETURNING' then 'RUNNING'
    when 'GAME_EXITED' then 'EXIT_CONFIRMED'
    when 'RESETTING' then 'EXIT_CONFIRMED'
    when 'RESET_CONFIRMED' then 'EXIT_CONFIRMED'
    when 'ABORTED' then case when system_ready_at is null then 'EXIT_CONFIRMED' else 'CLOSED' end
    when 'GATE_CLEARED' then 'CLOSED'
    else status end
  where status in ('LOBBY_CALL','TEAM_PREPARING','GAME_STARTED','CORRIDOR_ACTIVE','ROOM_REACHED',
                   'PUZZLE_COMPLETED','RETURNING','GAME_EXITED','RESETTING','RESET_CONFIRMED',
                   'GATE_CLEARED','ABORTED');

-- A round that a newer round superseded is finished: the event demonstrably moved on,
-- so leaving it open would misrepresent the history and break the one-game-at-a-time
-- invariant the new index enforces. Its own timestamps are kept; only the lifecycle is
-- closed, and no clearance is claimed for it (system_ready_at stays NULL).
update sc.rounds r set status = 'CLOSED'
 where r.status <> 'CLOSED'
   and (r.game_stopped_at is not null or r.aborted_at is not null or r.exit_confirmed_at is not null)
   and exists (select 1 from sc.rounds n
                where n.event_id = r.event_id and n.round_number > r.round_number);

-- The one occupying round per event, now keyed on the new terminal status. Creating it
-- validates the whole table, so any event left with two open rounds would fail here.
create unique index rounds_single_active on sc.rounds (event_id) where status <> 'CLOSED';

update sc.rounds set stage = case status
    when 'WAITING_FLOOR2_CONFIRMATION' then greatest(stage, 1)
    when 'READY_AT_FLOOR3' then greatest(stage, 2)
    when 'RUNNING' then greatest(stage, 3)
    when 'TIME_EXPIRED_PENDING_VALIDATION' then greatest(stage, 3)
    when 'WAITING_FOR_EXIT' then greatest(stage, 4)
    when 'EXIT_CONFIRMED' then greatest(stage, 5)
    when 'CLOSED' then greatest(stage, 6)
    else stage end;

-- Map the retired outcome vocabulary onto the new result field, then give every
-- running round a stored deadline.
update sc.rounds set result = case
    when aborted_at is not null or outcome = 'ABORTED' then 'ABORTED'
    when outcome = 'WON' then 'WON'
    when outcome in ('TIMEOUT','NO_PUZZLE') then 'TIME_UP'
    else 'IN_PROGRESS' end;

update sc.rounds
   set deadline_at = case
         when game_stopped_at is not null then game_started_at + (select game_limit_ms from sc.events e where e.id = sc.rounds.event_id)
         -- Paused or reset windows keep only the playing time they had actually banked.
         when game_anchor_ms is null then sc.now_ms() + greatest(0,
             (select game_limit_ms from sc.events e where e.id = sc.rounds.event_id) - game_elapsed_ms)
         else sc.now_ms() + greatest(0,
             (select game_limit_ms from sc.events e where e.id = sc.rounds.event_id)
             - game_elapsed_ms - greatest(0, sc.now_ms() - game_anchor_ms))
       end
 where deadline_at is null and game_started_at is not null;

-- A validated round keeps its official time and remembers that the value came from
-- the legacy single puzzle confirmation, so the derivation behaves identically.
update sc.rounds
   set validated_attempt_id = -1
 where validated_attempt_id is null and result = 'WON' and puzzle_completed_at is not null;

-- Reception is the step OPERATOR_01 owns; every existing team already had one.
update sc.rounds set received_by_role = 'LOBBY' where received_by_role is null;
-- Every completed step keeps the position that performed it, so an old round still
-- reads truthfully in the audit.
update sc.rounds set floor2_confirmed_by_role = 'CORRIDOR'
 where floor2_confirmed_at is not null and floor2_confirmed_by_role is null;
update sc.rounds set exit_by_role = 'GATE'
 where exit_confirmed_at is not null and exit_by_role is null and aborted_at is null;
update sc.rounds set finalized_by_role = 'GATE'
 where gate_finalized_at is not null and finalized_by_role is null;

-- An unfinished legacy round that never got a floor-2 step is placed at the first
-- waiting state, which is where OPERATOR_02 can still act on it truthfully.
update sc.rounds
   set status = 'WAITING_FLOOR2_CONFIRMATION'
 where status = 'CLOSED' and system_ready_at is null;

-- The reset ownership (step 2b) already re-pointed the open rounds' checks to the
-- floor-3 staff; history stays exactly as it was recorded.

-- The role and status vocabularies were already widened in step 2b, before these
-- writes. What is left is the new result column's companion check on the legacy
-- outcome, which keeps its retired values for historical rows.
-- An aborted legacy round that is still awaiting clearance is not terminal, so the
-- upgrade above can leave it open; only CLOSED ends a round.
alter table sc.rounds drop constraint if exists rounds_outcome_check;
alter table sc.rounds add constraint rounds_outcome_check check (outcome in
  ('IN_PROGRESS','WON','TIMEOUT','NO_PUZZLE','ABORTED'));

-- ---------------------------------------------- 6. the V3 permission authority
-- One row per authority, exactly as the role matrix demands. Retired actions simply
-- have no row, so no role can execute them; OBSERVER has no row at all.
delete from sc.role_permissions;
insert into sc.role_permissions (action, role) values
  ('CONFIGURE',        'SUPERVISOR'),
  ('CALL_TEAM',        'LOBBY'),
  ('CONFIRM_FLOOR2',   'CORRIDOR'),
  ('FLOOR2_BYPASS',    'GATE'),
  ('START_GAME',       'GATE'),
  ('CLAIM_COMPLETE',   'ROOM305'),
  ('VERIFY_ATTEMPT',   'ROOM305'),
  ('CONFIRM_EXIT',     'GATE'),
  ('EARLY_EXIT',       'GATE'),
  ('RESET_DONE',       'GATE'),     ('RESET_DONE',  'ROOM305'),
  ('GATE_FINALIZE',    'GATE'),
  ('SET_LAYOUT',       'GATE'),     ('SET_LAYOUT',  'ROOM305'),
  ('SET_LAYOUT',       'SUPERVISOR'),
  ('SET_TEAM_NAME',    'LOBBY'),    ('SET_TEAM_NAME','SUPERVISOR'),
  ('REOPEN_RESET',     'SUPERVISOR'),
  ('REVIEW_RESOLVE',   'SUPERVISOR'),
  ('END_EVENT',        'SUPERVISOR'),
  ('ABORT_ROUND',      'SUPERVISOR'),
  ('CORRECT_ROUND',    'SUPERVISOR'),
  ('OVERRIDE_ADMIT',   'SUPERVISOR'),
  ('OVERTIME_STARTED', 'SUPERVISOR'),
  ('EVENT_CLOSED',     'SUPERVISOR'),
  ('SESSION_RESTORE',  'SUPERVISOR');

-- ------------------------------------------- 7. RLS: a viewer reads no records
-- An OBSERVER may follow the shared state pointer (that is how realtime reaches it),
-- but never the operating tables. sc.snapshot() composes the redacted view for it,
-- so no route change or client edit can widen what a viewer sees.
create or replace function sc.may_read_records() returns boolean
language sql stable security definer set search_path = '' as $$
  select sc.is_operator() and sc.my_role() is distinct from 'OBSERVER'
$$;
grant execute on function sc.may_read_records() to authenticated;

drop policy if exists rounds_read on sc.rounds;
drop policy if exists tasks_read on sc.reset_tasks;
drop policy if exists log_read on sc.action_log;
drop policy if exists events_read on sc.events;
create policy rounds_read on sc.rounds for select to authenticated using (sc.may_read_records());
create policy tasks_read on sc.reset_tasks for select to authenticated using (sc.may_read_records());
create policy log_read on sc.action_log for select to authenticated using (sc.may_read_records());
-- The event row carries configuration a viewer needs in order to render the same
-- countdown; it holds no operator identity.
create policy events_read on sc.events for select to authenticated using (sc.is_operator());
create policy attempts_read on sc.completion_attempts for select to authenticated
  using (sc.may_read_records());

-- --------------------------------------------- 8. observer seats and the board
-- Ten viewing seats, anonymous and password-free. Capacity is enforced by the same
-- mechanism the operator seats use — a unique (role, seat_slot) index — so two
-- phones can never both take the last seat, and a refresh re-uses the binding the
-- caller already owns instead of consuming another seat.
alter table sc.operators drop constraint if exists operators_seat_slot_range;
alter table sc.operators add constraint operators_seat_slot_range check (
  seat_slot between 1 and 10
  -- Only the two multi-device identities may hold a slot above 1: SUPERVISOR up to
  -- two, OBSERVER up to the ten viewing seats. Every station stays pinned to slot 1.
  and (seat_slot = 1 or role in ('SUPERVISOR', 'OBSERVER'))
  and (role <> 'SUPERVISOR' or seat_slot <= 2)
);

create table if not exists sc.observer_seats (
  user_id  uuid primary key references sc.operators (user_id) on delete cascade,
  viewer_id text,
  seen_at  timestamptz not null default now()
);
alter table sc.observer_seats enable row level security;
revoke all on sc.observer_seats from public, anon, authenticated;

-- A seat is live while its heartbeat is recent. Abandoned phones stop beating and
-- are released by the sweep below, never by a client claim.
create or replace function sc._observer_ttl() returns interval
language sql immutable as $$ select interval '45 seconds' $$;

create or replace function sc._observer_sweep() returns int
language plpgsql security definer set search_path = '' as $$
declare v_freed int;
begin
  -- An access action only: it never touches a round, a clock or a reset task.
  update sc.operators set revoked_at = now()
   where role = 'OBSERVER' and revoked_at is null
     and user_id not in (select s.user_id from sc.observer_seats s
                          where s.seen_at > now() - sc._observer_ttl());
  get diagnostics v_freed = row_count;
  delete from sc.observer_seats
   where seen_at <= now() - sc._observer_ttl() * 2
     and user_id not in (select user_id from sc.operators
                          where role = 'OBSERVER' and revoked_at is null);
  return v_freed;
end $$;

-- OBSERVER becomes a claimable identity with no PIN, ten slots and no privileges:
-- sc.role_permissions has no OBSERVER row, so every command stays refused.
create or replace function sc.claim_station(p_role text, p_pin text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_bound sc.operators;
  v_capacity int;
  v_slot smallint;
  v_hash text;
  v_person_attempts int;
  v_global_attempts int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if p_role is null or p_role not in ('LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR','OBSERVER') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ROLE');
  end if;
  perform pg_advisory_xact_lock(30501);
  select * into v_bound from sc.operators where user_id = v_uid and revoked_at is null;
  if v_bound.user_id is not null then
    if v_bound.role <> p_role then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_BOUND_OTHER_ROLE');
    end if;
    -- Same identity, same seat: a refresh never consumes another viewer slot.
    if p_role = 'OBSERVER' then
      insert into sc.observer_seats(user_id, viewer_id, seen_at)
      values (v_uid, left(coalesce(p_pin, ''), 64), now())
      on conflict (user_id) do update set seen_at = now();
    end if;
    return jsonb_build_object('ok', true, 'code', 'ALREADY_BOUND', 'role', v_bound.role);
  end if;
  v_capacity := case p_role when 'SUPERVISOR' then 2 when 'OBSERVER' then 10 else 1 end;
  -- A viewer must not be locked out by a stale seat, so abandoned seats go first.
  if p_role = 'OBSERVER' then
    perform sc._observer_sweep();
  end if;
  select min(s)::smallint into v_slot from generate_series(1, v_capacity) s
   where not exists (select 1 from sc.operators o
                     where o.role = p_role and o.seat_slot = s and o.revoked_at is null);
  if v_slot is null then
    return jsonb_build_object('ok', false,
      'code', case when p_role = 'OBSERVER' then 'OBSERVER_FULL' else 'ROLE_TAKEN' end,
      'capacity', v_capacity);
  end if;
  if p_role = 'SUPERVISOR' then
    select supervisor_pin_hash into v_hash from sc.station_access_config where id;
    if v_hash is null then
      return jsonb_build_object('ok', false, 'code', 'PIN_NOT_CONFIGURED');
    end if;
    delete from sc.access_rate_limits where window_start < now() - interval '15 minutes';
    select attempts into v_person_attempts from sc.access_rate_limits where key = v_uid::text;
    select attempts into v_global_attempts from sc.access_rate_limits where key = 'global';
    if coalesce(v_person_attempts, 0) >= 5 or coalesce(v_global_attempts, 0) >= 30 then
      return jsonb_build_object('ok', false, 'code', 'PIN_RATE_LIMITED');
    end if;
    insert into sc.access_rate_limits(key, window_start, attempts)
    values (v_uid::text, now(), 1), ('global', now(), 1)
    on conflict (key) do update set attempts = sc.access_rate_limits.attempts + 1;
    if p_pin is null or length(p_pin) > 12 or p_pin !~ '^[0-9]{8,12}$'
       or extensions.crypt(p_pin, v_hash) <> v_hash then
      insert into sc.access_audit(user_id, role, action) values (v_uid, p_role, 'PIN_REFUSED');
      return jsonb_build_object('ok', false, 'code', 'PIN_INVALID');
    end if;
    delete from sc.access_rate_limits where key = v_uid::text;
  end if;
  insert into sc.operators(user_id, role, display_name, revoked_at, bound_at, device_id, is_anonymous, seat_slot)
  values (v_uid, p_role, p_role, null, now(), v_uid::text, sc._is_anonymous_caller(), v_slot)
  on conflict(user_id) do update set role = excluded.role, display_name = excluded.display_name,
    revoked_at = null, bound_at = now(), device_id = excluded.device_id,
    is_anonymous = excluded.is_anonymous, seat_slot = excluded.seat_slot;
  insert into sc.access_audit(user_id, role, action) values(v_uid, p_role, 'CLAIMED');
  if p_role = 'OBSERVER' then
    insert into sc.observer_seats(user_id, viewer_id, seen_at)
    values (v_uid, null, now())
    on conflict (user_id) do update set seen_at = now();
  end if;
  -- Deliberately no _ensure_event(), tick(), state write or timer action.
  return jsonb_build_object('ok', true, 'code', 'CLAIMED', 'role', p_role, 'seat', v_slot);
end $$;

-- The presence endpoints. Each one is scoped to auth.uid(): a caller can renew or
-- release its own seat and nothing else, so nobody can hold another viewer hostage.
create or replace function sc.observer_beat(p_viewer_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  perform pg_advisory_xact_lock(30501);
  perform sc._observer_sweep();
  select role into v_role from sc.operators where user_id = v_uid and revoked_at is null;
  if v_role is distinct from 'OBSERVER' then
    return jsonb_build_object('ok', false,
      'code', case when v_role is null then 'NOT_BOUND' else 'NOT_OBSERVER' end);
  end if;
  insert into sc.observer_seats(user_id, viewer_id, seen_at)
  values (v_uid, left(coalesce(p_viewer_id, ''), 64), now())
  on conflict (user_id) do update set seen_at = now(), viewer_id = coalesce(excluded.viewer_id, sc.observer_seats.viewer_id);
  return jsonb_build_object('ok', true, 'code', 'ALIVE',
    'devices', (select count(*) from sc.observer_seats s
                  join sc.operators o on o.user_id = s.user_id and o.revoked_at is null
                 where s.seen_at > now() - sc._observer_ttl()),
    'capacity', 10);
end $$;

create or replace function sc.observer_leave() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  perform pg_advisory_xact_lock(30501);
  delete from sc.observer_seats where user_id = v_uid;
  update sc.operators set revoked_at = now() where user_id = v_uid and role = 'OBSERVER' and revoked_at is null;
  insert into sc.access_audit(user_id, role, action) values (v_uid, 'OBSERVER', 'LEFT');
  return jsonb_build_object('ok', true, 'code', 'RELEASED');
end $$;

-- Releasing a station also drops the viewer seat, so no orphan seat lingers.
create or replace function sc.release_device() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  perform pg_advisory_xact_lock(30501);
  update sc.operators set revoked_at = now()
   where user_id = v_uid and revoked_at is null returning role into v_role;
  if v_role is not null then
    delete from sc.observer_seats where user_id = v_uid;
    insert into sc.access_audit(user_id, role, action) values(v_uid, v_role, 'RELEASED');
  end if;
  return jsonb_build_object('ok', true, 'code', case when v_role is null then 'NOT_BOUND' else 'RELEASED' end);
end $$;

-- Board v2: operator counters keep their exact meaning, and the viewer seats are
-- reported separately so ten spectators never make a station look full.
create or replace function sc.station_board() returns jsonb
language sql stable security definer set search_path = '' as $$
  with seats as (
    select r.role, r.ord, r.capacity,
           -- The viewer seat is counted from live presence, not from a binding row:
           -- a spectator holds a seat while it is watching, and the count is the same
           -- number the presence endpoints report.
           case when r.role = 'OBSERVER'
                then (select count(*) from sc.observer_seats s
                        join sc.operators o on o.user_id = s.user_id
                       and o.revoked_at is null and o.role = 'OBSERVER'
                       where s.seen_at > now() - sc._observer_ttl())
                else count(o.user_id)::int end      as devices,
           max(r.capacity)::int                     as capacity_max
      from (values ('LOBBY', 1, 1), ('GATE', 2, 1), ('CORRIDOR', 3, 1),
                  ('ROOM305', 4, 1), ('SUPERVISOR', 5, 2), ('OBSERVER', 6, 10))
           r(role, ord, capacity)
      left join sc.operators o
             on o.role = r.role and o.revoked_at is null and r.role <> 'OBSERVER'
     group by r.role, r.ord, r.capacity
  ), operators as (
    select coalesce(sum(capacity), 0)::int as device_capacity, coalesce(sum(devices), 0)::int as devices
      from seats where role <> 'OBSERVER'
  ), occupied as (
    select count(*) filter (where devices > 0) as n from seats where role <> 'OBSERVER'
  )
  select jsonb_build_object(
    'board_version', 2,
    'capacity', 5,
    'device_capacity', (select device_capacity from operators),
    'devices', (select devices from operators),
    'occupied', (select n from occupied),
    'locked', (select devices from operators) >= (select device_capacity from operators),
    'observer_capacity', 10,
    'observer_devices', (select devices from seats where role = 'OBSERVER'),
    'full', (select devices from operators) >= (select device_capacity from operators),
    -- The 5:00 belongs to the round: from BẮT ĐẦU until the team is confirmed out.
    -- The board reset is an access action and must never run over a live clock.
    'game_running', exists (select 1 from sc.rounds r join sc.state st on st.id
      where r.event_id = st.event_id and r.status <> 'CLOSED'
        and r.game_started_at is not null and r.exit_confirmed_at is null),
    'stations', jsonb_agg(jsonb_build_object('role', role, 'capacity', capacity_max,
      'devices', devices, 'occupied', devices >= capacity_max) order by ord))
  from seats;
$$;

-- ------------------------------------------------ 9. the derived lifecycle truth
-- The expiry is a property of the stored deadline, not a scheduled task: a device
-- that reconnects after the deadline, a phone with no stream, and the server itself
-- all reach the same answer with no timer to run. This function is the single place
-- that answer is computed, and it mirrors src/shared/machine.ts exactly.
create or replace function sc._derive(v_round sc.rounds, p_now bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit    bigint;
  v_deadline bigint;
  v_pending  int;
  v_live     text;
  v_result   text;
begin
  select game_limit_ms into v_limit from sc.events where id = v_round.event_id;
  v_limit := coalesce(v_limit, 300000);
  if v_round.deadline_at is not null then
    v_deadline := v_round.deadline_at;
  elsif v_round.game_started_at is null then
    v_deadline := null;
  elsif v_round.game_stopped_at is not null then
    v_deadline := v_round.game_started_at + v_limit;
  else
    -- A row written before this release has no stored deadline: reconstruct the time
    -- it actually had left from the retired flexible-window fields, without granting
    -- or taking away a millisecond.
    v_deadline := p_now + greatest(0, v_limit - v_round.game_elapsed_ms
      - case when v_round.game_anchor_ms is null then 0
             else greatest(0, p_now - v_round.game_anchor_ms) end);
  end if;

  v_live := v_round.status;
  if v_live = 'RUNNING' and v_deadline is not null and p_now >= v_deadline then
    select count(*) into v_pending from sc.completion_attempts a
     where a.round_id = v_round.id and a.status = 'PENDING' and a.claimed_at < v_deadline;
    v_live := case when v_pending > 0 then 'TIME_EXPIRED_PENDING_VALIDATION' else 'WAITING_FOR_EXIT' end;
  end if;

  if v_round.aborted_at is not null then
    v_result := 'ABORTED';
  elsif v_round.validated_attempt_id is not null
     or exists (select 1 from sc.completion_attempts a
                 where a.round_id = v_round.id and a.status = 'VALID') then
    v_result := 'WON';
  elsif v_result is null and v_round.result in ('WON','ABORTED','TIME_UP') then
    v_result := v_round.result;
  elsif v_round.game_started_at is null then
    v_result := 'IN_PROGRESS';
  elsif v_deadline is null or p_now < v_deadline then
    v_result := 'IN_PROGRESS';
  else
    select count(*) into v_pending from sc.completion_attempts a
     where a.round_id = v_round.id and a.status = 'PENDING' and a.claimed_at < v_deadline;
    v_result := case when v_pending > 0 then 'PENDING_VALIDATION' else 'TIME_UP' end;
  end if;

  return jsonb_build_object('live', v_live, 'result', v_result,
                            'deadline', v_deadline, 'limit', v_limit);
end $$;

-- Phase-specific rights: ROLE_ACTIONS says who, this says when. Kept next to the
-- permission table so an illegal transition cannot be forced through the API, and
-- mirrored by authorizePhase() in src/shared/machine.ts for the UI.
create or replace function sc._phase_allows(p_action text, p_live text, p_result text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_action
    -- No round in play is the only legal moment to receive a team.
    when 'CALL_TEAM'      then p_live is null
    when 'CONFIRM_FLOOR2' then p_live = 'WAITING_FLOOR2_CONFIRMATION'
    when 'FLOOR2_BYPASS'  then p_live = 'WAITING_FLOOR2_CONFIRMATION'
    when 'START_GAME'     then p_live = 'READY_AT_FLOOR3'
    -- A late claim is still recordable as information; it just cannot win.
    when 'CLAIM_COMPLETE' then p_live in ('RUNNING','TIME_EXPIRED_PENDING_VALIDATION','WAITING_FOR_EXIT')
    -- A decision may still land after the clock, and even after the team has left.
    when 'VERIFY_ATTEMPT' then p_live in ('RUNNING','TIME_EXPIRED_PENDING_VALIDATION','EXIT_CONFIRMED')
    when 'CONFIRM_EXIT'   then p_live in ('WAITING_FOR_EXIT','TIME_EXPIRED_PENDING_VALIDATION')
    when 'EARLY_EXIT'     then p_live in ('RUNNING','TIME_EXPIRED_PENDING_VALIDATION','WAITING_FOR_EXIT')
    when 'RESET_DONE'     then p_live = 'EXIT_CONFIRMED'
    when 'GATE_FINALIZE'  then p_live = 'EXIT_CONFIRMED'
    -- Props are prepared between teams or during the reset, never on the clock.
    when 'SET_LAYOUT'     then p_live in (null,'WAITING_FLOOR2_CONFIRMATION','READY_AT_FLOOR3','EXIT_CONFIRMED')
    -- Session data is frozen while the countdown runs.
    when 'SET_TEAM_NAME'  then p_live in ('WAITING_FLOOR2_CONFIRMATION','READY_AT_FLOOR3')
    when 'ABORT_ROUND'    then p_live in ('WAITING_FLOOR2_CONFIRMATION','READY_AT_FLOOR3','RUNNING','TIME_EXPIRED_PENDING_VALIDATION')
    -- Admin recovery, disputes and closure work on any round, always reasoned.
    when 'REOPEN_RESET' then true when 'REVIEW_RESOLVE' then true
    when 'END_EVENT' then true when 'CORRECT_ROUND' then true when 'CONFIGURE' then true
    else false end
    -- A decided round is immutable: no further claim and no second verification.
    and not (p_result in ('WON','ABORTED') and p_action in ('VERIFY_ATTEMPT','CLAIM_COMPLETE'));
$$;

-- ======================================================= the authoritative command
create or replace function sc._handle_command_internal(
  p_action text,
  p_meta jsonb default '{}'::jsonb,
  p_expected_revision bigint default 0,
  p_idempotency_key text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role     text;
  v_uid      uuid := (select auth.uid());
  v_now      bigint;
  v_press    bigint;
  v_delay    bigint;
  v_event    sc.events;
  v_round    sc.rounds;
  v_state    sc.state;
  v_der      jsonb;
  v_live     text;
  v_result   text;
  v_deadline bigint;
  v_limit    bigint;
  v_name     text;
  v_seq      int;
  v_attempt  sc.completion_attempts;
  v_missing  int;
  v_done     int;
  v_official bigint;
  v_message  text;
  v_first    boolean;
  v_revision bigint;
begin
  select role into v_role from sc.operators where user_id = v_uid and revoked_at is null;
  if v_role is null then
    return sc._result(false, 'PERMISSION_DENIED', 'TÀI KHOẢN CHƯA ĐƯỢC PHÂN QUYỀN VỊ TRÍ', 0, sc.now_ms());
  end if;
  -- A viewer has no operational authority at all, whatever it sends.
  if v_role = 'OBSERVER' then
    return sc._result(false, 'READ_ONLY', 'NGƯỜI THEO DÕI CHỈ XEM ĐƯỢC', 0, sc.now_ms());
  end if;

  -- one shared game state: serialise writers instead of letting two phones race
  perform pg_advisory_xact_lock(30500);

  if not exists (select 1 from sc.role_permissions where action = p_action and role = v_role) then
    return sc._result(false, 'PERMISSION_DENIED', v_role || ' KHÔNG ĐƯỢC PHÉP ' || p_action, 0, sc.now_ms());
  end if;

  select * into v_state from sc.state where id = true;
  select * into v_event from sc.events where id = v_state.event_id;
  v_now := sc.now_ms();

  -- idempotency: a retried tap returns the original result and writes nothing
  if exists (select 1 from sc.action_log
             where actor_id = v_uid::text and action = p_action and idempotency_key = p_idempotency_key) then
    return sc._result(true, 'OK', 'ĐÃ GHI NHẬN TRƯỚC ĐÓ', v_event.revision, v_now);
  end if;

  -- A phone that is merely behind is told so before any state question, so its
  -- client resynchronises instead of reporting a refused transition.
  if p_expected_revision <> v_event.revision then
    return sc._result(false, 'STALE_REVISION',
                      'Trạng thái đã thay đổi (bản ' || v_event.revision || '). Đang đồng bộ lại…',
                      v_event.revision, v_now);
  end if;

  select * into v_round from sc.rounds
   where event_id = v_event.id and status <> 'CLOSED'
   order by round_number desc limit 1;
  v_der := sc._derive(v_round, v_now);
  v_live := nullif(v_der->>'live', 'null');
  v_result := v_der->>'result';
  v_deadline := nullif(v_der->>'deadline', 'null')::bigint;
  v_limit := (v_der->>'limit')::bigint;
  if v_round.id is null and v_live is null and p_action not in ('CALL_TEAM', 'CONFIGURE', 'END_EVENT', 'REVIEW_RESOLVE', 'CORRECT_ROUND', 'REOPEN_RESET') then
    return sc._result(false, 'INVALID_STATE', 'Không có lượt chơi đang hoạt động', v_event.revision, v_now);
  end if;
  if not sc._phase_allows(p_action, v_live, v_result) then
    return sc._result(false, 'INVALID_STATE',
      'Giai đoạn hiện tại không nhận thao tác này (' || coalesce(v_live, 'chưa có đội') || ')',
      v_event.revision, v_now);
  end if;

  if p_action = 'CONFIGURE' then
    if v_event.event_started_at is not null and
       (p_meta ? 'event_duration_ms' or p_meta ? 'game_limit_ms' or p_meta ? 'start_team_number' or p_meta ? 'event_name') then
      return sc._result(false, 'INVALID_STATE', 'Không đổi được thời lượng sau khi sự kiện đã chạy', v_event.revision, v_now);
    end if;
    if p_meta ? 'hidden_object_owner' and p_meta->>'hidden_object_owner' not in ('GATE','ROOM305') then
      return sc._result(false, 'INVALID_STATE', 'Chủ vật ẩn phải là NPC 1 hoặc NPC 2', v_event.revision, v_now);
    end if;
    update sc.events set
      name                = coalesce(p_meta->>'event_name', name),
      duration_ms         = coalesce((p_meta->>'event_duration_ms')::bigint, duration_ms),
      game_limit_ms       = coalesce((p_meta->>'game_limit_ms')::bigint, game_limit_ms),
      prep_allowance_ms   = coalesce((p_meta->>'prep_allowance_ms')::bigint, prep_allowance_ms),
      reset_target_ms     = case when p_meta ? 'reset_target_ms'
                                 then nullif((p_meta->>'reset_target_ms'), '')::bigint else reset_target_ms end,
      hidden_object_owner = coalesce(p_meta->>'hidden_object_owner', hidden_object_owner),
      start_team_number   = coalesce((p_meta->>'start_team_number')::int, start_team_number),
      next_team_number    = case when v_event.event_started_at is null
                                 then coalesce((p_meta->>'start_team_number')::int, next_team_number)
                                 else next_team_number end
     where id = v_event.id
     returning * into v_event;
    v_revision := sc._commit(v_event, p_action, null, 'NONE', null, p_idempotency_key, p_meta, 'Đã cập nhật cấu hình sự kiện', v_now);
    return sc._result(true, 'OK', 'Đã lưu cấu hình', v_revision, v_now);

  elsif p_action = 'CALL_TEAM' then
    if v_event.event_ended_at is not null then
      return sc._result(false, 'INVALID_STATE', 'SỰ KIỆN ĐÃ KẾT THÚC', v_event.revision, v_now);
    end if;
    if v_round.id is not null then
      return sc._result(false, 'INVALID_STATE',
        'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' vẫn chưa hoàn tất', v_event.revision, v_now);
    end if;
    -- Record the first reception for event history; it has no timer effect.
    v_first := v_event.event_started_at is null;
    if v_first then
      update sc.events set event_started_at = v_now where id = v_event.id returning * into v_event;
    end if;
    v_name := nullif(regexp_replace(btrim(coalesce(p_meta->>'team_name', '')), '[[:space:]]+', ' ', 'g'), '');
    if v_name is not null and length(v_name) > 40 then
      return sc._result(false, 'INVALID_STATE', 'Tên đội tối đa 40 ký tự', v_event.revision, v_now);
    end if;
    insert into sc.rounds (event_id, round_number, team_number, team_name, status, stage, called_at,
                           received_by_role, received_by, created_revision, result, admission_override, hiding_layout)
    values (v_event.id,
            (select count(*) from sc.rounds where event_id = v_event.id) + 1,
            v_event.next_team_number, v_name,
            'WAITING_FLOOR2_CONFIRMATION', 1, v_now,
            v_role, v_uid, v_event.revision + 1, 'IN_PROGRESS',
            coalesce((p_meta->>'override')::boolean, false) and coalesce(p_meta->>'reason','') <> '',
            v_event.hiding_layout)
    returning * into v_round;
    update sc.events set next_team_number = next_team_number + 1 where id = v_event.id returning * into v_event;
    insert into sc.reset_tasks (round_id, task_key, required_role) values
      (v_round.id, 'hidden_objects', v_event.hidden_object_owner),
      (v_round.id, 'hallway', 'GATE'),
      (v_round.id, 'room', 'ROOM305');
    v_revision := sc._commit(v_event, p_action, v_round, 'NONE', 'WAITING_FLOOR2_CONFIRMATION', p_idempotency_key,
                             jsonb_build_object('team_name', v_round.team_name,
                                                'override', case when coalesce((p_meta->>'override')::boolean, false) then true else null end,
                                                'event_clock_started', case when v_first then true else null end),
                             'Đã nhận đội #' || lpad(v_round.team_number::text, 3, '0') || ' và cho lên tầng 2', v_now);
    return sc._result(true, 'OK', 'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' đã được cho lên tầng 2', v_revision, v_now);

  elsif p_action = 'CONFIRM_FLOOR2' then
    if v_round.floor2_confirmed_at is not null then
      return sc._result(true, 'OK', 'Đã xác nhận tầng 2 trước đó', v_event.revision, v_now);
    end if;
    -- A stale tap after NPC1 bypassed floor 2 is refused safely: the workflow does
    -- not revert and no fabricated confirmation is written.
    if v_round.floor2_bypassed_at is not null then
      return sc._result(false, 'INVALID_STATE',
                        'NPC 1 đã bỏ qua xác nhận tầng 2 — thao tác này không còn hiệu lực',
                        v_event.revision, v_now);
    end if;
    update sc.rounds set status = 'READY_AT_FLOOR3', stage = greatest(stage, 2),
           floor2_confirmed_at = v_now, floor2_confirmed_by_role = v_role, floor2_confirmed_by = v_uid
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, 'WAITING_FLOOR2_CONFIRMATION', 'READY_AT_FLOOR3',
                             p_idempotency_key, jsonb_build_object('operator', v_role),
                             'Đã nhận đội đến tầng 2 — đang được hướng dẫn lên tầng 3', v_now);
    return sc._result(true, 'OK', 'Đội sắp bắt đầu — NPC 1 có thể bấm BẮT ĐẦU', v_revision, v_now);

  elsif p_action = 'FLOOR2_BYPASS' then
    if coalesce(p_meta->>'reason', '') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do bỏ qua tầng 2', v_event.revision, v_now);
    end if;
    if v_round.floor2_confirmed_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Tầng 2 đã được xác nhận — không cần bỏ qua', v_event.revision, v_now);
    end if;
    if v_round.game_started_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Trận đã bắt đầu', v_event.revision, v_now);
    end if;
    update sc.rounds set status = 'READY_AT_FLOOR3', stage = greatest(stage, 2),
           floor2_bypassed_at = v_now, floor2_bypassed_by_role = v_role,
           floor2_bypassed_by = v_uid, floor2_bypass_reason = p_meta->>'reason'
     where id = v_round.id returning * into v_round;
    perform sc._review(v_round.id, 'FLOOR2_BYPASS');
    v_revision := sc._commit(v_event, p_action, v_round, 'WAITING_FLOOR2_CONFIRMATION', 'READY_AT_FLOOR3',
                             p_idempotency_key,
                             jsonb_build_object('bypassed_by', v_role, 'reason', p_meta->>'reason',
                                                'floor2_confirmed', false),
                             'Bỏ qua xác nhận tầng 2 cho đội #' || lpad(v_round.team_number::text, 3, '0'), v_now);
    return sc._result(true, 'OK', 'ĐÃ BỎ QUA TẦNG 2 — đội sẵn sàng ở tầng 3', v_revision, v_now);

  elsif p_action = 'START_GAME' then
    if v_round.floor2_confirmed_at is null and v_round.floor2_bypassed_at is null then
      return sc._result(false, 'INVALID_STATE', 'Chưa xác nhận đội ở tầng 3', v_event.revision, v_now);
    end if;
    if v_round.game_started_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Đồng hồ trận đã chạy', v_event.revision, v_now);
    end if;
    update sc.rounds set status = 'RUNNING', stage = greatest(stage, 3),
           game_started_at = v_now, deadline_at = v_now + v_limit,
           started_by_role = v_role, started_by = v_uid
     where id = v_round.id returning * into v_round;
    -- Transport diagnostics only: the authoritative instant stays the server value.
    v_press := nullif(p_meta#>>'{_press,press_ms}', '')::bigint;
    if v_press is not null then
      v_delay := greatest(0, v_now - v_press);
      update sc.rounds set start_press_ms = v_press, start_transport_ms = v_delay
       where id = v_round.id returning * into v_round;
      if v_delay > v_event.review_threshold_ms then
        perform sc._review(v_round.id, 'START_TRANSPORT');
      end if;
    end if;
    v_revision := sc._commit(v_event, p_action, v_round, 'READY_AT_FLOOR3', 'RUNNING', p_idempotency_key,
                             jsonb_build_object('prep_ms', v_now - v_round.called_at,
                                                'deadline_at', v_round.deadline_at,
                                                'limit_ms', v_limit,
                                                'start_transport_ms', v_delay),
                             'Bắt đầu 5:00 cho đội #' || lpad(v_round.team_number::text, 3, '0'), v_now);
    return sc._result(true, 'OK', 'ĐÃ BẮT ĐẦU 5:00 — màn hình đã khoá', v_revision, v_now);

  elsif p_action = 'CLAIM_COMPLETE' then
    if v_deadline is null then
      return sc._result(false, 'INVALID_STATE', 'Trận chưa bắt đầu', v_event.revision, v_now);
    end if;
    select coalesce(max(seq), 0) + 1 into v_seq from sc.completion_attempts where round_id = v_round.id;
    v_press := nullif(p_meta#>>'{_press,press_ms}', '')::bigint;
    v_delay := case when v_press is null then null else greatest(0, v_now - v_press) end;
    insert into sc.completion_attempts (round_id, event_id, seq, claimed_at, elapsed_ms, remaining_ms,
                                        in_time, status, claimed_by_role, claimed_by,
                                        claim_press_ms, claim_transport_ms, revision)
    values (v_round.id, v_event.id, v_seq, v_now,
            greatest(0, v_now - coalesce(v_round.game_started_at, v_now)), v_deadline - v_now,
            v_now < v_deadline,
            case when v_now < v_deadline then 'PENDING' else 'LATE' end,
            v_role, v_uid, v_press, v_delay, v_event.revision + 1)
    returning * into v_attempt;
    -- The countdown deliberately keeps running: a claim may be wrong and nobody knows
    -- that yet, so only the claim instant is recorded here.
    if v_attempt.status = 'LATE' then
      perform sc._review(v_round.id, 'LATE_CLAIM');
    elsif coalesce(v_delay, 0) > v_event.review_threshold_ms then
      perform sc._review(v_round.id, 'CLAIM_TRANSPORT');
    end if;
    v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_live, p_idempotency_key,
                             jsonb_build_object('attempt_id', v_attempt.id, 'claimed_at', v_now,
                                                'elapsed_ms', v_attempt.elapsed_ms,
                                                'remaining_ms', v_attempt.remaining_ms,
                                                'in_time', v_attempt.in_time,
                                                'press_transport_ms', v_delay),
                             'Lần ' || v_seq || ' — ghi nhận báo hoàn thành lúc '
                               || lpad((v_attempt.elapsed_ms / 60000)::text, 2, '0') || ':'
                               || lpad(((v_attempt.elapsed_ms % 60000) / 1000)::text, 2, '0'), v_now);
    return sc._result(true, 'OK',
      case when v_attempt.in_time
           then 'LẦN ' || v_seq || ' — ĐANG KIỂM TRA, đồng hồ vẫn chạy'
           else 'LẦN ' || v_seq || ' — GHI NHẬN SAU HẾT GIỜ (không thành thắng)' end,
      v_revision, v_now);

  elsif p_action = 'VERIFY_ATTEMPT' then
    select * into v_attempt from sc.completion_attempts
     where id = nullif(p_meta->>'attempt_id', '')::bigint and round_id = v_round.id;
    if not found then
      return sc._result(false, 'INVALID_STATE', 'Không tìm thấy lần báo hoàn thành', v_event.revision, v_now);
    end if;
    if v_attempt.status not in ('PENDING', 'LATE') then
      return sc._result(true, 'OK', 'Lần ' || v_attempt.seq || ' đã được chốt: ' || v_attempt.status,
                        v_event.revision, v_now);
    end if;
    if p_meta->>'decision' = 'INVALID' then
      -- Only this attempt closes: the timestamp, the countdown and the history stay.
      update sc.completion_attempts
         set status = 'INVALID', verified_by_role = v_role, verified_by = v_uid,
             verified_at = v_now, decision_note = nullif(p_meta->>'note', ''), revision = v_event.revision + 1
       where id = v_attempt.id;
      v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_live, p_idempotency_key,
                               jsonb_build_object('attempt_id', v_attempt.id, 'claimed_at', v_attempt.claimed_at,
                                                  'decision', 'INVALID'),
                               'Lần ' || v_attempt.seq || ' — CHƯA ĐÚNG, đội tiếp tục chơi', v_now);
      return sc._result(true, 'OK', 'LẦN ' || v_attempt.seq || ' CHƯA ĐÚNG — 5:00 vẫn chạy', v_revision, v_now);
    end if;
    if p_meta->>'decision' <> 'VALID' then
      return sc._result(false, 'INVALID_STATE', 'Quyết định không hợp lệ', v_event.revision, v_now);
    end if;
    -- The eligibility boundary, stated once: a claim at or after the deadline cannot
    -- create a winning result, however correct the arrangement turns out to be.
    if not v_attempt.in_time then
      return sc._result(false, 'INVALID_STATE',
        'Lần ' || v_attempt.seq || ' được ghi nhận sau hết giờ — không thể thành kết quả thắng',
        v_event.revision, v_now);
    end if;
    -- Atomic finalization: the official time is the claim's own instant.
    v_official := greatest(0, v_attempt.claimed_at - coalesce(v_round.game_started_at, v_attempt.claimed_at));
    update sc.completion_attempts
       set status = 'VALID', verified_by_role = v_role, verified_by = v_uid,
           verified_at = v_now, decision_note = nullif(p_meta->>'note', ''), revision = v_event.revision + 1
     where id = v_attempt.id;
    update sc.rounds
       set status = case when exit_confirmed_at is null then 'WAITING_FOR_EXIT' else status end,
           stage = greatest(stage, case when exit_confirmed_at is null then 4 else 5 end),
           result = 'WON',
           official_duration_ms = v_official,
           validated_attempt_id = v_attempt.id,
           puzzle_completed_at = v_attempt.claimed_at
     where id = v_round.id returning * into v_round;
    if abs(v_limit - v_official) <= v_event.review_threshold_ms then
      perform sc._review(v_round.id, 'CLOSE_FINISH');
    end if;
    v_revision := sc._commit(v_event, p_action, v_round, v_live, v_round.status, p_idempotency_key,
                             jsonb_build_object('attempt_id', v_attempt.id, 'decision', 'VALID',
                                                'claimed_at', v_attempt.claimed_at,
                                                'official_duration_ms', v_official,
                                                'verified_at', v_now,
                                                'verification_delay_ms', v_now - v_attempt.claimed_at),
                             'Lần ' || v_attempt.seq || ' — CHÍNH XÁC. Kết quả chính thức ' || v_official || ' ms', v_now);
    return sc._result(true, 'OK', 'THÀNH CÔNG — chờ đội rời tầng 3', v_revision, v_now);

  elsif p_action = 'CONFIRM_EXIT' then
    if v_round.exit_confirmed_at is not null then
      return sc._result(true, 'OK', 'Đã xác nhận đội rời tầng 3', v_event.revision, v_now);
    end if;
    -- The team is never detained by the software: an unresolved claim stays open and
    -- the departure is still recorded, with the result settled on the row here.
    update sc.rounds set status = 'EXIT_CONFIRMED', stage = greatest(stage, 5),
           exit_confirmed_at = v_now, exit_by_role = v_role, exit_by = v_uid,
           result = coalesce(v_result, 'IN_PROGRESS')
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_live, 'EXIT_CONFIRMED', p_idempotency_key,
                             jsonb_build_object('exited_at', v_now, 'result', v_round.result,
                                                'official_duration_ms', v_round.official_duration_ms,
                                                'pending_validation',
                                                  exists (select 1 from sc.completion_attempts a
                                                           where a.round_id = v_round.id and a.status = 'PENDING'
                                                             and a.claimed_at < coalesce(v_deadline, 0))),
                             'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' đã rời tầng 3', v_now);
    return sc._result(true, 'OK',
      case when exists (select 1 from sc.completion_attempts a
                         where a.round_id = v_round.id and a.status = 'PENDING'
                           and a.claimed_at < coalesce(v_deadline, 0))
           then 'ĐÃ GHI NHẬN RỜI KHU VỰC · KẾT QUẢ VẪN CHỜ NPC 2 XÁC MINH'
           else 'ĐÃ GHI NHẬN RỜI KHU VỰC — khu vực cần reset' end, v_revision, v_now);

  elsif p_action = 'EARLY_EXIT' then
    if coalesce(p_meta->>'reason', '') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do kết thúc sớm', v_event.revision, v_now);
    end if;
    if v_round.result = 'WON' then
      return sc._result(false, 'INVALID_STATE',
                        'Kết quả đã chốt THÀNH CÔNG — dùng XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3',
                        v_event.revision, v_now);
    end if;
    -- A guarded exception that terminates gameplay safely and never fabricates a
    -- successful completion time.
    update sc.rounds
       set status = 'EXIT_CONFIRMED', stage = greatest(stage, 5),
           game_stopped_at = coalesce(game_stopped_at, case when game_started_at is null then null else v_now end),
           official_duration_ms = case when game_started_at is null then official_duration_ms else null end,
           exit_confirmed_at = coalesce(exit_confirmed_at, v_now),
           exit_by_role = v_role, exit_by = v_uid, exit_reason = p_meta->>'reason',
           aborted_at = v_now, result = 'ABORTED', outcome = 'ABORTED'
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_live, 'EXIT_CONFIRMED', p_idempotency_key,
                             jsonb_build_object('reason', p_meta->>'reason', 'result', 'ABORTED',
                                                'elapsed_ms', case when v_round.game_started_at is null then null
                                                                  else v_now - v_round.game_started_at end),
                             'KẾT THÚC SỚM đội #' || lpad(v_round.team_number::text, 3, '0'), v_now);
    return sc._result(true, 'OK', 'ĐÃ KẾT THÚC SỚM — không có kết quả thắng', v_revision, v_now);

  elsif p_action = 'RESET_DONE' then
    update sc.reset_tasks
       set completed_at = v_now, confirmed_by_role = v_role, confirmed_by = v_uid,
           cycle = v_round.reset_cycle,
           layout = case when task_key = 'hidden_objects' then v_event.hiding_layout else layout end,
           revision = v_event.revision + 1
     where round_id = v_round.id
       and (completed_at is null or cycle <> v_round.reset_cycle)
       and required_role = v_role;
    get diagnostics v_done = row_count;
    if v_done = 0 then
      return sc._result(true, 'OK', 'Không có tác vụ nào chờ xác nhận', v_event.revision, v_now);
    end if;
    v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_round.status, p_idempotency_key,
                             jsonb_build_object('tasks', (select jsonb_agg(task_key) from sc.reset_tasks
                                                           where round_id = v_round.id and completed_at = v_now),
                                                'cycle', v_round.reset_cycle,
                                                'layout', v_event.hiding_layout,
                                                'since_exit_ms', case when v_round.exit_confirmed_at is null then null
                                                                     else v_now - v_round.exit_confirmed_at end),
                             v_role || ' xác nhận xong reset', v_now);
    return sc._result(true, 'OK', 'Đã ghi nhận reset', v_revision, v_now);

  elsif p_action = 'GATE_FINALIZE' then
    if v_round.exit_confirmed_at is null then
      return sc._result(false, 'BLOCKED', 'NPC 1 chưa xác nhận đội rời tầng 3', v_event.revision, v_now);
    end if;
    if v_result in ('IN_PROGRESS', 'PENDING_VALIDATION') then
      return sc._result(false, 'BLOCKED',
                        'Kết quả trận chưa chốt — NPC 2 cần xác minh lần báo hoàn thành', v_event.revision, v_now);
    end if;
    select count(*) into v_missing from sc.reset_tasks
     where round_id = v_round.id and (completed_at is null or cycle <> v_round.reset_cycle);
    if v_missing > 0 then
      return sc._result(false, 'BLOCKED', 'Chưa xác nhận reset: còn ' || v_missing || ' tác vụ',
                        v_event.revision, v_now);
    end if;
    update sc.rounds set status = 'CLOSED', stage = 6, result = v_result,
           gate_finalized_at = v_now, finalized_by_role = v_role, system_ready_at = v_now
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, 'EXIT_CONFIRMED', 'CLOSED', p_idempotency_key,
                             jsonb_build_object('total_reset_ms', v_now - v_round.exit_confirmed_at,
                                                'result', v_round.result,
                                                'official_duration_ms', v_round.official_duration_ms,
                                                'cycle', v_round.reset_cycle),
                             'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' đã đóng · SẴN SÀNG nhận đội tiếp theo', v_now);
    return sc._result(true, 'OK', 'SẴN SÀNG nhận đội tiếp theo', v_revision, v_now);

  elsif p_action = 'SET_LAYOUT' then
    if p_meta->>'layout' not in ('A','B','C') then
      return sc._result(false, 'INVALID_STATE', 'Bố trí không hợp lệ (A/B/C)', v_event.revision, v_now);
    end if;
    if v_role <> 'SUPERVISOR' and v_role <> v_event.hidden_object_owner then
      return sc._result(false, 'PERMISSION_DENIED',
                        'Chỉ ' || v_event.hidden_object_owner || ' mới bố trí vật ẩn', v_event.revision, v_now);
    end if;
    update sc.events set hiding_layout = p_meta->>'layout' where id = v_event.id returning * into v_event;
    v_revision := sc._commit(v_event, p_action, v_round, v_live, null, p_idempotency_key,
                             jsonb_build_object('to', v_event.hiding_layout),
                             'Bố trí vật ẩn: ' || v_event.hiding_layout, v_now);
    return sc._result(true, 'OK', 'Đã chuẩn bị bố trí ' || v_event.hiding_layout, v_revision, v_now);

  elsif p_action = 'SET_TEAM_NAME' then
    if jsonb_typeof(p_meta->'team_name') is distinct from 'string' then
      return sc._result(false, 'INVALID_STATE', 'Thiếu tên đội', v_event.revision, v_now);
    end if;
    v_name := nullif(regexp_replace(btrim(p_meta->>'team_name'), '[[:space:]]+', ' ', 'g'), '');
    if length(v_name) > 40 then
      return sc._result(false, 'INVALID_STATE', 'Tên đội tối đa 40 ký tự', v_event.revision, v_now);
    end if;
    if v_round.team_name is not distinct from v_name then
      return sc._result(true, 'OK', 'Tên đội không thay đổi', v_event.revision, v_now);
    end if;
    v_message := v_round.team_name;
    update sc.rounds set team_name = v_name where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_round.status, p_idempotency_key,
                             jsonb_build_object('team_name', v_name, 'previous_team_name', v_message),
                             case when v_name is null then 'Đã xoá tên đội #' || lpad(v_round.team_number::text, 3, '0')
                                  else 'Đặt tên đội #' || lpad(v_round.team_number::text, 3, '0') || ': ' || v_name end,
                             v_now);
    return sc._result(true, 'OK', case when v_name is null then 'Đã xoá tên đội'
                                       else 'Đã đặt tên đội: ' || v_name end, v_revision, v_now);

  elsif p_action = 'REOPEN_RESET' then
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do mở lại reset', v_event.revision, v_now);
    end if;
    select * into v_round from sc.rounds where id = (p_meta->>'round_id')::bigint;
    if not found then
      return sc._result(false, 'INVALID_STATE', 'Không tìm thấy lượt chơi', v_event.revision, v_now);
    end if;
    if v_round.status <> 'CLOSED' and v_round.exit_confirmed_at is null then
      return sc._result(false, 'INVALID_STATE', 'Lượt chơi không ở giai đoạn reset', v_event.revision, v_now);
    end if;
    if v_round.status = 'CLOSED' and v_round.id <> (select max(id) from sc.rounds where event_id = v_event.id) then
      return sc._result(false, 'INVALID_STATE', 'Đã gọi đội mới — không thể mở lại reset cũ', v_event.revision, v_now);
    end if;
    update sc.reset_tasks
       set completed_at = null, confirmed_by_role = null, confirmed_by = null, layout = null,
           reopen_count = reopen_count + 1
     where round_id = v_round.id and completed_at is not null;
    update sc.rounds
       set reset_cycle = reset_cycle + 1, gate_finalized_at = null, finalized_by_role = null,
           system_ready_at = null, status = 'EXIT_CONFIRMED'
     where id = v_round.id returning * into v_round;
    update sc.reset_tasks set cycle = v_round.reset_cycle where round_id = v_round.id;
    perform sc._review(v_round.id, 'RESET_REOPENED');
    v_revision := sc._commit(v_event, p_action, v_round, v_round.status, 'EXIT_CONFIRMED', p_idempotency_key,
                             jsonb_build_object('reason', p_meta->>'reason',
                                                'task', coalesce(nullif(p_meta->>'task_key',''),'all'),
                                                'cycle', v_round.reset_cycle),
                             'Mở lại reset đội #' || lpad(v_round.team_number::text, 3, '0') || ' · chu kỳ ' || v_round.reset_cycle,
                             v_now);
    return sc._result(true, 'OK', 'Tất cả bước reset phải xác nhận lại', v_revision, v_now);

  elsif p_action = 'REVIEW_RESOLVE' then
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do quyết định', v_event.revision, v_now);
    end if;
    if p_meta->>'decision' not in ('ACCEPT','REJECT') then
      return sc._result(false, 'INVALID_STATE', 'Quyết định không hợp lệ', v_event.revision, v_now);
    end if;
    select * into v_round from sc.rounds where id = (p_meta->>'round_id')::bigint;
    if not found then
      return sc._result(false, 'INVALID_STATE', 'Không tìm thấy lượt chơi', v_event.revision, v_now);
    end if;
    if not v_round.needs_review then
      return sc._result(false, 'INVALID_STATE', 'Lượt chơi không chờ xem xét', v_event.revision, v_now);
    end if;
    update sc.rounds
       set needs_review = false, review_resolved_at = v_now,
           decertified = (p_meta->>'decision' = 'REJECT')
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_round.status, p_idempotency_key,
                             jsonb_build_object('reason', p_meta->>'reason', 'decision', p_meta->>'decision',
                                                'reasons', v_round.review_reasons,
                                                'official_duration_ms', v_round.official_duration_ms),
                             'Xét kết quả đội #' || lpad(v_round.team_number::text, 3, '0') || ': ' || (p_meta->>'decision'),
                             v_now);
    return sc._result(true, 'OK',
                      case when p_meta->>'decision' = 'ACCEPT' then 'Đã xếp hạng kết quả'
                           else 'Kết quả bị loại khỏi bảng xếp hạng' end, v_revision, v_now);

  elsif p_action = 'END_EVENT' then
    if v_event.event_ended_at is not null then
      return sc._result(false, 'INVALID_STATE', 'Sự kiện đã kết thúc', v_event.revision, v_now);
    end if;
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Cần nhập lý do đóng sự kiện sớm', v_event.revision, v_now);
    end if;
    if v_round.id is not null then
      return sc._result(false, 'BLOCKED',
                        case when v_round.exit_confirmed_at is null and v_round.game_started_at is not null
                             then 'Đội #' || lpad(v_round.team_number::text, 3, '0') || ' vẫn đang trong khu vực'
                             else 'Chưa hoàn tất reset và đóng lượt chơi hiện tại' end,
                        v_event.revision, v_now);
    end if;
    update sc.events set event_ended_at = v_now where id = v_event.id returning * into v_event;
    v_revision := sc._commit(v_event, p_action, null, 'NONE', 'ENDED', p_idempotency_key,
                             jsonb_build_object('overtime_ms', 0), 'SỰ KIỆN KẾT THÚC', v_now);
    return sc._result(true, 'OK', 'SỰ KIỆN KẾT THÚC', v_revision, v_now);

  elsif p_action = 'ABORT_ROUND' then
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do dừng khẩn cấp', v_event.revision, v_now);
    end if;
    update sc.rounds
       set status = 'EXIT_CONFIRMED', stage = greatest(stage, 5),
           game_stopped_at = coalesce(game_stopped_at, case when game_started_at is null then null else v_now end),
           official_duration_ms = case when game_started_at is null then official_duration_ms else null end,
           exit_confirmed_at = coalesce(exit_confirmed_at, case when game_started_at is null then null else v_now end),
           exit_by_role = v_role, exit_by = v_uid, exit_reason = p_meta->>'reason',
           aborted_at = v_now, result = 'ABORTED', outcome = 'ABORTED'
     where id = v_round.id returning * into v_round;
    v_revision := sc._commit(v_event, p_action, v_round, v_live, 'EXIT_CONFIRMED', p_idempotency_key,
                             jsonb_build_object('reason', p_meta->>'reason', 'result', 'ABORTED'),
                             'DỪNG KHẨN CẤP đội #' || lpad(v_round.team_number::text, 3, '0'), v_now);
    return sc._result(true, 'OK', 'Đã dừng khẩn cấp — khu vực cần reset', v_revision, v_now);

  elsif p_action = 'CORRECT_ROUND' then
    if coalesce(p_meta->>'reason','') = '' then
      return sc._result(false, 'BLOCKED', 'Bắt buộc nhập lý do hiệu chỉnh', v_event.revision, v_now);
    end if;
    select * into v_round from sc.rounds where id = (p_meta->>'round_id')::bigint;
    if not found then
      return sc._result(false, 'INVALID_STATE', 'Không tìm thấy lượt chơi', v_event.revision, v_now);
    end if;
    -- The claim rows are deliberately absent from this list: correcting a score means
    -- recording the decision against the right attempt, never rewriting a claim.
    if p_meta->>'field' not in ('game_started_at','deadline_at','exit_confirmed_at','floor2_confirmed_at') then
      return sc._result(false, 'INVALID_STATE', 'Trường không được phép hiệu chỉnh', v_event.revision, v_now);
    end if;
    v_message := nullif(p_meta->>'value_ms', '');
    update sc.rounds
       set game_started_at     = case when p_meta->>'field' = 'game_started_at'
                                      then v_message::bigint else game_started_at end,
           deadline_at         = case when p_meta->>'field' = 'deadline_at' then v_message::bigint
                                      when p_meta->>'field' = 'game_started_at' and v_message is not null
                                      then v_message::bigint + v_limit else deadline_at end,
           exit_confirmed_at   = case when p_meta->>'field' = 'exit_confirmed_at'
                                      then v_message::bigint else exit_confirmed_at end,
           floor2_confirmed_at = case when p_meta->>'field' = 'floor2_confirmed_at'
                                      then v_message::bigint else floor2_confirmed_at end
     where id = v_round.id returning * into v_round;
    -- A duration was scored from a claim, so re-derive it from the corrected start
    -- instead of trusting a wall-clock recomputation.
    if p_meta->>'field' = 'game_started_at' and v_round.validated_attempt_id is not null then
      update sc.rounds
         set official_duration_ms = greatest(0, (select a.claimed_at from sc.completion_attempts a
                                                  where a.id = v_round.validated_attempt_id) - v_round.game_started_at)
       where id = v_round.id returning * into v_round;
    end if;
    perform sc._review(v_round.id, 'CORRECTED');
    v_revision := sc._commit(v_event, p_action, v_round, v_round.status, v_round.status, p_idempotency_key,
                             jsonb_build_object('field', p_meta->>'field',
                                                'after_ms', v_message::bigint,
                                                'undone', v_message is null,
                                                'reason', p_meta->>'reason'),
                             'Hiệu chỉnh ' || (p_meta->>'field'), v_now);
    return sc._result(true, 'OK', 'Đã hiệu chỉnh · kết quả chờ xét lại', v_revision, v_now);

  elsif p_action in ('TEAM_UPSTAIRS','GAME_PAUSE','GAME_RESUME','GAME_RESET','HALLWAY_PROGRESS',
                     'ROOM_REACHED','PUZZLE_COMPLETE','RETURN_START','GAME_STOP','START_EVENT') then
    -- Retired controls: a stale client gets an explanation instead of a silent success
    -- that would move the state machine twice.
    return sc._result(false, 'UNKNOWN_ACTION',
                      'Thao tác này không còn trong quy trình hiện tại', v_event.revision, v_now);
  end if;

  return sc._result(false, 'UNKNOWN_ACTION', 'Hành động không xác định', v_event.revision, v_now);
end $$;

-- ------------------------------------------------------- 10. the shared read view
-- A viewer is refused every command, and gets a view that withholds the operating
-- record: no actor identities, no transport diagnostics, no dispute flags, no claim
-- list and no reset checklist. The redaction happens here, on the authoritative side,
-- so no route change or client-side edit can widen what a viewer sees.
create or replace function sc._redact(p jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  with rounds as (
    select jsonb_agg(r - 'received_by' - 'received_by_role'
                       - 'floor2_confirmed_by' - 'floor2_confirmed_by_role'
                       - 'floor2_bypassed_by' - 'floor2_bypassed_by_role' - 'floor2_bypass_reason'
                       - 'started_by' - 'started_by_role'
                       - 'exit_by' - 'exit_by_role' - 'exit_reason'
                       - 'finalized_by_role'
                       - 'start_press_ms' - 'stop_press_ms'
                       - 'start_transport_ms' - 'stop_transport_ms'
                       - 'needs_review' - 'review_reasons' - 'review_resolved_at' - 'decertified'
                       - 'hiding_layout' - 'admission_override'
                       - 'game_anchor_ms' - 'game_elapsed_ms'
                       - 'game_reset_count' - 'game_pause_count'
                       - 'validated_attempt_id'
                       - 'reset_cycle' - 'created_revision'
                     order by ((r->>'round_number')::int)) as v
      from jsonb_array_elements(coalesce(p->'rounds', '[]'::jsonb)) r
  )
  select jsonb_set(
           jsonb_set(
             jsonb_set(
               jsonb_set(
                 jsonb_set(
                   jsonb_set(
                     jsonb_set(p, '{rounds}', coalesce((select v from rounds), '[]'::jsonb)),
                     '{log}', '[]'::jsonb),
                   '{operators}', '[]'::jsonb),
                 '{reset_tasks}', '[]'::jsonb),
               '{attempts}', '[]'::jsonb),
             '{event}',
             jsonb_set(
               p->'event', '{config}',
               (select coalesce(jsonb_object_agg(c.key, c.value), '{}'::jsonb)
                  from jsonb_each(p->'event'->'config') c
                 where c.key in ('event_name','event_duration_ms','game_limit_ms','prep_allowance_ms','reset_target_ms'))),
             true),
           '{redacted}', 'true'::jsonb, true);
$$;

-- Reads may settle nothing at all: expiry is derived from the stored deadline, so a
-- snapshot never needs to write. sc.tick() stays a no-op for compatibility.
create or replace function sc.snapshot() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_state sc.state; v_event sc.events; v_now bigint; v_role text; v_result jsonb;
begin
  v_role := sc.my_role();
  if v_role is null then
    raise exception 'PERMISSION_DENIED';
  end if;
  perform sc.tick();
  select * into v_state from sc.state where id = true;
  select * into v_event from sc.events where id = v_state.event_id;
  v_now := sc.now_ms();
  v_result := jsonb_build_object(
    'revision', v_event.revision,
    'server_now_ms', v_now,
    'event', jsonb_build_object(
      'id', v_event.id::text,
      'config', jsonb_build_object(
        'event_name', v_event.name,
        'event_duration_ms', v_event.duration_ms,
        'game_limit_ms', v_event.game_limit_ms,
        'prep_allowance_ms', v_event.prep_allowance_ms,
        'start_team_number', v_event.start_team_number,
        'reset_target_ms', v_event.reset_target_ms,
        'hidden_object_owner', v_event.hidden_object_owner,
        'hiding_layout', v_event.hiding_layout,
        'review_threshold_ms', v_event.review_threshold_ms,
        'stall_warn_ms', v_event.stall_warn_ms),
      'event_started_at', v_event.event_started_at,
      'event_ended_at', v_event.event_ended_at,
      'overtime_started_at', v_event.overtime_started_at,
      'closing_warned_at', v_event.closing_warned_at,
      'end_warned_at', v_event.end_warned_at,
      'next_team_number', v_event.next_team_number,
      'revision', v_event.revision),
    -- One row per round, split across two objects because jsonb_build_object caps at
    -- 100 arguments and a round now carries its own reception, handover, start, score
    -- and exit facts.
    'rounds', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id::text, 'event_id', r.event_id::text, 'round_number', r.round_number,
        'team_number', r.team_number, 'team_name', r.team_name, 'status', r.status, 'stage', r.stage,
        'called_at', r.called_at,
        'received_by_role', r.received_by_role, 'received_by', r.received_by::text,
        'floor2_confirmed_at', r.floor2_confirmed_at,
        'floor2_confirmed_by_role', r.floor2_confirmed_by_role,
        'floor2_confirmed_by', r.floor2_confirmed_by::text,
        'floor2_bypassed_at', r.floor2_bypassed_at,
        'floor2_bypassed_by_role', r.floor2_bypassed_by_role,
        'floor2_bypassed_by', r.floor2_bypassed_by::text,
        'floor2_bypass_reason', r.floor2_bypass_reason,
        'game_started_at', r.game_started_at,
        'started_by_role', r.started_by_role, 'started_by', r.started_by::text,
        'deadline_at', r.deadline_at,
        'game_anchor_ms', r.game_anchor_ms, 'game_elapsed_ms', r.game_elapsed_ms,
        'game_reset_count', r.game_reset_count, 'game_pause_count', r.game_pause_count,
        'game_stopped_at', r.game_stopped_at
      ) || jsonb_build_object(
        'official_duration_ms', r.official_duration_ms,
        'validated_attempt_id', r.validated_attempt_id::text,
        'puzzle_completed_at', r.puzzle_completed_at,
        'exit_confirmed_at', r.exit_confirmed_at,
        'exit_by_role', r.exit_by_role, 'exit_by', r.exit_by::text, 'exit_reason', r.exit_reason,
        'gate_finalized_at', r.gate_finalized_at, 'finalized_by_role', r.finalized_by_role,
        'system_ready_at', r.system_ready_at, 'aborted_at', r.aborted_at,
        'result', r.result, 'outcome', r.outcome,
        'admission_override', r.admission_override, 'hiding_layout', r.hiding_layout,
        'reset_cycle', r.reset_cycle, 'start_press_ms', r.start_press_ms, 'stop_press_ms', r.stop_press_ms,
        'start_transport_ms', r.start_transport_ms, 'stop_transport_ms', r.stop_transport_ms,
        'needs_review', r.needs_review, 'review_reasons', r.review_reasons,
        'review_resolved_at', r.review_resolved_at, 'decertified', r.decertified,
        'created_revision', r.created_revision)
        order by r.round_number)
      from sc.rounds r where r.event_id = v_event.id), '[]'::jsonb),
    'reset_tasks', coalesce((select jsonb_agg(jsonb_build_object(
        'round_id', t.round_id::text, 'task_key', t.task_key, 'required_role', t.required_role,
        'confirmed_by_role', t.confirmed_by_role, 'confirmed_by', t.confirmed_by::text,
        'completed_at', t.completed_at, 'cycle', t.cycle, 'reopen_count', t.reopen_count,
        'layout', t.layout, 'revision', t.revision) order by t.round_id, t.task_key)
      from sc.reset_tasks t
      join sc.rounds r on r.id = t.round_id where r.event_id = v_event.id), '[]'::jsonb),
    -- Every claim of the event, so each station can show the attempt list with its own
    -- timestamps. The viewer's copy of this array is emptied by sc._redact().
    'attempts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id::text, 'round_id', a.round_id::text, 'seq', a.seq,
        'claimed_at', a.claimed_at, 'elapsed_ms', a.elapsed_ms, 'remaining_ms', a.remaining_ms,
        'in_time', a.in_time, 'status', a.status,
        'claimed_by_role', a.claimed_by_role, 'claimed_by', a.claimed_by::text,
        'verified_by_role', a.verified_by_role, 'verified_by', a.verified_by::text,
        'verified_at', a.verified_at, 'decision_note', a.decision_note,
        'claim_press_ms', a.claim_press_ms, 'claim_transport_ms', a.claim_transport_ms,
        'revision', a.revision) order by a.round_id, a.claimed_at)
      from sc.completion_attempts a
      join sc.rounds r on r.id = a.round_id where r.event_id = v_event.id), '[]'::jsonb),
    'operators', sc.operator_states(v_event.id),
    'log', coalesce((select jsonb_agg(jsonb_build_object(
        'seq', l.seq, 'event_id', l.event_id::text, 'round_id', l.round_id::text,
        'team_number', l.team_number, 'action', l.action, 'actor_role', l.actor_role,
        'actor_id', l.actor_id, 'from_state', l.from_state, 'to_state', l.to_state,
        'at_ms', l.at_ms, 'revision', l.revision, 'idempotency_key', l.idempotency_key,
        'metadata', l.metadata) order by l.seq desc)
      from (select * from sc.action_log a where a.event_id = v_event.id order by a.seq desc limit 400) l), '[]'::jsonb)
  );
  if v_role = 'OBSERVER' then
    return sc._redact(v_result);
  end if;
  return v_result;
end $$;

-- The state pointer the Realtime channel publishes, readable by a viewer too: it
-- carries a revision and a server instant, and no operational content.
create or replace function sc.state_revision() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_now bigint; v_result jsonb;
begin
  if sc.my_role() is null then
    raise exception 'PERMISSION_DENIED';
  end if;
  v_now := sc.now_ms();
  select jsonb_build_object('revision', s.revision, 'server_now_ms', v_now, 'event_id', e.id::text)
    into v_result
    from sc.state s join sc.events e on e.id = s.event_id
   where s.id = true;
  return v_result;
end $$;

-- ------------------------------------------------- 11. the browser-facing surface
-- Observers join through the same anonymous auth the stations use, with no password:
-- they take a seat, beat for it, and may leave. Capacity is refused as data, never as
-- an exception, so the client can show the full-room message honestly.
create or replace function public.observer_join(p_viewer_id text) returns jsonb
language sql security definer set search_path = '' as $$
  select sc.claim_station('OBSERVER', null) ||
         (select jsonb_build_object('devices', count(*), 'capacity', 10)
            from sc.observer_seats s
            join sc.operators o on o.user_id = s.user_id and o.revoked_at is null and o.role = 'OBSERVER'
           where s.seen_at > now() - sc._observer_ttl())
$$;

create or replace function public.observer_beat(p_viewer_id text) returns jsonb
language sql security definer set search_path = '' as
$$ select sc.observer_beat(p_viewer_id) $$;

create or replace function public.observer_leave() returns jsonb
language sql security definer set search_path = '' as
$$ select sc.observer_leave() $$;

do $$
begin
  execute 'revoke all on function public.observer_join(text) from public, anon, authenticated';
  execute 'grant execute on function public.observer_join(text) to authenticated';
  execute 'revoke all on function public.observer_beat(text) from public, anon, authenticated';
  execute 'grant execute on function public.observer_beat(text) to authenticated';
  execute 'revoke all on function public.observer_leave() from public, anon, authenticated';
  execute 'grant execute on function public.observer_leave() to authenticated';
exception when undefined_function then
  raise notice 'observer wrappers not available yet';
end $$;

-- The seat table itself stays internal: it is presence bookkeeping, not something a
-- browser reads. RLS plus the absence of any policy keeps it closed either way.
revoke all on sc.observer_seats from public, anon, authenticated;
revoke all on function sc._redact(jsonb), sc._derive(sc.rounds, bigint),
  sc._phase_allows(text, text, text), sc._observer_sweep(), sc._observer_ttl()
  from public, anon, authenticated;
grant execute on function sc.observer_beat(text), sc.observer_leave() to authenticated;
grant execute on function sc.claim_station(text, text) to authenticated;

notify pgrst, 'reload schema';
