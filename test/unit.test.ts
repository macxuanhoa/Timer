import { describe, expect, it } from 'vitest';
import {
  formatClockMs,
  formatClockSec,
  formatDuration,
  formatSeconds,
  leaderboard,
  qualifiesForLeaderboard,
  roundMetrics,
} from '../src/shared/metrics';
import { OBSERVER_CAPACITY, RESET_TASKS, ROLES } from '../src/shared/constants';
import {
  ROLE_ACTIONS,
  authorize,
  evaluateDispatch,
  evaluateGameStart,
  finalizeSnapshot,
  isAllowed,
  resultOf,
} from '../src/shared/machine';
import { observerBoard, resolveBigScreen, resolveCountdown, resolveEmergency, resolveJourney, resolvePrimary } from '../src/client/selectors';
import { FakeClock, type CompletionAttempt, type Round, type Snapshot } from '../src/shared/types';
import { ScreamEngine, defaultConfig, initialState } from '../src/server/engine';
import { T0 } from './helpers/harness';

/**
 * The buttons that used to drive the relay, plus the four actions that existed only
 * to serve the retired 90-minute session clock (V3.1 §7.1). Nobody may press them
 * any more, and the permission table says so instead of the phase table.
 */
const RETIRED = ['TEAM_UPSTAIRS', 'GAME_PAUSE', 'GAME_RESUME', 'GAME_RESET', 'HALLWAY_PROGRESS', 'ROOM_REACHED', 'PUZZLE_COMPLETE', 'RETURN_START', 'GAME_STOP', 'START_EVENT', 'OVERTIME_STARTED', 'OVERRIDE_ADMIT', 'EVENT_CLOSED', 'SESSION_RESTORE'];

describe('unit — formats, permissions and boundaries', () => {
  it('formats clocks with the right precision per phase', () => {
    expect(formatClockMs(300_000)).toBe('05:00.000');
    expect(formatClockMs(4_123)).toBe('00:04.123');
    expect(formatClockMs(-65_000)).toBe('-01:05.000');
    expect(formatClockSec(300_000)).toBe('05:00');
    expect(formatSeconds(12_400)).toBe('12.4s');
    expect(formatSeconds(null)).toBe('—');
    expect(formatDuration(45_000)).toBe('45.0s');
    expect(formatDuration(90_000)).toBe('01:30');
  });

  it('gives every live action an explicit permission entry and empties the retired ones', () => {
    for (const action of Object.keys(ROLE_ACTIONS) as (keyof typeof ROLE_ACTIONS)[]) {
      const roles = ROLE_ACTIONS[action];
      if (RETIRED.includes(action)) expect(roles, action).toEqual([]);
      else expect(roles.length, action).toBeGreaterThan(0);
      for (const role of roles) expect(ROLES).toContain(role);
    }
  });

  it('implements the V3 role matrix, one holder per authority', () => {
    // §15: receive / confirm floor 2 / bypass / start / claim / verify / exit.
    expect(ROLE_ACTIONS.CALL_TEAM).toEqual(['LOBBY']);
    expect(ROLE_ACTIONS.CONFIRM_FLOOR2).toEqual(['CORRIDOR']);
    expect(ROLE_ACTIONS.FLOOR2_BYPASS).toEqual(['GATE']);
    expect(ROLE_ACTIONS.START_GAME).toEqual(['GATE']);
    expect(ROLE_ACTIONS.CLAIM_COMPLETE).toEqual(['ROOM305']);
    expect(ROLE_ACTIONS.VERIFY_ATTEMPT).toEqual(['ROOM305']);
    expect(ROLE_ACTIONS.CONFIRM_EXIT).toEqual(['GATE']);
    expect(ROLE_ACTIONS.EARLY_EXIT).toEqual(['GATE']);
    // Nobody at all may edit the countdown.
    expect(ROLE_ACTIONS.GAME_PAUSE).toEqual([]);
    expect(ROLE_ACTIONS.GAME_RESET).toEqual([]);
    expect(isAllowed('SUPERVISOR', 'START_GAME')).toBe(false);
    expect(isAllowed('LOBBY', 'CONFIRM_FLOOR2')).toBe(false);
    // The viewer holds no authority over anything, by construction.
    expect(ROLES.filter((r) => Object.values(ROLE_ACTIONS).some((roles) => roles.includes(r)))).not.toContain('OBSERVER');
    // The three physical checks belong to the floor-3 staff alone.
    expect(RESET_TASKS).toEqual(['hidden_objects', 'hallway', 'room']);
    expect(ROLES.filter((r) => isAllowed(r, 'RESET_DONE'))).toEqual(['GATE', 'ROOM305']);
    expect(isAllowed('CORRIDOR', 'RESET_DONE')).toBe(false);
    // Exceptional admin stays with the retained supervisor position.
    expect(ROLES.filter((r) => isAllowed(r, 'REVIEW_RESOLVE'))).toEqual(['SUPERVISOR']);
    expect(ROLES.filter((r) => isAllowed(r, 'REOPEN_RESET'))).toEqual(['SUPERVISOR']);
    expect(ROLES.filter((r) => isAllowed(r, 'CORRECT_ROUND'))).toEqual(['SUPERVISOR']);
  });

  it('applies the phase guard on top of the permission, so a yes is not always', () => {
    // NPC1 may start only at the floor-3 entrance, never while the clock is running.
    expect(authorize('GATE', 'START_GAME', 'READY_AT_FLOOR3', 'IN_PROGRESS').allowed).toBe(true);
    expect(authorize('GATE', 'START_GAME', 'RUNNING', 'IN_PROGRESS').allowed).toBe(false);
    // OPERATOR_02 may confirm only while the team is on the second-floor leg.
    expect(authorize('CORRIDOR', 'CONFIRM_FLOOR2', 'WAITING_FLOOR2_CONFIRMATION', 'IN_PROGRESS').allowed).toBe(true);
    expect(authorize('CORRIDOR', 'CONFIRM_FLOOR2', 'READY_AT_FLOOR3', 'IN_PROGRESS').allowed).toBe(false);
    // A settled win is immutable. A cancellation is not: it stops the clock, and a
    // claim recorded before the deadline stays verifiable (V3.1 §4.4), while a new
    // claim on a cancelled round is refused.
    expect(authorize('ROOM305', 'VERIFY_ATTEMPT', 'EXIT_CONFIRMED', 'ABORTED').allowed).toBe(true);
    expect(authorize('ROOM305', 'CLAIM_COMPLETE', 'EXIT_CONFIRMED', 'ABORTED').allowed).toBe(false);
    expect(authorize('ROOM305', 'VERIFY_ATTEMPT', 'EXIT_CONFIRMED', 'WON').allowed).toBe(false);
    expect(authorize('ROOM305', 'CLAIM_COMPLETE', 'CLOSED', 'WON').allowed).toBe(false);
    // A disqualification is a supervisor decision, not a verification: it stays locked
    // until REVIEW_RESOLVE has accepted the result by name.
    const disqualified: Round = makeRound(initialState(T0), { aborted_at: T0 + 60_000, abort_kind: 'misconduct' });
    expect(authorize('ROOM305', 'VERIFY_ATTEMPT', 'EXIT_CONFIRMED', 'ABORTED', disqualified).allowed).toBe(false);
    expect(authorize('ROOM305', 'VERIFY_ATTEMPT', 'EXIT_CONFIRMED', 'ABORTED',
      { ...disqualified, review_resolved_at: T0 + 90_000, decertified: false }).allowed).toBe(true);
    // A viewer is refused as a viewer even if a client forges an action.
    expect(authorize('OBSERVER', 'START_GAME', 'READY_AT_FLOOR3', 'IN_PROGRESS').reason).toBe('READ_ONLY');
  });

  it('does not impose an event duration limit on reception or game start', () => {
    const clock = new FakeClock(T0);
    const engine = new ScreamEngine(initialState(T0), clock, {
      lobby: { id: 'lobby', role: 'LOBBY', display_name: 'L' },
    });
    engine.dispatch({
      action: 'CALL_TEAM',
      actor: { id: 'lobby', role: 'LOBBY', display_name: 'L' },
      expected_revision: 0,
      idempotency_key: 'a',
    });
    const ev = engine.snapshot().event;
    const longAfter = T0 + ev.config.event_duration_ms + 1;
    expect(evaluateDispatch(ev, longAfter).allowed).toBe(true);
    expect(evaluateDispatch(ev, longAfter).remaining_ms).toBeNull();
    expect(evaluateGameStart(ev, longAfter).overridePossible).toBe(false);
    const ended = { ...ev, event_ended_at: longAfter };
    expect(evaluateDispatch(ended, longAfter).code).toBe('EVENT_ENDED');
    expect(evaluateGameStart(ended, longAfter).code).toBe('EVENT_ENDED');
    expect(defaultConfig()).toMatchObject({ game_limit_ms: 300_000, hidden_object_owner: 'ROOM305' });
  });

  it('treats exactly 5:00.000 as a win and anything above as not ranked', () => {
    const base = initialState(T0);
    const attempt = (elapsed: number): CompletionAttempt => ({
      id: `att-${elapsed}`,
      round_id: 'r-1',
      seq: 1,
      claimed_at: T0 + 1000 + elapsed,
      elapsed_ms: elapsed,
      remaining_ms: 300_000 - elapsed,
      in_time: elapsed < 300_000,
      status: 'VALID',
      claimed_by_role: 'ROOM305',
      claimed_by: 'room305',
      verified_by_role: 'ROOM305',
      verified_by: 'room305',
      verified_at: T0 + 1000 + elapsed + 5000,
      decision_note: null,
      claim_press_ms: null,
      claim_transport_ms: null,
      revision: 1,
    });
    const round = (ms: number) =>
      makeRound(base, {
        status: 'CLOSED',
        result: 'WON',
        outcome: 'WON',
        official_duration_ms: ms,
        validated_attempt_id: `att-${ms}`,
        deadline_at: T0 + 1000 + 300_000,
      });
    expect(qualifiesForLeaderboard(round(300_000), 300_000)).toBe(true);
    expect(qualifiesForLeaderboard(round(300_001), 300_000)).toBe(false);
    const snap = finalizeSnapshot({
      revision: 1,
      server_now_ms: T0,
      event: base.event,
      rounds: [round(300_001), round(300_000)],
      reset_tasks: [],
      attempts: [attempt(300_001), attempt(300_000)],
      operators: [],
      log: [],
    });
    expect(leaderboard(snap).map((r) => r.duration_ms)).toEqual([300_000]);
    expect(roundMetrics(round(300_000), [], undefined, [], 300_000).game_ms).toBe(300_000);
  });

  it('a team that never exited is never ranked, and an abort never looks like a win', () => {
    const base = initialState(T0);
    const noExit = makeRound(base, {
      status: 'WAITING_FOR_EXIT',
      result: 'WON',
      outcome: 'WON',
      official_duration_ms: 60_000,
      validated_attempt_id: 'att-1',
      exit_confirmed_at: null,
    });
    expect(qualifiesForLeaderboard(noExit, 300_000)).toBe(false);
    const aborted = makeRound(base, {
      status: 'CLOSED',
      result: 'ABORTED',
      outcome: 'ABORTED',
      official_duration_ms: null,
      validated_attempt_id: null,
      aborted_at: T0 + 60_000,
      exit_confirmed_at: T0 + 60_000,
    });
    expect(qualifiesForLeaderboard(aborted, 300_000)).toBe(false);
    expect(leaderboard({ rounds: [noExit, aborted], event: base.event })).toHaveLength(0);
  });

  it('derives the result from facts rather than from a timer task', () => {
    const base = initialState(T0);
    const open = makeRound(base, {
      status: 'RUNNING',
      result: 'IN_PROGRESS',
      outcome: 'IN_PROGRESS',
      game_started_at: T0,
      deadline_at: T0 + 300_000,
      official_duration_ms: null,
      validated_attempt_id: null,
      exit_confirmed_at: null,
      puzzle_completed_at: null,
    });
    const mk = (at: number, inTime: boolean, status: CompletionAttempt['status']): CompletionAttempt => ({
      id: `a-${at}`,
      round_id: open.id,
      seq: 1,
      claimed_at: T0 + at,
      elapsed_ms: at,
      remaining_ms: 300_000 - at,
      in_time: inTime,
      status,
      claimed_by_role: 'ROOM305',
      claimed_by: 'room305',
      verified_by_role: null,
      verified_by: null,
      verified_at: null,
      decision_note: null,
      claim_press_ms: null,
      claim_transport_ms: null,
      revision: 0,
    });
    // Before the deadline: in progress.
    expect(resultOf(open, [], 300_000, T0 + 100_000)).toBe('IN_PROGRESS');
    // Past the deadline with an open eligible claim: provisional, never a failure.
    expect(resultOf(open, [mk(299_000, true, 'PENDING')], 300_000, T0 + 305_000)).toBe('PENDING_VALIDATION');
    // Past the deadline with only invalid or late claims: time up.
    expect(resultOf(open, [mk(299_000, true, 'INVALID'), mk(301_000, false, 'LATE')], 300_000, T0 + 305_000)).toBe('TIME_UP');
    // A validated claim wins even after the deadline, at its own timestamp.
    const won = { ...open, result: 'WON' as const, validated_attempt_id: 'a-299000', official_duration_ms: 299_000 };
    expect(resultOf(won, [mk(299_000, true, 'VALID')], 300_000, T0 + 400_000)).toBe('WON');
  });

  describe('wall clock — the display mirrors the stored deadline', () => {
    it('shows MM:SS large and the hundredths as a separate, smaller field', () => {
      const now = T0 + 150_000; // 60 s after NPC1 pressed START
      const snap = runningSnap(now);
      const view = resolveCountdown(snap, now);
      expect(view.mm).toBe('04');
      expect(view.ss).toBe('00');
      expect(view.cs).toBe('00');
      expect(view.remainingMs).toBe(240_000);
      expect(view.running).toBe(true);
      expect(view.teamText).toBe('Đội #001');
      const big = resolveBigScreen(snap, now);
      expect(big?.limitMs).toBe(300_000);
      expect(big?.remainingMs).toBe(240_000);
      expect(big?.expired).toBe(false);
      expect(big).not.toHaveProperty('paused');
      expect(big).not.toHaveProperty('eventRemainingMs');
    });

    it('freezes at 00:00 instead of counting into negative digits', () => {
      const snap = runningSnap(T0 + 400_000);
      const big = resolveBigScreen(snap, T0 + 400_000);
      expect(big?.expired).toBe(true);
      expect(big?.remainingMs).toBe(0);
      const view = resolveCountdown(snap, T0 + 400_000);
      expect(`${view.mm}:${view.ss}:${view.cs}`).toBe('00:00:00');
      expect(view.expired).toBe(true);
      // Nobody wrote anything: the expiry is a property of the stored deadline.
      expect(snap.active_round?.exit_confirmed_at).toBeNull();
    });

    it('is absent before the countdown and once the round is out of the area', () => {
      const waiting = runningSnap(T0 + 30_000, { status: 'WAITING_FLOOR2_CONFIRMATION', game_started_at: null, deadline_at: null });
      expect(resolveBigScreen(waiting, T0 + 30_000)).toBeNull();
      const exited = runningSnap(T0 + 200_000, { status: 'EXIT_CONFIRMED', exit_confirmed_at: T0 + 180_000 });
      expect(resolveBigScreen(exited, T0 + 200_000)).toBeNull();
      // The operator screen, however, keeps the frozen clock visible at exit-waiting.
      const inside = runningSnap(T0 + 400_000);
      expect(resolveCountdown(inside, T0 + 400_000).visible).toBe(true);
    });
  });
});

describe('journey — the route every phone shows', () => {
  const snapOf = (rounds: Round[], next = 1): Snapshot =>
    finalizeSnapshot({
      revision: 5,
      server_now_ms: T0 + 120_000,
      event: { ...initialState(T0).event, event_started_at: T0, next_team_number: next },
      rounds,
      reset_tasks: [],
      attempts: [],
      operators: [],
      log: [],
    });

  it('starts every team at the lobby and gives the first press to OPERATOR 01', () => {
    const journey = resolveJourney(snapOf([]), T0 + 120_000, 'LOBBY');
    expect(journey.position).toBe(0);
    expect(journey.movement).toBe('idle');
    expect(journey.focus).toBe(0);
    expect(journey.stops[0].state).toBe('lead');
    expect(journey.stops.map((s) => s.floor)).toEqual(['TẦNG 1', 'TẦNG 2', 'TẦNG 3', 'TẦNG 3', 'KẾT THÚC']);
    expect(journey.stops.map((s) => s.station)).toEqual(['LOBBY', 'CORRIDOR', 'GATE', 'ROOM305', null]);
    expect(journey.turn).toMatchObject({ roles: ['LOBBY'], mine: true });
    expect(journey.turn?.label).toBe('NHẬN ĐỘI & CHO LÊN TẦNG 2');
  });

  it('moves the marker up the building as each position presses', () => {
    const received = runningSnap(T0 + 30_000, { status: 'WAITING_FLOOR2_CONFIRMATION', game_started_at: null, deadline_at: null });
    const climbing = resolveJourney(received, T0 + 30_000, 'CORRIDOR');
    expect(climbing.movement).toBe('up');
    expect(climbing.position).toBe(0);
    expect(climbing.focus).toBe(1); // walking into the second floor
    expect(climbing.where).toBe('ĐANG LÊN TẦNG 2');
    expect(climbing.turn).toMatchObject({ roles: ['CORRIDOR'], label: 'XÁC NHẬN ĐỘI ĐÃ ĐẾN TẦNG 2', mine: true });

    const atFloor2 = runningSnap(T0 + 60_000, {
      status: 'READY_AT_FLOOR3',
      game_started_at: null,
      deadline_at: null,
      floor2_confirmed_at: T0 + 40_000,
    });
    const atGate = resolveJourney(atFloor2, T0 + 60_000, 'GATE');
    expect(atGate.position).toBe(2);
    expect(atGate.stops[1].state).toBe('done');
    expect(atGate.caption).toBe('ĐỘI CHƠI SẮP BẮT ĐẦU');
    expect(atGate.turn).toMatchObject({ roles: ['GATE'], mine: true });
    expect(atGate.turn?.label).toContain('BẮT ĐẦU');
  });

  it('marks the bypass on the rail without pretending the floor was confirmed', () => {
    const snap = runningSnap(T0 + 60_000, {
      status: 'READY_AT_FLOOR3',
      game_started_at: null,
      deadline_at: null,
      floor2_bypassed_at: T0 + 40_000,
      floor2_bypassed_by_role: 'GATE',
    });
    const journey = resolveJourney(snap, T0 + 60_000, 'CORRIDOR');
    expect(journey.stops[1].note).toContain('Bỏ qua');
    expect(journey.caption).toBe('ĐỘI CHƠI SẮP BẮT ĐẦU');
    // OPERATOR_02 has nothing left to press for this team.
    expect(resolvePrimary('CORRIDOR', snap, T0 + 60_000).action).toBeNull();
  });

  it('sits on the room for the whole countdown and walks back to the door after', () => {
    const running = resolveJourney(runningSnap(T0 + 200_000), T0 + 200_000, 'ROOM305');
    expect(running.position).toBe(3);
    expect(running.stops[3].state).toBe('lead');
    expect(running.turn).toMatchObject({ roles: ['ROOM305'], label: 'GHI NHẬN BÁO HOÀN THÀNH', mine: true });

    const leaving = runningSnap(T0 + 400_000);
    const back = resolveJourney(leaving, T0 + 400_000, 'GATE');
    expect(back.movement).toBe('down');
    expect(back.where).toBe('ĐANG RA CỬA VÀO TẦNG 3');
    expect(back.turn).toMatchObject({ roles: ['GATE'], label: 'XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3', mine: true });
  });

  it('returns the route to the lobby once the round is closed', () => {
    const journey = resolveJourney(snapOf([makeRound(initialState(T0), { status: 'CLOSED' })], 2), T0 + 120_000, 'LOBBY');
    expect(journey.position).toBe(0);
    expect(journey.stops.every((s) => s.state !== 'done')).toBe(true);
    expect(journey.turn?.label).toBe('NHẬN ĐỘI & CHO LÊN TẦNG 2');
    expect(journey.turn?.mine).toBe(true);
  });
});

describe('observer surface', () => {
  it('reports the ten-seat capacity and refuses beyond it', () => {
    expect(observerBoard(3, 10)).toMatchObject({ seats: 3, capacity: 10, full: false });
    expect(observerBoard(10, 10).full).toBe(true);
    expect(observerBoard()).toMatchObject({ seats: 0, capacity: OBSERVER_CAPACITY, full: false });
  });

  it('has no primary action, no emergency action and no turn in any phase', () => {
    for (const snap of [
      runningSnap(T0 + 100_000),
      runningSnap(T0 + 320_000),
      runningSnap(T0 + 60_000, { status: 'READY_AT_FLOOR3', game_started_at: null, deadline_at: null }),
    ]) {
      const now = snap.server_now_ms;
      expect(resolvePrimary('OBSERVER', snap, now).action).toBeNull();
      expect(resolveEmergency('OBSERVER', snap, now)).toBeNull();
    }
  });
});

/** One running round inside an open event, ready for display selectors. */
function runningSnap(nowMs: number, over: Partial<Round> = {}): Snapshot {
  const base = initialState(T0);
  const event = { ...base.event, event_started_at: T0 };
  const round = makeRound(base, {
    status: 'RUNNING',
    result: 'IN_PROGRESS',
    outcome: 'IN_PROGRESS',
    game_started_at: T0 + 90_000,
    deadline_at: T0 + 90_000 + 300_000,
    official_duration_ms: null,
    validated_attempt_id: null,
    exit_confirmed_at: null,
    gate_finalized_at: null,
    system_ready_at: null,
    floor2_confirmed_at: T0 + 30_000,
    ...over,
  });
  return finalizeSnapshot({
    revision: 3,
    server_now_ms: nowMs,
    event,
    rounds: [round],
    reset_tasks: [],
    attempts: [],
    operators: [],
    log: [],
  });
}

function makeRound(base: ReturnType<typeof initialState>, over: Partial<Round>): Round {
  return {
    id: over.id ?? 'r-1',
    event_id: base.event.id,
    round_number: 1,
    team_number: 1,
    team_name: null,
    status: 'CLOSED',
    stage: 6,
    called_at: T0,
    received_by_role: 'LOBBY',
    received_by: 'lobby',
    floor2_confirmed_at: T0 + 20_000,
    floor2_confirmed_by_role: 'CORRIDOR',
    floor2_confirmed_by: 'corridor',
    floor2_bypassed_at: null,
    floor2_bypassed_by_role: null,
    floor2_bypassed_by: null,
    floor2_bypass_reason: null,
    game_started_at: T0 + 1000,
    started_by_role: 'GATE',
    started_by: 'gate',
    deadline_at: T0 + 1000 + 300_000,
    game_anchor_ms: null,
    game_elapsed_ms: 0,
    game_stopped_at: null,
    game_reset_count: 0,
    game_pause_count: 0,
    official_duration_ms: 300_000,
    validated_attempt_id: 'att-300000',
    puzzle_completed_at: T0 + 500,
    exit_confirmed_at: T0 + 301_000,
    exit_by_role: 'GATE',
    exit_by: 'gate',
    exit_reason: null,
    gate_finalized_at: T0 + 320_000,
    finalized_by_role: 'GATE',
    system_ready_at: T0 + 320_000,
    aborted_at: null,
    result: 'WON',
    outcome: 'WON',
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
    ...over,
    // V3.1 fields always resolve: the base round ran on the 05:00 default and was
    // never cancelled, unless the case under test says otherwise.
    round_duration_ms: over.round_duration_ms ?? 300_000,
    abort_kind: over.abort_kind ?? null,
    abort_reason: over.abort_reason ?? null,
  };
}
