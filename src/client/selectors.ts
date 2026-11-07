import type { HidingLayout, JourneyStopDef, ResetRowState, ResetTaskKey, Role, StationRole } from '../shared/constants';
import { ACTION_LABEL, ATTEMPT_LABEL, BIG_SCREEN_WARN_MS, DEGRADED_AFTER_MS, JOURNEY_STOPS, OBSERVER_CAPACITY, PHASE_LABEL, RESET_READOUT_ORDER, RESET_STATE_LABEL, RESET_TASK_LABEL, ROLE_AREA, ROLE_PERSON, ROLE_SHORT, STALL_WARN_MS, SYNC_STATE_LABEL, VERIFY_INTERVAL_MS, resetTasksSentence } from '../shared/constants';
import {
  attemptsOf,
  authorize,
  deriveEventStatus,
  flowStatus,
  gameRemainingMs,
  isResetWindow,
  liveStatus,
  pendingEligibleClaims,
  phaseAllows,
  resultOf,
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

type Tone = 'primary' | 'danger' | 'warn' | 'waiting';

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

function resultOfRound(snap: Snapshot, nowMs: number): RoundResult | null {
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
        // V3.4 Role 02: the copy names the whole fact being confirmed, and the
        // hint states the physical precondition — the server, not this phone,
        // records the arrival.
        return live('CONFIRM_FLOOR2', 'XÁC NHẬN ĐỘI ĐÃ ĐẾN TẦNG 2', {
          hint: 'Chỉ xác nhận khi đội đã có mặt tại tầng 2.',
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
          // V3.4 §2 kept the briefing steps inside NPC 1's own preparation card;
          // the hint used to read those steps out a second time under the press.
          hint: 'Chỉ NPC 1 mở đồng hồ.',
        });
      }
      // V3.4 Role 02: after the handoff is server-confirmed the confirmation
      // control is gone for good — the locked caption acknowledges the press
      // that landed and names who owns the next one. The bypass keeps its own
      // wording so a skipped floor is never displayed as a confirmation.
      if (role === 'CORRIDOR') {
        return round?.floor2_confirmed_at !== null
          ? locked('ĐÃ XÁC NHẬN ĐỘI ĐẾN TẦNG 2', 'Đội đang được hướng dẫn lên tầng 3 — NPC 1 mở đồng hồ')
          : locked('TẦNG 2 ĐÃ ĐƯỢC BỎ QUA', 'NPC 1 đã bỏ qua xác nhận tầng 2 — không còn thao tác ở đây');
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
          // V3.4 §7: the exit closes the floor for this team — the same two-press
          // guard every physical-fact confirmation uses, never a single stray tap.
          confirmLabel: 'XÁC NHẬN LẠI: ĐỘI ĐÃ RỜI TẦNG 3',
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
          confirmLabel: 'XÁC NHẬN LẠI: ĐỘI ĐÃ RỜI TẦNG 3',
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
          // V3.4 §4: NPC 1's button names the area it physically resets, because a
          // generic "done" reads as a claim over the whole floor — which this phone
          // has no authority to make. The words come from the caller's own rows, so
          // the CTA always describes exactly what `RESET_DONE` will mark for it.
          // NPC 2 keeps its approved wording; only its hint names its areas.
          const isNpc1 = role === 'GATE';
          return live('RESET_DONE', isNpc1 ? resetConfirmLabel(own) : 'ĐÃ RESET XONG', {
            tone: 'warn',
            hint: isNpc1 ? resetConfirmHint(own) : own.map((t) => RESET_TASK_LABEL[t.task_key]).join(' · '),
          });
        }
        if (role === 'GATE') {
          const missing = pendingTasks(snap);
          const pendingResult = resultOfRound(snap, nowMs) === 'PENDING_VALIDATION';
          if (missing.length === 0 && !pendingResult) {
            return live('GATE_FINALIZE', 'XÁC NHẬN SẴN SÀNG', {
              hint: 'Khu vực đã reset xong — chốt để Nhân sự 01 nhận đội tiếp theo.',
            });
          }
          // The confirmation is replaced by a read-only status naming only the areas
          // this station owns and the server has already recorded (V3.4 §4). No second
          // press exists here, and nothing else is claimed as done.
          const mine = doneTasks(snap, 'GATE');
          const outstanding = `Còn: ${resetTasksSentence(missing.map((m) => m.task_key))} · chờ ${Array.from(new Set(missing.map((m) => ROLE_SHORT[m.required_role]))).join(' · ')}`;
          return locked(
            mine.length > 0 ? resetConfirmedLabel(mine) : 'CHỜ RESET HOÀN TẤT',
            pendingResult ? 'Kết quả đang chờ NPC 2 xác minh' : outstanding,
          );
        }
        return locked('ĐÃ XONG PHẦN CỦA BẠN', 'Chờ NPC 1 chốt lượt chơi');
      }
      // A station that owns no part of the floor-3 checklist reads the same truth:
      // what is outstanding, and who owes it.
      const rest = pendingTasks(snap);
      return locked(
        'ĐANG RESET KHU VỰC',
        rest.length === 0
          ? 'Khu vực đã reset xong — chờ NPC 1 chốt cho đội tiếp theo'
          : `Còn ${resetTasksSentence(rest.map((t) => t.task_key))} · chờ ${Array.from(new Set(rest.map((t) => ROLE_SHORT[t.required_role]))).join(' · ')}`,
      );
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
  // V3.4.1: the WON line used to print the official time a second time, under digits
  // that are already that exact number. The word is the fact; the number is said
  // once, in the largest type on the surface.
  const statusLine =
    phase === 'TIME_EXPIRED_PENDING_VALIDATION'
      ? 'HẾT GIỜ — ĐANG CHỜ XÁC MINH MỐC HỢP LỆ'
      : result === 'WON'
        ? '● THÀNH CÔNG'
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
          : signed <= 0 ? 'danger' : signed <= BIG_SCREEN_WARN_MS ? 'warn' : 'primary',
    // V3.4: the warning window is the one configured threshold the wall display
    // already reads, so the phone and the wall cross into "warn" at the same ms.
    warnMs: BIG_SCREEN_WARN_MS,
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
  /**
   * The one word for this row, from `ATTEMPT_LABEL` and whether the round can
   * still be decided. Four surfaces print attempt status — NPC 2's history, the
   * reset ledger, the flow screens' list and the audit's claim lines — and each
   * used to spell it its own way, including a sealed PENDING that read as a
   * rejection. They read this field now.
   */
  statusWord: string;
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
  const open = (a: CompletionAttempt) => judgable && (a.status === 'PENDING' || a.status === 'LATE');
  return attemptsOf(snap.attempts ?? [], round.id).map((a) => ({
    id: a.id,
    seq: a.seq,
    claimedAt: a.claimed_at,
    elapsedMs: a.elapsed_ms,
    remainingMs: a.remaining_ms,
    status: a.status,
    inTime: a.in_time,
    open: open(a),
    statusWord: a.status === 'PENDING' && !judgable
      ? ATTEMPT_LABEL.PENDING_SEALED
      : ATTEMPT_LABEL[a.status],
    verifiedAt: a.verified_at,
    verifiedByRole: a.verified_by_role,
    decisionNote: a.decision_note,
    label: `Lần ${a.seq} — ${formatClockCs(a.elapsed_ms)} — ${
      a.status === 'PENDING' && !judgable
        ? ATTEMPT_LABEL.PENDING_SEALED
        : ATTEMPT_LABEL[a.status]
    }`,
  }));
}

/** True while NPC2 has an in-time claim that still needs a decision. */
function awaitingVerification(snap: Snapshot, nowMs: number): boolean {
  const round = snap.active_round;
  if (!round) return false;
  return pendingEligibleClaims(round, snap.attempts ?? [], roundLimitMs(round, snap.event.config.game_limit_ms), nowMs).length > 0;
}

/**
 * Whether NPC2 may still judge the recorded claims of this round. A validated win
 * seals the list; a cancellation seals it only when it was a disqualification, and
 * then only until a supervisor has resolved the review by name (V3.1 §4.4).
 */
function attemptsJudgable(round: Round, result: RoundResult | null): boolean {
  if (result === 'WON') return false;
  if (round.aborted_at !== null && round.abort_kind === 'misconduct') {
    return round.review_resolved_at !== null && !round.decertified;
  }
  return true;
}

/* ------------------------------------------------- V3.4 post-round reset */

/**
 * One physical-reset area, as the floor reads it while the team is out (V3.4 §3).
 *
 * `done` is only ever the server's own confirmation inside the round's current
 * reset cycle — the same predicate the checklist rows and `GATE_FINALIZE` use.
 * `submitting` and `failed` describe this phone's unacknowledged write, never a
 * stored state, so a screen can never mark an area ready ahead of the authority.
 */
export interface ResetRow {
  key: ResetTaskKey;
  /** The area in the operator's words, never the database key. */
  label: string;
  ownerRole: Role;
  /** Who owns it, in the short station name the floor recognises. */
  owner: string;
  mine: boolean;
  state: ResetRowState;
  /** Server instant and server role of the confirmation that counts. */
  confirmedAt: number | null;
  confirmedByRole: Role | null;
  /** A mark from an earlier cycle: real reopen data, and it is outstanding again. */
  reopened: boolean;
  reopenCount: number;
  /** The layout recorded with the hidden-object check, when there is one. */
  layout: string | null;
  /** The badge word. */
  status: string;
  /** One line saying what the state means for the person reading it. */
  note: string;
}

export interface ResetBoard {
  rows: ResetRow[];
  total: number;
  done: number;
  /** True only when every stored row of this round is confirmed in this cycle. */
  allDone: boolean;
  /** Tasks the round assigned to this station. */
  mineTotal: number;
  mineOutstanding: number;
  /** The station's own part is server-confirmed and there is nothing left to press. */
  mineDone: boolean;
  outstanding: ResetTaskKey[];
  outstandingSentence: string;
  /** Who else still owes a confirmation, in short station names. */
  waitingOn: string[];
}

/** Where this phone is in the reset write: on the wire, or refused. */
interface ResetSubmit {
  submitting?: boolean;
  failed?: boolean;
  message?: string | null;
}

const NO_RESET: ResetBoard = {
  rows: [],
  total: 0,
  done: 0,
  allDone: false,
  mineTotal: 0,
  mineOutstanding: 0,
  mineDone: false,
  outstanding: [],
  outstandingSentence: '',
  waitingOn: [],
};

/** The reset read-out order: the way the floor-3 crew physically walks it. */
function resetOrderOf(key: ResetTaskKey): number {
  const at = (RESET_READOUT_ORDER as readonly string[]).indexOf(key);
  return at === -1 ? RESET_READOUT_ORDER.length : at;
}

export function resolveResetBoard(
  snap: Snapshot,
  role: Role,
  submit: ResetSubmit = {},
): ResetBoard {
  const round = snap.active_round;
  // The checklist is only a live question while the area is being put back. A round
  // still on the clock has not started its reset, and a closed one has finished it.
  if (!round || !isResetWindow(round)) return NO_RESET;
  // Only the rows the round actually owns are shown: the screen never invents a
  // task the server did not create for this round.
  const tasks = snap.reset_tasks
    .filter((t) => t.round_id === round.id)
    .sort((a, b) => resetOrderOf(a.task_key) - resetOrderOf(b.task_key));
  if (tasks.length === 0) return NO_RESET;

  const rows: ResetRow[] = tasks.map((t) => {
    const confirmedCurrent = t.completed_at !== null && t.cycle === round.reset_cycle;
    const reopened = t.completed_at === null && t.reopen_count > 0;
    const mine = t.required_role === role;
    const state: ResetRowState = confirmedCurrent
      ? 'done'
      : mine && submit.submitting
        ? 'submitting'
        : mine && submit.failed
          ? 'failed'
          // A mark that belongs to an earlier cycle is outstanding again, and says
          // so — it is reopen data from the server, not a new completion state.
          : t.completed_at !== null
            ? 'reopened'
            : reopened
              ? 'reopened'
              : 'open';
    const owner = ROLE_SHORT[t.required_role];
    // Widened on purpose: the waiting row interpolates a station name, so the
    // badge word is a sentence, not one of the five fixed state labels.
    let status: string = RESET_STATE_LABEL[state];
    let note: string;
    if (state === 'done') {
      note = `Máy chủ ghi nhận lúc ${formatWallTime(t.completed_at ?? 0)} · ${ROLE_SHORT[(t.confirmed_by_role ?? t.required_role) as Role]}`;
      if (t.layout) note += ` · bố trí ${t.layout}`;
    } else if (state === 'submitting') {
      note = 'Đã gửi máy chủ — chờ xác nhận ghi nhận.';
    } else if (state === 'failed') {
      note = submit.message ? String(submit.message) : 'Máy chủ chưa ghi nhận — bấm lại để xác nhận.';
    } else if (state === 'reopened') {
      status = RESET_STATE_LABEL.reopened;
      note = t.reopen_count > 0
        ? `Đã mở lại ${t.reopen_count} lần · mốc cũ không còn hiệu lực`
        : 'Mốc này thuộc lần reset trước · cần xác nhận lại.';
    } else if (mine) {
      note = 'Kiểm tra thật tại khu vực này trước khi xác nhận.';
    } else {
      status = `CHỜ ${owner}`;
      note = `Phần việc của ${owner} · máy này không xác nhận thay được.`;
    }
    return {
      key: t.task_key,
      label: RESET_TASK_LABEL[t.task_key] ?? t.task_key,
      ownerRole: t.required_role,
      owner,
      mine,
      state,
      confirmedAt: confirmedCurrent ? t.completed_at : null,
      confirmedByRole: confirmedCurrent ? ((t.confirmed_by_role ?? null) as Role | null) : null,
      reopened: t.completed_at !== null && t.cycle !== round.reset_cycle,
      reopenCount: t.reopen_count,
      layout: confirmedCurrent ? t.layout : null,
      status,
      note,
    };
  });

  const outstandingKeys = tasks
    .filter((t) => t.completed_at === null || t.cycle !== round.reset_cycle)
    .map((t) => t.task_key);
  const mineTasks = rows.filter((r) => r.mine);
  const mineOutstanding = rows.filter((r) => r.mine && r.state !== 'done').length;
  return {
    rows,
    total: rows.length,
    done: rows.length - outstandingKeys.length,
    allDone: outstandingKeys.length === 0,
    mineTotal: mineTasks.length,
    mineOutstanding,
    mineDone: mineTasks.length > 0 && mineOutstanding === 0,
    outstanding: outstandingKeys,
    outstandingSentence: resetTasksSentence(outstandingKeys),
    waitingOn: Array.from(new Set(
      rows.filter((r) => r.state !== 'done').map((r) => r.owner),
    )),
  };
}

/* ---------------------------------------------------- reset action wording */

/**
 * The CTA words for the areas this station itself owns (V3.4 §4).
 *
 * The button has to name the physical thing being confirmed, because "ĐÃ RESET
 * XONG" could be read as the whole floor — and the whole floor is exactly what
 * this phone is not entitled to confirm. `RESET_DONE` marks every outstanding row
 * whose owner is the caller, so the wording follows the caller's real rows and
 * never promises a confirmation the server would not make.
 */
function resetConfirmLabel(tasks: readonly { task_key: ResetTaskKey }[]): string {
  const keys = new Set(tasks.map((t) => t.task_key));
  if (keys.size === 1) {
    const key = [...keys][0];
    if (key === 'hallway') return 'XÁC NHẬN ĐÃ RESET HÀNH LANG';
    if (key === 'hidden_objects') return 'XÁC NHẬN ĐÃ RESET VẬT PHẨM ẨN';
    if (key === 'room') return 'XÁC NHẬN ĐÃ RESET PHÒNG 305';
  }
  if (keys.has('hallway') && keys.has('hidden_objects')) return 'XÁC NHẬN RESET HÀNH LANG + VẬT ẨN';
  return `XÁC NHẬN ĐÃ RESET ${resetTasksSentence([...keys]).toUpperCase()}`;
}

/** The instruction that sits under the CTA: what must be true before pressing. */
function resetConfirmHint(tasks: readonly { task_key: ResetTaskKey }[]): string {
  const keys = new Set(tasks.map((t) => t.task_key));
  if (keys.size === 1) {
    const key = [...keys][0];
    if (key === 'hallway') return 'Kiểm tra và hoàn tất reset hành lang tầng 3 trước khi xác nhận.';
    if (key === 'hidden_objects') return 'Đặt lại toàn bộ vật phẩm ẩn theo bố trí hiện hành trước khi xác nhận.';
    if (key === 'room') return 'Về đủ đạo cụ và an toàn trong phòng 305 trước khi xác nhận.';
  }
  return `Hoàn tất ${resetTasksSentence([...keys])} ngay tại khu vực trước khi xác nhận.`;
}

/**
 * The read-only status that replaces the CTA once the server has the confirmation
 * (V3.4 §4). Named from the rows this station owns and has confirmed, so it can
 * only ever claim the areas this phone was responsible for.
 */
function resetConfirmedLabel(tasks: readonly { task_key: ResetTaskKey }[]): string {
  const keys = new Set(tasks.map((t) => t.task_key));
  if (keys.size === 1) {
    const key = [...keys][0];
    if (key === 'hallway') return 'HÀNH LANG ĐÃ RESET';
    if (key === 'hidden_objects') return 'VẬT PHẨM ẨN ĐÃ RESET';
    if (key === 'room') return 'PHÒNG 305 ĐÃ RESET';
  }
  if (keys.has('hallway') && keys.has('hidden_objects')) return 'HÀNH LANG + VẬT ẨN ĐÃ RESET';
  return `${resetTasksSentence([...keys]).toUpperCase()} ĐÃ RESET`;
}

/* -------------------------------------------------- completed-round summary */

/**
 * The official result of the round that just ended, exactly as the authority
 * recorded it (V3.4 §2 and §7). Nothing here recalculates, rounds or reuses a
 * countdown: the number is the stored `official_duration_ms` of the validated
 * claim, and a round that earned no time is said to have earned no time.
 */
export interface ResultSummary {
  teamText: string;
  /** The sentence over the result: the round is over, whatever it achieved. */
  headline: string;
  /** The short word the hero carries when there is no official time. */
  stateWord: string;
  result: RoundResult | null;
  resultLabel: string;
  /** The server's official elapsed time, or null when the round has none. */
  officialMs: number | null;
  /** MM:SS.hh of `officialMs`, ready to print as the authoritative result. */
  officialText: string | null;
  exitAt: number | null;
  exitText: string | null;
  attempts: number;
  rejected: number;
  late: number;
  tone: TeamTone;
}

export function resolveResultSummary(snap: Snapshot, nowMs: number): ResultSummary | null {
  const round = snap.active_round;
  if (!round) return null;
  const result = resultOfRound(snap, nowMs);
  const claims = attemptsOf(snap.attempts ?? [], round.id);
  const officialMs = result === 'WON' ? round.official_duration_ms : null;
  const base = {
    teamText: teamLabel(round, snap.event.next_team_number),
    result,
    officialMs,
    officialText: officialMs !== null ? formatClockCs(officialMs) : null,
    exitAt: round.exit_confirmed_at,
    exitText: round.exit_confirmed_at !== null ? formatWallTime(round.exit_confirmed_at) : null,
    attempts: claims.length,
    rejected: claims.filter((a) => a.status === 'INVALID').length,
    late: claims.filter((a) => a.status === 'LATE').length,
  };
  switch (result) {
    case 'WON':
      return {
        ...base,
        headline: 'LƯỢT CHƠI ĐÃ HOÀN THÀNH',
        stateWord: 'THÀNH CÔNG',
        resultLabel: 'KẾT QUẢ CHÍNH THỨC',
        tone: 'green',
      };
    case 'PENDING_VALIDATION':
      return {
        ...base,
        headline: 'LƯỢT CHƠI ĐÃ KẾT THÚC',
        stateWord: 'CHỜ XÁC MINH',
        resultLabel: 'Kết quả chờ NPC 2 xác minh lần báo',
        tone: 'amber',
      };
    case 'ABORTED':
      return {
        ...base,
        headline: 'LƯỢT CHƠI ĐÃ HỦY',
        stateWord: 'ĐÃ HỦY',
        resultLabel: round.abort_reason ?? 'Không có kết quả thắng',
        tone: 'blue',
      };
    case 'TIME_UP':
      return {
        ...base,
        headline: 'LƯỢT CHƠI ĐÃ KẾT THÚC',
        stateWord: 'HẾT GIỜ',
        resultLabel: 'Hết giờ — không có thời gian thắng',
        tone: 'mute',
      };
    default:
      // Unstarted or historic rows: the round is out, and no time has been decided.
      return {
        ...base,
        headline: 'LƯỢT CHƠI ĐÃ KẾT THÚC',
        stateWord: 'CHƯA CHỐT',
        resultLabel: 'Chưa có kết quả được ghi',
        tone: 'mute',
      };
  }
}

/* ----------------------------------------------------- next-team readiness */

/**
 * Whether the next team may be received yet, answered from the same predicate the
 * lobby's own press is checked against (V3.4 §9). The screen cannot invite a team
 * into a floor the authority has not cleared, and it never declares readiness on
 * the strength of the hallway tick alone.
 */
type ReadinessKey = 'ready' | 'verify' | 'reset' | 'finalize' | 'playing' | 'ended';

export interface ReadinessView {
  key: ReadinessKey;
  title: string;
  detail: string;
  /** Short station names still holding the floor back; empty when nothing is. */
  waitingOn: string[];
  /** True only when the lobby's reception press would be authorised now. */
  canCallTeam: boolean;
}

export function resolveNextTeamReadiness(
  snap: Snapshot,
  nowMs: number,
  board: ResetBoard,
): ReadinessView {
  const round = snap.active_round;
  const phase = phaseOf(snap, nowMs);
  if (phase === 'ENDED') {
    return {
      key: 'ended',
      title: 'SỰ KIỆN ĐÃ KẾT THÚC',
      detail: 'Không nhận thêm đội. Chỉ Quản trị viên mở sự kiện mới.',
      waitingOn: [],
      canCallTeam: false,
    };
  }
  const limit = roundLimitMs(round, snap.event.config.game_limit_ms);
  const live = round ? liveStatus(round, snap.attempts ?? [], limit, nowMs) : null;
  const result = round ? resultOf(round, snap.attempts ?? [], limit, nowMs) : null;
  // The real permission answer, from the shared table the server enforces.
  const canCallTeam = authorize('LOBBY', 'CALL_TEAM', live, result, round).allowed;
  if (!round) {
    return {
      key: 'ready',
      title: 'SẴN SÀNG NHẬN ĐỘI TIẾP THEO',
      detail: `Khu vực đã chốt · ${teamLabel(null, snap.event.next_team_number)} sẽ vào lượt tiếp theo.`,
      waitingOn: [],
      canCallTeam,
    };
  }
  if (phase !== 'EXIT_CONFIRMED') {
    return {
      key: 'playing',
      title: 'ĐANG CÓ LƯỢT CHƠI TRÊN SÀN',
      detail: 'Chưa hoàn tất lượt hiện tại — đội mới chỉ vào được sau khi lượt này chốt xong.',
      waitingOn: [],
      canCallTeam,
    };
  }
  if (result === 'PENDING_VALIDATION') {
    return {
      key: 'verify',
      title: 'CHƯA THỂ NHẬN ĐỘI MỚI',
      detail: 'Kết quả đang chờ NPC 2 xác minh — khu vực chưa được chốt.',
      waitingOn: ['NPC 2'],
      canCallTeam,
    };
  }
  if (!board.allDone) {
    return {
      key: 'reset',
      title: 'CHƯA THỂ NHẬN ĐỘI MỚI',
      detail: `Còn ${board.outstandingSentence} chưa được xác nhận.` +
        (board.waitingOn.length > 0 ? ` Chờ ${board.waitingOn.join(' · ')}.` : ''),
      waitingOn: board.waitingOn,
      canCallTeam,
    };
  }
  return {
    key: 'finalize',
    title: 'KHU VỰC ĐÃ RESET XONG',
    detail: 'Còn một bước: NPC 1 chốt khu vực thì Nhân sự 01 mới nhận được đội mới.',
    waitingOn: ['NPC 1'],
    canCallTeam,
  };
}

/* ---------------------------------------------------------- idle hero read */

/* ---------------------------------------------------------------- NPC2 stage */

/**
 * V3.4 §2 — what NPC2 may actually do right now, answered by the SAME table the
 * server enforces (`authorize`), never by a locally remembered phase. The claim
 * CTA is only ever rendered while `canClaim` is true; once a correct attempt is
 * finalised the round answers `finalized` and the screen becomes read-only for
 * completion reporting, exactly like the RPC behind it.
 */
export interface Npc2Stage {
  /** A newly recorded claim can still become a result (in-time window open). */
  canClaim: boolean;
  /** The claim window passed while the phase still accepts a record: the row
   *  is kept as an informational LATE attempt and can never win (§11 C). */
  lateOnly: boolean;
  /** Why the CTA is gone, in the operator's own words; null while it may show. */
  claimRefusal: string | null;
  /** A validated in-time claim sealed the official result — immutable now. */
  finalized: boolean;
  /** The official elapsed time once finalised, null before that. */
  officialMs: number | null;
  /** In-time claims still awaiting NPC2's decision. */
  pendingCount: number;
}

export function resolveNpc2Stage(snap: Snapshot, nowMs: number): Npc2Stage {
  const round = snap.active_round;
  const attempts = snap.attempts ?? [];
  if (!round) {
    return { canClaim: false, lateOnly: false, claimRefusal: 'Chưa có lượt chơi nào được ghi nhận.', finalized: false, officialMs: null, pendingCount: 0 };
  }
  const limit = roundLimitMs(round, snap.event.config.game_limit_ms);
  const live = liveStatus(round, attempts, limit, nowMs);
  const result = resultOf(round, attempts, limit, nowMs);
  const verdict = authorize('ROOM305', 'CLAIM_COMPLETE', live, result, round);
  const expired = gameRemainingMs(round, limit, nowMs) <= 0;
  const finalized = result === 'WON';
  let claimRefusal: string | null = null;
  if (!verdict.allowed) {
    claimRefusal = finalized
      ? 'Lượt chơi đã chốt kết quả — không ghi nhận thêm báo hoàn thành.'
      : round.aborted_at !== null
        ? 'Lượt chơi đã bị hủy — không ghi nhận thêm báo hoàn thành.'
        : 'Giai đoạn hiện tại không ghi nhận báo hoàn thành.';
  }
  return {
    canClaim: verdict.allowed,
    lateOnly: verdict.allowed && expired,
    claimRefusal,
    finalized,
    officialMs: finalized ? round.official_duration_ms : null,
    pendingCount: pendingEligibleClaims(round, attempts, limit, nowMs).length,
  };
}

/* ---------------------------------------------------------------- sync state */

/**
 * V3.4 §8 — five honest claims, kept apart because they are genuinely different
 * facts: the transport is up and the data is fresh (`connected`), a refresh is
 * running but the last authoritative read is still current (`current`), the
 * phone is waiting for its first read (`syncing`), the link is recovering
 * (`reconnecting`), or the server cannot be reached at all (`failed`).
 * Nothing here is driven by a frontend timer that could fake a healthy state:
 * `current` requires a real verified read inside the verify window, and only
 * the store's own failures can ever move the chip to `failed`.
 */
type SyncKey = 'connected' | 'current' | 'syncing' | 'reconnecting' | 'failed';

interface SyncState {
  key: SyncKey;
  label: string;
  /** True when the surface must offer a manual retry next to the chip. */
  showRetry: boolean;
}

export function resolveSyncState(
  status: string,
  facts: { dataAgeMs?: number | null; verifyMs?: number; degradedMs?: number } = {},
): SyncState {
  const verifyMs = facts.verifyMs ?? VERIFY_INTERVAL_MS;
  const degradedMs = facts.degradedMs ?? DEGRADED_AFTER_MS;
  const age = facts.dataAgeMs ?? null;
  const neverRead = age === null;
  const fresh = age !== null && age <= verifyMs * 1.5;
  const stale = age !== null && age > degradedMs;
  const label = (key: SyncKey): SyncState => ({ key, label: SYNC_STATE_LABEL[key], showRetry: key === 'failed' || key === 'reconnecting' });
  if (status === 'OFFLINE') return label('failed');
  if (status === 'DEGRADED') return neverRead || stale ? label('failed') : label('reconnecting');
  if (status === 'SYNCING') {
    // No verified read has ever landed: the honest word is "syncing", not a
    // recovery of something that never connected.
    if (neverRead) return label('syncing');
    // A transient refresh with still-current data must not read as syncing
    // forever — this is the exact case that left a finalised round wearing
    // ĐANG ĐỒNG BỘ on every phone.
    if (fresh) return label('current');
    return stale ? label('reconnecting') : label('syncing');
  }
  // CONNECTED: the store only claims it after a successful authoritative read,
  // but time may have passed since — a long-quiet read is reconnecting, not live.
  return neverRead || stale ? label('reconnecting') : label('connected');
}

/* --------------------------------------------------------------- big screen */

interface BigScreenClock {
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

type JourneyMovement = 'idle' | 'up' | 'at' | 'down';
/** done = ✓ red, lead = ring (the area being walked into), here = solid, todo = grey. */
type JourneyState = 'done' | 'lead' | 'here' | 'todo';

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
  /**
   * V3.4: a logged exception fell on this stop, so the route here is not the
   * normal one — today that is only the floor-2 bypass NPC 1 may record. The
   * stepper shows it as an attention state instead of a clean tick, because a
   * skipped stage that reads as a completed one is a lie about the floor.
   */
  attention: boolean;
}

interface JourneyTask {
  key: ResetTaskKey;
  label: string;
  role: Role;
  done: boolean;
}

interface JourneyTurn {
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
            : { roles: ['CORRIDOR'], label: 'XÁC NHẬN ĐỘI ĐÃ ĐẾN TẦNG 2' };
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
          caption = 'Đang reset khu vực';
          // The rail says what each station's own button says; with two owners still
          // outstanding it names the areas instead of one station's wording.
          turn = {
            roles: Array.from(new Set(open.map((t) => t.required_role))),
            label: `XÁC NHẬN ĐÃ RESET ${resetTasksSentence(open.map((t) => t.task_key)).toUpperCase()}`,
          };
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
      // The one exception the route itself can carry: floor 2 was skipped, and the
      // bypass is on the record rather than in the timestamps.
      attention: def.key === 'floor2' && round?.floor2_bypassed_at != null,
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

/* ------------------------------------------------------------------ handoff */

/**
 * The five honest states of the floor-2 handoff, derived only from the
 * server-recorded timestamps. The badge never claims an arrival the database
 * has not confirmed, and it never claims a confirmation a bypass has replaced.
 */
type HandoffKey = 'none' | 'incoming' | 'confirmed' | 'bypassed' | 'waiting-next';

export interface HandoffInfo {
  key: HandoffKey;
  /** Short chip text: what the handoff is right now. */
  badge: string;
  tone: TeamTone;
  /** The next required action, in one sentence, from the same server facts. */
  requirement: string;
}

export function resolveHandoff(snap: Snapshot, nowMs: number): HandoffInfo {
  const round = snap.active_round;
  const phase = phaseOf(snap, nowMs);
  if (!round) {
    return {
      key: 'none',
      badge: 'CHƯA CÓ ĐỘI ĐƯỢC BÀN GIAO',
      tone: 'mute',
      requirement: phase === 'ENDED'
        ? 'Sự kiện đã kết thúc — chờ Quản trị viên mở sự kiện mới'
        : 'Chờ Nhân sự 01 nhận đội ở sảnh tầng 1',
    };
  }
  // The bypass is its own audited fact: it is never rendered as a floor-2
  // confirmation, and it closes this station's task for the round.
  if (round.floor2_bypassed_at !== null) {
    return {
      key: 'bypassed',
      badge: 'TẦNG 2 ĐÃ BỎ QUA (NPC 1)',
      tone: 'amber',
      requirement: 'Không cần thao tác ở tầng 2 — lượt bỏ qua có ghi nhật ký',
    };
  }
  if (round.floor2_confirmed_at !== null) {
    return {
      key: 'confirmed',
      badge: `ĐÃ XÁC NHẬN · ${formatWallTime(round.floor2_confirmed_at)}`,
      tone: 'green',
      requirement: phase === 'READY_AT_FLOOR3'
        ? 'Đang chờ bước tiếp theo — NPC 1 bấm BẮT ĐẦU ở cửa tầng 3'
        : 'Đội đã được Nhân sự 02 xác nhận tại tầng 2',
    };
  }
  if (phase === 'WAITING_FLOOR2_CONFIRMATION') {
    return {
      key: 'incoming',
      badge: 'ĐỘI ĐANG LÊN TẦNG 2',
      tone: 'amber',
      requirement: 'Xác nhận khi đội đã có mặt tại tầng 2',
    };
  }
  // Past the handover window without either stamp (historic rows only): say
  // what is verifiable — the flow is waiting for its next server-recorded step.
  return {
    key: 'waiting-next',
    badge: 'ĐANG CHỜ BƯỚC TIẾP THEO',
    tone: 'blue',
    requirement: 'Đồng hồ và các bước sau đều do NPC 1 kiểm soát',
  };
}

/* ------------------------------------------------------------------ team line */

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

export function pad(n: number): string {
  return String(n).padStart(3, '0');
}

/** MM:SS.hh — the same formatting the authoritative messages use. */
function formatClockCs(ms: number): string {
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
function pendingTasks(snap: Snapshot, role?: Role) {
  const round = snap.active_round;
  if (!round) return [];
  return snap.reset_tasks.filter(
    (t) => t.round_id === round.id && (t.completed_at === null || t.cycle !== round.reset_cycle) && (!role || t.required_role === role),
  );
}

/**
 * The areas this role owns that the server has confirmed in the round's current
 * reset cycle. Only these may be claimed as done on a phone: a mark from an
 * earlier cycle stays outstanding, exactly as `pendingTasks` treats it.
 */
function doneTasks(snap: Snapshot, role?: Role) {
  const round = snap.active_round;
  if (!round) return [];
  return snap.reset_tasks.filter(
    (t) =>
      t.round_id === round.id &&
      t.completed_at !== null &&
      t.cycle === round.reset_cycle &&
      (!role || t.required_role === role),
  );
}

/* -------------------------------------------------------------- station strip */

type StationState = 'active' | 'idle';

interface StationInfo {
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

interface ObserverBoard {
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

/* --------------------------------------------------- V3.4 operations command */

/**
 * V3.4 §1 — the Điều hành tab is the shift's command centre. It answers five
 * questions in one reading order — what is the event state, which team is
 * active (or which round closed last), which stage the workflow is in, which
 * role is blocked, and what to do next — and every answer comes from the
 * authoritative state, never from the most recent audit action. An ended event
 * gets a completed-event answer, not a fake active-round dashboard.
 */
type OpsEventState = 'NOT_STARTED' | 'LIVE' | 'ENDED';

export const OPS_EVENT_STATE_WORD: Record<OpsEventState, string> = {
  NOT_STARTED: 'CHƯA MỞ SỰ KIỆN',
  LIVE: 'SỰ KIỆN ĐANG DIỄN RA',
  ENDED: 'SỰ KIỆN ĐÃ KẾT THÚC',
};

/**
 * The one honest decomposition of `snap.rounds` for the header question
 * “what does this number mean?” (V3.4 §3). The array is every round the current
 * event has *recorded* — including the single open round, and including cancelled
 * ones, which are still recorded history. “Đã đóng” counts rounds whose flow
 * reached CLOSED; “đang diễn ra” is what is left open (at most one); “bị hủy” is a
 * property of a recorded round, stated as such, never a fourth bucket of the sum.
 */
interface RoundCounts {
  recorded: number;
  closed: number;
  active: number;
  aborted: number;
  sentence: string;
}

export function roundCounts(snap: Snapshot): RoundCounts {
  const recorded = snap.rounds.length;
  const closed = snap.rounds.filter((r) => flowStatus(r) === 'CLOSED').length;
  const aborted = snap.rounds.filter((r) => r.aborted_at !== null).length;
  const active = recorded - closed;
  let sentence = `${recorded} lượt đã ghi nhận · ${closed} đã đóng · ${active} đang diễn ra`;
  if (aborted > 0) sentence += ` · ${aborted} lượt bị hủy có kiểm toán`;
  return { recorded, closed, active, aborted, sentence };
}

/**
 * Seat presence for the operations board. It is deliberately NOT inferred from
 * the last-action timestamp: `sc.operator_states` marks an unheld seat with a
 * null display_name (0004), and that binding fact — not activity — is the only
 * thing allowed to claim a seat is held. The local demo backend has no
 * multi-device seat board at all, so the caller says `seatKnown: false` and the
 * card reads CHƯA XÁC MINH ĐƯỢC instead of guessing.
 */
type OpsSeatState = 'held' | 'free' | 'unknown';

export const OPS_SEAT_WORD: Record<OpsSeatState, string> = {
  held: 'GHẾ ĐANG CÓ MÁY TRỰC',
  free: 'GHẾ CÒN TRỐNG',
  unknown: 'CHƯA XÁC MINH ĐƯỢC GHẾ',
};

type OpsBadgeTone = 'confirmed' | 'live' | 'queued' | 'danger' | 'idle';

interface OpsRoleStatus {
  role: StationRole;
  person: string;
  area: string;
  seat: OpsSeatState;
  /** The team is physically with this position right now. */
  ownsRound: boolean;
  /** This position's own press is what moves the flow forward. */
  mustPress: boolean;
  /** Short workflow-state word for the card badge. */
  stateWord: string;
  badgeTone: OpsBadgeTone;
  /** What this position owes the current round, one sentence; null when silent. */
  duty: string | null;
  /** An operating problem this role is holding the floor on, in act-ready words. */
  issue: string | null;
  /** Secondary information only — never the card's headline. */
  lastText: string | null;
  lastAt: number | null;
}

export function resolveOpsRoles(
  snap: Snapshot,
  nowMs: number,
  opts: { seatKnown: boolean },
): OpsRoleStatus[] {
  const stations = resolveStations(snap, nowMs);
  const phase = phaseOf(snap, nowMs);
  const round = snap.active_round;
  const limit = roundLimitMs(round, snap.event.config.game_limit_ms);
  const stallMs = snap.event.config.stall_warn_ms ?? STALL_WARN_MS;
  return STATION_ORDER.map((role) => {
    const info = stations.find((s) => s.role === role);
    const op = snap.operators.find((o) => o.role === role);
    const seat: OpsSeatState = !opts.seatKnown || !op ? 'unknown' : op.display_name ? 'held' : 'free';
    const primary = resolvePrimary(role, snap, nowMs);
    const mustPress = primary.action !== null;
    const ownsRound = info?.state === 'active';

    let issue: string | null = null;
    if (phase !== 'ENDED' && round) {
      if (role === 'ROOM305') {
        const open = pendingEligibleClaims(round, snap.attempts ?? [], limit, nowMs).length;
        if (open > 0) issue = `Còn ${open} lần báo hoàn thành chờ xác minh`;
      }
      if (!issue && role === 'GATE') {
        const since = stallSince(round, nowMs, limit);
        if (since !== null && since > stallMs) {
          issue = `Đội vẫn ở trong khu vực ${Math.floor(since / 1000)}s — cần xác nhận đã rời tầng 3`;
        }
      }
      if (!issue && phase === 'EXIT_CONFIRMED') {
        const own = pendingTasks(snap, role);
        if (own.length > 0) {
          issue = `Còn phần reset chưa xác nhận: ${resetTasksSentence(own.map((t) => t.task_key))}`;
        }
      }
      if (!issue && role === 'CORRIDOR' && phase === 'WAITING_FLOOR2_CONFIRMATION' && round.floor2_bypassed_at === null) {
        const waitingMs = nowMs - round.called_at;
        if (waitingMs > stallMs) {
          issue = `Đội được nhận ${Math.floor(waitingMs / 1000)}s trước vẫn chưa được xác nhận ở tầng 2`;
        }
      }
    }

    const stateWord = phase === 'ENDED'
      ? 'SỰ KIỆN ĐÃ ĐÓNG'
      : mustPress
        ? 'ĐẾN LƯỢT BẤM'
        : ownsRound
          ? 'ĐANG GIỮ LƯỢT'
          : 'CHỜ ĐẾN LƯỢT';
    const badgeTone: OpsBadgeTone = phase === 'ENDED'
      ? 'idle'
      : mustPress
        ? 'live'
        : ownsRound
          ? 'confirmed'
          : 'queued';
    // The duty sentence only adds information when it is the position's own
    // live work or a concrete blockage. A shared event-level caption (every
    // phone reading “SỰ KIỆN ĐÃ KẾT THÚC” four times) is duplicate noise (§6).
    const duty = phase === 'ENDED' ? null : mustPress || issue ? primary.label : primary.hint ?? null;
    const lastText = op?.last_action
      ? (op.last_detail?.trim() || ACTION_LABEL[op.last_action] || 'Thao tác không rõ')
      : null;
    return {
      role,
      person: ROLE_PERSON[role],
      area: ROLE_AREA[role],
      seat,
      ownsRound,
      mustPress,
      stateWord,
      badgeTone,
      duty,
      issue,
      lastText,
      lastAt: op?.last_action_at ?? null,
    };
  });
}

interface OpsNextAction {
  /** Short Vietnamese person words, never a raw role key. */
  who: string;
  what: string;
}

interface OpsCommand {
  state: OpsEventState;
  stateWord: string;
  eventName: string;
  /** The workflow stage in the operator's vocabulary. */
  stageWord: string;
  /** Who the floor is busy with, or who is next in the queue. */
  teamText: string;
  /** Where that team physically is; null while the event is closed. */
  whereText: string | null;
  counts: RoundCounts;
  next: OpsNextAction | null;
  /** Roles holding the floor on an actionable problem, prefixed by their person. */
  attention: string[];
}

export function resolveOpsCommand(
  snap: Snapshot,
  nowMs: number,
  opts: { isSupervisor: boolean },
): OpsCommand {
  const state = statusOf(snap, nowMs) as OpsEventState;
  const phase = phaseOf(snap, nowMs);
  const round = snap.active_round;
  const counts = roundCounts(snap);
  const stageWord = PHASE_LABEL[phase] ?? PHASE_LABEL.WAITING_FOR_TEAM;
  const attention: string[] = [];
  let teamText: string;
  let whereText: string | null = null;
  let next: OpsNextAction | null = null;

  if (state === 'ENDED') {
    teamText = 'Không còn đội nào trong khu vực';
    // The honest completed-event answer: no fake active round, no fake next press.
    next = opts.isSupervisor
      ? { who: ROLE_PERSON.SUPERVISOR, what: 'Mở sự kiện mới ở nhóm QUẢN TRỊ khi ca sau sẵn sàng' }
      : null;
  } else if (round) {
    const journey = resolveJourney(snap, nowMs, 'SUPERVISOR');
    teamText = teamLabel(round, snap.event.next_team_number);
    whereText = journey.where;
    if (journey.turn) {
      next = { who: journey.turn.roles.map((r) => ROLE_PERSON[r]).join(' · '), what: journey.turn.label };
    }
    if (round.needs_review && round.review_reasons.length > 0) {
      attention.push(`${teamText}: kết quả chờ xét lại — chỉ ${ROLE_PERSON.SUPERVISOR} xử lý được`);
    }
  } else {
    const lobbyPrimary = resolvePrimary('LOBBY', snap, nowMs);
    teamText = `Đội tiếp theo #${pad(snap.event.next_team_number)} — chưa vào khu vực`;
    next = { who: ROLE_PERSON.LOBBY, what: lobbyPrimary.label };
  }
  if (state !== 'ENDED') {
    for (const r of resolveOpsRoles(snap, nowMs, { seatKnown: false })) {
      if (r.issue) attention.push(`${r.person}: ${r.issue}`);
    }
  }
  return {
    state,
    stateWord: OPS_EVENT_STATE_WORD[state],
    eventName: snap.event.config.event_name,
    stageWord,
    teamText,
    whereText,
    counts,
    next,
    attention,
  };
}

/**
 * V3.4 §4 — the hidden-object layout card. It mirrors the ONE server-side
 * permission (SET_LAYOUT: the owning floor-3 position or the supervisor) and
 * the ONE state-machine window the action is legal in (between teams, at the
 * gate, or while the area is being reset — never mid-round), so the card can
 * neither offer a press the RPC would refuse nor claim ownership it does not
 * have. A phone without the right reads a summary, not misleading controls.
 */
interface OpsLayoutView {
  current: HidingLayout;
  ownerPerson: string;
  ownerArea: string;
  /** The caller's role may press SET_LAYOUT at all (server table mirrored). */
  canAct: boolean;
  /** The workflow currently accepts a change; false mid-round and after ENDED. */
  phaseAllowsEdit: boolean;
  /** Why the control reads locked, in the operator's words; null while open. */
  lockedReason: string | null;
  /** The layout the round in play was dispatched with, when there is one. */
  liveRoundLayout: HidingLayout | null;
}

export function resolveOpsLayout(snap: Snapshot, role: Role, nowMs: number): OpsLayoutView {
  const owner = snap.event.config.hidden_object_owner;
  const canAct = role === 'SUPERVISOR' || role === owner;
  const phase = phaseOf(snap, nowMs);
  const inWindow = phaseAllows('SET_LAYOUT', flowOf(snap, nowMs));
  const phaseAllowsEdit = phase !== 'ENDED' && inWindow;
  const lockedReason = phase === 'ENDED'
    ? 'Sự kiện đã kết thúc — bố trí mới chỉ áp dụng sau khi mở sự kiện mới'
    : !inWindow
      ? 'Đang có lượt trên đồng hồ — chỉ đổi giữa hai lượt hoặc trong lúc reset khu vực'
      : null;
  return {
    current: snap.event.config.hiding_layout,
    ownerPerson: ROLE_PERSON[owner],
    ownerArea: ROLE_AREA[owner],
    canAct,
    phaseAllowsEdit,
    lockedReason,
    liveRoundLayout: snap.active_round ? snap.active_round.hiding_layout : null,
  };
}

export type { ResetTaskKey };
