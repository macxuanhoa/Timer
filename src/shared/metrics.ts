import type { CompletionAttempt, Outcome, ResetTask, Round, RoundResult, Snapshot } from './types.ts' ;
import { gameElapsedMs, resultOf, roundLimitMs } from './machine.ts';
import { DEFAULT_ROUND_DURATION_MS } from './constants.ts';

/** Per-round operational measurements, derived only from persisted timestamps. */
export interface RoundMetrics {
  team_number: number;
  round_number: number;
  /** Official score: the validated claim's elapsed time. Null until NPC2 finalises. */
  game_ms: number | null;
  prep_ms: number | null;
  /** @deprecated how often the window was restarted/paused (history only). */
  game_reset_count: number;
  game_pause_count: number;
  reset_total_ms: number | null;
  corridor_reset_ms: number | null;
  room_reset_ms: number | null;
  hidden_objects_reset_ms: number | null;
  gate_clear_ms: number | null;
  puzzle_completed: boolean;
  outcome: Outcome;
  result: RoundResult;
  /** Completion claims recorded on this round. */
  claims: number;
  /** Claims NPC2 judged incorrect, kept for traceability. */
  rejected: number;
  admitted_by_override: boolean;
  needs_review: boolean;
  review_reasons: string[];
  /** Network component of the official STOP, for honest dispute handling. */
  stop_transport_ms: number | null;
  start_transport_ms: number | null;
  floor2_confirmed: boolean;
  floor2_bypassed: boolean;
}

function diff(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined) return null;
  return Math.max(0, to - from);
}

/**
 * Only the reset confirmations of the current cycle count.
 *
 * A metrics pass asks for three keys per round, and each ask used to walk the whole
 * task list — quadratic across a 90-minute event. The list is indexed once per
 * snapshot instead (a WeakMap, so an index dies with the array it came from) and
 * looked up in constant time. The first match in array order wins, exactly as the
 * previous `find` did.
 */
type TaskDoneIndex = Map<string, number>;
const taskIndexByList = new WeakMap<ResetTask[], TaskDoneIndex>();
const taskSlot = (roundId: string, key: string, cycle: number) => `${roundId}|${key}|${cycle}`;

function taskIndex(tasks: ResetTask[]): TaskDoneIndex {
  let index = taskIndexByList.get(tasks);
  if (!index) {
    index = new Map<string, number>();
    for (const t of tasks) {
      if (t.completed_at === null) continue;
      const slot = taskSlot(t.round_id, t.task_key, t.cycle);
      if (!index.has(slot)) index.set(slot, t.completed_at);
    }
    taskIndexByList.set(tasks, index);
  }
  return index;
}

function taskDone(tasks: ResetTask[], round: Round, key: string): number | null {
  return taskIndex(tasks).get(taskSlot(round.id, key, round.reset_cycle)) ?? null;
}

/**
 * `nowMs` only matters for a round that is still on the clock; `attempts` only for
 * the result derivation, so a report never re-decides a score that was already
 * finalised from a validated claim.
 */
export function roundMetrics(
  round: Round,
  tasks: ResetTask[],
  nowMs?: number,
  attempts: CompletionAttempt[] = [],
  limitMs?: number,
): RoundMetrics {
  const resetFrom = round.exit_confirmed_at ?? round.game_stopped_at;
  const claims = attempts.filter((a) => a.round_id === round.id);
  // The round's own duration decides its expiry; the caller's value is only the
  // fallback for rows that carry neither a snapshot nor a deadline.
  const own = roundLimitMs(round, limitMs ?? DEFAULT_ROUND_DURATION_MS);
  return {
    team_number: round.team_number,
    round_number: round.round_number,
    game_ms:
      round.official_duration_ms ??
      (round.game_stopped_at === null && nowMs !== undefined && limitMs !== undefined
        ? Math.max(0, gameElapsedMs(round, nowMs))
        : null),
    prep_ms: elapsed(round, round.called_at, round.game_started_at, nowMs),
    game_reset_count: round.game_reset_count,
    game_pause_count: round.game_pause_count,
    reset_total_ms: elapsed(round, resetFrom, round.system_ready_at, nowMs),
    corridor_reset_ms: elapsed(round, resetFrom, taskDone(tasks, round, 'hallway'), nowMs),
    room_reset_ms: elapsed(round, resetFrom, taskDone(tasks, round, 'room'), nowMs),
    hidden_objects_reset_ms: elapsed(round, resetFrom, taskDone(tasks, round, 'hidden_objects'), nowMs),
    gate_clear_ms: elapsed(round, resetFrom, round.gate_finalized_at, nowMs),
    puzzle_completed: round.validated_attempt_id !== null || round.puzzle_completed_at !== null,
    outcome: round.outcome,
    result: limitMs !== undefined && nowMs !== undefined ? resultOf(round, attempts, own, nowMs) : round.result,
    claims: claims.length,
    rejected: claims.filter((a) => a.status === 'INVALID').length,
    admitted_by_override: round.admission_override,
    needs_review: round.needs_review,
    review_reasons: round.review_reasons,
    stop_transport_ms: round.stop_transport_ms,
    start_transport_ms: round.start_transport_ms,
    floor2_confirmed: round.floor2_confirmed_at !== null,
    floor2_bypassed: round.floor2_bypassed_at !== null,
  };
}

/**
 * A duration between two stamps. `nowMs` is only used for the one case that is
 * genuinely still open — a round that has not been closed yet — so a published
 * report keeps a stable number instead of growing with the clock.
 */
function elapsed(round: Round, from: number | null | undefined, to: number | null | undefined, nowMs?: number): number | null {
  if (from === null || from === undefined || to === null || to === undefined) {
    if (from === null || from === undefined || nowMs === undefined || round.system_ready_at !== null) return null;
    return Math.max(0, nowMs - from);
  }
  return Math.max(0, to - from);
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
  const prevEnd = prev.system_ready_at;
  return {
    team_number: next.team_number,
    prev_team_number: prev.team_number,
    inter_team_ms: diff(prevEnd, next.game_started_at),
    start_to_start_ms: diff(prev.game_started_at, next.game_started_at),
    idle_after_ready_ms: diff(prevEnd, next.called_at),
    next_prep_ms: diff(next.called_at, next.game_started_at),
  };
}

/* ------------------------------------------------------------- leaderboard */

/**
 * A result ranks only when an in-time claim was verified correct, the physical exit
 * was confirmed, the official duration is within the round's own duration, and no
 * dispute is open. A flagged round is kept immutable and simply excluded until a
 * supervisor decides.
 */
export function qualifiesForLeaderboard(r: Round, gameLimitMs: number): boolean {
  if (r.official_duration_ms === null) return false;
  if (r.exit_confirmed_at === null) return false;
  if (!(r.result === 'WON' || r.outcome === 'WON')) return false;
  if (r.needs_review || r.decertified) return false;
  return r.official_duration_ms <= roundLimitMs(r, gameLimitMs);
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
  aborted: number;
  disputed: number;
  avg_game_ms: number | null;
  avg_prep_ms: number | null;
  avg_reset_ms: number | null;
  avg_cycle_ms: number | null;
  longest_reset: { team_number: number; ms: number } | null;
  longest_prep: { team_number: number; ms: number } | null;
  total_idle_ms: number;
  /** @deprecated how often the retired flexible window was restarted or paused. */
  clock_resets: number;
  clock_pauses: number;
  /** Completion claims recorded and rejected across the event. */
  claims: number;
  claims_rejected: number;
  fastest: LeaderRow | null;
  cycles: CycleMetrics[];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function analytics(
  snapshot: Pick<Snapshot, 'rounds' | 'reset_tasks' | 'event'> & Partial<Pick<Snapshot, 'attempts'>>,
  _nowMs: number,
): Analytics {
  const rounds = [...snapshot.rounds].sort((a, b) => a.round_number - b.round_number);
  const attempts = snapshot.attempts ?? [];
  const limit = snapshot.event.config.game_limit_ms;
  const metrics = rounds.map((r) => roundMetrics(r, snapshot.reset_tasks, undefined, attempts, limit));
  // A round is “done” once it was closed; the retired STOP press no longer defines it.
  const completed = rounds.filter((r) => r.system_ready_at !== null);
  const cycles: CycleMetrics[] = [];
  for (let i = 1; i < rounds.length; i++) cycles.push(cycleMetrics(rounds[i - 1], rounds[i]));

  const rows = leaderboard({ rounds, event: snapshot.event });
  const qualifying = rounds.filter((r) => qualifiesForLeaderboard(r, limit));
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
    timeouts: rounds.filter((r) => r.result === 'TIME_UP' || r.outcome === 'TIMEOUT' || r.outcome === 'NO_PUZZLE').length,
    aborted: rounds.filter((r) => r.result === 'ABORTED' || r.aborted_at !== null).length,
    avg_game_ms: mean(qualifying.map((r) => r.official_duration_ms as number)),
    avg_prep_ms: mean(metrics.map((m) => m.prep_ms).filter((v): v is number => v !== null)),
    avg_reset_ms: mean(resetValues),
    avg_cycle_ms: avgCycle,
    longest_reset: longestReset,
    longest_prep: longestPrep,
    total_idle_ms: cycles.reduce((a, c) => a + (c.idle_after_ready_ms ?? 0), 0),
    clock_resets: metrics.reduce((a, m) => a + m.game_reset_count, 0),
    clock_pauses: metrics.reduce((a, m) => a + m.game_pause_count, 0),
    claims: attempts.length,
    claims_rejected: metrics.reduce((a, m) => a + m.rejected, 0),
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
