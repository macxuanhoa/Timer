import { describe, expect, it } from 'vitest';
import { MIN, SEC, TestHub, entries, latest, playRound } from './helpers/harness';
import { analytics, leaderboard, roundMetrics, cycleMetrics } from '../src/shared/metrics';
import { evaluateDispatch, evaluateGameStart, gameRemainingMs } from '../src/shared/machine';
import { resolveAlerts, resolveHero } from '../src/client/selectors';

/**
 * Every case here runs on the controlled fake clock so long event durations can
 * be exercised without waiting in real time.
 */
describe('PASS 1 — event & game timekeeping', () => {
  it('1. the first dispatch is history only; elapsed event time never closes it', () => {
    const hub = new TestHub();
    expect(hub.snapshot().phase).toBe('PRE_EVENT');
    expect(hub.snapshot().event.config.event_duration_ms).toBe(90 * MIN);
    // nothing has gone upstairs yet, so no event timestamp has been recorded
    expect(hub.snapshot().event.event_started_at).toBeNull();

    expect(hub.command('gate', 'CALL_TEAM').code).toBe('PERMISSION_DENIED'); // §2 lobby only
    const res = hub.command('lobby', 'CALL_TEAM');
    expect(res.ok).toBe(true);
    expect(hub.snapshot().event.event_started_at).toBe(hub.now());
    expect(hub.snapshot().event.config).toMatchObject({ game_limit_ms: 5 * MIN });

    hub.advance(91 * MIN);
    expect(hub.snapshot().event_status).toBe('LIVE');
    // Elapsed event time never ends the event or limits the next team.
    expect(hub.snapshot().event.event_ended_at).toBeNull();
    expect(hub.snapshot().phase).toBe('PREPARING');
  });

  it('1b. no database write happens on a countdown frame', () => {
    const hub = new TestHub();
    const revision = hub.snapshot().revision;
    for (let i = 0; i < 500; i++) hub.advance(200); // 100 simulated seconds of ticking
    expect(hub.snapshot().revision).toBe(revision);
    const warnings = entries(hub).filter((l) => l.actor_id === 'system.clock');
    expect(warnings).toHaveLength(0);
  });

  it('2. the 5-minute game clock starts independently and expires at 300 s', () => {
    const hub = new TestHub();
    hub.advance(10 * MIN);
    hub.command('lobby', 'CALL_TEAM');
    const startedAt = hub.now() + 70 * SEC;
    hub.advance(70 * SEC);
    expect(hub.command('lobby', 'START_GAME').code).toBe('PERMISSION_DENIED'); // GATE owns the clock
    hub.command('gate', 'START_GAME');
    const round = hub.snapshot().active_round!;
    expect(round.game_started_at).toBe(startedAt);
    expect(round.game_started_at! - round.called_at).toBe(70 * SEC);

    hub.advance(5 * MIN - 1);
    expect(hub.snapshot().phase).toBe('RUNNING');
    hub.advance(1);
    expect(hub.snapshot().phase).toBe('GAME_OVERTIME');
    expect(hub.snapshot().active_round!.game_stopped_at).toBeNull();
  });

  it('3. preparation time never enters the official score', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(4 * MIN); // an unusually slow walk upstairs
    hub.command('gate', 'START_GAME');
    hub.advance(90 * SEC);
    hub.command('room305', 'ROOM_REACHED');
    hub.command('room305', 'PUZZLE_COMPLETE');
    hub.advance(30 * SEC);
    hub.command('gate', 'GAME_STOP');
    const round = hub.snapshot().rounds.at(-1)!;
    expect(round.official_duration_ms).toBe(120 * SEC);
    expect(roundMetrics(round, hub.snapshot().reset_tasks).prep_ms).toBe(4 * MIN);
    expect(leaderboard(hub.snapshot())[0].duration_ms).toBe(120 * SEC);
  });

  it('4. the event clock keeps running through prep, play, resets and idle', () => {
    const hub = new TestHub();
    const startedAt = hub.now();
    const marks: number[] = [];
    for (let i = 0; i < 3; i++) {
      playRound(hub, { prepMs: 60 * SEC, gameMs: 120 * SEC, resetMs: 45 * SEC });
      marks.push(hub.snapshot().server_now_ms - startedAt);
      hub.advance(30 * SEC); // lobby idle
    }
    // the first dispatch anchored the timeline once and it never moved again
    expect(hub.snapshot().event.event_started_at).toBe(startedAt);
    expect(marks).toEqual([225 * SEC, 480 * SEC, 735 * SEC]);
    expect(hub.snapshot().event.config.event_duration_ms).toBe(90 * MIN);
  });

  it('5. every meaningful action is an immutable, server-timestamped log entry', () => {
    const hub = new TestHub();
    playRound(hub);
    const log = entries(hub);
    const required = ['CALL_TEAM', 'START_GAME', 'HALLWAY_PROGRESS', 'ROOM_REACHED', 'PUZZLE_COMPLETE', 'RETURN_START', 'GAME_STOP', 'RESET_DONE', 'GATE_FINALIZE'];
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
    // monotonic per-event ordering and team attribution
    const seqs = log.map((l) => l.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(log.every((l) => l.event_id === hub.snapshot().event.id)).toBe(true);
  });

  it('6. derives preparation, game, reset and cycle durations from real timestamps', () => {
    const hub = new TestHub({ hiddenObjectOwner: 'GATE' });
    hub.command('lobby', 'CALL_TEAM', { team_name: 'Nu 1' });
    hub.advance(75 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(100 * SEC);
    hub.command('room305', 'ROOM_REACHED');
    hub.command('room305', 'PUZZLE_COMPLETE');
    hub.advance(20 * SEC);
    hub.command('gate', 'GAME_STOP'); // official 120s
    const stopAt = hub.now();
    hub.advance(10 * SEC);
    hub.command('corridor', 'RESET_DONE'); // hallway 10s after stop
    hub.advance(5 * SEC);
    hub.command('room305', 'RESET_DONE'); // room 15s after stop
    hub.advance(5 * SEC);
    hub.command('gate', 'RESET_DONE'); // hidden objects (owner=GATE) 20s after stop
    hub.advance(2 * SEC);
    hub.command('gate', 'GATE_FINALIZE');
    const readyAt = hub.now();

    const snap = hub.snapshot();
    const round = snap.rounds[0];
    const m = roundMetrics(round, snap.reset_tasks);
    expect(m.game_ms).toBe(120 * SEC);
    expect(m.prep_ms).toBe(75 * SEC);
    expect(m.reset_total_ms).toBe(readyAt - stopAt);
    expect(m.corridor_reset_ms).toBe(10 * SEC);
    expect(m.room_reset_ms).toBe(15 * SEC);
    expect(m.hidden_objects_reset_ms).toBe(20 * SEC);
    expect(m.gate_clear_ms).toBe(22 * SEC);

    // second team, for the cross-round measurements
    hub.advance(30 * SEC);
    const called2 = hub.now();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    const r2 = hub.snapshot().rounds[1];
    const c = cycleMetrics(round, r2);
    expect(c.inter_team_ms).toBe(r2.game_started_at! - stopAt);
    expect(c.start_to_start_ms).toBe(r2.game_started_at! - round.game_started_at!);
    expect(c.idle_after_ready_ms).toBe(called2 - readyAt);
    expect(c.next_prep_ms).toBe(60 * SEC);
  });

  it('7. concurrent reset confirmations are recorded separately', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(60 * SEC);
    hub.command('gate', 'GAME_STOP');
    hub.command('corridor', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE'); // same instant, different operator
    const done = entries(hub).filter((l) => l.action === 'RESET_DONE');
    expect(done.length).toBe(2);
    expect(done[0].at_ms).toBe(done[1].at_ms);
    expect(done[0].actor_role).not.toBe(done[1].actor_role);
    expect(done.map((d) => JSON.stringify(d.metadata?.tasks))).not.toEqual([]);
    const tasks = hub.snapshot().reset_tasks;
    expect(tasks.filter((t) => t.completed_at !== null).length).toBe(3); // hidden_objects belongs to CORRIDOR here
    expect(hub.command('gate', 'GATE_FINALIZE').ok).toBe(true);
  });

  it('8. the next team is blocked until every reset and GATE clearance', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(60 * SEC);
    hub.command('gate', 'GAME_STOP');

    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE'); // area busy until cleared
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED'); // resets not done
    hub.command('corridor', 'RESET_DONE'); // hallway + hidden objects (default owner)
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED'); // room 305 still pending
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
    hub.command('room305', 'RESET_DONE');
    expect(hub.snapshot().reset_tasks.every((t) => t.completed_at !== null)).toBe(true);
    expect(hub.command('room305', 'GATE_FINALIZE').code).toBe('PERMISSION_DENIED');
    expect(hub.command('gate', 'GATE_FINALIZE').ok).toBe(true);

    const ready = hub.snapshot();
    expect(ready.phase).toBe('READY');
    expect(ready.active_round).toBeNull();
    expect(ready.rounds[0].system_ready_at).toBe(hub.now());
    expect(hub.command('lobby', 'CALL_TEAM').ok).toBe(true);
  });

  it('8b. an expired timer never implies readiness', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(60 * SEC);
    hub.command('gate', 'GAME_STOP');
    hub.command('corridor', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    hub.command('corridor', 'RESET_DONE');
    hub.advance(10 * MIN); // long stall with nobody pressing GATE
    expect(hub.snapshot().phase).not.toBe('READY');
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
  });
});

describe('PASS 1 — admission control, integrity and outcomes', () => {
  it('9. allows dispatch and start after the legacy 90-minute duration', () => {
    const hub = new TestHub();
    playRound(hub);
    hub.advance(91 * MIN);
    const called = hub.command('lobby', 'CALL_TEAM');
    expect(called.ok).toBe(true);
    expect(hub.snapshot().active_round?.admission_override).toBe(false);
    expect(evaluateDispatch(hub.snapshot().event, hub.now()).allowed).toBe(true);
    expect(hub.command('gate', 'START_GAME').ok).toBe(true);
    expect(evaluateGameStart(hub.snapshot().event, hub.now()).allowed).toBe(true);
  });

  it('9b. explicit supervisor closure still blocks later dispatches', () => {
    const hub = new TestHub();
    playRound(hub);
    expect(hub.command('supervisor', 'END_EVENT', { reason: 'Đóng theo kế hoạch' }).ok).toBe(true);
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
    expect(hub.command('supervisor', 'CALL_TEAM').code).toBe('INVALID_STATE');
  });

  it('10. confirming the puzzle does not stop the clock', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(80 * SEC);
    hub.command('room305', 'ROOM_REACHED');
    const res = hub.command('room305', 'PUZZLE_COMPLETE');
    expect(res.ok).toBe(true);
    const round = hub.snapshot().active_round!;
    expect(round.puzzle_completed_at).not.toBeNull();
    expect(round.game_stopped_at).toBeNull();
    expect(round.official_duration_ms).toBeNull();
    expect(hub.snapshot().phase).toBe('RUNNING');
    // a duplicate confirmation must not add a second timestamp
    hub.advance(10 * SEC);
    expect(hub.command('room305', 'PUZZLE_COMPLETE').ok).toBe(true);
    expect(hub.snapshot().active_round!.puzzle_completed_at).toBe(round.puzzle_completed_at);
  });

  it('11. a timeout does not clear the game area automatically', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(5 * MIN + 40 * SEC);
    const stuck = hub.snapshot();
    expect(stuck.phase).toBe('GAME_OVERTIME');
    expect(stuck.active_round!.game_stopped_at).toBeNull();
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
    expect(hub.command('supervisor', 'END_EVENT').code).toBe('BLOCKED');
    // GATE keeps control until the last player is out
    hub.command('gate', 'GAME_STOP');
    const stopped = hub.snapshot().rounds.at(-1)!;
    expect(stopped.outcome).toBe('TIMEOUT');
    expect(stopped.official_duration_ms).toBe(5 * MIN + 40 * SEC);
    expect(leaderboard(hub.snapshot())).toHaveLength(0);
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED');
    hub.advance(40 * SEC);
    hub.command('corridor', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    hub.command('corridor', 'RESET_DONE');
    expect(hub.command('gate', 'GATE_FINALIZE').ok).toBe(true);
  });

  it('11b. elapsed event time has no overtime state and never closes a round', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(90 * MIN); // no event-level deadline
    const snap = hub.snapshot();
    expect(snap.event.overtime_started_at).toBeNull();
    expect(snap.event.event_ended_at).toBeNull();
    expect(snap.phase).toBe('GAME_OVERTIME');
    hub.command('room305', 'ROOM_REACHED');
    hub.command('room305', 'PUZZLE_COMPLETE');
    hub.command('gate', 'GAME_STOP');
    expect(hub.snapshot().event.event_ended_at).toBeNull(); // team still being escorted out
    hub.advance(30 * SEC);
    hub.command('corridor', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    hub.command('corridor', 'RESET_DONE');
    hub.command('gate', 'GATE_FINALIZE');
    const closed = hub.snapshot();
    // The room stays available for the next team until a supervisor closes it.
    expect(closed.event.event_ended_at).toBeNull();
    expect(closed.event_status).toBe('LIVE');
    expect(closed.phase).toBe('READY');
    expect(hub.command('lobby', 'CALL_TEAM').ok).toBe(true);
  });

  it('12. the official STOP closes the round exactly once', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(111_111);
    expect(hub.command('gate', 'GAME_STOP').ok).toBe(true);
    const first = hub.snapshot().rounds.at(-1)!;
    hub.advance(9 * SEC);
    const again = hub.command('room305', 'GAME_STOP'); // wrong role AND already closed
    expect(again.code).toBe('PERMISSION_DENIED');
    expect(hub.command('gate', 'GAME_STOP').ok).toBe(true); // double tap
    const second = hub.snapshot().rounds.at(-1)!;
    expect(second.official_duration_ms).toBe(111_111);
    expect(second.game_stopped_at).toBe(first.game_stopped_at);
    expect(entries(hub).filter((l) => l.action === 'GAME_STOP')).toHaveLength(1);
  });

  it('13. duplicate actions cannot duplicate timestamps, scores or revisions', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    const key = 'tap-start-1';
    const first = hub.command('gate', 'START_GAME', {}, undefined, key);
    const revisionAfter = hub.snapshot().revision;
    const replay = hub.command('gate', 'START_GAME', {}, undefined, key); // retry with same key
    expect(replay.ok).toBe(true);
    expect(replay.revision).toBe(revisionAfter);
    expect(entries(hub).filter((l) => l.action === 'START_GAME')).toHaveLength(1);
    expect(first.ok).toBe(true);

    // optimistic concurrency: a stale phone must not advance the machine
    const stale = hub.command('room305', 'ROOM_REACHED', {}, 0);
    expect(stale.code).toBe('STALE_REVISION');
    expect(hub.snapshot().revision).toBe(revisionAfter);

    // already-recorded reset task keeps its original timestamp
    hub.advance(60 * SEC);
    hub.command('gate', 'GAME_STOP');
    hub.advance(10 * SEC);
    hub.command('corridor', 'RESET_DONE');
    const at = hub.snapshot().reset_tasks.find((t) => t.task_key === 'hallway')!.completed_at;
    hub.advance(40 * SEC);
    expect(hub.command('corridor', 'RESET_DONE').ok).toBe(true);
    expect(hub.snapshot().reset_tasks.find((t) => t.task_key === 'hallway')!.completed_at).toBe(at);
  });

  it('18. the leaderboard only ranks completed, exited, in-time teams', () => {
    const hub = new TestHub();
    playRound(hub, { gameMs: 200 * SEC }); // win 200s
    playRound(hub, { gameMs: 100 * SEC }); // win 100s
    playRound(hub, { gameMs: 150 * SEC, puzzle: false }); // no puzzle
    hub.advance(50 * SEC);
    // timeout round
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(30 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(5 * MIN + 5 * SEC);
    hub.command('gate', 'GAME_STOP');
    hub.advance(20 * SEC);
    hub.command('corridor', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    hub.command('corridor', 'RESET_DONE');
    hub.command('gate', 'GATE_FINALIZE');

    const snap = hub.snapshot();
    const rows = leaderboard(snap);
    expect(rows.map((r) => [r.rank, r.team_number, r.duration_ms])).toEqual([
      [1, 2, 100 * SEC],
      [2, 1, 200 * SEC],
    ]);
    const stats = analytics(snap, hub.now());
    expect(stats.teams_completed).toBe(4);
    expect(stats.teams_successful).toBe(2);
    expect(stats.timeouts).toBe(1);
    expect(stats.avg_game_ms).toBe(150 * SEC);
    expect(stats.fastest?.team_number).toBe(2);
  });

  it('19. emergency abort is explicit, reasoned and audited', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(45 * SEC);
    expect(hub.command('gate', 'ABORT_ROUND').code).toBe('PERMISSION_DENIED');
    expect(hub.command('supervisor', 'ABORT_ROUND').code).toBe('BLOCKED'); // no reason
    const res = hub.command('supervisor', 'ABORT_ROUND', { reason: 'Khach gian du' });
    expect(res.ok).toBe(true);
    const round = hub.snapshot().rounds.at(-1)!;
    expect(round.outcome).toBe('ABORTED');
    expect(round.aborted_at).toBe(hub.now());
    const entry = latest(hub, 'ABORT_ROUND')!;
    expect(entry.metadata?.reason).toBe('Khach gian du');
    expect(leaderboard(hub.snapshot())).toHaveLength(0);
    // the area still has to be reset before the next team
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED');
    expect(hub.snapshot().phase).toBe('RESETTING');
  });

  it('19b. supervisor corrections keep an audit trail and withhold the result', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(120 * SEC);
    hub.command('room305', 'ROOM_REACHED');
    hub.command('room305', 'PUZZLE_COMPLETE');
    hub.command('gate', 'GAME_STOP');
    const round = hub.snapshot().rounds.at(-1)!;
    const corrected = round.game_stopped_at! - 10 * SEC;
    expect(hub.command('gate', 'CORRECT_ROUND', { round_id: round.id, field: 'game_stopped_at', value_ms: corrected }).code).toBe('PERMISSION_DENIED');
    const res = hub.command('supervisor', 'CORRECT_ROUND', {
      round_id: round.id,
      field: 'game_stopped_at',
      value_ms: corrected,
      reason: 'GATE nhan cham 10s',
    });
    expect(res.ok).toBe(true);
    const after = hub.snapshot().rounds.at(-1)!;
    expect(after.official_duration_ms).toBe(110 * SEC);
    const audit = latest(hub, 'CORRECT_ROUND')!;
    expect(audit.metadata).toMatchObject({ before_ms: round.game_stopped_at, after_ms: corrected, reason: 'GATE nhan cham 10s' });
    // A hand-corrected score is prize-relevant: it ranks only after a decision.
    expect(after.needs_review).toBe(true);
    expect(leaderboard(hub.snapshot())).toHaveLength(0);
    expect(hub.command('supervisor', 'REVIEW_RESOLVE', { round_id: round.id, decision: 'ACCEPT' }).code).toBe('BLOCKED');
    const decided = hub.command('supervisor', 'REVIEW_RESOLVE', {
      round_id: round.id,
      decision: 'ACCEPT',
      reason: 'Da doi chieu nhat ky GATE',
    });
    expect(decided.ok).toBe(true);
    expect(leaderboard(hub.snapshot())[0].duration_ms).toBe(110 * SEC);
  });

  it('19c. a closed round cannot be re-timed, and an undo is not a silent delete', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(60 * SEC);
    hub.command('room305', 'ROOM_REACHED');
    hub.command('room305', 'PUZZLE_COMPLETE'); // wrongly confirmed (Scenario A)
    hub.command('gate', 'GAME_STOP');
    const round = hub.snapshot().rounds.at(-1)!;
    hub.advance(20 * SEC);
    hub.command('corridor', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    hub.command('gate', 'GATE_FINALIZE');

    // start/stop marks are frozen once the area is READY
    expect(
      hub.command('supervisor', 'CORRECT_ROUND', { round_id: round.id, field: 'game_stopped_at', value_ms: round.game_stopped_at! - 1000, reason: 'x' })
        .code,
    ).toBe('INVALID_STATE');

    // the puzzle confirmation can still be revoked, keeping the original value
    const undo = hub.command('supervisor', 'CORRECT_ROUND', {
      round_id: round.id,
      field: 'puzzle_completed_at',
      value_ms: null,
      reason: 'Nham phong 305 chua giai',
    });
    expect(undo.ok).toBe(true);
    const fixed = hub.snapshot().rounds.at(-1)!;
    expect(fixed.puzzle_completed_at).toBeNull();
    expect(fixed.outcome).toBe('NO_PUZZLE');
    const audit = latest(hub, 'CORRECT_ROUND')!;
    expect(audit.metadata).toMatchObject({ undone: true, before_ms: round.puzzle_completed_at });
    expect(leaderboard(hub.snapshot())).toHaveLength(0);
  });

  it('19d. closing the event early is an explicit, reasoned decision', () => {
    const hub = new TestHub();
    expect(hub.command('supervisor', 'END_EVENT').code).toBe('BLOCKED');
    expect(hub.command('supervisor', 'END_EVENT', { reason: 'Chap dien ngat dien' }).ok).toBe(true);
    const entry = latest(hub, 'END_EVENT')!;
    expect(entry.metadata?.reason).toBe('Chap dien ngat dien');
    // a closed event can never be re-opened by dispatching another team
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
    expect(hub.command('supervisor', 'END_EVENT', { reason: 'lan 2' }).code).toBe('INVALID_STATE');
  });

  it('20. the event accepts teams after 90 minutes and still closes explicitly', () => {
    const hub = new TestHub();
    const startedAt = hub.now();
    for (let i = 0; i < 24; i++) {
      playRound(hub, { prepMs: 70 * SEC, gameMs: 140 * SEC, resetMs: 50 * SEC });
      hub.advance(20 * SEC);
    }
    hub.advance(10 * MIN);
    expect(hub.now() - startedAt).toBeGreaterThan(90 * MIN);
    expect(hub.snapshot().event.event_ended_at).toBeNull();
    expect(hub.snapshot().phase).toBe('READY');
    expect(evaluateDispatch(hub.snapshot().event, hub.now()).allowed).toBe(true);
    const afterLimit = playRound(hub, { prepMs: 10 * SEC, gameMs: 30 * SEC, resetMs: 10 * SEC });
    expect(afterLimit.stop.ok).toBe(true);
    const rounds = hub.snapshot().rounds.length;
    expect(rounds).toBe(25);
    const snap = hub.snapshot();
    expect(leaderboard(snap)).toHaveLength(rounds);
    expect(hub.command('supervisor', 'END_EVENT', { reason: 'Đóng có kiểm soát' }).ok).toBe(true);
    expect(hub.snapshot().phase).toBe('ENDED');
    const stats = analytics(hub.snapshot(), hub.now());
    expect(stats.teams_completed).toBe(rounds);
    expect(stats.avg_cycle_ms).not.toBeNull();
    expect(entries(hub).length).toBeGreaterThan(rounds * 8);
  });
});

describe('PASS 1 — the flexible 5:00 window (pause / reset)', () => {
  /** A team on the clock: the first dispatch is recorded for history. */
  const onTheClock = () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    return hub;
  };

  it('21. a pause freezes only the 5:00 window and hands out no extra time', () => {
    const hub = onTheClock();
    hub.advance(90 * SEC);
    expect(hub.command('lobby', 'GAME_PAUSE').code).toBe('PERMISSION_DENIED'); // GATE owns the clock
    expect(hub.command('gate', 'GAME_PAUSE').ok).toBe(true);
    const limit = hub.snapshot().event.config.game_limit_ms;
    expect(gameRemainingMs(hub.snapshot().active_round!, limit, hub.now())).toBe(210 * SEC);

    hub.advance(91 * MIN); // no event cutoff; paused 5:00 stays frozen
    const paused = hub.snapshot();
    expect(gameRemainingMs(paused.active_round!, limit, hub.now())).toBe(210 * SEC);
    expect(paused.event_status).toBe('LIVE');
    expect(paused.event.event_ended_at).toBeNull();
    expect(paused.phase).toBe('RUNNING'); // a paused game is not overtime
    expect(resolveHero(paused, hub.now()).mode).toBe('GAME_PAUSED');
    expect(resolveAlerts(paused, hub.now(), false).some((a) => a.id === 'PAUSE')).toBe(true);

    hub.command('gate', 'GAME_RESUME');
    hub.advance(30 * SEC);
    hub.command('gate', 'GAME_STOP');
    const round = hub.snapshot().rounds.at(-1)!;
    expect(round.game_pause_count).toBe(1);
    // 90 s played + 30 s played; the 5 paused minutes are not scored
    expect(round.official_duration_ms).toBe(120 * SEC);
  });

  it('22. a reset restarts the 5:00, is audited and withholds the result until review', () => {
    const hub = onTheClock();
    hub.advance(200 * SEC);
    expect(hub.command('gate', 'GAME_RESET').ok).toBe(true);
    const round = hub.snapshot().active_round!;
    expect(round.game_reset_count).toBe(1);
    expect(round.review_reasons).toContain('GAME_RESET');
    expect(round.needs_review).toBe(true);
    expect(gameRemainingMs(round, hub.snapshot().event.config.game_limit_ms, hub.now())).toBe(5 * MIN);

    hub.advance(40 * SEC);
    hub.command('room305', 'ROOM_REACHED');
    hub.command('room305', 'PUZZLE_COMPLETE');
    hub.command('gate', 'GAME_STOP');
    expect(hub.snapshot().rounds.at(-1)!.official_duration_ms).toBe(40 * SEC);
    // a clock that was restarted is a prize decision, never a silent advantage
    expect(leaderboard(hub.snapshot())).toHaveLength(0);
    hub.command('supervisor', 'REVIEW_RESOLVE', { round_id: round.id, decision: 'ACCEPT', reason: 'Da xac nhan cho reset' });
    expect(leaderboard(hub.snapshot())[0].duration_ms).toBe(40 * SEC);
  });

  it('23. pause and reset need a live game and are rejected once GATE stopped it', () => {
    const hub = onTheClock();
    hub.advance(30 * SEC);
    hub.command('gate', 'GAME_STOP');
    expect(hub.command('gate', 'GAME_PAUSE').code).toBe('INVALID_STATE');
    expect(hub.command('gate', 'GAME_RESET').code).toBe('INVALID_STATE');
    const fresh = new TestHub();
    expect(fresh.command('gate', 'GAME_PAUSE').code).toBe('INVALID_STATE'); // no team yet
  });
});
