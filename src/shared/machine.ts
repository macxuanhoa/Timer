import type {
  ActionType,
  CompletionAttempt,
  EventSession,
  FlowStatus,
  LegacyRoundStatus,
  LogEntry,
  OperatorState,
  ResetTask,
  Round,
  RoundResult,
  RoundStatus,
  Snapshot,
  SystemPhase,
} from './types.ts';
import { DEFAULT_ROUND_DURATION_MS } from './constants.ts';

/**
 * Server-enforced permission table. The authoritative layer rejects any command
 * whose actor role is not listed here; the UI only mirrors it for ergonomics.
 *
 * This is the V3 role matrix (§15), one row per action:
 *
 *   LOBBY = OPERATOR_01 · CORRIDOR = OPERATOR_02 · GATE = NPC1 · ROOM305 = NPC2
 *   SUPERVISOR keeps only exceptional admin rights, and OBSERVER has none at all.
 */
export const ROLE_ACTIONS: Record<ActionType, string[]> = {
  CONFIGURE: ['SUPERVISOR'],
  // Only OPERATOR_01 receives a team; nobody else can put a team into play.
  CALL_TEAM: ['LOBBY'],
  // Only OPERATOR_02 confirms physical arrival at floor 2.
  CONFIRM_FLOOR2: ['CORRIDOR'],
  // Only NPC1 may bypass floor 2, and only with a reason that stays in the audit.
  FLOOR2_BYPASS: ['GATE'],
  // Only NPC1 starts the countdown.
  START_GAME: ['GATE'],
  // Only NPC2 records claims and verifies the arrangement.
  CLAIM_COMPLETE: ['ROOM305'],
  VERIFY_ATTEMPT: ['ROOM305'],
  // Only NPC1 confirms the physical exit and the guarded early departure.
  CONFIRM_EXIT: ['GATE'],
  EARLY_EXIT: ['GATE'],
  // The three physical checks belong to the floor-3 staff who actually move props.
  RESET_DONE: ['GATE', 'ROOM305'],
  GATE_FINALIZE: ['GATE'],
  SET_LAYOUT: ['GATE', 'ROOM305', 'SUPERVISOR'],
  // The team label belongs to the position that receives the team; the supervisor
  // may correct it, always with an audit entry.
  SET_TEAM_NAME: ['LOBBY', 'SUPERVISOR'],
  REOPEN_RESET: ['SUPERVISOR'],
  REVIEW_RESOLVE: ['SUPERVISOR'],
  END_EVENT: ['SUPERVISOR'],
  // The counterweight to END_EVENT: only the retained admin may hand the room to a
  // new night, and only after the current event is closed and every round is CLOSED.
  OPEN_NEW_EVENT: ['SUPERVISOR'],
  ABORT_ROUND: ['SUPERVISOR'],
  CORRECT_ROUND: ['SUPERVISOR'],
  /* ----------------------------------------------------------------- retired */
  // Duplicated Corridor/Gate/Room305 controls, the flexible-window buttons and the
  // four actions that existed only for the retired 90-minute session clock are all
  // outside the permission surface now: no role may execute them any more, while
  // historical log rows keep the names so the audit stays readable (V3.1 §7.1).
  TEAM_UPSTAIRS: [],
  GAME_PAUSE: [],
  GAME_RESUME: [],
  GAME_RESET: [],
  HALLWAY_PROGRESS: [],
  ROOM_REACHED: [],
  PUZZLE_COMPLETE: [],
  RETURN_START: [],
  GAME_STOP: [],
  START_EVENT: [],
  OVERTIME_STARTED: [],
  OVERRIDE_ADMIT: [],
  EVENT_CLOSED: [],
  SESSION_RESTORE: [],
};

export const STAGE_OF_STATUS: Record<RoundStatus, number> = {
  // legacy (history only)
  LOBBY_CALL: 1,
  TEAM_PREPARING: 1,
  GAME_STARTED: 3,
  CORRIDOR_ACTIVE: 3,
  ROOM_REACHED: 3,
  PUZZLE_COMPLETED: 3,
  RETURNING: 3,
  GAME_EXITED: 5,
  RESETTING: 5,
  RESET_CONFIRMED: 5,
  GATE_CLEARED: 6,
  ABORTED: 5,
  // authoritative flow
  WAITING_FLOOR2_CONFIRMATION: 1,
  READY_AT_FLOOR3: 2,
  RUNNING: 3,
  TIME_EXPIRED_PENDING_VALIDATION: 3,
  WAITING_FOR_EXIT: 4,
  EXIT_CONFIRMED: 5,
  CLOSED: 6,
};

export function isAllowed(actorRole: string, action: ActionType): boolean {
  return ROLE_ACTIONS[action]?.includes(actorRole) ?? false;
}

/**
 * The stored status of a round mapped onto the single authoritative vocabulary.
 *
 * Legacy rows keep their original text in the database; every consumer reads
 * through this function instead of branching on two names for one logical state.
 */
export function flowStatus(r: Round | null): FlowStatus | null {
  if (!r) return null;
  const s = r.status as LegacyRoundStatus;
  switch (s) {
    case 'LOBBY_CALL':
    case 'TEAM_PREPARING':
      return 'WAITING_FLOOR2_CONFIRMATION';
    case 'GAME_STARTED':
    case 'CORRIDOR_ACTIVE':
    case 'ROOM_REACHED':
    case 'PUZZLE_COMPLETED':
    case 'RETURNING':
      return 'RUNNING';
    case 'GAME_EXITED':
    case 'RESETTING':
    case 'RESET_CONFIRMED':
    case 'ABORTED':
      return r.system_ready_at !== null ? 'CLOSED' : 'EXIT_CONFIRMED';
    case 'GATE_CLEARED':
      return 'CLOSED';
    default:
      return r.status as FlowStatus;
  }
}

/** A round that can never be acted on again: the next team may be received. */
export function isTerminalRound(r: Round | null): boolean {
  return !r || flowStatus(r) === 'CLOSED';
}

/* ------------------------------------------------------------------ clock */

/**
 * The duration this round actually runs on.
 *
 * V3.1 makes the countdown configurable, so the number that matters is the one the
 * round was started with — never the configuration as it happens to read right now.
 * Precedence: the snapshot taken at START, then the round's own stored window, then
 * the current configuration default for rows that carry neither.
 */
export function roundLimitMs(r: Round | null, fallbackMs: number): number {
  if (!r) return fallbackMs;
  if (r.round_duration_ms !== null && r.round_duration_ms > 0) return r.round_duration_ms;
  if (r.deadline_at !== null && r.game_started_at !== null && r.deadline_at > r.game_started_at) {
    return r.deadline_at - r.game_started_at;
  }
  return fallbackMs;
}

/**
 * The authoritative end of the round's window.
 *
 * Rows written before this release have no stored deadline, so it is reconstructed
 * from the banked flexible-window fields without handing the team extra time: the
 * remaining playing time at "now" is measured exactly as the old clock measured it.
 */
export function roundDeadlineMs(r: Round, limitMs: number, nowMs: number): number | null {
  if (r.deadline_at !== null) return r.deadline_at;
  if (r.game_started_at === null) return null;
  const own = roundLimitMs(r, limitMs);
  if (r.game_stopped_at !== null) return r.game_started_at + own;
  const banked = r.game_elapsed_ms + (r.game_anchor_ms === null ? 0 : Math.max(0, nowMs - r.game_anchor_ms));
  return nowMs + Math.max(0, own - banked);
}

/** Milliseconds left on the authoritative countdown; negative once expired. */
export function gameRemainingMs(r: Round, limitMs: number, nowMs: number): number {
  const deadline = roundDeadlineMs(r, limitMs, nowMs);
  if (deadline === null) return limitMs;
  return deadline - nowMs;
}

/**
 * Playing time measured from START. Official scores never come from here: they come
 * from the validated claim (`claimed_at - game_started_at`), persisted once.
 */
export function gameElapsedMs(r: Round, nowMs: number): number {
  if (r.game_started_at === null) return 0;
  if (r.deadline_at !== null) return Math.max(0, nowMs - r.game_started_at);
  // Legacy rows: honour the banked time of the flexible window they were scored on.
  const segment = r.game_anchor_ms === null ? 0 : Math.max(0, nowMs - r.game_anchor_ms);
  return r.game_elapsed_ms + segment;
}

/** A round whose result has been decided — success is immutable from here. */
export function hasValidatedAttempt(r: Round): boolean {
  return r.validated_attempt_id !== null || r.result === 'WON' || r.outcome === 'WON';
}

/** True while the area is being put back ready for the next team. */
export function isResetWindow(r: Round | null): boolean {
  return flowStatus(r) === 'EXIT_CONFIRMED';
}

/* ------------------------------------------------------------------ claims */

/** Claims of one round in recording order. */
export function attemptsOf(attempts: CompletionAttempt[], roundId: string | null): CompletionAttempt[] {
  if (!roundId) return [];
  return attempts.filter((a) => a.round_id === roundId).sort((a, b) => a.claimed_at - b.claimed_at || a.seq - b.seq);
}

/**
 * The eligibility boundary, stated once and used by every layer:
 * a claim first recorded at or after the deadline is not an in-time completion.
 */
export function isEligibleClaim(a: CompletionAttempt, deadlineMs: number): boolean {
  return a.claimed_at < deadlineMs;
}

/** An in-time claim that NPC2 has not decided yet. */
export function pendingEligibleClaims(r: Round, attempts: CompletionAttempt[], limitMs: number, nowMs: number) {
  const deadline = roundDeadlineMs(r, limitMs, nowMs);
  if (deadline === null) return [];
  return attemptsOf(attempts, r.id).filter((a) => a.status === 'PENDING' && isEligibleClaim(a, deadline));
}

/* ------------------------------------------------------------------ result */

/**
 * The gameplay result, derived from immutable facts rather than from a task that
 * has to win a race with the verification press:
 *
 *   ABORTED  — the round was cancelled (and not rescued by a validated in-time claim)
 *   WON      — an in-time claim was verified as correct (official time = claim time)
 *   PENDING_VALIDATION — the deadline passed while an eligible claim awaits NPC2
 *   TIME_UP  — the deadline passed and no eligible claim is left open
 *
 * Because it is derived, a device that reconnects after the deadline, a phone with
 * no stream, and the server agree on the outcome with no expiry timer at all.
 *
 * A cancellation is not automatically a verdict on the players' arrangement: a
 * `technical` or `safety` abort still lets a claim that was recorded before the
 * deadline be verified and win on its own instant, while a `misconduct` abort
 * disqualifies and can only be reopened by a supervisor's REVIEW_RESOLVE (§4.4).
 */
export function resultOf(r: Round, attempts: CompletionAttempt[], limitMs: number, nowMs: number): RoundResult {
  const validated = attemptsOf(attempts, r.id).some((a) => a.status === 'VALID') || hasValidatedAttempt(r);
  if (r.aborted_at !== null) {
    if (r.abort_kind === 'misconduct') {
      // A disqualification stands until a supervisor resolves the review by name:
      // an early claim alone never converts a penalised round into a win (§4.4).
      return validated && r.review_resolved_at !== null && !r.decertified ? 'WON' : 'ABORTED';
    }
    return validated ? 'WON' : 'ABORTED';
  }
  if (validated) return 'WON';
  if (r.result === 'WON' || r.result === 'ABORTED') return r.result;
  if (r.game_started_at === null) return 'IN_PROGRESS';
  // A round that was already closed keeps whatever was finalised on it.
  if (flowStatus(r) === 'CLOSED') return r.result === 'IN_PROGRESS' ? 'TIME_UP' : r.result;
  const deadline = roundDeadlineMs(r, limitMs, nowMs);
  if (deadline === null || nowMs < deadline) return r.result === 'IN_PROGRESS' ? 'IN_PROGRESS' : r.result;
  if (pendingEligibleClaims(r, attempts, limitMs, nowMs).length > 0) return 'PENDING_VALIDATION';
  return 'TIME_UP';
}

/**
 * The lifecycle position a round is *displayed* in. Only RUNNING depends on the
 * clock: past the deadline it becomes the pending-validation state when an eligible
 * claim is still open, and the exit-waiting state otherwise.
 */
export function liveStatus(r: Round, attempts: CompletionAttempt[], limitMs: number, nowMs: number): FlowStatus {
  const flow = flowStatus(r);
  if (flow !== 'RUNNING') return flow ?? 'WAITING_FLOOR2_CONFIRMATION';
  const deadline = roundDeadlineMs(r, limitMs, nowMs);
  if (deadline === null || nowMs < deadline) return 'RUNNING';
  // The only two ways out of a running clock with nobody having pressed anything:
  // an eligible claim still open, or the time simply being up.
  return pendingEligibleClaims(r, attempts, limitMs, nowMs).length > 0 ? 'TIME_EXPIRED_PENDING_VALIDATION' : 'WAITING_FOR_EXIT';
}

/**
 * How long the team has been inside after gameplay ended — the countdown expiring or
 * a claim being validated. Warning only: the system never decides an exit by itself,
 * because only NPC1 can see the last player go through the door.
 */
export function stallSince(r: Round | null, nowMs: number, limitMs?: number): number | null {
  if (!r) return null;
  if (r.exit_confirmed_at !== null || r.aborted_at !== null) return null;
  const flow = flowStatus(r);
  if (flow !== 'RUNNING' && flow !== 'WAITING_FOR_EXIT' && flow !== 'TIME_EXPIRED_PENDING_VALIDATION') return null;
  const gameplayEnded =
    r.validated_attempt_id !== null && r.puzzle_completed_at !== null
      ? r.puzzle_completed_at
      : roundDeadlineMs(r, roundLimitMs(r, limitMs ?? DEFAULT_ROUND_DURATION_MS), nowMs) ?? r.game_stopped_at;
  if (gameplayEnded === null || nowMs < gameplayEnded) return null;
  return Math.max(0, nowMs - gameplayEnded);
}

/* ---------------------------------------------------- phase-specific rights */

/**
 * Where each action may legitimately happen. A permission in `ROLE_ACTIONS` says
 * *who*; this says *when*. The engine checks both, so no role can force an illegal
 * transition by calling the API directly, and the UI mirrors exactly the same table.
 */
const ACTION_PHASES: Partial<Record<ActionType, (FlowStatus | 'NO_ROUND')[]>> = {
  CALL_TEAM: ['NO_ROUND'],
  CONFIRM_FLOOR2: ['WAITING_FLOOR2_CONFIRMATION'],
  FLOOR2_BYPASS: ['WAITING_FLOOR2_CONFIRMATION'],
  START_GAME: ['READY_AT_FLOOR3'],
  // A claim recorded after the deadline is still worth keeping as an informational
  // fact (§11 scenario C) — it simply can never become a winning result.
  CLAIM_COMPLETE: ['RUNNING', 'TIME_EXPIRED_PENDING_VALIDATION', 'WAITING_FOR_EXIT'],
  // A decision may still land after the clock, after the team has left, and after a
  // non-disqualifying cancellation — but never as a new claim (§4.4).
  VERIFY_ATTEMPT: ['RUNNING', 'TIME_EXPIRED_PENDING_VALIDATION', 'WAITING_FOR_EXIT', 'EXIT_CONFIRMED'],
  CONFIRM_EXIT: ['WAITING_FOR_EXIT', 'TIME_EXPIRED_PENDING_VALIDATION'],
  EARLY_EXIT: ['RUNNING', 'TIME_EXPIRED_PENDING_VALIDATION', 'WAITING_FOR_EXIT'],
  RESET_DONE: ['EXIT_CONFIRMED'],
  GATE_FINALIZE: ['EXIT_CONFIRMED'],
  // Props are prepared between teams or while the area is being reset, never while
  // a team is on the clock.
  SET_LAYOUT: ['NO_ROUND', 'WAITING_FLOOR2_CONFIRMATION', 'READY_AT_FLOOR3', 'EXIT_CONFIRMED'],
  SET_TEAM_NAME: ['WAITING_FLOOR2_CONFIRMATION', 'READY_AT_FLOOR3'],
  ABORT_ROUND: ['WAITING_FLOOR2_CONFIRMATION', 'READY_AT_FLOOR3', 'RUNNING', 'TIME_EXPIRED_PENDING_VALIDATION'],
};

/** Admin actions that act on any round, including closed ones, always with a reason. */
const PHASE_FREE: ActionType[] = [
  'CONFIGURE',
  'REOPEN_RESET',
  'REVIEW_RESOLVE',
  'END_EVENT',
  // OPEN_NEW_EVENT has no round to be gated on — its precondition is entirely on
  // event_ended_at and on every prior round being CLOSED, both enforced inside the
  // handle_command wrapper (and mirrored in engine.onOpenNewEvent).
  'OPEN_NEW_EVENT',
  'CORRECT_ROUND',
];

export function phaseAllows(action: ActionType, live: FlowStatus | null): boolean {
  if (PHASE_FREE.includes(action)) return true;
  const allowed = ACTION_PHASES[action];
  if (!allowed) return false;
  return allowed.some((s) => (s === 'NO_ROUND' ? live === null : s === live));
}

/** The complete server-side authorization answer for one press. */
export function authorize(
  actorRole: string,
  action: ActionType,
  live: FlowStatus | null,
  result: RoundResult | null,
  round?: Round | null,
): { allowed: boolean; reason: 'PERMISSION_DENIED' | 'INVALID_STATE' | 'READ_ONLY' | null; message?: string } {
  const role = authorizeRole(actorRole, action);
  if (!role.allowed) return role;
  return authorizePhase(action, live, result, round);
}

/**
 * Who may press at all. Checked first and cheapest, and it never reveals anything
 * about the current state to a device that has no right to ask.
 */
export function authorizeRole(actorRole: string, action: ActionType): { allowed: boolean; reason: 'PERMISSION_DENIED' | 'READ_ONLY' | null } {
  // A viewer is never an operator, whatever the client claims.
  if (actorRole === 'OBSERVER') return { allowed: false, reason: 'READ_ONLY' };
  if (!isAllowed(actorRole, action)) return { allowed: false, reason: 'PERMISSION_DENIED' };
  return { allowed: true, reason: null };
}

/**
 * When a permitted action is legal. Answered after the revision check, so a device
 * that is merely behind gets the resynchronising `STALE_REVISION` answer rather
 * than a confusing “invalid state” for a press that was fine when it made it.
 *
 * The refusal also says *why* in the operator's own words: a round whose result is
 * already settled is not the same problem as a press in the wrong phase (§10.2).
 */
export function authorizePhase(
  action: ActionType,
  live: FlowStatus | null,
  result: RoundResult | null,
  round?: Round | null,
): { allowed: boolean; reason: 'INVALID_STATE' | null; message?: string } {
  if (!phaseAllows(action, live)) return { allowed: false, reason: 'INVALID_STATE' };
  // No new claim may be recorded once the round has been cancelled or settled.
  if (action === 'CLAIM_COMPLETE') {
    if (round && round.aborted_at !== null) {
      return { allowed: false, reason: 'INVALID_STATE', message: 'Lượt chơi đã bị hủy — không ghi nhận thêm lần báo hoàn thành' };
    }
    if (result === 'WON') {
      return { allowed: false, reason: 'INVALID_STATE', message: 'Lượt chơi đã chốt kết quả' };
    }
  }
  if (action === 'VERIFY_ATTEMPT') {
    if (result === 'WON') {
      return { allowed: false, reason: 'INVALID_STATE', message: 'Lượt chơi đã chốt kết quả' };
    }
    // A disqualified round is a supervisor decision, not an NPC2 verification. Only
    // after REVIEW_RESOLVE has accepted the result by name may the claim be judged.
    if (round && round.aborted_at !== null && round.abort_kind === 'misconduct'
      && !(round.review_resolved_at !== null && !round.decertified)) {
      return {
        allowed: false,
        reason: 'INVALID_STATE',
        message: 'Lượt chơi đã bị hủy vì kỷ luật — Quản trị viên phải xét lại kết quả',
      };
    }
  }
  return { allowed: true, reason: null };
}

/* ------------------------------------------------------------ admission control */

type AdmissionCode =
  | 'ALLOWED'
  | 'OVERRIDE_ALLOWED'
  | 'EVENT_NOT_STARTED'
  | 'EVENT_ENDED'
  | 'TIME_EXHAUSTED'
  | 'ROUND_ACTIVE'
  | 'NOT_READY';

interface AdmissionDecision {
  allowed: boolean;
  /** A supervisor may force the action with an explicit reason + audit entry. */
  overridePossible: boolean;
  code: AdmissionCode;
  remaining_ms: number | null;
  required_ms: number | null;
  message: string;
}

/**
 * A team may be received whenever the area is clear; there is no event deadline
 * any more, so the only real gate is "one game at a time" plus the reset readiness.
 */
export function evaluateDispatch(event: EventSession, _nowMs: number): AdmissionDecision {
  if (event.event_ended_at !== null) {
    return base('EVENT_ENDED', null, null, 'SỰ KIỆN ĐÃ KẾT THÚC');
  }
  return base('ALLOWED', null, null, 'Sẵn sàng nhận đội mới');
}

/**
 * START is not gated by any event clock: the 300 s window belongs to the round.
 */
export function evaluateGameStart(event: EventSession, _nowMs: number): AdmissionDecision {
  if (event.event_ended_at !== null) {
    return base('EVENT_ENDED', null, null, 'SỰ KIỆN ĐÃ KẾT THÚC');
  }
  return base('ALLOWED', null, null, 'Sẵn sàng bắt đầu');
}

function base(
  code: AdmissionCode,
  remaining_ms: number | null,
  required_ms: number | null,
  message: string,
): AdmissionDecision {
  return {
    allowed: code === 'ALLOWED',
    overridePossible: false,
    code,
    remaining_ms,
    required_ms,
    message,
  };
}

/* ------------------------------------------------------------ display state */

export function deriveEventStatus(ev: EventSession, _nowMs: number): Snapshot['event_status'] {
  if (ev.event_ended_at !== null) return 'ENDED';
  if (ev.event_started_at === null) return 'NOT_STARTED';
  return 'LIVE';
}

export function derivePhase(
  ev: EventSession,
  active: Round | null,
  nowMs: number,
  attempts: CompletionAttempt[] = [],
): SystemPhase {
  if (ev.event_ended_at !== null) return 'ENDED';
  if (ev.event_started_at === null && !active) return 'PRE_EVENT';
  if (active) return liveStatus(active, attempts, ev.config.game_limit_ms, nowMs);
  return 'WAITING_FOR_TEAM';
}

/**
 * Turns stored rows into the renderable snapshot. Shared by the local engine and
 * the Supabase gateway so neither can invent its own phase logic.
 */
export function finalizeSnapshot(input: {
  revision: number;
  server_now_ms: number;
  event: EventSession;
  rounds: Round[];
  reset_tasks: ResetTask[];
  attempts?: CompletionAttempt[];
  operators: OperatorState[];
  log: LogEntry[];
}): Snapshot {
  const attempts = input.attempts ?? [];
  const active = input.rounds.find((r) => !isTerminalRound(r)) ?? null;
  const { attempts: _attempts, ...rest } = input;
  return {
    ...rest,
    attempts,
    event_status: deriveEventStatus(input.event, input.server_now_ms),
    phase: derivePhase(input.event, active, input.server_now_ms, attempts),
    active_round: active,
  };
}
