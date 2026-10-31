import type { JourneyStopDef, ResetTaskKey, Role } from '../shared/constants';
import { JOURNEY_STOPS, RESET_TASK_LABEL, STALL_WARN_MS } from '../shared/constants';
import {
  deriveEventStatus,
  derivePhase,
  eventDeadline,
  eventRemainingMs,
  gameRemainingMs,
  isGamePaused,
  isGameRunning,
  isResetWindow,
  isTerminalRound,
  stallSince,
} from '../shared/machine';
import { formatClockSec, formatWallTime } from '../shared/metrics';
import type { ActionType, Round, Snapshot, SystemPhase } from '../shared/types';

export type Tone = 'primary' | 'danger' | 'warn' | 'waiting';

export interface PrimaryAction {
  action: ActionType | null;
  label: string;
  tone: Tone;
  hint: string | null;
  /** True when only a supervisor, with a typed reason, may proceed. */
  overrideOnly: boolean;
}

/**
 * The only number allowed on the main screen besides the 90:00 corner clock: the
 * 5-minute game countdown. `valueMs === null` means “show no number at all”, which
 * is what every non-playing phase does — one fixed timeline, one flexible window.
 */
export interface HeroClock {
  mode: 'GAME' | 'GAME_OVERTIME' | 'GAME_PAUSED' | 'IDLE';
  label: string;
  sublabel: string;
  /** Signed ms: the countdown goes negative into game overtime. */
  valueMs: number | null;
  tone: Tone;
}

export function activeRound(snap: Snapshot | null): Round | null {
  if (!snap) return null;
  return snap.active_round;
}

/**
 * Phase and status are pure functions of authoritative timestamps and "now", so
 * they are re-derived against the client's estimated server clock on every
 * render. A fetched snapshot can never leave the dashboard showing a phase that
 * time has already passed — while the official numbers stay untouched.
 */
export function phaseOf(snap: Snapshot, nowMs: number): SystemPhase {
  return derivePhase(snap.event, snap.active_round, nowMs);
}

export function statusOf(snap: Snapshot, nowMs: number): ReturnType<typeof deriveEventStatus> {
  return deriveEventStatus(snap.event, nowMs);
}

/* ------------------------------------------------------------- primary action */

export function resolvePrimary(role: Role, snap: Snapshot, nowMs: number): PrimaryAction {
  const phase = phaseOf(snap, nowMs);
  const round = activeRound(snap);
  const ev = snap.event;

  if (phase === 'PRE_EVENT') {
    // Nothing has burned the 90:00 yet: the first dispatch is the start button.
    if (role === 'LOBBY') {
      return {
        action: 'CALL_TEAM',
        label: 'CHO ĐỘI LÊN',
        tone: 'primary',
        hint: `Đồng hồ ${Math.round(ev.config.event_duration_ms / 60_000)}:00 chạy ngay khi đội đầu tiên lên`,
        overrideOnly: false,
      };
    }
    if (role === 'SUPERVISOR') {
      return { action: null, label: 'CHƯA CHẠY 90:00', tone: 'waiting', hint: 'LOBBY gọi đội đầu tiên để mở đồng hồ · cấu hình trong “Xem thêm”', overrideOnly: false };
    }
    return { action: null, label: 'CHỜ LOBBY GỌI ĐỘI', tone: 'waiting', hint: 'Khu vực sẵn sàng, đồng hồ chưa chạy', overrideOnly: false };
  }

  if (phase === 'ENDED') {
    return { action: null, label: 'SỰ KIỆN ĐÃ KẾT THÚC', tone: 'waiting', hint: 'Xem tổng kết trong “Xem thêm”', overrideOnly: false };
  }

  if (phase === 'READY') {
    const remaining = eventRemainingMs(ev, nowMs);
    const required = ev.config.game_limit_ms + ev.config.prep_allowance_ms;
    const cutoff = remaining !== null && remaining < required;
    if (role === 'LOBBY') {
      if (cutoff) {
        return {
          action: null,
          label: 'SẮP KẾT THÚC — KHÔNG NHẬN ĐỘI MỚI',
          tone: 'warn',
          hint: remaining <= 0 ? 'Đã hết thời gian sự kiện' : `Cần ${Math.ceil(required / 1000)}s, còn ${Math.ceil(remaining / 1000)}s`,
          overrideOnly: true,
        };
      }
      return {
        action: 'CALL_TEAM',
        label: 'CHO ĐỘI LÊN',
        tone: 'primary',
        hint: 'Đồng hồ 90:00 đang chạy · đội lên tầng ngay khi gọi',
        overrideOnly: false,
      };
    }
    if (role === 'SUPERVISOR') {
      if (cutoff) {
        // Exceptional admission belongs to the supervisor, with an audit reason.
        return {
          action: null,
          label: 'SẮP KẾT THÚC — KHÔNG NHẬN ĐỘI MỚI',
          tone: 'warn',
          hint: remaining <= 0 ? 'Đã hết thời gian sự kiện' : `Cần ${Math.ceil(required / 1000)}s, còn ${Math.ceil(remaining / 1000)}s`,
          overrideOnly: true,
        };
      }
      return { action: null, label: 'SẴN SÀNG — CHỜ LOBBY', tone: 'waiting', hint: 'Không cần thao tác trong trận bình thường', overrideOnly: false };
    }
    if (cutoff) {
      return {
        action: null,
        label: 'SẮP KẾT THÚC — KHÔNG NHẬN ĐỘI MỚI',
        tone: 'warn',
        hint: 'Chờ đội cuối cùng hoàn tất',
        overrideOnly: false,
      };
    }
    const hint = role === 'GATE' ? 'Chưa có đội nào được gọi' : 'Khu vực đã sẵn sàng';
    return { action: null, label: 'SẴN SÀNG NHẬN ĐỘI', tone: 'waiting', hint, overrideOnly: false };
  }

  if (!round) {
    return { action: null, label: 'CHỜ ĐỒNG BỘ…', tone: 'waiting', hint: null, overrideOnly: false };
  }

  /* ---------------------------------------------------------------- preparing */
  if (phase === 'PREPARING') {
    if (role === 'GATE') {
      const remaining = eventRemainingMs(ev, nowMs);
      if (remaining !== null && remaining < ev.config.game_limit_ms) {
        return {
          action: null,
          label: 'CÒN DƯỚI 5 PHÚT — CHỜ SUPERVISOR',
          tone: 'warn',
          hint: 'Chỉ SUPERVISOR mới được vào trận bằng ghi nhận kiểm toán',
          overrideOnly: true,
        };
      }
      return { action: 'START_GAME', label: 'BẮT ĐẦU', tone: 'primary', hint: 'Chốt đồng hồ chuẩn bị, chạy 05:00', overrideOnly: false };
    }
    if (role === 'LOBBY') {
      if (round.status === 'LOBBY_CALL') {
        return {
          action: 'TEAM_UPSTAIRS',
          label: 'ĐÃ LÊN TẦNG 3',
          tone: 'primary',
          hint: 'GATE bấm BẮT ĐẦU chạy 05:00 sau đó',
          overrideOnly: false,
        };
      }
      return { action: null, label: 'ĐỘI ĐANG Ở CỬA VÀO TẦNG 3', tone: 'waiting', hint: 'Chờ GATE bấm BẮT ĐẦU 05:00', overrideOnly: false };
    }
    if (role === 'SUPERVISOR') {
      return { action: null, label: 'ĐANG CHUẨN BỊ', tone: 'waiting', hint: null, overrideOnly: false };
    }
    if (role === 'CORRIDOR') {
      return { action: null, label: 'CHỜ ĐỘI VÀO HÀNH LANG', tone: 'waiting', hint: null, overrideOnly: false };
    }
    if (role === 'ROOM305') {
      return { action: null, label: 'CHỜ ĐỘI ĐẾN 305', tone: 'waiting', hint: null, overrideOnly: false };
    }
    return { action: null, label: 'ĐANG CHUẨN BỊ', tone: 'waiting', hint: null, overrideOnly: false };
  }

  /* ------------------------------------------------------------------ running */
  if (phase === 'RUNNING' || phase === 'GAME_OVERTIME') {
    const overtime = phase === 'GAME_OVERTIME';
    if (role === 'GATE') {
      return {
        action: 'GAME_STOP',
        label: 'KHÁCH ĐÃ RA — CHỐT GIỜ',
        tone: overtime ? 'danger' : 'primary',
        hint: overtime ? 'Quá giờ — đội vẫn được ra an toàn' : 'Nhấn khi người cuối cùng qua cửa',
        overrideOnly: false,
      };
    }
    if (role === 'CORRIDOR') {
      if (round.status === 'GAME_STARTED') {
        return { action: 'HALLWAY_PROGRESS', label: 'ĐÃ SETUP XONG', tone: 'primary', hint: 'Bắt đầu hóa trang & gây sợ', overrideOnly: false };
      }
      return { action: null, label: overtime ? 'QUÁ GIỜ — HƯỚNG DẪN ĐỘI RA' : 'ĐỘI ĐANG Ở 305', tone: overtime ? 'danger' : 'waiting', hint: null, overrideOnly: false };
    }
    if (role === 'ROOM305') {
      if (round.status === 'GAME_STARTED' || round.status === 'CORRIDOR_ACTIVE') {
        return { action: 'ROOM_REACHED', label: 'ĐÃ ĐẾN 305', tone: 'primary', hint: 'Đội đã trước cửa phòng', overrideOnly: false };
      }
      if (round.status === 'ROOM_REACHED') {
        return { action: 'PUZZLE_COMPLETE', label: 'XÁC NHẬN HOÀN THÀNH', tone: 'primary', hint: 'Đồng hồ VẪN chạy', overrideOnly: false };
      }
      if (round.status === 'PUZZLE_COMPLETED') {
        return { action: 'RETURN_START', label: 'ĐỘI RỜI PHÒNG 305', tone: 'primary', hint: 'Hướng dẫn đội quay lại cửa vào', overrideOnly: false };
      }
      return { action: null, label: overtime ? 'QUÁ GIỜ — CHO ĐỘI RA' : 'ĐỘI ĐANG QUAY LẠI', tone: overtime ? 'danger' : 'waiting', hint: null, overrideOnly: false };
    }
    if (role === 'LOBBY') {
      return { action: null, label: 'TRẬN ĐANG DIỄN RA', tone: 'waiting', hint: overtime ? 'Đội đang quá giờ' : null, overrideOnly: false };
    }
    return { action: null, label: overtime ? 'SỰ KIỆN QUA GIỜ' : 'TRẬN ĐANG DIỄN RA', tone: overtime ? 'danger' : 'waiting', hint: 'Chỉ can thiệp khi khẩn cấp', overrideOnly: false };
  }

  /* ----------------------------------------------------------------- resetting */
  if (phase === 'RESETTING' || phase === 'RESET_OVERTIME') {
    const pendingFor = (r: Role) => pendingTasks(snap, r);
    const missing = pendingTasks(snap);

    if (role === 'GATE') {
      const own = pendingFor('GATE');
      if (own.length > 0) {
        return { action: 'RESET_DONE', label: 'ĐÃ RESET XONG', tone: 'primary', hint: own.map((t) => RESET_TASK_LABEL[t.task_key]).join(' · '), overrideOnly: false };
      }
      if (missing.length === 0) {
        return { action: 'GATE_FINALIZE', label: 'XÁC NHẬN SẴN SÀNG', tone: 'primary', hint: 'Cửa vào & khu vực đã thông thoáng', overrideOnly: false };
      }
      return {
        action: null,
        label: 'CHỜ RESET HOÀN TẤT',
        tone: 'waiting',
        hint: `Còn: ${missing.map((m) => RESET_TASK_LABEL[m.task_key]).join(' · ')}`,
        overrideOnly: false,
      };
    }
    if (role === 'CORRIDOR' || role === 'ROOM305') {
      const own = pendingFor(role);
      if (own.length > 0) {
        return { action: 'RESET_DONE', label: 'ĐÃ RESET XONG', tone: 'primary', hint: own.map((t) => RESET_TASK_LABEL[t.task_key]).join(' · '), overrideOnly: false };
      }
      return { action: null, label: 'ĐÃ XONG PHẦN CỦA BẠN', tone: 'waiting', hint: 'Chờ GATE xác nhận', overrideOnly: false };
    }
    if (role === 'LOBBY') {
      return {
        action: null,
        label: 'ĐANG RESET KHU VỰC',
        tone: 'waiting',
        hint: missing.length === 0 ? 'Reset xong — chờ GATE chốt' : `Còn ${missing.length} tác vụ`,
        overrideOnly: false,
      };
    }
    return {
      action: null,
      label: 'ĐANG RESET',
      tone: 'waiting',
      hint: missing.length === 0 ? 'GATE có thể xác nhận' : `Còn: ${missing.map((m) => RESET_TASK_LABEL[m.task_key]).join(', ')}`,
      overrideOnly: false,
    };
  }

  /* an active round in a phase we do not map to a button: never guess */
  return { action: null, label: 'CHỜ ĐỒNG BỘ…', tone: 'waiting', hint: null, overrideOnly: false };
}

/* ------------------------------------------------------------------ hero clock */

/**
 * The main screen carries exactly two numbers: the fixed 90:00 timeline in the
 * corner and, while a team is on the clock, the flexible 5:00 window. Everything
 * else (prep, reset, idle) is a status line, never another stopwatch.
 */
export function resolveHero(snap: Snapshot, nowMs: number): HeroClock {
  const ev = snap.event;
  const round = activeRound(snap);
  const limit = ev.config.game_limit_ms;

  if (!round) {
    if (ev.event_ended_at !== null) {
      const teams = snap.rounds.filter((r) => r.game_stopped_at !== null).length;
      return { mode: 'IDLE', label: 'SỰ KIỆN KẾT THÚC', sublabel: `${teams} đội đã chơi`, valueMs: null, tone: 'waiting' };
    }
    if (ev.event_started_at === null) {
      return {
        mode: 'IDLE',
        label: 'CHƯA TÍNH GIỜ',
        sublabel: 'Đồng hồ 90:00 chỉ chạy khi LOBBY gọi đội lên',
        valueMs: null,
        tone: 'waiting',
      };
    }
    return {
      mode: 'IDLE',
      label: 'CHƯA TÍNH GIỜ',
      sublabel: `Đã hoàn thành ${snap.rounds.filter((r) => r.system_ready_at !== null).length} đội · #${pad(ev.next_team_number)} là đội tiếp theo`,
      valueMs: null,
      tone: 'waiting',
    };
  }

  if (round.status === 'LOBBY_CALL' || round.status === 'TEAM_PREPARING') {
    return {
      mode: 'IDLE',
      // The status line under TEAM #… already says where the team is; the hero
      // only adds what that line cannot: the 5:00 has not started.
      label: 'CHƯA TÍNH GIỜ',
      sublabel: `Đồng hồ ${formatClockSec(limit)} chưa chạy`,
      valueMs: null,
      tone: 'warn',
    };
  }

  if (round.game_started_at !== null && round.game_stopped_at === null) {
    const left = gameRemainingMs(round, limit, nowMs);
    const resetNote = round.game_reset_count > 0 ? ` · reset 5:00 lần ${round.game_reset_count}` : '';
    if (isGamePaused(round)) {
      return {
        mode: 'GAME_PAUSED',
        label: 'TẠM DỪNG 5:00',
        sublabel: `Đồng hồ trận đang dừng${resetNote} · 90:00 vẫn chạy`,
        valueMs: left,
        tone: 'warn',
      };
    }
    return {
      mode: left <= 0 ? 'GAME_OVERTIME' : 'GAME',
      label: left <= 0 ? 'QUÁ GIỜ' : 'THỜI GIAN CÒN LẠI',
      sublabel:
        left <= 0
          ? `Đã vượt ${formatClockSec(limit)}${resetNote} — đưa đội ra an toàn`
          : `Đội #${pad(round.team_number)} đang tìm trận đồ${resetNote}`,
      valueMs: left,
      tone: left <= 0 ? 'danger' : left <= 60_000 ? 'warn' : 'primary',
    };
  }

  if (isResetWindow(round)) {
    const missing = snap.reset_tasks.filter((t) => t.round_id === round.id && t.completed_at === null).length;
    return {
      mode: 'IDLE',
      label: 'CHƯA TÍNH GIỜ',
      sublabel: missing === 0 ? 'Khu vực đã xong · chờ GATE xác nhận' : `Đang setup · còn ${missing} tác vụ`,
      valueMs: null,
      tone: 'warn',
    };
  }

  return { mode: 'IDLE', label: 'ĐANG CHỜ', sublabel: 'Đang đồng bộ trạng thái…', valueMs: null, tone: 'waiting' };
}

/* --------------------------------------------------------------- big screen */

export interface BigScreenClock {
  /** Identifies the running game; changes on every reset of the 5:00 window. */
  key: string;
  teamNumber: number;
  /** The 5-minute game limit, never the 90-minute event duration. */
  limitMs: number;
  /** Signed ms: keeps counting into overtime so the display and the alarm agree. */
  remainingMs: number;
  expired: boolean;
  /** True while the authoritative clock is paused; the 90:00 keeps running. */
  paused: boolean;
  resetCount: number;
  pauseCount: number;
  eventRemainingMs: number | null;
}

/**
 * What the wall display shows: the official 5-minute countdown of the running
 * round, mirrored straight from the authoritative timestamps. It has no local
 * override — a reset on this screen is a real `GAME_RESET` command, so the number
 * here and the score can never disagree.
 */
export function resolveBigScreen(snap: Snapshot, nowMs: number): BigScreenClock | null {
  const round = activeRound(snap);
  if (!round || round.game_started_at === null || !isGameRunning(round)) return null;
  const limitMs = snap.event.config.game_limit_ms;
  const remainingMs = gameRemainingMs(round, limitMs, nowMs);
  return {
    key: `${round.id}:${round.game_started_at}:${round.game_reset_count}`,
    teamNumber: round.team_number,
    limitMs,
    remainingMs,
    expired: remainingMs <= 0,
    paused: isGamePaused(round),
    resetCount: round.game_reset_count,
    pauseCount: round.game_pause_count,
    eventRemainingMs: eventRemainingMs(snap.event, nowMs),
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
  /** Printed under the node: [“SẢNH”, “TẦNG 1”], [“CỬA VÀO”]… */
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
  /** Station(s) whose next press moves the team forward. */
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
  /** Where the team is, in words: “CỬA VÀO · TẦNG 3”, “ĐANG LÊN TẦNG 3”… */
  where: string;
  turn: JourneyTurn | null;
  /** One line, identical on all five phones. */
  caption: string;
  tasks: JourneyTask[];
}

/** Timestamp of the last logged press of `action` on this round, if still in the log. */
function logAt(snap: Snapshot, roundId: string, action: ActionType): number | null {
  for (let i = snap.log.length - 1; i >= 0; i -= 1) {
    const entry = snap.log[i];
    if (entry.round_id === roundId && entry.action === action) return entry.at_ms;
  }
  return null;
}

/**
 * The team's walk through the venue, derived only from authoritative timestamps:
 * Sảnh tầng 1 → Cửa vào tầng 3 → Hành lang → Phòng 305 → Kết thúc cuộc chơi.
 * Every station reads the same position, so nobody has to reconstruct the route
 * from a status label.
 */
export function resolveJourney(snap: Snapshot, nowMs: number, role: Role): JourneyInfo {
  const round = activeRound(snap);
  const phase = phaseOf(snap, nowMs);
  const limit = snap.event.config.game_limit_ms;
  const at: (number | null)[] = [null, null, null, null, null];
  const notes: (string | null)[] = [null, null, null, null, null];
  let position = 0;
  let movement: JourneyMovement = 'idle';
  let where = 'SẢNH TẦNG 1';
  let caption = 'Chưa mở sự kiện';
  let turn: { roles: Role[]; label: string } | null = null;

  if (round) {
    at[0] = round.called_at;
    at[1] = round.game_started_at;
    // The round's own timestamps are authoritative; the log fills in the legs that
    // have no column of their own, and a later press proves the earlier legs.
    at[3] = logAt(snap, round.id, 'ROOM_REACHED') ?? round.puzzle_completed_at;
    at[2] = logAt(snap, round.id, 'HALLWAY_PROGRESS') ?? at[3];
    notes[0] = 'Đã gọi đội — mở đồng hồ 90:00';
    position = 0;

    switch (round.status) {
      case 'LOBBY_CALL':
        movement = 'up';
        where = 'ĐANG LÊN TẦNG 3';
        caption = 'Đội đang lên tầng 3';
        turn = { roles: ['LOBBY'], label: 'ĐÃ LÊN TẦNG 3' };
        break;
      case 'TEAM_PREPARING':
        position = 1;
        movement = 'at';
        where = 'CỬA VÀO · TẦNG 3';
        notes[1] = 'Đội đã tới cửa vào — chờ bấm 05:00';
        caption = 'Đội đã lên tới cửa vào tầng 3';
        turn = { roles: ['GATE'], label: 'BẮT ĐẦU' };
        break;
      case 'GAME_STARTED':
        position = 1;
        movement = 'at';
        where = 'CỬA VÀO · TẦNG 3';
        notes[1] = '05:00 đang chạy';
        caption = 'Đội đang ở cửa vào';
        turn = { roles: ['CORRIDOR'], label: 'ĐÃ SETUP XONG' };
        break;
      case 'CORRIDOR_ACTIVE':
        position = 2;
        movement = 'at';
        where = 'HÀNH LANG · TẦNG 3';
        notes[2] = 'Đội đang trong hành lang';
        caption = 'Đội đang ở hành lang';
        turn = { roles: ['ROOM305'], label: 'ĐÃ ĐẾN 305' };
        break;
      case 'ROOM_REACHED':
        position = 3;
        movement = 'at';
        where = 'PHÒNG 305 · TẦNG 3';
        notes[3] = 'Đội đã vào phòng 305';
        caption = 'Đội đang ở phòng 305';
        turn = { roles: ['ROOM305'], label: 'XÁC NHẬN HOÀN THÀNH' };
        break;
      case 'PUZZLE_COMPLETED':
        position = 3;
        movement = 'at';
        where = 'PHÒNG 305 · TẦNG 3';
        notes[3] = `Trận đồ xong · ${formatWallTime(round.puzzle_completed_at ?? nowMs)}`;
        caption = 'Trận đồ đã hoàn thành · đồng hồ vẫn chạy';
        turn = { roles: ['ROOM305'], label: 'ĐỘI RỜI PHÒNG 305' };
        break;
      case 'RETURNING':
        position = 2;
        movement = 'down';
        where = 'ĐANG VỀ CỬA VÀO';
        notes[2] = 'Đội đang đi ngược ra cửa vào';
        notes[3] = `Trận đồ xong · ${formatWallTime(round.puzzle_completed_at ?? nowMs)}`;
        caption = 'Đội đang quay lại cửa vào tầng 3';
        turn = { roles: ['GATE'], label: 'KHÁCH ĐÃ RA — CHỐT GIỜ' };
        break;
      default: {
        // GATE stopped the clock (or the supervisor aborted): the team is back at
        // the third-floor entrance and the area is being reset for the next team.
        position = 1;
        movement = 'at';
        where = 'CỬA VÀO · TẦNG 3';
        notes[1] = round.game_stopped_at ? `Khách đã ra · ${formatWallTime(round.game_stopped_at)}` : 'Đang reset khu vực';
        if (round.puzzle_completed_at !== null) notes[3] = `Trận đồ xong · ${formatWallTime(round.puzzle_completed_at)}`;
        const open = pendingTasks(snap);
        if (open.length > 0) {
          caption = 'Đang setup khu vực';
          turn = { roles: Array.from(new Set(open.map((t) => t.required_role))), label: 'ĐÃ RESET XONG' };
        } else {
          caption = 'Đã setup xong · chờ GATE chốt';
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
    // Between rounds the route starts again at the lobby, which is what makes the
    // first press of every team the same, predictable one.
    position = 0;
    const remaining = eventRemainingMs(snap.event, nowMs);
    const cutoff = remaining !== null && remaining < snap.event.config.game_limit_ms + snap.event.config.prep_allowance_ms;
    if (phase === 'PRE_EVENT') {
      caption = 'Chưa mở sự kiện — LOBBY gọi đội đầu tiên';
      turn = { roles: ['LOBBY'], label: 'CHO ĐỘI LÊN' };
    } else if (cutoff) {
      caption = 'Sắp kết thúc — không nhận đội mới';
      turn = { roles: ['SUPERVISOR'], label: 'XEM NGOẠI LỆ VÀO ĐỘI' };
    } else {
      caption = `Sẵn sàng gọi đội #${pad(snap.event.next_team_number)}`;
      turn = { roles: ['LOBBY'], label: 'CHO ĐỘI LÊN' };
    }
  }

  // The reset checklist only matters once the team is out; mid-round it is noise.
  const tasks: JourneyTask[] =
    round && round.game_stopped_at !== null
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
  // on “KẾT THÚC” once the clock is stopped and the round only needs closing.
  const focus =
    position < 0
      ? -1
      : round && round.game_stopped_at !== null
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
  const round = activeRound(snap);
  const phase = phaseOf(snap, nowMs);
  if (!round) {
    if (phase === 'ENDED') return { text: 'Sự kiện đã kết thúc', tone: 'mute' };
    if (phase === 'PRE_EVENT') return { text: 'Chờ mở sự kiện', tone: 'mute' };
    return { text: 'Chờ gọi đội', tone: 'mute' };
  }
  switch (round.status) {
    case 'LOBBY_CALL':
      return { text: 'Đang lên tầng', tone: 'amber' };
    case 'TEAM_PREPARING':
      return { text: 'Đang ở cửa vào', tone: 'amber' };
    case 'GAME_STARTED':
      return { text: 'Đang chơi', tone: 'green' };
    case 'CORRIDOR_ACTIVE':
      return { text: 'Đang chơi', tone: 'green' };
    case 'ROOM_REACHED':
      return { text: 'Đang ở phòng 305', tone: 'violet' };
    case 'PUZZLE_COMPLETED':
      return { text: 'Đã hoàn thành trận đồ', tone: 'violet' };
    case 'RETURNING':
      return { text: 'Đang quay lại', tone: 'amber' };
    default:
      return { text: round.game_stopped_at !== null ? 'Đang setup lại' : 'Đang xử lý', tone: 'amber' };
  }
}

export function isAreaReady(snap: Snapshot | null, nowMs: number): boolean {
  if (!snap) return false;
  return phaseOf(snap, nowMs) === 'READY';
}

export function hasActiveRound(snap: Snapshot | null): boolean {
  return !!snap && !isTerminalRound(snap.active_round);
}

export function eventDeadlineMs(snap: Snapshot): number | null {
  return eventDeadline(snap.event);
}

export function pad(n: number): string {
  return String(n).padStart(3, '0');
}

/* ------------------------------------------------------ must-not-be-hidden-by */

export interface AlertInfo {
  id: 'STALL' | 'REVIEW' | 'OVERTIME' | 'DEGRADED' | 'AUDIO' | 'PAUSE' | 'RESET';
  tone: Tone;
  text: string;
}

/**
 * Scenario B / P0-05 / P0-02: safety- and prize-critical notices are surfaced on
 * the main screen, never only inside “Xem thêm”. Warnings only — nothing here
 * stops a clock or changes a state by itself.
 */
export function resolveAlerts(snap: Snapshot, nowMs: number, staleData: boolean): AlertInfo[] {
  const out: AlertInfo[] = [];
  const round = snap.active_round;
  const stallMs = snap.event.config.stall_warn_ms ?? STALL_WARN_MS;
  const since = stallSince(round, nowMs);
  if (round && since !== null && since > stallMs) {
    out.push({
      id: 'STALL',
      tone: 'warn',
      text: `Đội #${pad(round.team_number)} rời 305 được ${Math.floor(since / 1000)}s — GATE chưa chốt giờ`,
    });
  }
  if (round && round.needs_review && round.review_reasons.length > 0) {
    out.push({ id: 'REVIEW', tone: 'warn', text: `Kết quả đội #${pad(round.team_number)} chờ xét lại` });
  }
  // A paused or restarted 5:00 is never silent: the whole room reads it here, and
  // the 90:00 beside it keeps counting down the fixed timeline.
  if (round && isGamePaused(round)) {
    out.push({ id: 'PAUSE', tone: 'warn', text: `5:00 đội #${pad(round.team_number)} đang TẠM DỪNG — 90:00 vẫn chạy` });
  } else if (round && round.game_reset_count > 0 && round.game_stopped_at === null) {
    out.push({ id: 'RESET', tone: 'warn', text: `5:00 đã RESET ${round.game_reset_count} lần — kết quả sẽ chờ SUPERVISOR xét` });
  }
  const phase = phaseOf(snap, nowMs);
  if (phase === 'GAME_OVERTIME' || phase === 'RESET_OVERTIME') {
    out.push({ id: 'OVERTIME', tone: 'danger', text: 'Sự kiện qua giờ — cho đội cuối ra an toàn' });
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

/* -------------------------------------------------------------- station relay */

export type StationState = 'active' | 'idle';

export interface StationInfo {
  role: Role;
  /** Short station name for the five-chip strip. */
  label: string;
  /** The leg of the relay this station owns right now — exactly the green chips. */
  state: StationState;
  /** This operator has a tappable action: the pulsing handoff ring. */
  turn: boolean;
}

const STATION_ORDER: Role[] = ['LOBBY', 'GATE', 'CORRIDOR', 'ROOM305', 'SUPERVISOR'];

const STATION_LABEL: Record<Role, string> = {
  LOBBY: 'LOBBY',
  GATE: 'NPC 1',
  CORRIDOR: 'NPC 2',
  ROOM305: 'NPC 3',
  SUPERVISOR: 'GIÁM SÁT',
};

/**
 * Which stations own the current leg of the relay. The green chip is the station
 * the team is with, not the station that presses next: LOBBY stays lit while the
 * team walks up, and GATE lights up only once its 5:00 clock owns the round.
 * Reset is the one parallel window, so several stations light at the same time.
 */
function owningStations(snap: Snapshot, nowMs: number): Set<Role> {
  const phase = phaseOf(snap, nowMs);
  // The first dispatch is LOBBY's call — it is the station that opens the 90:00.
  if (phase === 'PRE_EVENT') return new Set<Role>(['LOBBY']);
  if (phase === 'ENDED') return new Set<Role>();

  const round = activeRound(snap);
  if (!round) {
    const last = snap.rounds.at(-1);
    // An aborted round the area has not cleared yet still belongs to the supervisor.
    if (last && last.status === 'ABORTED' && last.system_ready_at === null) return new Set<Role>(['SUPERVISOR']);
    return new Set<Role>(['LOBBY']);
  }

  switch (round.status) {
    case 'LOBBY_CALL':
    case 'TEAM_PREPARING':
      return new Set<Role>(['LOBBY']);
    case 'GAME_STARTED':
      return new Set<Role>(['GATE']);
    case 'CORRIDOR_ACTIVE':
      return new Set<Role>(['CORRIDOR']);
    case 'ROOM_REACHED':
    case 'PUZZLE_COMPLETED':
    case 'RETURNING':
      return new Set<Role>(['ROOM305']);
    case 'GAME_EXITED':
    case 'RESETTING':
    case 'RESET_CONFIRMED': {
      // Reset runs in parallel: every station with an outstanding task stays lit.
      const pending = new Set<Role>(pendingTasks(snap).map((t) => t.required_role));
      return pending.size > 0 ? pending : new Set<Role>(['GATE']);
    }
    default:
      return new Set<Role>(['LOBBY']);
  }
}

/** Five-station handoff strip: who owns the round now, and who must press next. */
export function resolveStations(snap: Snapshot, nowMs: number): StationInfo[] {
  const owners = owningStations(snap, nowMs);
  return STATION_ORDER.map((role) => ({
    role,
    label: STATION_LABEL[role],
    state: owners.has(role) ? 'active' : 'idle',
    turn: resolvePrimary(role, snap, nowMs).action !== null,
  }));
}

export type { ResetTaskKey };
