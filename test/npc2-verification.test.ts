import { describe, expect, it } from 'vitest';
import { TestHub, SEC, MIN } from './helpers/harness';
import {
  resolveNpc2Stage,
  resolvePrimary,
  resolveCountdown,
  resolveBigScreen,
  resolveAttempts,
  resolveSyncState,
  flowOf,
  phaseOf,
} from '../src/client/selectors';
import { authorize } from '../src/shared/machine';
import type { CompletionAttempt } from '../src/shared/types';

/**
 * V3.4 — NPC2 verification & round-completion regressions.
 *
 * The bug this file pins: the NPC2 screen kept its big "GHI NHẬN BÁO HOÀN
 * THÀNH" CTA visible after a correct attempt had been finalised, so pressing
 * it could only ever earn a server refusal. The UI now derives its eligibility
 * from the same `authorize` table the engine and the RPC enforce — and the
 * server-side refusal itself must stay exactly as strict as before.
 */

function toFinalRound(hub: TestHub, opts: { claimMs?: number; verifyMs?: number } = {}) {
  const claimMs = opts.claimMs ?? 111 * SEC; // 01:51.00 on the board
  const verifyMs = opts.verifyMs ?? 150;
  hub.command('lobby', 'CALL_TEAM');
  hub.advance(40 * SEC);
  hub.command('corridor', 'CONFIRM_FLOOR2');
  hub.advance(10 * SEC);
  hub.command('gate', 'START_GAME');
  hub.advance(claimMs);
  hub.command('room305', 'CLAIM_COMPLETE');
  const attempt = hub.attempts().at(-1)!;
  hub.advance(verifyMs);
  hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: attempt.id, decision: 'VALID' });
  return attempt;
}

describe('NPC2 claim eligibility mirrors the authoritative table', () => {
  it('1. a running round offers the claim CTA to NPC2 only', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(SEC);
    const snap = hub.snapshot();
    const now = hub.now();
    const stage = resolveNpc2Stage(snap, now);
    expect(stage.canClaim).toBe(true);
    expect(stage.finalized).toBe(false);
    expect(resolvePrimary('ROOM305', snap, now).action).toBe('CLAIM_COMPLETE');
    // Nobody else is offered the press, and the server agrees.
    expect(resolvePrimary('LOBBY', snap, now).action).not.toBe('CLAIM_COMPLETE');
    expect(resolvePrimary('GATE', snap, now).action).not.toBe('CLAIM_COMPLETE');
    expect(authorize('GATE', 'VERIFY_ATTEMPT', flowOf(snap, now), 'IN_PROGRESS', snap.active_round).allowed).toBe(false);
    expect(authorize('OBSERVER', 'CLAIM_COMPLETE', flowOf(snap, now), 'IN_PROGRESS', snap.active_round).allowed).toBe(false);
  });

  it('2. a rejected attempt keeps its own timestamp and history row', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(65 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const first = hub.attempts().at(-1)!;
    const firstElapsed = first.elapsed_ms;
    hub.advance(2 * SEC);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: first.id, decision: 'INVALID' });
    const kept = hub.attempts().find((a: CompletionAttempt) => a.id === first.id)!;
    expect(kept.status).toBe('INVALID');
    expect(kept.claimed_at).toBe(first.claimed_at);
    expect(kept.elapsed_ms).toBe(firstElapsed);
    // The row stays readable for the operator, with the claim's own instant.
    const rows = resolveAttempts(hub.snapshot(), hub.now());
    const row = rows.find((r) => r.seq === 1)!;
    expect(row.status).toBe('INVALID');
    expect(row.elapsedMs).toBe(firstElapsed);
    expect(row.open).toBe(false);
  });

  it('3. after a rejection a later attempt is still permitted while the clock runs', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(60 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE');
    const first = hub.attempts().at(-1)!;
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: first.id, decision: 'INVALID' });
    hub.advance(30 * SEC);
    const stage = resolveNpc2Stage(hub.snapshot(), hub.now());
    expect(stage.canClaim).toBe(true);
    hub.command('room305', 'CLAIM_COMPLETE');
    expect(hub.attempts()).toHaveLength(2);
  });

  it('4. a correct confirmation locks the official result from the claim instant', () => {
    const hub = new TestHub();
    const attempt = toFinalRound(hub);
    const snap = hub.snapshot();
    const now = hub.now();
    const round = snap.active_round!;
    expect(round.result).toBe('WON');
    // Official time is the claim's own elapsed instant — never the decision press.
    expect(round.official_duration_ms).toBe(attempt.elapsed_ms);
    expect(round.validated_attempt_id).toBe(attempt.id);
    const stage = resolveNpc2Stage(snap, now);
    expect(stage.finalized).toBe(true);
    expect(stage.officialMs).toBe(attempt.elapsed_ms);
  });

  it('5. no further completion report is accepted after finalisation — server AND UI', () => {
    const hub = new TestHub();
    toFinalRound(hub);
    const snap = hub.snapshot();
    const now = hub.now();
    const stage = resolveNpc2Stage(snap, now);
    // The UI answer: the CTA is gone, and the read-only caption names why.
    expect(stage.canClaim).toBe(false);
    expect(stage.claimRefusal).toContain('đã chốt kết quả');
    // The server answer stays exactly as strict (never hidden, never relaxed).
    const refused = hub.command('room305', 'CLAIM_COMPLETE');
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.message).toContain('chốt kết quả');
    // A second official result can never be produced, even from a fresh claim.
    const pending = hub.attempts().filter((a: CompletionAttempt) => a.status === 'PENDING');
    expect(pending.length).toBe(0);
    const reVerify = hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: hub.attempts()[0].id, decision: 'INVALID' });
    expect(reVerify.ok).toBe(false);
    expect(hub.snapshot().active_round?.result).toBe('WON');
  });

  it('6. the invalid large CTA disappears once the result is finalised', () => {
    const hub = new TestHub();
    toFinalRound(hub);
    const snap = hub.snapshot();
    const now = hub.now();
    // The phase is WAITING_FOR_EXIT: NPC2's primary surface is the read-only
    // result, and the only actionable press on the floor belongs to NPC1.
    expect(phaseOf(snap, now)).toBe('WAITING_FOR_EXIT');
    expect(resolveNpc2Stage(snap, now).canClaim).toBe(false);
    expect(resolvePrimary('ROOM305', snap, now).action).toBe(null);
    const gate = resolvePrimary('GATE', snap, now);
    expect(gate.action).toBe('CONFIRM_EXIT');
    // §7: the exit is guarded by the existing second-press confirmation.
    expect(gate.confirmLabel).toBeTruthy();
  });

  it('7. NPC1 exit confirmation never moves the official result', () => {
    const hub = new TestHub();
    const attempt = toFinalRound(hub);
    hub.advance(20 * SEC);
    const exit = hub.command('gate', 'CONFIRM_EXIT');
    expect(exit.ok).toBe(true);
    const round = hub.snapshot().active_round!;
    expect(round.status).toBe('EXIT_CONFIRMED');
    expect(round.official_duration_ms).toBe(attempt.elapsed_ms);
    expect(round.exit_by_role).toBe('GATE');
  });

  it('8. countdown, big screen and NPC2 stage agree on the finalized result', () => {
    const hub = new TestHub();
    const attempt = toFinalRound(hub);
    const snap = hub.snapshot();
    const now = hub.now();
    const hero = resolveCountdown(snap, now);
    const wall = resolveBigScreen(snap, now);
    const stage = resolveNpc2Stage(snap, now);
    expect(hero.result).toBe('WON');
    expect(hero.officialMs).toBe(attempt.elapsed_ms);
    expect(stage.officialMs).toBe(attempt.elapsed_ms);
    expect(wall?.officialMs).toBe(attempt.elapsed_ms);
    expect(wall?.result).toBe('WON');
    // The hero carries the official instant itself, not a running countdown.
    expect(`${hero.mm}:${hero.ss}.${hero.cs}`).toBe(
      `${String(Math.floor(attempt.elapsed_ms / 60_000)).padStart(2, '0')}:${String(Math.floor((attempt.elapsed_ms % 60_000) / 1000)).padStart(2, '0')}.${String(Math.floor((attempt.elapsed_ms % 1000) / 10)).padStart(2, '0')}`,
    );
  });

  it('9. a reconnecting device recovers the finalized state, not a pressable CTA', () => {
    const hub = new TestHub();
    toFinalRound(hub);
    // A phone that joins after the result: fresh store, fresh read, same truth.
    const late = hub.client('room305');
    return late.store.start().then(async () => {
      const snap = late.store.getSnapshot().snapshot!;
      const now = late.store.serverNow();
      const stage = resolveNpc2Stage(snap, now);
      expect(stage.finalized).toBe(true);
      expect(stage.canClaim).toBe(false);
      // And the server still refuses the press from that device.
      const refused = await late.store.act('CLAIM_COMPLETE');
      expect(refused?.ok).toBe(false);
      late.store.stop();
    });
  });

  it('10. expired-with-pending-claim keeps decisions open but never re-opens winning', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(4 * MIN + 59 * SEC); // inside the 5:00 by one second
    hub.command('room305', 'CLAIM_COMPLETE');
    const pending = hub.attempts().at(-1)!;
    hub.advance(2 * SEC); // now past the deadline
    const snap = hub.snapshot();
    const now = hub.now();
    expect(phaseOf(snap, now)).toBe('TIME_EXPIRED_PENDING_VALIDATION');
    const stage = resolveNpc2Stage(snap, now);
    // A late record is still accepted as an informational fact…
    expect(stage.canClaim).toBe(true);
    expect(stage.lateOnly).toBe(true);
    // …and the in-time claim can still be judged.
    expect(stage.pendingCount).toBe(1);
    const rows = resolveAttempts(snap, now);
    expect(rows.find((r) => r.seq === 1)?.open).toBe(true);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: pending.id, decision: 'VALID' });
    expect(hub.snapshot().active_round?.result).toBe('WON');
    expect(hub.snapshot().active_round?.official_duration_ms).toBe(pending.elapsed_ms);
  });
});

describe('V3.4 §10 — the five honest synchronisation states', () => {
  it('a transient SYNCING over current data reads as current, never as permanent syncing', () => {
    // This is the exact case that left every phone wearing "ĐANG ĐỒNG BỘ"
    // after the result had already been finalised and acknowledged.
    const s = resolveSyncState('SYNCING', { dataAgeMs: 3_000 });
    expect(s.key).toBe('current');
    expect(s.label).toBe('DỮ LIỆU HIỆN TẠI');
    expect(s.showRetry).toBe(false);
  });

  it('SYNCING with no read ever landed is syncing; with a stale read it is reconnecting', () => {
    expect(resolveSyncState('SYNCING', { dataAgeMs: null }).key).toBe('syncing');
    expect(resolveSyncState('SYNCING', { dataAgeMs: 60_000 }).key).toBe('reconnecting');
  });

  it('only real transport failures are named as failures — never a fake success', () => {
    const off = resolveSyncState('OFFLINE', { dataAgeMs: 1_000 });
    expect(off.key).toBe('failed');
    expect(off.showRetry).toBe(true);
    const degraded = resolveSyncState('DEGRADED', { dataAgeMs: 90_000 });
    expect(degraded.key).toBe('failed');
    const quiet = resolveSyncState('CONNECTED', { dataAgeMs: 90_000 });
    expect(quiet.key).toBe('reconnecting');
    expect(resolveSyncState('CONNECTED', { dataAgeMs: 1_000 }).key).toBe('connected');
  });
});
