import type { JourneyStopDef, ResetTaskKey, Role, StationRole } from '../shared/constants';
import { JOURNEY_STOPS, OBSERVER_CAPACITY, RESET_TASK_LABEL, STALL_WARN_MS } from '../shared/constants';
import {
  attemptsOf,
  deriveEventStatus,
  gameRemainingMs,
  isResetWindow,
  isTerminalRound,
  liveStatus,
  pendingEligibleClaims,
  resultOf,
  roundDeadlineMs,
  roundLimitMs,
  stallSince,
} from '../shared/machine';
import { formatClockSec, formatWallTime } from '../shared/metrics';
import type {
  ActionType,
  CommandMeta,
  CompletionAttempt,
  FlowStatus,
  Round,
  RoundResult,
  Snapshot,
  SystemPhase,
} from '../shared/types';

export type Tone = 'primary' | 'danger' | 'warn' | 'waiting';

export interface PrimaryAction {
  action: ActionType | null;
  label: string;
  tone: Tone;
  hint: string | null;
  /** True when only a supervisor, with a typed reason, may proceed. */
  overrideOnly: boolean;
  /** When set, the control must collect this reason before it may send. */
  reasonPrompt: string | null;
  /** When set, the control must be confirmed a second time before it may send. */
  confirmLabel: string | null;
  /** Extra payload the action carries (an attempt id, an override flag…). */
  meta: CommandMeta;
}

/** Everything the one control needs, so no screen decides permissions for itself. */
function locked(label: string, hint: string | null = null): PrimaryAction {
  return {
    action: null,
    label,
    tone: 'waiting',
    hint,
    overrideOnly: false,
    reasonPrompt: null,
    confirmLabel: null,
    meta: {},
  };
}

function live(
  action: ActionType,
  label: string,
  opts: { tone?: Tone; hint?: string | null; meta?: CommandMeta; reasonPrompt?: string; confirmLabel?: string } = {},
): PrimaryAction {
  return {
    action,
    label,
    tone: opts.tone ?? 'primary',
    hint: opts.hint ?? null,
    overrideOnly: false,
    reasonPrompt: opts.reasonPrompt ?? null,
    confirmLabel: opts.confirmLabel ?? null,
    meta: opts.meta ?? {},
  };
}

export function activeRound(snap: Snapshot | null): Round | null {
  if (!snap) return null;
  return snap.active_round;
}

/**
 * Phase and status are pure functions of authoritative timestamps and "now", so
 * they are re-derived against the client's estimated server clock on every render.
 * A fetched snapshot can never leave the dashboard showing a phase that time has
 * already passed — while the official numbers stay untouched.
 */
export function phaseOf(snap: Snapshot, nowMs: number): SystemPhase {
  // Always recomputed against the live estimated server clock: a snapshot fetched a
  // minute ago must not keep a phone in a phase that time has already left behind.
  return deriveFallback(snap, nowMs);
}

/** The derivation the server used, recomputed locally against the live clock. */
function deriveFallback(snap: Snapshot, nowMs: number): SystemPhase {
  const round = snap.active_round;
  if (snap.event.event_ended_at !== null) return 'ENDED';
  if (snap.event.event_started_at === null && !round) return 'PRE_EVENT';
  if (!round) return 'WAITING_FOR_TEAM';
  return liveStatus(round, snap.attempts ?? [], roundLimitMs(round, snap.event.config.game_limit_ms), nowMs);
}

export function statusOf(snap: Snapshot, nowMs: number): ReturnType<typeof deriveEventStatus> {
  return deriveEventStatus(snap.event, nowMs);
}

/** The lifecycle position of the round in play, or null when nobody is on the floor. */
export function flowOf(snap: Snapshot, nowMs: number): FlowStatus | null {
  const phase = phaseOf(snap, nowMs);
  return phase === 'PRE_EVENT' || phase === 'ENDED' || phase === 'WAITING_FOR_TEAM' ? null : phase;
}

export function resultOfRound(snap: Snapshot, nowMs: number): RoundResult | null {
  const round = snap.active_round;
  if (!round) return null;
  return resultOf(round, snap.attempts ?? [], roundLimitMs(round, snap.event.config.game_limit_ms), nowMs);
}

/**
 * The functional screen lock (§9). While the countdown runs, or the clock has run
 * out and a claim still awaits verification, every phone shows the clock and only
 * the explicitly authorised in-game controls stay available.
 */
export function isLockedPhase(phase: SystemPhase): boolean {
  return phase === 'RUNNING' || phase === 'TIME_EXPIRED_PENDING_VALIDATION';
}

/* ------------------------------------------------------------------ identity */

/** “Đội PHANTOM 05”, the way every shared sentence names the team. */
export function teamLabel(round: Round | null, nextTeamNumber: number): string {
  if (!round) return `Đội #${pad(nextTeamNumber)}`;
  return round.team_name ? `Đội ${round.team_name.toUpperCase()}` : `Đội #${pad(round.team_number)}`;
}

/* ------------------------------------------------------------- primary action */

export function resolvePrimary(role: Role, snap: Snapshot, nowMs: number): PrimaryAction {
  const phase = phaseOf(snap, nowMs);
  const round = snap.active_round;
  const attempts = snap.attempts ?? [];
  // What a round runs on: its own snapshot once it has started, otherwise the
  // duration the supervisor has configured for the next round (V3.1 §7.5).
  const limit = roundLimitMs(round, snap.event.config.game_limit_ms);
  const limitLabel = formatClockSec(limit);

  // A viewer is never an operator, whatever the client renders around it.
  if (role === 'OBSERVER') return locked('CHỈ XEM — TRỰC TIẾP', 'Bạn đang theo dõi phòng 305');

  switch (phase) {
    case 'PRE_EVENT':
    case 'WAITING_FOR_TEAM':
      if (role === 'LOBBY') {
        return live('CALL_TEAM', 'NHẬN ĐỘI & CHO LÊN TẦNG 2', {
          hint: 'Kiểm tra đội tại sảnh rồi cho đội lên tầng 2',
        });
      }
      return locked('ĐANG CHỜ TIẾP NHẬN ĐỘI CHƠI', 'Chỉ Nhân sự 01 được nhận đội');

    case 'WAITING_FLOOR2_CONFIRMATION': {
      if (role === 'CORRIDOR') {
        return live('CONFIRM_FLOOR2', 'XÁC NHẬN ĐÃ ĐẾN TẦNG 2', {
          hint: 'Bấm khi đội đã có mặt ở tầng 2',
        });
      }
      if (role === 'GATE') {
        return live('FLOOR2_BYPASS', 'ĐỘI ĐÃ ĐẾN TẦNG 3 — BỎ QUA XÁC NHẬN TẦNG 2', {
          tone: 'warn',
          hint: 'Chỉ dùng khi tận mắt thấy đội ở tầng 3. Bỏ qua không phải là xác nhận tầng 2.',
          reasonPrompt: 'Lý do bỏ qua tầng 2 (bắt buộc, sẽ vào nhật ký)',
          confirmLabel: 'XÁC NHẬN BỎ QUA TẦNG 2',
        });
      }
      if (role === 'LOBBY') {
        return locked('ĐÃ CHO ĐỘI LÊN TẦNG 2', secondary(snap, round, nowMs));
      }
      return locked('CHỜ NHÂN SỰ 02 XÁC NHẬN TẦNG 2', secondary(snap, round, nowMs));
    }

    case 'READY_AT_FLOOR3':
      if (role === 'GATE') {
        return live('START_GAME', `BẮT ĐẦU TRÒ CHƠI — ${limitLabel}`, {
          tone: 'primary',
          hint: 'Phổ biến luật và đưa gợi ý trước khi bấm. Chỉ NPC 1 mở đồng hồ.',
        });
      }
      return locked('ĐỘI CHƠI SẮP BẮT ĐẦU', 'Chỉ NPC 1 được bấm BẮT ĐẦU');

      case 'RUNNING': {
        if (role === 'ROOM305') {
          return live('CLAIM_COMPLETE', 'GHI NHẬN BÁO HOÀN THÀNH', {
            hint: 'Đồng hồ VẪN chạy sau khi ghi nhận. Kiểm tra trận đồ rồi mới chốt.',
          });
        }
        if (role === 'GATE') return locked(`${limitLabel} ĐANG CHẠY`, 'Chỉ bấm khi cần rời khu vực khẩn cấp');
        return locked(`ĐANG KHOÁ — ${limitLabel} ĐANG CHẠY`);
      }

    case 'TIME_EXPIRED_PENDING_VALIDATION': {
      if (role === 'GATE') {
        return live('CONFIRM_EXIT', 'XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3', {
          tone: 'warn',
          hint: 'Đội không bị giữ lại vì phần mềm đang chờ xác minh',
        });
      }
      if (role === 'ROOM305') {
        return locked('Kiểm tra lần báo đang chờ', 'Dùng danh sách lần báo hoàn thành bên dưới');
      }
      return locked('HẾT GIỜ — ĐANG CHỜ XÁC MINH MỐC HỢP LỆ');
    }

    case 'WAITING_FOR_EXIT':
      if (role === 'GATE') {
        return live('CONFIRM_EXIT', 'XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3', {
          tone: 'primary',
          hint: round?.aborted_at !== null
            ? 'Lượt chơi đã bị hủy — vẫn phải xác nhận đội đã ra khỏi khu vực'
            : 'Thời gian hoàn thành không đổi khi xác nhận rời khu vực',
        });
      }
      return locked(round && round.aborted_at !== null
        ? 'LƯỢT CHƠI ĐÃ HỦY — CHỜ NPC 1 XÁC NHẬN ĐÃ RỜI TẦNG 3'
        : 'ĐANG CHỜ NPC1 XÁC NHẬN ĐỘI RỜI TẦNG 3');

    case 'EXIT_CONFIRMED': {
      if (role === 'ROOM305' && pendingEligibleClaims(round ?? emptyRound(), attempts, limit, nowMs).length > 0) {
        return locked('Còn lần báo chờ xác minh', 'Kiểm tra và chốt lần báo trong danh sách');
      }
      if (role === 'GATE' || role === 'ROOM305') {
        const own = pendingTasks(snap, role);
        if (own.length > 0) {
          return live('RESET_DONE', 'ĐÃ RESET XONG', {
            tone: 'warn',
            hint: own.map((t) => RESET_TASK_LABEL[t.task_key]).join(' · '),
          });
        }
        if (role === 'GATE') {
          const missing = pendingTasks(snap);
          const pendingResult = resultOfRound(snap, nowMs) === 'PENDING_VALIDATION';
          if (missing.length === 0 && !pendingResult) {
            return live('GATE_FINALIZE', 'XÁC NHẬN SẴN SÀNG', {
              hint: 'NPC 1 chốt lượt chơi sau khi khu vực đã reset',
            });
          }
          return locked('CHỜ RESET HOÀN TẤT', pendingResult ? 'Kết quả đang chờ NPC 2 xác minh' : `Còn: ${missing.map((m) => RESET_TASK_LABEL[m.task_key]).join(' · ')}`);
        }
        return locked('ĐÃ XONG PHẦN CỦA BẠN', 'Chờ NPC 1 chốt lượt chơi');
      }
      return locked('ĐANG RESET KHU VỰC', 'Chờ khu vực tầng 3 sẵn sàng cho đội tiếp theo');
    }

    case 'CLOSED':
      return locked('LƯỢT CHƠI ĐÃ ĐÓNG', 'Sẵn sàng nhận đội tiếp theo');

    case 'ENDED':
      return locked('SỰ KIỆN ĐÃ KẾT THÚC', 'Xem tổng kết trong “Xem thêm”');

    default:
      return locked('CHỜ ĐỒNG BỘ…');
  }
}

/** The line under a locked control: who is expected to act, in one sentence. */
function secondary(snap: Snapshot, round: Round | null, nowMs: number): string | null {
  if (!round) return null;
  if (round.floor2_bypassed_at !== null) {
    return 'NPC 1 đã bỏ qua xác nhận tầng 2 — không cần thao tác ở tầng 2';
  }
  if (round.floor2_confirmed_at !== null) return 'Đội đang được hướng dẫn lên tầng 3';
  return resultOfRound(snap, nowMs) === 'IN_PROGRESS' ? 'Chờ Nhân sự 02 xác nhận đội đã đến tầng 2' : null;
}

const EMPTY_ROUND_EXTRA = {
  result: 'IN_PROGRESS' as RoundResult,
  validated_attempt_id: null,
};

/** A stand-in that only exists so the helper above never dereferences null. */
function emptyRound(): Round {
  return {
    ...EMPTY_ROUND_EXTRA,
    id: '',
    event_id: '',
    round_number: 0,
    team_number: 0,
    team_name: null,
    status: 'WAITING_FLOOR2_CONFIRMATION',
    stage: 1,
    called_at: 0,
    received_by_role: null,
    received_by: null,
    floor2_confirmed_at: null,
    floor2_confirmed_by_role: null,
    floor2_confirmed_by: null,
    floor2_bypassed_at: null,
    floor2_bypassed_by_role: null,
    floor2_bypassed_by: null,
    floor2_bypass_reason: null,
    game_started_at: null,
    started_by_role: null,
    started_by: null,
    deadline_at: null,
    game_anchor_ms: null,
    game_elapsed_ms: 0,
    game_stopped_at: null,
    game_reset_count: 0,
    game_pause_count: 0,
    round_duration_ms: null,
    abort_kind: null,
    abort_reason: null,
    official_duration_ms: null,
    puzzle_completed_at: null,
    exit_confirmed_at: null,
    exit_by_role: null,
    exit_by: null,
    exit_reason: null,
    gate_finalized_at: null,
    finalized_by_role: null,
    system_ready_at: null,
    aborted_at: null,
    outcome: 'IN_PROGRESS',
    admission_override: false,
    hiding_layout: 'A',
    reset_cycle: 1,
    start_press_ms: null,
    stop_press_ms: null,
    start_transport_ms: null,
    stop_transport_ms: null,
    needs_review: false,
    review_reasons: [],
    review_resolved_at: null,
    decertified: false,
    created_revision: 0,
  };
}

/**
 * The compact secondary control that stays reachable on the locked screen: NPC1's
 * guarded emergency exit. It is deliberately not a primary button, so it never
 * competes with the clock, and it always needs a reason plus a confirmation.
 */
export function resolveEmergency(role: Role, snap: Snapshot, nowMs: number): PrimaryAction | null {
  if (role !== 'GATE') return null;
  const phase = phaseOf(snap, nowMs);
  if (phase !== 'RUNNING' && phase !== 'TIME_EXPIRED_PENDING_VALIDATION' && phase !== 'WAITING_FOR_EXIT') return null;
  if (resultOfRound(snap, nowMs) === 'WON' && phase === 'WAITING_FOR_EXIT') return null;
  return live('EARLY_EXIT', 'KẾT THÚC SỚM / RỜI KHU VỰC', {
    tone: 'danger',
    hint: 'Chỉ dùng khi đội buộc phải rời khu vực. Không tạo thời gian thắng.',
    reasonPrompt: 'Lý do kết thúc sớm (bắt buộc, sẽ vào nhật ký)',
    confirmLabel: 'XÁC NHẬN KẾT THÚC SỚM',
  });
}

/* ------------------------------------------------------------------ countdown */

/**
 * The one clock every locked screen renders. MM:SS carries the visual weight and
 * the hundredths are a separate, smaller field, so nothing competes with the main
 * number. It is derived purely from the stored deadline and the synced server
 * clock: no interval, no local start, no drift.
 */
export interface CountdownView {
  /** Whether this screen should be the countdown at all. */
  visible: boolean;
  /** Signed ms until the authoritative deadline; clamped for display. */
  remainingMs: number;
  /** Display value, never negative: at 00:00 the countdown stops. */
  mm: string;
  ss: string;
  cs: string;
  expired: boolean;
  running: boolean;
  /**
   * True once the round is decided. The gameplay countdown is live information
   * only until then: from the moment an announcement is judged (or the floor is
   * aborted) the screen stops counting toward a deadline that no longer matters.
   */
  settled: boolean;
  /** Which number the hero carries: the remaining time, or the time that counted. */
  mode: 'GAME' | 'RESULT';
  /** The line above the hero digits, in the operator's own words. */
  heroLabel: string;
  /** The duration this round runs on, for every label that names it. */
  durationMs: number;
  teamText: string;
  statusLine: string;
  result: RoundResult | null;
  /** Official elapsed time once a claim has been validated. */
  officialMs: number | null;
  tone: Tone;
  /** Warning threshold crossing for the alarm pattern. */
  warnMs: number;
}

export function resolveCountdown(snap: Snapshot, nowMs: number): CountdownView {
  const round = snap.active_round;
  // The round's own duration, not the configuration as it reads right now.
  const limit = roundLimitMs(round, snap.event.config.game_limit_ms);
  const phase = phaseOf(snap, nowMs);
  const signed = round ? gameRemainingMs(round, limit, nowMs) : limit;
  const shown = Math.max(0, signed);
  const result = resultOfRound(snap, nowMs);
  // §10 step B item 5: verifying the right announcement ends the countdown as a
  // piece of live information. The hero then carries the official time itself —
  // the claim's own instant — so the number on the screen is the number on the
  // board. An aborted round freezes at whatever the clock had left when NPC1 said
  // so, and never invents a finishing time.
  const settled = result === 'WON' || result === 'ABORTED';
  const heroMs = result === 'WON'
    ? round?.official_duration_ms ?? 0
    : result === 'ABORTED'
      ? Math.max(0, (round?.deadline_at ?? 0) - (round?.aborted_at ?? round?.exit_confirmed_at ?? 0))
      : shown;
  const total = Math.floor(heroMs / 1000);
  const statusLine =
    phase === 'TIME_EXPIRED_PENDING_VALIDATION'
      ? 'HẾT GIỜ — ĐANG CHỜ XÁC MINH MỐC HỢP LỆ'
      : result === 'WON'
        ? `● THÀNH CÔNG ${formatClockSec(round?.official_duration_ms ?? 0)}`
        : result === 'TIME_UP'
          ? 'HẾT GIỜ — CHỜ ĐỘI RỜI TẦNG 3'
          : result === 'ABORTED'
            ? 'ĐÃ KẾT THÚC SỚM'
            : phase === 'RUNNING'
              ? `● ĐANG CHẠY ${formatClockSec(limit)}`
              : '● ĐANG CHỜ';
  return {
    visible: isLockedPhase(phase) || phase === 'WAITING_FOR_EXIT',
    remainingMs: signed,
    mm: String(Math.floor(total / 60)).padStart(2, '0'),
    ss: String(total % 60).padStart(2, '0'),
    cs: String(Math.floor((heroMs % 1000) / 10)).padStart(2, '0'),
    expired: signed <= 0,
    running: phase === 'RUNNING' && result === 'IN_PROGRESS',
    settled,
    mode: settled ? 'RESULT' : 'GAME',
    heroLabel: result === 'WON'
      ? 'THỜI GIAN HOÀN THÀNH'
      : result === 'ABORTED'
        ? 'LƯỢT CHƠI ĐÃ HỦY'
        : signed <= 0
          ? 'HẾT GIỜ'
          : 'THỜI GIAN CÒN LẠI',
    durationMs: limit,
    teamText: teamLabel(round, snap.event.next_team_number),
    statusLine,
    result,
    officialMs: round?.official_duration_ms ?? null,
    tone: phase === 'TIME_EXPIRED_PENDING_VALIDATION'
      ? 'warn'
      : result === 'ABORTED'
        ? 'warn'
        : result === 'WON'
          ? 'primary'
          : signed <= 0 ? 'danger' : signed <= 60_000 ? 'warn' : 'primary',
    warnMs: 60_000,
  };
}

/* ------------------------------------------------------------------ attempts */

export interface AttemptRow {
  id: string;
  seq: number;
  claimedAt: number;
  elapsedMs: number;
  remainingMs: number;
  status: CompletionAttempt['status'];
  inTime: boolean;
  /** The two decisions NPC2 may still make about this attempt. */
  open: boolean;
  verifiedAt: number | null;
  verifiedByRole: string | null;
  decisionNote: string | null;
  label: string;
}

/**
 * NPC2's compact attempt list: every claim keeps its own row and its own timestamp,
 * so a verification always names the attempt it belongs to.
 */
export function resolveAttempts(snap: Snapshot, nowMs: number): AttemptRow[] {
  const round = snap.active_round;
  if (!round) return [];
  const limit = roundLimitMs(round, snap.event.config.game_limit_ms);
  const result = resultOf(round, snap.attempts ?? [], limit, nowMs);
  // A settled win closes the list; a cancellation only closes it when the round was
  // disqualified, so a claim recorded before the deadline stays judgable (§4.4).
  const judgable = attemptsJudgable(round, result);
  return attemptsOf(snap.attempts ?? [], round.id).map((a) => ({
    id: a.id,
    seq: a.seq,
    claimedAt: a.claimed_at,
    elapsedMs: a.elapsed_ms,
    remainingMs: a.remaining_ms,
    status: a.status,
    inTime: a.in_time,
    open: judgable && (a.status === 'PENDING' || a.status === 'LATE'),
    verifiedAt: a.verified_at,
    verifiedByRole: a.verified_by_role,
    decisionNote: a.decision_note,
    label: `Lần ${a.seq} — ${formatClockCs(a.elapsed_ms)} — ${
      a.status === 'PENDING' ? 'Chờ kiểm tra' : a.status === 'LATE' ? 'Đến muộn' : a.status === 'VALID' ? 'CHÍNH XÁC' : 'CHƯA ĐÚNG'
    }`,
  }));
}

/** True while NPC2 has an in-time claim that still needs a decision. */
export function awaitingVerification(snap: Snapshot, nowMs: number): boolean {
  const round = snap.active_round;
  if (!round) return false;
  return pendingEligibleClaims(round, snap.attempts ?? [], roundLimitMs(round, snap.event.config.game_limit_ms), nowMs).length > 0;
}

/**
 * Whether NPC2 may still judge the recorded claims of this round. A validated win
 * seals the list; a cancellation seals it only when it was a disqualification, and
 * then only until a supervisor has resolved the review by name (V3.1 §4.4).
 */
export function attemptsJudgable(round: Round, result: RoundResult | null): boolean {
  if (result === 'WON') return false;
  if (round.aborted_at !== null && round.abort_kind === 'misconduct') {
    return round.review_resolved_at !== null && !round.decertified;
  }
  return true;
}

/* --------------------------------------------------------------- big screen */

export interface BigScreenClock {
  /** Identifies the running game; changes when a new countdown is started. */
  key: string;
  teamNumber: number;
  /** The authoritative 5-minute game limit. */
  limitMs: number;
  /** Signed ms: frozen at zero once the deadline passes, never negative on screen. */
  remainingMs: number;
  expired: boolean;
  phase: SystemPhase;
  result: RoundResult | null;
  officialMs: number | null;
  pendingValidation: boolean;
}

/**
 * What the wall display shows: the authoritative countdown of the current round,
 * mirrored straight from the stored start, duration and deadline. It has no local
 * override and no pause or reset control, because the clock is not editable.
 */
export function resolveBigScreen(snap: Snapshot, nowMs: number): BigScreenClock | null {
  const round = snap.active_round;
  if (!round) return null;
  const limitMs = roundLimitMs(round, snap.event.config.game_limit_ms);
  const phase = phaseOf(snap, nowMs);
  if (!isLockedPhase(phase) && phase !== 'WAITING_FOR_EXIT') return null;
  if (round.game_started_at === null) return null;
  const result = resultOf(round, snap.attempts ?? [], limitMs, nowMs);
  return {
    key: `${round.id}:${round.deadline_at ?? round.game_started_at}`,
    teamNumber: round.team_number,
    limitMs,
    remainingMs: Math.max(0, gameRemainingMs(round, limitMs, nowMs)),
    expired: gameRemainingMs(round, limitMs, nowMs) <= 0,
    phase,
    result,
    officialMs: round.official_duration_ms,
    pendingValidation: result === 'PENDING_VALIDATION',
  };
}

/* --------------------------------------------------------------------- journey */

export type JourneyMovement = 'idle' | 'up' | 'at' | 'down';
/** done = ✓ red, lead = ring (the area being walked into), here = solid, todo = grey. */
export type JourneyState = 'done' | 'lead' | 'here' | 'todo';

export interface JourneyStop {
  key: JourneyStopDef['key'];
  floor: string;
  name: string;
  /** Printed under the node: [“SẢNH”, “TẦNG 1”], [“TẦNG 2”… */
  label: readonly string[];
  station: Role | null;
  state: JourneyState;
  /** Server time of the press that reached this stop, when one recorded it. */
  at_ms: number | null;
  note: string | null;
}

export interface JourneyTask {
  key: ResetTaskKey;
  label: string;
  role: Role;
  done: boolean;
}

export interface JourneyTurn {
  /** Position(s) whose next press moves the team forward. */
  roles: Role[];
  /** The same words as the button on that station. */
  label: string;
  /** True on the phone that must press right now. */
  mine: boolean;
}

export interface JourneyInfo {
  team_number: number | null;
  team_name: string | null;
  next_team_number: number;
  stops: JourneyStop[];
  /** Index into `stops` the team stands at or is travelling from; -1 = nobody. */
  position: number;
  /** Index into `stops` of the area the team is walking into — the tile that leads. */
  focus: number;
  movement: JourneyMovement;
  /** Where the team is, in words: “TẦNG 2”, “ĐANG LÊN TẦNG 2”… */
  where: string;
  turn: JourneyTurn | null;
  /** One line, identical on every device. */
  caption: string;
  tasks: JourneyTask[];
}

/**
 * The team's walk through the venue, derived only from authoritative timestamps:
 * SẢNH TẦNG 1 → TẦNG 2 → CỬA VÀO TẦNG 3 → PHÒNG 305 → KẾT THÚC. Every device reads
 * the same position, so nobody has to reconstruct the route from a status label.
 * The hallway is part of the floor-3 leg and has no node of its own any more.
 */
export function resolveJourney(snap: Snapshot, nowMs: number, role: Role): JourneyInfo {
  const round = snap.active_round;
  const phase = phaseOf(snap, nowMs);
  const at: (number | null)[] = [null, null, null, null, null];
  const notes: (string | null)[] = [null, null, null, null, null];
  let position = 0;
  let movement: JourneyMovement = 'idle';
  let where = 'SẢNH TẦNG 1';
  let caption = 'Chưa mở sự kiện';
  let turn: { roles: Role[]; label: string } | null = null;

  if (round) {
    const limitLabel = formatClockSec(roundLimitMs(round, snap.event.config.game_limit_ms));
    at[0] = round.called_at;
    at[1] = round.floor2_confirmed_at ?? round.floor2_bypassed_at;
    at[2] = round.game_started_at;
    at[3] = round.puzzle_completed_at ?? (round.exit_confirmed_at ? round.exit_confirmed_at : null);
    notes[0] = 'Đã nhận đội ở sảnh';

    switch (phase) {
      case 'WAITING_FLOOR2_CONFIRMATION':
        position = 0;
        movement = 'up';
        where = 'ĐANG LÊN TẦNG 2';
        caption = round.floor2_bypassed_at !== null ? 'Đội đã được bỏ qua tầng 2' : 'Đội đang lên tầng 2';
        turn =
          round.floor2_bypassed_at !== null
            ? { roles: ['GATE'], label: `BẮT ĐẦU TRÒ CHƠI — ${limitLabel}` }
            : { roles: ['CORRIDOR'], label: 'XÁC NHẬN ĐÃ ĐẾN TẦNG 2' };
        break;
      case 'READY_AT_FLOOR3':
        position = 2;
        movement = 'at';
        where = 'CỬA VÀO · TẦNG 3';
        notes[1] = round.floor2_bypassed_at !== null ? 'Bỏ qua xác nhận (NPC 1)' : `Đã xác nhận · ${formatWallTime(round.floor2_confirmed_at ?? 0)}`;
        notes[2] = 'Đội đang nghe phổ biến luật';
        caption = 'ĐỘI CHƠI SẮP BẮT ĐẦU';
        turn = { roles: ['GATE'], label: `BẮT ĐẦU TRÒ CHƠI — ${limitLabel}` };
        break;
      case 'RUNNING':
        position = 3;
        movement = 'at';
        where = 'PHÒNG 305 · TẦNG 3';
        notes[2] = `${limitLabel} chạy · ${formatWallTime(round.game_started_at ?? 0)}`;
        caption = `${limitLabel} đang chạy`;
        turn = { roles: ['ROOM305'], label: 'GHI NHẬN BÁO HOÀN THÀNH' };
        break;
      case 'TIME_EXPIRED_PENDING_VALIDATION':
        position = 3;
        movement = 'at';
        where = 'PHÒNG 305 · TẦNG 3';
        notes[2] = `Hết ${limitLabel} · ${formatWallTime(round.deadline_at ?? 0)}`;
        caption = 'Hết giờ — đang chờ xác minh mốc hợp lệ';
        turn = { roles: ['ROOM305', 'GATE'], label: 'KIỂM TRA LẦN BÁO / XÁC NHẬN RỜI TẦNG 3' };
        break;
      case 'WAITING_FOR_EXIT':
        position = 3;
        movement = 'down';
        where = 'ĐANG RA CỬA VÀO TẦNG 3';
        notes[2] = `Chờ rời tầng 3 · ${formatWallTime(nowMs)}`;
        if (round.puzzle_completed_at !== null) notes[3] = `Trận đồ · ${formatWallTime(round.puzzle_completed_at)}`;
        caption = resultOfRound(snap, nowMs) === 'WON'
          ? 'Đã chốt thời gian — chờ đội rời tầng 3'
          : round.aborted_at !== null
            ? 'Lượt chơi đã hủy — chờ đội rời tầng 3'
            : 'Chờ đội rời tầng 3';
        turn = { roles: ['GATE'], label: 'XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3' };
        break;
      default: {
        // The team is out; the area is being put back ready for the next team.
        position = 2;
        movement = 'at';
        where = 'CỬA VÀO · TẦNG 3';
        notes[2] = round.exit_confirmed_at ? `Đã rời tầng 3 · ${formatWallTime(round.exit_confirmed_at)}` : 'Đang reset khu vực';
        if (round.puzzle_completed_at !== null) notes[3] = `Trận đồ · ${formatWallTime(round.puzzle_completed_at)}`;
        const open = pendingTasks(snap);
        if (open.length > 0) {
          caption = 'Đang setup khu vực';
          turn = { roles: Array.from(new Set(open.map((t) => t.required_role))), label: 'ĐÃ RESET XONG' };
        } else {
          caption = 'Đã setup xong · chờ NPC 1 chốt lượt chơi';
          turn = { roles: ['GATE'], label: 'XÁC NHẬN SẴN SÀNG' };
        }
        break;
      }
    }
  } else if (phase === 'ENDED') {
    position = -1;
    where = 'SỰ KIỆN KẾT THÚC';
    caption = 'Sự kiện đã kết thúc';
  } else {
    // Between teams the route starts again at the lobby, which is what makes the
    // first press of every team the same, predictable one.
    position = 0;
    caption = phase === 'PRE_EVENT' ? 'Chưa mở sự kiện — Nhân sự 01 nhận đội đầu tiên' : `Sẵn sàng nhận đội #${pad(snap.event.next_team_number)}`;
    turn = { roles: ['LOBBY'], label: 'NHẬN ĐỘI & CHO LÊN TẦNG 2' };
  }

  // The reset checklist only matters once the team is out; mid-round it is noise.
  const tasks: JourneyTask[] =
    round && isResetWindow(round)
      ? snap.reset_tasks
          .filter((t) => t.round_id === round.id)
          .map((t) => ({
            key: t.task_key,
            label: RESET_TASK_LABEL[t.task_key],
            role: t.required_role,
            done: t.completed_at !== null && t.cycle === round.reset_cycle,
          }))
      : [];

  // The ring sits on the area the guests are walking into (or standing in), and
  // on “KẾT THÚC” once the round only needs closing.
  const focus =
    position < 0
      ? -1
      : round && (phase === 'EXIT_CONFIRMED' || phase === 'CLOSED')
        ? JOURNEY_STOPS.length - 1
        : movement === 'up'
          ? Math.min(position + 1, JOURNEY_STOPS.length - 1)
          : movement === 'down'
            ? Math.max(position - 1, 0)
            : position;

  const stateOf = (i: number): JourneyState => {
    if (i === focus) return 'lead';
    if (movement !== 'at' && i === position) return 'here';
    if (i < focus) return 'done';
    if (movement === 'down' && i > focus) return 'done';
    return 'todo';
  };

  return {
    team_number: round?.team_number ?? null,
    team_name: round?.team_name ?? null,
    next_team_number: snap.event.next_team_number,
    stops: JOURNEY_STOPS.map((def, i) => ({
      key: def.key,
      floor: def.floor,
      name: def.name,
      label: def.label,
      station: def.station,
      state: stateOf(i),
      at_ms: at[i],
      note: notes[i],
    })),
    position,
    focus,
    movement,
    where,
    turn: turn ? { ...turn, mine: turn.roles.includes(role) } : null,
    caption,
    tasks,
  };
}

/* ----------------------------------------------------------------- team line */

export type TeamTone = 'red' | 'green' | 'amber' | 'blue' | 'violet' | 'mute';

export interface TeamLine {
  text: string;
  tone: TeamTone;
}

/** The one sentence under TEAM #…, worded per phase and coloured per situation. */
export function resolveTeamLine(snap: Snapshot, nowMs: number): TeamLine {
  const round = snap.active_round;
  const phase = phaseOf(snap, nowMs);
  if (!round) {
    if (phase === 'ENDED') return { text: 'Sự kiện đã kết thúc', tone: 'mute' };
    if (phase === 'PRE_EVENT') return { text: 'Chờ tiếp nhận đội chơi', tone: 'mute' };
    return { text: 'Chờ tiếp nhận đội chơi', tone: 'mute' };
  }
  const result = resultOfRound(snap, nowMs);
  switch (phase) {
    case 'WAITING_FLOOR2_CONFIRMATION':
      return { text: round.floor2_bypassed_at !== null ? 'Đã bỏ qua tầng 2' : 'Đang lên tầng 2', tone: 'amber' };
    case 'READY_AT_FLOOR3':
      return { text: 'Sắp bắt đầu ở tầng 3', tone: 'amber' };
    case 'RUNNING':
      return { text: `${formatClockSec(roundLimitMs(round, snap.event.config.game_limit_ms))} đang chạy`, tone: 'green' };
    case 'TIME_EXPIRED_PENDING_VALIDATION':
      return { text: 'Hết giờ — chờ xác minh mốc hợp lệ', tone: 'amber' };
    case 'WAITING_FOR_EXIT':
      return result === 'WON'
        ? { text: `Thành công ${formatClockSec(round.official_duration_ms ?? 0)} — chờ rời tầng 3`, tone: 'green' }
        : result === 'ABORTED'
          ? { text: 'Lượt chơi đã hủy — chờ đội rời tầng 3', tone: 'blue' }
          : { text: 'Hết giờ — chờ đội rời tầng 3', tone: 'blue' };
    case 'EXIT_CONFIRMED':
      return result === 'PENDING_VALIDATION'
        ? { text: 'Đã rời khu vực — kết quả chờ xác minh', tone: 'amber' }
        : { text: 'Đang reset khu vực', tone: 'violet' };
    default:
      return { text: 'Đang xử lý', tone: 'amber' };
  }
}

export function isAreaReady(snap: Snapshot | null, nowMs: number): boolean {
  if (!snap) return false;
  const phase = phaseOf(snap, nowMs);
  return phase === 'WAITING_FOR_TEAM' || phase === 'PRE_EVENT';
}

export function hasActiveRound(snap: Snapshot | null): boolean {
  return !!snap && !isTerminalRound(snap.active_round);
}

export function pad(n: number): string {
  return String(n).padStart(3, '0');
}

/** MM:SS.hh — the same formatting the authoritative messages use. */
export function formatClockCs(ms: number): string {
  const abs = Math.max(0, ms);
  const m = Math.floor(abs / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  const cs = Math.floor((abs % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/* ------------------------------------------------------ must-not-be-hidden-by */

export interface AlertInfo {
  id: 'STALL' | 'REVIEW' | 'PENDING' | 'BYPASS' | 'DEGRADED' | 'AUDIO' | 'PRESTART' | 'FULL';
  tone: Tone;
  text: string;
}

/**
 * Safety- and prize-critical notices are surfaced on the main screen, never only
 * inside “Xem thêm”. Warnings only — nothing here stops a clock or changes a state.
 */
export function resolveAlerts(snap: Snapshot, nowMs: number, staleData: boolean): AlertInfo[] {
  const out: AlertInfo[] = [];
  const round = snap.active_round;
  const stallMs = snap.event.config.stall_warn_ms ?? STALL_WARN_MS;
  const since = stallSince(round, nowMs, roundLimitMs(round, snap.event.config.game_limit_ms));
  const phase = phaseOf(snap, nowMs);
  if (round && since !== null && since > stallMs) {
    out.push({
      id: 'STALL',
      tone: 'warn',
      text: `${teamLabel(round, snap.event.next_team_number)} ở lại khu vực được ${Math.floor(since / 1000)}s — NPC 1 chưa xác nhận rời tầng 3`,
    });
  }
  if (phase === 'READY_AT_FLOOR3') {
    out.push({ id: 'PRESTART', tone: 'warn', text: 'ĐỘI CHƠI SẮP BẮT ĐẦU — NPC 1 chuẩn bị phổ biến luật' });
  }
  if (round && resultOfRound(snap, nowMs) === 'PENDING_VALIDATION') {
    out.push({ id: 'PENDING', tone: 'warn', text: 'HẾT GIỜ — ĐANG CHỜ XÁC MINH MỐC HỢP LỆ' });
  }
  if (round && round.floor2_bypassed_at !== null) {
    out.push({ id: 'BYPASS', tone: 'warn', text: 'Tầng 2 được NPC 1 bỏ qua — có ghi nhật ký' });
  }
  if (round && round.needs_review && round.review_reasons.length > 0) {
    out.push({ id: 'REVIEW', tone: 'warn', text: `Kết quả ${teamLabel(round, snap.event.next_team_number)} chờ xét lại` });
  }
  if (staleData) {
    out.push({ id: 'DEGRADED', tone: 'warn', text: 'Dữ liệu có thể cũ — đang kiểm tra lại với máy chủ' });
  }
  return out;
}

/** Reset tasks still outstanding for the round, honouring the reset cycle. */
export function pendingTasks(snap: Snapshot, role?: Role) {
  const round = snap.active_round;
  if (!round) return [];
  return snap.reset_tasks.filter(
    (t) => t.round_id === round.id && (t.completed_at === null || t.cycle !== round.reset_cycle) && (!role || t.required_role === role),
  );
}

/* -------------------------------------------------------------- station strip */

export type StationState = 'active' | 'idle';

export interface StationInfo {
  role: StationRole;
  /** Short station name for the four-chip strip. */
  label: string;
  /** Position whose hand owns the round right now. */
  state: StationState;
  /** This operator has a tappable action: the pulsing handoff ring. */
  turn: boolean;
}

const STATION_ORDER: StationRole[] = ['LOBBY', 'CORRIDOR', 'GATE', 'ROOM305'];

const STATION_LABEL: Record<StationRole, string> = {
  LOBBY: '01 · SẢNH',
  CORRIDOR: '02 · TẦNG 2',
  GATE: 'NPC 1',
  ROOM305: 'NPC 2',
};

/**
 * Which position the team is actually with. The green chip is where the guests are,
 * not who presses next: OPERATOR 02 wears it while the team climbs to floor 2, NPC 2
 * wears it for the whole 5:00, and NPC 1 wears it again on the way out. Reset is the
 * one parallel window, so several stations light at the same time there.
 */
function owningStations(snap: Snapshot, nowMs: number): Set<StationRole> {
  const phase = phaseOf(snap, nowMs);
  // OPERATOR 01 owns the floor whenever nobody is in play, including the first team.
  if (phase === 'PRE_EVENT' || phase === 'WAITING_FOR_TEAM') return new Set<StationRole>(['LOBBY']);
  if (phase === 'ENDED') return new Set<StationRole>();
  const round = snap.active_round;
  if (!round) return new Set<StationRole>(['LOBBY']);
  switch (phase) {
    case 'WAITING_FLOOR2_CONFIRMATION':
      return new Set<StationRole>(['CORRIDOR']);
    case 'READY_AT_FLOOR3':
    case 'WAITING_FOR_EXIT':
      return new Set<StationRole>(['GATE']);
    case 'RUNNING':
    case 'TIME_EXPIRED_PENDING_VALIDATION':
      return new Set<StationRole>(['ROOM305']);
    case 'EXIT_CONFIRMED': {
      const pending = new Set<StationRole>(
        pendingTasks(snap)
          .map((t) => t.required_role)
          .filter((r): r is StationRole => (STATION_ORDER as string[]).includes(r)),
      );
      return pending.size > 0 ? pending : new Set<StationRole>(['GATE']);
    }
    default:
      return new Set<StationRole>(['LOBBY']);
  }
}

/** Four-position handoff strip: who owns the round now, and who must press next. */
export function resolveStations(snap: Snapshot, nowMs: number): StationInfo[] {
  const owners = owningStations(snap, nowMs);
  const pending = awaitingVerification(snap, nowMs);
  return STATION_ORDER.map((role) => ({
    role,
    label: STATION_LABEL[role],
    state: owners.has(role) ? 'active' : 'idle',
    // NPC 2 also owns a turn while an eligible claim sits unjudged: that control
    // lives in its verification panel rather than in the single primary button.
    turn: resolvePrimary(role, snap, nowMs).action !== null || (role === 'ROOM305' && pending),
  }));
}

/* ------------------------------------------------------------------- observer */

export interface ObserverBoard {
  seats: number;
  capacity: number;
  full: boolean;
}

/** The viewer-facing capacity line, from whatever the server reported. */
export function observerBoard(devices?: number, capacity?: number): ObserverBoard {
  const seats = devices ?? 0;
  const cap = capacity ?? OBSERVER_CAPACITY;
  return { seats, capacity: cap, full: seats >= cap };
}

export type { ResetTaskKey };
