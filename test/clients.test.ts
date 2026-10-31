import { describe, expect, it } from 'vitest';
import { OPERATORS, SEC, TestHub } from './helpers/harness';
import { resolveHero, resolvePrimary, activeRound } from '../src/client/selectors';
import { LiveStore } from '../src/client/liveStore';

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(times = 8) {
  for (let i = 0; i < times; i++) await flush();
}

describe('PASS 2 — five synchronized operator clients', () => {
  it('14. all five devices converge to the same revision', async () => {
    const hub = new TestHub();
    const clients = OPERATORS.map((o) => hub.client(o.id));
    await Promise.all(clients.map((c) => c.store.start()));

    for (const expected of [1, 2, 3]) {
      // each step is pressed by exactly one phone
      if (expected === 1) await clients[0].store.act('CALL_TEAM', { team_name: 'Team A' });
      if (expected === 2) await clients[1].store.act('START_GAME');
      if (expected === 3) {
        hub.advance(40 * SEC);
        await clients[3].store.act('ROOM_REACHED');
      }
      await settle();
      const revisions = clients.map((c) => c.store.getSnapshot().revision);
      expect(new Set(revisions).size, `revs ${revisions.join(',')}`).toBe(1);
      expect(revisions[0]).toBe(expected);
      const phases = new Set(clients.map((c) => c.store.getSnapshot().snapshot?.phase));
      expect(phases.size).toBe(1);
    }

    // the same authoritative state is visible on every phone
    const states = clients.map((c) => c.store.getSnapshot().snapshot!);
    expect(states.every((s) => s.active_round?.id === states[0].active_round?.id)).toBe(true);
    expect(states.every((s) => s.rounds.length === 1)).toBe(true);
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

    expect(label('SUPERVISOR').action).toBe(null);
    expect(label('LOBBY').action).toBe('CALL_TEAM'); // LOBBY calls the first team
    expect(label('GATE').action).toBe(null);
    expect(label('GATE').label).toContain('CHỜ LOBBY');

    await stores.get('LOBBY')!.act('CALL_TEAM');
    await settle();
    expect(label('GATE').action).toBe('START_GAME');
    // LOBBY owns the first leg of the walk and confirms the team reached the door.
    expect(label('LOBBY').action).toBe('TEAM_UPSTAIRS');
    expect(label('ROOM305').action).toBe(null);

    await stores.get('LOBBY')!.act('TEAM_UPSTAIRS');
    await settle();
    expect(label('LOBBY').action).toBe(null); // nothing left to press while GATE holds the clock
    expect(label('GATE').action).toBe('START_GAME');

    await stores.get('GATE')!.act('START_GAME');
    await settle();
    expect(label('CORRIDOR').action).toBe('HALLWAY_PROGRESS');
    expect(label('ROOM305').action).toBe('ROOM_REACHED');
    expect(label('GATE').action).toBe('GAME_STOP');

    hub.advance(30 * SEC);
    await stores.get('ROOM305')!.act('ROOM_REACHED');
    await settle();
    expect(label('ROOM305').action).toBe('PUZZLE_COMPLETE');
    await stores.get('ROOM305')!.act('PUZZLE_COMPLETE');
    await settle();
    expect(label('ROOM305').action).toBe('RETURN_START');
    expect(label('GATE').action).toBe('GAME_STOP');

    hub.advance(20 * SEC);
    await stores.get('GATE')!.act('GAME_STOP');
    await settle();
    expect(label('CORRIDOR').action).toBe('RESET_DONE');
    expect(label('ROOM305').action).toBe('RESET_DONE');
    expect(label('GATE').action).toBe(null); // waiting for the NPCs it does not own
    expect(label('LOBBY').action).toBe(null);

    await stores.get('CORRIDOR')!.act('RESET_DONE');
    await stores.get('ROOM305')!.act('RESET_DONE');
    await settle();
    expect(label('GATE').action).toBe('GATE_FINALIZE');

    await stores.get('GATE')!.act('GATE_FINALIZE');
    await settle();
    expect(label('LOBBY').action).toBe('CALL_TEAM');
    stores.forEach((s) => s.stop());
  });

  it('15. a reconnecting phone restores event time, game time and state', async () => {
    const hub = new TestHub();
    const sup = hub.client('supervisor');
    await sup.store.start();
    await settle();
    const gate = hub.client('gate');
    const lobby = hub.client('lobby');
    await gate.store.start();
    await lobby.store.start();

    await lobby.store.act('CALL_TEAM');
    await settle();
    hub.advance(50 * SEC);
    await gate.store.act('START_GAME');
    await settle();

    // GATE loses the network: it stops receiving hints
    gate.store.stop();
    hub.advance(70 * SEC);
    const supervisor = hub.client('supervisor');
    await supervisor.store.start();
    await supervisor.store.act('ROOM_REACHED');
    await settle();
    supervisor.store.stop();

    // reopening the app must recover from the server, not from local memory
    const gate2 = hub.client('gate');
    await gate2.store.start();
    const snap = gate2.store.getSnapshot().snapshot!;
    expect(snap.phase).toBe('RUNNING');
    expect(activeRound(snap)?.status).toBe('ROOM_REACHED');
    expect(snap.event.event_started_at).toBe(hub.snapshot().event.event_started_at);
    expect(Math.abs(gate2.store.serverNow() - hub.now())).toBeLessThan(50);
    const hero = resolveHero(snap, gate2.store.serverNow());
    expect(hero.mode).toBe('GAME');
    // 5:00 limit minus the 70 s already played = 230 s still on the official clock
    expect(Math.abs((hero.valueMs ?? 0) - 230 * SEC)).toBeLessThan(5 * SEC);
    gate2.store.stop();
  });

  it('stale phones are reconciled instead of being allowed to force a transition', async () => {
    const hub = new TestHub();
    const sup = hub.client('supervisor');
    const lobby = hub.client('lobby');
    const room = hub.client('room305');
    await sup.store.start();
    await lobby.store.start();
    await room.store.start();
    await lobby.store.act('CALL_TEAM');
    await settle();

    // ROOM305 holds a stale view (its subscription was dropped)
    room.store.stop();
    const fresh = hub.client('gate');
    await fresh.store.start();
    await fresh.store.act('START_GAME');
    await settle();

    const before = hub.snapshot().revision;
    const staleView = room.store.getSnapshot().snapshot!;
    expect(staleView.revision).toBeLessThan(before);
    const res = await room.store.act('ROOM_REACHED');
    expect(res?.code).toBe('STALE_REVISION');
    await settle();
    expect(room.store.getSnapshot().revision).toBe(hub.snapshot().revision);
    expect(room.store.getSnapshot().notice).toContain('đồng bộ lại');
    // ...and now the same action succeeds against the fresh revision
    const ok = await room.store.act('ROOM_REACHED');
    expect(ok?.ok).toBe(true);
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
    await clients[1].store.act('START_GAME');
    await settle();
    expect(hub.snapshot().revision).toBe(before + 2);
    // every other phone kept advancing while the sheet would be open
    expect(clients[3].store.getSnapshot().revision).toBe(before + 2);
    expect(clients[3].store.getSnapshot().snapshot?.phase).toBe('RUNNING');
    // reading the sheet data does not write anything
    const hero = resolveHero(clients[3].store.getSnapshot().snapshot!, clients[3].store.serverNow());
    expect(hero.mode).toBe('GAME');
    expect(hub.snapshot().revision).toBe(before + 2);
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
    await lobby.store.start();
    await lobby.store.act('CALL_TEAM');
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
  });

  it('double taps from one phone produce one server action', async () => {
    const hub = new TestHub();
    const sup = hub.client('supervisor');
    const lobby = hub.client('lobby');
    await sup.store.start();
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

  it('network failure never marks a state as done', async () => {
    const hub = new TestHub();
    const sup = hub.client('supervisor');
    await sup.store.start();
    const lobby = hub.client('lobby');
    await lobby.store.start();
    await lobby.store.act('CALL_TEAM');
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
    const sup = hub.client('supervisor');
    await sup.store.start();
    const lobby = hub.client('lobby', { failSnapshot: true });
    await lobby.store.start();
    expect(lobby.store.getSnapshot().status).toBe('OFFLINE');
    expect(lobby.store.getSnapshot().snapshot).toBeNull();
    expect(await lobby.store.act('CALL_TEAM')).toBeNull();
    expect(hub.snapshot().rounds).toHaveLength(0);
  });
});
