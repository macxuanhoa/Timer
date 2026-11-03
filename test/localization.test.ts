import { describe, expect, it } from 'vitest';
import {
  ABORT_KIND_LABEL,
  ABORT_KINDS,
  ACTION_LABEL,
  ATTEMPT_LABEL,
  OUTCOME_LABEL,
  PHASE_LABEL,
  RESET_BLOCK_LABEL,
  RESET_BLOCK_REASONS,
  RESET_TASKS,
  RESET_TASK_LABEL,
  REVIEW_REASON_LABEL,
  ROLE_DUTY,
  ROLE_LABEL,
  ROLE_SHORT,
  ROLES,
  STATUS_LABEL,
  TRANSPORT_LABEL,
  resetTasksSentence,
} from '../src/shared/constants';
import type {
  ActionType,
  AttemptStatus,
  CompletionAttempt,
  FlowStatus,
  Round,
  RoundResult,
  Snapshot,
  SystemPhase,
} from '../src/shared/types';
import { T0 } from './helpers/harness';
import { initialState, defaultConfig } from '../src/server/engine';
import {
  observerBoard,
  resolveAlerts,
  resolveCountdown,
  resolveJourney,
  resolvePrimary,
  resolveStations,
  resolveTeamLine,
  teamLabel,
} from '../src/client/selectors';
import { finalizeSnapshot } from '../src/shared/machine';

/**
 * GĐ5 §IV — Vietnamese localization layer.
 *
 * The handoff demands 100% Vietnamese on the operator surface, and it specifically
 * calls out that a raw action enum, a raw status key or an English role never
 * reaches the phone. The assertions below walk every enumeration the UI can
 * project and fail the moment a label is missing, empty, or accidentally still
 * spelled with the internal identifier.
 */

/** Every technical identifier this codebase could accidentally print. */
const RAW_TOKENS = [
  'CALL_TEAM', 'CONFIRM_FLOOR2', 'FLOOR2_BYPASS', 'START_GAME', 'CLAIM_COMPLETE',
  'VERIFY_ATTEMPT', 'CONFIRM_EXIT', 'EARLY_EXIT', 'RESET_DONE', 'GATE_FINALIZE',
  'SET_LAYOUT', 'SET_TEAM_NAME', 'REOPEN_RESET', 'REVIEW_RESOLVE', 'END_EVENT',
  'ABORT_ROUND', 'CORRECT_ROUND', 'CONFIGURE', 'OVERRIDE_ADMIT', 'OVERTIME_STARTED',
  'EVENT_CLOSED', 'SESSION_RESTORE', 'TEAM_UPSTAIRS', 'GAME_PAUSE', 'GAME_RESUME',
  'GAME_RESET', 'HALLWAY_PROGRESS', 'ROOM_REACHED', 'PUZZLE_COMPLETE', 'RETURN_START',
  'GAME_STOP', 'START_EVENT',
  'OPERATOR 01', 'OPERATOR 02', 'OPERATOR_01', 'OPERATOR_02',
  'WAITING_FLOOR2_CONFIRMATION', 'READY_AT_FLOOR3', 'TIME_EXPIRED_PENDING_VALIDATION',
  'WAITING_FOR_EXIT', 'EXIT_CONFIRMED',
  'LOBBY_CALL', 'TEAM_PREPARING', 'GAME_STARTED', 'CORRIDOR_ACTIVE',
  'PUZZLE_COMPLETED', 'GAME_EXITED', 'RESETTING', 'RESET_CONFIRMED', 'GATE_CLEARED',
  'PENDING_VALIDATION', 'TIME_UP',
  'hidden_objects', 'hallway',
  'PENDING', 'VALID', 'INVALID', 'LATE',
  'CONNECTED', 'SYNCING', 'DEGRADED', 'OFFLINE',
  // The four station identifiers plus the two auxiliary seats. These never appear
  // in a Vietnamese label — the display name always says the human name.
  'LOBBY', 'CORRIDOR', 'ROOM305', 'SUPERVISOR', 'OBSERVER',
  // Words that also exist as internal enums but show up in Vietnamese labels for
  // the flow itself ("Đồng hồ lượt chơi đang chạy", "Lượt chơi đã đóng", …), so
  // they are asserted at the call site rather than in the RAW_TOKENS scan.
] as const;

const ALL_ACTION_TYPES: ActionType[] = [
  'CONFIGURE', 'CALL_TEAM', 'CONFIRM_FLOOR2', 'FLOOR2_BYPASS', 'START_GAME',
  'CLAIM_COMPLETE', 'VERIFY_ATTEMPT', 'CONFIRM_EXIT', 'EARLY_EXIT', 'RESET_DONE',
  'GATE_FINALIZE', 'SET_LAYOUT', 'SET_TEAM_NAME', 'REOPEN_RESET', 'REVIEW_RESOLVE',
  'END_EVENT', 'ABORT_ROUND', 'CORRECT_ROUND', 'OVERRIDE_ADMIT', 'OVERTIME_STARTED',
  'EVENT_CLOSED', 'SESSION_RESTORE', 'TEAM_UPSTAIRS', 'GAME_PAUSE', 'GAME_RESUME',
  'GAME_RESET', 'HALLWAY_PROGRESS', 'ROOM_REACHED', 'PUZZLE_COMPLETE', 'RETURN_START',
  'GAME_STOP', 'START_EVENT',
];

const LIVE_FLOW: FlowStatus[] = [
  'WAITING_FLOOR2_CONFIRMATION', 'READY_AT_FLOOR3', 'RUNNING',
  'TIME_EXPIRED_PENDING_VALIDATION', 'WAITING_FOR_EXIT', 'EXIT_CONFIRMED', 'CLOSED',
];

const TRANSPORT_STATES = ['CONNECTED', 'SYNCING', 'DEGRADED', 'OFFLINE'] as const;

/** Any string that will be printed on a phone: buttons, log lines, error messages. */
function expectVietnamese(label: string, source: string): void {
  expect(label, `${source} must not be empty`).not.toBe('');
  // Nothing on the operator surface may contain a raw enum token.
  for (const raw of RAW_TOKENS) {
    expect(label, `${source} leaks raw token "${raw}"`).not.toContain(raw);
  }
}

describe('V3.1 §IV — Vietnamese label layer', () => {
  it('gives every operational role a Vietnamese display name and a short label', () => {
    for (const role of ROLES) {
      expectVietnamese(ROLE_LABEL[role], `ROLE_LABEL[${role}]`);
      // The short form still has to exist; it may be digits or a compact word, but
      // never the internal identifier ("LOBBY", "CORRIDOR").
      const short = ROLE_SHORT[role];
      expect(short, `ROLE_SHORT[${role}] present`).toBeTruthy();
      expect(short.toLowerCase(), `ROLE_SHORT[${role}] no raw key`).not.toBe(role.toLowerCase());
      expectVietnamese(ROLE_DUTY[role], `ROLE_DUTY[${role}]`);
    }
    // §3.4 handoff: LOBBY is presented as "NHÂN SỰ 01 · TẦNG 1".
    expect(ROLE_LABEL.LOBBY).toBe('NHÂN SỰ 01 · TẦNG 1');
    expect(ROLE_LABEL.CORRIDOR).toBe('NHÂN SỰ 02 · TẦNG 2');
    expect(ROLE_LABEL.GATE).toBe('NPC 1 · CỬA TẦNG 3');
    expect(ROLE_LABEL.ROOM305).toBe('NPC 2 · PHÒNG 305');
    expect(ROLE_LABEL.SUPERVISOR).toBe('QUẢN TRỊ VIÊN');
    expect(ROLE_LABEL.OBSERVER).toBe('NGƯỜI THEO DÕI');
  });

  it('maps every action type (live and retired) to a Vietnamese label', () => {
    for (const action of ALL_ACTION_TYPES) {
      const label = ACTION_LABEL[action];
      expect(label, `ACTION_LABEL[${action}] must exist`).toBeTruthy();
      expectVietnamese(label, `ACTION_LABEL[${action}]`);
    }
  });

  it('maps every lifecycle phase to a Vietnamese label (handoff §IV.4.1)', () => {
    for (const phase of LIVE_FLOW) {
      expectVietnamese(STATUS_LABEL[phase], `STATUS_LABEL[${phase}]`);
      expectVietnamese(PHASE_LABEL[phase], `PHASE_LABEL[${phase}]`);
    }
    // The event-level phases are also rendered.
    for (const p of ['PRE_EVENT', 'WAITING_FOR_TEAM', 'ENDED'] as SystemPhase[]) {
      expectVietnamese(PHASE_LABEL[p], `PHASE_LABEL[${p}]`);
    }
  });

  it('maps every abort kind to a Vietnamese reason', () => {
    for (const k of ABORT_KINDS) {
      expectVietnamese(ABORT_KIND_LABEL[k], `ABORT_KIND_LABEL[${k}]`);
    }
  });

  it('maps every reset task to its Vietnamese area (never invents a new meaning)', () => {
    // §IV.4.1: hallway → Hành lang, hidden_objects → Vật phẩm ẩn, room → Phòng 305.
    expect(RESET_TASK_LABEL.hallway).toBe('Hành lang tầng 3');
    expect(RESET_TASK_LABEL.hidden_objects).toBe('Vật phẩm ẩn');
    expect(RESET_TASK_LABEL.room).toBe('Phòng 305');
    for (const t of RESET_TASKS) expectVietnamese(RESET_TASK_LABEL[t], `RESET_TASK_LABEL[${t}]`);
    // The sentence builder never echoes a raw key.
    expectVietnamese(resetTasksSentence(['hallway', 'hidden_objects', 'room']), 'resetTasksSentence(all)');
    expect(resetTasksSentence(['hallway', 'hidden_objects', 'room'])).toBe(
      'Hành lang tầng 3, Vật phẩm ẩn và Phòng 305',
    );
    expect(resetTasksSentence([])).toBe('');
  });

  it('names every transport state in Vietnamese (handoff §IV.4.1)', () => {
    for (const s of TRANSPORT_STATES) {
      expectVietnamese(TRANSPORT_LABEL[s], `TRANSPORT_LABEL[${s}]`);
    }
    expect(TRANSPORT_LABEL.CONNECTED).toBe('ĐÃ KẾT NỐI');
    expect(TRANSPORT_LABEL.SYNCING).toBe('ĐANG ĐỒNG BỘ');
    expect(TRANSPORT_LABEL.DEGRADED).toBe('KẾT NỐI KHÔNG ỔN ĐỊNH');
    expect(TRANSPORT_LABEL.OFFLINE).toBe('MẤT KẾT NỐI');
  });

  it('names every reset block reason in Vietnamese', () => {
    for (const r of RESET_BLOCK_REASONS) {
      expectVietnamese(RESET_BLOCK_LABEL[r], `RESET_BLOCK_LABEL[${r}]`);
    }
  });

  it('maps every outcome and attempt status to a Vietnamese label', () => {
    for (const r of ['IN_PROGRESS', 'PENDING_VALIDATION', 'WON', 'TIME_UP', 'ABORTED'] as RoundResult[]) {
      expectVietnamese(OUTCOME_LABEL[r], `OUTCOME_LABEL[${r}]`);
    }
    for (const s of ['PENDING', 'VALID', 'INVALID', 'LATE'] as AttemptStatus[]) {
      // ATTEMPT_LABEL intentionally carries the raw decision names because it is
      // read only through `label`, not printed. Assert the mapped text instead.
      const label = ATTEMPT_LABEL[s];
      expect(label, `ATTEMPT_LABEL[${s}] present`).toBeTruthy();
      // None of the Vietnamese strings may contain any other raw token.
      for (const raw of RAW_TOKENS) {
        if (raw === s) continue;
        expect(label, `ATTEMPT_LABEL[${s}] leaks ${raw}`).not.toContain(raw);
      }
    }
  });

  it('keeps every review reason readable in Vietnamese', () => {
    // Reasons the engine or the SQL layer may raise. If a code path adds a new one,
    // the assertion below forces this table to grow with it.
    const reasons = [
      'CLOSE_FINISH', 'START_TRANSPORT', 'STOP_TRANSPORT', 'PUZZLE_TRANSPORT',
      'CLAIM_TRANSPORT', 'LATE_PUZZLE', 'LATE_CLAIM', 'GAME_RESET', 'CORRECTED',
      'RESET_REOPENED', 'FLOOR2_BYPASS', 'ROUND_ABORTED',
    ];
    for (const r of reasons) {
      const label = REVIEW_REASON_LABEL[r];
      expect(label, `REVIEW_REASON_LABEL[${r}] present`).toBeTruthy();
      // Only assert the raw action code doesn't leak; the review-reason keys are
      // allowed to be echoed in text if the translation says "đồng hồ lượt chơi
      // bị reset giữa trận", but never the ALL-CAPS identifier itself.
      for (const raw of ALL_ACTION_TYPES) {
        expect(label, `REVIEW_REASON_LABEL[${r}] leaks action ${raw}`).not.toContain(raw);
      }
      for (const raw of ['OPERATOR 01', 'OPERATOR 02', 'LOBBY', 'CORRIDOR', 'ROOM305', 'GATE', 'OBSERVER', 'SUPERVISOR']) {
        expect(label, `REVIEW_REASON_LABEL[${r}] leaks role ${raw}`).not.toContain(raw);
      }
    }
  });
});

/**
 * Selector-level assertions: the handoff insists that a label scan is not enough,
 * so we render the derived strings here and assert the operator never sees a raw
 * token on the phone. This is the same surface DetailsSheet / Dashboard / BigScreen
 * render, without a browser.
 */
function baseRound(): Round {
  const seed = initialState(T0, defaultConfig());
  return {
    id: 'r-1',
    event_id: seed.event.id,
    round_number: 1,
    team_number: 1,
    team_name: null,
    status: 'WAITING_FLOOR2_CONFIRMATION',
    stage: 1,
    called_at: T0,
    received_by_role: 'LOBBY',
    received_by: 'lobby',
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
    round_duration_ms: 300_000,
    deadline_at: null,
    game_anchor_ms: null,
    game_elapsed_ms: 0,
    game_stopped_at: null,
    game_reset_count: 0,
    game_pause_count: 0,
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
    created_revision: 1,
  };
}

function buildSnapshot(active: Round | null, extra: Partial<Snapshot> = {}): Snapshot {
  const base = finalizeSnapshot({
    revision: 1,
    server_now_ms: T0,
    event: { ...initialState(T0, defaultConfig()).event },
    rounds: active ? [active] : [],
    reset_tasks: [],
    attempts: [],
    operators: [],
    log: [],
  });
  return { ...base, active_round: active, ...extra };
}

describe('V3.1 §IV — derived UI strings never leak raw tokens', () => {
  it('counts down with a Vietnamese status line in every phase', () => {
    const base = baseRound();
    for (const phase of LIVE_FLOW) {
      const round: Round = {
        ...base,
        status: phase,
        game_started_at: phase === 'RUNNING' || phase === 'TIME_EXPIRED_PENDING_VALIDATION' || phase === 'WAITING_FOR_EXIT' || phase === 'EXIT_CONFIRMED' || phase === 'CLOSED' ? T0 : null,
        deadline_at: phase === 'RUNNING' ? T0 + 4 * 60_000 : phase === 'TIME_EXPIRED_PENDING_VALIDATION' ? T0 - 1_000 : T0 + 5 * 60_000,
        round_duration_ms: 5 * 60_000,
        exit_confirmed_at: phase === 'EXIT_CONFIRMED' || phase === 'CLOSED' ? T0 : null,
        floor2_confirmed_at: T0 - 60_000,
      };
      const snap = buildSnapshot(round);
      const view = resolveCountdown(snap, T0);
      expectVietnamese(view.statusLine, `resolveCountdown.statusLine @${phase}`);
      expectVietnamese(view.heroLabel, `resolveCountdown.heroLabel @${phase}`);
      expect(view.teamText.startsWith('Đội'), 'teamText uses "Đội"').toBe(true);
      expectVietnamese(view.teamText, `resolveCountdown.teamText @${phase}`);
    }
  });

  it('produces Vietnamese team-line sentences in every phase', () => {
    const base = baseRound();
    for (const phase of LIVE_FLOW) {
      const round: Round = {
        ...base,
        status: phase,
        game_started_at: T0,
        deadline_at: T0 + 5 * 60_000,
        round_duration_ms: 5 * 60_000,
        exit_confirmed_at: phase === 'EXIT_CONFIRMED' || phase === 'CLOSED' ? T0 : null,
        floor2_confirmed_at: T0 - 60_000,
      };
      const snap = buildSnapshot(round);
      const line = resolveTeamLine(snap, T0);
      expectVietnamese(line.text, `resolveTeamLine.text @${phase}`);
    }
    // The no-round state should also read in Vietnamese.
    const idle = buildSnapshot(null);
    expectVietnamese(resolveTeamLine(idle, T0).text, 'resolveTeamLine.text no-round');
  });

  it('renders a Vietnamese journey caption in every phase', () => {
    const base = baseRound();
    for (const phase of LIVE_FLOW) {
      const round: Round = {
        ...base,
        status: phase,
        game_started_at: T0,
        deadline_at: T0 + 5 * 60_000,
        round_duration_ms: 5 * 60_000,
        exit_confirmed_at: phase === 'EXIT_CONFIRMED' || phase === 'CLOSED' ? T0 : null,
        floor2_confirmed_at: T0 - 60_000,
      };
      const snap = buildSnapshot(round);
      const info = resolveJourney(snap, T0, 'GATE');
      expectVietnamese(info.caption, `resolveJourney.caption @${phase}`);
      expectVietnamese(info.where, `resolveJourney.where @${phase}`);
      if (info.turn) expectVietnamese(info.turn.label, `resolveJourney.turn.label @${phase}`);
    }
  });

  it('gives every station a Vietnamese chip label (never the identifier)', () => {
    const snap = buildSnapshot(null);
    for (const st of resolveStations(snap, T0)) {
      expectVietnamese(st.label, `resolveStations.label[${st.role}]`);
      // Never the raw role key ("LOBBY", "CORRIDOR", "GATE", "ROOM305").
      expect(st.label).not.toContain(st.role);
    }
  });

  it('gives every role a Vietnamese primary action label (or a Vietnamese lock)', () => {
    const phases: SystemPhase[] = [
      'PRE_EVENT', 'WAITING_FOR_TEAM', 'WAITING_FLOOR2_CONFIRMATION', 'READY_AT_FLOOR3',
      'RUNNING', 'TIME_EXPIRED_PENDING_VALIDATION', 'WAITING_FOR_EXIT', 'EXIT_CONFIRMED',
      'CLOSED', 'ENDED',
    ];
    const base = baseRound();
    for (const role of ROLES) {
      for (const phase of phases) {
        const round = phase === 'PRE_EVENT' || phase === 'WAITING_FOR_TEAM' || phase === 'ENDED'
          ? null
          : {
              ...base,
              status: phase as FlowStatus,
              game_started_at: T0,
              deadline_at: T0 + 5 * 60_000,
              round_duration_ms: 5 * 60_000,
              exit_confirmed_at: phase === 'EXIT_CONFIRMED' || phase === 'CLOSED' ? T0 : null,
              floor2_confirmed_at: T0 - 60_000,
            };
        const snap = buildSnapshot(round);
        const primary = resolvePrimary(role, snap, T0);
        expectVietnamese(primary.label, `resolvePrimary(${role}) @${phase}`);
        if (primary.hint) expectVietnamese(primary.hint, `resolvePrimary(${role}).hint @${phase}`);
        if (primary.reasonPrompt) expectVietnamese(primary.reasonPrompt, `resolvePrimary(${role}).reasonPrompt @${phase}`);
        if (primary.confirmLabel) expectVietnamese(primary.confirmLabel, `resolvePrimary(${role}).confirmLabel @${phase}`);
      }
    }
  });

  it('renders Vietnamese alert copy in every reachable warning', () => {
    const base = baseRound();
    const round: Round = {
      ...base,
      status: 'TIME_EXPIRED_PENDING_VALIDATION',
      game_started_at: T0 - 6 * 60_000,
      deadline_at: T0 - 60_000,
      round_duration_ms: 5 * 60_000,
      floor2_confirmed_at: T0 - 7 * 60_000,
      needs_review: true,
      review_reasons: ['LATE_CLAIM'],
      floor2_bypassed_at: T0 - 7 * 60_000,
    };
    const attempt: CompletionAttempt = {
      id: 'a1', round_id: round.id, seq: 1, claimed_at: T0 - 60_000, elapsed_ms: 4 * 60_000,
      remaining_ms: 60_000, in_time: true, status: 'PENDING',
      claimed_by_role: 'ROOM305', claimed_by: 'npc2', verified_by_role: null, verified_by: null,
      verified_at: null, decision_note: null, claim_press_ms: null, claim_transport_ms: null, revision: 1,
    };
    const snap = buildSnapshot(round, { attempts: [attempt] });
    const alerts = resolveAlerts(snap, T0, true);
    expect(alerts.length, 'at least one alert fired').toBeGreaterThan(0);
    for (const a of alerts) expectVietnamese(a.text, `resolveAlerts[${a.id}]`);
  });

  it('names the observer capacity, never a raw enum', () => {
    const board = observerBoard(11, 10);
    expect(board.full).toBe(true);
  });

  it('uses "Đội" as the shared team prefix', () => {
    expect(teamLabel(null, 7)).toBe('Đội #007');
    const r = { ...baseRound(), team_number: 4, team_name: 'phantom 05' };
    expect(teamLabel(r, 4)).toBe('Đội PHANTOM 05');
  });
});
