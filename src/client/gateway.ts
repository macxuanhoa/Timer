import type {
  CommandRequest,
  CommandResult,
  OperationStatus,
  RevisionHintResponse,
  Snapshot,
} from '../shared/types';

/**
 * CONNECTED only ever means “the authoritative state was read recently and the
 * stream is alive”. A live socket with unverifiable data is DEGRADED, never LIVE.
 */
export type ConnectionStatus = 'CONNECTED' | 'SYNCING' | 'DEGRADED' | 'OFFLINE';

export interface RevisionHint {
  revision: number;
  server_now_ms: number;
  /**
   * Identifier of the event the state pointer refers to. Only a hint whose event
   * differs from the phone's current view can legitimately carry a lower revision,
   * because a new event restarts the sequence at 1. The client uses it to skip the
   * "lower revision is stale / duplicate" bail when a supervisor has just pressed
   * OPEN_NEW_EVENT, so every phone adopts the fresh event without waiting for the
   * 10-second periodic verification.
   */
  event_id?: string;
}

/**
 * V3.3 P0: every network call the store or the boot path makes carries a hard
 * deadline. A stalled socket on venue Wi-Fi used to leave a phone awaiting a
 * promise that never settled — the visible symptom was "ĐANG ĐỒNG BỘ" forever,
 * because the boot read, the clock probe and the periodic verification all
 * inherited the hang. withTimeout guarantees a settle (rejection) so each
 * caller's existing failure path — OFFLINE, the retry notice, the periodic
 * recheck — actually runs.
 */
export const GATEWAY_TIMEOUT_MS = 8_000;

/**
 * Accepts a PromiseLike on purpose: the Supabase client returns a Postgrest-
 * FilterBuilder (a thenable) from `.rpc()`, and awaiting it directly is the
 * idiomatic call site. The deadline must therefore wrap the thenable, not a
 * pre-awaited promise.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(`${label}: request timed out after ${ms} ms`)), ms);
    // unref-style guard for browsers: the timer is cleared on settle below.
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolveP(v); },
      (e) => { clearTimeout(timer); rejectP(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/** Minimal transport contract shared by the local engine and Supabase. */
export interface Gateway {
  kind: 'local' | 'supabase';
  snapshot(): Promise<Snapshot>;
  /** Cheap revision + server instant, used by the periodic freshness check. */
  revision(): Promise<RevisionHintResponse>;
  /** Scenario G: did this idempotency key already commit? */
  operationStatus(idempotencyKey: string): Promise<OperationStatus>;
  command(req: CommandRequest, opts?: { dropResponseOnce?: boolean }): Promise<CommandResult>;
  time(): Promise<number>;
  /** Resolves when the subscription ends. Reconnect handling lives inside. */
  subscribe(handlers: {
    onRevision(hint: RevisionHint): void;
    onStatus(status: ConnectionStatus): void;
    /**
     * A stream keep-alive that carries the server instant and nothing else. It
     * proves the socket is alive, NOT that this phone can read the authoritative
     * state, so it may refine the clock and must never mark the data as freshly
     * read (V3.4 §11: the chip has to name the real transport state).
     */
    onHeartbeat?(serverNowMs: number): void;
  }): () => void;
}

interface GatewayConfig {
  token: string;
  baseUrl?: string;
}

const BACKEND = (import.meta.env.VITE_BACKEND as string | undefined) ?? 'local';
export const USING_SUPABASE = BACKEND === 'supabase';

/**
 * Boot warm-up. Both Supabase modules are needed only a moment later (the session
 * check, then the gateway), and one of them carries the client library: fetching
 * them while the app is still mounting keeps that download off the critical path,
 * so the awaited imports below resolve from the module cache. A local build never
 * enters this branch and therefore never requests the chunks. Failing to warm up
 * is invisible on purpose: the real await below still reports the error.
 */
if (USING_SUPABASE) void Promise.all([import('./supabaseGateway'), import('./supabaseAuth')]).catch(() => undefined);

export async function createGateway(config: GatewayConfig): Promise<Gateway> {
  if (USING_SUPABASE) {
    const { SupabaseGateway } = await import('./supabaseGateway');
    return SupabaseGateway.connect();
  }
  return new LocalGateway({ token: config.token, baseUrl: config.baseUrl ?? '' });
}

/* ------------------------------------------------------------ local engine */

export class LocalGateway implements Gateway {
  kind = 'local' as const;
  constructor(private readonly cfg: { token: string; baseUrl: string }) {}

  private get auth(): Record<string, string> {
    return { authorization: `Bearer ${this.cfg.token}` };
  }

  private snapshotInFlight: Promise<Snapshot> | null = null;

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await withTimeout(
      fetch(`${this.cfg.baseUrl}${path}`, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
        headers: { ...this.auth, 'content-type': 'application/json', ...(init?.headers ?? {}) },
      }),
      GATEWAY_TIMEOUT_MS + 500, path,
    );
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok && res.status !== 409) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body;
  }

  snapshot(): Promise<Snapshot> {
    // One authoritative read on the wire at a time: the boot path, a revision hint
    // that arrives during it and the periodic check can all ask in the same instant
    // for the same server state, and the payload is the heaviest one we fetch.
    if (!this.snapshotInFlight) {
      this.snapshotInFlight = this.json<Snapshot>('/api/snapshot').finally(() => {
        this.snapshotInFlight = null;
      });
    }
    return this.snapshotInFlight;
  }

  revision(): Promise<RevisionHintResponse> {
    return this.json<RevisionHintResponse>('/api/revision');
  }

  operationStatus(idempotencyKey: string): Promise<OperationStatus> {
    return this.json<OperationStatus>(`/api/operation?key=${encodeURIComponent(idempotencyKey)}`);
  }

  time(): Promise<number> {
    return this.json<{ server_now_ms: number }>('/api/time').then((r) => r.server_now_ms);
  }

  async command(req: CommandRequest, opts?: { dropResponseOnce?: boolean }): Promise<CommandResult> {
    const path = opts?.dropResponseOnce ? '/api/command?drop_response=1' : '/api/command';
    return this.json<CommandResult>(path, { method: 'POST', body: JSON.stringify(req) });
  }

  /** SSE over fetch so the bearer token stays in a header instead of a URL. */
  subscribe(handlers: {
    onRevision(h: RevisionHint): void;
    onStatus(s: ConnectionStatus): void;
    onHeartbeat?(serverNowMs: number): void;
  }): () => void {
    let closed = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const loop = async () => {
      while (!closed) {
        try {
          handlers.onStatus('SYNCING');
          const res = await fetch(`${this.cfg.baseUrl}/api/stream`, {
            headers: { ...this.auth, accept: 'text/event-stream' },
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          handlers.onStatus('CONNECTED');
          while (!closed) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const lines = frame.split('\n');
              const dataLine = lines.find((l) => l.startsWith('data:'));
              if (!dataLine) continue;
              // The frame's own event name is what separates a state change from a
              // keep-alive. `event: time` is emitted every few seconds by the hub to
              // hold the socket open; reading it as a revision hint used to restamp
              // "data verified now", so a phone whose authoritative reads were
              // failing still wore ĐÃ KẾT NỐI.
              const eventName = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
              const payload = JSON.parse(dataLine.slice(5).trim()) as RevisionHint & { r?: number };
              if (eventName === 'time') {
                if (payload.server_now_ms) handlers.onHeartbeat?.(payload.server_now_ms);
                continue;
              }
              handlers.onRevision({
                revision: payload.revision ?? payload.r ?? 0,
                server_now_ms: payload.server_now_ms,
                event_id: payload.event_id,
              });
            }
          }
        } catch {
          if (!closed) handlers.onStatus('OFFLINE');
        }
        if (closed) break;
        await new Promise((r) => setTimeout(r, 1200));
      }
    };
    void loop();

    return () => {
      closed = true;
      void reader?.cancel().catch(() => undefined);
    };
  }
}
