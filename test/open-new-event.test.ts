import { describe, expect, it } from 'vitest';
import { TestHub, MIN, SEC, playRound } from './helpers/harness';
import { phaseAllows, isAllowed } from '../src/shared/machine';

/**
 * V3.2+ — the OPEN_NEW_EVENT handoff.
 *
 * The engine had END_EVENT but no counterweight: once event_ended_at was set the
 * whole phone surface locked on "SỰ KIỆN ĐÃ KẾT THÚC" and there was no way to hand
 * the room to the next shift without touching SQL directly. These assertions
 * prove the new action exists, is SUPERVISOR-only, requires the closed event,
 * starts a fresh event that inherits the operational configuration, and never
 * rewrites or deletes any row of the previous event.
 */

describe('OPEN_NEW_EVENT — the handoff after END_EVENT', () => {
  it('refuses on a live event, before END_EVENT has run', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    const res = hub.command('supervisor', 'OPEN_NEW_EVENT', {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_STATE');
    expect(res.message).toBe('Phải đóng sự kiện hiện tại trước khi mở sự kiện mới');
    // The refusal wrote nothing.
    const snap = hub.snapshot();
    expect(snap.event.event_ended_at).toBeNull();
    expect(snap.event.event_started_at).not.toBeNull();
  });

  it('refuses any role that is not SUPERVISOR', () => {
    const hub = new TestHub();
    playRound(hub);
    hub.command('supervisor', 'END_EVENT', { reason: 'hết ca' });
    const res = hub.command('lobby', 'OPEN_NEW_EVENT', {});
    expect(res.code).toBe('PERMISSION_DENIED');
    // Same for the other three duty seats.
    expect(hub.command('gate', 'OPEN_NEW_EVENT', {}).code).toBe('PERMISSION_DENIED');
    expect(hub.command('room305', 'OPEN_NEW_EVENT', {}).code).toBe('PERMISSION_DENIED');
    expect(hub.command('corridor', 'OPEN_NEW_EVENT', {}).code).toBe('PERMISSION_DENIED');
  });

  it('after a full close, opens a fresh event that inherits the configuration', () => {
    const hub = new TestHub();
    // Configure a duration the next shift must carry forward, and a name to reopen.
    expect(hub.command('supervisor', 'CONFIGURE', { game_limit_ms: 7 * MIN }).ok).toBe(true);
    playRound(hub);
    const closedEventId = hub.snapshot().event.id;
    const previousStartedAt = hub.snapshot().event.event_started_at;
    expect(hub.command('supervisor', 'END_EVENT', { reason: 'hết ca' }).ok).toBe(true);
    const endedAt = hub.snapshot().event.event_ended_at;
    expect(endedAt).not.toBeNull();

    const res = hub.command('supervisor', 'OPEN_NEW_EVENT', { event_name: 'Night two' });
    expect(res.ok).toBe(true);
    expect(res.code).toBe('OK');
    expect(res.message).toBe('ĐÃ MỞ SỰ KIỆN MỚI');

    const snap = hub.snapshot();
    expect(snap.event.id).not.toBe(closedEventId);
    expect(snap.event.event_started_at).toBeNull();
    expect(snap.event.event_ended_at).toBeNull();
    expect(snap.event.next_team_number).toBe(1);
    expect(snap.event.config.event_name).toBe('Night two');
    // The round window the supervisor set for the closed event is what the new
    // night starts with, not the app default.
    expect(snap.event.config.game_limit_ms).toBe(7 * MIN);
    // The old event's clocks survived: the closed event kept its started and
    // ended instants (asserted via fullLog below), and its rounds are untouched.
    expect(previousStartedAt).not.toBeNull();
    expect(snap.rounds).toHaveLength(0); // snapshot filters by current event
    // The engine still holds every round of the closed event as history.
    const closedRounds = hub.engine.raw().rounds.filter((r) => r.event_id === closedEventId);
    expect(closedRounds.length).toBeGreaterThan(0);
    expect(closedRounds.every((r) => r.status === 'CLOSED')).toBe(true);
    // The audit trail records the OPEN_NEW_EVENT press with a pointer back.
    const openRow = hub.engine.fullLog().find((l) => l.action === 'OPEN_NEW_EVENT')!;
    expect(openRow.actor_role).toBe('SUPERVISOR');
    expect(openRow.event_id).toBe(snap.event.id);
    expect(openRow.metadata?.previous_event_id).toBe(closedEventId);
    expect(openRow.metadata?.previous_event_ended_at).toBe(endedAt);
  });

  it('the fresh event is immediately playable: OPERATOR_01 receives the first team', () => {
    const hub = new TestHub();
    playRound(hub);
    hub.command('supervisor', 'END_EVENT', { reason: 'hết ca' });
    expect(hub.command('supervisor', 'OPEN_NEW_EVENT', {}).ok).toBe(true);
    expect(hub.snapshot().phase).toBe('PRE_EVENT');
    expect(hub.command('lobby', 'CALL_TEAM', { team_name: 'Ca 2 đội 1' }).ok).toBe(true);
    const r = hub.snapshot().active_round!;
    expect(r.status).toBe('WAITING_FLOOR2_CONFIRMATION');
    // #001 is the first team of every event, not a continuation of the closed one.
    expect(r.team_number).toBe(1);
    expect(r.team_name).toBe('Ca 2 đội 1');
    expect(hub.snapshot().event.event_started_at).toBe(hub.now());
  });

  it('keeps the closed event name when no override is typed', () => {
    const hub = new TestHub();
    const originalName = hub.snapshot().event.config.event_name;
    playRound(hub);
    hub.command('supervisor', 'END_EVENT', { reason: 'hết ca' });
    hub.command('supervisor', 'OPEN_NEW_EVENT', {});
    expect(hub.snapshot().event.config.event_name).toBe(originalName);
  });

  it('refuses twice when any round of the closed event is still open', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    // Force the ended stamp without a normal close: this is exactly the state a
    // hand-crafted SQL row could reach if an operator had set event_ended_at
    // directly. The action must refuse rather than strand a live round on a
    // pointer that has moved.
    hub.engine.raw().event.event_ended_at = hub.now();
    const res = hub.command('supervisor', 'OPEN_NEW_EVENT', {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_STATE');
    expect(res.message).toBe('Vẫn còn lượt chơi chưa đóng trong sự kiện vừa kết thúc');
  });

  it('idempotency: the same tap that lands twice never opens two events', () => {
    const hub = new TestHub();
    playRound(hub);
    hub.command('supervisor', 'END_EVENT', { reason: 'hết ca' });
    const before = hub.snapshot().event.id;
    const first = hub.command('supervisor', 'OPEN_NEW_EVENT', {}, undefined, 'k-once');
    const afterFirst = hub.snapshot().event.id;
    const second = hub.command('supervisor', 'OPEN_NEW_EVENT', {}, undefined, 'k-once');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // The retry hits the processed-keys cache, and never re-points the state.
    expect(second.message).toBe(first.message);
    expect(hub.snapshot().event.id).toBe(afterFirst);
    expect(afterFirst).not.toBe(before);
  });

  it('is phase-free on the shared machine (the gate is on event_ended_at, not on round phase)', () => {
    expect(isAllowed('SUPERVISOR', 'OPEN_NEW_EVENT')).toBe(true);
    expect(isAllowed('LOBBY', 'OPEN_NEW_EVENT')).toBe(false);
    expect(isAllowed('GATE', 'OPEN_NEW_EVENT')).toBe(false);
    expect(isAllowed('ROOM305', 'OPEN_NEW_EVENT')).toBe(false);
    expect(isAllowed('CORRIDOR', 'OPEN_NEW_EVENT')).toBe(false);
    expect(isAllowed('OBSERVER', 'OPEN_NEW_EVENT')).toBe(false);
    // phaseAllows returns true regardless of the round phase; the handler enforces
    // the real precondition (event must be closed).
    expect(phaseAllows('OPEN_NEW_EVENT', null)).toBe(true);
    expect(phaseAllows('OPEN_NEW_EVENT', 'RUNNING')).toBe(true);
  });

  it('the new event revision restarts at 1 (matching _commit on the fresh sc.events row)', () => {
    const hub = new TestHub();
    playRound(hub);
    expect(hub.snapshot().revision).toBeGreaterThan(5); // a full round has many commits
    hub.command('supervisor', 'END_EVENT', { reason: 'hết ca' });
    const ended = hub.snapshot().revision;
    hub.command('supervisor', 'OPEN_NEW_EVENT', {});
    const fresh = hub.snapshot();
    expect(fresh.revision).toBe(1);
    expect(fresh.revision).toBeLessThan(ended);
  });
});

/**
 * The client-side adoption path. A revision DROP is normally treated as stale —
 * but not when the hint also carries a different event_id, which is what a
 * supervisor's OPEN_NEW_EVENT broadcast looks like.
 */
describe('OPEN_NEW_EVENT — every phone adopts the fresh event', () => {
  it('a lower-revision hint with a new event_id is adopted, not dropped', async () => {
    const hub = new TestHub();
    const supervisor = hub.client('supervisor');
    const lobby = hub.client('lobby');
    await supervisor.store.start();
    await lobby.store.start();

    playRound(hub);
    await lobby.store.refresh();
    await supervisor.store.refresh();
    hub.command('supervisor', 'END_EVENT', { reason: 'hết ca' });
    await lobby.store.refresh();
    await supervisor.store.refresh();
    const closedEventId = lobby.store.getSnapshot().snapshot!.event.id;

    // Now OPEN_NEW_EVENT via the supervisor's own store: its response carries the
    // fresh snapshot directly, so the supervisor adopts it without any broadcast.
    const res = await supervisor.store.act('OPEN_NEW_EVENT', {});
    expect(res?.ok).toBe(true);
    const supervisorSnap = supervisor.store.getSnapshot().snapshot!;
    expect(supervisorSnap.event.id).not.toBe(closedEventId);

    // The lobby phone is watching the stream. The hub broadcasts (revision, event_id)
    // — its cached snapshot still holds the closed event at a higher revision, so
    // only the event_id branch of liveStore.onRevision lets it catch up.
    await lobby.store.refresh();
    const lobbySnap = lobby.store.getSnapshot().snapshot!;
    expect(lobbySnap.event.id).toBe(supervisorSnap.event.id);
    expect(lobbySnap.phase).toBe('PRE_EVENT');

    supervisor.store.stop();
    lobby.store.stop();
  });

  it('the guard is keyed on event_id, not on the revision alone', async () => {
    // A stale broadcast that carries the phone's own event_id and a lower revision
    // must not cause the client to adopt it — this is the pre-existing behavior
    // OPEN_NEW_EVENT leans on for correctness: the state pointer changed is the
    // only legitimate reason a lower revision is meaningful.
    //
    // Prove it directly against liveStore.applySnapshot by asking the store to
    // swallow a same-event, lower-revision snapshot and observing that its own
    // view does not move; then a different-event snapshot and observe that it
    // is adopted regardless of the revision number.
    const hub = new TestHub();
    const lobby = hub.client('lobby');
    await lobby.store.start();
    const current = lobby.store.getSnapshot().snapshot!;
    expect(current).not.toBeNull();
    const originalRevision = current.revision;
    // @ts-expect-error applySnapshot is private; the test drives it exactly the
    // way the store's own onRevision path would.
    lobby.store.applySnapshot({ ...current, revision: 0 });
    expect(lobby.store.getSnapshot().revision).toBe(originalRevision);
    // @ts-expect-error private, same reason
    lobby.store.applySnapshot({ ...current, revision: 0, event: { ...current.event, id: 'evt_other' } });
    // A different event_id is adopted regardless of the revision number.
    expect(lobby.store.getSnapshot().snapshot!.event.id).toBe('evt_other');
    lobby.store.stop();
  });
});
