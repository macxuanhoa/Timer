import { describe, expect, it } from 'vitest';
import { MIN, SEC, TestHub, entries, latest, playRound } from './helpers/harness';
import { analytics, leaderboard, roundMetrics } from '../src/shared/metrics';
import { evaluateDispatch } from '../src/shared/machine';
import { resolveAlerts, resolveHero } from '../src/client/selectors';
import type { CommandRequest } from '../src/shared/types';

/** A press that reached the server late, as a real phone on bad Wi-Fi would send. */
const latePress = (hub: TestHub, ms: number): CommandRequest['press'] => ({
  press_ms: hub.now() - ms,
  local_press_ms: Date.now() - ms,
  rtt_ms: ms,
});

describe('hardening — disputes, recovery and concurrency', () => {
  it('H1. a slow STOP is recorded, disputed and withheld from the ranking (P0-01, P0-05)', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME', {}, undefined, 'start-key', latePress(hub, 1800));
    const started = hub.snapshot().active_round!;
    expect(started.start_transport_ms).toBeGreaterThanOrEqual(1800);
    expect(started.needs_review).toBe(true);
    expect(started.review_reasons).toContain('START_TRANSPORT');
    // the official start instant is still the server value, never the press time
    expect(started.game_started_at).toBe(hub.now());
    expect(started.start_press_ms).toBeLessThan(started.game_started_at!);

    hub.advance(100 * SEC);
    hub.command('room305', 'ROOM_REACHED');
    hub.command('room305', 'PUZZLE_COMPLETE');
    hub.command('gate', 'GAME_STOP', {}, undefined, 'stop-key', latePress(hub, 1500));
    const round = hub.snapshot().rounds.at(-1)!;
    expect(round.stop_transport_ms).toBeGreaterThanOrEqual(1500);
    expect(round.review_reasons).toContain('STOP_TRANSPORT');
    expect(round.outcome).toBe('WON'); // the measurement is preserved …
    expect(leaderboard(hub.snapshot())).toHaveLength(0); // … but no prize from disputed data

    // a disputed finish is visible on the operator screen, not buried in the sheet
    const alerts = resolveAlerts(hub.snapshot(), hub.now(), false);
    expect(alerts.map((a) => a.id)).toContain('REVIEW');

    // the supervisor has to decide explicitly
    expect(hub.command('gate', 'REVIEW_RESOLVE', { round_id: round.id, decision: 'ACCEPT', reason: 'x' }).code).toBe(
      'PERMISSION_DENIED',
    );
    expect(hub.command('supervisor', 'REVIEW_RESOLVE', { round_id: round.id, decision: 'ACCEPT' }).code).toBe('BLOCKED');
    hub.advance(30 * SEC);
    hub.command('corridor', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    hub.command('gate', 'GATE_FINALIZE');
    const resolved = hub.command('supervisor', 'REVIEW_RESOLVE', {
      round_id: round.id,
      decision: 'ACCEPT',
      reason: 'Da xem lai nhat ky',
    });
    expect(resolved.ok).toBe(true);
    expect(leaderboard(hub.snapshot()).map((r) => r.team_number)).toEqual([1]);
    const audit = latest(hub, 'REVIEW_RESOLVE')!;
    expect(audit.metadata).toMatchObject({ decision: 'ACCEPT', reason: 'Da xem lai nhat ky' });
  });

  it('H2. a finish within the review window of 5:00 is disputed, not auto-decided', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(300 * SEC - 200); // 200 ms short of the limit
    hub.command('room305', 'ROOM_REACHED');
    hub.command('room305', 'PUZZLE_COMPLETE');
    hub.command('gate', 'GAME_STOP');
    const round = hub.snapshot().rounds.at(-1)!;
    expect(round.official_duration_ms).toBe(299_800);
    expect(round.review_reasons).toContain('CLOSE_FINISH');
    expect(leaderboard(hub.snapshot())).toHaveLength(0);

    // and a full 200 ms outside the window is an ordinary, rankable result
    const hub2 = new TestHub();
    playRound(hub2, { prepMs: 60 * SEC, gameMs: 299_400 });
    const clean = hub2.snapshot().rounds.at(-1)!;
    expect(clean.review_reasons).toEqual([]);
    expect(leaderboard(hub2.snapshot())).toHaveLength(1);
  });

  it('H3. reopening a reset revokes READY and forces all three confirmations (P0-06)', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(60 * SEC);
    hub.command('gate', 'GAME_STOP');
    hub.command('corridor', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    expect(hub.command('room305', 'REOPEN_RESET', { reason: 'nham' }).code).toBe('PERMISSION_DENIED');
    expect(hub.command('supervisor', 'REOPEN_RESET', { reason: 'nham' }).code).toBe('INVALID_STATE'); // no round_id
    const roundId = hub.snapshot().active_round!.id;
    const before = hub.snapshot().reset_tasks.filter((t) => t.completed_at !== null).length;
    expect(before).toBe(3);
    const reopen = hub.command('supervisor', 'REOPEN_RESET', { round_id: roundId, task_key: 'room', reason: 'Manocung chua dat lai' });
    expect(reopen.ok).toBe(true);

    const after = hub.snapshot();
    expect(after.reset_tasks.every((t) => t.completed_at === null)).toBe(true);
    expect(after.active_round!.reset_cycle).toBe(2);
    expect(after.active_round!.system_ready_at).toBeNull();
    expect(after.phase).toBe('RESETTING');
    // dispatch is refused again — the old DONE marks cannot authorise a team
    expect(hub.command('lobby', 'CALL_TEAM').code).toBe('INVALID_STATE');
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED');

    // re-confirm the new cycle only
    hub.command('corridor', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    const tasks = hub.snapshot().reset_tasks;
    expect(tasks.filter((t) => t.completed_at !== null).map((t) => t.cycle)).toEqual([2, 2, 2]);
    expect(hub.command('gate', 'GATE_FINALIZE').ok).toBe(true);
    expect(hub.command('lobby', 'CALL_TEAM').ok).toBe(true);
    const audit = latest(hub, 'REOPEN_RESET')!;
    expect(audit.metadata).toMatchObject({ reason: 'Manocung chua dat lai', task: 'room', cycle: 2 });
    // the invalidated timestamps stay in history, never rewritten
    expect(hub.snapshot().reset_tasks.filter((t) => t.reopen_count === 1).length).toBe(3);
  });

  it('H4. a reset confirmation from a previous round can never be reused (G07)', () => {
    const hub = new TestHub();
    playRound(hub); // round 1 fully closed
    const first = hub.snapshot().rounds[0];
    expect(first.system_ready_at).not.toBeNull();
    hub.command('lobby', 'CALL_TEAM'); // round 2
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(60 * SEC);
    hub.command('gate', 'GAME_STOP');
    const second = hub.snapshot().rounds[1];
    expect(second.id).not.toBe(first.id);
    // round 2 has its own untouched task rows
    expect(hub.snapshot().reset_tasks.filter((t) => t.round_id === second.id && t.completed_at === null)).toHaveLength(3);
    expect(hub.command('gate', 'GATE_FINALIZE').code).toBe('BLOCKED');
    const metrics = roundMetrics(second, hub.snapshot().reset_tasks);
    expect(metrics.corridor_reset_ms).toBeNull(); // not inherited from round 1
  });

  it('H5. hiding layout is owned by one operator and recorded per team (Scenario C)', () => {
    const hub = new TestHub();
    expect(hub.command('room305', 'SET_LAYOUT', { layout: 'B' }).code).toBe('PERMISSION_DENIED');
    expect(hub.command('corridor', 'SET_LAYOUT', { layout: 'Z' }).code).toBe('INVALID_STATE');
    expect(hub.command('corridor', 'SET_LAYOUT', { layout: 'B' }).ok).toBe(true);
    hub.command('lobby', 'CALL_TEAM');
    expect(hub.snapshot().active_round!.hiding_layout).toBe('B');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(60 * SEC);
    hub.command('gate', 'GAME_STOP');
    hub.command('corridor', 'RESET_DONE');
    const stamped = hub.snapshot().reset_tasks.find((t) => t.task_key === 'hidden_objects')!;
    expect(stamped.layout).toBe('B');
    // GATE can read what is prepared for the next team
    const next = hub.command('corridor', 'SET_LAYOUT', { layout: 'C' });
    expect(next.ok).toBe(true);
    expect(hub.snapshot().event.config.hiding_layout).toBe('C');
    expect(entries(hub).some((l) => l.action === 'SET_LAYOUT' && l.metadata?.to === 'C')).toBe(true);
  });

  it('H6. committed action + lost response reconciles without duplication (G02, Scenario G)', async () => {
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
    await lobby2.store.act('TEAM_UPSTAIRS');
    hub.command('gate', 'START_GAME');
    hub.advance(60 * SEC);
    hub.command('gate', 'GAME_STOP');
    // close round 1 properly, otherwise a new dispatch is legitimately refused
    hub.command('corridor', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    hub.command('gate', 'GATE_FINALIZE');
    await settle();
    const lost = await lobby2.store.act('CALL_TEAM', {}, { dropAllResponses: true });
    expect(lost?.ok).toBe(true);
    expect(lost?.message).toContain('đã xác minh');
    expect(lobby2.store.getSnapshot().verifying).toBeNull();
    // a second team was created exactly once (round 2), never twice
    expect(hub.snapshot().rounds).toHaveLength(2);
    expect(hub.snapshot().rounds[1].team_number).toBe(2);

    // (c) a command that really never reached the server is reported as unconfirmed
    const broken = hub.client('corridor', { failCommands: true });
    await broken.store.start();
    const openTasks = () => hub.snapshot().reset_tasks.filter((t) => t.completed_at !== null).length;
    const before = openTasks();
    const failed = await broken.store.act('RESET_DONE');
    expect(failed?.ok).toBe(false);
    expect(failed?.message).toContain('CHƯA ĐƯỢC GHI NHẬN');
    expect(broken.store.getSnapshot().verifying).toBeNull();
    // nothing was written: the completion count is untouched and no log row exists
    expect(openTasks()).toBe(before);
    expect(entries(hub).filter((l) => l.action === 'RESET_DONE' && l.actor_role === 'CORRIDOR')).toHaveLength(1);
    // the last round is still the reconciled dispatch from (b): unchanged state
    expect(hub.snapshot().rounds.at(-1)!.status).toBe('LOBBY_CALL');
  });

  it('H7. concurrent presses cannot create two active teams or double-timestamp (G04, R01, R02)', async () => {
    const hub = new TestHub();
    const gateways = ['lobby', 'supervisor', 'lobby'].map((id) => hub.gateway(id));
    const call = (gw: ReturnType<TestHub['gateway']>, actor: string, revision: number, key: string) =>
      gw.command({
        action: 'CALL_TEAM',
        actor: { id: actor, role: actor === 'lobby' ? 'LOBBY' : 'SUPERVISOR', display_name: actor },
        expected_revision: revision,
        idempotency_key: key,
        meta: {},
      });
    const results = await Promise.all([
      call(gateways[0], 'lobby', 0, 'race-a'),
      call(gateways[1], 'supervisor', 0, 'race-b'),
      call(gateways[2], 'lobby', 0, 'race-c'),
    ]);
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    expect(results.filter((r) => r.code === 'STALE_REVISION')).toHaveLength(2);
    expect(hub.snapshot().rounds).toHaveLength(1);
    expect(hub.snapshot().rounds[0].team_number).toBe(1);

    // racing the same logical STOP from two phones: one timestamp, one record
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(60 * SEC);
    const revision = hub.snapshot().revision;
    const stops = await Promise.all([
      call(hub.gateway('gate'), 'gate', revision, 'stop-a'),
      hub.gateway('gate').command({
        action: 'GAME_STOP',
        actor: { id: 'gate', role: 'GATE', display_name: 'gate' },
        expected_revision: revision,
        idempotency_key: 'stop-b',
        meta: {},
      }),
    ]);
    expect(stops.filter((s) => s.ok).length).toBeGreaterThanOrEqual(1);
    const round = hub.snapshot().rounds.at(-1)!;
    expect(entries(hub).filter((l) => l.action === 'GAME_STOP')).toHaveLength(1);
    expect(round.game_stopped_at).not.toBeNull();
    // the later duplicate could not overwrite the first authoritative instant
    const stoppedAt = round.game_stopped_at;
    expect(entries(hub).filter((l) => l.action === 'GAME_STOP')[0].at_ms).toBe(stoppedAt);
  });

  it('H8. timeouts, alarms and stalled exits are surfaced without auto-stopping (G05, Scenario B)', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(60 * SEC);
    hub.command('gate', 'START_GAME');

    const limit = hub.snapshot().event.config.game_limit_ms;
    hub.advance(limit - 1); // immediately before
    expect(resolveHero(hub.snapshot(), hub.now()).mode).toBe('GAME');
    hub.advance(1); // exactly at 300 s
    const atLimit = hub.snapshot();
    expect(resolveHero(atLimit, hub.now()).mode).toBe('GAME_OVERTIME');
    expect(atLimit.active_round!.game_stopped_at).toBeNull(); // never auto-stopped
    expect(resolveAlerts(atLimit, hub.now(), false).map((a) => a.id)).toContain('OVERTIME');
    hub.advance(40 * SEC); // after
    expect(hub.command('gate', 'GAME_STOP').ok).toBe(true);
    expect(hub.snapshot().rounds.at(-1)!.official_duration_ms).toBe(limit + 40 * SEC);

    // a stalled RETURNING team warns without touching the clock
    const hub2 = new TestHub();
    hub2.command('lobby', 'CALL_TEAM');
    hub2.advance(60 * SEC);
    hub2.command('gate', 'START_GAME');
    hub2.advance(30 * SEC);
    hub2.command('room305', 'ROOM_REACHED');
    hub2.command('room305', 'PUZZLE_COMPLETE');
    hub2.command('room305', 'RETURN_START');
    expect(resolveAlerts(hub2.snapshot(), hub2.now(), false)).toHaveLength(0);
    hub2.advance(90 * SEC);
    const alert = resolveAlerts(hub2.snapshot(), hub2.now(), false).find((a) => a.id === 'STALL');
    expect(alert?.text).toContain('GATE chưa chốt giờ');
    expect(hub2.snapshot().active_round!.game_stopped_at).toBeNull();
  });

  it('H9. first-dispatch history survives later actions without imposing a deadline (P0-07)', () => {
    const hub = new TestHub();
    const startedAt = hub.now();
    for (let i = 0; i < 3; i++) playRound(hub, { prepMs: 50 * SEC, gameMs: 100 * SEC, resetMs: 30 * SEC });
    hub.advance(4 * MIN);
    hub.command('supervisor', 'CONFIGURE', { prep_allowance_ms: 120_000, hidden_object_owner: 'GATE' });
    hub.command('corridor', 'SET_LAYOUT', { layout: 'A' });
    expect(hub.snapshot().event.event_started_at).toBe(startedAt);
    expect(hub.snapshot().event.config.event_duration_ms).toBe(90 * MIN);
    // No event cutoff occurs; closing it stays a supervisor decision.
    hub.advance(91 * MIN);
    expect(hub.snapshot().event.event_ended_at).toBeNull();
    expect(hub.snapshot().event_status).toBe('LIVE');
    expect(evaluateDispatch(hub.snapshot().event, hub.now()).allowed).toBe(true);
    expect(hub.command('lobby', 'CALL_TEAM').ok).toBe(true);
  });
  it('H10. a silent realtime channel is detected and repaired by verification (P0-02)', async () => {
    const hub = new TestHub();
    const sup = hub.client('supervisor');
    await sup.store.start();
    await settle();

    // this phone’s broadcast channel is dead, but its reads still work
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

  it('H11. an unreadable server degrades the state and blocks presses (P0-02, R08)', async () => {
    const hub = new TestHub();
    const sup = hub.client('supervisor');
    await sup.store.start();
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
    expect(await stale.store.act('TEAM_UPSTAIRS')).not.toBeNull();
    stale.store.stop();

    // an unrecoverable read leaves the phone unable to authorise any action
    const offline = hub.client('lobby', { failSnapshot: true, silentStream: true });
    await offline.store.start();
    offline.store.stop();
    expect(offline.store.getSnapshot().snapshot).toBeNull();
  });

  it('H12. every official press carries press diagnostics, never browser scores (P0-01)', async () => {
    const hub = new TestHub();
    const sup = hub.client('supervisor');
    await sup.store.start();
    const lobby = hub.client('lobby');
    await lobby.store.start();
    await lobby.store.act('CALL_TEAM');
    const gate = hub.client('gate');
    await gate.store.start();
    hub.advance(30 * SEC);
    await gate.store.act('START_GAME');
    const round = hub.snapshot().active_round!;
    // the recorded press is within one frame of the authoritative start
    expect(round.start_press_ms).not.toBeNull();
    expect(Math.abs((round.start_press_ms ?? 0) - round.game_started_at!)).toBeLessThan(50);
    expect(round.start_transport_ms).toBeLessThan(50);
    expect(round.needs_review).toBe(false);
  });

  it('H13. an idempotent replay of a committed press never re-timestamps (R01)', async () => {
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
});

async function settle(times = 8) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}
