import type {
  ActionType,
  EventSession,
  LogEntry,
  OperatorState,
  ResetTask,
  Round,
  RoundStatus,
  Snapshot,
  SystemPhase,
} from './types.ts';

/**
 * Server-enforced permission table. The authoritative layer rejects any command
 * whose actor role is not listed here; the UI only mirrors it for ergonomics.
 */
export const ROLE_ACTIONS: Record<ActionType, string[]> = {
  CONFIGURE: ['SUPERVISOR'],
  CALL_TEAM: ['LOBBY', 'SUPERVISOR'],
  TEAM_UPSTAIRS: ['LOBBY', 'GATE', 'SUPERVISOR'],
  START_GAME: ['GATE', 'SUPERVISOR'],
  // The 5-minute window is the only flexible clock, and GATE owns it. Every press
  // is authoritative and audited, so all five stations read the same state.
  GAME_PAUSE: ['GATE', 'SUPERVISOR'],
  GAME_RESUME: ['GATE', 'SUPERVISOR'],
  GAME_RESET: ['GATE', 'SUPERVISOR'],
  HALLWAY_PROGRESS: ['CORRIDOR', 'SUPERVISOR'],
  ROOM_REACHED: ['ROOM305', 'SUPERVISOR'],
  PUZZLE_COMPLETE: ['ROOM305', 'SUPERVISOR'],
  RETURN_START: ['ROOM305', 'CORRIDOR', 'GATE', 'SUPERVISOR'],
  GAME_STOP: ['GATE', 'SUPERVISOR'],
  RESET_DONE: ['CORRIDOR', 'ROOM305', 'GATE', 'SUPERVISOR'],
  GATE_FINALIZE: ['GATE', 'SUPERVISOR'],
  // Only the operator responsible for object placement prepares a layout; the
  // supervisor may correct it, always with an audit entry.
  SET_LAYOUT: ['CORRIDOR', 'GATE', 'SUPERVISOR'],
  // The optional team label belongs to the same two stations that can dispatch
  // a team: LOBBY names it while calling, SUPERVISOR may correct it later.
  SET_TEAM_NAME: ['LOBBY', 'SUPERVISOR'],
  REOPEN_RESET: ['SUPERVISOR'],
  REVIEW_RESOLVE: ['SUPERVISOR'],
  END_EVENT: ['SUPERVISOR'],
  ABORT_ROUND: ['SUPERVISOR'],
  CORRECT_ROUND: ['SUPERVISOR'],
  OVERRIDE_ADMIT: ['SUPERVISOR'],
  OVERTIME_STARTED: ['SUPERVISOR'],
  EVENT_CLOSED: ['SUPERVISOR'],
  SESSION_RESTORE: ['SUPERVISOR'],
};

export const STAGE_OF_STATUS: Record<RoundStatus, number> = {
  LOBBY_CALL: 1,
  TEAM_PREPARING: 1,
  GAME_STARTED: 2,
  CORRIDOR_ACTIVE: 3,
  ROOM_REACHED: 4,
  PUZZLE_COMPLETED: 5,
  RETURNING: 6,
  GAME_EXITED: 7,
  RESETTING: 7,
  RESET_CONFIRMED: 8,
  GATE_CLEARED: 9,
  ABORTED: 9,
};

export function isAllowed(actorRole: string, action: ActionType): boolean {
  return ROLE_ACTIONS[action]?.includes(actorRole) ?? false;
}

export function isTerminalRound(r: Round | null): boolean {
  return !r || r.status === 'GATE_CLEARED' || r.status === 'ABORTED';
}

/** A round whose game clock is currently running (may be past its deadline). */
export function isGameRunning(r: Round | null): boolean {
  if (!r) return false;
  switch (r.status) {
    case 'GAME_STARTED':
    case 'CORRIDOR_ACTIVE':
    case 'ROOM_REACHED':
    case 'PUZZLE_COMPLETED':
    case 'RETURNING':
      return r.game_stopped_at === null;
    default:
      return false;
  }
}

/** True while GATE has frozen the 5-minute window. */
export function isGamePaused(r: Round | null): boolean {
  return !!r && r.game_started_at !== null && r.game_stopped_at === null && r.game_anchor_ms === null;
}

/**
 * Playing time banked on the 5-minute clock, excluding every paused gap. A reset
 * zeroes it, so the official score always measures what the team actually played.
 */
export function gameElapsedMs(r: Round, nowMs: number): number {
  if (r.game_started_at === null) return 0;
  const segment = r.game_anchor_ms === null ? 0 : Math.max(0, nowMs - r.game_anchor_ms);
  return r.game_elapsed_ms + segment;
}

/** Signed ms left on the 5-minute clock; negative once the team is over time. */
export function gameRemainingMs(r: Round, limitMs: number, nowMs: number): number {
  return limitMs - gameElapsedMs(r, nowMs);
}

/** True from GATE STOP until the area is cleared — controlled exit / reset window. */
export function isResetWindow(r: Round | null): boolean {
  if (!r) return false;
  return (
    r.status === 'GAME_EXITED' ||
    r.status === 'RESETTING' ||
    r.status === 'RESET_CONFIRMED' ||
    (r.status === 'ABORTED' && r.system_ready_at === null)
  );
}

/**
 * Scenario B: a team that left the room (or is in the exit window) without GATE
 * stopping the clock. Warning only — the system never stops an official clock by
 * itself, because only GATE knows the last player is out.
 */
export function stallSince(r: Round | null, nowMs: number): number | null {
  if (!r || r.game_stopped_at !== null) return null;
  if (r.status !== 'RETURNING' && r.status !== 'PUZZLE_COMPLETED') return null;
  const since = r.status === 'RETURNING' ? r.game_started_at : r.puzzle_completed_at;
  if (since === null) return null;
  return Math.max(0, nowMs - since);
}

/* ------------------------------------------------------------ admission control */

export type AdmissionCode =
  | 'ALLOWED'
  | 'OVERRIDE_ALLOWED'
  | 'EVENT_NOT_STARTED'
  | 'EVENT_ENDED'
  | 'TIME_EXHAUSTED'
  | 'ROUND_ACTIVE'
  | 'NOT_READY';

export interface AdmissionDecision {
  allowed: boolean;
  /** A supervisor may force the action with an explicit reason + audit entry. */
  overridePossible: boolean;
  code: AdmissionCode;
  remaining_ms: number | null;
  required_ms: number | null;
  message: string;
}

/**
 * Event-level admission only checks explicit closure. The command handler also
 * checks active rounds and reset readiness before dispatching the next team.
 */
export function evaluateDispatch(event: EventSession, _nowMs: number): AdmissionDecision {
  if (event.event_ended_at !== null) {
    return base('EVENT_ENDED', null, null, 'SỰ KIỆN ĐÃ KẾT THÚC');
  }
  return base('ALLOWED', null, null, 'Sẵn sàng nhận đội mới');
}

/**
 * A new game keeps its full round limit regardless of event elapsed time.
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

export function derivePhase(ev: EventSession, active: Round | null, nowMs: number): SystemPhase {
  if (ev.event_ended_at !== null) return 'ENDED';
  if (ev.event_started_at === null) return 'PRE_EVENT';
  if (active) {
    // A game that exceeded its 5-minute limit is in overtime; the team still
    // follows the same controlled exit workflow.
    const gameOvertime =
      active.game_started_at !== null && active.game_stopped_at === null
        ? gameRemainingMs(active, ev.config.game_limit_ms, nowMs) <= 0
        : false;
    if (isGameRunning(active)) return gameOvertime ? 'GAME_OVERTIME' : 'RUNNING';
    if (isResetWindow(active)) return 'RESETTING';
    if (active.status === 'LOBBY_CALL' || active.status === 'TEAM_PREPARING') return 'PREPARING';
  }
  return 'READY';
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
  operators: OperatorState[];
  log: LogEntry[];
}): Snapshot {
  const active = input.rounds.find((r) => !isTerminalRound(r)) ?? null;
  return {
    ...input,
    event_status: deriveEventStatus(input.event, input.server_now_ms),
    phase: derivePhase(input.event, active, input.server_now_ms),
    active_round: active,
  };
}
