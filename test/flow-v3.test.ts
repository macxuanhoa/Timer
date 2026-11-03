import { describe, expect, it } from 'vitest';
import { TestHub, T0, SEC, MIN, playRound } from './helpers/harness';
import { resolveBigScreen, resolveCountdown, resolveEmergency, resolvePrimary, phaseOf, isLockedPhase } from '../src/client/selectors';
import { ROLE_ACTIONS, authorize, flowStatus, liveStatus, resultOf } from '../src/shared/machine';

/**
 * The V3 acceptance matrix, played against the authoritative engine.
 *
 * Every case drives real commands through the same dispatch path a phone uses and
 * then asserts on the persisted facts, so "the UI says X" can never be reported as
 * a passing test unless the server actually recorded X.
 */

function startedHub(opts: { bypass?: boolean } = {}) {
  const hub = new TestHub();
  hub.command('lobby', 'CALL_TEAM', { team_name: 'Phantom 05' });
  hub.advance(40 * SEC);
  if (opts.bypass) hub.command('gate', 'FLOOR2_BYPASS', { reason: 'Đội đã lên thẳng tầng 3' });
  else hub.command('corridor', 'CONFIRM_FLOOR2');
  hub.advance(10 * SEC);
  hub.command('gate', 'START_GAME');
  return hub;
}

describe('phase 01 — OPERATOR_01 receives the team', () => {
  it('only OPERATOR_01 may receive a team, and every other role is refused', () => {
    const hub = new TestHub();
    for (const id of ['gate', 'corridor', 'room305', 'supervisor']) {
      const res = hub.command(id, 'CALL_TEAM');
      expect(res.ok, id).toBe(false);
      expect(res.code, id).toBe('PERMISSION_DENIED');
    }
    // A viewer is refused as a viewer, which is a different answer from “wrong station”.
    expect(hub.command('observer', 'CALL_TEAM').code).toBe('READ_ONLY');
    expect(hub.command('lobby', 'CALL_TEAM').ok).toBe(true);
    expect(phaseOf(hub.snapshot(), hub.now())).toBe('WAITING_FLOOR2_CONFIRMATION');
  });

  it('records the receiving operator and the authoritative timestamp', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM', { team_name: 'Phantom 05' });
    const round = hub.snapshot().active_round!;
    expect(round.called_at).toBe(hub.now());
    expect(round.received_by_role).toBe('LOBBY');
    expect(round.status).toBe('WAITING_FLOOR2_CONFIRMATION');
    // The one-reception rule: a second team cannot be opened while one is in play.
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
  });

  it('offers no countdown and no other control while the team is being received', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    const snap = hub.snapshot();
    expect(snap.active_round!.game_started_at).toBeNull();
    for (const role of ['LOBBY', 'GATE', 'ROOM305', 'SUPERVISOR'] as const) {
      expect(resolvePrimary(role, snap, hub.now()).action).not.toBe('START_GAME');
    }
  });
});

describe('phase 02 — OPERATOR_02 confirms floor 2', () => {
  it('only OPERATOR_02 confirms arrival, and it does not start the clock', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    expect(hub.command('gate', 'CONFIRM_FLOOR2').code).toBe('PERMISSION_DENIED');
    expect(hub.command('room305', 'CONFIRM_FLOOR2').code).toBe('PERMISSION_DENIED');
    const nowBefore = hub.now();
    expect(hub.command('corridor', 'CONFIRM_FLOOR2').ok).toBe(true);
    const round = hub.snapshot().active_round!;
    expect(round.floor2_confirmed_at).toBe(nowBefore);
    expect(round.game_started_at).toBeNull();
    expect(phaseOf(hub.snapshot(), hub.now())).toBe('READY_AT_FLOOR3');
  });

  it('keeps the confirmation audit separate from a bypass', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    const confirmed = hub.snapshot().active_round!;
    expect(confirmed.floor2_confirmed_at).not.toBeNull();
    expect(confirmed.floor2_bypassed_at).toBeNull();

    const other = new TestHub();
    other.command('lobby', 'CALL_TEAM');
    other.command('gate', 'FLOOR2_BYPASS', { reason: 'Đội đã ở tầng 3, tầng 2 không thấy' });
    const bypassed = other.snapshot().active_round!;
    // The integrity rule: a bypass is never written as a floor-2 confirmation.
    expect(bypassed.floor2_confirmed_at).toBeNull();
    expect(bypassed.floor2_bypassed_at).not.toBeNull();
    expect(bypassed.floor2_bypassed_by_role).toBe('GATE');
    expect(bypassed.floor2_bypass_reason).toContain('tầng 3');
  });

  it('refuses a stale confirmation after the bypass without reverting', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('gate', 'FLOOR2_BYPASS', { reason: 'Đội đã ở tầng 3' });
    const res = hub.command('corridor', 'CONFIRM_FLOOR2');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_STATE');
    const round = hub.snapshot().active_round!;
    expect(round.floor2_confirmed_at).toBeNull();
    expect(round.status).toBe('READY_AT_FLOOR3');
  });

  it('requires a reason for the exception and refuses it without one', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    expect(hub.command('gate', 'FLOOR2_BYPASS', {}).code).toBe('BLOCKED');
    expect(hub.snapshot().active_round!.status).toBe('WAITING_FLOOR2_CONFIRMATION');
  });

  it('never lets the bypass skip the team reception itself', () => {
    const hub = new TestHub();
    // No team received yet: there is nothing to bypass onto floor 3.
    expect(hub.command('gate', 'FLOOR2_BYPASS', { reason: 'không có đội' }).code).toBe('INVALID_STATE');
  });
});

describe('phase 03-04 — pre-start and the authoritative start', () => {
  it('only NPC1 may start, and every other role is refused by the server', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    for (const id of ['lobby', 'corridor', 'room305', 'supervisor', 'observer']) {
      expect(hub.command(id, 'START_GAME').ok, id).toBe(false);
    }
    expect(hub.command('gate', 'START_GAME').ok).toBe(true);
  });

  it('cannot start before the floor handover is settled', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    expect(hub.command('gate', 'START_GAME').code).toBe('INVALID_STATE');
    expect(hub.snapshot().active_round!.game_started_at).toBeNull();
  });

  it('stores the deadline once, so no client can move it', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.advance(3 * MIN);
    hub.command('gate', 'START_GAME');
    const round = hub.snapshot().active_round!;
    expect(round.game_started_at).toBe(hub.now());
    expect(round.deadline_at).toBe(round.game_started_at! + 300 * SEC);
    expect(round.started_by_role).toBe('GATE');
    // A second START cannot create a second clock: the phase no longer allows it.
    expect(hub.command('gate', 'START_GAME').code).toBe('INVALID_STATE');
    expect(hub.snapshot().active_round!.deadline_at).toBe(round.deadline_at!);
  });

  it('locks every device into the same countdown', () => {
    const hub = startedHub();
    hub.advance(90 * SEC);
    const snap = hub.snapshot();
    const view = resolveCountdown(snap, hub.now());
    expect(phaseOf(snap, hub.now())).toBe('RUNNING');
    expect(isLockedPhase(phaseOf(snap, hub.now()))).toBe(true);
    expect(view.remainingMs).toBe(210 * SEC);
    expect(`${view.mm}:${view.ss}`).toBe('03:30');
    expect(resolveBigScreen(snap, hub.now())!.remainingMs).toBe(210 * SEC);
  });

  it('freezes the display at zero instead of counting negative', () => {
    const hub = startedHub();
    hub.advance(300 * SEC + 14 * SEC);
    const view = resolveCountdown(hub.snapshot(), hub.now());
    expect(view.expired).toBe(true);
    expect(view.remainingMs).toBeLessThanOrEqual(0);
    expect(`${view.mm}:${view.ss}`).toBe('00:00');
  });

  it('stops the countdown display the moment the round is decided', () => {
    const hub = startedHub();
    hub.advance(150 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts()[0];
    hub.advance(4 * SEC);
    expect(hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' }).ok).toBe(true);
    const view = resolveCountdown(hub.snapshot(), hub.now());
    // §10 step B item 5: the gameplay countdown stops being live information, and the
    // hero carries the official time — the claim's own instant, not the instant NPC2
    // finished checking, which stays in the audit only.
    expect(view.settled).toBe(true);
    expect(view.mode).toBe('RESULT');
    expect(view.heroLabel).toBe('THỜI GIAN HOÀN THÀNH');
    expect(`${view.mm}:${view.ss}:${view.cs}`).toBe('02:30:00');
    expect(view.officialMs).toBe(150 * SEC);
    // The stored clock is still the truth about the window, frozen or not.
    expect(view.remainingMs).toBe(146 * SEC);

    // An aborted round freezes at whatever the clock had left and invents no time.
    const other = startedHub();
    other.advance(120 * SEC);
    expect(other.command('gate', 'EARLY_EXIT', { reason: 'Khách cần y tế' }).ok).toBe(true);
    const aborted = resolveCountdown(other.snapshot(), other.now());
    expect(aborted.settled).toBe(true);
    expect(aborted.mode).toBe('RESULT');
    expect(aborted.heroLabel).toBe('LƯỢT CHƠI ĐÃ HỦY');
    expect(`${aborted.mm}:${aborted.ss}`).toBe('03:00');
    expect(aborted.officialMs).toBeNull();
  });

  it('rejects the retired clock manipulation and the duplicated station presses', () => {
    const hub = startedHub();
    for (const action of ['GAME_PAUSE', 'GAME_RESUME', 'GAME_RESET', 'TEAM_UPSTAIRS', 'HALLWAY_PROGRESS', 'ROOM_REACHED', 'PUZZLE_COMPLETE', 'RETURN_START', 'GAME_STOP'] as const) {
      for (const id of ['lobby', 'corridor', 'gate', 'room305', 'supervisor']) {
        const res = hub.command(id, action);
        expect(res.ok, `${action} by ${id}`).toBe(false);
        expect(res.code, `${action} by ${id}`).toBe('PERMISSION_DENIED');
      }
      expect(ROLE_ACTIONS[action]).toEqual([]);
    }
    // The deadline is untouched by every refused attempt above.
    expect(resultOf(hub.snapshot().active_round!, [], 300 * SEC, hub.now())).toBe('IN_PROGRESS');
  });

  it('offers no control to the roles that are read-only during the game', () => {
    const hub = startedHub();
    const snap = hub.snapshot();
    for (const role of ['LOBBY', 'CORRIDOR', 'SUPERVISOR', 'OBSERVER'] as const) {
      expect(resolvePrimary(role, snap, hub.now()).action).toBeNull();
      expect(resolveEmergency(role, snap, hub.now())).toBeNull();
    }
    expect(resolvePrimary('ROOM305', snap, hub.now()).action).toBe('CLAIM_COMPLETE');
    // NPC1 keeps only the guarded safety path, and it is not the primary control.
    expect(resolvePrimary('GATE', snap, hub.now()).action).toBeNull();
    expect(resolveEmergency('GATE', snap, hub.now())!.action).toBe('EARLY_EXIT');
  });
});

describe('phase 05 — NPC2 claims and verification', () => {
  it('records a claim with its own server timestamp and keeps the clock running', () => {
    const hub = startedHub();
    hub.advance(100 * SEC);
    expect(hub.command('gate', 'CLAIM_COMPLETE').code).toBe('PERMISSION_DENIED');
    const res = hub.command('room305', 'CLAIM_COMPLETE');
    expect(res.ok).toBe(true);
    const attempt = hub.attempts()[0];
    expect(attempt.claimed_at).toBe(hub.now());
    expect(attempt.elapsed_ms).toBe(100 * SEC);
    expect(attempt.remaining_ms).toBe(200 * SEC);
    expect(attempt.status).toBe('PENDING');
    expect(attempt.in_time).toBe(true);
    // The countdown is untouched by the announcement.
    expect(phaseOf(hub.snapshot(), hub.now())).toBe('RUNNING');
    expect(resolveCountdown(hub.snapshot(), hub.now()).remainingMs).toBe(200 * SEC);
  });

  it('keeps every rejected attempt and still allows a new claim', () => {
    const hub = startedHub();
    hub.advance(60 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const first = hub.attempts()[0];
    hub.advance(5 * SEC);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: first.id, decision: 'INVALID' });
    expect(hub.attempts()[0].status).toBe('INVALID');
    // The rejected claim keeps the timestamp it was recorded with.
    expect(hub.attempts()[0].claimed_at).toBe(first.claimed_at);
    hub.advance(30 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    expect(hub.attempts().length).toBe(2);
    expect(hub.attempts()[1].seq).toBe(2);
    expect(hub.attempts()[1].elapsed_ms).toBe(95 * SEC);
  });

  it('scores the validated claim, not the verification instant', () => {
    const hub = startedHub();
    hub.advance(120 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts()[0];
    hub.advance(35 * SEC); // NPC2 takes its time checking the arrangement
    const res = hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    expect(res.ok).toBe(true);
    const round = hub.snapshot().active_round!;
    expect(round.official_duration_ms).toBe(120 * SEC);
    expect(round.validated_attempt_id).toBe(claim.id);
    expect(round.result).toBe('WON');
    // The verification delay is audited separately and never becomes the score.
    const entry = hub.engine.fullLog().find((l) => l.action === 'VERIFY_ATTEMPT')!;
    expect(entry.metadata?.verification_delay_ms).toBe(35 * SEC);
  });

  it('uses the correct attempt when several were recorded (04:12 of three)', () => {
    const hub = startedHub();
    // Attempt 1 at 02:10 — incorrect.
    hub.advance(130 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const one = hub.attempts()[0];
    hub.advance(4 * SEC);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: one.id, decision: 'INVALID' });
    // Attempt 2 at 03:25 — incorrect.
    hub.advance(71 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const two = hub.attempts()[1];
    expect(two.elapsed_ms).toBe(205 * SEC);
    hub.advance(4 * SEC);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: two.id, decision: 'INVALID' });
    // Attempt 3 at 04:12 — correct, and NPC2 only finishes checking at 04:30.
    hub.advance(43 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const three = hub.attempts()[2];
    expect(three.elapsed_ms).toBe(252 * SEC);
    hub.advance(18 * SEC);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: three.id, decision: 'VALID' });
    const round = hub.snapshot().active_round!;
    // 04:12, never 04:30.
    expect(round.official_duration_ms).toBe(252 * SEC);
    expect(round.validated_attempt_id).toBe(three.id);
    // All three attempts survive, each with its own recorded timestamp.
    expect(hub.attempts().map((a) => a.status)).toEqual(['INVALID', 'INVALID', 'VALID']);
    expect(new Set(hub.attempts().map((a) => a.claimed_at)).size).toBe(3);
  });

  it('refuses a decision on an attempt that is already closed', () => {
    const hub = startedHub();
    hub.advance(50 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const attempt = hub.attempts()[0];
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: attempt.id, decision: 'INVALID' });
    const again = hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: attempt.id, decision: 'VALID' });
    expect(again.ok).toBe(true); // idempotent answer
    expect(hub.snapshot().active_round!.result).not.toBe('WON');
    expect(hub.attempts()[0].status).toBe('INVALID');
  });

  it('cannot verify an unknown attempt id, so a stale panel cannot decide history', () => {
    const hub = startedHub();
    hub.advance(50 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const res = hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: 'att_other_round_1', decision: 'VALID' });
    expect(res.code).toBe('INVALID_STATE');
  });
});

describe('phase 06 — expiry and the race with verification', () => {
  it('a claim recorded before the deadline stays valid when it is checked after', () => {
    const hub = startedHub();
    hub.advance(298 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts()[0];
    expect(claim.in_time).toBe(true);
    hub.advance(10 * SEC); // the clock runs out while NPC2 is checking
    expect(phaseOf(hub.snapshot(), hub.now())).toBe('TIME_EXPIRED_PENDING_VALIDATION');
    expect(resultOf(hub.snapshot().active_round!, hub.snapshot().attempts, 300 * SEC, hub.now())).toBe('PENDING_VALIDATION');
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    const round = hub.snapshot().active_round!;
    expect(round.result).toBe('WON');
    expect(round.official_duration_ms).toBe(298 * SEC);
  });

  it('a claim recorded at or after the deadline can never produce a win', () => {
    const hub = startedHub();
    hub.advance(304 * SEC);
    expect(phaseOf(hub.snapshot(), hub.now())).toBe('WAITING_FOR_EXIT');
    hub.command('room305', 'CLAIM_COMPLETE');
    const late = hub.attempts()[0];
    expect(late).toBeTruthy();
    expect(late.in_time).toBe(false);
    expect(late.status).toBe('LATE');
    const res = hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: late.id, decision: 'VALID' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_STATE');
    expect(hub.snapshot().active_round!.official_duration_ms).toBeNull();
    expect(resultOf(hub.snapshot().active_round!, hub.snapshot().attempts, 300 * SEC, hub.now())).toBe('TIME_UP');
  });

  it('expiry without any valid claim is TIME UP, with no timer task involved', () => {
    const hub = startedHub();
    hub.advance(200 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts()[0];
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'INVALID' });
    hub.advance(150 * SEC);
    const snap = hub.snapshot();
    expect(phaseOf(snap, hub.now())).toBe('WAITING_FOR_EXIT');
    expect(resultOf(snap.active_round!, snap.attempts, 300 * SEC, hub.now())).toBe('TIME_UP');
    // Nothing was ever written by the passing of time itself.
    expect(snap.log.some((l) => l.action === 'CONFIRM_EXIT')).toBe(false);
  });

  it('a late claim does not hold the round in the pending state', () => {
    const hub = startedHub();
    hub.advance(305 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    expect(phaseOf(hub.snapshot(), hub.now())).toBe('WAITING_FOR_EXIT');
    expect(resultOf(hub.snapshot().active_round!, hub.snapshot().attempts, 300 * SEC, hub.now())).toBe('TIME_UP');
  });

  it('resolves several claims around the deadline independently', () => {
    const hub = startedHub();
    hub.advance(291 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const a = hub.attempts()[0];
    hub.advance(8 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const b = hub.attempts()[1];
    hub.advance(1 * SEC); // exactly at 300 s
    hub.command('room305', 'CLAIM_COMPLETE');
    const c = hub.attempts()[2];
    // claimed_at < deadline_at is the boundary: 299 s is in time, 300 s is not.
    expect([a.in_time, b.in_time, c.in_time]).toEqual([true, true, false]);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: a.id, decision: 'INVALID' });
    hub.advance(12 * SEC);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: b.id, decision: 'VALID' });
    const round = hub.snapshot().active_round!;
    expect(round.official_duration_ms).toBe(299 * SEC);
    // The late claim stays as an informational record and cannot be validated.
    expect(hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: c.id, decision: 'VALID' }).ok).toBe(false);
    expect(hub.attempts()[2].status).toBe('LATE');
  });

  it('a double tap records one claim, because the revision check is the guard', () => {
    const hub = startedHub();
    hub.advance(80 * SEC);
    const snap = hub.snapshot();
    const key = 'same-tap';
    const first = hub.command('room305', 'CLAIM_COMPLETE', {}, snap.revision, key);
    // The accidental repeat carries the same key (retry) or a stale revision (tap).
    expect(hub.command('room305', 'CLAIM_COMPLETE', {}, snap.revision, 'other-key').code).toBe('STALE_REVISION');
    expect(hub.command('room305', 'CLAIM_COMPLETE', {}, first.revision, key).ok).toBe(true);
    expect(hub.attempts().length).toBe(1);
  });
});

describe('phase 07 — the physical exit is not the score', () => {
  it('exit after SUCCESS keeps the official time untouched', () => {
    const hub = startedHub();
    hub.advance(150 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts()[0];
    hub.advance(20 * SEC);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    hub.advance(40 * SEC);
    expect(hub.command('room305', 'CONFIRM_EXIT').code).toBe('PERMISSION_DENIED');
    expect(hub.command('gate', 'CONFIRM_EXIT').ok).toBe(true);
    const round = hub.snapshot().active_round!;
    expect(round.official_duration_ms).toBe(150 * SEC);
    expect(round.exit_confirmed_at).toBe(hub.now());
    expect(round.exit_by_role).toBe('GATE');
    expect(round.status).toBe('EXIT_CONFIRMED');
    expect(round.result).toBe('WON');
  });

  it('exit after TIME UP records the departure and leaves the result', () => {
    const hub = startedHub();
    hub.advance(320 * SEC);
    hub.command('gate', 'CONFIRM_EXIT');
    const round = hub.snapshot().active_round!;
    expect(round.result).toBe('TIME_UP');
    expect(round.official_duration_ms).toBeNull();
    expect(round.exit_confirmed_at).not.toBeNull();
  });

  it('lets the team leave while the review is still open, then resolves it', () => {
    const hub = startedHub();
    hub.advance(299 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts()[0];
    hub.advance(20 * SEC);
    // The team walks out before NPC2 finishes checking.
    hub.command('gate', 'CONFIRM_EXIT');
    expect(hub.snapshot().active_round!.status).toBe('EXIT_CONFIRMED');
    expect(resultOf(hub.snapshot().active_round!, hub.snapshot().attempts, 300 * SEC, hub.now())).toBe('PENDING_VALIDATION');
    // NPC2 can still settle the in-time attempt.
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    expect(hub.snapshot().active_round!.official_duration_ms).toBe(299 * SEC);
    // …but the closure now respects the finalised result.
    expect(hub.snapshot().active_round!.status).toBe('EXIT_CONFIRMED');
  });

  it('early departure needs a reason and can never fake a success', () => {
    const hub = startedHub();
    hub.advance(120 * SEC);
    expect(hub.command('gate', 'EARLY_EXIT', {}).code).toBe('BLOCKED');
    expect(hub.command('room305', 'EARLY_EXIT', { reason: 'khách say' }).code).toBe('PERMISSION_DENIED');
    expect(hub.command('gate', 'EARLY_EXIT', { reason: 'Khách cần y tế' }).ok).toBe(true);
    const round = hub.snapshot().active_round!;
    expect(round.result).toBe('ABORTED');
    expect(round.aborted_at).not.toBeNull();
    expect(round.official_duration_ms).toBeNull();
    expect(round.exit_reason).toBe('Khách cần y tế');
    // V3.1 §4.3: an early exit at the gate is a safety cancellation, so a claim that
    // was already recorded before the deadline keeps its right to be judged. A new
    // claim is not accepted on a cancelled round.
    expect(authorize('ROOM305', 'VERIFY_ATTEMPT', flowStatus(round), 'ABORTED', round).allowed).toBe(true);
    expect(authorize('ROOM305', 'CLAIM_COMPLETE', flowStatus(round), 'ABORTED', round).allowed).toBe(false);
    // And the departure is never asked for twice.
    expect(hub.command('gate', 'EARLY_EXIT', { reason: 'nhầm' }).code).toBe('INVALID_STATE');
  });

  it('an early exit cannot erase an already validated win', () => {
    const hub = startedHub();
    hub.advance(100 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts()[0];
    hub.advance(5 * SEC);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    expect(hub.command('gate', 'EARLY_EXIT', { reason: 'bấm nhầm' }).code).toBe('INVALID_STATE');
    expect(hub.snapshot().active_round!.official_duration_ms).toBe(100 * SEC);
  });
});

describe('phase 08 — closure and the next team', () => {
  it('will not close while the result is still open', () => {
    const hub = startedHub();
    hub.advance(299 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    hub.advance(10 * SEC);
    hub.command('gate', 'CONFIRM_EXIT');
    hub.command('gate', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    const res = hub.command('gate', 'GATE_FINALIZE');
    expect(res.code).toBe('BLOCKED');
    expect(hub.snapshot().active_round!.status).toBe('EXIT_CONFIRMED');
  });

  it('will not close before the physical checks are confirmed', () => {
    const hub = startedHub();
    hub.advance(150 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts()[0];
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    hub.command('gate', 'CONFIRM_EXIT');
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED');
  });

  it('a closed round cannot be acted on any more', () => {
    const hub = new TestHub();
    playRound(hub);
    const closed = hub.snapshot().rounds.at(-1)!;
    expect(closed.status).toBe('CLOSED');
    expect(flowStatus(closed)).toBe('CLOSED');
    expect(hub.snapshot().active_round).toBeNull();
    expect(hub.command('lobby', 'CALL_TEAM').ok).toBe(true);
    expect(hub.command('gate', 'CONFIRM_EXIT').code).toBe('INVALID_STATE');
  });

  it('the next team inherits no countdown, no claims and no timestamps', () => {
    const hub = new TestHub();
    playRound(hub);
    const previous = hub.snapshot().rounds[0];
    hub.command('lobby', 'CALL_TEAM', { team_name: 'Next' });
    const fresh = hub.snapshot().active_round!;
    expect(fresh.id).not.toBe(previous.id);
    expect(fresh.game_started_at).toBeNull();
    expect(fresh.deadline_at).toBeNull();
    expect(fresh.official_duration_ms).toBeNull();
    expect(fresh.result).toBe('IN_PROGRESS');
    expect(fresh.team_number).toBe(previous.team_number + 1);
    expect(hub.attempts(fresh.id)).toEqual([]);
    // History stays immutable: the earlier claim is still there.
    expect(hub.attempts(previous.id).length).toBe(1);
    expect(hub.snapshot().rounds.length).toBe(2);
  });
});

describe('observer — read-only by construction', () => {
  it('refuses every command, whatever the action', () => {
    const hub = startedHub();
    for (const action of Object.keys(ROLE_ACTIONS) as (keyof typeof ROLE_ACTIONS)[]) {
      const res = hub.command('observer', action);
      expect(res.ok, action).toBe(false);
      // A viewer is refused as a viewer, never as a misconfigured operator.
      expect(res.code === 'READ_ONLY' || res.code === 'PERMISSION_DENIED', `${action}:${res.code}`).toBe(true);
    }
  });

  it('has no permission entry in the authoritative matrix at all', () => {
    const granted = Object.values(ROLE_ACTIONS).filter((roles) => roles.includes('OBSERVER'));
    expect(granted).toEqual([]);
  });

  it('the derived phase is identical for a viewer and an operator', () => {
    const hub = startedHub();
    hub.advance(120 * SEC);
    const snap = hub.snapshot();
    expect(liveStatus(snap.active_round!, snap.attempts, 300 * SEC, hub.now())).toBe('RUNNING');
    expect(resolveCountdown(snap, hub.now()).remainingMs).toBe(180 * SEC);
  });
});

describe('recovery and idempotency', () => {
  it('a refresh mid-countdown re-reads the same authoritative timer', () => {
    const hub = startedHub();
    hub.advance(75 * SEC);
    const first = hub.snapshot();
    const again = hub.snapshot();
    expect(again.active_round!.deadline_at).toBe(first.active_round!.deadline_at);
    expect(resolveCountdown(again, hub.now()).remainingMs).toBe(225 * SEC);
    // Re-reading never writes: the revision is unchanged by a snapshot.
    expect(again.revision).toBe(first.revision);
  });

  it('a stale device write is rejected and resynchronised, not applied', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM', {}, 0);
    const stale = hub.command('corridor', 'CONFIRM_FLOOR2', {}, 0);
    expect(stale.code).toBe('STALE_REVISION');
    expect(hub.snapshot().active_round!.status).toBe('WAITING_FLOOR2_CONFIRMATION');
    expect(stale.revision).toBe(hub.snapshot().revision);
  });

  it('replaying a committed press returns the original result without a second record', () => {
    const hub = new TestHub();
    const res = hub.command('lobby', 'CALL_TEAM', { team_name: 'A' }, undefined, 'retry-key');
    expect(res.ok).toBe(true);
    const revision = res.revision;
    const replay = hub.command('lobby', 'CALL_TEAM', { team_name: 'A' }, undefined, 'retry-key');
    expect(replay.ok).toBe(true);
    expect(replay.revision).toBe(revision);
    expect(hub.snapshot().rounds.length).toBe(1);
  });
});
