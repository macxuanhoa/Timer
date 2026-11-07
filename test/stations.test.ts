import { describe, expect, it } from 'vitest';
import { resolveStations } from '../src/client/selectors';
import { TestHub, SEC } from './helpers/harness';

/** Role of every chip currently lit on the handoff strip. */
function active(hub: TestHub): string[] {
  return resolveStations(hub.snapshot(), hub.now()).filter((s) => s.state === 'active').map((s) => s.role);
}

/** Role of every chip currently ringed as “your turn to press”. */
function turn(hub: TestHub): string[] {
  return resolveStations(hub.snapshot(), hub.now()).filter((s) => s.turn).map((s) => s.role);
}

/**
 * The strip is the one place all four phones read the same handoff. Exactly one leg
 * is lit at a time, except during the reset window, where the outstanding physical
 * checks genuinely run in parallel.
 */
describe('station relay — exactly one leg lit at a time', () => {
  it('lights OPERATOR 01 before the first reception', () => {
    const hub = new TestHub();
    expect(active(hub)).toEqual(['LOBBY']);
    expect(turn(hub)).toEqual(['LOBBY']);
  });

  it('moves the chip to OPERATOR 02 while the team climbs, without starting the clock', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(20 * SEC);
    // The team is on the second-floor leg: 01 has finished, 02 has not confirmed yet.
    expect(active(hub)).toEqual(['CORRIDOR']);
    // 02 must confirm, and NPC 1 still holds the documented bypass for this phase.
    expect(turn(hub)).toEqual(['CORRIDOR', 'GATE']);
    expect(turn(hub)).not.toContain('LOBBY');
  });

  it('hands the single lit chip to NPC 1 at the floor-3 entrance', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.advance(30 * SEC);
    hub.command('corridor', 'CONFIRM_FLOOR2');
    expect(active(hub)).toEqual(['GATE']);
    expect(turn(hub)).toEqual(['GATE']);
    hub.command('gate', 'START_GAME');
    // The game itself belongs to the room, so the chip follows the guests.
    expect(active(hub)).toEqual(['ROOM305']);
    expect(turn(hub)).toEqual(['ROOM305']);
  });

  it('keeps OPERATOR 01 and 02 off the strip for the whole countdown', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(120 * SEC);
    expect(active(hub)).toEqual(['ROOM305']);
    expect(turn(hub)).toEqual(['ROOM305']);
    // Expiry with an open claim: NPC 2 must judge it and NPC 1 may let the team out.
    hub.command('room305', 'CLAIM_COMPLETE');
    hub.advance(181 * SEC);
    expect(active(hub)).toEqual(['ROOM305']);
    expect(turn(hub)).toEqual(['GATE', 'ROOM305']);
  });

  it('follows the team out to NPC 1, then lights the parallel reset checks', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    hub.advance(301 * SEC);
    expect(active(hub)).toEqual(['GATE']);
    expect(turn(hub)).toEqual(['GATE']);

    hub.command('gate', 'CONFIRM_EXIT');
    const during = active(hub);
    expect(during).toContain('GATE');
    expect(during).toContain('ROOM305');
    expect(during).not.toContain('LOBBY');
    expect(during).not.toContain('CORRIDOR');

    hub.command('gate', 'RESET_DONE');
    expect(active(hub)).toEqual(['ROOM305']);
    hub.command('room305', 'RESET_DONE');
    hub.command('gate', 'GATE_FINALIZE');
    // The area is clear: the next team is OPERATOR 01's to receive again.
    expect(active(hub)).toEqual(['LOBBY']);
    expect(turn(hub)).toEqual(['LOBBY']);
  });

  it('renders exactly the four floor positions, never the admin or the viewer', () => {
    const hub = new TestHub();
    const strip = resolveStations(hub.snapshot(), hub.now());
    expect(strip.map((s) => s.role)).toEqual(['LOBBY', 'CORRIDOR', 'GATE', 'ROOM305']);
    expect(strip.map((s) => s.label)).toEqual(['01 · SẢNH', '02 · TẦNG 2', 'Nhân sự 03', 'Nhân sự 04']);
  });
});
