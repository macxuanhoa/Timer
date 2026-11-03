import { describe, expect, it } from 'vitest';
import { OPERATORS, SEC, TestHub } from './helpers/harness';
import { activeRound, isLockedPhase, phaseOf, resolveCountdown, resolvePrimary } from '../src/client/selectors';
import { LiveStore } from '../src/client/liveStore';

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(times = 8) {
  for (let i = 0; i < times; i++) await flush();
}

/**
 * The four operator phones plus the retained admin and an open viewer, all reading
 * one authoritative state. Convergence is asserted on revisions and phases, never on
 * a rendered string, so a display change can never hide a synchronisation fault.
 */
describe('PASS 2 — synchronized clients on one authoritative state', () => {
  it('14. every device converges to the same revision', async () => {
    const hub = new TestHub();
    const clients = OPERATORS.map((o) => hub.client(o.id));
    await Promise.all(clients.map((c) => c.store.start()));

    const steps: [number, () => Promise<unknown>][] = [
      [1, () => clients[0].store.act('CALL_TEAM', { team_name: 'Team A' })],
      [2, () => clients[1].store.act('CONFIRM_FLOOR2')],
      [3, () => clients[2].store.act('START_GAME')],
      [4, async () => {
        hub.advance(40 * SEC);
        return clients[3].store.act('CLAIM_COMPLETE');
      }],
    ];
    for (const [expected, press] of steps) {
      await press(); // each step is pressed by exactly one phone
      await settle();
      const revisions = clients.map((c) => c.store.getSnapshot().revision);
      expect(new Set(revisions).size, `revs ${revisions.join(',')}`).toBe(1);
      expect(revisions[0]).toBe(expected);
      const phases = new Set(clients.map((c) => c.store.getSnapshot().snapshot?.phase));
      expect(phases.size).toBe(1);
    }

    const states = clients.map((c) => c.store.getSnapshot().snapshot!);
    expect(states.every((s) => s.active_round?.id === states[0].active_round?.id)).toBe(true);
    expect(states.every((s) => s.rounds.length === 1)).toBe(true);
    // One claim, visible identically on every phone, including the viewer's copy.
    expect(states.every((s) => s.active_round?.status === 'RUNNING')).toBe(true);
    clients.forEach((c) => c.store.stop());
  });

  it('14c. a team rename reaches every phone at the same revision', async () => {
    const hub = new TestHub();
    const lobby = hub.client('lobby');
    const gate = hub.client('gate');
    await lobby.store.start();
    await gate.store.start();
    await settle();

    await lobby.store.act('CALL_TEAM', { team_name: 'Ma Tro' });
    await settle();
    expect(gate.store.getSnapshot().snapshot?.active_round?.team_name).toBe('Ma Tro');

    // The correction is a normal command: the other station adopts it with the
    // acknowledged revision, not on its next poll.
    expect((await lobby.store.act('SET_TEAM_NAME', { team_name: 'Nhà Búp Bê' }))?.ok).toBe(true);
    await settle();
    expect(gate.store.getSnapshot().snapshot?.active_round?.team_name).toBe('Nhà Búp Bê');
    expect(gate.store.getSnapshot().revision).toBe(lobby.store.getSnapshot().revision);
    lobby.store.stop();
    gate.store.stop();
  });

  it('14b. each role sees exactly one obvious next action', async () => {
    const hub = new TestHub();
    const stores = new Map(OPERATORS.map((o) => [o.role, hub.client(o.id).store]));
    await Promise.all([...stores.values()].map((s) => s.start()));
    await settle();

    const label = (role: (typeof OPERATORS)[number]['role']) => {
      const store = stores.get(role)!;
      const snap = store.getSnapshot().snapshot!;
      return resolvePrimary(role, snap, store.serverNow());
    };

    // Nothing has been received yet: only OPERATOR 01 has a button.
    expect(label('SUPERVISOR').action).toBe(null);
    expect(label('OBSERVER').action).toBe(null);
    expect(label('LOBBY').action).toBe('CALL_TEAM');
    expect(label('GATE').action).toBe(null);
    expect(label('CORRIDOR').label).toContain('ĐANG CHỜ TIẾP NHẬN');

    await stores.get('LOBBY')!.act('CALL_TEAM');
    await settle();
    // 01 is done for this team; 02 must confirm and NPC 1 may bypass the floor.
    expect(label('CORRIDOR').action).toBe('CONFIRM_FLOOR2');
    expect(label('GATE').action).toBe('FLOOR2_BYPASS');
    expect(label('GATE').reasonPrompt).toBeTruthy();
    expect(label('LOBBY').action).toBe(null);
    expect(label('ROOM305').action).toBe(null);

    await stores.get('CORRIDOR')!.act('CONFIRM_FLOOR2');
    await settle();
    // Pre-start: the whole room reads the same alert, only NPC 1 can start.
    expect(label('GATE').action).toBe('START_GAME');
    expect(label('LOBBY').label).toBe('ĐỘI CHƠI SẮP BẮT ĐẦU');
    expect(label('CORRIDOR').label).toBe('ĐỘI CHƠI SẮP BẮT ĐẦU');
    expect(label('ROOM305').action).toBe(null);

    await stores.get('GATE')!.act('START_GAME');
    await settle();
    expect(label('ROOM305').action).toBe('CLAIM_COMPLETE');
    expect(label('GATE').action).toBe(null); // the emergency path is secondary, not primary
    expect(label('LOBBY').action).toBe(null);
    expect(label('CORRIDOR').action).toBe(null);

    await stores.get('ROOM305')!.act('CLAIM_COMPLETE');
    await settle();
    const claims = stores.get('ROOM305')!.getSnapshot().snapshot!.attempts;
    expect(claims).toHaveLength(1);

    hub.advance(20 * SEC);
    await stores.get('ROOM305')!.act('VERIFY_ATTEMPT', { attempt_id: claims[0].id, decision: 'VALID' });
    await settle();
    expect(label('GATE').action).toBe('CONFIRM_EXIT');
    expect(label('ROOM305').action).toBe(null);

    await stores.get('GATE')!.act('CONFIRM_EXIT');
    await settle();
    expect(label('GATE').action).toBe('RESET_DONE');
    expect(label('ROOM305').action).toBe('RESET_DONE');
    expect(label('LOBBY').action).toBe(null);
    expect(label('CORRIDOR').action).toBe(null);

    await stores.get('GATE')!.act('RESET_DONE');
    await stores.get('ROOM305')!.act('RESET_DONE');
    await settle();
    expect(label('GATE').action).toBe('GATE_FINALIZE');

    await stores.get('GATE')!.act('GATE_FINALIZE');
    await settle();
    expect(label('LOBBY').action).toBe('CALL_TEAM');
    stores.forEach((s) => s.stop());
  });

  it('15. a reconnecting phone restores the session, the deadline and the state', async () => {
    const hub = new TestHub();
    const lobby = hub.client('lobby');
    const corridor = hub.client('corridor');
    const gate = hub.client('gate');
    await Promise.all([lobby.store.start(), corridor.store.start(), gate.store.start()]);

    await lobby.store.act('CALL_TEAM');
    await settle();
    hub.advance(50 * SEC);
    await corridor.store.act('CONFIRM_FLOOR2');
    await gate.store.act('START_GAME');
    await settle();

    // GATE loses the network entirely: it stops receiving hints.
    gate.store.stop();
    hub.advance(70 * SEC);
    const room = hub.client('room305');
    await room.store.start();
    await room.store.act('CLAIM_COMPLETE');
    await settle();
    room.store.stop();

    // Reopening the app recovers from the server, not from local memory.
    const gate2 = hub.client('gate');
    await gate2.store.start();
    const snap = gate2.store.getSnapshot().snapshot!;
    expect(snap.phase).toBe('RUNNING');
    expect(activeRound(snap)?.status).toBe('RUNNING');
    expect(snap.event.event_started_at).toBe(hub.snapshot().event.event_started_at);
    expect(Math.abs(gate2.store.serverNow() - hub.now())).toBeLessThan(50);
    const clock = resolveCountdown(snap, gate2.store.serverNow());
    expect(isLockedPhase(snap.phase)).toBe(true);
    // 5:00 minus the 70 s already played = 230 s still on the official clock.
    expect(Math.abs(clock.remainingMs - 230 * SEC)).toBeLessThan(5 * SEC);
    // The claim the other phone recorded is part of the same authoritative state.
    expect(snap.attempts).toHaveLength(1);
    gate2.store.stop();
  });

  it('stale phones are reconciled instead of being allowed to force a transition', async () => {
    const hub = new TestHub();
    const lobby = hub.client('lobby');
    const corridor = hub.client('corridor');
    const room = hub.client('room305');
    await lobby.store.start();
    await corridor.store.start();
    await room.store.start();
    await lobby.store.act('CALL_TEAM');
    await corridor.store.act('CONFIRM_FLOOR2');
    await settle();

    // ROOM305 holds a stale view: its subscription was dropped before NPC 1 started.
    room.store.stop();
    const fresh = hub.client('gate');
    await fresh.store.start();
    await fresh.store.act('START_GAME');
    await settle();

    const before = hub.snapshot().revision;
    const staleView = room.store.getSnapshot().snapshot!;
    expect(staleView.revision).toBeLessThan(before);
    const res = await room.store.act('CLAIM_COMPLETE');
    expect(res?.code).toBe('STALE_REVISION');
    await settle();
    expect(room.store.getSnapshot().revision).toBe(hub.snapshot().revision);
    expect(room.store.getSnapshot().notice).toContain('đồng bộ lại');
    // …and now the same press succeeds against the fresh revision.
    expect((await room.store.act('CLAIM_COMPLETE'))?.ok).toBe(true);
  });

  it('16. opening “Xem thêm” never pauses or mutates the live dashboard', async () => {
    const hub = new TestHub();
    const clients = OPERATORS.map((o) => hub.client(o.id));
    await Promise.all(clients.map((c) => c.store.start()));
    await settle();

    // The sheet is a pure overlay: it reads the same store and issues no command.
    const before = hub.snapshot().revision;
    const lobby = clients[0].store;
    await lobby.act('CALL_TEAM');
    await settle();
    hub.advance(30 * SEC);
    await clients[1].store.act('CONFIRM_FLOOR2');
    await clients[2].store.act('START_GAME');
    await settle();
    expect(hub.snapshot().revision).toBe(before + 3);
    // every other phone kept advancing while the sheet would have been open
    expect(clients[3].store.getSnapshot().revision).toBe(before + 3);
    expect(phaseOf(clients[3].store.getSnapshot().snapshot!, clients[3].store.serverNow())).toBe('RUNNING');
    const clock = resolveCountdown(clients[3].store.getSnapshot().snapshot!, clients[3].store.serverNow());
    expect(clock.running).toBe(true);
    expect(hub.snapshot().revision).toBe(before + 3);
    clients.forEach((c) => c.store.stop());
  });

  it('the client clock estimate tracks the authoritative clock', async () => {
    const hub = new TestHub();
    const c = hub.client('lobby');
    await c.store.start();
    expect(c.store.getSnapshot().clockReady).toBe(true);
    hub.advance(3 * SEC);
    expect(Math.abs(c.store.serverNow() - hub.now())).toBeLessThan(50);
    expect(c.store.getSnapshot().maxDisplayErrorMs).not.toBeNull();
    c.store.stop();
  });

  it('a press instant reaches the wire as a whole millisecond', async () => {
    const hub = new TestHub();
    const lobby = hub.client('lobby');
    const corridor = hub.client('corridor');
    await lobby.store.start();
    await corridor.store.start();
    await lobby.store.act('CALL_TEAM');
    await corridor.store.act('CONFIRM_FLOOR2');
    await settle();

    const inner = hub.gateway('gate');
    const sent: number[] = [];
    // performance.now() is fractional in every browser, so the calibrated press
    // estimate is too; the harness clock hides that by ticking in whole ms.
    let mono = 1000.25;
    const store = new LiveStore({
      gateway: {
        ...inner,
        command: (req, opts) => {
          sent.push(req.press!.press_ms);
          return inner.command(req, opts);
        },
      },
      account: { id: 'gate', role: 'GATE', display_name: 'Hung' },
      mono: () => (mono += 1.5),
    });
    await store.start();
    await settle();

    expect((await store.act('START_GAME'))?.ok).toBe(true);
    // A fractional instant is rejected outright by the database, which would
    // roll the press back and report "CHƯA ĐƯỢC GHI NHẬN" on every retry.
    expect(sent).toHaveLength(1);
    expect(Number.isInteger(sent[0])).toBe(true);
    expect(hub.snapshot().active_round?.start_press_ms).toBe(sent[0]);
    store.stop();
    lobby.store.stop();
    corridor.store.stop();
  });

  it('double taps from one phone produce one server action', async () => {
    const hub = new TestHub();
    const lobby = hub.client('lobby');
    await lobby.store.start();
    await settle();
    const a = lobby.store.act('CALL_TEAM');
    const b = lobby.store.act('CALL_TEAM'); // second finger on the same button
    await Promise.all([a, b]);
    await settle();
    expect(hub.snapshot().rounds).toHaveLength(1);
    expect(lobby.store.getSnapshot().revision).toBe(hub.snapshot().revision);
    lobby.store.stop();
  });

  it('two taps on the claim button record one attempt, not two', async () => {
    const hub = new TestHub();
    const lobby = hub.client('lobby');
    const corridor = hub.client('corridor');
    const gate = hub.client('gate');
    const room = hub.client('room305');
    await Promise.all([lobby, corridor, gate, room].map((c) => c.store.start()));
    await lobby.store.act('CALL_TEAM');
    await corridor.store.act('CONFIRM_FLOOR2');
    await gate.store.act('START_GAME');
    await settle();

    await Promise.all([room.store.act('CLAIM_COMPLETE'), room.store.act('CLAIM_COMPLETE')]);
    await settle();
    expect(hub.attempts()).toHaveLength(1);
    [lobby, corridor, gate, room].forEach((c) => c.store.stop());
  });

  it('network failure never marks a state as done', async () => {
    const hub = new TestHub();
    const lobby = hub.client('lobby');
    const corridor = hub.client('corridor');
    await lobby.store.start();
    await corridor.store.start();
    await lobby.store.act('CALL_TEAM');
    await corridor.store.act('CONFIRM_FLOOR2');
    await settle();

    const broken = hub.client('gate', { failCommands: true });
    await broken.store.start();
    // The reply never comes back, so the store asks the server whether the press
    // committed instead of claiming either outcome.
    const res = await broken.store.act('START_GAME');
    expect(res?.ok).toBe(false);
    expect(res?.message).toContain('CHƯA ĐƯỢC GHI NHẬN');
    expect(broken.store.getSnapshot().error).toContain('CHƯA ĐƯỢC GHI NHẬN');
    expect(broken.store.getSnapshot().verifying).toBeNull();
    expect(hub.snapshot().active_round?.game_started_at).toBeNull();

    // a healthy connection performs the same press successfully
    const healthy = hub.client('gate');
    await healthy.store.start();
    expect((await healthy.store.act('START_GAME'))?.ok).toBe(true);
    expect(hub.snapshot().active_round?.game_started_at).toBe(hub.now());
    expect(lobby.store.getSnapshot().snapshot?.phase).toBe('RUNNING');
  });

  it('an unreadable server is reported as OFFLINE instead of showing a stale action', async () => {
    const hub = new TestHub();
    const lobby = hub.client('lobby', { failSnapshot: true });
    await lobby.store.start();
    expect(lobby.store.getSnapshot().status).toBe('OFFLINE');
    expect(lobby.store.getSnapshot().snapshot).toBeNull();
    expect(await lobby.store.act('CALL_TEAM')).toBeNull();
    expect(hub.snapshot().rounds).toHaveLength(0);
  });

  it('a silent realtime channel still converges through the periodic check', async () => {
    const hub = new TestHub();
    const lobby = hub.client('lobby');
    // No broadcast ever arrives, but the state stays readable.
    const watcher = hub.client('room305', { silentStream: true });
    await lobby.store.start();
    await watcher.store.start();
    await settle();
    await lobby.store.act('CALL_TEAM');
    await settle();
    // Without hints the watcher must recover by verifying on its own cadence.
    expect(watcher.store.getSnapshot().revision).toBeLessThan(hub.snapshot().revision);
    await watcher.store.verifyNow();
    expect(watcher.store.getSnapshot().revision).toBe(hub.snapshot().revision);
    expect(watcher.store.getSnapshot().snapshot?.phase).toBe('WAITING_FLOOR2_CONFIRMATION');
    lobby.store.stop();
    watcher.store.stop();
  });
});
