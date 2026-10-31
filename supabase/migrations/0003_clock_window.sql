-- SCREAM CONTROL — Room 305 · V2 · flexible 5-minute window (upgrade path)
--
-- Fresh installs already get these columns from 0001_init.sql. This migration
-- exists so a project that was created before the 5-minute clock became
-- pausable/resettable can be upgraded in place: the 90-minute timeline keeps
-- whatever anchor it already has, and a running round keeps its original start.
--
-- Apply with:  supabase db push   (or psql -f this file)

alter table sc.rounds add column if not exists game_anchor_ms   bigint;
alter table sc.rounds add column if not exists game_elapsed_ms  bigint not null default 0;
alter table sc.rounds add column if not exists game_reset_count int    not null default 0;
alter table sc.rounds add column if not exists game_pause_count int    not null default 0;

-- A round that is on the clock right now was, before this migration, measured
-- from its first start; keep that behaviour instead of reading it as paused.
update sc.rounds
   set game_anchor_ms = game_started_at
 where game_anchor_ms is null
   and game_started_at is not null
   and game_stopped_at is null;

-- A finished round keeps its banked time, so re-reporting metrics stays stable.
update sc.rounds
   set game_elapsed_ms = coalesce(official_duration_ms, 0)
 where game_stopped_at is not null
   and game_elapsed_ms = 0
   and coalesce(official_duration_ms, 0) > 0;

-- The start button is retired: the first LOBBY dispatch anchors the 90:00.
delete from sc.role_permissions where action = 'START_EVENT';

insert into sc.role_permissions (action, role) values
  ('GAME_PAUSE',  'GATE'), ('GAME_PAUSE',  'SUPERVISOR'),
  ('GAME_RESUME', 'GATE'), ('GAME_RESUME', 'SUPERVISOR'),
  ('GAME_RESET',  'GATE'), ('GAME_RESET',  'SUPERVISOR')
on conflict do nothing;
