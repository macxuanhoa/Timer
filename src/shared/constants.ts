/** Protected operational defaults. All values are milliseconds unless noted. */

export const ROLES = ['LOBBY', 'GATE', 'CORRIDOR', 'ROOM305', 'SUPERVISOR'] as const;

export const EVENT_DURATION_MS = 90 * 60_000;
export const GAME_LIMIT_MS = 5 * 60_000;
export const PREP_ALLOWANCE_MS = 90_000;

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

/** Reset tasks that must be confirmed before GATE may finalize readiness. */
export const RESET_TASKS = ['hidden_objects', 'hallway', 'room'] as const;

export type Role = (typeof ROLES)[number];
export type ResetTaskKey = (typeof RESET_TASKS)[number];
export type HiddenObjectOwner = Extract<Role, 'GATE' | 'CORRIDOR'>;

export const ROLE_LABEL: Record<Role, string> = {
  LOBBY: 'LOBBY',
  GATE: 'GATE · NPC 1',
  CORRIDOR: 'CORRIDOR · NPC 2',
  ROOM305: 'ROOM 305 · NPC 3',
  SUPERVISOR: 'SUPERVISOR',
};

/** Short station codes, for the journey strip where every column is ~80 px wide. */
export const ROLE_SHORT: Record<Role, string> = {
  LOBBY: 'LOBBY',
  GATE: 'NPC 1',
  CORRIDOR: 'NPC 2',
  ROOM305: 'NPC 3',
  SUPERVISOR: 'SUP',
};

/**
 * The physical route of one team, in walking order: the ground-floor lobby, then
 * everything the team passes on the third floor. The journey strip and the floor
 * map both render this list, so the UI can never invent a stop that does not exist.
 */
export interface JourneyStopDef {
  key: 'lobby' | 'gate' | 'hall' | 'room' | 'end';
  floor: string;
  name: string;
  /** Line printed under the node; the first stop uses two lines (“SẢNH” / “TẦNG 1”). */
  label: readonly string[];
  station: Role | null;
}

export const JOURNEY_STOPS: readonly JourneyStopDef[] = [
  { key: 'lobby', floor: 'TẦNG 1', name: 'SẢNH TẦNG 1', label: ['SẢNH', 'TẦNG 1'], station: 'LOBBY' },
  { key: 'gate', floor: 'TẦNG 3', name: 'CỬA VÀO', label: ['CỬA VÀO'], station: 'GATE' },
  { key: 'hall', floor: 'TẦNG 3', name: 'HÀNH LANG', label: ['HÀNH LANG'], station: 'CORRIDOR' },
  { key: 'room', floor: 'TẦNG 3', name: 'PHÒNG 305', label: ['PHÒNG 305'], station: 'ROOM305' },
  { key: 'end', floor: 'KẾT THÚC', name: 'KẾT THÚC', label: ['KẾT THÚC'], station: null },
] as const;

export const RESET_TASK_LABEL: Record<ResetTaskKey, string> = {
  hidden_objects: 'Đặt lại vật ẩn',
  hallway: 'Hành lang sẵn sàng',
  room: 'Phòng 305 sẵn sàng',
};

/** Vietnamese labels for every round status. */
export const STATUS_LABEL = {
  NOT_STARTED: 'Chưa bắt đầu',
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
} as const;

export const OUTCOME_LABEL = {
  IN_PROGRESS: 'Đang diễn ra',
  WON: 'THÀNH CÔNG',
  TIMEOUT: 'QUÁ GIỜ',
  NO_PUZZLE: 'Chưa hoàn thành trận đồ',
  ABORTED: 'Hủy khẩn cấp',
  OVERRIDE: 'Vào trận sau cutoff',
} as const;

/** Reasons a result is withheld from the ranking until a supervisor decides. */
export const REVIEW_REASON_LABEL: Record<string, string> = {
  CLOSE_FINISH: 'Kết quả sát nút 5:00',
  START_TRANSPORT: 'Nhấn BẮT ĐẦU chậm được ghi nhận',
  STOP_TRANSPORT: 'Nhấn CHỐT GIỜ chậm được ghi nhận',
  PUZZLE_TRANSPORT: 'Xác nhận trận đồ đến muộn',
  LATE_PUZZLE: 'Trận đồ xác nhận sau khi chốt giờ',
  GAME_RESET: 'Đồng hồ 5:00 bị reset giữa trận',
  CORRECTED: 'Đã hiệu chỉnh thủ công',
  RESET_REOPENED: 'Một bước reset đã được mở lại',
};
