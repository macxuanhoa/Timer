import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHub, devAccounts } from '../src/server/hub';
import { MemoryStore } from '../src/server/store';
import { FakeClock } from '../src/shared/types';
import { LocalGateway } from '../src/client/gateway';
import { LiveStore } from '../src/client/liveStore';
import type { Role } from '../src/shared/constants';
import type { StoredSession } from '../src/ui/session';

/**
 * Real transport test: five LiveStore instances over genuine HTTP + SSE against
 * the authoritative engine, with the same Node process acting as the server.
 * Synchronisation latency below is measured, not assumed.
 */
let server: Server;
let baseUrl = '';
/** The authoritative clock for this harness. It is a FakeClock on purpose, so a
 *  test can step the server's notion of time; it therefore does NOT follow
 *  Date.now(). Any assertion about the client's clock estimate has to compare
 *  against this clock, never against the wall clock. */
let clock: FakeClock;
const stores = new Map<Role, LiveStore>();
const tokens = new Map<Role, string>();
/** Filled by the convergence test; reported, never invented. */
export const measured = { p50: 0, p95: 0, p99: 0, max: 0, samples: 0 };

async function loginAs(accountId: string, passcode: string): Promise<StoredSession> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: accountId, passcode }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (await res.json()) as StoredSession;
}

async function connect(role: Role, session: StoredSession): Promise<LiveStore> {
  const gateway = new LocalGateway({ token: session.token, baseUrl });
  const store = new LiveStore({ gateway, account: session.account });
  await store.start();
  stores.set(role, store);
  return store;
}

/**
 * Walks whatever round is currently on the floor to a closed state, so a later case
 * starts from a clean area. Uses NPC1's guarded early exit rather than waiting out
 * the 300 s, which is exactly the path an operator would take between teams.
 */
async function clearFloor(): Promise<void> {
  for (let step = 0; step < 12; step++) {
    const lobby = stores.get('LOBBY')!;
    await lobby.refresh();
    const round = lobby.getSnapshot().snapshot?.active_round;
    if (!round) return;
    const press = async (role: Role, action: Parameters<LiveStore['act']>[0], meta?: Record<string, unknown>) => {
      await stores.get(role)!.refresh();
      await stores.get(role)!.act(action, meta);
    };
    switch (round.status) {
      case 'WAITING_FLOOR2_CONFIRMATION':
        await press('CORRIDOR', 'CONFIRM_FLOOR2');
        break;
      case 'READY_AT_FLOOR3':
        await press('GATE', 'START_GAME');
        break;
      case 'RUNNING':
        await press('GATE', 'EARLY_EXIT', { reason: 'Dọn sàn giữa hai ca' });
        break;
      case 'WAITING_FOR_EXIT':
      case 'TIME_EXPIRED_PENDING_VALIDATION':
        await press('GATE', 'CONFIRM_EXIT');
        break;
      case 'EXIT_CONFIRMED':
        await press('GATE', 'RESET_DONE');
        await press('ROOM305', 'RESET_DONE');
        await press('GATE', 'GATE_FINALIZE');
        break;
      default:
        return;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('clearFloor could not close the active round');
}

/** Refreshes first, then presses, so a fast sequence never races its own view. */
async function press(role: Role, action: Parameters<LiveStore['act']>[0], meta?: Record<string, unknown>): Promise<boolean> {
  const store = stores.get(role)!;
  await store.refresh();
  const res = await store.act(action, meta);
  return Boolean(res?.ok);
}

beforeAll(async () => {
  clock = new FakeClock(Date.now());
  const hub = createHub({ store: new MemoryStore(), allowTestClock: true, clock });
  server = createServer(hub.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const accounts = devAccounts();
  for (const account of accounts) {
    const session = await loginAs(account.id, account.secret);
    tokens.set(account.role, session.token);
    await connect(account.role, session);
  }
});

afterAll(() => {
  for (const store of stores.values()) store.stop();
  server?.closeAllConnections?.();
  server?.close();
});

describe('PASS 4 — real HTTP synchronisation between the phones', () => {
  it('authenticates every seat without a passcode, and refuses only unknown accounts', async () => {
    const anonymous = await fetch(`${baseUrl}/api/snapshot`);
    expect(anonymous.status).toBe(401);
    // V3.2: choosing a station IS the claim — no passcode is checked any more.
    const gate = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'gate' }),
    });
    expect(gate.status).toBe(200);
    // Only an account that does not exist is refused.
    const wrong = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'nobody' }),
    });
    expect(wrong.status).toBe(401);
    // The viewer seat is open: no passcode is the documented behaviour.
    const viewer = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'observer' }),
    });
    expect(viewer.status).toBe(200);
    const token = (await viewer.json()).token as string;
    const asViewer = await fetch(`${baseUrl}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } });
    const redacted = await asViewer.json();
    // A viewer sees the game, not the operating record.
    expect(redacted.redacted).toBe(true);
    expect(redacted.log).toEqual([]);
    expect(redacted.attempts).toEqual([]);
    expect(redacted.operators).toEqual([]);
    if (redacted.active_round) {
      expect(redacted.active_round.started_by).toBeNull();
      expect(redacted.active_round.review_reasons).toEqual([]);
    }
  });

  it('refuses every command from an observer over the wire', async () => {
    const viewer = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'observer', passcode: '' }),
    });
    const token = (await viewer.json()).token as string;
    const before = (await (await fetch(`${baseUrl}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } })).json()).revision;
    for (const action of ['CALL_TEAM', 'START_GAME', 'CLAIM_COMPLETE', 'CONFIRM_EXIT', 'GATE_FINALIZE']) {
      const res = await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action, expected_revision: before, idempotency_key: `viewer:${action}` }),
      });
      expect([401, 403, 409], `${action} → ${res.status}`).toContain(res.status);
    }
    const after = (await (await fetch(`${baseUrl}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } })).json()).revision;
    expect(after).toBe(before);
  });

  it('an observer seat is reused by the same viewer and freed only by an explicit leave', async () => {
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'observer', passcode: '' }),
    });
    const token = (await login.json()).token as string;
    const presence = async (path: 'join' | 'leave', viewer_id: string) => {
      const res = await fetch(`${baseUrl}/api/observer/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ viewer_id }),
      });
      return res.json() as Promise<{ ok: boolean; code: string; devices: number }>;
    };
    const first = await presence('join', 'seat-A');
    expect(first.ok).toBe(true);
    // The same browser coming back — a remount, a refresh, a return from the
    // full-room screen — renews its own seat instead of consuming a second one.
    const again = await presence('join', 'seat-A');
    expect(again.code).toBe('REUSED');
    expect(again.devices).toBe(first.devices);
    const second = await presence('join', 'seat-B');
    expect(second.devices).toBe(first.devices + 1);
    // Only a deliberate exit frees a seat, so an unanswered detach can never throw
    // a watching phone out of the ten seats it holds.
    const left = await presence('leave', 'seat-B');
    expect(left.devices).toBe(second.devices - 1);
    await presence('leave', 'seat-A');
  });

  it('rejects a command the role is not allowed to press', async () => {
    const lobby = stores.get('LOBBY')!;
    const res = await lobby.act('END_EVENT');
    expect(res?.code).toBe('PERMISSION_DENIED');
    const snap = await fetch(`${baseUrl}/api/snapshot`, { headers: { authorization: `Bearer ${tokens.get('LOBBY')}` } });
    expect((await snap.json()).event.event_started_at).toBeNull();
  });

  it('14b/15. five connected phones converge; propagation is measured (G01)', async () => {
    const supervisor = stores.get('SUPERVISOR')!;
    const lobby = stores.get('LOBBY')!;
    const observer = stores.get('OBSERVER')!;
    const readers = (['GATE', 'CORRIDOR', 'ROOM305'] as Role[]).map((r) => stores.get(r)!);
    const all = [supervisor, lobby, observer, ...readers];

    // Drive a full round and measure how long each *other* phone needs to apply
    // each committed revision. Loopback numbers, reported as measured.
    const claimId = () => {
      const snap = stores.get('ROOM305')!.getSnapshot().snapshot!;
      return snap.attempts[snap.attempts.length - 1]?.id ?? '';
    };
    const steps: [Role, 'CALL_TEAM' | 'CONFIRM_FLOOR2' | 'START_GAME' | 'CLAIM_COMPLETE' | 'VERIFY_ATTEMPT' | 'CONFIRM_EXIT' | 'RESET_DONE' | 'GATE_FINALIZE', () => Record<string, unknown>][] = [
      ['LOBBY', 'CALL_TEAM', () => ({ team_name: 'Do 1' })],
      ['CORRIDOR', 'CONFIRM_FLOOR2', () => ({})],
      ['GATE', 'START_GAME', () => ({})],
      ['ROOM305', 'CLAIM_COMPLETE', () => ({})],
      ['ROOM305', 'VERIFY_ATTEMPT', () => ({ attempt_id: claimId(), decision: 'VALID' })],
      ['GATE', 'CONFIRM_EXIT', () => ({})],
      ['GATE', 'RESET_DONE', () => ({})],
      ['ROOM305', 'RESET_DONE', () => ({})],
      ['GATE', 'GATE_FINALIZE', () => ({})],
    ];
    const lags: number[] = [];
    for (const [role, action, meta] of steps) {
      const store = stores.get(role)!;
      const target = store.getSnapshot().revision + 1;
      const ack = Date.now();
      const res = await store.act(action, meta());
      expect(res?.ok, `${action} failed: ${res?.message}`).toBe(true);
      const watchers = all.filter((s) => s !== store);
      for (const watcher of watchers) {
        await expect.poll(() => watcher.getSnapshot().revision, { timeout: 5000, interval: 2 }).toBe(target);
        lags.push(Date.now() - ack);
      }
    }
    const sorted = [...lags].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    console.info(
      `[measured] loopback HTTP+SSE propagation · n=${sorted.length} · p50=${pct(0.5)}ms p95=${pct(0.95)}ms p99=${pct(0.99)}ms max=${sorted.at(-1)}ms`,
    );
    measured.p50 = pct(0.5);
    measured.p95 = pct(0.95);
    measured.p99 = pct(0.99);
    measured.samples = sorted.length;
    measured.max = sorted.at(-1) ?? 0;
    // A generous ceiling that catches a broken pipeline, not a performance claim.
    expect(pct(0.95)).toBeLessThan(1500);

    const states = all.map((s) => s.getSnapshot().snapshot!);
    expect(new Set(states.map((s) => s.revision)).size).toBe(1);
    expect(states.every((s) => s.rounds.length === 1 && s.rounds[0].status === 'CLOSED')).toBe(true);
    expect(states.every((s) => s.rounds[0].official_duration_ms === states[0].rounds[0].official_duration_ms)).toBe(true);
  });

  it('G02. a committed action whose response is lost is reconciled, never duplicated', async () => {
    const lobby = stores.get('LOBBY')!;
    const gateway = new LocalGateway({ token: tokens.get('LOBBY')!, baseUrl });
    const before = lobby.getSnapshot().revision;
    const key = 'lost-response-1';
    // The server commits, then the reply is destroyed: the client truly cannot tell.
    const result = await gateway
      .command(
        {
          action: 'CALL_TEAM',
          actor: { id: 'lobby', role: 'LOBBY', display_name: 'Lan' },
          expected_revision: before,
          idempotency_key: key,
          meta: { team_name: 'Do 2' },
        },
        { dropResponseOnce: true },
      )
      .catch(() => null);
    expect(result).toBeNull();

    // The next attempt reuses the same operation identity and is resolved through
    // /api/operation instead of guessing an outcome.
    const reconciled = await lobby.act('CALL_TEAM', { team_name: 'Do 2' }, {
      dropAllResponses: true,
      idempotencyKey: key,
    });
    expect(reconciled?.ok).toBe(true);
    expect(reconciled?.message).toContain('đã xác minh');
    const snap = await gateway.snapshot();
    const teams2 = snap.rounds.filter((r) => r.team_name === 'Do 2');
    expect(teams2).toHaveLength(1); // never two teams from one intent
  });

  it('P0-01/R05. malformed and empty requests cannot take the engine down', async () => {
    const bodies = ['', '   ', 'not json at all', '[]', '"a string"', '{"account":', '{}'];
    for (const body of bodies) {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect([400, 401], `body ${JSON.stringify(body)} → ${res.status}`).toContain(res.status);
    }
    // an authenticated command with a garbage body is rejected per request
    const bad = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.get('LOBBY')}`, 'content-type': 'application/json' },
      body: '{oops',
    });
    expect(bad.status).toBe(400);
    // missing fields are rejected too, without touching state
    const revisionBefore = (await (await fetch(`${baseUrl}/api/snapshot`, { headers: { authorization: `Bearer ${tokens.get('LOBBY')}` } })).json()).revision;

    // still alive, still serving, credentials still work
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'gate', passcode: devAccounts().find((a) => a.id === 'gate')!.secret }),
    });
    expect(login.status).toBe(200);
    const snap = await fetch(`${baseUrl}/api/snapshot`, { headers: { authorization: `Bearer ${tokens.get('LOBBY')}` } });
    expect(snap.status).toBe(200);
    expect((await snap.json()).revision).toBe(revisionBefore);
  });

  it('P0-02. revision probe and operation status are authoritative over HTTP', async () => {
    const token = tokens.get('SUPERVISOR')!;
    const probe = await (await fetch(`${baseUrl}/api/revision`, { headers: { authorization: `Bearer ${token}` } })).json() as {
      revision: number; event_id: string; server_now_ms: number;
    };
    expect(probe.revision).toBe(stores.get('SUPERVISOR')!.getSnapshot().revision);
    expect(typeof probe.event_id).toBe('string');
    // Against the authoritative clock, not Date.now(): the harness clock is a
    // frozen FakeClock, so wall time has no bearing on what the server reports.
    expect(Math.abs(probe.server_now_ms - clock.nowMs())).toBeLessThan(50);

    const missing = await (await fetch(`${baseUrl}/api/operation?key=nope`, { headers: { authorization: `Bearer ${token}` } })).json() as { found: boolean };
    expect(missing.found).toBe(false); // never a null body the client must guess about
    const other = await (await fetch(`${baseUrl}/api/operation?key=nope`, { headers: { authorization: `Bearer ${tokens.get('CORRIDOR')}` } })).json() as { found: boolean };
    expect(other.found).toBe(false); // scoped to the calling operator
  });

  it('15b. a refresh mid-round recovers the session, the deadline and the state', async () => {
    await clearFloor();
    const gate = stores.get('GATE')!;
    expect(await press('LOBBY', 'CALL_TEAM', { team_name: 'Do 3' })).toBe(true);
    expect(await press('CORRIDOR', 'CONFIRM_FLOOR2')).toBe(true);
    expect(await press('GATE', 'START_GAME')).toBe(true);
    await expect.poll(() => gate.getSnapshot().snapshot?.phase, { timeout: 5000 }).toBe('RUNNING');
    const started = gate.getSnapshot().snapshot?.active_round?.game_started_at;
    const deadline = gate.getSnapshot().snapshot?.active_round?.deadline_at;
    const eventStarted = gate.getSnapshot().snapshot?.event.event_started_at;

    // simulate a phone reload: brand new gateway + store over the same token
    const session = await loginAs('gate', devAccounts().find((a) => a.role === 'GATE')!.secret);
    const reloaded = await connect('GATE', session);
    const snap = reloaded.getSnapshot().snapshot!;
    expect(snap.phase).toBe('RUNNING');
    expect(snap.active_round?.game_started_at).toBe(started);
    // The countdown is the stored deadline, not something the phone recomputes.
    expect(snap.active_round?.deadline_at).toBe(deadline);
    expect(snap.event.event_started_at).toBe(eventStarted);
    // The reloaded store's estimate has to track the authoritative clock. It is
    // compared with `clock`, not `Date.now()`: this harness never advances its
    // FakeClock, so the wall clock drifts away from server time by the suite's
    // own runtime — measuring that would say nothing about the estimate.
    expect(Math.abs(reloaded.serverNow() - clock.nowMs())).toBeLessThan(1_000);
    await clearFloor();
  });

  it('20b. the controlled fake clock drives the full event over HTTP too', async () => {
    await clearFloor();
    const supervisor = stores.get('SUPERVISOR')!;
    const lobby = stores.get('LOBBY')!;
    const token = tokens.get('SUPERVISOR')!;
    const forbidden = await fetch(`${baseUrl}/api/dev/clock`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.get('LOBBY')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ advance_ms: 1000 }),
    });
    expect(forbidden.status).toBe(403);

    // Put a team on the clock, then jump 76 minutes: the event stays live while the
    // 5:00 window expires on its own stored deadline.
    expect(await press('LOBBY', 'CALL_TEAM', { team_name: 'Do 4' })).toBe(true);
    expect(await press('CORRIDOR', 'CONFIRM_FLOOR2')).toBe(true);
    expect(await press('GATE', 'START_GAME')).toBe(true);

    // jump 76 minutes: the event remains live, while the 5-minute game expires
    const res = await fetch(`${baseUrl}/api/dev/clock`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ advance_ms: 76 * 60 * 1000 }),
    });
    expect(res.status).toBe(200);
    await lobby.refresh();
    await supervisor.refresh();
    const snap = supervisor.getSnapshot().snapshot!;
    expect(snap.event_status).toBe('LIVE');
    // Nobody pressed anything: the expiry is derived from the stored deadline, so the
    // round is already in the exit-waiting state with a TIME UP result.
    expect(snap.phase).toBe('WAITING_FOR_EXIT');
    expect(snap.active_round?.exit_confirmed_at).toBeNull();
    // and the lobby can no longer be offered a new team
    await lobby.refresh();
    const dispatch = await lobby.act('CALL_TEAM');
    expect(dispatch?.code).toBe('INVALID_STATE');
    expect(dispatch?.message).toContain('Giai đoạn');
    await clearFloor();
  });

  it('serves the supervisor CSV export and blocks it for other roles', async () => {
    const csv = await fetch(`${baseUrl}/api/export`, { headers: { authorization: `Bearer ${tokens.get('SUPERVISOR')}` } });
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).toContain('section,team_number,round,metric');
    expect(text).toContain('CALL_TEAM');
    const denied = await fetch(`${baseUrl}/api/export`, { headers: { authorization: `Bearer ${tokens.get('CORRIDOR')}` } });
    expect(denied.status).toBe(403);
  });
});
