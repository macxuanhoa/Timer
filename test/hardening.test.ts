import { describe, expect, it } from 'vitest';
import { MIN, SEC, TestHub, entries, latest, playRound } from './helpers/harness';
import { leaderboard, roundMetrics } from '../src/shared/metrics';
import { evaluateDispatch, flowStatus, resultOf } from '../src/shared/machine';
import { resolveAlerts, resolveCountdown } from '../src/client/selectors';
import type { CommandRequest } from '../src/shared/types';

/** A press that reached the server late, as a real phone on bad Wi-Fi would send. */
const latePress = (hub: TestHub, ms: number): CommandRequest['press'] => ({
  press_ms: hub.now() - ms,
  local_press_ms: Date.now() - ms,
  rtt_ms: ms,
});

async function settle(times = 8) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Reception → floor 2 → START, the three presses that put a clock on the floor. */
function onTheClock(hub: TestHub, press?: (id: string, action: CommandRequest['action'], meta?: Record<string, unknown>, key?: string, p?: CommandRequest['press']) => unknown) {
  const cmd = press ?? ((id, action, meta, key, p) => hub.command(id, action, meta ?? {}, undefined, key ?? `k-${action}`, p));
  cmd('lobby', 'CALL_TEAM');
  cmd('corridor', 'CONFIRM_FLOOR2');
  cmd('gate', 'START_GAME');
}

describe('hardening — disputes, recovery and concurrency', () => {
  it('H1. a slow press is recorded, disputed and withheld from the ranking', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME', {}, undefined, 'start-key', latePress(hub, 1800));
    const started = hub.snapshot().active_round!;
    expect(started.start_transport_ms).toBeGreaterThanOrEqual(1800);
    expect(started.needs_review).toBe(true);
    expect(started.review_reasons).toContain('START_TRANSPORT');
    // the official start instant is still the server value, never the press time
    expect(started.game_started_at).toBe(hub.now());
    expect(started.start_press_ms).toBeLessThan(started.game_started_at!);

    hub.advance(100 * SEC);
    hub.command('room305', 'CLAIM_COMPLETE', {}, undefined, 'claim-key', latePress(hub, 1500));
    const claim = hub.attempts()[0];
    expect(claim.claim_transport_ms).toBeGreaterThanOrEqual(1500);
    expect(claim.claimed_at).toBe(hub.now());
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    const round = hub.snapshot().rounds.at(-1)!;
    expect(round.review_reasons).toContain('CLAIM_TRANSPORT');
    expect(round.official_duration_ms).toBe(100 * SEC); // the measurement is preserved …
    hub.command('gate', 'CONFIRM_EXIT');
    expect(leaderboard(hub.snapshot())).toHaveLength(0); // … but no prize from disputed data

    // a disputed finish is visible on the operator screen, not buried in the sheet
    expect(resolveAlerts(hub.snapshot(), hub.now(), false).map((a) => a.id)).toContain('REVIEW');

    // the supervisor has to decide explicitly
    expect(hub.command('gate', 'REVIEW_RESOLVE', { round_id: round.id, decision: 'ACCEPT', reason: 'x' }).code).toBe(
      'PERMISSION_DENIED',
    );
    expect(hub.command('supervisor', 'REVIEW_RESOLVE', { round_id: round.id, decision: 'ACCEPT' }).code).toBe('BLOCKED');
    hub.command('gate', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    hub.command('gate', 'GATE_FINALIZE');
    const resolved = hub.command('supervisor', 'REVIEW_RESOLVE', {
      round_id: round.id,
      decision: 'ACCEPT',
      reason: 'Da xem lai nhat ky',
    });
    expect(resolved.ok).toBe(true);
    expect(leaderboard(hub.snapshot()).map((r) => r.team_number)).toEqual([1]);
    expect(latest(hub, 'REVIEW_RESOLVE')!.metadata).toMatchObject({ decision: 'ACCEPT', reason: 'Da xem lai nhat ky' });
  });

  it('H2. a finish within the review window of 5:00 is disputed, not auto-decided', () => {
    const hub = new TestHub();
    onTheClock(hub);
    hub.advance(300 * SEC - 200); // 200 ms short of the limit
    hub.command('room305', 'CLAIM_COMPLETE');
    const claim = hub.attempts()[0];
    expect(claim.in_time).toBe(true);
    hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: claim.id, decision: 'VALID' });
    const round = hub.snapshot().rounds.at(-1)!;
    expect(round.official_duration_ms).toBe(299_800);
    expect(round.review_reasons).toContain('CLOSE_FINISH');
    expect(leaderboard(hub.snapshot())).toHaveLength(0);

    // and a full 200 ms inside the window is an ordinary, rankable result
    const hub2 = new TestHub();
    playRound(hub2, { claimMs: 299_400 });
    const clean = hub2.snapshot().rounds.at(-1)!;
    expect(clean.review_reasons).toEqual([]);
    expect(leaderboard(hub2.snapshot())).toHaveLength(1);
  });

  it('H3. reopening a reset revokes readiness and forces every confirmation again', () => {
    const hub = new TestHub();
    onTheClock(hub);
    hub.advance(301 * SEC);
    hub.command('gate', 'CONFIRM_EXIT');
    hub.command('gate', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    expect(hub.command('room305', 'REOPEN_RESET', { reason: 'nham' }).code).toBe('PERMISSION_DENIED');
    expect(hub.command('supervisor', 'REOPEN_RESET', { reason: 'nham' }).code).toBe('INVALID_STATE'); // no round_id
    const roundId = hub.snapshot().active_round!.id;
    expect(hub.snapshot().reset_tasks.filter((t) => t.completed_at !== null)).toHaveLength(3);
    expect(hub.command('supervisor', 'REOPEN_RESET', { round_id: roundId, task_key: 'room', reason: 'Manocung chua dat lai' }).ok).toBe(true);

    const after = hub.snapshot();
    expect(after.reset_tasks.every((t) => t.completed_at === null)).toBe(true);
    expect(after.active_round!.reset_cycle).toBe(2);
    expect(after.active_round!.system_ready_at).toBeNull();
    expect(flowStatus(after.active_round!)).toBe('EXIT_CONFIRMED');
    // dispatch is refused again — the old DONE marks cannot authorise a team
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED');

    // re-confirm the new cycle only
    hub.command('gate', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    const tasks = hub.snapshot().reset_tasks;
    expect(tasks.filter((t) => t.completed_at !== null).map((t) => t.cycle)).toEqual([2, 2, 2]);
    expect(hub.command('gate', 'GATE_FINALIZE').ok).toBe(true);
    expect(hub.command('lobby', 'CALL_TEAM').ok).toBe(true);
    const audit = latest(hub, 'REOPEN_RESET')!;
    expect(audit.metadata).toMatchObject({ reason: 'Manocung chua dat lai', task: 'room', cycle: 2 });
    // the invalidated timestamps stay in history, never rewritten
    expect(hub.snapshot().reset_tasks.filter((t) => t.reopen_count === 1)).toHaveLength(3);
  });

  it('H4. a reset confirmation from a previous round can never be reused (G07)', () => {
    const hub = new TestHub();
    playRound(hub); // round 1 fully closed
    const first = hub.snapshot().rounds[0];
    expect(first.system_ready_at).not.toBeNull();
    hub.command('lobby', 'CALL_TEAM'); // round 2
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(301 * SEC);
    hub.command('gate', 'CONFIRM_EXIT');
    const second = hub.snapshot().rounds[1];
    expect(second.id).not.toBe(first.id);
    // round 2 has its own untouched task rows
    expect(hub.snapshot().reset_tasks.filter((t) => t.round_id === second.id && t.completed_at === null)).toHaveLength(3);
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED');
    const metrics = roundMetrics(second, hub.snapshot().reset_tasks);
    expect(metrics.room_reset_ms).toBeNull(); // not inherited from round 1
    // The claims of round 1 cannot be re-decided as if they belonged to round 2.
    const firstClaim = hub.snapshot().attempts.find((a) => a.round_id === first.id)!;
    expect(hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: firstClaim.id, decision: 'INVALID' }).code).toBe('INVALID_STATE');
  });

  it('H5. the hiding layout belongs to one floor-3 operator and is recorded per team', () => {
    const hub = new TestHub();
    // CORRIDOR is the second-floor position now: it no longer prepares props.
    expect(hub.command('corridor', 'SET_LAYOUT', { layout: 'B' }).code).toBe('PERMISSION_DENIED');
    expect(hub.command('lobby', 'SET_LAYOUT', { layout: 'B' }).code).toBe('PERMISSION_DENIED');
    expect(hub.command('room305', 'SET_LAYOUT', { layout: 'Z' }).code).toBe('INVALID_STATE');
    expect(hub.command('room305', 'SET_LAYOUT', { layout: 'B' }).ok).toBe(true);
    hub.command('lobby', 'CALL_TEAM');
    expect(hub.snapshot().active_round!.hiding_layout).toBe('B');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    // The layout cannot be swapped while a team is on the clock.
    expect(hub.command('room305', 'SET_LAYOUT', { layout: 'C' }).code).toBe('INVALID_STATE');
    hub.advance(301 * SEC);
    hub.command('gate', 'CONFIRM_EXIT');
    hub.command('room305', 'RESET_DONE');
    const stamped = hub.snapshot().reset_tasks.find((t) => t.task_key === 'hidden_objects')!;
    expect(stamped.layout).toBe('B');
    hub.command('gate', 'RESET_DONE');
    hub.command('gate', 'GATE_FINALIZE');
    expect(hub.command('room305', 'SET_LAYOUT', { layout: 'C' }).ok).toBe(true);
    expect(hub.snapshot().event.config.hiding_layout).toBe('C');
    expect(entries(hub).some((l) => l.action === 'SET_LAYOUT' && l.metadata?.to === 'C')).toBe(true);
  });

  it('H6. committed action + lost response reconciles without duplication (G02)', async () => {
    const hub = new TestHub();
    const sup = hub.client('supervisor');
    await sup.store.start();
    await settle();

    // (a) the reply is lost but the automatic retry lands: idempotency prevents a
    // second team.
    const lobby = hub.client('lobby');
    await lobby.store.start();
    const retried = await lobby.store.act('CALL_TEAM', {}, { dropResponseOnce: true });
    expect(retried?.ok).toBe(true);
    expect(hub.snapshot().rounds).toHaveLength(1);

    // (b) every reply is lost: the store must ask the server what happened instead
    // of inventing success or failure.
    const lobby2 = hub.client('lobby');
    await lobby2.store.start();
    const corridor2 = hub.client('corridor');
    await corridor2.store.start();
    await corridor2.store.act('CONFIRM_FLOOR2');
    const gate = hub.client('gate');
    await gate.store.start();
    await gate.store.act('START_GAME');
    hub.advance(60 * SEC);
    await gate.store.act('EARLY_EXIT', { reason: 'Don san' });
    // close the round properly, otherwise a new dispatch is legitimately refused
    const room305 = hub.client('room305');
    await room305.store.start();
    await gate.store.act('RESET_DONE');
    await room305.store.act('RESET_DONE');
    await gate.store.act('GATE_FINALIZE');
    await settle();
    const lost = await lobby2.store.act('CALL_TEAM', {}, { dropAllResponses: true });
    expect(lost?.ok).toBe(true);
    expect(lost?.message).toContain('đã xác minh');
    expect(lobby2.store.getSnapshot().verifying).toBeNull();
    // a second team was created exactly once, never twice
    expect(hub.snapshot().rounds).toHaveLength(2);
    expect(hub.snapshot().rounds[1].team_number).toBe(2);

    // (c) a command that really never reached the server is reported as unconfirmed
    const broken = hub.client('room305', { failCommands: true });
    await broken.store.start();
    const failed = await broken.store.act('CLAIM_COMPLETE');
    expect(failed?.ok).toBe(false);
    expect(failed?.message).toContain('CHƯA ĐƯỢC GHI NHẬN');
    expect(broken.store.getSnapshot().verifying).toBeNull();
    // nothing was written: no claim row exists for the fresh round
    expect(hub.attempts(hub.snapshot().rounds[1].id)).toHaveLength(0);
    expect(hub.snapshot().rounds[1].status).toBe('WAITING_FLOOR2_CONFIRMATION');
  });

  it('H7. concurrent presses cannot create two active teams or double-timestamp', async () => {
    const hub = new TestHub();
    const gateways = ['lobby', 'supervisor', 'lobby'].map((id) => hub.gateway(id));
    const call = (gw: ReturnType<TestHub['gateway']>, actor: string, role: string, revision: number, key: string) =>
      gw.command({
        action: 'CALL_TEAM',
        actor: { id: actor, role: role as never, display_name: actor },
        expected_revision: revision,
        idempotency_key: key,
        meta: {},
      });
    const results = await Promise.all([
      call(gateways[0], 'lobby', 'LOBBY', 0, 'race-a'),
      call(gateways[1], 'supervisor', 'SUPERVISOR', 0, 'race-b'),
      call(gateways[2], 'lobby', 'LOBBY', 0, 'race-c'),
    ]);
    // Exactly one reception lands; the other two are refused — one for authority,
    // one because the state had already moved.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.code === 'PERMISSION_DENIED')).toHaveLength(1);
    expect(results.filter((r) => r.code === 'STALE_REVISION')).toHaveLength(1);
    expect(hub.snapshot().rounds).toHaveLength(1);
    expect(hub.snapshot().rounds[0].team_number).toBe(1);

    // Racing the same exit from two phones: one timestamp, one record.
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(301 * SEC);
    const revision = hub.snapshot().revision;
    const exits = await Promise.all([
      call(hub.gateway('gate'), 'gate', 'GATE', revision, 'exit-a'),
      hub.gateway('gate').command({
        action: 'CONFIRM_EXIT',
        actor: { id: 'gate', role: 'GATE', display_name: 'gate' },
        expected_revision: revision,
        idempotency_key: 'exit-b',
        meta: {},
      }),
    ]);
    expect(exits.filter((s) => s.ok).length).toBeGreaterThanOrEqual(1);
    const round = hub.snapshot().rounds.at(-1)!;
    expect(entries(hub).filter((l) => l.action === 'CONFIRM_EXIT')).toHaveLength(1);
    // the later duplicate could not overwrite the first authoritative instant
    expect(entries(hub).filter((l) => l.action === 'CONFIRM_EXIT')[0].at_ms).toBe(round.exit_confirmed_at);
    void exits;
  });

  it('H8. expiry, alarms and a stalled exit are surfaced without auto-stopping', () => {
    const hub = new TestHub();
    onTheClock(hub);
    const limit = hub.snapshot().event.config.game_limit_ms;
    hub.advance(limit - 1); // immediately before
    expect(resolveCountdown(hub.snapshot(), hub.now()).running).toBe(true);
    hub.advance(1); // exactly at 300 s
    const atLimit = hub.snapshot();
    expect(resolveCountdown(atLimit, hub.now()).expired).toBe(true);
    expect(resolveCountdown(atLimit, hub.now()).remainingMs).toBe(0);
    expect(flowStatus(atLimit.active_round!)).toBe('RUNNING'); // nothing was written
    expect(leaderboard(atLimit)).toHaveLength(0);
    hub.advance(40 * SEC);
    expect(resolveCountdown(hub.snapshot(), hub.now()).expired).toBe(true);
    expect(hub.snapshot().active_round!.exit_confirmed_at).toBeNull();
    hub.advance(30 * SEC); // past the non-intrusive stall warning
    expect(resolveAlerts(hub.snapshot(), hub.now(), false).map((a) => a.id)).toContain('STALL');
    // The stored row keeps no result until someone writes one; the derived result is
    // already unambiguous, which is exactly why no expiry task is needed.
    expect(resultOf(hub.snapshot().active_round!, [], limit, hub.now())).toBe('TIME_UP');
    expect(hub.snapshot().active_round!.official_duration_ms).toBeNull();
  });

  it('H9. the first reception survives later actions and imposes no deadline', () => {
    const hub = new TestHub();
    const startedAt = hub.now();
    for (let i = 0; i < 3; i++) playRound(hub, { prepMs: 50 * SEC, claimMs: 100 * SEC, resetMs: 30 * SEC });
    hub.advance(4 * MIN);
    expect(hub.command('supervisor', 'CONFIGURE', { prep_allowance_ms: 120_000, hidden_object_owner: 'GATE' }).ok).toBe(true);
    hub.command('gate', 'SET_LAYOUT', { layout: 'A' });
    expect(hub.snapshot().event.event_started_at).toBe(startedAt);
    // No event cutoff occurs: closing stays a supervisor decision.
    hub.advance(91 * MIN);
    expect(hub.snapshot().event.event_ended_at).toBeNull();
    expect(hub.snapshot().event_status).toBe('LIVE');
    expect(evaluateDispatch(hub.snapshot().event, hub.now()).allowed).toBe(true);
    expect(hub.command('lobby', 'CALL_TEAM').ok).toBe(true);
  });

  it('H10. a silent realtime channel is detected and repaired by verification', async () => {
    const hub = new TestHub();
    const sup = hub.client('supervisor');
    await sup.store.start();
    await settle();

    // this phone's broadcast channel is dead, but its reads still work
    const blind = hub.client('lobby', { silentStream: true });
    await blind.store.start();
    expect(blind.store.getSnapshot().status).toBe('CONNECTED');
    const seen = blind.store.getSnapshot().revision;

    // another device moves the state; no hint can arrive
    await sup.store.act('CONFIGURE', { prep_allowance_ms: 100_000 });
    await settle();
    expect(blind.store.getSnapshot().revision).toBe(seen);

    // the periodic authoritative check closes the gap without any broadcast
    await blind.store.verifyNow();
    expect(blind.store.getSnapshot().revision).toBe(hub.snapshot().revision);
    expect(blind.store.getSnapshot().status).toBe('CONNECTED');
  });

  it('H11. an unreadable server degrades the state and blocks presses', async () => {
    const hub = new TestHub();
    const dead = hub.client('lobby', { failSnapshot: true });
    await dead.store.start();
    expect(dead.store.getSnapshot().snapshot).toBeNull();
    expect(dead.store.getSnapshot().status).toBe('OFFLINE');
    // no snapshot, no authority: the operator is never shown a button to press
    expect(await dead.store.act('CALL_TEAM')).toBeNull();
    expect(hub.snapshot().rounds).toHaveLength(0);

    // a stale-but-readable client must stop claiming CONNECTED
    const stale = hub.client('lobby', { silentStream: true });
    await stale.store.start();
    expect(stale.store.getSnapshot().status).toBe('CONNECTED');
    hub.advance(60 * SEC); // no read happens in this window
    stale.store.checkFreshness();
    expect(stale.store.getSnapshot().status).toBe('DEGRADED');
    // pressing while degraded is allowed (reads still work) and stays honest
    expect(await stale.store.act('CALL_TEAM')).not.toBeNull();
    stale.store.stop();

    // an unrecoverable read leaves the phone unable to authorise any action
    const offline = hub.client('lobby', { failSnapshot: true, silentStream: true });
    await offline.store.start();
    offline.store.stop();
    expect(offline.store.getSnapshot().snapshot).toBeNull();
  });

  it('H12. every official press carries press diagnostics, never browser scores', async () => {
    const hub = new TestHub();
    const lobby = hub.client('lobby');
    const corridor = hub.client('corridor');
    const gate = hub.client('gate');
    await Promise.all([lobby.store.start(), corridor.store.start(), gate.store.start()]);
    await lobby.store.act('CALL_TEAM');
    await corridor.store.act('CONFIRM_FLOOR2');
    hub.advance(30 * SEC);
    await gate.store.act('START_GAME');
    const round = hub.snapshot().active_round!;
    // the recorded press is within one frame of the authoritative start
    expect(round.start_press_ms).not.toBeNull();
    expect(Math.abs((round.start_press_ms ?? 0) - round.game_started_at!)).toBeLessThan(50);
    expect(round.start_transport_ms).toBeLessThan(50);
    expect(round.needs_review).toBe(false);
    // the deadline is the server's, not the phone's
    expect(round.deadline_at).toBe(round.game_started_at! + 300 * SEC);
  });

  it('H13. an idempotent replay of a committed press never re-timestamps (R01)', () => {
    const hub = new TestHub();
    const key = 'same-tap';
    const first = hub.command('lobby', 'CALL_TEAM', {}, undefined, key);
    const at = hub.snapshot().rounds[0].called_at;
    hub.advance(5 * SEC);
    const replay = hub.command('lobby', 'CALL_TEAM', {}, undefined, key);
    expect(first.ok && replay.ok).toBe(true);
    expect(replay.revision).toBe(first.revision);
    expect(hub.snapshot().rounds).toHaveLength(1);
    expect(hub.snapshot().rounds[0].called_at).toBe(at);
  });

  it('H14. a viewer can never author anything, even with a valid-looking request', async () => {
    const hub = new TestHub();
    const viewer = hub.client('observer');
    await viewer.store.start();
    await settle();
    for (const action of ['CALL_TEAM', 'CONFIRM_FLOOR2', 'START_GAME', 'CLAIM_COMPLETE', 'VERIFY_ATTEMPT', 'CONFIRM_EXIT', 'EARLY_EXIT', 'GATE_FINALIZE'] as const) {
      const res = await viewer.store.act(action);
      expect(res?.ok, action).toBe(false);
      expect(res?.code === 'READ_ONLY' || res?.code === 'PERMISSION_DENIED', `${action}:${res?.code}`).toBe(true);
    }
    expect(hub.snapshot().rounds).toHaveLength(0);
    viewer.store.stop();
  });
});
