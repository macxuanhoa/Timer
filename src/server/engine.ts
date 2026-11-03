import {
  ABORT_KINDS,
  ABORT_KIND_LABEL,
  DEFAULT_ROUND_DURATION_MS,
  EVENT_DURATION_MS,
  PHASE_LABEL,
  PREP_ALLOWANCE_MS,
  RESET_TARGET_MS,
  REVIEW_THRESHOLD_MS,
  ROUND_DURATION_MAX_MS,
  ROUND_DURATION_MIN_MS,
  STALL_WARN_MS,
  ROLE_SHORT,
  TEAM_NAME_MAX,
  resetTasksSentence,
  type AbortKind,
  type HidingLayout,
  type ResetTaskKey,
  type Role,
} from '../shared/constants.ts';
import {
  STAGE_OF_STATUS,
  attemptsOf,
  authorizePhase,
  authorizeRole,
  deriveEventStatus,
  derivePhase,
  evaluateDispatch,
  evaluateGameStart,
  finalizeSnapshot,
  flowStatus,
  gameElapsedMs,
  hasValidatedAttempt,
  isEligibleClaim,
  isResetWindow,
  isTerminalRound,
  liveStatus,
  pendingEligibleClaims,
  resultOf,
  roundDeadlineMs,
  roundLimitMs,
} from '../shared/machine.ts';
import type {
  ActionType,
  Clock,
  CommandRequest,
  CommandResult,
  CompletionAttempt,
  EventConfig,
  EventSession,
  FlowStatus,
  LegacyRoundStatus,
  LogEntry,
  OperatorState,
  OperationStatus,
  Outcome,
  ResetTask,
  Round,
  RoundResult,
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
  /** Completion claims, append-only: an earlier attempt is never overwritten. */
  attempts: CompletionAttempt[];
  log: LogEntry[];
  /** idempotency key -> committed outcome, so a retry never double-writes. */
  processed_keys: Record<string, { revision: number; code: string; message: string }>;
}

const LOG_LIMIT = 2000;

export function defaultConfig(): EventConfig {
  return {
    event_name: 'SCREAM CONTROL — Room 305',
    event_duration_ms: EVENT_DURATION_MS,
    game_limit_ms: DEFAULT_ROUND_DURATION_MS,
    prep_allowance_ms: PREP_ALLOWANCE_MS,
    start_team_number: 1,
    reset_target_ms: RESET_TARGET_MS,
    hidden_object_owner: 'ROOM305',
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
    attempts: [],
    log: [],
    processed_keys: {},
  };
}

/**
 * Rows persisted before the unified flow carry none of the new columns, and their
 * status text belongs to the retired five-station relay. Filling the fields from
 * what is already there keeps a running event readable across a deploy instead of
 * crashing the countdown, and maps every legacy status onto the one vocabulary the
 * rest of the system reads.
 */
export function hydrateState(state: PersistedState, nowMs = Date.now()): PersistedState {
  state.attempts ??= [];
  for (const r of state.rounds) {
    const legacy: Partial<Round> = r;
    // V3.1 fields: rows written before the duration became configurable and before
    // the cancellation kinds existed are filled from what the round already proves.
    if (legacy.round_duration_ms === undefined) {
      r.round_duration_ms = r.deadline_at !== null && r.game_started_at !== null
        ? Math.max(0, r.deadline_at - r.game_started_at)
        : null;
    }
    if (legacy.abort_kind === undefined) r.abort_kind = r.aborted_at !== null ? 'safety' : null;
    if (legacy.abort_reason === undefined) r.abort_reason = null;
    if (typeof legacy.game_elapsed_ms !== 'number') r.game_elapsed_ms = 0;
    if (legacy.game_anchor_ms === undefined) r.game_anchor_ms = null;
    if (typeof legacy.game_reset_count !== 'number') r.game_reset_count = 0;
    if (typeof legacy.game_pause_count !== 'number') r.game_pause_count = 0;
    if (legacy.received_by_role === undefined) r.received_by_role = r.status === 'LOBBY_CALL' ? null : 'LOBBY';
    if (legacy.received_by === undefined) r.received_by = null;
    if (legacy.floor2_confirmed_at === undefined) r.floor2_confirmed_at = null;
    if (legacy.floor2_confirmed_by_role === undefined) r.floor2_confirmed_by_role = null;
    if (legacy.floor2_confirmed_by === undefined) r.floor2_confirmed_by = null;
    if (legacy.floor2_bypassed_at === undefined) r.floor2_bypassed_at = null;
    if (legacy.floor2_bypassed_by_role === undefined) r.floor2_bypassed_by_role = null;
    if (legacy.floor2_bypassed_by === undefined) r.floor2_bypassed_by = null;
    if (legacy.floor2_bypass_reason === undefined) r.floor2_bypass_reason = null;
    if (legacy.started_by_role === undefined) r.started_by_role = null;
    if (legacy.started_by === undefined) r.started_by = null;
    if (legacy.deadline_at === undefined) r.deadline_at = null;
    if (legacy.validated_attempt_id === undefined) r.validated_attempt_id = null;
    if (legacy.exit_by_role === undefined) r.exit_by_role = null;
    if (legacy.exit_by === undefined) r.exit_by = null;
    if (legacy.exit_reason === undefined) r.exit_reason = null;
    if (legacy.finalized_by_role === undefined) r.finalized_by_role = null;
    if (legacy.result === undefined) r.result = legacyResult(r.outcome);
    if (legacy.stage !== STAGE_OF_STATUS[r.status]) r.stage = STAGE_OF_STATUS[r.status] ?? r.stage;
    // One vocabulary: rewrite the stored status onto the authoritative flow. A legacy
    // row that was mid-window keeps its clock (the deadline is derived from the fields
    // it does have), so nobody gains or loses time from the upgrade.
    const flow = flowStatus(r);
    if (flow && r.status !== flow) r.status = flow;
    // A legacy round already scored as WON keeps a validated-attempt marker so the
    // result derivation behaves the same as a claim-based round.
    if (r.result === 'WON' && r.validated_attempt_id === null && r.puzzle_completed_at !== null) {
      r.validated_attempt_id = 'legacy';
    }
    if (r.result === 'WON' && r.official_duration_ms === null && r.game_started_at !== null) {
      r.official_duration_ms = Math.max(0, (r.puzzle_completed_at ?? nowMs) - r.game_started_at);
    }
  }
  for (const a of state.attempts) {
    if (typeof a.claim_press_ms !== 'number') a.claim_press_ms = null;
    if (typeof a.claim_transport_ms !== 'number') a.claim_transport_ms = null;
    if (typeof a.decision_note !== 'string' && a.decision_note === undefined) a.decision_note = null;
  }
  return state;
}

/** Old outcome vocabulary mapped onto the new result field. */
function legacyResult(outcome: Outcome | undefined): RoundResult {
  switch (outcome) {
    case 'WON':
      return 'WON';
    case 'ABORTED':
      return 'ABORTED';
    case 'TIMEOUT':
    case 'NO_PUZZLE':
      return 'TIME_UP';
    default:
      return 'IN_PROGRESS';
  }
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
      attempts: structuredClone(this.state.attempts),
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

    // State-specific authorization, from the same table the UI mirrors: who may act,
    // and in which phase, with the decided result as the final immutability guard.
    // The role answer comes first (it leaks nothing about the state), the revision
    // check before the phase check, so a phone that is simply behind is told so and
    // resynchronises instead of receiving a confusing “invalid state”.
    const roleVerdict = authorizeRole(req.actor.role, req.action);
    if (!roleVerdict.allowed) {
      if (roleVerdict.reason === 'READ_ONLY') {
        return this.result(false, 'READ_ONLY', 'NGƯỜI THEO DÕI CHỈ XEM ĐƯỢC', this.revision, now);
      }
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

    const round = this.activeRound();
    // The round's own duration is the truth for its clock; the configuration is only
    // the fallback for rows that carry neither a snapshot nor a stored deadline.
    const limit = roundLimitMs(round, this.state.event.config.game_limit_ms);
    const live = round ? liveStatus(round, this.state.attempts, limit, now) : null;
    const result = round ? resultOf(round, this.state.attempts, limit, now) : null;
    const verdict = authorizePhase(req.action, live, result, round);
    if (!verdict.allowed) {
      return this.result(
        false,
        'INVALID_STATE',
        // Say what actually blocked the press: a settled round is not a wrong phase.
        verdict.message
          ?? `Giai đoạn hiện tại (${PHASE_LABEL[live ?? 'WAITING_FOR_TEAM'] ?? live ?? 'chưa có đội'}) không nhận thao tác này`,
        this.revision,
        now,
      );
    }

    const handlers: Partial<Record<ActionType, (r: CommandRequest, t: number) => CommandResult>> = {
      CONFIGURE: this.onConfigure,
      CALL_TEAM: this.onCallTeam,
      CONFIRM_FLOOR2: this.onConfirmFloor2,
      FLOOR2_BYPASS: this.onFloor2Bypass,
      START_GAME: this.onStartGame,
      CLAIM_COMPLETE: this.onClaimComplete,
      VERIFY_ATTEMPT: this.onVerifyAttempt,
      CONFIRM_EXIT: this.onConfirmExit,
      EARLY_EXIT: this.onEarlyExit,
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
    if (!handler) {
      return this.result(false, 'UNKNOWN_ACTION', retiredMessage(req.action) ?? 'Hành động không xác định', this.revision, now);
    }
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
    // V3.1: the round duration is a configuration the supervisor may change at any
    // time, and it only ever applies to the NEXT round. A round that is already
    // running keeps its own snapshot, so changing this can never move a live clock.
    const locked: (keyof EventConfig)[] = ['start_team_number', 'event_name'];
    for (const k of locked) {
      if (started && cfg[k] !== undefined && cfg[k] !== this.state.event.config[k]) {
        return this.result(false, 'INVALID_STATE', 'Không đổi được dữ liệu sự kiện sau khi ca đã chạy', this.revision, now);
      }
    }
    // The session length is retired: it is not editable at all, so no configuration
    // path can bring a 90-minute deadline back into the operating surface (§7.1).
    if (cfg.event_duration_ms !== undefined && cfg.event_duration_ms !== this.state.event.config.event_duration_ms) {
      return this.result(false, 'INVALID_STATE', 'Sự kiện không còn thời lượng phiên để cấu hình', this.revision, now);
    }
    const allowed: (keyof EventConfig)[] = started
      ? ['game_limit_ms', 'prep_allowance_ms', 'reset_target_ms', 'hidden_object_owner']
      : ['event_name', 'game_limit_ms', 'prep_allowance_ms', 'start_team_number', 'reset_target_ms', 'hidden_object_owner'];
    const applied: Record<string, unknown> = {};
    for (const k of allowed) {
      if (cfg[k] !== undefined) {
        if (k === 'hidden_object_owner' && cfg[k] !== 'GATE' && cfg[k] !== 'ROOM305') {
          return this.result(false, 'INVALID_STATE', 'Chủ vật ẩn phải là NPC 1 hoặc NPC 2', this.revision, now);
        }
        if (k === 'game_limit_ms') {
          const verdict = validateRoundDuration(cfg[k]);
          if (!verdict.ok) return this.result(false, 'INVALID_STATE', verdict.message, this.revision, now);
        }
        applied[k] = cfg[k];
        (this.state.event.config as unknown as Record<string, unknown>)[k] = cfg[k];
      }
    }
    if (!started && cfg.start_team_number !== undefined) this.state.event.next_team_number = cfg.start_team_number;
    if (cfg.game_limit_ms !== undefined) {
      applied.round_duration_ms = cfg.game_limit_ms;
      this.commit(req, now, null, null,
        `Đã đặt thời lượng lượt chơi mặc định ${formatClockSec(Number(cfg.game_limit_ms))}`, applied);
      const running = this.activeRound();
      return this.result(true, 'OK', running && running.game_started_at !== null
        ? `ĐÃ LƯU · ${formatClockSec(Number(cfg.game_limit_ms))} · Áp dụng từ lượt tiếp theo`
        : `ĐÃ LƯU · ${formatClockSec(Number(cfg.game_limit_ms))}`, this.revision, now);
    }
    this.commit(req, now, null, null, 'Đã cập nhật cấu hình sự kiện', applied);
    return this.result(true, 'OK', 'Đã lưu cấu hình', this.revision, now);
  }

  /**
   * PHASE 01 — OPERATOR_01 receives the team and sends it up. This is the only
   * dispatch step: the old second LOBBY button (“đã lên tầng 3”) was a duplicate of
   * the floor handover and is gone, so one press can never be counted twice.
   */
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
      status: 'WAITING_FLOOR2_CONFIRMATION',
      stage: STAGE_OF_STATUS.WAITING_FLOOR2_CONFIRMATION,
      called_at: now,
      received_by_role: req.actor.role,
      received_by: req.actor.id,
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
      validated_attempt_id: null,
      puzzle_completed_at: null,
      exit_confirmed_at: null,
      exit_by_role: null,
      exit_by: null,
      exit_reason: null,
      gate_finalized_at: null,
      finalized_by_role: null,
      system_ready_at: null,
      aborted_at: null,
      result: 'IN_PROGRESS',
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
    this.commit(
      req,
      now,
      round,
      'WAITING_FLOOR2_CONFIRMATION',
      `Đã nhận đội ${labelOf(round)} và cho lên tầng 2`,
      {
        override: !decision.allowed ? true : undefined,
        hiding_layout: round.hiding_layout,
        event_clock_started: firstTeam ? true : undefined,
        team_name: round.team_name,
      },
    );
    return this.result(true, 'OK', `${teamSentence(round, 'đã được cho lên tầng 2')}`, this.revision, now);
  }

  /**
   * PHASE 02 — OPERATOR_02 confirms the team physically reached floor 2. Confirmation
   * is a fact about arrival, distinct from the send-off upstairs, and it does not start
   * the countdown.
   */
  private onConfirmFloor2(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    if (round.floor2_confirmed_at !== null) {
      return this.result(true, 'OK', 'Đã xác nhận tầng 2 trước đó', this.revision, now);
    }
    // A stale tap after NPC1 bypassed floor 2 is refused safely: the workflow does not
    // revert, and no fake confirmation is written.
    if (round.floor2_bypassed_at !== null) {
      return this.result(
        false,
        'INVALID_STATE',
        'NPC 1 đã bỏ qua xác nhận tầng 2 — thao tác này không còn hiệu lực',
        this.revision,
        now,
      );
    }
    round.floor2_confirmed_at = now;
    round.floor2_confirmed_by_role = req.actor.role;
    round.floor2_confirmed_by = req.actor.id;
    this.advance(round, 'READY_AT_FLOOR3');
    this.commit(req, now, round, 'READY_AT_FLOOR3', `${teamSentence(round, 'đã đến tầng 2 — đang được hướng dẫn lên tầng 3')}`, {
      operator: req.actor.role,
    });
    return this.result(true, 'OK', 'Đội sắp bắt đầu — NPC 1 có thể bấm BẮT ĐẦU', this.revision, now);
  }

  /**
   * Controlled exception: the team walked straight to floor 3. NPC1 can see that, so
   * NPC1 may skip the floor-2 confirmation — while `floor2Confirmed` stays false. The
   * bypass is its own audited fact, never a substituted confirmation.
   */
  private onFloor2Bypass(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    if (!req.meta?.reason) {
      return this.result(false, 'BLOCKED', 'Bắt buộc nhập lý do bỏ qua tầng 2', this.revision, now);
    }
    if (round.floor2_confirmed_at !== null) {
      return this.result(false, 'INVALID_STATE', 'Tầng 2 đã được xác nhận — không cần bỏ qua', this.revision, now);
    }
    if (round.game_started_at !== null) {
      return this.result(false, 'INVALID_STATE', 'Trận đã bắt đầu', this.revision, now);
    }
    round.floor2_bypassed_at = now;
    round.floor2_bypassed_by_role = req.actor.role;
    round.floor2_bypassed_by = req.actor.id;
    round.floor2_bypass_reason = String(req.meta.reason);
    this.advance(round, 'READY_AT_FLOOR3');
    this.flagReview(round, 'FLOOR2_BYPASS');
    this.commit(req, now, round, 'READY_AT_FLOOR3', `Bỏ qua xác nhận tầng 2 cho ${labelOf(round)}`, {
      bypassed_by: req.actor.role,
      reason: req.meta.reason,
      floor2_confirmed: false,
    });
    return this.result(true, 'OK', 'ĐÃ BỎ QUA TẦNG 2 — đội sẵn sàng ở tầng 3', this.revision, now);
  }

  /**
   * PHASE 04 — one atomic, server-authoritative start. Both instants are persisted, so
   * every device counts down against the same deadline and no browser interval is ever
   * the clock.
   */
  private onStartGame(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    if (round.game_started_at !== null) {
      return this.result(true, 'OK', `Đồng hồ ${formatClockSec(roundLimitMs(round, this.state.event.config.game_limit_ms))} đang chạy`, this.revision, now);
    }
    if (!round.floor2_confirmed_at && !round.floor2_bypassed_at) {
      return this.result(false, 'INVALID_STATE', 'Chưa xác nhận đội ở tầng 3', this.revision, now);
    }
    const decision = evaluateGameStart(this.state.event, now);
    if (!decision.allowed) {
      return this.result(false, 'BLOCKED', decision.message, this.revision, now, {
        requires_override: decision.overridePossible,
      });
    }
    // One atomic snapshot: the duration the configuration carries right now becomes
    // this round's duration for good. Later configuration changes cannot move it.
    const configured = validateRoundDuration(this.state.event.config.game_limit_ms);
    const duration = configured.ok ? configured.ms : DEFAULT_ROUND_DURATION_MS;
    round.round_duration_ms = duration;
    round.game_started_at = now;
    round.deadline_at = now + duration;
    round.started_by_role = req.actor.role;
    round.started_by = req.actor.id;
    this.advance(round, 'RUNNING');
    this.recordPress(round, req, now);
    this.commit(req, now, round, 'RUNNING', `Bắt đầu ${formatClockSec(duration)} cho ${labelOf(round)}`, {
      prep_ms: now - round.called_at,
      deadline_at: round.deadline_at,
      round_duration_ms: duration,
      start_transport_ms: round.start_transport_ms,
    });
    return this.result(true, 'OK', `ĐÃ BẮT ĐẦU ${formatClockSec(duration)} — màn hình đã khoá`, this.revision, now);
  }

  /**
   * PHASE 05 step A — record that the players say they are finished. The claim is the
   * score candidate; the countdown deliberately keeps running, because the claim may be
   * wrong and nobody knows that yet.
   */
  private onClaimComplete(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    const limit = roundLimitMs(round, this.state.event.config.game_limit_ms);
    const deadline = roundDeadlineMs(round, limit, now);
    if (deadline === null) return this.result(false, 'INVALID_STATE', 'Trận chưa bắt đầu', this.revision, now);
    const inTime = isEligibleClaim({ claimed_at: now } as CompletionAttempt, deadline);
    const seq = attemptsOf(this.state.attempts, round.id).length + 1;
    const claimTransport = req.press ? Math.max(0, now - req.press.press_ms) : null;
    const attempt: CompletionAttempt = {
      id: `att_${round.id}_${seq}`,
      round_id: round.id,
      seq,
      claimed_at: now,
      elapsed_ms: Math.max(0, now - (round.game_started_at ?? now)),
      remaining_ms: deadline - now,
      in_time: inTime,
      status: inTime ? 'PENDING' : 'LATE',
      claimed_by_role: req.actor.role,
      claimed_by: req.actor.id,
      verified_by_role: null,
      verified_by: null,
      verified_at: null,
      decision_note: null,
      claim_press_ms: req.press?.press_ms ?? null,
      claim_transport_ms: claimTransport,
      revision: this.revision + 1,
    };
    this.state.attempts.push(attempt);
    if (!inTime) this.flagReview(round, 'LATE_CLAIM');
    else if (claimTransport !== null && claimTransport > this.state.event.config.review_threshold_ms) {
      this.flagReview(round, 'CLAIM_TRANSPORT');
    }
    this.commit(
      req,
      now,
      round,
      liveStatus(round, this.state.attempts, limit, now),
      `Lần ${seq} — ghi nhận báo hoàn thành lúc ${formatClockCs(attempt.elapsed_ms)}${inTime ? ' — chờ kiểm tra' : ' — đến muộn'}`,
      {
        attempt_id: attempt.id,
        claimed_at: now,
        elapsed_ms: attempt.elapsed_ms,
        remaining_ms: attempt.remaining_ms,
        in_time: inTime,
        press_transport_ms: claimTransport,
      },
    );
    return this.result(
      true,
      'OK',
      inTime
        ? `LẦN ${seq} · ${formatClockCs(attempt.elapsed_ms)} — ĐANG KIỂM TRA, đồng hồ vẫn chạy`
        : `LẦN ${seq} · ${formatClockCs(attempt.elapsed_ms)} — GHI NHẬN SAU HẾT GIỜ (không thành thắng)`,
      this.revision,
      now,
    );
  }

  /**
   * PHASE 05 step B — NPC2's decision on one specific recorded attempt.
   *
   * The official time is the attempt's own claim instant, so the seconds NPC2 spent
   * checking the arrangement never penalise the players. The attempt identity is
   * required precisely so a decision can never land on an unrelated historical
   * checkpoint, and a decided attempt is immutable.
   */
  private onVerifyAttempt(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    const limit = roundLimitMs(round, this.state.event.config.game_limit_ms);
    const meta = req.meta as unknown as { attempt_id?: string; decision?: 'VALID' | 'INVALID'; note?: string };
    const deadline = roundDeadlineMs(round, limit, now);
    if (deadline === null) return this.result(false, 'INVALID_STATE', 'Trận chưa bắt đầu', this.revision, now);
    const attempt = this.state.attempts.find((a) => a.id === meta?.attempt_id && a.round_id === round.id);
    if (!attempt) return this.result(false, 'INVALID_STATE', 'Không tìm thấy lần báo hoàn thành', this.revision, now);
    if (attempt.status !== 'PENDING' && attempt.status !== 'LATE') {
      return this.result(true, 'OK', `Lần ${attempt.seq} đã được chốt: ${attempt.status}`, this.revision, now);
    }
    const decision = meta?.decision;
    if (decision !== 'VALID' && decision !== 'INVALID') {
      return this.result(false, 'INVALID_STATE', 'Quyết định không hợp lệ', this.revision, now);
    }
    // A disqualified round is a supervisor decision, never an NPC2 verification,
    // until REVIEW_RESOLVE has accepted the result by name.
    if (round.aborted_at !== null && round.abort_kind === 'misconduct'
      && !(round.review_resolved_at !== null && !round.decertified)) {
      return this.result(false, 'INVALID_STATE', 'Lượt chơi đã bị hủy vì kỷ luật — Quản trị viên phải xét lại kết quả', this.revision, now);
    }

    if (decision === 'INVALID') {
      // Keep the timestamp, keep the countdown, keep the history: only this attempt closes.
      attempt.status = 'INVALID';
      attempt.verified_by_role = req.actor.role;
      attempt.verified_by = req.actor.id;
      attempt.verified_at = now;
      attempt.decision_note = meta?.note ? String(meta.note) : null;
      attempt.revision = this.revision + 1;
      this.commit(
        req,
        now,
        round,
        liveStatus(round, this.state.attempts, limit, now),
        `Lần ${attempt.seq} — CHƯA ĐÚNG, đội tiếp tục chơi`,
        { attempt_id: attempt.id, claimed_at: attempt.claimed_at, decision: 'INVALID' },
      );
      return this.result(true, 'OK', `LẦN ${attempt.seq} CHƯA ĐÚNG — đồng hồ vẫn chạy`, this.revision, now);
    }

    if (!attempt.in_time) {
      return this.result(
        false,
        'INVALID_STATE',
        `Lần ${attempt.seq} được ghi nhận sau hết giờ — không thể thành kết quả thắng`,
        this.revision,
        now,
      );
    }
    // Atomic finalization: one validated claim decides the score, once.
    attempt.status = 'VALID';
    attempt.verified_by_role = req.actor.role;
    attempt.verified_by = req.actor.id;
    attempt.verified_at = now;
    attempt.decision_note = meta?.note ? String(meta.note) : null;
    attempt.revision = this.revision + 1;
    const official = Math.max(0, attempt.claimed_at - (round.game_started_at ?? attempt.claimed_at));
    round.official_duration_ms = official;
    round.validated_attempt_id = attempt.id;
    round.puzzle_completed_at = attempt.claimed_at;
    round.result = 'WON';
    // The team may already have left while NPC2 was checking: a decision must never
    // drag the lifecycle backwards, so only a round still inside moves to exit-waiting.
    if (round.exit_confirmed_at === null) this.advance(round, 'WAITING_FOR_EXIT');
    if (Math.abs(limit - official) <= this.state.event.config.review_threshold_ms) this.flagReview(round, 'CLOSE_FINISH');
    this.commit(
      req,
      now,
      round,
      'WAITING_FOR_EXIT',
      `Lần ${attempt.seq} — CHÍNH XÁC. Kết quả chính thức ${formatClockCs(official)}`,
      {
        attempt_id: attempt.id,
        decision: 'VALID',
        claimed_at: attempt.claimed_at,
        official_duration_ms: official,
        verified_at: now,
        verification_delay_ms: now - attempt.claimed_at,
      },
    );
    return this.result(true, 'OK', `THÀNH CÔNG ${formatClockCs(official)} — chờ đội rời tầng 3`, this.revision, now);
  }

  /**
   * PHASE 07 — the physical exit is its own event. It never touches the completion
   * duration, and it may happen while a claim still awaits verification: the team is
   * not detained by the software, and the review simply stays open.
   */
  private onConfirmExit(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    if (round.exit_confirmed_at !== null) {
      return this.result(true, 'OK', 'Đã xác nhận đội rời tầng 3', this.revision, now);
    }
    const limit = roundLimitMs(round, this.state.event.config.game_limit_ms);
    const pending = pendingEligibleClaims(round, this.state.attempts, limit, now);
    round.exit_confirmed_at = now;
    round.exit_by_role = req.actor.role;
    round.exit_by = req.actor.id;
    // The departure is an authoritative write, so the gameplay result is settled into
    // the row here — the same value the derivation shows on every screen.
    round.result = resultOf(round, this.state.attempts, limit, now);
    this.advance(round, 'EXIT_CONFIRMED');
    this.commit(
      req,
      now,
      round,
      'EXIT_CONFIRMED',
      `${labelOf(round)} đã rời tầng 3 · kết quả ${resultText(round, this.state.attempts, limit, now)}`,
      {
        exited_at: now,
        result: resultOf(round, this.state.attempts, limit, now),
        official_duration_ms: round.official_duration_ms,
        pending_validation: pending.length > 0,
        since_start_ms: round.game_started_at ? now - round.game_started_at : null,
      },
    );
    return this.result(
      true,
      'OK',
      pending.length > 0
        ? 'ĐÃ GHI NHẬN RỜI KHU VỰC · KẾT QUẢ VẪN CHỜ NPC 2 XÁC MINH'
        : 'ĐÃ GHI NHẬN RỜI KHU VỰC — khu vực cần reset',
      this.revision,
      now,
    );
  }

  /**
   * Guarded exception at the gate: the team leaves before solving, or the area is
   * evacuated. This press IS the confirmation that the players are out — NPC1 stands
   * at the door — so it writes the exit stamp and no second press is asked for.
   * It never invents a successful completion time.
   */
  private onEarlyExit(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    if (!req.meta?.reason) {
      return this.result(false, 'BLOCKED', 'Bắt buộc nhập lý do kết thúc sớm', this.revision, now);
    }
    if (round.result === 'WON') {
      // The win is already final: an early-exit press must not erase it.
      return this.result(false, 'INVALID_STATE', 'Kết quả đã chốt THÀNH CÔNG — dùng XÁC NHẬN RỜI TẦNG 3', this.revision, now);
    }
    if (round.aborted_at !== null) {
      return this.result(false, 'INVALID_STATE', 'Lượt chơi đã bị hủy — NPC 1 dùng XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3', this.revision, now);
    }
    const limit = roundLimitMs(round, this.state.event.config.game_limit_ms);
    if (round.game_started_at !== null) {
      round.game_stopped_at = now;
      round.official_duration_ms = null;
    }
    // An early exit IS the confirmed departure: the team is physically out, so the
    // exit stamp is written here rather than waiting for a second press.
    if (round.exit_confirmed_at === null) {
      round.exit_confirmed_at = now;
      round.exit_by_role = req.actor.role;
      round.exit_by = req.actor.id;
    }
    round.aborted_at = now;
    // A gate-side early departure is a safety/operational cancellation, not a
    // verdict on the arrangement: a claim recorded before the deadline may still be
    // verified afterwards and win on its own instant (§4.4).
    round.abort_kind = round.abort_kind ?? 'safety';
    round.exit_reason = String(req.meta.reason);
    round.result = resultOf(round, this.state.attempts, limit, now);
    round.outcome = round.result === 'WON' ? 'WON' : 'ABORTED';
    this.advance(round, 'EXIT_CONFIRMED');
    this.flagReview(round, 'ROUND_ABORTED');
    this.commit(req, now, round, 'EXIT_CONFIRMED', `KẾT THÚC SỚM ${labelOf(round)} · ${ABORT_KIND_LABEL[round.abort_kind]}`, {
      reason: req.meta.reason,
      kind: round.abort_kind,
      result: round.result,
      elapsed_ms: round.game_started_at ? now - round.game_started_at : null,
    });
    return this.result(true, 'OK',
      round.result === 'WON'
        ? `ĐÃ RỜI KHU VỰC · KẾT QUẢ CHÍNH THỨC ${formatClockCs(round.official_duration_ms ?? 0)}`
        : 'LƯỢT CHƠI ĐÃ HỦY — không có kết quả thắng', this.revision, now);
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
    this.commit(
      req,
      now,
      round,
      round.status,
      `${ROLE_SHORT[req.actor.role]} xác nhận xong: ${resetTasksSentence(pending.map((t) => t.task_key))}`,
      {
        tasks: pending.map((t) => t.task_key),
        cycle: round.reset_cycle,
        layout: this.state.event.config.hiding_layout,
        since_exit_ms: round.exit_confirmed_at ? now - round.exit_confirmed_at : null,
      },
    );
    return this.result(true, 'OK', 'Đã ghi nhận reset', this.revision, now);
  }

  /**
   * PHASE 08 — closure. It requires the physical departure, the outstanding physical
   * checks, and a finalised result: a claim still awaiting verification keeps the
   * session open instead of silently dropping it.
   */
  private onGateFinalize(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    if (!isResetWindow(round)) {
      return this.result(false, 'INVALID_STATE', 'Chưa tới giai đoạn reset', this.revision, now);
    }
    if (round.exit_confirmed_at === null) {
      return this.result(false, 'BLOCKED', 'NPC 1 chưa xác nhận đội rời tầng 3', this.revision, now);
    }
    const limit = this.state.event.config.game_limit_ms;
    const result = resultOf(round, this.state.attempts, limit, now);
    if (result === 'IN_PROGRESS' || result === 'PENDING_VALIDATION') {
      return this.result(false, 'BLOCKED', 'Kết quả trận chưa chốt — NPC 2 cần xác minh lần báo hoàn thành', this.revision, now);
    }
    const missing = this.state.reset_tasks.filter(
      (t) => t.round_id === round.id && (t.completed_at === null || t.cycle !== round.reset_cycle),
    );
    if (missing.length > 0) {
      return this.result(
        false,
        'BLOCKED',
        `Chưa thể sẵn sàng: ${resetTasksSentence(missing.map((m) => m.task_key))} chưa được xác nhận.`,
        this.revision,
        now,
      );
    }
    round.result = result;
    round.gate_finalized_at = now;
    round.finalized_by_role = req.actor.role;
    round.system_ready_at = now;
    this.advance(round, 'CLOSED');
    this.commit(req, now, round, 'CLOSED', `${labelOf(round)} đã đóng · SẴN SÀNG nhận đội tiếp theo`, {
      total_reset_ms: round.exit_confirmed_at ? now - round.exit_confirmed_at : null,
      result,
      official_duration_ms: round.official_duration_ms,
      cycle: round.reset_cycle,
    });
    return this.result(true, 'OK', 'SẴN SÀNG nhận đội tiếp theo', this.revision, now);
  }

  /** The object-placement operator records the prepared hiding layout. */
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
   * The optional label of the team on the floor. Only allowed before the countdown
   * starts: while 5:00 runs, session data is frozen (§9).
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
      name ? `Đặt tên đội ${labelOf(round)}: ${name}` : `Đã xoá tên đội ${labelOf(round)}`,
      { team_name: name, previous_team_name: before },
    );
    return this.result(true, 'OK', name ? `Đã đặt tên đội: ${name}` : 'Đã xoá tên đội', this.revision, now);
  }

  /**
   * Reopening a reset invalidates every confirmation of the round by advancing its
   * reset cycle, and revokes readiness so no team can be dispatched on the old
   * acknowledgement set. The original records stay in the audit log.
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
    round.finalized_by_role = null;
    round.system_ready_at = null;
    round.status = 'EXIT_CONFIRMED';
    this.flagReview(round, 'RESET_REOPENED');
    this.commit(req, now, round, 'EXIT_CONFIRMED', `Mở lại reset ${labelOf(round)} · chu kỳ ${round.reset_cycle}`, {
      reason: meta.reason,
      task: meta.task_key ?? 'all',
      cycle: round.reset_cycle,
      invalidated: previous,
    });
    return this.result(true, 'OK', 'Tất cả bước reset phải xác nhận lại', this.revision, now);
  }

  /** Only a supervisor decision releases (or rejects) a disputed result. */
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
    this.commit(req, now, round, round.status,
      `Xét kết quả ${labelOf(round)}: ${meta.decision === 'ACCEPT' ? 'chấp nhận' : 'loại bỏ'}`, {
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
        flowStatus(active) === 'EXIT_CONFIRMED'
          ? 'Chưa hoàn tất reset và đóng lượt chơi hiện tại'
          : `${labelOf(active)} vẫn đang trong khu vực — không cắt đồng hồ`,
        this.revision,
        now,
      );
    }
    this.state.event.event_ended_at = now;
    this.commit(req, now, null, 'ENDED', 'Sự kiện đã kết thúc (đóng có kiểm soát)', { overtime_ms: 0 });
    return this.result(true, 'OK', 'SỰ KIỆN KẾT THÚC', this.revision, now);
  }

  /**
   * Supervisor-side cancellation. It cancels the *round*; it never speaks for the
   * players' bodies (V3.1 §4.2): no exit stamp is written here, so NPC1 still has to
   * confirm the team is out of floor 3 before the area may be prepared again.
   *
   * `kind` decides what happens to an outstanding claim: a `misconduct` cancellation
   * disqualifies and can only be reopened by REVIEW_RESOLVE, while `technical` and
   * `safety` leave a claim recorded before the deadline verifiable by NPC2 (§4.4).
   */
  private onAbortRound(req: CommandRequest, now: number): CommandResult {
    const round = this.requireActive(req, now);
    if (!round) return this.invalidRound(req, now);
    const reason = String(req.meta?.reason ?? '').trim();
    if (!reason) {
      return this.result(false, 'BLOCKED', 'Bắt buộc nhập lý do dừng khẩn cấp', this.revision, now);
    }
    const kind = String(req.meta?.kind ?? '') as AbortKind;
    if (!ABORT_KINDS.includes(kind)) {
      return this.result(false, 'INVALID_STATE', 'Chọn loại hủy: Sự cố kỹ thuật, An toàn · y tế hoặc Kỷ luật', this.revision, now);
    }
    if (round.aborted_at !== null) {
      return this.result(true, 'OK', 'Lượt chơi đã bị hủy trước đó', this.revision, now);
    }
    const limit = roundLimitMs(round, this.state.event.config.game_limit_ms);
    round.aborted_at = now;
    round.abort_kind = kind;
    round.abort_reason = reason;
    // The clock stops on a cancellation, and nothing can start it again.
    if (round.game_started_at !== null) round.game_stopped_at = now;
    const validated = hasValidatedAttempt(round) || attemptsOf(this.state.attempts, round.id).some((a) => a.status === 'VALID');
    if (kind === 'misconduct') {
      // Disqualified, but the recorded facts survive: the claim rows, its timestamp
      // and the time it would have scored stay on the row so a supervisor's REVIEW_RESOLVE
      // can decide on the real numbers instead of a rewritten history (§4.4, §10.2).
      round.result = 'ABORTED';
      round.outcome = 'ABORTED';
      round.decertified = true;
    } else if (validated) {
      // A win already decided by a legitimate claim is not erased by an operational
      // cancellation; the abort itself still stands in the history and the review.
      round.result = 'WON';
      round.outcome = 'WON';
    } else {
      round.official_duration_ms = null;
      round.result = 'ABORTED';
      round.outcome = 'ABORTED';
    }
    // Gameplay is over, the team is still inside: the lifecycle stops at exit-waiting.
    this.advance(round, 'WAITING_FOR_EXIT');
    this.flagReview(round, 'ROUND_ABORTED');
    this.commit(req, now, round, 'WAITING_FOR_EXIT', `HỦY LƯỢT ${labelOf(round)} · ${ABORT_KIND_LABEL[kind]}`, {
      reason,
      kind,
      result: round.result,
      pending_validation: pendingEligibleClaims(round, this.state.attempts, limit, now).length > 0,
      elapsed_ms: round.game_started_at ? now - round.game_started_at : null,
    });
    return this.result(true, 'OK',
      'LƯỢT CHƠI ĐÃ HỦY — NPC 1 vẫn cần xác nhận đội đã rời tầng 3', this.revision, now);
  }

  /**
   * Elevated correction for an operator mistake. It requires a reason, keeps the
   * original value in the audit entry, and never rewrites a claim: correcting an
   * attempt timestamp means recording the decision against the right attempt, which
   * this does not do — so the claim rows themselves stay out of reach.
   */
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
    const correctable: (keyof Round)[] = ['game_started_at', 'deadline_at', 'exit_confirmed_at', 'floor2_confirmed_at'];
    if (!field || !correctable.includes(field)) {
      return this.result(false, 'INVALID_STATE', 'Trường không được phép hiệu chỉnh', this.revision, now);
    }
    let value: number | null = null;
    if (meta.value_ms !== null && meta.value_ms !== undefined) {
      value = Number(meta.value_ms);
      if (!Number.isFinite(value)) return this.result(false, 'INVALID_STATE', 'Thời gian không hợp lệ', this.revision, now);
    }
    const before = round[field] as number | null;
    if (field === 'game_started_at' && value !== null) {
      // Moving START moves the deadline with it, so the window keeps its 300 seconds.
      round.deadline_at = value + this.state.event.config.game_limit_ms;
    }
    (round as unknown as Record<string, unknown>)[field] = value;
    // A duration was scored from a claim: re-derive it against the corrected start
    // instead of trusting a wall-clock recomputation.
    if (field === 'game_started_at' && round.validated_attempt_id !== null) {
      const attempt = this.state.attempts.find((a) => a.id === round.validated_attempt_id);
      if (attempt && value !== null) round.official_duration_ms = Math.max(0, attempt.claimed_at - value);
    }
    this.flagReview(round, 'CORRECTED');
    this.commit(req, now, round, round.status, `Hiệu chỉnh ${fieldLabel(field)}`, {
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

  /**
   * Move the round to the next lifecycle position. `stage` only ever grows, so the
   * progress line can show how far a team got even after an exceptional branch.
   */
  private advance(round: Round, to: FlowStatus): void {
    round.status = to;
    round.stage = Math.max(round.stage, STAGE_OF_STATUS[to]);
  }

  private requiredTasks(): { key: ResetTaskKey; role: Role }[] {
    const owner = this.state.event.config.hidden_object_owner;
    return [
      { key: 'hidden_objects', role: owner },
      { key: 'hallway', role: 'GATE' },
      { key: 'room', role: 'ROOM305' },
    ];
  }

  /**
   * Stores the gap between the operator's physical press (client-calibrated instant)
   * and the authoritative server commit. The official timestamp stays the server value;
   * a large gap makes the result disputed rather than silently accepted.
   */
  private recordPress(round: Round, req: CommandRequest, now: number): void {
    const press = req.press;
    const delay = press ? Math.max(0, now - press.press_ms) : null;
    round.start_press_ms = press?.press_ms ?? null;
    round.start_transport_ms = delay;
    if (delay !== null && delay > this.state.event.config.review_threshold_ms) this.flagReview(round, 'START_TRANSPORT');
  }

  private flagReview(round: Round, reason: string): void {
    if (!round.review_reasons.includes(reason)) round.review_reasons.push(reason);
    round.needs_review = true;
    round.review_resolved_at = null;
  }

  private operatorStates(): OperatorState[] {
    const roles: Role[] = ['LOBBY', 'CORRIDOR', 'GATE', 'ROOM305', 'SUPERVISOR'];
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

export { deriveEventStatus, derivePhase, flowStatus, gameElapsedMs, liveStatus, resultOf, roundDeadlineMs };

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

/** “#004 · PHANTOM 05”, the identity every shared status sentence must carry. */
function labelOf(r: Round): string {
  return r.team_name ? `#${pad3(r.team_number)} · ${r.team_name}` : `#${pad3(r.team_number)}`;
}

/** The one sentence the whole room reads after a phase press. */
function teamSentence(r: Round, predicate: string): string {
  return `Đội ${labelOf(r)} ${predicate}`;
}

function resultText(r: Round, attempts: CompletionAttempt[], limit: number, now: number): string {
  switch (resultOf(r, attempts, limit, now)) {
    case 'WON':
      return `THÀNH CÔNG ${formatClockCs(r.official_duration_ms ?? 0)}`;
    case 'TIME_UP':
      return 'HẾT GIỜ';
    case 'PENDING_VALIDATION':
      return 'ĐANG CHỜ XÁC MINH';
    case 'ABORTED':
      return 'LƯỢT CHƠI ĐÃ HỦY';
    default:
      return 'ĐANG DIỄN RA';
  }
}

/** The correctable columns named the way the operator sees them (§10.2). */
function fieldLabel(field: keyof Round | string): string {
  switch (field) {
    case 'game_started_at': return 'mốc bắt đầu lượt chơi';
    case 'deadline_at': return 'mốc hết giờ';
    case 'exit_confirmed_at': return 'mốc đội rời tầng 3';
    case 'floor2_confirmed_at': return 'mốc xác nhận tầng 2';
    default: return String(field);
  }
}

/** Human-readable duration for labels and messages (MM:SS). */
export function formatClockSec(ms: number): string {
  const abs = Math.max(0, Math.floor(ms / 1000) * 1000);
  const m = Math.floor(abs / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * The single duration rule shared by the engine, the UI and the tests: a round is
 * between 00:01 and 59:59, whole seconds, and never 00:00 (V3.1 §7.3). PostgreSQL
 * enforces the same bounds in `sc._valid_round_duration`.
 */
export function validateRoundDuration(value: unknown): { ok: boolean; message: string; ms: number } {
  const ms = Number(value);
  if (!Number.isFinite(ms) || Number.isNaN(ms)) {
    return { ok: false, message: 'Thời lượng không hợp lệ', ms: 0 };
  }
  if (ms !== Math.round(ms)) {
    return { ok: false, message: 'Thời lượng phải là số giây nguyên', ms: 0 };
  }
  if (ms % 1000 !== 0) {
    return { ok: false, message: 'Thời lượng tính theo giây, không theo phần trăm giây', ms: 0 };
  }
  if (ms < ROUND_DURATION_MIN_MS) {
    return { ok: false, message: 'Thời lượng lượt chơi phải lớn hơn 00:00', ms: 0 };
  }
  if (ms > ROUND_DURATION_MAX_MS) {
    return { ok: false, message: `Thời lượng tối đa là ${formatClockSec(ROUND_DURATION_MAX_MS)}`, ms: 0 };
  }
  return { ok: true, message: '', ms };
}

/** Human-readable elapsed for messages and the attempt list (MM:SS.hh). */
export function formatClockCs(ms: number): string {
  const abs = Math.max(0, ms);
  const m = Math.floor(abs / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  const cs = Math.floor((abs % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * What a retired button used to do, and where that job lives now. A stale client
 * must get an explanation, not a silent success that moves the state machine.
 */
function retiredMessage(action: ActionType): string | null {
  const map: Partial<Record<ActionType, string>> = {
    TEAM_UPSTAIRS: 'Thao tác đã gộp vào NHẬN ĐỘI & CHO LÊN TẦNG 2',
    HALLWAY_PROGRESS: 'Hành lang không còn điều khiển lượt chơi',
    ROOM_REACHED: 'Đội đến phòng 305 do NPC 2 ghi nhận khi báo hoàn thành',
    PUZZLE_COMPLETE: 'Dùng GHI NHẬN BÁO HOÀN THÀNH rồi kiểm tra từng lần',
    RETURN_START: 'Việc quay lại cửa vào không còn là một bước bấm riêng',
    GAME_STOP: 'NPC 1 dùng XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3',
    OVERTIME_STARTED: 'Không còn nghiệp vụ phiên 90 phút để gia hạn',
    OVERRIDE_ADMIT: 'Không còn mốc cutoff phiên để vượt qua',
    EVENT_CLOSED: 'Đóng sự kiện do Quản trị viên thực hiện bằng ĐÓNG SỰ KIỆN CÓ KIỂM SOÁT',
    SESSION_RESTORE: 'Không còn phiên 90 phút để khôi phục',
    GAME_PAUSE: 'Đồng hồ lượt chơi không còn tạm dừng được',
    GAME_RESUME: 'Đồng hồ lượt chơi không còn chạy lại được',
    GAME_RESET: 'Đồng hồ lượt chơi không thể reset — chỉ KẾT THÚC SỚM có lý do',
    START_EVENT: 'Sự kiện mở bằng lần nhận đội đầu tiên',
  };
  return map[action] ?? null;
}
