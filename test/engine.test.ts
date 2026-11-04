import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/shared/types';
import { MIN, SEC, TestHub, T0, entries, latest, playRound } from './helpers/harness';
import { analytics, cycleMetrics, leaderboard, roundMetrics } from '../src/shared/metrics';
import { evaluateDispatch, evaluateGameStart, flowStatus, gameRemainingMs, isTerminalRound } from '../src/shared/machine';
import { STALL_WARN_MS } from '../src/shared/constants';
import { ScreamEngine, initialState } from '../src/server/engine';
import { resolveAlerts, resolveCountdown } from '../src/client/selectors';
import type { Snapshot } from '../src/shared/types';

/**
 * Timekeeping, derived reporting and the admin surface.
 *
 * Every case runs on the controlled fake clock so long spans are exercised without
 * waiting, and every expectation is placed on persisted authoritative facts rather
 * than on a rendered number.
 */

function ready(hub: TestHub) {
  hub.command('lobby', 'CALL_TEAM');
  hub.advance(30 * SEC);
  hub.command('corridor', 'CONFIRM_FLOOR2');
  hub.advance(10 * SEC);
  hub.command('gate', 'START_GAME');
}

describe('timekeeping — one authoritative clock', () => {
  it('1. the first reception opens the event; elapsed time alone never closes it', () => {
    const hub = new TestHub();
    expect(hub.snapshot().phase).toBe('PRE_EVENT');
    expect(hub.snapshot().event.event_started_at).toBeNull();
    expect(hub.command('lobby', 'CALL_TEAM').ok).toBe(true);
    expect(hub.snapshot().event.event_started_at).toBe(hub.now());
    expect(hub.snapshot().event.config).toMatchObject({ game_limit_ms: 5 * MIN });
    hub.advance(91 * MIN);
    // 91 minutes of idling ends nothing: closure stays a human decision.
    expect(hub.snapshot().event_status).toBe('LIVE');
    expect(hub.snapshot().event.event_ended_at).toBeNull();
  });

  it('1b. no countdown frame writes to the store', () => {
    const hub = new TestHub();
    ready(hub);
    const revision = hub.snapshot().revision;
    for (let i = 0; i < 500; i++) hub.advance(200);
    expect(hub.snapshot().revision).toBe(revision);
    expect(entries(hub).filter((l) => l.actor_id === 'system.clock')).toHaveLength(0);
  });

  it('2. the deadline is stored once and expires at exactly 300 s', () => {
    const hub = new TestHub();
    hub.advance(10 * MIN);
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    const startedAt = hub.now() + 70 * SEC;
    hub.advance(70 * SEC);
    expect(hub.command('lobby', 'START_GAME').code).toBe('PERMISSION_DENIED');
    expect(hub.command('gate', 'START_GAME').ok).toBe(true);
    const round = hub.snapshot().active_round!;
    expect(round.game_started_at).toBe(startedAt);
    expect(round.deadline_at).toBe(startedAt + 300 * SEC);
    hub.advance(300 * SEC - 1);
    expect(flowStatus(round)).toBe('RUNNING');
    expect(gameRemainingMs(round, 300 * SEC, hub.now())).toBe(1);
    hub.advance(1);
    // Expiry is derived, so it needs no write and no timer.
    expect(hub.snapshot().phase).toBe('WAITING_FOR_EXIT');
    expect(hub.snapshot().active_round!.game_stopped_at).toBeNull();
  });

  it('3. the walk upstairs never enters the official score', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(4 * MIN); // an unusually slow walk
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(90 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts()[0];
    hub.advance(30 * SEC); // NPC2 takes half a minute to check
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    const round = hub.snapshot().rounds.at(-1)!;
    // 90 s of play, not 4 minutes of walking and not 120 s of checking.
    expect(round.official_duration_ms).toBe(90 * SEC);
    // Preparation is the walk from reception to START — nothing else is folded in.
    expect(roundMetrics(round, hub.snapshot().reset_tasks, undefined, hub.snapshot().attempts, 300 * SEC).prep_ms).toBe(4 * MIN);
    hub.command('gate', 'CONFIRM_EXIT');
    expect(leaderboard(hub.snapshot())[0].duration_ms).toBe(90 * SEC);
  });

  it('4. the same deadline is what every client renders', () => {
    const hub = new TestHub();
    ready(hub);
    const snap = hub.snapshot();
    hub.advance(97 * SEC);
    const view = resolveCountdown(snap, hub.now());
    expect(view.mm).toBe('03');
    expect(view.ss).toBe('23');
    expect(view.remainingMs).toBe(300 * SEC - 97 * SEC);
  });
});

describe('audit trail — immutable, server-timestamped', () => {
  it('5. every meaningful action is one append-only row', () => {
    const hub = new TestHub();
    playRound(hub);
    const log = entries(hub);
    const required = ['CALL_TEAM', 'CONFIRM_FLOOR2', 'START_GAME', 'CLAIM_COMPLETE', 'VERIFY_ATTEMPT', 'CONFIRM_EXIT', 'RESET_DONE', 'GATE_FINALIZE'];
    for (const action of required) {
      const rows = log.filter((l) => l.action === action);
      expect(rows.length, action).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Number.isFinite(row.at_ms)).toBe(true);
        expect(row.revision).toBeGreaterThan(0);
        expect(row.idempotency_key).toBeTruthy();
        expect(row.actor_role).toBeTruthy();
        expect(row.to_state).toBeTruthy();
      }
    }
    const seqs = log.map((l) => l.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(log.every((l) => l.event_id === hub.snapshot().event.id)).toBe(true);
  });

  it('5b. the bypass is audited as a bypass, never as a confirmation', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('gate', 'FLOOR2_BYPASS', { reason: 'Đội đã ở tầng 3' });
    const row = latest(hub, 'FLOOR2_BYPASS')!;
    expect(row.metadata?.floor2_confirmed).toBe(false);
    expect(row.metadata?.bypassed_by).toBe('GATE');
    expect(row.metadata?.reason).toBe('Đội đã ở tầng 3');
    expect(latest(hub, 'CONFIRM_FLOOR2')).toBeNull();
  });

  it('5c. a claim keeps its own timestamp even after a rejection', () => {
    const hub = new TestHub();
    ready(hub);
    hub.advance(60 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts()[0];
    hub.advance(6 * SEC);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'INVALID' });
    const row = entries(hub).find((l) => l.action === 'VERIFY_ATTEMPT')!;
    expect(row.at_ms).toBe(claim.claimed_at + 6 * SEC);
    // The decision is recorded against the claim, separately from the claim itself.
    expect(row.metadata?.claimed_at).toBe(claim.claimed_at);
    expect(row.metadata?.attempt_id).toBe(claim.id);
  });

  it('6. preparation, reset and cycle durations come from timestamps only', () => {
    const hub = new TestHub({ hiddenObjectOwner: 'GATE' });
    hub.command('lobby', 'CALL_TEAM', { team_name: 'Nu 1' });
    hub.advance(75 * SEC);
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.advance(10 * SEC);
    hub.command('gate', 'START_GAME');
    const startAt = hub.now();
    hub.advance(100 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts()[0];
    hub.advance(20 * SEC);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    hub.command('gate', 'CONFIRM_EXIT');
    const exitAt = hub.now();
    hub.advance(10 * SEC);
    hub.command('gate', 'RESET_DONE'); // hallway + hidden objects (owner = GATE)
    hub.advance(5 * SEC);
    hub.command('room305', 'RESET_DONE'); // room 305
    hub.advance(2 * SEC);
    hub.command('gate', 'GATE_FINALIZE');
    const readyAt = hub.now();

    const snap = hub.snapshot();
    const round = snap.rounds[0];
    const m = roundMetrics(round, snap.reset_tasks, undefined, snap.attempts, 300 * SEC);
    expect(m.game_ms).toBe(100 * SEC);
    expect(m.prep_ms).toBe(85 * SEC);
    expect(m.reset_total_ms).toBe(readyAt - exitAt);
    expect(m.room_reset_ms).toBe(15 * SEC);
    expect(m.gate_clear_ms).toBe(17 * SEC);
    expect(round.deadline_at).toBe(startAt + 300 * SEC);

    // second team, for the cross-round measurements
    hub.advance(30 * SEC);
    const called2 = hub.now();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    const r2 = snap.rounds[1] ?? hub.snapshot().rounds[1];
    const c = cycleMetrics(round, r2);
    expect(c.inter_team_ms).toBe(r2.game_started_at! - readyAt);
    expect(c.start_to_start_ms).toBe(r2.game_started_at! - round.game_started_at!);
    expect(c.idle_after_ready_ms).toBe(called2 - readyAt);
    expect(c.next_prep_ms).toBe(60 * SEC);
  });

  it('7. concurrent reset confirmations are recorded separately', () => {
    const hub = new TestHub();
    ready(hub);
    // The clock runs out: the round is over, but nobody has confirmed the exit yet.
    hub.advance(301 * SEC);
    hub.command('gate', 'CONFIRM_EXIT');
    hub.command('gate', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE'); // same instant, different position
    const done = entries(hub).filter((l) => l.action === 'RESET_DONE');
    expect(done).toHaveLength(2);
    expect(done[0].at_ms).toBe(done[1].at_ms);
    expect(done[0].actor_role).not.toBe(done[1].actor_role);
    const tasks = hub.snapshot().reset_tasks;
    // hidden_objects belongs to NPC2 by default, so 305 covers two checks at once.
    expect(tasks.filter((t) => t.completed_at !== null)).toHaveLength(3);
    expect(hub.command('gate', 'GATE_FINALIZE').ok).toBe(true);
  });
});

describe('closure — readiness and the next team', () => {
  it('8. a team cannot be received until clearance is complete', () => {
    const hub = new TestHub();
    ready(hub);
    hub.advance(301 * SEC);
    hub.command('gate', 'CONFIRM_EXIT');
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED'); // result + resets
    hub.command('gate', 'RESET_DONE');
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED'); // room 305 pending
    hub.command('room305', 'RESET_DONE');
    expect(hub.snapshot().reset_tasks.every((t) => t.completed_at !== null)).toBe(true);
    expect(hub.command('room305', 'GATE_FINALIZE').code).toBe('PERMISSION_DENIED');
    expect(hub.command('gate', 'GATE_FINALIZE').ok).toBe(true);

    const readySnap = hub.snapshot();
    expect(readySnap.phase).toBe('WAITING_FOR_TEAM');
    expect(readySnap.active_round).toBeNull();
    expect(readySnap.rounds[0].system_ready_at).toBe(hub.now());
    expect(hub.command('lobby', 'CALL_TEAM').ok).toBe(true);
  });

  it('8b. a TIME UP round still has to be exited and closed properly', () => {
    const hub = new TestHub();
    ready(hub);
    hub.advance(301 * SEC);
    expect(hub.snapshot().phase).toBe('WAITING_FOR_EXIT');
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('INVALID_STATE');
    hub.command('gate', 'CONFIRM_EXIT');
    const closedRound = hub.snapshot().active_round!;
    expect(closedRound.result).toBe('TIME_UP');
    hub.command('gate', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    expect(hub.command('gate', 'GATE_FINALIZE').ok).toBe(true);
    expect(leaderboard(hub.snapshot())).toHaveLength(0);
  });
});

describe('admin — the retained supervisor surface', () => {
  it('9. reopening a reset revokes readiness and demands all checks again', () => {
    const hub = new TestHub();
    playRound(hub);
    const closed = hub.snapshot().rounds.at(-1)!;
    expect(hub.command('gate', 'REOPEN_RESET', { round_id: closed.id, reason: 'quên đồ' }).code).toBe('PERMISSION_DENIED');
    expect(hub.command('supervisor', 'REOPEN_RESET', { round_id: closed.id }).code).toBe('BLOCKED');
    expect(hub.command('supervisor', 'REOPEN_RESET', { round_id: closed.id, reason: 'Chưa đặt lại vật ẩn' }).ok).toBe(true);
    const reopened = hub.snapshot().rounds.at(-1)!;
    expect(reopened.reset_cycle).toBe(closed.reset_cycle + 1);
    expect(reopened.system_ready_at).toBeNull();
    expect(reopened.status).toBe('EXIT_CONFIRMED');
    expect(hub.snapshot().reset_tasks.every((t) => t.completed_at === null)).toBe(true);
    // A mark from the previous cycle can never satisfy the new one.
    hub.command('gate', 'RESET_DONE');
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED');
    hub.command('room305', 'RESET_DONE');
    expect(hub.command('gate', 'GATE_FINALIZE').ok).toBe(true);
  });

  it('9b. a reopened reset cannot be revived once a new team is on the floor', () => {
    const hub = new TestHub();
    playRound(hub);
    const first = hub.snapshot().rounds[0];
    hub.command('lobby', 'CALL_TEAM');
    const res = hub.command('supervisor', 'REOPEN_RESET', { round_id: first.id, reason: 'muộn' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_STATE');
  });

  it('10. a corrected timestamp is flagged and never silently re-ranked', () => {
    const hub = new TestHub();
    playRound(hub);
    const round = hub.snapshot().rounds.at(-1)!;
    expect(hub.command('supervisor', 'CORRECT_ROUND', { round_id: round.id, field: 'outcome', reason: 'x' }).code).toBe('INVALID_STATE');
    expect(hub.command('supervisor', 'CORRECT_ROUND', { round_id: round.id, field: 'exit_confirmed_at', value_ms: round.exit_confirmed_at! + 5000, reason: 'Sửa giờ bấm' }).ok).toBe(true);
    const corrected = hub.snapshot().rounds.at(-1)!;
    expect(corrected.needs_review).toBe(true);
    expect(corrected.review_reasons).toContain('CORRECTED');
    expect(leaderboard(hub.snapshot())).toHaveLength(0);
    // A supervisor decision is required before the result ranks again.
    expect(hub.command('supervisor', 'REVIEW_RESOLVE', { round_id: corrected.id, decision: 'ACCEPT' }).code).toBe('BLOCKED');
    expect(hub.command('supervisor', 'REVIEW_RESOLVE', { round_id: corrected.id, decision: 'ACCEPT', reason: 'Đã xem lại băng ghi hình' }).ok).toBe(true);
    expect(hub.snapshot().rounds.at(-1)!.needs_review).toBe(false);
    expect(leaderboard(hub.snapshot())).toHaveLength(1);
    // Rejecting keeps the record but removes it from the ranking for good.
    hub.command('supervisor', 'CORRECT_ROUND', { round_id: corrected.id, field: 'exit_confirmed_at', value_ms: corrected.exit_confirmed_at, reason: 'Hiệu chỉnh lần hai' });
    hub.command('supervisor', 'REVIEW_RESOLVE', { round_id: corrected.id, decision: 'REJECT', reason: 'Không thống nhất với log' });
    expect(hub.snapshot().rounds.at(-1)!.decertified).toBe(true);
    expect(leaderboard(hub.snapshot())).toHaveLength(0);
  });

  it('11. closing the event is explicit, reasoned and only with an empty area', () => {
    const hub = new TestHub();
    ready(hub);
    expect(hub.command('supervisor', 'END_EVENT', {}).code).toBe('BLOCKED');
    expect(hub.command('supervisor', 'END_EVENT', { reason: 'Hết ca' }).code).toBe('BLOCKED'); // team inside
    playRound(hub);
    expect(hub.command('lobby', 'END_EVENT', { reason: 'Hết ca' }).code).toBe('PERMISSION_DENIED');
    expect(hub.command('supervisor', 'END_EVENT', { reason: 'Hết ca' }).ok).toBe(true);
    const snap = hub.snapshot();
    expect(snap.phase).toBe('ENDED');
    expect(snap.event_status).toBe('ENDED');
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
  });

  it('12. the supervisor can abort, and the abort can never look like a win', () => {
    const hub = new TestHub();
    ready(hub);
    hub.advance(50 * SEC);
    // A cancellation has to say why, and what kind of why: the kind decides whether
    // an outstanding claim can still be judged (V3.1 §4.4).
    expect(hub.command('supervisor', 'ABORT_ROUND', {}).code).toBe('BLOCKED');
    expect(hub.command('supervisor', 'ABORT_ROUND', { reason: 'Khách cần cấp cứu' }).code).toBe('INVALID_STATE');
    expect(hub.command('supervisor', 'ABORT_ROUND', { kind: 'technical' }).code).toBe('BLOCKED');
    expect(hub.command('supervisor', 'ABORT_ROUND', { reason: 'Khách cần cấp cứu', kind: 'safety' }).ok).toBe(true);
    const round = hub.snapshot().active_round!;
    expect(round.result).toBe('ABORTED');
    expect(round.official_duration_ms).toBeNull();
    // P0: cancelling a round says nothing about where the players are standing. No
    // departure may be recorded by this press, so the area stays closed to the next
    // team until NPC1 confirms it (§4.2).
    expect(round.exit_confirmed_at).toBeNull();
    expect(round.exit_by).toBeNull();
    expect(round.exit_by_role).toBeNull();
    expect(round.abort_kind).toBe('safety');
    expect(round.abort_reason).toBe('Khách cần cấp cứu');
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('INVALID_STATE');
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
    expect(leaderboard(hub.snapshot())).toHaveLength(0);
    expect(analytics(hub.snapshot(), hub.now()).aborted).toBe(1);
    // NPC1 confirming the departure is a separate, physical act, and it cannot move
    // a score that was never earned.
    expect(hub.command('gate', 'CONFIRM_EXIT').ok).toBe(true);
    expect(hub.snapshot().active_round!.official_duration_ms).toBeNull();
  });

  it('13. admission has no hidden deadline any more, only one game at a time', () => {
    const hub = new TestHub();
    const snap = hub.snapshot();
    expect(evaluateDispatch(snap.event, hub.now()).allowed).toBe(true);
    expect(evaluateGameStart(snap.event, hub.now()).allowed).toBe(true);
    hub.advance(2 * 60 * MIN); // far past any former 90-minute framing
    const later = hub.snapshot();
    expect(evaluateDispatch(later.event, hub.now()).allowed).toBe(true);
    expect(later.event.overtime_started_at).toBeNull();
  });
});

describe('legacy rows — the upgrade keeps a running event readable', () => {
  /** A snapshot shaped exactly like a database row written before the unified flow. */
  function legacyRound(status: string, extra: Record<string, unknown> = {}) {
    return {
      id: 'rnd_legacy',
      event_id: 'evt_1',
      round_number: 1,
      team_number: 1,
      team_name: 'Cu',
      status,
      stage: 3,
      called_at: T0,
      game_anchor_ms: null,
      game_elapsed_ms: 0,
      game_stopped_at: null,
      game_reset_count: 1,
      game_pause_count: 2,
      official_duration_ms: null,
      puzzle_completed_at: null,
      exit_confirmed_at: null,
      gate_finalized_at: null,
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
      ...extra,
    };
  }

  it('14. old statuses map onto the single vocabulary', () => {
    const map: [string, string][] = [
      ['LOBBY_CALL', 'WAITING_FLOOR2_CONFIRMATION'],
      ['TEAM_PREPARING', 'WAITING_FLOOR2_CONFIRMATION'],
      ['GAME_STARTED', 'RUNNING'],
      ['CORRIDOR_ACTIVE', 'RUNNING'],
      ['ROOM_REACHED', 'RUNNING'],
      ['PUZZLE_COMPLETED', 'RUNNING'],
      ['RETURNING', 'RUNNING'],
      ['GAME_EXITED', 'EXIT_CONFIRMED'],
      ['RESETTING', 'EXIT_CONFIRMED'],
      ['RESET_CONFIRMED', 'EXIT_CONFIRMED'],
      ['GATE_CLEARED', 'CLOSED'],
    ];
    for (const [from, to] of map) {
      const snap = legacySnapshot(legacyRound(from, { game_started_at: T0 + 60_000, game_stopped_at: from === 'GAME_STARTED' ? null : T0 + 200_000 }));
      expect(snap.rounds[0].status, from).toBe(to);
      expect(isTerminalRound(snap.rounds[0]), from).toBe(to === 'CLOSED');
    }
  });

  it('14b. a legacy round already in play keeps the time it had left', () => {
    // Written while the window was pausable: 80 s banked, 20 s in the current segment.
    const snap = legacySnapshot(
      legacyRound('GAME_STARTED', { game_started_at: T0 + 60_000, game_anchor_ms: T0 + 100_000, game_elapsed_ms: 80_000 }),
    );
    const round = snap.rounds[0];
    expect(round.status).toBe('RUNNING');
    expect(round.deadline_at).toBeNull();
    // 300 s - (80 s + 20 s) = 200 s still on the clock at T0 + 120 s.
    expect(gameRemainingMs(round, 300 * SEC, T0 + 120_000)).toBe(200 * SEC);
    // And a legacy win is still a win for the ranking.
    const won = legacySnapshot(
      legacyRound('GATE_CLEARED', {
        game_started_at: T0 + 60_000,
        game_stopped_at: T0 + 200_000,
        official_duration_ms: 140_000,
        puzzle_completed_at: T0 + 190_000,
        exit_confirmed_at: T0 + 200_000,
        gate_finalized_at: T0 + 300_000,
        system_ready_at: T0 + 300_000,
        outcome: 'WON',
      }),
    );
    expect(won.rounds[0].result).toBe('WON');
    expect(leaderboard(won)).toHaveLength(1);
  });

  it('15. alerts never invent a state, they only report one', () => {
    const hub = new TestHub();
    ready(hub);
    // Over the deadline and over the stall warning, with nobody confirming the exit.
    hub.advance(305 * SEC + STALL_WARN_MS);
    const alerts = resolveAlerts(hub.snapshot(), hub.now(), false);
    expect(alerts.map((a) => a.id)).toContain('STALL');
    // Nothing above changed the authoritative state.
    expect(hub.snapshot().active_round!.exit_confirmed_at).toBeNull();
  });
});

/**
 * Reads a pre-upgrade state through the engine's own hydrate path, which is exactly
 * what happens to the live row when a deploy lands mid-event.
 *
 * The round arrives with the arbitrary event_id `evt_1` (the legacy status vocabulary
 * is what is under test, not the event pointer). We re-home it on the seeded event
 * before handing the state to the engine, because snapshot() filters every array on
 * the current event id — the same contract sc.snapshot() enforces in production.
 */
function legacySnapshot(round: Record<string, unknown>): Snapshot {
  const base = initialState(T0);
  const state = {
    ...base,
    event: { ...base.event, event_started_at: T0, revision: 1 },
    rounds: [{ ...round, event_id: base.event.id }],
  };
  const engine = new ScreamEngine(state as never, new FakeClock(T0 + 120_000), {});
  return engine.snapshot();
}

/** Reporting aggregates, exercised on a full event. */
describe('reporting — analytics over the whole event', () => {
  it('16. counts and averages come from persisted stamps', () => {
    const hub = new TestHub();
    playRound(hub, { claimMs: 100 * SEC });
    playRound(hub, { claimMs: 220 * SEC });
    playRound(hub, { puzzle: false });
    const snap: Snapshot = hub.snapshot();
    const stats = analytics(snap, hub.now());
    expect(stats.teams_completed).toBe(3);
    expect(stats.teams_successful).toBe(2);
    expect(stats.timeouts).toBe(1);
    expect(stats.claims).toBe(2);
    expect(stats.fastest!.duration_ms).toBe(100 * SEC);
    expect(stats.avg_game_ms).toBe((100 * SEC + 220 * SEC) / 2);
    expect(snap.rounds.map((r) => r.status)).toEqual(['CLOSED', 'CLOSED', 'CLOSED']);
  });
});
