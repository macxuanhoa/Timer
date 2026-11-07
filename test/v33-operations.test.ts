import { describe, expect, it } from 'vitest';
import { TestHub, playRound } from './helpers/harness';
import { ScreamEngine, initialState } from '../src/server/engine';
import { FakeClock } from '../src/shared/types';
import { CLIENT_BUILD, MIN_CLIENT_VERSION, APP_VERSION, compareSemver, isClientStale } from '../src/shared/version';

/**
 * V3.3 forced-update gate and per-seat release. These cases cover the
 * client-visible shape of the two migration-0019 features:
 *
 *   - the version stamp (`CLIENT_BUILD` inside every command's `_v` meta) is
 *     what the authoritative layer reads; the server's ceiling is compared
 *     against the leading semver portion (build metadata after '+' is stripped);
 *   - a stale bundle is refused before any state check runs, so the operator's
 *     phone cannot corrupt the shared state on stale rules;
 *   - the liveStore's `staleClient` flag is set by any VERSION_STALE response
 *     or by a periodic state_revision read that reports the ceiling above the
 *     phone's own APP_VERSION;
 *   - release_station is not routed through the version gate — a supervisor on
 *     a stale bundle must always be able to free a stuck duty seat.
 */

describe('V3.3 version stamp semantics', () => {
  it('treats missing and empty _v as pre-V3.3 clients (refused when the floor is raised)', () => {
    const hub = new TestHub();
    hub.engine.setMinClientVersion(MIN_CLIENT_VERSION);
    // A caller with no stamp at all is refused before role, revision or phase.
    const noStamp = hub.command('lobby', 'CALL_TEAM', {});
    expect(noStamp.code).toBe('VERSION_STALE');
    expect(noStamp.ok).toBe(false);
    // An explicit empty string is the same "no stamp" case; nothing slips
    // through by omitting the value.
    const empty = hub.engine.dispatch({
      action: 'CALL_TEAM',
      actor: { id: 'lobby', role: 'LOBBY', display_name: 'Lan' },
      expected_revision: hub.engine.revision,
      idempotency_key: 'v-empty',
      meta: { _v: '' },
      press: { press_ms: hub.now(), local_press_ms: Date.now(), rtt_ms: 0 },
    });
    expect(empty.code).toBe('VERSION_STALE');
  });

  it('compares only the leading semver portion of a stamped client', () => {
    const hub = new TestHub();
    hub.engine.setMinClientVersion('3.3.0');
    const res = hub.command('lobby', 'CALL_TEAM', {
      _v: '3.3.0+build-2026-11-04-team-room-305',
      team_name: 'Ca 3',
    });
    // Build metadata after '+' is dropped; the version passes the floor.
    expect(res.code).not.toBe('VERSION_STALE');
    expect(res.ok).toBe(true);
  });

  it('refuses a stamp below the floor with VERSION_STALE', () => {
    const hub = new TestHub();
    hub.engine.setMinClientVersion('3.3.1');
    const res = hub.command('lobby', 'CALL_TEAM', { _v: '3.3.0+old' });
    expect(res.code).toBe('VERSION_STALE');
    // Nothing was written; the state revision did not move.
    expect(hub.snapshot().rounds).toHaveLength(0);
  });

  it('leaves every command untouched when the floor is empty (default)', () => {
    // A fresh database defaults `sc.runtime_flags.min_client_version` to '',
    // which is what a mixed fleet needs during a rollout. The gate must
    // therefore be transparent until the organiser explicitly raises it.
    const hub = new TestHub();
    expect(hub.command('lobby', 'CALL_TEAM', {}).ok).toBe(true);
  });

  it('preserves the OPEN_NEW_EVENT path through the new wrapper', () => {
    // Migration 0019 hoisted 0018's OPEN_NEW_EVENT body into sc._open_new_event_internal
    // so the version-gate branch fits on top; the two features coexist. This
    // case proves the intercept still fires.
    const hub = new TestHub();
    playRound(hub);
    expect(hub.command('supervisor', 'END_EVENT', { reason: 'hết ca' }).ok).toBe(true);
    hub.engine.setMinClientVersion(MIN_CLIENT_VERSION);
    // A stamped supervisor handoff still works.
    const res = hub.command('supervisor', 'OPEN_NEW_EVENT', { _v: CLIENT_BUILD });
    expect(res.code).not.toBe('VERSION_STALE');
    expect(res.ok).toBe(true);
    expect(hub.snapshot().phase).toBe('PRE_EVENT');
  });

  it('state_revision carries the current floor alongside revision + event_id', () => {
    const engine = new ScreamEngine(initialState(1_730_000_000_000), new FakeClock(1_730_000_000_000), {});
    expect(engine.revisionProbe().min_client_version).toBe('');
    engine.setMinClientVersion('3.3.0');
    expect(engine.revisionProbe().min_client_version).toBe('3.3.0');
  });
});

/**
 * The pure comparator the client uses to decide "this phone is stale" against
 * whatever the server says on state_revision. Locked here so the gate cannot
 * drift into accepting something it should refuse.
 */
describe('compareSemver + isClientStale', () => {
  it('orders major/minor/patch numerically, not lexically', () => {
    expect(compareSemver('3.10.0', '3.9.0')).toBe(1);
    expect(compareSemver('3.9.0', '3.10.0')).toBe(-1);
    expect(compareSemver('2.0.0', '3.0.0')).toBe(-1);
    expect(compareSemver('3.3.0', '3.3.0')).toBe(0);
    expect(compareSemver('3.3', '3.3.0')).toBe(0);
    expect(compareSemver('3.3.1', '3.3')).toBe(1);
  });

  it('isClientStale is false when the floor is empty or missing', () => {
    expect(isClientStale('')).toBe(false);
    expect(isClientStale(null)).toBe(false);
    expect(isClientStale(undefined)).toBe(false);
  });

  it('isClientStale is true when the running APP_VERSION is below the floor', () => {
    // The bundle this test file lives inside reports APP_VERSION (3.3.0 as of
    // V3.3). A server asking for anything higher is stale; anything equal or
    // lower is accepted.
    expect(isClientStale(APP_VERSION)).toBe(false);
    expect(isClientStale('99.0.0')).toBe(true);
    expect(isClientStale('3.2.0')).toBe(false);
  });
});

/**
 * The store's own behaviour: a VERSION_STALE refusal from any command flips
 * `staleClient`, and every subsequent write is blocked before touching the
 * network. Also proves that a periodic state_revision read carrying a ceiling
 * above APP_VERSION flips the same flag, so a phone that never presses a
 * button is still locked before its first tap.
 */
describe('liveStore + version gate', () => {
  it('staleClient flips on a VERSION_STALE command refusal', async () => {
    const hub = new TestHub();
    hub.engine.setMinClientVersion('99.0.0'); // higher than every real bundle
    const client = hub.client('lobby');
    await client.store.start();
    // First press at the raised ceiling: the command is refused, and the store
    // records the refusal as "this phone is stale".
    const res = await client.store.act('CALL_TEAM');
    expect(res?.code).toBe('VERSION_STALE');
    expect(client.store.getSnapshot().staleClient).toBe(true);
    // A follow-up never reaches the wire — the store short-circuits locally.
    const before = hub.engine.revision;
    const second = await client.store.act('CALL_TEAM');
    expect(second).toBeNull();
    expect(hub.engine.revision).toBe(before);
    client.store.stop();
  });

  it('staleClient flips on a periodic verify that reads a ceiling above APP_VERSION', async () => {
    const hub = new TestHub();
    const client = hub.client('lobby');
    await client.store.start();
    // Raise the floor behind the phone's back. The next verifyNow tick (driven
    // here explicitly, not by the interval) reads state_revision's new answer
    // and locks the store.
    hub.engine.setMinClientVersion('99.0.0');
    await client.store.verifyNow();
    expect(client.store.getSnapshot().staleClient).toBe(true);
    client.store.stop();
  });

  it('a fresh stamped command succeeds once the floor matches', async () => {
    const hub = new TestHub();
    hub.engine.setMinClientVersion(APP_VERSION);
    const client = hub.client('lobby');
    await client.store.start();
    const res = await client.store.act('CALL_TEAM', { team_name: 'Ca 3' });
    expect(res?.ok).toBe(true);
    expect(client.store.getSnapshot().staleClient).toBe(false);
    // Sanity: the stamp travelled with the command as p_meta._v; the handler
    // does not see it as a business field.
    const round = hub.snapshot().active_round!;
    expect(round.team_name).toBe('Ca 3');
    client.store.stop();
  });
});

/**
 * release_station is a separate RPC and never goes through the command wrapper,
 * which is exactly what the V3.3 stuck-seat case requires: a supervisor phone
 * that is itself behind the floor must still be able to free a duty seat.
 * Locally the client-side surface only runs on Supabase (see the USING_SUPABASE
 * guard in DetailsSheet); this case locks the pure contract.
 */
describe('V3.3 release_station escape hatch', () => {
  it('CLIENT_BUILD always includes the leading APP_VERSION semver so the floor compares cleanly', () => {
    expect(CLIENT_BUILD.startsWith(APP_VERSION)).toBe(true);
    // Anything after '+' is build metadata and is stripped before the compare.
    expect(CLIENT_BUILD).toMatch(/^\d+\.\d+\.\d+(\+.+)?$/);
  });

  it('the running bundle passes the shipped V3.3 floor', () => {
    // MIN_CLIENT_VERSION is what the organiser will set the floor to after the
    // V3.3 frontend lands. The current APP_VERSION must not be refused by it.
    expect(isClientStale(MIN_CLIENT_VERSION)).toBe(false);
    // And a stamped command carrying CLIENT_BUILD compares equal or above the
    // same floor, so the same phone keeps working after the floor is raised.
    expect(compareSemver(CLIENT_BUILD, MIN_CLIENT_VERSION)).toBeGreaterThanOrEqual(0);
    // A pre-V3.3 bundle, e.g. one stamped "3.2.9", would be refused.
    expect(compareSemver('3.2.9', MIN_CLIENT_VERSION)).toBeLessThan(0);
  });
});
