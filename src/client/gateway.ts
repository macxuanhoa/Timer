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

export interface SessionAccount {
  id: string;
  role: Snapshot['operators'][number]['role'];
  display_name: string;
}

export interface RevisionHint {
  revision: number;
  server_now_ms: number;
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
  }): () => void;
}

export interface GatewayConfig {
  token: string;
  baseUrl?: string;
}

const BACKEND = (import.meta.env.VITE_BACKEND as string | undefined) ?? 'local';
export const USING_SUPABASE = BACKEND === 'supabase';

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

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      ...init,
      headers: { ...this.auth, 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok && res.status !== 409) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body;
  }

  snapshot(): Promise<Snapshot> {
    return this.json<Snapshot>('/api/snapshot');
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
  subscribe(handlers: { onRevision(h: RevisionHint): void; onStatus(s: ConnectionStatus): void }): () => void {
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
              const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
              if (!dataLine) continue;
              const payload = JSON.parse(dataLine.slice(5).trim()) as RevisionHint & { r?: number };
              handlers.onRevision({ revision: payload.revision ?? payload.r ?? 0, server_now_ms: payload.server_now_ms });
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
