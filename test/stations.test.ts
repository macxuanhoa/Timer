import { describe, expect, it } from 'vitest';
import { resolveStations } from '../src/client/selectors';
import { TestHub, SEC } from './helpers/harness';

/** Role of every chip currently lit on the handoff strip. */
function active(hub: TestHub): string[] {
  return resolveStations(hub.snapshot(), hub.now()).filter((s) => s.state === 'active').map((s) => s.role);
}

/** Role of every chip currently ringed as "your turn to press". */
function turn(hub: TestHub): string[] {
  return resolveStations(hub.snapshot(), hub.now()).filter((s) => s.turn).map((s) => s.role);
}

describe('station relay — exactly one leg lit at a time', () => {
  it('lights LOBBY before the first call, and GATE only after it', () => {
    const hub = new TestHub();

    // Nothing has run yet: LOBBY calls the first team.
    expect(active(hub)).toEqual(['LOBBY']);
    expect(turn(hub)).toEqual(['LOBBY']);

    hub.command('lobby', 'CALL_TEAM');
    hub.advance(20 * SEC);

    // The team is walking up: LOBBY stays lit and confirms the arrival at the door,
    // and the 5:00 stays NPC 1's to start.
    expect(active(hub)).toEqual(['LOBBY']);
    expect(turn(hub)).toContain('LOBBY');
    expect(turn(hub)).toContain('GATE');
  });

  it('hands the single green chip from LOBBY to NPC 1 the moment the 5:00 starts', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(30 * SEC);
    hub.command('gate', 'START_GAME');

    expect(active(hub)).toEqual(['GATE']);
    expect(active(hub)).not.toContain('LOBBY');
    expect(active(hub)).not.toContain('SUPERVISOR');
    // GATE holds the only official clock, so it also owns the stop button.
    expect(turn(hub)).toContain('GATE');
  });

  it('moves the lit chip through NPC 2 and NPC 3 as the team walks the route', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(20 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(20 * SEC);

    hub.command('corridor', 'HALLWAY_PROGRESS');
    expect(active(hub)).toEqual(['CORRIDOR']);

    hub.command('room305', 'ROOM_REACHED');
    expect(active(hub)).toEqual(['ROOM305']);

    hub.command('room305', 'PUZZLE_COMPLETE');
    expect(active(hub)).toEqual(['ROOM305']);
  });

  it('lights every station that still owes a reset task, then returns to LOBBY', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(20 * SEC);
    hub.command('gate', 'START_GAME');
    hub.advance(40 * SEC);
    hub.command('room305', 'ROOM_REACHED');
    hub.command('gate', 'GAME_STOP');

    const during = active(hub);
    // Reset is the only parallel window: the two area stations always owe a task.
    expect(during).toContain('CORRIDOR');
    expect(during).toContain('ROOM305');
    expect(during).not.toContain('LOBBY');
    expect(during).not.toContain('SUPERVISOR');

    hub.command('corridor', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    if (hub.snapshot().event.config.hidden_object_owner === 'GATE') hub.command('gate', 'RESET_DONE');
    hub.command('gate', 'GATE_FINALIZE');

    // The area is clear: the next team is LOBBY's to admit again.
    expect(active(hub)).toEqual(['LOBBY']);
  });

  it('keeps the supervisor off the strip unless the round was aborted', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(10 * SEC);
    hub.command('gate', 'START_GAME');
    expect(active(hub)).not.toContain('SUPERVISOR');
  });
});
