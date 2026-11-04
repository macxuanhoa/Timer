import type { AbortKind, HiddenObjectOwner, HidingLayout, ResetBlockReason, ResetTaskKey, Role } from './constants.ts';

export type { HidingLayout, AbortKind, ResetBlockReason };

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
 * Deterministic clock for tests: long sessions can be replayed in microseconds.
 * Only the authoritative side may use this — never the renderer.
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

export type EventStatus = 'NOT_STARTED' | 'LIVE' | 'ENDED';

export interface EventConfig {
  event_name: string;
  /** Legacy history only; no countdown or admission limit uses this value. */
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
   * First dispatch timestamp for event history and analytics. It never imposes
   * a deadline; only an explicit supervisor closure ends the event.
   */
  event_started_at: number | null;
  event_ended_at: number | null;
  /** Legacy event-limit history; new operations never set this field. */
  overtime_started_at: number | null;
  closing_warned_at: number | null;
  end_warned_at: number | null;
  next_team_number: number;
  revision: number;
}

/* ------------------------------------------------------------------ round */

/**
 * The one authoritative lifecycle. A round is created when OPERATOR_01 receives
 * the team and terminal only at `CLOSED`, so exactly one of these can be active.
 */
export type FlowStatus =
  | 'WAITING_FLOOR2_CONFIRMATION'
  | 'READY_AT_FLOOR3'
  | 'RUNNING'
  | 'TIME_EXPIRED_PENDING_VALIDATION'
  | 'WAITING_FOR_EXIT'
  | 'EXIT_CONFIRMED'
  | 'CLOSED';

/** Statuses written by earlier releases; readable, never reachable again. */
export type LegacyRoundStatus =
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

export type RoundStatus = FlowStatus | LegacyRoundStatus;

/** Retained vocabulary for historical rows. New rows write `result` only. */
export type Outcome = 'IN_PROGRESS' | 'WON' | 'TIMEOUT' | 'NO_PUZZLE' | 'ABORTED';

/**
 * Gameplay outcome, kept separate from the lifecycle so a phase transition can
 * never lose it: `PENDING_VALIDATION` is provisional, not an irreversible failure.
 */
export type RoundResult = 'IN_PROGRESS' | 'PENDING_VALIDATION' | 'WON' | 'TIME_UP' | 'ABORTED';

export interface Round {
  id: string;
  event_id: string;
  round_number: number;
  team_number: number;
  team_name: string | null;
  status: RoundStatus;
  /** Highest lifecycle stage reached — used for the progress line. */
  stage: number;
  /** OPERATOR_01's reception instant: the team exists in the venue from here. */
  called_at: number;
  received_by_role: Role | null;
  received_by: string | null;
  /** OPERATOR_02's physical arrival confirmation at floor 2. */
  floor2_confirmed_at: number | null;
  floor2_confirmed_by_role: Role | null;
  floor2_confirmed_by: string | null;
  /**
   * A bypass is never a fabricated confirmation: these fields stay distinct from
   * `floor2_confirmed_*` so the audit can tell the two situations apart.
   */
  floor2_bypassed_at: number | null;
  floor2_bypassed_by_role: Role | null;
  floor2_bypassed_by: string | null;
  floor2_bypass_reason: string | null;
  game_started_at: number | null;
  /** NPC1 who pressed START. */
  started_by_role: Role | null;
  started_by: string | null;
  /**
   * The duration this round was actually started with, snapshotted from the
   * configuration at START (V3.1 §7.5). `null` on rows written before the duration
   * became configurable: those rounds keep their own stored `deadline_at`, and the
   * fallback for a round with neither is the current configuration default.
   */
  round_duration_ms: number | null;
  /**
   * The authoritative end of the round's window. It is stored, not recomputed, so a
   * refresh, a sleep or a reconnect can never extend or restart the countdown.
   */
  deadline_at: number | null;
  /** @deprecated flexible-window remnant; new rounds leave these at their start values. */
  game_anchor_ms: number | null;
  /** @deprecated playing time banked before a pause; the countdown no longer pauses. */
  game_elapsed_ms: number;
  game_stopped_at: number | null;
  /** @deprecated how many times the 5-minute window was restarted (history). */
  game_reset_count: number;
  /** @deprecated how many times the 5-minute window was paused (history). */
  game_pause_count: number;
  /**
   * Official score: the validated claim's `claimed_at - game_started_at`. Never the
   * verification instant and never the exit instant.
   */
  official_duration_ms: number | null;
  /** The attempt whose time became official. */
  validated_attempt_id: string | null;
  /** @deprecated legacy single-confirmation stamp; mirrors the validated claim time. */
  puzzle_completed_at: number | null;
  /** NPC1's confirmation that the team physically left floor 3. */
  exit_confirmed_at: number | null;
  exit_by_role: Role | null;
  exit_by: string | null;
  /** Reason recorded for an early or emergency departure. */
  exit_reason: string | null;
  gate_finalized_at: number | null;
  finalized_by_role: Role | null;
  system_ready_at: number | null;
  aborted_at: number | null;
  /**
   * Why the round was cancelled. `misconduct` disqualifies the result and locks the
   * verification path; `technical` / `safety` leave a pending in-time claim still
   * verifiable (V3.1 §4.4). `null` on rounds that were never cancelled, and on
   * history written before the distinction existed.
   */
  abort_kind: AbortKind | null;
  /** Reason recorded for the cancellation, kept apart from the exit reason. */
  abort_reason: string | null;
  result: RoundResult;
  /** @deprecated legacy outcome column; kept for rows written before this release. */
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

/**
 * One completion claim by the players, recorded by NPC2.
 *
 * The claim time and the verification decision are deliberately two separate
 * facts: only the claim time can become the official score.
 */
export type AttemptStatus = 'PENDING' | 'VALID' | 'INVALID' | 'LATE';

export interface CompletionAttempt {
  id: string;
  round_id: string;
  /** 1-based within the round, for “Lần 1 — 03:42.35 — Chờ kiểm tra”. */
  seq: number;
  /** Server instant of the claim. Never trusted from the client. */
  claimed_at: number;
  /** claimed_at - game_started_at, in ms. */
  elapsed_ms: number;
  /** Time left when the claim was recorded; negative once past the deadline. */
  remaining_ms: number;
  /** claimed_at < deadline_at: the only boundary that can produce a win. */
  in_time: boolean;
  status: AttemptStatus;
  claimed_by_role: Role;
  claimed_by: string;
  verified_by_role: Role | null;
  verified_by: string | null;
  verified_at: number | null;
  decision_note: string | null;
  /** Press diagnostics; never scored. */
  claim_press_ms: number | null;
  claim_transport_ms: number | null;
  revision: number;
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
  /* ---------------------------------------------------------------- live flow */
  | 'CALL_TEAM'
  | 'CONFIRM_FLOOR2'
  | 'FLOOR2_BYPASS'
  | 'START_GAME'
  | 'CLAIM_COMPLETE'
  | 'VERIFY_ATTEMPT'
  | 'CONFIRM_EXIT'
  | 'EARLY_EXIT'
  | 'RESET_DONE'
  | 'GATE_FINALIZE'
  | 'SET_LAYOUT'
  | 'SET_TEAM_NAME'
  /* ------------------------------------------------------------- admin & event */
  | 'REOPEN_RESET'
  | 'REVIEW_RESOLVE'
  | 'END_EVENT'
  /* Reopens the operating surface after END_EVENT by pointing sc.state at a fresh
     sc.events row. SUPERVISOR only; history of the closed event is untouched. */
  | 'OPEN_NEW_EVENT'
  | 'ABORT_ROUND'
  | 'CORRECT_ROUND'
  | 'OVERRIDE_ADMIT'
  | 'OVERTIME_STARTED'
  | 'EVENT_CLOSED'
  | 'SESSION_RESTORE'
  /* --------------------------------------------- retired, kept so history parses */
  | 'TEAM_UPSTAIRS'
  | 'GAME_PAUSE'
  | 'GAME_RESUME'
  | 'GAME_RESET'
  | 'HALLWAY_PROGRESS'
  | 'ROOM_REACHED'
  | 'PUZZLE_COMPLETE'
  | 'RETURN_START'
  | 'GAME_STOP'
  | 'START_EVENT';

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

/**
 * The single derived phase every screen reads. `WAITING_FOR_TEAM` and `ENDED` are
 * event-level positions (no round in play); everything else is a `FlowStatus`.
 * The retired 'PREPARING' | 'RUNNING' | 'EXITED' | 'RESETTING' | 'GAME_OVERTIME'
 * values are gone: one phase means one screen state, everywhere.
 */
export type SystemPhase = 'PRE_EVENT' | 'WAITING_FOR_TEAM' | 'ENDED' | FlowStatus;

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
  /** Every completion claim of this event, grouped by round in the UI. */
  attempts: CompletionAttempt[];
  operators: OperatorState[];
  log: LogEntry[];
  /**
   * True when this snapshot was produced for an OBSERVER: operational detail is
   * redacted and no action can be taken with it.
   */
  redacted?: boolean;
}

/* ------------------------------------------------------------- station board */

/** Public occupancy for one role; no operator identity is disclosed. */
export interface StationSlot {
  role: Role;
  /** All slots for this role are full. */
  occupied: boolean;
  /** Server-declared limit; Home refuses incomplete legacy board payloads. */
  capacity?: number;
  /** Devices currently holding this seat (0, 1 or 2). */
  devices?: number;
}

/**
 * Public seat board. It carries station roles and counters only — never an
 * operator name or device id, so an unbound phone may read it at the root URL.
 *
 * Operator seats and observer seats are counted separately: filling the ten
 * viewing seats must never turn away an operator, and vice versa.
 */
export interface StationBoard {
  /** Board contract version; 2 adds the observer counters. */
  board_version?: number;
  capacity: number;
  occupied: number;
  /** All operator device slots are full. */
  locked: boolean;
  /** Total operator device slots across the seats (6 since 0008). */
  device_capacity?: number;
  /** Operator devices currently bound (up to device_capacity). */
  devices?: number;
  /** Concurrency limit for read-only observers. */
  observer_capacity?: number;
  /** Observer seats currently held. */
  observer_devices?: number;
  /** No seat has room left: every new phone will be turned away. */
  full?: boolean;
  /**
   * A team is still inside the round's window (from NPC1's BẮT ĐẦU until the team is
   * confirmed out). The board release is an access action and must never run over a
   * live floor, so the picker disables it while this is true. Undefined means an
   * older board that cannot say — treated as not allowed.
   */
  game_running?: boolean;
  /**
   * Whether the board release may run right now, and the single authoritative reason
   * it may not. Both the button state and `reset_all_stations` read this same
   * predicate, so the UI can never offer what the RPC is going to refuse (V3.1 §6.2).
   */
  reset_allowed?: boolean;
  reset_block_reason?: ResetBlockReason | null;
  stations: StationSlot[];
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
  code:
    | 'OK'
    | 'STALE_REVISION'
    | 'PERMISSION_DENIED'
    | 'INVALID_STATE'
    | 'BLOCKED'
    | 'UNKNOWN_ACTION'
    /** A viewer has no operational authority at all. */
    | 'READ_ONLY';
  message: string;
  revision: number;
  snapshot?: Snapshot;
  requires_override?: boolean;
  server_now_ms: number;
}
