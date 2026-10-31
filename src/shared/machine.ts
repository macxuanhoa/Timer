import { EVENT_WARN_CLOSE_MS, GAME_LIMIT_MS } from './constants.ts' ;
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
} from './types.ts' ;

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

/** True while GATE has frozen the 5-minute window; the 90-minute clock keeps running. */
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

export function eventDeadline(event: EventSession): number | null {
  if (event.event_started_at === null) return null;
  return event.event_started_at + event.config.event_duration_ms;
}

export function eventRemainingMs(event: EventSession, nowMs: number): number | null {
  const deadline = eventDeadline(event);
  if (deadline === null) return null;
  return deadline - nowMs;
}

/**
 * Lobby dispatch gate. Rule: an incoming team needs the full 5-minute game limit
 * plus the configurable upstairs preparation allowance to still be admissible.
 * The very first dispatch is what anchors the 90-minute timeline, so it is always
 * allowed — there is no separate "start event" step to wait for.
 */
export function evaluateDispatch(event: EventSession, nowMs: number): AdmissionDecision {
  const remaining = eventRemainingMs(event, nowMs);
  if (event.event_started_at === null) {
    return base('ALLOWED', event.config.event_duration_ms, null, 'Đội đầu tiên — đồng hồ 90:00 chạy từ lúc này');
  }
  if (event.event_ended_at !== null) {
    return base('EVENT_ENDED', remaining, null, 'SỰ KIỆN ĐÃ KẾT THÚC');
  }
  if (remaining !== null && remaining <= 0) {
    return base('TIME_EXHAUSTED', remaining, null, 'SẮP KẾT THÚC — KHÔNG NHẬN ĐỘI MỚI');
  }
  const required = event.config.game_limit_ms + event.config.prep_allowance_ms;
  if (remaining !== null && remaining < required) {
    return {
      ...base('OVERRIDE_ALLOWED', remaining, required, 'SẮP KẾT THÚC — KHÔNG NHẬN ĐỘI MỚI'),
      allowed: false,
      overridePossible: true,
    };
  }
  return base('ALLOWED', remaining, required, 'Đủ thời gian nhận đội mới');
}

/**
 * Game start gate. Rule: never start the official 5-minute clock with less than
 * 5 minutes left in the 90-minute event.
 */
export function evaluateGameStart(event: EventSession, nowMs: number): AdmissionDecision {
  const remaining = eventRemainingMs(event, nowMs);
  if (event.event_ended_at !== null) {
    return base('EVENT_ENDED', remaining, GAME_LIMIT_MS, 'SỰ KIỆN ĐÃ KẾT THÚC');
  }
  if (remaining !== null && remaining <= 0) {
    return base('TIME_EXHAUSTED', remaining, GAME_LIMIT_MS, 'HẾT GIỜ SỰ KIỆN — KHÔNG BẮT ĐẦU TRẬN MỚI');
  }
  if (remaining !== null && remaining < event.config.game_limit_ms) {
    return {
      ...base('OVERRIDE_ALLOWED', remaining, event.config.game_limit_ms, 'CÒN DƯỚI 5 PHÚT'),
      allowed: false,
      overridePossible: true,
    };
  }
  return base('ALLOWED', remaining, event.config.game_limit_ms, 'Đủ thời gian bắt đầu');
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

export function deriveEventStatus(ev: EventSession, nowMs: number): Snapshot['event_status'] {
  if (ev.event_ended_at !== null) return 'ENDED';
  if (ev.event_started_at === null) return 'NOT_STARTED';
  const remaining = eventRemainingMs(ev, nowMs);
  if (remaining !== null && remaining <= EVENT_WARN_CLOSE_MS) return 'CLOSING';
  return 'LIVE';
}

export function derivePhase(ev: EventSession, active: Round | null, nowMs: number): SystemPhase {
  if (ev.event_started_at === null) return 'PRE_EVENT';
  const remaining = eventRemainingMs(ev, nowMs);
  const eventOvertime = remaining !== null && remaining <= 0;
  if (active) {
    // A game that blew its own 5-minute limit is in overtime even if the event
    // clock still has an hour to run; alerts and controlled exit follow this.
    const gameOvertime =
      active.game_started_at !== null && active.game_stopped_at === null
        ? gameRemainingMs(active, ev.config.game_limit_ms, nowMs) <= 0
        : false;
    if (isGameRunning(active)) return eventOvertime || gameOvertime ? 'GAME_OVERTIME' : 'RUNNING';
    if (isResetWindow(active)) return eventOvertime ? 'RESET_OVERTIME' : 'RESETTING';
    if (active.status === 'LOBBY_CALL' || active.status === 'TEAM_PREPARING') return eventOvertime ? 'GAME_OVERTIME' : 'PREPARING';
  }
  if (ev.event_ended_at !== null) return 'ENDED';
  return eventOvertime ? 'RESET_OVERTIME' : 'READY';
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
