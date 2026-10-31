import type { Outcome, ResetTask, Round, Snapshot } from './types.ts' ;
import { gameElapsedMs } from './machine.ts';

/** Per-round operational measurements, derived only from persisted timestamps. */
export interface RoundMetrics {
  team_number: number;
  round_number: number;
  /** Official score. Null until GATE STOP. */
  game_ms: number | null;
  prep_ms: number | null;
  /** Times GATE restarted / paused this 5-minute window. */
  game_reset_count: number;
  game_pause_count: number;
  reset_total_ms: number | null;
  corridor_reset_ms: number | null;
  room_reset_ms: number | null;
  hidden_objects_reset_ms: number | null;
  gate_clear_ms: number | null;
  puzzle_completed: boolean;
  outcome: Outcome;
  admitted_by_override: boolean;
  needs_review: boolean;
  review_reasons: string[];
  /** Network component of the official STOP, for honest dispute handling. */
  stop_transport_ms: number | null;
  start_transport_ms: number | null;
}

function diff(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined) return null;
  return Math.max(0, to - from);
}

/** Only the reset confirmations of the current cycle count. */
function taskDone(tasks: ResetTask[], round: Round, key: string): number | null {
  const t = tasks.find(
    (x) => x.round_id === round.id && x.task_key === key && x.completed_at !== null && x.cycle === round.reset_cycle,
  );
  return t?.completed_at ?? null;
}

/**
 * `nowMs` only matters for a round that is still on the clock: the running
 * measurement then follows the flexible 5-minute window (pauses excluded, resets
 * banked), never the raw wall distance from the first start.
 */
export function roundMetrics(round: Round, tasks: ResetTask[], nowMs?: number): RoundMetrics {
  const stop = round.game_stopped_at;
  return {
    team_number: round.team_number,
    round_number: round.round_number,
    game_ms: round.official_duration_ms ?? (stop === null && nowMs !== undefined ? gameElapsedMs(round, nowMs) : null),
    prep_ms: diff(round.called_at, round.game_started_at),
    game_reset_count: round.game_reset_count,
    game_pause_count: round.game_pause_count,
    reset_total_ms: diff(stop, round.system_ready_at),
    corridor_reset_ms: diff(stop, taskDone(tasks, round, 'hallway')),
    room_reset_ms: diff(stop, taskDone(tasks, round, 'room')),
    hidden_objects_reset_ms: diff(stop, taskDone(tasks, round, 'hidden_objects')),
    gate_clear_ms: diff(stop, round.gate_finalized_at),
    puzzle_completed: round.puzzle_completed_at !== null,
    outcome: round.outcome,
    admitted_by_override: round.admission_override,
    needs_review: round.needs_review,
    review_reasons: round.review_reasons,
    stop_transport_ms: round.stop_transport_ms,
    start_transport_ms: round.start_transport_ms,
  };
}

/** Cross-round metrics that require the previous round's timestamps. */
export interface CycleMetrics {
  team_number: number;
  prev_team_number: number;
  inter_team_ms: number | null;
  start_to_start_ms: number | null;
  idle_after_ready_ms: number | null;
  next_prep_ms: number | null;
}

export function cycleMetrics(prev: Round, next: Round): CycleMetrics {
  return {
    team_number: next.team_number,
    prev_team_number: prev.team_number,
    inter_team_ms: diff(prev.game_stopped_at, next.game_started_at),
    start_to_start_ms: diff(prev.game_started_at, next.game_started_at),
    idle_after_ready_ms: diff(prev.system_ready_at, next.called_at),
    next_prep_ms: diff(next.called_at, next.game_started_at),
  };
}

/* ------------------------------------------------------------- leaderboard */

/**
 * A result ranks only when the puzzle was confirmed, GATE confirmed the physical
 * exit, the official duration is within the limit, and no dispute is open. A
 * flagged round is kept immutable and simply excluded until a supervisor decides.
 */
export function qualifiesForLeaderboard(r: Round, gameLimitMs: number): boolean {
  if (r.official_duration_ms === null) return false;
  if (r.game_stopped_at === null || r.exit_confirmed_at === null) return false;
  if (r.puzzle_completed_at === null) return false;
  if (r.needs_review || r.decertified) return false;
  return r.outcome === 'WON' && r.official_duration_ms <= gameLimitMs;
}

export interface LeaderRow {
  rank: number;
  team_number: number;
  team_name: string | null;
  duration_ms: number;
  round_id: string;
}

export function leaderboard(snapshot: Pick<Snapshot, 'rounds' | 'event'>): LeaderRow[] {
  const limit = snapshot.event.config.game_limit_ms;
  return snapshot.rounds
    .filter((r) => qualifiesForLeaderboard(r, limit))
    // Fully deterministic: duration, then dispatch order. Identical times keep
    // the earlier round ahead on every device.
    .sort(
      (a, b) =>
        (a.official_duration_ms as number) - (b.official_duration_ms as number) || a.round_number - b.round_number,
    )
    .map((r, i) => ({
      rank: i + 1,
      team_number: r.team_number,
      team_name: r.team_name,
      duration_ms: r.official_duration_ms as number,
      round_id: r.id,
    }));
}

/** Rounds withheld from the ranking: prize-relevant, must never be silent. */
export function disputedRounds(rounds: Round[]): Round[] {
  return rounds.filter((r) => r.needs_review && r.official_duration_ms !== null);
}

/* --------------------------------------------------------------- analytics */

export interface Analytics {
  teams_completed: number;
  teams_successful: number;
  timeouts: number;
  disputed: number;
  avg_game_ms: number | null;
  avg_prep_ms: number | null;
  avg_reset_ms: number | null;
  avg_cycle_ms: number | null;
  longest_reset: { team_number: number; ms: number } | null;
  longest_prep: { team_number: number; ms: number } | null;
  total_idle_ms: number;
  /** How often the flexible 5-minute window had to be restarted or paused. */
  clock_resets: number;
  clock_pauses: number;
  fastest: LeaderRow | null;
  cycles: CycleMetrics[];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function analytics(
  snapshot: Pick<Snapshot, 'rounds' | 'reset_tasks' | 'event'>,
  _nowMs: number,
): Analytics {
  const rounds = [...snapshot.rounds].sort((a, b) => a.round_number - b.round_number);
  const metrics = rounds.map((r) => roundMetrics(r, snapshot.reset_tasks));
  const completed = rounds.filter((r) => r.game_stopped_at !== null);
  const cycles: CycleMetrics[] = [];
  for (let i = 1; i < rounds.length; i++) cycles.push(cycleMetrics(rounds[i - 1], rounds[i]));

  const rows = leaderboard({ rounds, event: snapshot.event });
  const qualifying = rounds.filter((r) => qualifiesForLeaderboard(r, snapshot.event.config.game_limit_ms));
  const resetValues = metrics.map((m) => m.reset_total_ms).filter((v): v is number => v !== null);
  const resetsWithTeam = metrics.filter((m) => m.reset_total_ms !== null);
  const longestReset = resetsWithTeam.reduce<{ team_number: number; ms: number } | null>((acc, m) => {
    const v = m.reset_total_ms as number;
    return !acc || v > acc.ms ? { team_number: m.team_number, ms: v } : acc;
  }, null);
  const prepsWithTeam = metrics.filter((m) => m.prep_ms !== null);
  const longestPrep = prepsWithTeam.reduce<{ team_number: number; ms: number } | null>((acc, m) => {
    const v = m.prep_ms as number;
    return !acc || v > acc.ms ? { team_number: m.team_number, ms: v } : acc;
  }, null);

  const cycleTimes = cycles.map((c) => c.start_to_start_ms).filter((v): v is number => v !== null);
  const avgCycle = mean(cycleTimes);

  return {
    teams_completed: completed.length,
    teams_successful: rows.length,
    disputed: disputedRounds(snapshot.rounds).length,
    timeouts: rounds.filter((r) => r.outcome === 'TIMEOUT').length,
    avg_game_ms: mean(qualifying.map((r) => r.official_duration_ms as number)),
    avg_prep_ms: mean(metrics.map((m) => m.prep_ms).filter((v): v is number => v !== null)),
    avg_reset_ms: mean(resetValues),
    avg_cycle_ms: avgCycle,
    longest_reset: longestReset,
    longest_prep: longestPrep,
    total_idle_ms: cycles.reduce((a, c) => a + (c.idle_after_ready_ms ?? 0), 0),
    clock_resets: metrics.reduce((a, m) => a + m.game_reset_count, 0),
    clock_pauses: metrics.reduce((a, m) => a + m.game_pause_count, 0),
    fastest: rows[0] ?? null,
    cycles,
  };
}

/* ------------------------------------------------------------------ formats */

const pad = (n: number, size = 2) => String(Math.floor(Math.abs(n))).padStart(size, '0');

/** MM:SS.mmm — official scoring precision. */
export function formatClockMs(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  return `${sign}${pad(abs / 60_000)}:${pad((abs % 60_000) / 1000)}.${pad(abs % 1000, 3)}`;
}

/** MM:SS — round clocks and calm displays. */
export function formatClockSec(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  return `${sign}${pad(abs / 60_000)}:${pad((abs % 60_000) / 1000)}`;
}


/** MM:SS.hh — the running game clock on the operator screen. */
export function formatClockCs(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  return `${sign}${pad(abs / 60_000)}:${pad((abs % 60_000) / 1000)}.${pad((abs % 1000) / 10)}`;
}

/** 12.4s style, for setup/reset measurements where milliseconds are noise. */
export function formatSeconds(ms: number | null, digits = 1): string {
  if (ms === null) return '—';
  return `${(ms / 1000).toFixed(digits)}s`;
}

/** Mixed precision: seconds below a minute, MM:SS above. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (Math.abs(ms) < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatClockSec(ms);
}

export function formatWallTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatTenths(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  return `${sign}${pad(abs / 60_000)}:${pad((abs % 60_000) / 1000)}.${Math.floor((abs % 1000) / 100)}`;
}
