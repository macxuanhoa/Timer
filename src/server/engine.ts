import {
  EVENT_DURATION_MS,
  GAME_LIMIT_MS,
  PREP_ALLOWANCE_MS,
  RESET_TARGET_MS,
  REVIEW_THRESHOLD_MS,
  STALL_WARN_MS,
  TEAM_NAME_MAX,
  type HidingLayout,
  type ResetTaskKey,
  type Role,
} from '../shared/constants.ts';
import {
  STAGE_OF_STATUS,
  deriveEventStatus,
  derivePhase,
  evaluateDispatch,
  evaluateGameStart,
  finalizeSnapshot,
  gameElapsedMs,
  isAllowed,
  isGameRunning,
  isResetWindow,
  isTerminalRound,
} from '../shared/machine.ts';
import type {
  ActionType,
  Clock,
  CommandRequest,
  CommandResult,
  EventConfig,
  EventSession,
  LogEntry,
  OperatorState,
  OperationStatus,
  Outcome,
  ResetTask,
  Round,
  Snapshot,
} from '../shared/types.ts';

export interface Account {
  id: string;
  role: Role;
  display_name: string;
}

export interface PersistedState {
  event: EventSession;
  rounds: Round[];
  reset_tasks: ResetTask[];
  log: LogEntry[];
  /** idempotency key -> committed outcome, so a retry never double-writes. */
  processed_keys: Record<string, { revision: number; code: string; message: string }>;
}

const LOG_LIMIT = 2000;

export function defaultConfig(): EventConfig {
  return {
    event_name: 'SCREAM CONTROL — Room 305',
    event_duration_ms: EVENT_DURATION_MS,
    game_limit_ms: GAME_LIMIT_MS,
    prep_allowance_ms: PREP_ALLOWANCE_MS,
    start_team_number: 1,
    reset_target_ms: RESET_TARGET_MS,
    hidden_object_owner: 'CORRIDOR',
    review_threshold_ms: REVIEW_THRESHOLD_MS,
    stall_warn_ms: STALL_WARN_MS,
    hiding_layout: 'A',
  };
}

export function initialState(nowMs: number, overrides: Partial<EventConfig> = {}): PersistedState {
  return {
    event: {
      id: `evt_${nowMs.toString(36)}`,
      config: { ...defaultConfig(), ...overrides },
      event_started_at: null,
      event_ended_at: null,
      overtime_started_at: null,
      closing_warned_at: null,
      end_warned_at: null,
      next_team_number: overrides.start_team_number ?? 1,
      revision: 0,
    },
    rounds: [],
    reset_tasks: [],
    log: [],
    processed_keys: {},
  };
}

/**
 * Sessions persisted before the 5-minute clock became pausable/resettable carry
 * none of the new fields. Filling them from the old timestamps keeps a running
 * event readable across a deploy instead of crashing the countdown.
 */
export function hydrateState(state: PersistedState): PersistedState {
  for (const r of state.rounds) {
    // Rows written by an older build simply lack these keys; read them as optional.
    const legacy: Partial<Round> = r;
    if (typeof legacy.game_elapsed_ms !== 'number') {
      r.game_elapsed_ms =
        legacy.official_duration_ms ??
        (legacy.game_started_at !== null && legacy.game_started_at !== undefined
          ? Math.max(0, (legacy.game_stopped_at ?? 0) - legacy.game_started_at)
          : 0);
    }
    if (legacy.game_anchor_ms === undefined) {
      // Older rows may lack the key entirely, so `Partial<Round>` makes it optional.
      const started = legacy.game_started_at;
      r.game_anchor_ms = typeof started === 'number' && (legacy.game_stopped_at ?? null) === null ? started : null;
    }
    if (typeof legacy.game_reset_count !== 'number') r.game_reset_count = 0;
    if (typeof legacy.game_pause_count !== 'number') r.game_pause_count = 0;
  }
  return state;
}

/* -------------------------------------------------------------------- engine */

export class ScreamEngine {
  constructor(
    private state: PersistedState,
    private clock: Clock,
    private accounts: Record<string, Account>,
  ) {
    this.state = hydrateState(state);
  }

  get revision(): number {
    return this.state.event.revision;
  }

  private activeRound(): Round | null {
    for (let i = this.state.rounds.length - 1; i >= 0; i--) {
      const r = this.state.rounds[i];
      if (!isTerminalRound(r)) return r;
    }
    return null;
  }

  /** Latest committed state plus the authoritative server instant. */
  snapshot(nowMs = this.clock.nowMs()): Snapshot {

    return finalizeSnapshot({
      revision: this.state.event.revision,
      server_now_ms: nowMs,
      event: structuredClone(this.state.event),
      rounds: structuredClone(this.state.rounds),
      reset_tasks: structuredClone(this.state.reset_tasks),
      operators: this.operatorStates(),
      log: structuredClone(this.state.log.slice(-400)),
    });
  }

  /** Full append-only history, used by the supervisor CSV export. */
  fullLog(): LogEntry[] {
    return structuredClone(this.state.log);
  }

  /** Cheap freshness probe for the client's periodic authoritative check. */
  revisionProbe(nowMs = this.clock.nowMs()): { revision: number; server_now_ms: number; event_id: string } {
    return { revision: this.state.event.revision, server_now_ms: nowMs, event_id: this.state.event.id };
  }

  /**
   * Scenario G: “committed but response lost”. The client asks whether its
   * idempotency key already landed before retrying or reporting a failure.
   */
  operationStatus(actorId: string, idempotencyKey: string): OperationStatus {
    const entry = this.state.log.find((l) => l.actor_id === actorId && l.idempotency_key === idempotencyKey);
    if (!entry) return { found: false };
    return { found: true, action: entry.action, at_ms: entry.at_ms, revision: entry.revision, round_id: entry.round_id };
  }

  raw(): PersistedState {
    return this.state;
  }

  /* --------------------------------------------------------------- commands */

  dispatch(req: CommandRequest): CommandResult {
    const now = this.clock.nowMs();
    const idemKey = `${req.actor.id}:${req.action}:${req.idempotency_key}`;
    const cached = this.state.processed_keys[idemKey];
    if (cached) {
      // A retry of an already-committed tap: never re-timestamp, never re-bump.
      return this.result(true, 'OK', cached.message, cached.revision, now);
    }

    if (!this.accounts[req.actor.id] || this.accounts[req.actor.id].role !== req.actor.role) {
      return this.result(false, 'PERMISSION_DENIED', 'Tài khoản không hợp lệ', this.revision, now);
    }
    if (!isAllowed(req.actor.role, req.action)) {
      return this.result(
        false,
        'PERMISSION_DENIED',
        `${req.actor.role} không được phép thực hiện ${req.action}`,
        this.revision,
        now,
      );
    }
    if (req.expected_revision !== this.revision) {
      return this.result(
        false,
        'STALE_REVISION',
        `Trạng thái đã thay đổi (bản ${this.revision}). Đang đồng bộ lại…`,
        this.revision,
        now,
      );
    }

    const handlers: Partial<Record<ActionType, (r: CommandRequest, t: number) => CommandResult>> = {
      CONFIGURE: this.onConfigure,
      CALL_TEAM: this.onCallTeam,
      TEAM_UPSTAIRS: this.onTeamUpstairs,
      START_GAME: this.onStartGame,
      GAME_PAUSE: this.onGamePause,
      GAME_RESUME: this.onGameResume,
      GAME_RESET: this.onGameReset,
      HALLWAY_PROGRESS: this.onHallwayProgress,
      ROOM_REACHED: this.onRoomReached,
      PUZZLE_COMPLETE: this.onPuzzleComplete,
      RETURN_START: this.onReturnStart,
      GAME_STOP: this.onGameStop,
      RESET_DONE: this.onResetDone,
      GATE_FINALIZE: this.onGateFinalize,
      SET_LAYOUT: this.onSetLayout,
      SET_TEAM_NAME: this.onSetTeamName,
      REOPEN_RESET: this.onReopenReset,
      REVIEW_RESOLVE: this.onReviewResolve,
      END_EVENT: this.onEndEvent,
      ABORT_ROUND: this.onAbortRound,
      CORRECT_ROUND: this.onCorrectRound,
    };
    const handler = handlers[req.action];
    if (!handler) return this.result(false, 'UNKNOWN_ACTION', `Hành động không xác định`, this.revision, now);
    const res = handler.call(this, req, now);
    if (res.ok) this.state.processed_keys[idemKey] = { revision: res.revision, code: 'OK', message: res.message };
    return res;
  }

  private result(
    ok: boolean,
    code: CommandResult['code'],
    message: string,
    revision = this.revision,
    nowMs = this.clock.nowMs(),
    extra: Partial<CommandResult> = {},
  ): CommandResult {
    return {
      ok,
      code,
      message,
      revision,
      server_now_ms: nowMs,
      snapshot: ok ? this.snapshot(nowMs) : undefined,
      ...extra,
    };
  }

  /** Append one immutable, server-timestamped history row and bump the revision. */
  private commit(
    req: CommandRequest,
    now: number,
    round: Round | null,
    toState: string | null,
    message: string,
    metadata: Record<string, unknown> | null = null,
  ): void {
    const from = round?.status ?? null;
    this.state.event.revision += 1;
    const entry: LogEntry = {
      seq: this.state.log.length + 1,
      event_id: this.state.event.id,
      round_id: round?.id ?? null,
      team_number: round?.team_number ?? null,
      action: req.action,
      actor_role: req.actor.role,
      actor_id: req.actor.id,
      from_state: from,
      to_state: toState,
      at_ms: now,
      revision: this.state.event.revision,
      idempotency_key: req.idempotency_key,
      metadata: {
        detail_text: message,
        ...(metadata ?? {}),
        ...(req.meta?.reason ? { reason: req.meta.reason } : {}),
        ...(req.meta?.override ? { override: true } : {}),
      },
    };
    this.state.log.push(entry);
    if (this.state.log.length > LOG_LIMIT) this.state.log.splice(0, this.state.log.length - LOG_LIMIT);
  }

  /* -------------------------------------------------------------- handlers */

  private onConfigure(req: CommandRequest, now: number): CommandResult {
    const cfg = req.meta as unknown as Partial<EventConfig>;
    const started = this.state.event.event_started_at !== null;
    const locked: (keyof EventConfig)[] = ['event_duration_ms', 'game_limit_ms', 'start_team_number', 'event_name'];
    for (const k of locked) {
      if (started && cfg[k] !== undefined && cfg[k] !== this.state.event.config[k]) {
        return this.result(false, 'INVALID_STATE', 'Không đổi được thời lượng sau khi sự kiện đã chạy', this.revision, now);
      }
    }
    const allowed: (keyof EventConfig)[] = started
      ? ['prep_allowance_ms', 'reset_target_ms', 'hidden_object_owner']
      : ['event_name', 'event_duration_ms', 'game_limit_ms', 'prep_allowance_ms', 'start_team_number', 'reset_target_ms', 'hidden_object_owner'];
    const applied: Record<string, unknown> = {};
    for (const k of allowed) {
      if (cfg[k] !== undefined) {
        applied[k] = cfg[k];
        (this.state.event.config as unknown as Record<string, unknown>)[k] = cfg[k];
      }
    }
    if (!started && cfg.start_team_number !== undefined) this.state.event.next_team_number = cfg.start_team_number;
    this.commit(req, now, null, null, 'Đã cập nhật cấu hình sự kiện', applied);
    return this.result(true, 'OK', 'Đã lưu cấu hình', this.revision, now);
  }

  private onCallTeam(req: CommandRequest, now: number): CommandResult {
    if (this.state.event.event_ended_at !== null) {
      return this.result(false, 'INVALID_STATE', 'SỰ KIỆN ĐÃ KẾT THÚC', this.revision, now);
    }
    const active = this.activeRound();
    if (active) {
      return this.result(false, 'INVALID_STATE', 'Vẫn còn đội chưa hoàn tất', this.revision, now);
    }
    // Record the first dispatch for history, without starting an event countdown.
    const firstTeam = this.state.event.event_started_at === null;
    if (firstTeam) this.state.event.event_started_at = now;
    const decision = evaluateDispatch(this.state.event, now);
    const override = req.meta?.override === true && !!req.meta?.reason;
    if (!decision.allowed) {
      if (!decision.overridePossible || !override) {
        return this.result(false, 'BLOCKED', decision.message, this.revision, now, {
          requires_override: decision.overridePossible,
        });
      }
    }
    const name = teamNameOf(req.meta);
    if (name !== null && name.length > TEAM_NAME_MAX) {
      return this.result(false, 'INVALID_STATE', `Tên đội tối đa ${TEAM_NAME_MAX} ký tự`, this.revision, now);
    }
    const round: Round = {
      id: `rnd_${this.state.event.next_team_number}_${now.toString(36)}`,
      event_id: this.state.event.id,
      round_number: this.state.rounds.length + 1,
      team_number: this.state.event.next_team_number,
      team_name: name,
      status: 'LOBBY_CALL',
      stage: 1,
      called_at: now,
      game_started_at: null,
      game_anchor_ms: null,
      game_elapsed_ms: 0,
      game_stopped_at: null,
      game_reset_count: 0,
      game_pause_count: 0,
      official_duration_ms: null,
      puzzle_completed_at: null,
      exit_confirmed_at: null,
      gate_finalized_at: null,
      system_ready_at: null,
      aborted_at: null,
      outcome: 'IN_PROGRESS',
      admission_override: !decision.allowed,
      hiding_layout: this.state.event.config.hiding_layout,
      reset_cycle: 1,
      start_press_ms: null,
      stop_press_ms: null,
      start_transport_ms: null,
      stop_transport_ms: null,
      needs_review: false,
      review_reasons: [],
      review_resolved_at: null,
      decertified: false,
      created_revision: this.revision + 1,
    };
    this.state.event.next_team_number += 1;
    this.state.rounds.push(round);
    for (const task of this.requiredTasks()) {
      this.state.reset_tasks.push({
        round_id: round.id,
        task_key: task.key,
        required_role: task.role,
        confirmed_by_role: null,
        confirmed_by: null,
        completed_at: null,
        cycle: 1,
        reopen_count: 0,
        layout: null,
        revision: 0,
      });
    }
    this.commit(req, now, round, 'LOBBY_CALL', `Đã gọi đội #${pad3(round.team_number)}`, {
      override: !decision.allowed ? true : undefined,
      remaining_ms: decision.remaining_ms,
      hiding_layout: round.hiding_layout,
      event_clock_started: firstTeam ? true : undefined,
    });
    return this.result(true, 'OK', `Đội #${pad3(round.team_number)} đang lên tầng`, this.revision, now);
  }

  private onTeamUpstairs(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    if (round.status !== 'LOBBY_CALL') {
      return this.result(true, 'OK', 'Trạng thái đã được ghi nhận', this.revision, now);
    }
    round.status = 'TEAM_PREPARING';
    this.commit(req, now, round, 'TEAM_PREPARING', 'Đội đang lên cầu thang');
    return this.result(true, 'OK', 'Đội đang lên tầng', this.revision, now);
  }

  private onStartGame(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    if (round.game_started_at !== null) {
      return this.result(false, 'INVALID_STATE', 'Đồng hồ trận đã chạy', this.revision, now);
    }
    if (round.status !== 'LOBBY_CALL' && round.status !== 'TEAM_PREPARING') {
      return this.result(false, 'INVALID_STATE', 'Không thể bắt đầu trận từ trạng thái này', this.revision, now);
    }
    const decision = evaluateGameStart(this.state.event, now);
    const override = req.meta?.override === true && !!req.meta?.reason;
    if (!decision.allowed) {
      if (!decision.overridePossible || !override) {
        return this.result(false, 'BLOCKED', decision.message, this.revision, now, {
          requires_override: decision.overridePossible,
        });
      }
      round.admission_override = true;
    }
    round.status = 'GAME_STARTED';
    round.stage = Math.max(round.stage, STAGE_OF_STATUS.GAME_STARTED);
    round.game_started_at = now;
    round.game_anchor_ms = now;
    round.game_elapsed_ms = 0;
    this.recordPress(round, 'start', req, now);
    this.commit(req, now, round, 'GAME_STARTED', `Bắt đầu trận đội #${pad3(round.team_number)}`, {
      prep_ms: now - round.called_at,
      remaining_ms: decision.remaining_ms,
      start_transport_ms: round.start_transport_ms,
    });
    return this.result(true, 'OK', 'Đồng hồ 5:00 đang chạy', this.revision, now);
  }

  /**
   * GATE freezes the 5-minute window when a player falls, the puzzle jams, or the
   * hallway is blocked. Paused gaps do not count toward the official score.
   */
  private onGamePause(req: CommandRequest, now: number): CommandResult {
    const round = this.requireRunning(req, now);
    if (!round) return this.invalidRound(req, now);
    if (round.game_anchor_ms === null) {
      return this.result(true, 'OK', `5:00 đang tạm dừng · còn lại ${formatLeft(this.state.event.config.game_limit_ms - round.game_elapsed_ms)}`, this.revision, now);
    }
    round.game_elapsed_ms = gameElapsedMs(round, now);
    round.game_anchor_ms = null;
    round.game_pause_count += 1;
    const left = this.state.event.config.game_limit_ms - round.game_elapsed_ms;
    this.commit(req, now, round, round.status, `Tạm dừng đồng hồ 5:00 đội #${pad3(round.team_number)} · còn ${formatLeft(left)}`, {
      paused_at_ms: now,
      banked_ms: round.game_elapsed_ms,
      remaining_ms: left,
      pause_count: round.game_pause_count,
    });
    return this.result(true, 'OK', `TẠM DỪNG 5:00 · còn lại ${formatLeft(left)}`, this.revision, now);
  }

  /** Releases the pause without handing out any extra time. */
  private onGameResume(req: CommandRequest, now: number): CommandResult {
    const round = this.requireRunning(req, now);
    if (!round) return this.invalidRound(req, now);
    if (round.game_anchor_ms !== null) {
      return this.result(true, 'OK', 'Đồng hồ 5:00 đang chạy', this.revision, now);
    }
    round.game_anchor_ms = now;
    const left = this.state.event.config.game_limit_ms - round.game_elapsed_ms;
    this.commit(req, now, round, round.status, `Chạy lại 5:00 đội #${pad3(round.team_number)} · còn ${formatLeft(left)}`, {
      resumed_at_ms: now,
      remaining_ms: left,
      pause_count: round.game_pause_count,
    });
    return this.result(true, 'OK', `5:00 chạy lại · còn lại ${formatLeft(left)}`, this.revision, now);
  }

  /**
   * A full restart of the 5-minute window. It is a scoring decision, not a display
   * trick: the banked time is dropped and the official result is measured from here,
   * so the round is flagged for supervisor review and every station sees the count.
   */
  private onGameReset(req: CommandRequest, now: number): CommandResult {
    const round = this.requireRunning(req, now);
    if (!round) return this.invalidRound(req, now);
    const lost = gameElapsedMs(round, now);
    round.game_elapsed_ms = 0;
    round.game_anchor_ms = now;
    round.game_reset_count += 1;
    this.flagReview(round, 'GAME_RESET');
    this.commit(req, now, round, round.status, `RESET 5:00 đội #${pad3(round.team_number)} · lần ${round.game_reset_count}`, {
      reset_at_ms: now,
      discarded_ms: lost,
      reset_count: round.game_reset_count,
      pause_count: round.game_pause_count,
    });
    return this.result(true, 'OK', `ĐÃ RESET 5:00 · ${formatLeft(this.state.event.config.game_limit_ms)} chạy lại`, this.revision, now);
  }

  private onHallwayProgress(req: CommandRequest, now: number): CommandResult {
    const round = this.requireRunning(req, now);
    if (!round) return this.invalidRound(req, now);
    if (round.status === 'GAME_STARTED') {
      round.status = 'CORRIDOR_ACTIVE';
      round.stage = Math.max(round.stage, STAGE_OF_STATUS.CORRIDOR_ACTIVE);
      this.commit(req, now, round, 'CORRIDOR_ACTIVE', 'Đội đang tìm ở hành lang');
    }
    return this.result(true, 'OK', 'Đã ghi nhận hành lang', this.revision, now);
  }

  private onRoomReached(req: CommandRequest, now: number): CommandResult {
    const round = this.requireRunning(req, now);
    if (!round) return this.invalidRound(req, now);
    if (round.status === 'GAME_STARTED' || round.status === 'CORRIDOR_ACTIVE') {
      round.status = 'ROOM_REACHED';
      round.stage = Math.max(round.stage, STAGE_OF_STATUS.ROOM_REACHED);
      this.commit(req, now, round, 'ROOM_REACHED', `Đội #${pad3(round.team_number)} đã đến 305`);
    }
    return this.result(true, 'OK', 'Đã ghi nhận đến phòng 305', this.revision, now);
  }

  private onPuzzleComplete(req: CommandRequest, now: number): CommandResult {
    const round = this.requireRunning(req, now);
    if (!round) return this.invalidRound(req, now);
    if (round.puzzle_completed_at !== null) {
      return this.result(true, 'OK', 'Trận đồ đã được xác nhận', this.revision, now);
    }
    round.puzzle_completed_at = now;
    round.status = 'PUZZLE_COMPLETED';
    round.stage = Math.max(round.stage, STAGE_OF_STATUS.PUZZLE_COMPLETED);
    // Explicit rule: completion does NOT stop the official clock.
    const puzzleTransport = req.press ? Math.max(0, now - req.press.press_ms) : null;
    if (puzzleTransport !== null && puzzleTransport > this.state.event.config.review_threshold_ms) {
      this.flagReview(round, 'PUZZLE_TRANSPORT');
    }
    this.commit(req, now, round, 'PUZZLE_COMPLETED', 'Trận đồ hoàn thành — đồng hồ vẫn chạy', {
      elapsed_ms: round.game_started_at !== null ? gameElapsedMs(round, now) : null,
      press_transport_ms: puzzleTransport,
    });
    return this.result(true, 'OK', 'Trận đồ hoàn thành', this.revision, now);
  }

  private onReturnStart(req: CommandRequest, now: number): CommandResult {
    const round = this.requireRunning(req, now);
    if (!round) return this.invalidRound(req, now);
    if (round.status !== 'RETURNING') {
      round.status = 'RETURNING';
      round.stage = Math.max(round.stage, STAGE_OF_STATUS.RETURNING);
      this.commit(req, now, round, 'RETURNING', 'Đội đang quay lại cửa vào');
    }
    return this.result(true, 'OK', 'Đã ghi nhận đội quay lại', this.revision, now);
  }

  private onGameStop(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    if (round.game_stopped_at !== null) {
      // Exactly-once: the second press must not create a second score record.
      return this.result(true, 'OK', `Đã chốt giờ: ${round.official_duration_ms} ms`, this.revision, now);
    }
    if (round.game_started_at === null) {
      return this.result(false, 'INVALID_STATE', 'Trận chưa bắt đầu', this.revision, now);
    }
    // The score is what the 5-minute window actually measured: every paused gap is
    // excluded and a reset restarts the measurement from 5:00.
    const duration = gameElapsedMs(round, now);
    round.game_elapsed_ms = duration;
    round.game_anchor_ms = null;
    const limit = this.state.event.config.game_limit_ms;
    round.game_stopped_at = now;
    round.exit_confirmed_at = now;
    round.official_duration_ms = duration;
    round.outcome = this.computeOutcome(round, duration);
    round.status = 'RESETTING';
    round.stage = Math.max(round.stage, STAGE_OF_STATUS.GAME_EXITED);
    this.recordPress(round, 'stop', req, now);
    // A finish within the review window of the limit is a prize dispute, not a
    // fact the software may settle on its own.
    if (Math.abs(limit - duration) <= this.state.event.config.review_threshold_ms) this.flagReview(round, 'CLOSE_FINISH');
    this.commit(req, now, round, 'RESETTING', `Chốt giờ đội #${pad3(round.team_number)}: ${duration} ms`, {
      official_duration_ms: duration,
      outcome: round.outcome,
      limit_ms: limit,
      game_reset_count: round.game_reset_count,
      game_pause_count: round.game_pause_count,
      stop_transport_ms: round.stop_transport_ms,
      needs_review: round.needs_review,
      review_reasons: round.review_reasons,
    });
    return this.result(true, 'OK', `Kết quả: ${outcomeText(round.outcome, duration)}`, this.revision, now);
  }

  private onResetDone(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    if (!isResetWindow(round)) {
      return this.result(false, 'INVALID_STATE', 'Chưa tới giai đoạn reset', this.revision, now);
    }
    const wanted = (req.meta as { task_key?: ResetTaskKey })?.task_key;
    // A role may only confirm the tasks assigned to it; a supervisor may name a
    // single task explicitly as an emergency intervention. A mark from an earlier
    // reset cycle counts as outstanding, so a reopened reset can be re-confirmed.
    const pending = this.state.reset_tasks.filter(
      (t) =>
        t.round_id === round.id &&
        (t.completed_at === null || t.cycle !== round.reset_cycle) &&
        (t.required_role === req.actor.role ||
          (req.actor.role === 'SUPERVISOR' && !!wanted && t.task_key === wanted)),
    );
    if (pending.length === 0) {
      return this.result(true, 'OK', 'Không có tác vụ nào chờ xác nhận', this.revision, now);
    }
    for (const t of pending) {
      t.completed_at = now;
      t.confirmed_by_role = req.actor.role;
      t.confirmed_by = req.actor.id;
      t.cycle = round.reset_cycle;
      // The layout actually prepared is recorded with the object-placement task.
      if (t.task_key === 'hidden_objects') t.layout = this.state.event.config.hiding_layout;
      t.revision = this.revision + 1;
    }
    round.status = this.allTasksDone(round.id) ? 'RESET_CONFIRMED' : 'RESETTING';
    round.stage = Math.max(round.stage, STAGE_OF_STATUS.RESETTING);
    this.commit(
      req,
      now,
      round,
      round.status,
      `${req.actor.role} xác nhận xong: ${pending.map((t) => t.task_key).join(', ')}`,
      {
        tasks: pending.map((t) => t.task_key),
        cycle: round.reset_cycle,
        layout: this.state.event.config.hiding_layout,
        since_stop_ms: round.game_stopped_at ? now - round.game_stopped_at : null,
      },
    );
    return this.result(true, 'OK', 'Đã ghi nhận reset', this.revision, now);
  }

  private onGateFinalize(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    if (!isResetWindow(round)) {
      return this.result(false, 'INVALID_STATE', 'Chưa tới giai đoạn reset', this.revision, now);
    }
    const missing = this.state.reset_tasks.filter(
      (t) => t.round_id === round.id && (t.completed_at === null || t.cycle !== round.reset_cycle),
    );
    if (missing.length > 0) {
      return this.result(
        false,
        'BLOCKED',
        `Chưa xác nhận reset: ${missing.map((m) => m.task_key).join(', ')}`,
        this.revision,
        now,
      );
    }
    round.gate_finalized_at = now;
    round.system_ready_at = now;
    round.status = 'GATE_CLEARED';
    round.stage = STAGE_OF_STATUS.GATE_CLEARED;
    // The deadline may already have passed; the event only closes once the
    // supervisor confirms the area is clear or the round finishes in overtime.
    this.commit(req, now, round, 'GATE_CLEARED', 'GATE xác nhận khu vực thông thoáng — SẴN SÀNG', {
      total_reset_ms: round.game_stopped_at ? now - round.game_stopped_at : null,
      cycle: round.reset_cycle,
    });
    return this.result(true, 'OK', 'SẴN SÀNG nhận đội tiếp theo', this.revision, now);
  }

  /** Scenario C: the object-placement operator records the prepared hiding layout. */
  private onSetLayout(req: CommandRequest, now: number): CommandResult {
    const meta = req.meta as unknown as { layout?: HidingLayout };
    const layout = meta?.layout;
    if (layout !== 'A' && layout !== 'B' && layout !== 'C') {
      return this.result(false, 'INVALID_STATE', 'Bố trí không hợp lệ (A/B/C)', this.revision, now);
    }
    const owner = this.state.event.config.hidden_object_owner;
    if (req.actor.role !== 'SUPERVISOR' && req.actor.role !== owner) {
      return this.result(false, 'PERMISSION_DENIED', `Chỉ ${owner} mới bố trí vật ẩn`, this.revision, now);
    }
    const before = this.state.event.config.hiding_layout;
    this.state.event.config.hiding_layout = layout;
    this.commit(req, now, this.activeRound(), null, `Bố trí vật ẩn: ${layout}`, { from: before, to: layout });
    return this.result(true, 'OK', `Đã chuẩn bị bố trí ${layout}`, this.revision, now);
  }

  /**
   * The optional label of the team currently on the floor. It is a normal
   * revisioned command: every station receives the corrected name with the next
   * snapshot, and the change stays in the audit history.
   */
  private onSetTeamName(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    const raw = (req.meta as { team_name?: unknown } | undefined)?.team_name;
    // A missing value is a malformed command, never a silent erase: clearing the
    // name must be an explicit empty string.
    if (typeof raw !== 'string') {
      return this.result(false, 'INVALID_STATE', 'Thiếu tên đội', this.revision, now);
    }
    const name = teamNameOf(req.meta);
    if (name !== null && name.length > TEAM_NAME_MAX) {
      return this.result(false, 'INVALID_STATE', `Tên đội tối đa ${TEAM_NAME_MAX} ký tự`, this.revision, now);
    }
    if (round.team_name === name) {
      return this.result(true, 'OK', 'Tên đội không thay đổi', this.revision, now);
    }
    const before = round.team_name;
    round.team_name = name;
    this.commit(
      req,
      now,
      round,
      round.status,
      name ? `Đặt tên đội #${pad3(round.team_number)}: ${name}` : `Đã xoá tên đội #${pad3(round.team_number)}`,
      { team_name: name, previous_team_name: before },
    );
    return this.result(true, 'OK', name ? `Đã đặt tên đội: ${name}` : 'Đã xoá tên đội', this.revision, now);
  }

  /**
   * P0-06: reopening a reset invalidates every confirmation of the round by
   * advancing its reset cycle, and revokes READY so no team can be dispatched on
   * the old acknowledgement set. The original records stay in the audit log.
   */
  private onReopenReset(req: CommandRequest, now: number): CommandResult {
    const meta = req.meta as unknown as { round_id?: string; task_key?: ResetTaskKey; reason?: string };
    if (!meta?.reason) return this.result(false, 'BLOCKED', 'Bắt buộc nhập lý do mở lại reset', this.revision, now);
    const round = this.state.rounds.find((r) => r.id === meta.round_id);
    if (!round) return this.result(false, 'INVALID_STATE', 'Không tìm thấy lượt chơi', this.revision, now);
    const isLast = round.id === this.state.rounds.at(-1)?.id;
    if (!isTerminalRound(round) && !isResetWindow(round)) {
      return this.result(false, 'INVALID_STATE', 'Lượt chơi không ở giai đoạn reset', this.revision, now);
    }
    if (isTerminalRound(round) && !isLast) {
      return this.result(false, 'INVALID_STATE', 'Đã gọi đội mới — không thể mở lại reset cũ', this.revision, now);
    }
    const cleared = this.state.reset_tasks.filter((t) => t.round_id === round.id && t.completed_at !== null);
    const previous = cleared.map((t) => ({ task: t.task_key, by: t.confirmed_by_role, at: t.completed_at, cycle: t.cycle }));
    for (const t of cleared) {
      t.completed_at = null;
      t.confirmed_by_role = null;
      t.confirmed_by = null;
      t.layout = null;
      t.reopen_count += 1;
    }
    round.reset_cycle += 1;
    // Bring the task rows onto the new cycle so the pending check stays simple.
    for (const t of this.state.reset_tasks.filter((x) => x.round_id === round.id)) t.cycle = round.reset_cycle;
    round.gate_finalized_at = null;
    round.system_ready_at = null;
    round.status = 'RESETTING';
    this.commit(req, now, round, 'RESETTING', `Mở lại reset đội #${pad3(round.team_number)} · chu kỳ ${round.reset_cycle}`, {
      reason: meta.reason,
      task: meta.task_key ?? 'all',
      cycle: round.reset_cycle,
      invalidated: previous,
    });
    return this.result(true, 'OK', 'Cả ba bước reset phải xác nhận lại', this.revision, now);
  }

  /** P0-05: only a supervisor decision releases (or rejects) a disputed result. */
  private onReviewResolve(req: CommandRequest, now: number): CommandResult {
    const meta = req.meta as unknown as { round_id?: string; decision?: 'ACCEPT' | 'REJECT'; reason?: string };
    if (!meta?.reason) return this.result(false, 'BLOCKED', 'Bắt buộc nhập lý do quyết định', this.revision, now);
    if (meta.decision !== 'ACCEPT' && meta.decision !== 'REJECT') {
      return this.result(false, 'INVALID_STATE', 'Quyết định không hợp lệ', this.revision, now);
    }
    const round = this.state.rounds.find((r) => r.id === meta.round_id);
    if (!round) return this.result(false, 'INVALID_STATE', 'Không tìm thấy lượt chơi', this.revision, now);
    if (!round.needs_review) return this.result(false, 'INVALID_STATE', 'Lượt chơi không chờ xem xét', this.revision, now);
    round.needs_review = false;
    round.review_resolved_at = now;
    round.decertified = meta.decision === 'REJECT';
    this.commit(req, now, round, round.status, `Xét kết quả đội #${pad3(round.team_number)}: ${meta.decision}`, {
      reason: meta.reason,
      decision: meta.decision,
      reasons: round.review_reasons,
      official_duration_ms: round.official_duration_ms,
    });
    return this.result(
      true,
      'OK',
      meta.decision === 'ACCEPT' ? 'Đã xếp hạng kết quả' : 'Kết quả bị loại khỏi bảng xếp hạng',
      this.revision,
      now,
    );
  }

  private onEndEvent(req: CommandRequest, now: number): CommandResult {
    if (this.state.event.event_ended_at !== null) {
      return this.result(false, 'INVALID_STATE', 'Sự kiện đã kết thúc', this.revision, now);
    }
    // Controlled closure is an explicit, reasoned, audited decision.
    if (!req.meta?.reason) {
      return this.result(false, 'BLOCKED', 'Cần nhập lý do đóng sự kiện sớm', this.revision, now);
    }
    const active = this.activeRound();
    if (active) {
      return this.result(
        false,
        'BLOCKED',
        active.game_stopped_at === null
          ? `Đội #${pad3(active.team_number)} vẫn đang trong khu vực — không cắt đồng hồ`
          : 'Chưa hoàn tất reset cho đội hiện tại',
        this.revision,
        now,
      );
    }
    this.state.event.event_ended_at = now;
    this.commit(req, now, null, 'ENDED', 'Sự kiện đã kết thúc (đóng có kiểm soát)', {
      overtime_ms: 0,
    });
    return this.result(true, 'OK', 'SỰ KIỆN KẾT THÚC', this.revision, now);
  }

  private onAbortRound(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    if (!req.meta?.reason) {
      return this.result(false, 'BLOCKED', 'Bắt buộc nhập lý do dừng khẩn cấp', this.revision, now);
    }
    if (round.game_started_at !== null && round.game_stopped_at === null) {
      const duration = gameElapsedMs(round, now);
      round.game_elapsed_ms = duration;
      round.game_anchor_ms = null;
      round.game_stopped_at = now;
      round.exit_confirmed_at = now;
      round.official_duration_ms = duration;
    }
    round.aborted_at = now;
    round.outcome = 'ABORTED';
    round.status = 'RESETTING';
    this.commit(req, now, round, 'RESETTING', `DỪNG KHẨN CẤP đội #${pad3(round.team_number)}`, {
      reason: req.meta.reason,
    });
    return this.result(true, 'OK', 'Đã dừng khẩn cấp — khu vực cần reset', this.revision, now);
  }

  private onCorrectRound(req: CommandRequest, now: number): CommandResult {
    const meta = req.meta as unknown as {
      round_id?: string;
      field?: string;
      value_ms?: number | null;
      reason?: string;
    };
    if (!meta?.reason) {
      return this.result(false, 'BLOCKED', 'Bắt buộc nhập lý do hiệu chỉnh', this.revision, now);
    }
    const round = this.state.rounds.find((r) => r.id === meta.round_id);
    if (!round) return this.result(false, 'INVALID_STATE', 'Không tìm thấy lượt chơi', this.revision, now);
    const field = meta.field as keyof Round | undefined;
    if (!field || !['game_started_at', 'game_stopped_at', 'puzzle_completed_at', 'exit_confirmed_at'].includes(field)) {
      return this.result(false, 'INVALID_STATE', 'Trường không được phép hiệu chỉnh', this.revision, now);
    }
    if (round.system_ready_at !== null && field !== 'puzzle_completed_at') {
      return this.result(false, 'INVALID_STATE', 'Lượt chơi đã đóng — không đổi mốc giờ sau khi SẴN SÀNG', this.revision, now);
    }
    const before = round[field] as number | null;
    // null is an explicit undo (Scenario A: a wrong puzzle confirmation), never a
    // silent delete: the original value stays in the audit entry.
    let value: number | null = null;
    if (meta.value_ms !== null && meta.value_ms !== undefined) {
      value = Number(meta.value_ms);
      if (!Number.isFinite(value)) return this.result(false, 'INVALID_STATE', 'Thời gian không hợp lệ', this.revision, now);
    }
    (round as unknown as Record<string, unknown>)[field] = value;
    // A wall-clock recompute is only honest for a round whose 5-minute window was
    // never paused or restarted; otherwise the banked score stays and the mismatch
    // is left for the supervisor to resolve (this press already flags CORRECTED).
    if (
      round.game_started_at !== null &&
      round.game_stopped_at !== null &&
      round.game_reset_count === 0 &&
      round.game_pause_count === 0
    ) {
      round.official_duration_ms = Math.max(0, round.game_stopped_at - round.game_started_at);
      round.outcome = round.outcome === 'ABORTED' ? 'ABORTED' : this.computeOutcome(round, round.official_duration_ms);
    }
    this.flagReview(round, 'CORRECTED');
    this.commit(req, now, round, round.status, `Hiệu chỉnh ${field}`, {
      field,
      before_ms: before,
      after_ms: value,
      undone: value === null,
      reason: meta.reason,
    });
    return this.result(true, 'OK', 'Đã hiệu chỉnh · kết quả chờ xét lại', this.revision, now);
  }

  /* ------------------------------------------------------------------ utils */

  private invalidRound(req: CommandRequest, now: number): CommandResult {
    return this.result(false, 'INVALID_STATE', 'Không có lượt chơi đang hoạt động', this.revision, now);
  }

  private requireActive(_req: CommandRequest, _now: number): Round | null {
    return this.activeRound();
  }

  private requireRunning(_req: CommandRequest, _now: number): Round | null {
    const r = this.activeRound();
    return r && isGameRunning(r) ? r : null;
  }

  private requiredTasks(): { key: ResetTaskKey; role: Role }[] {
    const owner = this.state.event.config.hidden_object_owner;
    return [
      { key: 'hidden_objects', role: owner },
      { key: 'hallway', role: 'CORRIDOR' },
      { key: 'room', role: 'ROOM305' },
    ];
  }

  private allTasksDone(roundId: string): boolean {
    const round = this.state.rounds.find((r) => r.id === roundId);
    if (!round) return false;
    // Only confirmations from the current cycle count, so a reopened reset can
    // never be satisfied by the previous round's DONE marks.
    return this.state.reset_tasks
      .filter((t) => t.round_id === roundId)
      .every((t) => t.completed_at !== null && t.cycle === round.reset_cycle);
  }

  /**
   * Stores the gap between the operator's physical press (client-calibrated
   * instant) and the authoritative server commit. The official timestamp stays the
   * server value; a large gap makes the result disputed rather than silently
   * accepted.
   */
  private recordPress(round: Round, which: 'start' | 'stop', req: CommandRequest, now: number): void {
    const press = req.press;
    const delay = press ? Math.max(0, now - press.press_ms) : null;
    if (which === 'start') {
      round.start_press_ms = press?.press_ms ?? null;
      round.start_transport_ms = delay;
      if (delay !== null && delay > this.state.event.config.review_threshold_ms) this.flagReview(round, 'START_TRANSPORT');
    } else {
      round.stop_press_ms = press?.press_ms ?? null;
      round.stop_transport_ms = delay;
      if (delay !== null && delay > this.state.event.config.review_threshold_ms) this.flagReview(round, 'STOP_TRANSPORT');
    }
  }

  private flagReview(round: Round, reason: string): void {
    if (!round.review_reasons.includes(reason)) round.review_reasons.push(reason);
    round.needs_review = true;
    round.review_resolved_at = null;
  }

  private computeOutcome(round: Round, duration: number): Outcome {
    if (round.aborted_at !== null) return 'ABORTED';
    const limit = this.state.event.config.game_limit_ms;
    if (duration > limit) return 'TIMEOUT';
    if (round.puzzle_completed_at === null) return 'NO_PUZZLE';
    return 'WON';
  }

  private operatorStates(): OperatorState[] {
    const roles: Role[] = ['LOBBY', 'GATE', 'CORRIDOR', 'ROOM305', 'SUPERVISOR'];
    return roles.map((role) => {
      const entry = [...this.state.log].reverse().find((l) => l.actor_role === role && l.actor_id !== 'system.clock');
      const account = Object.values(this.accounts).find((a) => a.role === role);
      return {
        role,
        display_name: account?.display_name ?? role,
        last_action: entry?.action ?? null,
        last_action_at: entry?.at_ms ?? null,
        last_detail: entry?.metadata?.detail_text ? String(entry.metadata.detail_text) : entry?.action ?? null,
      };
    });
  }
}

/* ------------------------------------------------------------------ helpers */

export { deriveEventStatus, derivePhase };

/** Trim a submitted team label; missing or non-string input means “no label”. */
function teamNameOf(meta: CommandRequest['meta']): string | null {
  const raw = (meta as { team_name?: unknown } | undefined)?.team_name;
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.length > 0 ? name : null;
}

export function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/** Human-readable remainder for command messages (seconds, no milliseconds noise). */
function formatLeft(ms: number): string {
  const abs = Math.abs(ms);
  const m = Math.floor(abs / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  return `${ms < 0 ? '-' : ''}${m}:${String(s).padStart(2, '0')}`;
}

function outcomeText(outcome: Outcome, duration: number): string {
  const ms = `${Math.floor(duration / 1000)}.${String(duration % 1000).padStart(3, '0')}s`;
  switch (outcome) {
    case 'WON':
      return `THÀNH CÔNG ${ms}`;
    case 'TIMEOUT':
      return `QUÁ GIỜ ${ms}`;
    case 'NO_PUZZLE':
      return `CHƯA HOÀN THÀNH TRẬN ĐỒ · ${ms}`;
    default:
      return ms;
  }
}
