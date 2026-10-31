import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  CommandRequest,
  CommandResult,
  OperationStatus,
  RevisionHintResponse,
  Snapshot,
} from '../shared/types';
import type { ConnectionStatus, Gateway, RevisionHint } from './gateway';
import { finalizeSnapshot } from '../shared/machine';

/**
 * Production gateway: every write goes through the transactional `sc.handle_command`
 * RPC (permissions enforced inside Postgres), every read through `sc.snapshot()`.
 * Realtime is used only as a revision hint — the snapshot is the truth.
 */
export class SupabaseGateway implements Gateway {
  kind = 'supabase' as const;
  private channel: ReturnType<SupabaseClient['channel']> | null = null;

  private constructor(private readonly sb: SupabaseClient, private readonly role: string) {}

  static async connect(): Promise<SupabaseGateway> {
    const url = import.meta.env.VITE_SUPABASE_URL as string;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
    if (!url || !key) throw new Error('THIẾU VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
    const sb = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await sb.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) throw new Error('CHƯA ĐĂNG NHẬP');
    const { data: profile, error } = await sb
      .from('operators')
      .select('role,display_name')
      .eq('user_id', userId)
      .single();
    if (error || !profile) throw new Error('TÀI KHOẢN CHƯA ĐƯỢC PHÂN QUYỀN VỊ TRÍ');
    return new SupabaseGateway(sb, profile.role as string);
  }

  /**
   * Postgres returns stored rows only; phase is derived by the shared machine so
   * both backends behave identically. `server_now_ms` comes from the database
   * clock, never from the phone.
   */
  async snapshot(): Promise<Snapshot> {
    const { data, error } = await this.sb.rpc('snapshot');
    if (error) throw new Error(error.message);
    const raw = data as { revision: number; server_now_ms: number } & Omit<Snapshot, 'event_status' | 'phase' | 'active_round' | 'server_now_ms'>;
    return finalizeSnapshot({
      revision: Number(raw.revision),
      server_now_ms: Number(raw.server_now_ms),
      event: raw.event,
      rounds: raw.rounds,
      reset_tasks: raw.reset_tasks,
      operators: raw.operators,
      log: raw.log,
    });
  }

  get operatorRole(): string {
    return this.role;
  }

  async time(): Promise<number> {
    const { data, error } = await this.sb.rpc('server_now_ms');
    if (error) throw new Error(error.message);
    return Number(data);
  }

  /** Cheap revision probe for the periodic freshness check. */
  async revision(): Promise<RevisionHintResponse> {
    const { data, error } = await this.sb.rpc('state_revision');
    if (error) throw new Error(error.message);
    return data as RevisionHintResponse;
  }

  /** Scenario G: was this idempotency key already committed? */
  async operationStatus(idempotencyKey: string): Promise<OperationStatus> {
    const { data, error } = await this.sb.rpc('operation_status', { p_idempotency_key: idempotencyKey });
    if (error) throw new Error(error.message);
    return (data ?? { found: false }) as OperationStatus;
  }

  async command(req: CommandRequest, opts?: { dropResponseOnce?: boolean }): Promise<CommandResult> {
    const { data, error } = await this.sb.rpc('handle_command', {
      p_action: req.action,
      p_meta: { ...(req.meta ?? {}), ...(req.press ? { _press: req.press } : {}) },
      p_expected_revision: req.expected_revision,
      p_idempotency_key: req.idempotency_key,
    });
    if (error) throw new Error(error.message);
    // Test-only simulation of a lost reply (G02); the RPC itself already committed.
    if (opts?.dropResponseOnce) throw new Error('ECONNRESET after commit');
    return data as CommandResult;
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
            const next = payload.new as { revision: string | number; updated_at: string };
            handlers.onRevision({
              revision: Number(next.revision),
              server_now_ms: next.updated_at ? new Date(next.updated_at).getTime() : Date.now(),
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
