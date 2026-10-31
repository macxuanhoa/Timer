-- SCREAM CONTROL — Room 305 · V2 · PASS 1 data layer
-- Schema, tables, permissions table and row level security.
-- Apply with:  supabase db push   (or psql -f this file)

create schema if not exists sc;
grant usage on schema sc to authenticated;

-- ---------------------------------------------------------------- operators
-- Maps a Supabase Auth user to one of the five live operator roles.
create table sc.operators (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  role         text not null check (role in ('LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR')),
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------------------ runtime
-- Test-only clock override + safety flags. In a production project
-- allow_test_clock stays false, so sc_set_test_clock() is a no-op error.
create table sc.runtime_flags (
  id                boolean primary key default true check (id),
  allow_test_clock  boolean not null default false,
  test_now_ms       bigint
);
insert into sc.runtime_flags (id, allow_test_clock) values (true, false) on conflict do nothing;

-- ------------------------------------------------------------------- events
-- One row per 90-minute operating session. Authoritative time = server clock.
create table sc.events (
  id                       bigint generated always as identity primary key,
  name                     text    not null default 'SCREAM CONTROL — Room 305',
  duration_ms              bigint  not null default 5400000 check (duration_ms > 0),
  game_limit_ms            bigint  not null default 300000  check (game_limit_ms > 0),
  prep_allowance_ms        bigint  not null default 90000   check (prep_allowance_ms >= 0),
  reset_target_ms          bigint  check (reset_target_ms is null or reset_target_ms > 0),
  hidden_object_owner      text    not null default 'CORRIDOR' check (hidden_object_owner in ('GATE','CORRIDOR')),
  hiding_layout            text    not null default 'A' check (hiding_layout in ('A','B','C')),
  review_threshold_ms      bigint  not null default 500,
  stall_warn_ms            bigint  not null default 60000,
  start_team_number        int     not null default 1,
  next_team_number         int     not null default 1,
  event_started_at         bigint,                 -- epoch ms, server clock
  event_ended_at           bigint,                 -- epoch ms, controlled closure
  overtime_started_at      bigint,                 -- deadline passed with a team inside
  closing_warned_at        bigint,
  end_warned_at            bigint,
  revision                 bigint  not null default 0
);

-- Single-row pointer: also the Realtime change channel for revision hints.
create table sc.state (
  id         boolean primary key default true check (id),
  event_id   bigint not null references sc.events (id),
  revision   bigint not null default 0,
  updated_at bigint not null default 0
);

-- ------------------------------------------------------------------- rounds
create table sc.rounds (
  id                   bigint generated always as identity primary key,
  event_id             bigint not null references sc.events (id) on delete cascade,
  round_number         int    not null,
  team_number          int    not null,
  team_name            text,
  status               text   not null check (status in
    ('LOBBY_CALL','TEAM_PREPARING','GAME_STARTED','CORRIDOR_ACTIVE','ROOM_REACHED',
     'PUZZLE_COMPLETED','RETURNING','GAME_EXITED','RESETTING','RESET_CONFIRMED',
     'GATE_CLEARED','ABORTED')),
  stage                int    not null default 1,
  called_at            bigint not null,
  game_started_at      bigint,
  -- The 5-minute window is the only flexible clock: these four columns let GATE
  -- pause it, resume it, or restart it without ever touching the 90-minute timeline.
  game_anchor_ms       bigint,
  game_elapsed_ms      bigint not null default 0,
  game_reset_count     int    not null default 0,
  game_pause_count     int    not null default 0,
  game_stopped_at      bigint,
  official_duration_ms bigint,
  puzzle_completed_at  bigint,
  exit_confirmed_at    bigint,
  gate_finalized_at    bigint,
  system_ready_at      bigint,
  aborted_at           bigint,
  outcome              text   not null default 'IN_PROGRESS' check (outcome in
    ('IN_PROGRESS','WON','TIMEOUT','NO_PUZZLE','ABORTED')),
  admission_override   boolean not null default false,
  -- Layout prepared for this team, recorded at dispatch.
  hiding_layout        text   check (hiding_layout in ('A','B','C')),
  reset_cycle          int    not null default 1,
  -- Transport diagnostics: press estimate vs server commit. Never scored.
  start_press_ms       bigint,
  stop_press_ms        bigint,
  start_transport_ms   bigint,
  stop_transport_ms    bigint,
  -- Prize disputes: kept immutable and withheld from the ranking until decided.
  needs_review         boolean not null default false,
  review_reasons       text[]  not null default '{}',
  review_resolved_at   bigint,
  decertified          boolean not null default false,
  created_revision     bigint  not null default 0,
  unique (event_id, round_number),
  unique (event_id, team_number)
);

-- P0-03: at most one occupying round per event, enforced by the database itself
-- even if a future code path forgot the advisory lock.
create unique index rounds_single_active on sc.rounds (event_id) where status <> 'GATE_CLEARED';

-- ------------------------------------------------------------ reset tasks
-- Exactly one valid completion per task per round.
create table sc.reset_tasks (
  round_id         bigint not null references sc.rounds (id) on delete cascade,
  task_key         text   not null check (task_key in ('hidden_objects','hallway','room')),
  required_role    text   not null check (required_role in ('LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR')),
  confirmed_by_role text,
  confirmed_by     uuid references sc.operators (user_id),
  completed_at     bigint,
  -- Confirmation belongs to a cycle; reopening invalidates every older mark.
  cycle            int    not null default 1,
  reopen_count     int    not null default 0,
  layout           text   check (layout in ('A','B','C')),
  revision         bigint not null default 0,
  primary key (round_id, task_key)
);

-- -------------------------------------------------------------- action log
-- Append-only, immutable, server-timestamped history.
create table sc.action_log (
  seq              bigint generated always as identity primary key,
  event_id         bigint not null references sc.events (id),
  round_id         bigint references sc.rounds (id),
  team_number      int,
  action           text   not null,
  actor_role       text   not null,
  actor_id         text   not null,
  from_state       text,
  to_state         text,
  at_ms            bigint not null,
  recorded_at      timestamptz not null default now(),
  revision         bigint not null,
  idempotency_key  text   not null,
  metadata         jsonb  not null default '{}'::jsonb,
  unique (actor_id, action, idempotency_key)
);
create index if not exists action_log_event_idx on sc.action_log (event_id, seq);
create index if not exists rounds_event_idx     on sc.rounds (event_id, round_number);

-- ------------------------------------------------------ server-side rights
create table sc.role_permissions (
  action text not null,
  role   text not null check (role in ('LOBBY','GATE','CORRIDOR','ROOM305','SUPERVISOR')),
  primary key (action, role)
);
insert into sc.role_permissions (action, role) values
  ('CONFIGURE',        'SUPERVISOR'),
  ('CALL_TEAM',        'LOBBY'),      ('CALL_TEAM',        'SUPERVISOR'),
  ('TEAM_UPSTAIRS',    'LOBBY'),      ('TEAM_UPSTAIRS',    'GATE'), ('TEAM_UPSTAIRS', 'SUPERVISOR'),
  ('START_GAME',       'GATE'),       ('START_GAME',       'SUPERVISOR'),
  ('GAME_PAUSE',       'GATE'),       ('GAME_PAUSE',       'SUPERVISOR'),
  ('GAME_RESUME',      'GATE'),       ('GAME_RESUME',      'SUPERVISOR'),
  ('GAME_RESET',       'GATE'),       ('GAME_RESET',       'SUPERVISOR'),
  ('HALLWAY_PROGRESS', 'CORRIDOR'),   ('HALLWAY_PROGRESS', 'SUPERVISOR'),
  ('ROOM_REACHED',     'ROOM305'),    ('ROOM_REACHED',     'SUPERVISOR'),
  ('PUZZLE_COMPLETE',  'ROOM305'),    ('PUZZLE_COMPLETE',  'SUPERVISOR'),
  ('RETURN_START',     'ROOM305'),    ('RETURN_START',     'CORRIDOR'),
  ('RETURN_START',     'GATE'),       ('RETURN_START',     'SUPERVISOR'),
  ('GAME_STOP',        'GATE'),       ('GAME_STOP',        'SUPERVISOR'),
  ('RESET_DONE',       'CORRIDOR'),   ('RESET_DONE',       'ROOM305'),
  ('RESET_DONE',       'GATE'),       ('RESET_DONE',       'SUPERVISOR'),
  ('GATE_FINALIZE',    'GATE'),       ('GATE_FINALIZE',    'SUPERVISOR'),
  ('SET_LAYOUT',       'CORRIDOR'),   ('SET_LAYOUT',       'GATE'),
  ('SET_LAYOUT',       'SUPERVISOR'),
  ('REOPEN_RESET',     'SUPERVISOR'),
  ('REVIEW_RESOLVE',   'SUPERVISOR'),
  ('END_EVENT',        'SUPERVISOR'),
  ('ABORT_ROUND',      'SUPERVISOR'),
  ('CORRECT_ROUND',    'SUPERVISOR');

-- ------------------------------------------------------------------- RLS
alter table sc.operators      enable row level security;
alter table sc.events         enable row level security;
alter table sc.state          enable row level security;
alter table sc.rounds         enable row level security;
alter table sc.reset_tasks    enable row level security;
alter table sc.action_log     enable row level security;
alter table sc.runtime_flags  enable row level security;
alter table sc.role_permissions enable row level security;

-- Role resolution must not recurse into RLS, so it is SECURITY DEFINER.
create or replace function sc.my_role() returns text
language sql stable security definer set search_path = '' as
$$ select role from sc.operators where user_id = (select auth.uid()) $$;

create or replace function sc.is_operator() returns boolean
language sql stable security definer set search_path = '' as
$$ select exists (select 1 from sc.operators where user_id = (select auth.uid())) $$;

grant execute on function sc.my_role() to authenticated;
grant execute on function sc.is_operator() to authenticated;

-- Every operator may read the shared operational state; an operator may read
-- only their own profile row (used by the app to resolve its role on startup).
create policy operators_self on sc.operators for select to authenticated using (user_id = (select auth.uid()));
create policy events_read      on sc.events   for select to authenticated using (sc.is_operator());
create policy state_read       on sc.state    for select to authenticated using (sc.is_operator());
create policy rounds_read      on sc.rounds   for select to authenticated using (sc.is_operator());
create policy tasks_read       on sc.reset_tasks for select to authenticated using (sc.is_operator());
create policy log_read         on sc.action_log  for select to authenticated using (sc.is_operator());
create policy perms_read       on sc.role_permissions for select to authenticated using (sc.is_operator());

-- Table-level read rights for the operational state (RLS above still applies).
-- sc.runtime_flags stays unreadable by clients: only the SECURITY DEFINER
-- functions touch it.
grant select on sc.operators, sc.events, sc.state, sc.rounds, sc.reset_tasks, sc.action_log, sc.role_permissions
  to authenticated;

-- No INSERT/UPDATE/DELETE policies at all: writes happen only inside the
-- SECURITY DEFINER RPCs. Direct table writes fail closed.
revoke insert, update, delete, truncate on all tables in schema sc from authenticated;
revoke all on all sequences in schema sc from authenticated;
