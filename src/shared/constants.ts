/** Protected operational defaults. All values are milliseconds unless noted. */

/**
 * The six access identities of one session.
 *
 * V3 collapses the old five-station relay into one authoritative flow, but keeps
 * the stored identifiers so history and existing bindings stay readable:
 *
 *   LOBBY     → OPERATOR_01 (tầng 1): receives the team, sends it to floor 2
 *   CORRIDOR  → OPERATOR_02 (tầng 2): confirms physical arrival, nothing else
 *   GATE      → NPC1 / FLOOR3_GATE: briefing, START, bypass, exit, emergency
 *   ROOM305   → NPC2 / PUZZLE_CHECKER: completion claims and verification
 *   SUPERVISOR: retained admin (disputes, corrections, resets) — never a station
 *   OBSERVER: open read-only viewing, no password, capped concurrency
 *
 * CORRIDOR intentionally owns no progression step any more, and GATE is no longer
 * the floor-2 operator: the game gatekeeper sits at the entrance to floor 3.
 */
export const ROLES = ['LOBBY', 'CORRIDOR', 'GATE', 'ROOM305', 'SUPERVISOR', 'OBSERVER'] as const;

/** The four positions that act on the game, in walking order. */
export const STATION_ROLES = ['LOBBY', 'CORRIDOR', 'GATE', 'ROOM305'] as const;

/** Everything that can hold an operator binding, including the retained admin. */
export const OPERATOR_ROLES = [...STATION_ROLES, 'SUPERVISOR'] as const;

/** What the picker offers: four stations plus the open observer seat. */
export const BOARD_ROLES = [...STATION_ROLES, 'OBSERVER'] as const;

/**
 * @deprecated History only. The session length column stays readable for old rows,
 * but no countdown, no admission rule and no warning uses it any more (V3.1 §7.1).
 */
export const EVENT_DURATION_MS = 90 * 60_000;

/**
 * The one authoritative countdown belongs to the round and is configurable.
 * `DEFAULT_ROUND_DURATION_MS` is only what a fresh event starts with; SUPERVISOR may
 * change it, and every round stores the duration it was actually started with.
 */
export const DEFAULT_ROUND_DURATION_MS = 5 * 60_000;
/** Valid configuration range for one round: 00:01 … 59:59 (V3.1 §7.3). */
export const ROUND_DURATION_MIN_MS = 1_000;
export const ROUND_DURATION_MAX_MS = 59 * 60_000 + 59_000;
/** @deprecated kept as the historical 05:00 name for tests and old comments. */
export const GAME_LIMIT_MS = DEFAULT_ROUND_DURATION_MS;
export const PREP_ALLOWANCE_MS = 90_000;

/** Observers are anonymous viewers, so their capacity is a presence property. */
export const OBSERVER_CAPACITY = 10;
/** A viewer proves it is still watching this often; the seat is freed after two misses. */
export const OBSERVER_HEARTBEAT_MS = 15_000;
export const OBSERVER_TTL_MS = 45_000;

/** The big wall display switches to its pre-expiry alarm look this late in the 5-minute game. */
export const BIG_SCREEN_WARN_MS = 60_000;

export const RESET_TARGET_MS = 90_000;

/** Close finishes and slow presses are flagged for supervisor review (P0-05). */
export const REVIEW_THRESHOLD_MS = 500;
/** Non-intrusive warning when a team is inside the exit workflow too long. */
export const STALL_WARN_MS = 60_000;

export const LAYOUTS = ['A', 'B', 'C'] as const;
export type HidingLayout = (typeof LAYOUTS)[number];

/** Optional team label. The database enforces the same limit (migration 0013). */
export const TEAM_NAME_MAX = 40;

/** Client clock freshness bounds (P0-02). */
export const VERIFY_INTERVAL_MS = 10_000;
export const DEGRADED_AFTER_MS = 22_000;

/** Reset tasks that must be confirmed before NPC1 may declare the area ready. */
export const RESET_TASKS = ['hidden_objects', 'hallway', 'room'] as const;

/** Why an access sweep of the board is refused while the floor is not idle (V3.1 §6.2). */
export const RESET_BLOCK_REASONS = ['RUNNING', 'PENDING_CLAIM', 'RESET_OPEN'] as const;
export type ResetBlockReason = (typeof RESET_BLOCK_REASONS)[number];

/** The three reasons a round can be cancelled; only one of them disqualifies (V3.1 §4.4). */
export const ABORT_KINDS = ['technical', 'safety', 'misconduct'] as const;
export type AbortKind = (typeof ABORT_KINDS)[number];
export const ABORT_KIND_LABEL: Record<AbortKind, string> = {
  technical: 'Sự cố kỹ thuật',
  safety: 'An toàn · y tế',
  misconduct: 'Kỷ luật · vi phạm luật chơi',
};

/**
 * V3.2: the four operating positions are password-free by design. Opening the
 * link and tapping a free seat is the whole joining ritual; the only server-side
 * gate left is the supervisor allow-list, which lives in PostgreSQL and never in
 * this bundle. The old crew-code constants are gone.
 */

export type Role = (typeof ROLES)[number];
export type StationRole = (typeof STATION_ROLES)[number];
export type ResetTaskKey = (typeof RESET_TASKS)[number];
/** The two floor-3 positions can own the hidden props; corridor no longer can. */
export type HiddenObjectOwner = Extract<Role, 'GATE' | 'ROOM305'>;

/**
 * The names the floor actually reads. §III of the brief pairs every identifier with a
 * Vietnamese display name, so "LOBBY" and "OPERATOR" stay in the wire format and never
 * appear on a phone: the crew are Nhân sự 01/02, the scare actors are NPC 1/NPC 2.
 */
export const ROLE_LABEL: Record<Role, string> = {
  LOBBY: 'NHÂN SỰ 01 · TẦNG 1',
  CORRIDOR: 'NHÂN SỰ 02 · TẦNG 2',
  GATE: 'NPC 1 · CỬA TẦNG 3',
  ROOM305: 'NPC 2 · PHÒNG 305',
  SUPERVISOR: 'QUẢN TRỊ VIÊN',
  OBSERVER: 'NGƯỜI THEO DÕI',
};

/** Short station codes, for the journey strip where every column is ~80 px wide. */
export const ROLE_SHORT: Record<Role, string> = {
  LOBBY: '01',
  CORRIDOR: '02',
  GATE: 'NPC 1',
  ROOM305: 'NPC 2',
  SUPERVISOR: 'TRỊ',
  OBSERVER: 'XEM',
};

/** How each position is described to its own operator. */
export const ROLE_DUTY: Record<Role, string> = {
  LOBBY: 'Nhận đội và cho lên tầng 2',
  CORRIDOR: 'Xác nhận đội đã đến tầng 2',
  GATE: 'Phổ biến, bắt đầu lượt chơi, xác nhận đội rời tầng 3',
  ROOM305: 'Ghi nhận báo hoàn thành và kiểm tra trận đồ',
  SUPERVISOR: 'Theo dõi và xử lý ngoại lệ',
  OBSERVER: 'Chỉ xem',
};

/**
 * V3.4 — the two halves of a station's identity, for the role band on the
 * operator screen. `ROLE_LABEL` stays the single canonical sentence (audit,
 * seat list, handoff notes all print it); the band needs the person and the
 * place on separate lines, at different sizes, so it reads as
 * "NHÂN SỰ 01 — SẢNH TẦNG 1" at a glance instead of as one long caption.
 */
export const ROLE_PERSON: Record<Role, string> = {
  LOBBY: 'NHÂN SỰ 01',
  CORRIDOR: 'NHÂN SỰ 02',
  GATE: 'NPC 1',
  ROOM305: 'NPC 2',
  SUPERVISOR: 'QUẢN TRỊ VIÊN',
  OBSERVER: 'NGƯỜI THEO DÕI',
};

/** Where that person physically stands. Matches the journey stops, not the enum. */
export const ROLE_AREA: Record<Role, string> = {
  LOBBY: 'SẢNH TẦNG 1',
  CORRIDOR: 'TẦNG 2',
  GATE: 'CỬA VÀO · TẦNG 3',
  ROOM305: 'PHÒNG 305',
  SUPERVISOR: 'TOÀN BỘ KHU VỰC',
  OBSERVER: 'KHÔNG GIỮ VỊ TRÍ',
};

/**
 * The word under each stepper node's shape. The node already carries the state as
 * a silhouette; this is the sentence that makes it unambiguous for anyone reading
 * the route for the first time.
 */
export const STOP_STATE_LABEL: Record<string, string> = {
  done: 'ĐÃ QUA',
  here: 'ĐANG Ở ĐÂY',
  lead: 'ĐANG TỚI',
  todo: 'CHƯA TỚI',
  locked: 'CHƯA MỞ',
  attention: 'CÓ NGOẠI LỆ',
} as const;

/**
 * The physical route of one team, in walking order: the ground-floor lobby, the
 * second-floor handover, then the two positions on the third floor. The journey
 * strip and the floor map both render this list, so the UI can never invent a
 * stop that does not exist. The hallway is still walked, but it is part of the
 * floor-3 leg and no longer has a control of its own.
 */
export interface JourneyStopDef {
  key: 'lobby' | 'floor2' | 'gate' | 'room' | 'end';
  floor: string;
  name: string;
  /** Line printed under the node; the first stop uses two lines (“SẢNH” / “TẦNG 1”). */
  label: readonly string[];
  station: Role | null;
}

export const JOURNEY_STOPS: readonly JourneyStopDef[] = [
  { key: 'lobby', floor: 'TẦNG 1', name: 'SẢNH TẦNG 1', label: ['SẢNH', 'TẦNG 1'], station: 'LOBBY' },
  { key: 'floor2', floor: 'TẦNG 2', name: 'TẦNG 2', label: ['TẦNG 2'], station: 'CORRIDOR' },
  { key: 'gate', floor: 'TẦNG 3', name: 'CỬA VÀO', label: ['CỬA VÀO'], station: 'GATE' },
  { key: 'room', floor: 'TẦNG 3', name: 'PHÒNG 305', label: ['PHÒNG 305'], station: 'ROOM305' },
  { key: 'end', floor: 'KẾT THÚC', name: 'KẾT THÚC', label: ['KẾT THÚC'], station: null },
] as const;

export const RESET_TASK_LABEL: Record<ResetTaskKey, string> = {
  hidden_objects: 'Vật phẩm ẩn',
  hallway: 'Hành lang tầng 3',
  room: 'Phòng 305',
};

/**
 * V3.4 §3 — the states one physical-reset area may honestly be shown in.
 *
 * `open`, `done` and `reopened` come straight from the stored checklist row
 * (`completed_at` plus the round's `reset_cycle`): untouched, server-confirmed,
 * and a mark that belongs to an earlier cycle and therefore has to be done
 * again. `submitting` and `failed` are the phone's own write only: a
 * confirmation that is on the wire but not yet acknowledged, and one the server
 * refused. Nothing here invents a backend completion state — the workflow only
 * ever has “outstanding” and “confirmed in this current cycle”.
 */
export const RESET_STATE_LABEL = {
  open: 'Chưa thực hiện',
  submitting: 'Đang chờ xác nhận',
  done: 'Đã hoàn thành',
  reopened: 'Đã mở lại · cần xác nhận lại',
  failed: 'Lỗi xác nhận',
} as const;

export type ResetRowState = keyof typeof RESET_STATE_LABEL;

/**
 * V3.4 §5 — the three floor-3 areas in the order the crew physically walks them
 * when putting the floor back: the hallway, the hidden props, then the room.
 * `RESET_TASKS` stays the storage order; only the read-out is re-sequenced.
 */
export const RESET_READOUT_ORDER = ['hallway', 'hidden_objects', 'room'] as const;

/**
 * The same three areas as a sentence, because an operator must be told which part of
 * the floor is still outstanding, not shown a database key (V3.1 §10.2).
 */
export function resetTasksSentence(keys: readonly string[]): string {
  const labels = keys.map((k) => RESET_TASK_LABEL[k as ResetTaskKey] ?? k);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} và ${labels[labels.length - 1]}`;
}

/** Connection state in the operator's own words; the enum never reaches the screen. */
export const TRANSPORT_LABEL: Record<string, string> = {
  CONNECTED: 'ĐÃ KẾT NỐI',
  SYNCING: 'ĐANG ĐỒNG BỘ',
  DEGRADED: 'KẾT NỐI KHÔNG ỔN ĐỊNH',
  OFFLINE: 'MẤT KẾT NỐI',
};

/**
 * V3.4 §8 — the five honest synchronisation claims the header chip may make.
 * They are deliberately finer than TRANSPORT_LABEL: "network up", "a refresh is
 * running", "the data on screen is current", "recovering" and "failed" are
 * different facts, and the chip must never blur them into one permanent
 * "ĐANG ĐỒNG BỘ" after the server has already answered.
 */
export const SYNC_STATE_LABEL: Record<'connected' | 'current' | 'syncing' | 'reconnecting' | 'failed', string> = {
  connected: 'ĐÃ KẾT NỐI',
  current: 'DỮ LIỆU HIỆN TẠI',
  syncing: 'ĐANG ĐỒNG BỘ…',
  reconnecting: 'ĐANG KẾT NỐI LẠI…',
  failed: 'MẤT KẾT NỐI',
};

/** Why the board cannot be released right now, in words an operator can act on. */
export const RESET_BLOCK_LABEL: Record<ResetBlockReason, string> = {
  RUNNING: 'Vẫn còn đội trong khu vực — NPC 1 chưa xác nhận rời tầng 3',
  PENDING_CLAIM: 'Còn lần báo hoàn thành chờ NPC 2 xác minh',
  RESET_OPEN: 'Khu vực chưa xác nhận reset xong',
};

/**
 * Vietnamese labels for every phase of the single flow. Legacy values stay in the
 * table because historical rounds and old audit rows still carry those statuses;
 * `flowStatus()` maps them onto the new vocabulary before anything is rendered.
 */
export const STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: 'Chưa bắt đầu',
  /* ----------------------------------------------------------- retired (history) */
  LOBBY_CALL: 'Đã gọi đội',
  TEAM_PREPARING: 'Đội đang lên tầng',
  GAME_STARTED: 'Trận đấu đang chạy',
  CORRIDOR_ACTIVE: 'Đội ở hành lang',
  ROOM_REACHED: 'Đội đã đến 305',
  PUZZLE_COMPLETED: 'Trận đồ hoàn thành',
  RETURNING: 'Đội đang quay lại',
  GAME_EXITED: 'Chờ chốt giờ',
  RESETTING: 'Đang reset',
  RESET_CONFIRMED: 'Reset xong',
  GATE_CLEARED: 'Khu vực thông thoáng',
  SYSTEM_READY: 'Sẵn sàng nhận đội',
  ABORTED: 'Đã hủy khẩn cấp',
  /* ------------------------------------------------------------ authoritative flow */
  WAITING_FLOOR2_CONFIRMATION: 'Đã nhận đội · chờ xác nhận tầng 2',
  READY_AT_FLOOR3: 'Đội sắp bắt đầu',
  RUNNING: 'Đồng hồ lượt chơi đang chạy',
  TIME_EXPIRED_PENDING_VALIDATION: 'Hết giờ · đang chờ xác minh mốc hợp lệ',
  WAITING_FOR_EXIT: 'Chờ đội rời tầng 3',
  EXIT_CONFIRMED: 'Đội đã rời tầng 3 · đang reset',
  CLOSED: 'Lượt chơi đã đóng',
} as const;

/** The lifecycle positions the operator screen speaks about, in flow order. */
export const PHASE_LABEL: Record<string, string> = {
  PRE_EVENT: 'Chưa mở sự kiện',
  WAITING_FOR_TEAM: 'Đang chờ tiếp nhận đội chơi',
  WAITING_FLOOR2_CONFIRMATION: 'Chờ Nhân sự 02 xác nhận tầng 2',
  READY_AT_FLOOR3: 'ĐỘI CHƠI SẮP BẮT ĐẦU',
  RUNNING: 'LƯỢT CHƠI ĐANG CHẠY',
  TIME_EXPIRED_PENDING_VALIDATION: 'HẾT GIỜ — ĐANG CHỜ XÁC MINH',
  WAITING_FOR_EXIT: 'Chờ NPC 1 xác nhận đội rời tầng 3',
  EXIT_CONFIRMED: 'Đang reset khu vực',
  CLOSED: 'Sẵn sàng nhận đội tiếp theo',
  ENDED: 'Sự kiện đã kết thúc',
} as const;

export const OUTCOME_LABEL = {
  IN_PROGRESS: 'Đang diễn ra',
  PENDING_VALIDATION: 'ĐANG CHỜ XÁC MINH',
  WON: 'THÀNH CÔNG',
  TIME_UP: 'HẾT GIỜ',
  ABORTED: 'LƯỢT CHƠI ĐÃ HỦY',
  /* retired, history only */
  TIMEOUT: 'QUÁ GIỜ',
  NO_PUZZLE: 'Chưa hoàn thành trận đồ',
  OVERRIDE: 'Vào trận sau cutoff',
} as const;

/** Per-attempt verification state, kept separate from the session lifecycle. */
export const ATTEMPT_LABEL = {
  PENDING: 'Chờ kiểm tra',
  /**
   * The round was sealed before this report was ever decided. It is neither
   * accepted nor rejected, and printing either of those words would invent a
   * decision the database never recorded (V3.4 §5).
   */
  PENDING_SEALED: 'CHƯA QUYẾT ĐỊNH',
  VALID: 'CHÍNH XÁC',
  INVALID: 'CHƯA ĐÚNG',
  LATE: 'ĐẾN MUỘN',
} as const;

/**
 * The action log in the operator's own words (§10.2). History rows keep their English
 * action type — that is the wire format the audit and the RPCs speak — so every entry
 * is translated here instead of being printed raw, retired actions included.
 */
export const ACTION_LABEL: Record<string, string> = {
  /* the live flow */
  CALL_TEAM: 'Nhận đội và cho lên tầng 2',
  CONFIRM_FLOOR2: 'Xác nhận đội đã đến tầng 2',
  FLOOR2_BYPASS: 'Bỏ qua xác nhận tầng 2',
  START_GAME: 'Bắt đầu lượt chơi',
  CLAIM_COMPLETE: 'Ghi nhận báo hoàn thành',
  VERIFY_ATTEMPT: 'Xác minh lần báo hoàn thành',
  CONFIRM_EXIT: 'Xác nhận đội đã rời tầng 3',
  EARLY_EXIT: 'Đội rời khu vực sớm',
  RESET_DONE: 'Xác nhận reset khu vực',
  GATE_FINALIZE: 'NPC 1 chốt khu vực sẵn sàng',
  SET_LAYOUT: 'Chọn bố trí vật ẩn',
  SET_TEAM_NAME: 'Đặt tên đội',
  /* admin & event */
  CONFIGURE: 'Cập nhật cấu hình',
  REOPEN_RESET: 'Mở lại một bước reset',
  REVIEW_RESOLVE: 'Xét lại kết quả tranh chấp',
  END_EVENT: 'Đóng sự kiện',
  OPEN_NEW_EVENT: 'Mở sự kiện mới',
  ABORT_ROUND: 'Hủy lượt chơi',
  CORRECT_ROUND: 'Hiệu chỉnh mốc thời gian có nhật ký',
  /* retired — a crew code, an old deadline or a cancelled session still appears in history */
  OVERRIDE_ADMIT: 'Ngoại lệ cho nhận đội (đã bãi bỏ)',
  OVERTIME_STARTED: 'Bắt đầu vượt giờ (đã bãi bỏ)',
  EVENT_CLOSED: 'Đóng sự kiện (đã bãi bỏ)',
  SESSION_RESTORE: 'Phục hồi phiên',
  TEAM_UPSTAIRS: 'Cho đội lên tầng (luồng cũ)',
  GAME_PAUSE: 'Tạm dừng đồng hồ (đã cấm)',
  GAME_RESUME: 'Tiếp tục đồng hồ (đã cấm)',
  GAME_RESET: 'Reset đồng hồ (đã cấm)',
  HALLWAY_PROGRESS: 'Đội ở hành lang (luồng cũ)',
  ROOM_REACHED: 'Đội đã đến 305 (luồng cũ)',
  PUZZLE_COMPLETE: 'Chốt giờ trận đồ (luồng cũ)',
  RETURN_START: 'Bắt đầu cho đội quay lại (luồng cũ)',
  GAME_STOP: 'Dừng trận đấu (luồng cũ)',
  START_EVENT: 'Mở sự kiện (luồng cũ)',
};

/** Reasons a result is withheld from the ranking until a supervisor decides. */
export const REVIEW_REASON_LABEL: Record<string, string> = {
  CLOSE_FINISH: 'Kết quả sát thời lượng lượt chơi',
  START_TRANSPORT: 'Nhấn BẮT ĐẦU chậm được ghi nhận',
  STOP_TRANSPORT: 'Nhấn CHỐT GIỜ chậm được ghi nhận',
  PUZZLE_TRANSPORT: 'Xác nhận trận đồ đến muộn',
  CLAIM_TRANSPORT: 'Ghi nhận báo hoàn thành đến muộn',
  LATE_PUZZLE: 'Trận đồ xác nhận sau khi chốt giờ',
  LATE_CLAIM: 'Báo hoàn thành ghi nhận sau hạn lượt chơi',
  GAME_RESET: 'Đồng hồ lượt chơi bị reset giữa trận',
  CORRECTED: 'Đã hiệu chỉnh thủ công',
  RESET_REOPENED: 'Một bước reset đã được mở lại',
  FLOOR2_BYPASS: 'Bỏ qua xác nhận tầng 2 (NPC 1)',
  ROUND_ABORTED: 'Lượt chơi bị hủy có kiểm toán',
};
