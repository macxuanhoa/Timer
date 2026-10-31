import type { HiddenObjectOwner, HidingLayout, ResetTaskKey, Role } from './constants.ts';

export type { HidingLayout };

/* ------------------------------------------------------------------ clock */

/** All authoritative time is epoch milliseconds from a server-side clock. */
export interface Clock {
  nowMs(): number;
}

/** Wall clock used in production. */
export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

/**
 * Deterministic clock for tests: the whole 90-minute event can be replayed in
 * microseconds. Only the authoritative side may use this — never the renderer.
 */
export class FakeClock implements Clock {
  private current: number;
  constructor(startMs = 1_730_000_000_000) {
    this.current = startMs;
  }
  nowMs(): number {
    return this.current;
  }
  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }
  set(ms: number): number {
    this.current = ms;
    return this.current;
  }
}

/**
 * Real time that can still be jumped forward — used by the development engine so
 * a browser test can reach the 15-minute warning without waiting 75 minutes,
 * while the clock keeps ticking normally in between.
 */
export class OffsetClock implements Clock {
  private offset = 0;
  nowMs(): number {
    return Date.now() + this.offset;
  }
  advance(ms: number): number {
    this.offset += ms;
    return this.nowMs();
  }
  set(targetMs: number): number {
    this.offset = targetMs - Date.now();
    return this.nowMs();
  }
}

/** Any authoritative clock that may be stepped by a test harness. */
export type SteppableClock = Clock & { advance(ms: number): number; set(ms: number): number };

export function isSteppable(clock: Clock): clock is SteppableClock {
  return typeof (clock as SteppableClock).advance === 'function';
}

/* ------------------------------------------------------------------ event */

export type EventStatus = 'NOT_STARTED' | 'LIVE' | 'CLOSING' | 'ENDED';

export interface EventConfig {
  event_name: string;
  event_duration_ms: number;
  game_limit_ms: number;
  prep_allowance_ms: number;
  start_team_number: number;
  reset_target_ms: number | null;
  hidden_object_owner: HiddenObjectOwner;
  /** Results closer than this to the limit, or presses slower than this to commit, go to review. */
  review_threshold_ms: number;
  /** Alert when a team has been RETURNING (or playing) longer than this without STOP. */
  stall_warn_ms: number;
  hiding_layout: HidingLayout;
}

export interface EventSession {
  id: string;
  config: EventConfig;
  /**
   * Anchor of the fixed 90-minute timeline. Set the instant LOBBY dispatches the
   * first team (there is no separate "start event" press) and never moved again:
   * the clock keeps running past its deadline until `event_ended_at` is recorded.
   */
  event_started_at: number | null;
  event_ended_at: number | null;
  /** Set when the 90-minute deadline passed while a team was still inside. */
  overtime_started_at: number | null;
  closing_warned_at: number | null;
  end_warned_at: number | null;
  next_team_number: number;
  revision: number;
}

/* ------------------------------------------------------------------ round */

export type RoundStatus =
  | 'LOBBY_CALL'
  | 'TEAM_PREPARING'
  | 'GAME_STARTED'
  | 'CORRIDOR_ACTIVE'
  | 'ROOM_REACHED'
  | 'PUZZLE_COMPLETED'
  | 'RETURNING'
  | 'GAME_EXITED'
  | 'RESETTING'
  | 'RESET_CONFIRMED'
  | 'GATE_CLEARED'
  | 'ABORTED';

export type Outcome = 'IN_PROGRESS' | 'WON' | 'TIMEOUT' | 'NO_PUZZLE' | 'ABORTED';

export interface Round {
  id: string;
  event_id: string;
  round_number: number;
  team_number: number;
  team_name: string | null;
  status: RoundStatus;
  /** Highest lifecycle stage reached (1..6) — used for the progress line. */
  stage: number;
  called_at: number;
  game_started_at: number | null;
  /**
   * Start of the currently running segment of the 5-minute clock, or null while
   * GATE has paused it. The 90-minute event clock never pauses: only this window
   * is flexible, and every pause or reset keeps its own accumulated time.
   */
  game_anchor_ms: number | null;
  /** Playing time already banked before the current segment; 0 after a game reset. */
  game_elapsed_ms: number;
  game_stopped_at: number | null;
  /** How many times GATE restarted this 5-minute window (audited, prize-relevant). */
  game_reset_count: number;
  /** How many times GATE paused this 5-minute window. */
  game_pause_count: number;
  /** Official score, persisted once at GATE STOP. Never recomputed later. */
  official_duration_ms: number | null;
  puzzle_completed_at: number | null;
  exit_confirmed_at: number | null;
  gate_finalized_at: number | null;
  system_ready_at: number | null;
  aborted_at: number | null;
  outcome: Outcome;
  /** True when admission happened after the cutoff with an audited override. */
  admission_override: boolean;
  /** Layout prepared for this team, recorded at dispatch. */
  hiding_layout: HidingLayout;
  /** Increments every time a reset task is reopened, invalidating old DONE marks. */
  reset_cycle: number;
  /* ------------------------------------- transport diagnostics (never scored) */
  /** Operator's calibrated press instant for START / STOP, in server time. */
  start_press_ms: number | null;
  stop_press_ms: number | null;
  /** Server commit minus press estimate: how much of the timestamp is network. */
  start_transport_ms: number | null;
  stop_transport_ms: number | null;
  /* ------------------------------------------------------------- dispute flags */
  needs_review: boolean;
  review_reasons: string[];
  review_resolved_at: number | null;
  /** Supervisor rejected the result: kept, but never ranked again. */
  decertified: boolean;
  created_revision: number;
}

export interface ResetTask {
  round_id: string;
  task_key: ResetTaskKey;
  required_role: Role;
  confirmed_by_role: Role | null;
  confirmed_by: string | null;
  completed_at: number | null;
  /** Cycle the confirmation belongs to; only the current cycle counts. */
  cycle: number;
  reopen_count: number;
  layout: HidingLayout | null;
  revision: number;
}

/* --------------------------------------------------------------- action log */

export type ActionType =
  | 'CONFIGURE'
  | 'CALL_TEAM'
  | 'TEAM_UPSTAIRS'
  | 'START_GAME'
  | 'GAME_PAUSE'
  | 'GAME_RESUME'
  | 'GAME_RESET'
  | 'HALLWAY_PROGRESS'
  | 'ROOM_REACHED'
  | 'PUZZLE_COMPLETE'
  | 'RETURN_START'
  | 'GAME_STOP'
  | 'RESET_DONE'
  | 'GATE_FINALIZE'
  | 'SET_LAYOUT'
  | 'REOPEN_RESET'
  | 'REVIEW_RESOLVE'
  | 'END_EVENT'
  | 'ABORT_ROUND'
  | 'CORRECT_ROUND'
  | 'OVERRIDE_ADMIT'
  | 'OVERTIME_STARTED'
  | 'EVENT_CLOSED'
  | 'SESSION_RESTORE';

export interface LogEntry {
  seq: number;
  event_id: string;
  round_id: string | null;
  team_number: number | null;
  action: ActionType;
  actor_role: Role;
  actor_id: string;
  from_state: string | null;
  to_state: string | null;
  at_ms: number;
  revision: number;
  idempotency_key: string;
  metadata: Record<string, unknown> | null;
}

/* ---------------------------------------------------------------- snapshot */

export type SystemPhase =
  | 'PRE_EVENT'
  | 'READY'
  | 'PREPARING'
  | 'RUNNING'
  | 'EXITED'
  | 'RESETTING'
  | 'ENDED'
  | 'GAME_OVERTIME'
  | 'RESET_OVERTIME';

export interface OperatorState {
  role: Role;
  display_name: string;
  last_action: ActionType | null;
  last_action_at: number | null;
  last_detail: string | null;
}

export interface Snapshot {
  revision: number;
  server_now_ms: number;
  event: EventSession;
  event_status: EventStatus;
  phase: SystemPhase;
  active_round: Round | null;
  rounds: Round[];
  reset_tasks: ResetTask[];
  operators: OperatorState[];
  log: LogEntry[];
}

/* ------------------------------------------------------------------ commands */

export interface CommandMeta {
  reason?: string;
  override?: boolean;
  [key: string]: unknown;
}

/** Everything the authoritative layer needs to validate and timestamp a call. */
export interface CommandRequest {
  action: ActionType;
  actor: { id: string; role: Role; display_name: string };
  expected_revision: number;
  idempotency_key: string;
  meta?: CommandMeta;
  /**
   * Transport diagnostics captured at the instant of the physical press, from the
   * client's calibrated estimate of server time. Never used for scoring: it exists
   * so a network-delayed press can be flagged for review instead of trusted blindly.
   */
  press?: { press_ms: number; local_press_ms: number; rtt_ms: number | null };
}

/** Result of asking the server whether an idempotency key already committed. */
export interface OperationStatus {
  found: boolean;
  action?: ActionType;
  at_ms?: number;
  revision?: number;
  round_id?: string | null;
}

export interface RevisionHintResponse {
  revision: number;
  server_now_ms: number;
  event_id: string;
}

export interface CommandResult {
  ok: boolean;
  code: 'OK' | 'STALE_REVISION' | 'PERMISSION_DENIED' | 'INVALID_STATE' | 'BLOCKED' | 'UNKNOWN_ACTION';
  message: string;
  revision: number;
  snapshot?: Snapshot;
  requires_override?: boolean;
  server_now_ms: number;
}
