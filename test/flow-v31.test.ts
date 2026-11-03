import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/server/store';
import { TestHub, SEC, MIN, playRound } from './helpers/harness';
import { authorize, flowStatus, liveStatus, resultOf, roundLimitMs } from '../src/shared/machine';
import { resolveCountdown, resolvePrimary, resolveAttempts } from '../src/client/selectors';
import { ABORT_KINDS, RESET_TASK_LABEL, ROUND_DURATION_MAX_MS, ROUND_DURATION_MIN_MS } from '../src/shared/constants';
import { validateRoundDuration } from '../src/server/engine';

/**
 * V3.1 acceptance — the configurable countdown, the truth about a cancellation, and
 * the Vietnamese operator surface.
 *
 * Everything here runs on the local authoritative engine; the same rules are proved
 * again against the production PostgreSQL RPCs in supabase/tests/040_v31_hardening.sql.
 */

/** Receive, hand over and start a round whose default duration is `durationMs`. */
function started(hub: TestHub, durationMs: number) {
  expect(hub.command('supervisor', 'CONFIGURE', { game_limit_ms: durationMs }).ok).toBe(true);
  hub.command('lobby', 'CALL_TEAM');
  hub.command('corridor', 'CONFIRM_FLOOR2');
  hub.command('gate', 'START_GAME');
  return hub.snapshot().active_round!;
}

describe('V3.1 §12.2 — the duration configuration matrix', () => {
  it('T01-T04: every accepted duration becomes that round\'s own deadline', () => {
    for (const duration of [120_000, 300_000, 420_000, 210_000]) {
      const hub = new TestHub();
      const round = started(hub, duration);
      expect(round.deadline_at).toBe(round.game_started_at! + duration);
      expect(round.round_duration_ms).toBe(duration);
      expect(roundLimitMs(round, 300_000)).toBe(duration);
      // The receipt and the pre-start label name the duration that was actually used.
      expect(liveStatus(round, [], duration, hub.now())).toBe('RUNNING');
      expect(resolveCountdown(hub.snapshot(), hub.now()).durationMs).toBe(duration);
    }
  });

  it('T05-T06: nothing invalid is ever accepted, and nothing is stored', () => {
    const hub = new TestHub();
    for (const bad of [0, -1000, 1500, 999, ROUND_DURATION_MAX_MS + 1000, Number.NaN, 'abc', 1.5]) {
      const res = hub.command('supervisor', 'CONFIGURE', { game_limit_ms: bad as never });
      expect(res.ok, String(bad)).toBe(false);
      expect(res.code, String(bad)).toBe('INVALID_STATE');
    }
    expect(hub.snapshot().event.config.game_limit_ms).toBe(300_000);
    expect(validateRoundDuration(ROUND_DURATION_MIN_MS).ok).toBe(true);
    expect(validateRoundDuration(ROUND_DURATION_MAX_MS).ok).toBe(true);
    expect(validateRoundDuration(ROUND_DURATION_MAX_MS + 1000).ok).toBe(false);
  });

  it('T07: a change before START is what NPC1 is about to run', () => {
    const hub = new TestHub();
    expect(hub.command('supervisor', 'CONFIGURE', { game_limit_ms: 420_000 }).ok).toBe(true);
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    const primary = resolvePrimary('GATE', hub.snapshot(), hub.now());
    expect(primary.label).toBe('BẮT ĐẦU TRÒ CHƠI — 07:00');
    const round = hub.snapshot().active_round!;
    expect(roundLimitMs(round, hub.snapshot().event.config.game_limit_ms)).toBe(420_000);
  });

  it('T08: changing the default never moves a round that is already running', () => {
    const hub = new TestHub();
    const round = started(hub, 120_000);
    const before = { started: round.game_started_at, deadline: round.deadline_at, duration: round.round_duration_ms };
    expect(hub.command('supervisor', 'CONFIGURE', { game_limit_ms: 600_000 }).ok).toBe(true);
    const after = hub.snapshot().active_round!;
    expect(after.game_started_at).toBe(before.started);
    expect(after.deadline_at).toBe(before.deadline);
    expect(after.round_duration_ms).toBe(before.duration);
    // The receipt says plainly that the new value belongs to the next round.
    const res = hub.command('supervisor', 'CONFIGURE', { game_limit_ms: 300_000 });
    expect(res.message).toContain('lượt tiếp theo');
    expect(hub.snapshot().event.config.game_limit_ms).toBe(300_000);
  });

  it('T09: two rounds in a row keep their own windows', () => {
    const hub = new TestHub();
    const first = started(hub, 120_000);
    hub.advance(120 * SEC + 5 * SEC);
    hub.command('gate', 'CONFIRM_EXIT');
    hub.command('gate', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    hub.command('gate', 'GATE_FINALIZE');
    const second = started(hub, 420_000);
    expect(first.round_duration_ms).toBe(120_000);
    expect(second.round_duration_ms).toBe(420_000);
    expect(second.deadline_at! - second.game_started_at!).toBe(420_000);
    // The closed round is still scored against the window it actually had.
    const closed = hub.snapshot().rounds.find(r => r.id === first.id)!;
    expect(resultOf(closed, hub.snapshot().attempts, hub.snapshot().event.config.game_limit_ms, hub.now())).not.toBe('IN_PROGRESS');
  });

  it('T12: nobody but the supervisor may change the duration', () => {
    const hub = new TestHub();
    for (const id of ['lobby', 'corridor', 'gate', 'room305', 'observer']) {
      const res = hub.command(id, 'CONFIGURE', { game_limit_ms: 60_000 });
      expect(res.ok, id).toBe(false);
      expect(res.code, id).toBe(id === 'observer' ? 'READ_ONLY' : 'PERMISSION_DENIED');
    }
    expect(hub.snapshot().event.config.game_limit_ms).toBe(300_000);
  });

  it('T10: a refresh in the middle of a 07:00 round resumes the same countdown', () => {
    const store = new MemoryStore();
    const hub = new TestHub({ store });
    const round = started(hub, 420_000);
    hub.advance(90 * SEC);
    const view = resolveCountdown(hub.snapshot(), hub.now());
    expect(view.mm).toBe('05');
    expect(view.ss).toBe('30');
    // A reconnecting phone reads the persisted state, not a browser timer: the same
    // deadline and the same duration, with no restart and no extension.
    store.save(hub.engine.raw());
    const fresh = new TestHub({ store });
    const reloaded = fresh.snapshot().active_round!;
    expect(reloaded.deadline_at).toBe(round.deadline_at);
    expect(reloaded.game_started_at).toBe(round.game_started_at);
    expect(reloaded.round_duration_ms).toBe(420_000);
  });
});

describe('V3.1 §12.3 — claims, verification and expiry on every duration', () => {
  for (const duration of [120_000, 300_000, 420_000]) {
    describe(`round duration ${duration / SEC}s`, () => {
      it('scores the claim instant, never the verification instant', () => {
        const hub = new TestHub();
        const round = started(hub, duration);
        hub.advance(duration / 3);
        hub.command('room305', 'CLAIM_COMPLETE');
        const claim = hub.attempts().at(-1)!;
        hub.advance(11 * SEC);
        expect(hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' }).ok).toBe(true);
        const done = hub.snapshot().active_round!;
        expect(done.official_duration_ms).toBe(claim.elapsed_ms);
        expect(done.official_duration_ms).not.toBe(claim.elapsed_ms + 11 * SEC);
        expect(done.puzzle_completed_at).toBe(claim.claimed_at);
      });

      it('a claim recorded at or after the deadline can never win', () => {
        const hub = new TestHub();
        started(hub, duration);
        hub.advance(duration);
        hub.command('room305', 'CLAIM_COMPLETE');
        const late = hub.attempts().at(-1)!;
        expect(late.in_time).toBe(false);
        expect(late.status).toBe('LATE');
        const res = hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: late.id, decision: 'VALID' });
        expect(res.ok).toBe(false);
        expect(res.message).toContain('sau hết giờ');
        expect(hub.snapshot().active_round!.result).not.toBe('WON');
      });

      it('keeps every rejected attempt and lets the play continue', () => {
        const hub = new TestHub();
        started(hub, duration);
        hub.advance(duration / 4);
        hub.command('room305', 'CLAIM_COMPLETE');
        const first = hub.attempts().at(-1)!;
        hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: first.id, decision: 'INVALID' });
        hub.advance(duration / 4);
        hub.command('room305', 'CLAIM_COMPLETE');
        const second = hub.attempts().at(-1)!;
        expect(hub.attempts()).toHaveLength(2);
        expect(hub.attempts()[0].claimed_at).toBe(first.claimed_at);
        expect(second.elapsed_ms).toBe(first.elapsed_ms + duration / 4);
        // The countdown is untouched by either press.
        expect(liveStatus(hub.snapshot().active_round!, hub.snapshot().attempts, duration, hub.now())).toBe('RUNNING');
      });

      it('expiry with an open in-time claim is a provisional state, not a failure', () => {
        const hub = new TestHub();
        started(hub, duration);
        hub.advance(duration - 5 * SEC);
        hub.command('room305', 'CLAIM_COMPLETE');
        const claim = hub.attempts().at(-1)!;
        hub.advance(6 * SEC);
        const snap = hub.snapshot();
        expect(liveStatus(snap.active_round!, snap.attempts, duration, hub.now())).toBe('TIME_EXPIRED_PENDING_VALIDATION');
        expect(resultOf(snap.active_round!, snap.attempts, duration, hub.now())).toBe('PENDING_VALIDATION');
        // Closure is refused while the verdict is owed, then the claim still wins.
        expect(hub.command('gate', 'CONFIRM_EXIT').ok).toBe(true);
        expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED');
        expect(hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' }).ok).toBe(true);
        const done = hub.snapshot().active_round!;
        expect(done.result).toBe('WON');
        expect(done.official_duration_ms).toBe(claim.elapsed_ms);
      });

      it('expiry with nothing open is TIME UP, and the exit cannot change it', () => {
        const hub = new TestHub();
        started(hub, duration);
        hub.advance(duration + SEC);
        const snap = hub.snapshot();
        expect(resultOf(snap.active_round!, snap.attempts, duration, hub.now())).toBe('TIME_UP');
        hub.command('gate', 'CONFIRM_EXIT');
        expect(hub.snapshot().active_round!.result).toBe('TIME_UP');
        expect(hub.snapshot().active_round!.official_duration_ms).toBeNull();
      });

      it('a double tap records one claim, and a late request is never back-dated', () => {
        const hub = new TestHub();
        started(hub, duration);
        hub.advance(duration - SEC);
        const key = 'twice-claim';
        expect(hub.command('room305', 'CLAIM_COMPLETE', {}, undefined, key).ok).toBe(true);
        expect(hub.command('room305', 'CLAIM_COMPLETE', {}, undefined, key).ok).toBe(true);
        expect(hub.attempts()).toHaveLength(1);
        // A press made before the deadline whose request lands after it stays LATE:
        // the official instant is the server's, never the browser's claim.
        hub.advance(2 * SEC);
        const late = hub.command('room305', 'CLAIM_COMPLETE', {}, undefined, 'late-press', {
          press_ms: hub.now() - 3 * SEC, local_press_ms: Date.now(), rtt_ms: 0,
        });
        expect(late.ok).toBe(true);
        const recorded = hub.attempts().at(-1)!;
        expect(recorded.in_time).toBe(false);
        expect(recorded.claimed_at).toBeGreaterThan(hub.snapshot().active_round!.deadline_at!);
      });
    });
  }
});

describe('V3.1 §12.4 P0 — a cancellation is not a departure', () => {
  it('ABORT_ROUND records the cancellation and nothing about the players\' bodies', () => {
    const hub = new TestHub();
    started(hub, 300_000);
    hub.advance(50 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const pending = hub.attempts().at(-1)!;
    expect(hub.command('supervisor', 'ABORT_ROUND', { reason: 'hỏng điện' }).code).toBe('INVALID_STATE');
    expect(hub.command('supervisor', 'ABORT_ROUND', { kind: 'technical' }).code).toBe('BLOCKED');
    const res = hub.command('supervisor', 'ABORT_ROUND', { reason: 'hỏng điện', kind: 'technical' });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('NPC 1 vẫn cần xác nhận');
    const round = hub.snapshot().active_round!;
    expect(round.aborted_at).not.toBeNull();
    expect(round.abort_kind).toBe('technical');
    expect(round.abort_reason).toBe('hỏng điện');
    expect(round.exit_confirmed_at).toBeNull();
    expect(round.exit_by).toBeNull();
    expect(round.exit_by_role).toBeNull();
    // Neither the reset nor the next team may be reached without that confirmation.
    expect(hub.command('gate', 'RESET_DONE').code).toBe('INVALID_STATE');
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('INVALID_STATE');
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
    // No new claim on a cancelled round, but the recorded one keeps its rights.
    expect(hub.command('room305', 'CLAIM_COMPLETE').code).toBe('INVALID_STATE');
    expect(hub.attempts()).toHaveLength(1);
    expect(hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: pending.id, decision: 'VALID' }).ok).toBe(true);
    const won = hub.snapshot().active_round!;
    expect(won.result).toBe('WON');
    expect(won.official_duration_ms).toBe(pending.elapsed_ms);
    expect(won.aborted_at).not.toBeNull();
    // And the departure is still owed.
    expect(hub.command('gate', 'CONFIRM_EXIT').ok).toBe(true);
    expect(hub.snapshot().active_round!.exit_by_role).toBe('GATE');
  });

  it('a disqualification is only ever undone by a named supervisor decision', () => {
    const hub = new TestHub();
    started(hub, 300_000);
    hub.advance(80 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts().at(-1)!;
    expect(hub.command('supervisor', 'ABORT_ROUND', { reason: 'phạm luật', kind: 'misconduct' }).ok).toBe(true);
    const denied = hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    expect(denied.ok).toBe(false);
    expect(denied.message).toContain('kỷ luật');
    expect(hub.snapshot().active_round!.decertified).toBe(true);
    expect(hub.snapshot().active_round!.official_duration_ms).toBeNull();
    // The claim row and its instant survive for the review to decide on.
    expect(hub.attempts()[0].claimed_at).toBe(claim.claimed_at);
    expect(hub.command('supervisor', 'REVIEW_RESOLVE', { round_id: claim.round_id, decision: 'ACCEPT', reason: 'trọng tài nhầm' }).ok).toBe(true);
    expect(hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' }).ok).toBe(true);
    const after = hub.snapshot().active_round!;
    expect(after.result).toBe('WON');
    expect(after.official_duration_ms).toBe(claim.elapsed_ms);
  });

  it('EARLY_EXIT is the departure, and it is never asked for twice', () => {
    const hub = new TestHub();
    started(hub, 300_000);
    hub.advance(60 * SEC);
    expect(hub.command('gate', 'EARLY_EXIT', { reason: 'khách xin ra' }).ok).toBe(true);
    const round = hub.snapshot().active_round!;
    expect(round.exit_confirmed_at).not.toBeNull();
    expect(round.exit_by_role).toBe('GATE');
    expect(round.abort_kind).toBe('safety');
    expect(round.result).toBe('ABORTED');
    expect(hub.command('gate', 'EARLY_EXIT', { reason: 'nhầm' }).code).toBe('INVALID_STATE');
    // A cancellation after a departure is refused: the round is already accounted for.
    expect(hub.command('supervisor', 'ABORT_ROUND', { reason: 'quên', kind: 'technical' }).code).toBe('INVALID_STATE');
  });

  it('abort, verify and exit race for the same round without double-writing', () => {
    const hub = new TestHub();
    started(hub, 300_000);
    hub.advance(100 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts().at(-1)!;
    const revision = hub.engine.revision;
    // Two presses that arrive as if simultaneously: only one revision may win.
    const first = hub.command('supervisor', 'ABORT_ROUND', { reason: 'sự cố', kind: 'technical' }, revision);
    const second = hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' }, revision);
    expect(first.ok || second.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.code).toBe('STALE_REVISION');
    const round = hub.snapshot().active_round!;
    expect(round.result).toBe('ABORTED');
    expect(hub.attempts()[0].status).toBe('PENDING');
  });

  it('the abort kinds are exactly the three the brief names', () => {
    expect(ABORT_KINDS).toEqual(['technical', 'safety', 'misconduct']);
  });
});

describe('V3.1 §12.6 — the readiness gate over the three physical areas', () => {
  it('names the outstanding areas in Vietnamese and refuses 0/3, 1/3 and 2/3', () => {
    const hub = new TestHub({ hiddenObjectOwner: 'GATE' });
    const round = started(hub, 120_000);
    hub.advance(121 * SEC);
    hub.command('gate', 'CONFIRM_EXIT');
    const id = round.id;
    const outstanding = () => hub.snapshot().reset_tasks
      .filter(t => t.round_id === id && (t.completed_at === null || t.cycle !== round.reset_cycle))
      .map(t => t.task_key);

    let res = hub.command('gate', 'GATE_FINALIZE');
    expect(res.code).toBe('BLOCKED');
    expect(res.message).toContain(RESET_TASK_LABEL.hallway);
    expect(res.message).toContain(RESET_TASK_LABEL.hidden_objects);
    expect(res.message).toContain(RESET_TASK_LABEL.room);
    expect(res.message).not.toContain('hidden_objects');

    res = hub.command('gate', 'RESET_DONE');           // hallway + hidden objects
    expect(res.ok).toBe(true);
    expect(outstanding()).toEqual(['room']);
    res = hub.command('gate', 'GATE_FINALIZE');
    expect(res.code).toBe('BLOCKED');
    expect(res.message).toContain(RESET_TASK_LABEL.room);

    res = hub.command('room305', 'RESET_DONE');
    expect(res.ok).toBe(true);
    expect(outstanding()).toHaveLength(0);
    res = hub.command('gate', 'GATE_FINALIZE');
    expect(res.ok).toBe(true);
    expect(hub.snapshot().rounds.at(-1)!.status).toBe('CLOSED');

    // Reopening the reset revokes readiness and every mark of that cycle.
    const last = hub.snapshot().rounds.at(-1)!;
    res = hub.command('supervisor', 'REOPEN_RESET', { round_id: last.id, reason: 'kiểm tra lại' });
    expect(res.ok).toBe(true);
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED');
    expect(outstanding().length).toBeGreaterThan(0);
  });

  it('a team that has not been confirmed out keeps the floor closed', () => {
    const hub = new TestHub();
    started(hub, 120_000);
    hub.advance(121 * SEC);
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
    expect(hub.command('gate', 'RESET_DONE').code).toBe('INVALID_STATE');
    hub.command('gate', 'CONFIRM_EXIT');
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
    // The area is open for its checks now, but closure still needs all three of them.
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED');
  });
});

describe('V3.1 §12.7 — nothing of the 90-minute session is left in the operating path', () => {
  it('the retired session actions are refused by the permission table itself', () => {
    const hub = new TestHub();
    for (const action of ['OVERTIME_STARTED', 'OVERRIDE_ADMIT', 'EVENT_CLOSED', 'SESSION_RESTORE'] as const) {
      const res = hub.command('supervisor', action, { reason: 'thử' });
      expect(res.ok, action).toBe(false);
      expect(res.code, action).toBe('PERMISSION_DENIED');
    }
  });

  it('no amount of elapsed session time ends, blocks or deletes anything', () => {
    const hub = new TestHub();
    playRound(hub, { durationMs: 120_000 });
    const before = hub.snapshot();
    hub.advance(90 * MIN + 30 * MIN);
    const after = hub.snapshot();
    expect(after.event.event_ended_at).toBeNull();
    expect(after.event.event_started_at).toBe(before.event.event_started_at);
    expect(after.rounds).toHaveLength(before.rounds.length);
    expect(after.attempts).toHaveLength(before.attempts.length);
    expect(after.event.config.event_duration_ms).toBe(before.event.config.event_duration_ms);
    // A new team is still received, because only "one game at a time" gates it.
    expect(hub.command('lobby', 'CALL_TEAM').ok).toBe(true);
    // Closure stays a manual, reasoned and safety-gated act.
    expect(hub.command('supervisor', 'END_EVENT', { reason: 'hết ca' }).code).toBe('BLOCKED');
    expect(after.event.closing_warned_at).toBeNull();
    expect(after.event.end_warned_at).toBeNull();
    expect(after.event.overtime_started_at).toBeNull();
  });

  it('the session length can no longer be configured at all', () => {
    const hub = new TestHub();
    const res = hub.command('supervisor', 'CONFIGURE', { event_duration_ms: 60_000 });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('không còn thời lượng phiên');
  });

  it('the countdown display stops the moment the round is decided, at any duration', () => {
    for (const duration of [120_000, 420_000]) {
      const hub = new TestHub();
      started(hub, duration);
      hub.advance(duration / 2);
      hub.command('room305', 'CLAIM_COMPLETE');
      const claim = hub.attempts().at(-1)!;
      hub.advance(4 * SEC);
      hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
      const view = resolveCountdown(hub.snapshot(), hub.now());
      expect(view.settled).toBe(true);
      expect(view.mode).toBe('RESULT');
      expect(view.heroLabel).toBe('THỜI GIAN HOÀN THÀNH');
      expect(`${view.mm}:${view.ss}`).toBe(
        `${String(Math.floor(claim.elapsed_ms / 60_000)).padStart(2, '0')}:${String(Math.floor((claim.elapsed_ms % 60_000) / 1000)).padStart(2, '0')}`,
      );
    }
  });

  it('a viewer is refused every V3.1 surface, including the new ones', () => {
    const hub = new TestHub();
    const snap = hub.snapshot();
    for (const action of ['CONFIGURE', 'ABORT_ROUND', 'REVIEW_RESOLVE', 'CORRECT_ROUND', 'REOPEN_RESET', 'END_EVENT'] as const) {
      expect(authorize('OBSERVER', action, null, null, snap.active_round).reason, action).toBe('READ_ONLY');
    }
    for (const action of ['CALL_TEAM', 'CONFIRM_FLOOR2', 'FLOOR2_BYPASS', 'START_GAME', 'CLAIM_COMPLETE',
      'VERIFY_ATTEMPT', 'CONFIRM_EXIT', 'EARLY_EXIT', 'RESET_DONE', 'GATE_FINALIZE'] as const) {
      expect(authorize('OBSERVER', action, 'RUNNING', 'IN_PROGRESS').reason, action).toBe('READ_ONLY');
    }
  });

  it('the attempt panel stays open after a non-disqualifying cancellation', () => {
    const hub = new TestHub();
    started(hub, 300_000);
    hub.advance(40 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    hub.command('supervisor', 'ABORT_ROUND', { reason: 'sự cố', kind: 'safety' });
    const rows = resolveAttempts(hub.snapshot(), hub.now());
    expect(rows).toHaveLength(1);
    expect(rows[0].open).toBe(true);
    hub.command('supervisor', 'ABORT_ROUND', { reason: 'again', kind: 'misconduct' }, undefined, 'second-abort');
    expect(resolveAttempts(hub.snapshot(), hub.now())[0].open).toBe(true);
  });
});
