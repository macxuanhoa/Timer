import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CommandRequest,
  CommandResult,
  OperationStatus,
  RevisionHintResponse,
  Snapshot,
} from '../shared/types';
import type { ConnectionStatus, Gateway, RevisionHint } from './gateway';
import { GATEWAY_TIMEOUT_MS, withTimeout } from './gateway';
import { supabase } from './supabaseAuth';
import { finalizeSnapshot } from '../shared/machine';

/**
 * Production gateway: every write goes through the transactional `sc.handle_command`
 * RPC (permissions enforced inside Postgres), every read through `sc.snapshot()`.
 * Realtime is used only as a revision hint — the snapshot is the truth.
 *
 * V3.3 P0: every RPC carries a hard deadline. supabase-js has no request timeout
 * of its own, and a stalled socket on venue Wi-Fi used to leave the phone awaiting
 * a promise that never settled — the boot read, the clock probe and the periodic
 * verification all inherited the hang, and the visible symptom was "ĐANG ĐỒNG BỘ"
 * forever. Each call now rejects within GATEWAY_TIMEOUT_MS so the store's failure
 * paths (OFFLINE, retry, notice) actually run.
 */
export class SupabaseGateway implements Gateway {
  kind = 'supabase' as const;
  private channel: ReturnType<SupabaseClient['channel']> | null = null;
  /** The one authoritative read in flight, shared by everyone who asks for it. */
  private snapshotInFlight: Promise<Snapshot> | null = null;

  private rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
    return withTimeout(
      this.sb.rpc(name, args).then(({ data, error }) => {
        if (error) throw new Error(error.message);
        return data as T;
      }),
      GATEWAY_TIMEOUT_MS, name,
    );
  }

  private constructor(private readonly sb: SupabaseClient, private readonly role: string) {}

  static async connect(): Promise<SupabaseGateway> {
    const sb = supabase();
    const { data } = await sb.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) throw new Error('CHƯA ĐĂNG NHẬP');
    // The role comes from the server-side binding, never from the client.
    const { data: profile, error } = await sb.rpc('whoami');
    const who = profile as { user_id?: string; role?: string } | null;
    // Bind the connection to the role the server assigned to this exact user id.
    if (error || !who?.role || who.user_id !== userId) {
      throw new Error('TÀI KHOẢN CHƯA ĐƯỢC PHÂN QUYỀN VỊ TRÍ');
    }
    return new SupabaseGateway(sb, who.role);
  }

  /**
   * Postgres returns stored rows only; phase is derived by the shared machine so
   * both backends behave identically. `server_now_ms` comes from the database
   * clock, never from the phone.
   *
   * Concurrent asks are coalesced: the snapshot is the largest payload this app
   * moves, and a hint landing during boot or during a verification tick wants the
   * same server state the read already in flight will return.
   */
  snapshot(): Promise<Snapshot> {
    if (!this.snapshotInFlight) {
      this.snapshotInFlight = this.readSnapshot().finally(() => {
        this.snapshotInFlight = null;
      });
    }
    return this.snapshotInFlight;
  }

  private async readSnapshot(): Promise<Snapshot> {
    const raw = await this.rpc<Snapshot & { revision: number | string; server_now_ms: number | string }>('snapshot');
    return finalizeSnapshot({
      revision: Number(raw.revision),
      server_now_ms: Number(raw.server_now_ms),
      event: raw.event,
      rounds: raw.rounds,
      reset_tasks: raw.reset_tasks,
      // Completion claims travel with the snapshot, so both backends derive the same
      // phase and the same provisional result with no extra round trip.
      attempts: raw.attempts ?? [],
      operators: raw.operators,
      log: raw.log,
    });
  }

  get operatorRole(): string {
    return this.role;
  }

  async time(): Promise<number> {
    return Number(await this.rpc<number>('server_now_ms'));
  }

  /** Cheap revision probe for the periodic freshness check. */
  async revision(): Promise<RevisionHintResponse> {
    return await this.rpc<RevisionHintResponse>('state_revision');
  }

  /** Scenario G: was this idempotency key already committed? */
  async operationStatus(idempotencyKey: string): Promise<OperationStatus> {
    const data = await this.rpc<OperationStatus>('operation_status', { p_idempotency_key: idempotencyKey });
    return data ?? { found: false };
  }

  async command(req: CommandRequest, opts?: { dropResponseOnce?: boolean }): Promise<CommandResult> {
    // The command timeout is deliberately the same window as a read: a committed
    // write whose reply is lost lands in the store's reconcile path, which answers
    // by idempotency key. A client-side timeout here never means "the server did
    // not do it".
    const data = await this.rpc<CommandResult>('handle_command', {
      p_action: req.action,
      p_meta: { ...(req.meta ?? {}), ...(req.press ? { _press: req.press } : {}) },
      p_expected_revision: req.expected_revision,
      p_idempotency_key: req.idempotency_key,
    });
    // Test-only simulation of a lost reply (G02); the RPC itself already committed.
    if (opts?.dropResponseOnce) throw new Error('ECONNRESET after commit');
    return data;
  }

  /**
   * Revision hints come from Postgres itself (change on the single-row
   * `sc.state` record, readable only by authenticated operators) so a device can
   * never forge another operator's state update. The subscription is rebuilt
   * whenever the auth token changes, so a refreshed session reconnects cleanly.
   */
  subscribe(handlers: { onRevision(h: RevisionHint): void; onStatus(s: ConnectionStatus): void }): () => void {
    handlers.onStatus('SYNCING');
    const open = () => {
      this.channel = this.sb
        .channel('sc-state')
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'sc', table: 'state' },
          (payload) => {
            const next = payload.new as { revision: string | number; updated_at: string; event_id?: string | number };
            handlers.onRevision({
              revision: Number(next.revision),
              server_now_ms: next.updated_at ? new Date(next.updated_at).getTime() : Date.now(),
              // A different event_id is the one legitimate reason a revision may
              // go DOWN (a fresh event starts at 1); liveStore uses this to adopt
              // the new event without waiting for the periodic verify tick.
              event_id: next.event_id === undefined || next.event_id === null ? undefined : String(next.event_id),
            });
          },
        )
        .on('system', { event: 'connected' }, () => handlers.onStatus('CONNECTED'))
        .on('system', { event: 'disconnected' }, () => handlers.onStatus('OFFLINE'))
        .on('system', { event: 'timed out' }, () => handlers.onStatus('SYNCING'))
        .subscribe();
    };
    open();
    const { data } = this.sb.auth.onAuthStateChange((event) => {
      // TOKEN_REFRESHED / SIGNED_IN: the old channel carries a stale claim.
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
        if (this.channel) void this.sb.removeChannel(this.channel);
        open();
      }
      if (event === 'SIGNED_OUT') handlers.onStatus('OFFLINE');
    });
    return () => {
      data.subscription.unsubscribe();
      if (this.channel) void this.sb.removeChannel(this.channel);
      this.channel = null;
    };
  }
}
