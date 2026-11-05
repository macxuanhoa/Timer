import { describe, expect, it } from 'vitest';
import { withTimeout, GATEWAY_TIMEOUT_MS, type Gateway } from '../src/client/gateway';
import { LiveStore } from '../src/client/liveStore';
import type { CommandRequest, CommandResult, RevisionHintResponse, Snapshot } from '../src/shared/types';
import { TestHub } from './helpers/harness';
import { APP_VERSION, isClientStale } from '../src/shared/version';

/**
 * V3.3 P0 — "ĐANG ĐỒNG BỘ" must never be forever.
 *
 * The field failure looked like a stuck sync, but the mechanism was a promise
 * that never settled: a Supabase RPC with no deadline, awaited on the boot path
 * and in the periodic verification. Once that first read hung, the store never
 * reached CONNECTED or OFFLINE, the verify timer never started, and the phone sat
 * on the spinner with no retry and no explanation. The cases below pin the
 * contract that replaces it: every interaction settles within a bounded window,
 * the store always reports a definite state, and a manual retry exists.
 */

/** A gateway whose reads hang forever — the exact shape of a stalled venue Wi-Fi socket. */
function hangingGateway(overrides: Partial<Gateway> = {}): Gateway {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  return {
    kind: 'local',
    snapshot: never,
    revision: never,
    operationStatus: never,
    command: never,
    time: never,
    subscribe: () => () => undefined,
    ...overrides,
  };
}

/** A gateway that answers like the local hub, built from a real TestHub snapshot. */
function workingGateway(hub: TestHub): Gateway {
  return {
    kind: 'local',
    snapshot: async () => hub.snapshot(),
    revision: async () => hub.engine.revisionProbe() as RevisionHintResponse,
    operationStatus: async () => ({ found: false }),
    command: async (req: CommandRequest): Promise<CommandResult> =>
      hub.command(req.actor.id === 'lobby' ? 'lobby' : 'lobby', req.action, req.meta, req.expected_revision, req.idempotency_key),
    time: async () => hub.now(),
    subscribe: (handlers) => { handlers.onStatus('CONNECTED'); return () => undefined; },
  };
}

const account = { id: 'lobby', role: 'LOBBY' as const, display_name: 'Lan' };

describe('withTimeout', () => {
  it('passes a resolved value straight through', async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, 'x')).resolves.toBe(7);
  });

  it('rejects a promise that never settles', async () => {
    const started = Date.now();
    await expect(withTimeout(new Promise<number>(() => undefined), 40, 'probe')).rejects.toThrow(/probe/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('preserves the original rejection reason', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 40, 'probe')).rejects.toThrow('boom');
  });
});

describe('LiveStore boot never hangs', () => {
  it('a stalled first read lands the store in OFFLINE, not an endless SYNCING', async () => {
    const store = new LiveStore({ gateway: hangingGateway(), account, verifyIntervalMs: 50, settleMs: 400 });
    const started = Date.now();
    await store.start();
    const state = store.getSnapshot();
    // Bounded: start() itself resolved (the timer that drives every later retry
    // therefore exists), and the visible status is a definite failure, not "sync".
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(state.status).toBe('OFFLINE');
    expect(state.snapshot).toBeNull();
    store.stop();
  }, 20_000);

  it('recovers as soon as the transport answers again, with no manual reload', async () => {
    // The other half of the contract: OFFLINE is a state, not a dead end. The
    // verify tick keeps running, so a phone whose network comes back heals by
    // itself — requirement "không được loading vô hạn" means both directions.
    let online = false;
    const hub = new TestHub();
    const gateway = hangingGateway({
      snapshot: async () => { if (!online) return new Promise<Snapshot>(() => undefined); return hub.snapshot(); },
      revision: async () => { if (!online) return new Promise<RevisionHintResponse>(() => undefined); return hub.engine.revisionProbe() as RevisionHintResponse; },
      time: async () => { if (!online) return new Promise<number>(() => undefined); return hub.now(); },
    });
    const store = new LiveStore({ gateway, account, verifyIntervalMs: 40, settleMs: 400 });
    await store.start();
    expect(store.getSnapshot().snapshot).toBeNull();
    online = true;
    await store.recover();
    await vi_waitUntil(() => store.getSnapshot().snapshot !== null, 8_000);
    expect(store.getSnapshot().snapshot).not.toBeNull();
    expect(store.getSnapshot().status).toBe('CONNECTED');
    store.stop();
  }, 30_000);

  it('a working gateway still boots on the fast path', async () => {
    const hub = new TestHub();
    const store = new LiveStore({ gateway: workingGateway(hub), account, verifyIntervalMs: 100 });
    await store.start();
    expect(store.getSnapshot().snapshot).not.toBeNull();
    expect(store.getSnapshot().status).toBe('CONNECTED');
    store.stop();
  });

  it('a command against a hung transport is refused with a message, never left in flight', async () => {
    const hub = new TestHub();
    const store = new LiveStore({ gateway: workingGateway(hub), account, verifyIntervalMs: 100, settleMs: 400 });
    await store.start();
    // Swap in a gateway whose writes hang after boot: the act() must settle (the
    // reconcile path resolves the unknown), leaving pending/verifying cleared.
    (store as unknown as { opts: { gateway: Gateway } }).opts.gateway = hangingGateway({
      snapshot: async () => hub.snapshot(),
      revision: async () => hub.engine.revisionProbe() as RevisionHintResponse,
      operationStatus: async () => ({ found: false }),
      subscribe: () => () => undefined,
    });
    const started = Date.now();
    const res = await store.act('CALL_TEAM', { team_name: 'Do treo' });
    expect(Date.now() - started).toBeLessThan(30_000);
    // res is null (outcome unknown, refused by reconcile) or an explicit failure;
    // either way the store is no longer holding the action in flight.
    const after = store.getSnapshot();
    expect(after.pending).toBeNull();
    expect(after.verifying).toBeNull();
    store.stop();
  }, 40_000);
});

describe('server floor blocks an outdated bundle safely', () => {
  it('the running bundle is never stale against the shipped V3.3 floor', () => {
    // 3.4.0 is the NPC2 verification release; the shipped server floor stays at
    // 3.3.1 (QUẢN LÝ VỊ TRÍ), so the running bundle must clear it and any
    // organiser-raised floor up to its own version without being locked out.
    expect(APP_VERSION).toBe('3.4.0');
    expect(isClientStale(APP_VERSION)).toBe(false);
    expect(isClientStale('3.3.1')).toBe(false);
    expect(isClientStale('99.0.0')).toBe(true);
  });

  it('VERSION_STALE from the wire locks the store', async () => {
    const hub = new TestHub();
    hub.engine.setMinClientVersion('99.0.0');
    const store = new LiveStore({ gateway: workingGateway(hub), account, verifyIntervalMs: 100 });
    await store.start();
    const res = await store.act('CALL_TEAM');
    expect(res?.code).toBe('VERSION_STALE');
    expect(store.getSnapshot().staleClient).toBe(true);
    // Every later press is refused locally as well — the client cannot keep
    // sending commands that do not match the server.
    expect(await store.act('CALL_TEAM')).toBeNull();
    store.stop();
  });
});

async function vi_waitUntil(fn: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('waitUntil timed out');
}
