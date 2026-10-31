import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isSteppable, SystemClock, type Clock, type CommandRequest, type SteppableClock } from '../shared/types.ts' ;
import { ScreamEngine, initialState, type Account, type PersistedState } from './engine.ts' ;
import { FileStore, MemoryStore, type StateStore } from './store.ts' ;
import { analytics, roundMetrics } from '../shared/metrics.ts' ;

export interface OperatorAccount extends Account {
  secret: string;
}

/** Shared duty passcode for every station; override per station with `SC_PASSCODE_*`. */
const DEFAULT_PASSCODE = '3110';

/**
 * Dev / self-hosted operator accounts. In Supabase deployment these five
 * identities come from Supabase Auth + `sc.operator_profiles` and the app key is
 * never used (see README §Production).
 */
export function devAccounts(): OperatorAccount[] {
  const roles: [string, Account['role'], string][] = [
    ['lobby', 'LOBBY', process.env.SC_PASSCODE_LOBBY ?? DEFAULT_PASSCODE],
    ['gate', 'GATE', process.env.SC_PASSCODE_GATE ?? DEFAULT_PASSCODE],
    ['corridor', 'CORRIDOR', process.env.SC_PASSCODE_CORRIDOR ?? DEFAULT_PASSCODE],
    ['room305', 'ROOM305', process.env.SC_PASSCODE_ROOM305 ?? DEFAULT_PASSCODE],
    ['supervisor', 'SUPERVISOR', process.env.SC_PASSCODE_SUPERVISOR ?? DEFAULT_PASSCODE],
  ];
  return roles.map(([id, role, secret]) => ({
    id,
    role,
    display_name: role.charAt(0) + role.slice(1).toLowerCase(),
    secret,
  }));
}

export interface HubOptions {
  store?: StateStore;
  clock?: Clock;
  accounts?: OperatorAccount[];
  /** Enables the controlled fake clock used by the automated test suite. */
  allowTestClock?: boolean;
  tokenSecret?: string;
}

export interface Hub {
  engine: ScreamEngine;
  clock: Clock;
  accounts: OperatorAccount[];
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Total SSE delivery lag measured on the last broadcast (ms). */
  stats: { broadcasts: number; connectedClients: number };
}

const TOKEN_SECRET_DEFAULT = 'scream-control-dev-token-secret';

export function createHub(options: HubOptions = {}): Hub {
  const accounts = options.accounts ?? devAccounts();
  const accountMap: Record<string, Account> = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const tokenSecret = options.tokenSecret ?? process.env.SC_TOKEN_SECRET ?? TOKEN_SECRET_DEFAULT;
  const clock = options.clock ?? new SystemClock();
  const store = options.store ?? new MemoryStore();
  const state: PersistedState = store.load() ?? initialState(clock.nowMs());
  // Reassignable so a dev/test reset can swap in a brand new session.
  let engine = new ScreamEngine(state, clock, accountMap);
  const fake: SteppableClock | null = isSteppable(clock) ? clock : null;

  const sign = (id: string) => createHmac('sha256', tokenSecret).update(id).digest('hex').slice(0, 32);
  const issueToken = (id: string) => `${id}.${sign(id)}`;
  const verifyToken = (token: string | undefined): Account | null => {
    if (!token) return null;
    const [id, sig] = token.split('.');
    const expected = sign(id);
    if (!sig || sig.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return accountMap[id] ?? null;
  };

  const clients = new Set<ServerResponse>();
  const stats = { broadcasts: 0, connectedClients: 0 };

  const broadcast = (revision: number) => {
    stats.broadcasts += 1;
    const payload = `event: revision\ndata: ${JSON.stringify({ revision, server_now_ms: clock.nowMs() })}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  };

  const persistAndBroadcast = () => {
    store.save(engine.raw());
    broadcast(engine.revision);
  };

  /** Persist + notify only when a mutation actually advanced the revision. */
  const settle = (revisionBefore: number) => {
    if (engine.revision !== revisionBefore) persistAndBroadcast();
  };

  /**
   * Reading a body must never throw: an empty, truncated or non-JSON payload used
   * to crash the whole engine process (and with it every connected phone). Malformed
   * input is reported per request instead.
   */
  const readBody = async (req: IncomingMessage): Promise<{ value: Record<string, unknown>; malformed: boolean }> => {
    const chunks: Buffer[] = [];
    try {
      for await (const c of req) chunks.push(c as Buffer);
    } catch {
      return { value: {}, malformed: true };
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw === '') return { value: {}, malformed: false };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: {}, malformed: true };
      return { value: parsed as Record<string, unknown>, malformed: false };
    } catch {
      return { value: {}, malformed: true };
    }
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(json);
  };

  /** Last line of defence: a failing request is answered, never allowed to escape. */
  const guard = (res: ServerResponse, fn: () => Promise<void>): void => {
    void fn().catch((err: unknown) => {
      console.error('[scream-engine] request failed:', err instanceof Error ? err.message : err);
      send(res, 500, { error: 'LỖI MÁY CHỦ' });
    });
  };

  const csv = (): string => {
    const snap = engine.snapshot();
    const rows: string[] = [];
    rows.push('section,team_number,round,metric,value_ms,value_text,actor_role,at_iso,revision');
    for (const r of snap.rounds) {
      const m = roundMetrics(r, snap.reset_tasks);
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === 'number') rows.push(['round', r.team_number, r.round_number, k, v, '', '', new Date(snap.server_now_ms).toISOString(), r.created_revision].join(','));
      }
    }
    for (const l of engine.fullLog()) {
      rows.push(
        [
          'log',
          l.team_number ?? '',
          '',
          l.action,
          l.at_ms,
          JSON.stringify(String(l.metadata?.detail_text ?? '')),
          l.actor_role,
          new Date(l.at_ms).toISOString(),
          l.revision,
        ].join(','),
      );
    }
    const a = analytics(snap, snap.server_now_ms);
    for (const [k, v] of Object.entries(a)) {
      if (typeof v === 'number') rows.push(['event', '', '', k, v, '', 'SUPERVISOR', new Date(snap.server_now_ms).toISOString(), snap.revision].join(','));
    }
    return rows.join('\n');
  };

  const route = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname.replace(/\/+$/, '');
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }

    if (path === '/api/login' && req.method === 'POST') {
      guard(res, async () => {
        const { value: body, malformed } = await readBody(req);
        if (malformed) {
          send(res, 400, { error: 'YÊU CẦU KHÔNG HỢP LỆ' });
          return;
        }
        const account = accounts.find((a) => a.id === body.account);
        if (!account || typeof body.passcode !== 'string' || body.passcode !== account.secret) {
          send(res, 401, { error: 'SAI TÀI KHOẢN HOẶC MẬT KHẨU' });
          return;
        }
        send(res, 200, {
          token: issueToken(account.id),
          account: { id: account.id, role: account.role, display_name: account.display_name },
        });
      });
      return;
    }

    const actor = verifyToken(token);
    if (!actor) {
      send(res, 401, { error: 'UNAUTHENTICATED' });
      return;
    }

    if (path === '/api/account' && req.method === 'GET') {
      const account = accounts.find((a) => a.id === actor.id)!;
      send(res, 200, { id: account.id, role: account.role, display_name: account.display_name });
      return;
    }

    if (path === '/api/time' && req.method === 'GET') {
      send(res, 200, { server_now_ms: clock.nowMs() });
      return;
    }

    // Cheap freshness probe for the client's periodic authoritative check.
    if (path === '/api/revision' && req.method === 'GET') {
      send(res, 200, engine.revisionProbe());
      return;
    }

    /**
     * Scenario G: “committed but the response was lost”. The client asks for the
     * operation by its idempotency key before retrying or reporting a failure, so a
     * successful server action is never re-executed or shown as unknown.
     */
    if (path === '/api/operation' && req.method === 'GET') {
      const key = url.searchParams.get('key') ?? '';
      send(res, 200, engine.operationStatus(actor.id, key));
      return;
    }

    if (path === '/api/snapshot' && req.method === 'GET') {
      const before = engine.revision;
      const snap = engine.snapshot();
      settle(before);
      send(res, 200, snap);
      return;
    }

    if (path === '/api/export' && req.method === 'GET') {
      if (actor.role !== 'SUPERVISOR') {
        send(res, 403, { error: 'PERMISSION_DENIED' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="scream-control-305.csv"',
        'cache-control': 'no-store',
      });
      res.end(csv());
      return;
    }

    if (path === '/api/command' && req.method === 'POST') {
      guard(res, async () => {
        const { value: raw, malformed } = await readBody(req);
        if (malformed) {
          send(res, 400, { error: 'YÊU CẦU KHÔNG HỢP LỆ' });
          return;
        }
        const body = raw as Omit<CommandRequest, 'actor'>;
        if (typeof body.action !== 'string' || typeof body.idempotency_key !== 'string') {
          send(res, 400, { error: 'THIẾU HÀNH ĐỘNG HOẶC KHÓA Idempotency' });
          return;
        }
        const before = engine.revision;
        const result = engine.dispatch({ ...body, actor: { id: actor.id, role: actor.role, display_name: actor.display_name } });
        // Derived boundaries crossed while reading (auto-close) must persist too.
        settle(before);
        // Test-only fault injection (G02): commit, then drop the response once.
        if (options.allowTestClock && url.searchParams.get('drop_response') === '1' && result.ok) {
          res.destroy();
          return;
        }
        send(res, result.ok ? 200 : 409, result);
      });
      return;
    }

    if (path === '/api/dev/reset' && req.method === 'POST') {
      // Dev/test only: start a brand new session. The revision counter keeps
      // climbing so every connected phone adopts the fresh state immediately.
      if (!options.allowTestClock || actor.role !== 'SUPERVISOR') {
        send(res, 403, { error: 'RESET DISABLED' });
        return;
      }
      const nextRevision = engine.revision + 1;
      engine = new ScreamEngine(initialState(clock.nowMs()), clock, accountMap);
      engine.raw().event.revision = nextRevision;
      store.save(engine.raw());
      broadcast(nextRevision);
      send(res, 200, { ok: true, revision: nextRevision, server_now_ms: clock.nowMs() });
      return;
    }

    if (path === '/api/dev/clock' && req.method === 'POST') {
      if (!options.allowTestClock || !fake || actor.role !== 'SUPERVISOR') {
        send(res, 403, { error: 'TEST CLOCK DISABLED' });
        return;
      }
      guard(res, async () => {
        const { value: body, malformed } = await readBody(req);
        if (malformed) {
          send(res, 400, { error: 'YÊU CẦU KHÔNG HỢP LỆ' });
          return;
        }
        const before = engine.revision;
        if (typeof body.set_ms === 'number') fake.set(body.set_ms);
        if (typeof body.advance_ms === 'number') fake.advance(body.advance_ms);
        engine.snapshot();
        settle(before);
        send(res, 200, { server_now_ms: fake.nowMs(), revision: engine.revision });
      });
      return;
    }

    if (path === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ revision: engine.revision, server_now_ms: clock.nowMs() })}\n\n`);
      clients.add(res);
      stats.connectedClients = clients.size;
      const heartbeat = setInterval(() => {
        try {
          res.write(`event: time\ndata: ${JSON.stringify({ server_now_ms: clock.nowMs(), r: engine.revision })}\n\n`);
        } catch {
          // A half-closed phone socket must never take the timer loop down.
          clearInterval(heartbeat);
          clients.delete(res);
          stats.connectedClients = clients.size;
        }
      }, 5000);
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
        stats.connectedClients = clients.size;
      });
      return;
    }

    send(res, 404, { error: 'NOT_FOUND' });
  };

  /** Synchronous throws are contained too: one bad request cannot kill the event. */
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      route(req, res);
    } catch (err) {
      console.error('[scream-engine] handler failed:', err instanceof Error ? err.message : err);
      send(res, 500, { error: 'LỖI MÁY CHỦ' });
    }
  };

  return { engine, clock, accounts, handler, stats };
}
