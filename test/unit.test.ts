import { describe, expect, it } from 'vitest';
import {
  formatClockMs,
  formatClockSec,
  formatDuration,
  formatSeconds,
  qualifiesForLeaderboard,
  leaderboard,
  roundMetrics,
} from '../src/shared/metrics';
import { ROLES, RESET_TASKS } from '../src/shared/constants';
import { ROLE_ACTIONS, evaluateDispatch, evaluateGameStart, isAllowed, finalizeSnapshot } from '../src/shared/machine';
import { resolveBigScreen, resolveJourney } from '../src/client/selectors';
import { FakeClock } from '../src/shared/types';
import { initialState, defaultConfig, ScreamEngine } from '../src/server/engine';
import { T0 } from './helpers/harness';

describe('unit — formats, permissions and boundaries', () => {
  it('formats clocks with the right precision per phase (§4)', () => {
    expect(formatClockMs(300_000)).toBe('05:00.000');
    expect(formatClockMs(4_123)).toBe('00:04.123');
    expect(formatClockMs(-65_000)).toBe('-01:05.000');
    expect(formatClockSec(5_400_000)).toBe('90:00');
    expect(formatClockSec(89_500)).toBe('01:29');
    expect(formatSeconds(12_400)).toBe('12.4s');
    expect(formatSeconds(null)).toBe('—');
    expect(formatDuration(45_000)).toBe('45.0s');
    expect(formatDuration(90_000)).toBe('01:30');
  });

  it('gives every role an explicit permission entry and never a wildcard', () => {
    for (const action of Object.keys(ROLE_ACTIONS) as (keyof typeof ROLE_ACTIONS)[]) {
      const roles = ROLE_ACTIONS[action];
      expect(roles.length, action).toBeGreaterThan(0);
      for (const role of roles) expect(ROLES).toContain(role);
    }
    // §2: LOBBY cannot start or stop official gameplay
    expect(isAllowed('LOBBY', 'START_GAME')).toBe(false);
    expect(isAllowed('LOBBY', 'GAME_STOP')).toBe(false);
    expect(isAllowed('LOBBY', 'GATE_FINALIZE')).toBe(false);
    // §2: only GATE finalises readiness
    expect(ROLES.filter((r) => isAllowed(r, 'GATE_FINALIZE'))).toEqual(['GATE', 'SUPERVISOR']);
    // §2: only GATE stops the clock
    expect(ROLES.filter((r) => isAllowed(r, 'GAME_STOP'))).toEqual(['GATE', 'SUPERVISOR']);
    // every reset task is owned by exactly one required role
    expect(RESET_TASKS).toEqual(['hidden_objects', 'hallway', 'room']);
    expect(isAllowed('SUPERVISOR', 'ABORT_ROUND')).toBe(true);
    expect(isAllowed('CORRIDOR', 'ABORT_ROUND')).toBe(false);
    // P0-05/P0-06 exceptions are supervisor-only, layout is the owner's
    expect(ROLES.filter((r) => isAllowed(r, 'REVIEW_RESOLVE'))).toEqual(['SUPERVISOR']);
    expect(ROLES.filter((r) => isAllowed(r, 'REOPEN_RESET'))).toEqual(['SUPERVISOR']);
    expect(ROLES.filter((r) => isAllowed(r, 'SET_LAYOUT'))).toEqual(['GATE', 'CORRIDOR', 'SUPERVISOR']);
    expect(ROLES.filter((r) => isAllowed(r, 'ROOM_REACHED'))).toEqual(['ROOM305', 'SUPERVISOR']);
  });

  it('applies the admission boundaries exactly', () => {
    const clock = new FakeClock(T0);
    const engine = new ScreamEngine(initialState(T0), clock, {
      supervisor: { id: 'supervisor', role: 'SUPERVISOR', display_name: 'S' },
    });
    engine.dispatch({
      action: 'CALL_TEAM',
      actor: { id: 'supervisor', role: 'SUPERVISOR', display_name: 'S' },
      expected_revision: 0,
      idempotency_key: 'a',
    });
    const ev = engine.snapshot().event;
    const required = ev.config.game_limit_ms + ev.config.prep_allowance_ms; // 390 s

    // exactly enough time -> allowed
    expect(evaluateDispatch(ev, T0 + ev.config.event_duration_ms - required).allowed).toBe(true);
    // one millisecond short -> needs an audited override
    const tight = evaluateDispatch(ev, T0 + ev.config.event_duration_ms - required + 1);
    expect(tight.allowed).toBe(false);
    expect(tight.overridePossible).toBe(true);
    // exhausted -> hard stop
    expect(evaluateDispatch(ev, T0 + ev.config.event_duration_ms).overridePossible).toBe(false);
    expect(evaluateDispatch(ev, T0 + ev.config.event_duration_ms + 1).code).toBe('TIME_EXHAUSTED');
    // the 5-minute rule is independent of the preparation allowance
    expect(evaluateGameStart(ev, T0 + ev.config.event_duration_ms - ev.config.game_limit_ms).allowed).toBe(true);
    expect(evaluateGameStart(ev, T0 + ev.config.event_duration_ms - ev.config.game_limit_ms + 1).allowed).toBe(false);
    expect(evaluateGameStart(ev, T0).code).toBe('ALLOWED');
  });

  it('the first dispatch is always admissible and anchors the fixed timeline', () => {
    const ev = initialState(T0).event;
    const first = evaluateDispatch(ev, T0);
    expect(first.allowed).toBe(true);
    expect(first.code).toBe('ALLOWED');
    expect(first.remaining_ms).toBe(ev.config.event_duration_ms);
    expect(defaultConfig()).toMatchObject({ event_duration_ms: 5_400_000, game_limit_ms: 300_000, prep_allowance_ms: 90_000 });
  });

  it('treats exactly 5:00.000 as a win and anything above as a timeout (§1)', () => {
    const base = initialState(T0);
    const round = (ms: number) => makeRound(base, { official_duration_ms: ms, game_stopped_at: T0 + 1000 + ms, outcome: ms <= 300_000 ? 'WON' : 'TIMEOUT' });
    const exact = round(300_000);
    const over = round(300_001);
    expect(qualifiesForLeaderboard(exact, 300_000)).toBe(true);
    expect(qualifiesForLeaderboard(over, 300_000)).toBe(false);
    const snap = finalizeSnapshot({
      revision: 1,
      server_now_ms: T0,
      event: base.event,
      rounds: [over, exact],
      reset_tasks: [],
      operators: [],
      log: [],
    });
    expect(leaderboard(snap).map((r) => r.duration_ms)).toEqual([300_000]);
    expect(roundMetrics(exact, []).game_ms).toBe(300_000);
  });

  it('a team that never exited is never ranked even with a fast puzzle', () => {
    const base = initialState(T0);
    const round = makeRound(base, {
      status: 'ABORTED',
      game_stopped_at: T0 + 60_000,
      official_duration_ms: 60_000,
      puzzle_completed_at: T0 + 30_000,
      exit_confirmed_at: null,
      outcome: 'ABORTED',
    });
    expect(qualifiesForLeaderboard(round, 300_000)).toBe(false);
    expect(leaderboard({ rounds: [round], event: base.event })).toHaveLength(0);
  });

  describe('big screen — the wall display mirrors the flexible 5:00 window', () => {
    it('mirrors the official game clock, not the 90-minute event clock', () => {
      const now = T0 + 150_000; // 60 s after GATE pressed BẮT ĐẦU
      const snap = runningSnap(now);
      const big = resolveBigScreen(snap, now);
      expect(big).not.toBeNull();
      expect(big?.limitMs).toBe(300_000);
      expect(big?.remainingMs).toBe(240_000);
      expect(big?.expired).toBe(false);
      expect(big?.paused).toBe(false);
      // the event clock is carried alongside it and is never the number shown
      expect(big?.eventRemainingMs).toBe(5_400_000 - 150_000);
    });

    it('a paused game freezes the number while the 90:00 keeps running', () => {
      const now = T0 + 150_000;
      const snap = runningSnap(now, { game_anchor_ms: null, game_elapsed_ms: 60_000, game_pause_count: 1 });
      const big = resolveBigScreen(snap, now);
      expect(big?.paused).toBe(true);
      expect(big?.remainingMs).toBe(240_000);
      const muchLater = resolveBigScreen(snap, now + 600_000);
      expect(muchLater?.remainingMs).toBe(240_000); // frozen window
      expect(muchLater?.eventRemainingMs).toBe(5_400_000 - 750_000); // fixed timeline
    });

    it('counts past zero instead of stopping, so the alarm and the digits agree', () => {
      const snap = runningSnap(T0 + 400_000);
      const big = resolveBigScreen(snap, T0 + 400_000);
      expect(big?.expired).toBe(true);
      expect(big?.remainingMs).toBe(-10_000);
      // the round is still officially running: GATE alone stops it
      expect(snap.active_round?.game_stopped_at).toBeNull();
    });

    it('is absent while a team is only walking upstairs and after GATE stops the clock', () => {
      const preparing = runningSnap(T0 + 30_000, {
        status: 'TEAM_PREPARING',
        game_started_at: null,
        game_anchor_ms: null,
        game_elapsed_ms: 0,
      });
      expect(resolveBigScreen(preparing, T0 + 30_000)).toBeNull();
      const stopped = runningSnap(T0 + 200_000, { status: 'GAME_EXITED', game_stopped_at: T0 + 180_000, game_anchor_ms: null });
      expect(resolveBigScreen(stopped, T0 + 200_000)).toBeNull();
    });
  });
});

describe('journey — the route every phone shows', () => {
  const snapOf = (rounds: ReturnType<typeof makeRound>[], next = 1) =>
    finalizeSnapshot({
      revision: 5,
      server_now_ms: T0 + 120_000,
      event: { ...initialState(T0).event, event_started_at: T0, next_team_number: next },
      rounds,
      reset_tasks: [],
      operators: [],
      log: [],
    });

  it('starts every team at the lobby and gives the first press to LOBBY', () => {
    const journey = resolveJourney(snapOf([]), T0 + 120_000, 'LOBBY');
    expect(journey.position).toBe(0);
    expect(journey.movement).toBe('idle');
    expect(journey.focus).toBe(0); // the lobby is where the next team appears
    expect(journey.stops[0].state).toBe('lead');
    expect(journey.stops[0].floor).toBe('TẦNG 1');
    expect(journey.stops.slice(1).map((s) => s.floor)).toEqual(['TẦNG 3', 'TẦNG 3', 'TẦNG 3', 'KẾT THÚC']);
    expect(journey.turn).toMatchObject({ roles: ['LOBBY'], mine: true });
    expect(journey.turn?.label).toBe('CHO ĐỘI LÊN');
  });

  it('moves the marker up the building as each station presses', () => {
    const called = runningSnap(T0 + 30_000, { status: 'LOBBY_CALL', game_started_at: null });
    const atLobby = resolveJourney(called, T0 + 30_000, 'LOBBY');
    expect(atLobby.movement).toBe('up');
    expect(atLobby.position).toBe(0);
    expect(atLobby.focus).toBe(1); // walking into the third-floor entrance
    expect(atLobby.stops[0].state).toBe('here');
    expect(atLobby.turn).toMatchObject({ roles: ['LOBBY'], label: 'ĐÃ LÊN TẦNG 3' });

    const preparing = runningSnap(T0 + 60_000, { status: 'TEAM_PREPARING', game_started_at: null });
    const atGate = resolveJourney(preparing, T0 + 60_000, 'GATE');
    expect(atGate.position).toBe(1);
    expect(atGate.movement).toBe('at');
    expect(atGate.stops[1].state).toBe('lead');
    expect(atGate.turn).toMatchObject({ roles: ['GATE'], mine: true });
    expect(atGate.turn?.label).toContain('BẮT ĐẦU');

    const hall = resolveJourney(runningSnap(T0 + 200_000, { status: 'CORRIDOR_ACTIVE' }), T0 + 200_000, 'CORRIDOR');
    expect(hall.position).toBe(2);
    expect(hall.stops[1].state).toBe('done');

    const room = runningSnap(T0 + 260_000, { status: 'PUZZLE_COMPLETED', puzzle_completed_at: T0 + 250_000 });
    const atRoom = resolveJourney(room, T0 + 260_000, 'ROOM305');
    expect(atRoom.position).toBe(3);
    expect(atRoom.caption).toContain('Trận đồ đã hoàn thành');
    expect(atRoom.turn).toMatchObject({ label: 'ĐỘI RỜI PHÒNG 305', mine: true });
  });

  it('walks the marker back down on the return leg', () => {
    const returning = runningSnap(T0 + 280_000, { status: 'RETURNING', puzzle_completed_at: T0 + 250_000 });
    const journey = resolveJourney(returning, T0 + 280_000, 'GATE');
    expect(journey.movement).toBe('down');
    expect(journey.position).toBe(2);
    expect(journey.focus).toBe(1); // the door they are walking back out of
    expect(journey.stops[3].state).toBe('done');
    expect(journey.stops[1].state).toBe('lead');
    expect(journey.turn).toMatchObject({ roles: ['GATE'], mine: true });
  });

  it('returns the route to the lobby once GATE clears the area', () => {
    const journey = resolveJourney(snapOf([makeRound(initialState(T0), { status: 'GATE_CLEARED' })], 2), T0 + 120_000, 'LOBBY');
    expect(journey.position).toBe(0);
    expect(journey.movement).toBe('idle');
    expect(journey.stops.every((s) => s.state !== 'done')).toBe(true);
    expect(journey.turn?.label).toBe('CHO ĐỘI LÊN');
    expect(journey.turn?.mine).toBe(true);
  });
});

/** One running round inside a live 90-minute event, ready for display selectors. */
function runningSnap(nowMs: number, over: Partial<import('../src/shared/types').Round> = {}) {
  const base = initialState(T0);
  const event = { ...base.event, event_started_at: T0 };
  const round = makeRound(base, {
    status: 'GAME_STARTED',
    game_started_at: T0 + 90_000,
    game_anchor_ms: T0 + 90_000,
    game_elapsed_ms: 0,
    game_stopped_at: null,
    official_duration_ms: null,
    exit_confirmed_at: null,
    gate_finalized_at: null,
    system_ready_at: null,
    outcome: 'IN_PROGRESS',
    ...over,
  });
  return finalizeSnapshot({
    revision: 3,
    server_now_ms: nowMs,
    event,
    rounds: [round],
    reset_tasks: [],
    operators: [],
    log: [],
  });
}

function makeRound(
  base: ReturnType<typeof initialState>,
  over: Partial<import('../src/shared/types').Round>,
): import('../src/shared/types').Round {
  return {
    id: over.id ?? 'r-1',
    event_id: base.event.id,
    round_number: 1,
    team_number: 1,
    team_name: null,
    status: 'GATE_CLEARED',
    stage: 9,
    called_at: T0,
    game_started_at: T0 + 1000,
    game_anchor_ms: T0 + 1000,
    game_elapsed_ms: 300_000,
    game_stopped_at: T0 + 301_000,
    game_reset_count: 0,
    game_pause_count: 0,
    official_duration_ms: 300_000,
    puzzle_completed_at: T0 + 500,
    exit_confirmed_at: T0 + 301_000,
    gate_finalized_at: T0 + 320_000,
    system_ready_at: T0 + 320_000,
    aborted_at: null,
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
  };
}
