import type { ConnectionStatus, Gateway, RevisionHint } from './gateway';
import { ServerClockEstimate } from './clockSync';
import { DEGRADED_AFTER_MS, VERIFY_INTERVAL_MS } from '../shared/constants';
import type { ActionType, CommandRequest, CommandResult, Snapshot } from '../shared/types';
import type { Role } from '../shared/constants';

export interface StoreState {
  status: ConnectionStatus;
  snapshot: Snapshot | null;
  revision: number;
  /** Action currently awaiting an acknowledged write. */
  pending: ActionType | null;
  /**
   * A write whose outcome is unknown: the request was sent but the response was
   * lost. The store asks the server whether the operation idempotency key already
   * committed instead of claiming failure or success.
   */
  verifying: ActionType | null;
  error: string | null;
  notice: string | null;
  clockReady: boolean;
  maxDisplayErrorMs: number | null;
  /** Monotonic stamp of the last successful authoritative read. */
  lastVerifiedMono: number | null;
  streamAlive: boolean;
  rttMs: number | null;
}

export interface StoreAccount {
  id: string;
  role: Role;
  display_name: string;
}

export interface LiveStoreOptions {
  gateway: Gateway;
  account: StoreAccount;
  /** Injectable monotonic source, so tests never wait on real time. */
  mono?: () => number;
  onCommitted?: (result: CommandResult, action: ActionType) => void;
  /** Verification cadence; overridden by tests. */
  verifyIntervalMs?: number;
  degradedAfterMs?: number;
}

let seq = 0;
const nextKey = () => `k${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Single client brain: reconciles broadcast revisions against authoritative
 * snapshots, verifies freshness periodically, keeps an estimated server clock and
 * sends idempotent commands whose outcome is always resolved, never assumed.
 */
export class LiveStore {
  private state: StoreState = {
    status: 'SYNCING',
    snapshot: null,
    revision: -1,
    pending: null,
    verifying: null,
    error: null,
    notice: null,
    clockReady: false,
    maxDisplayErrorMs: null,
    lastVerifiedMono: null,
    streamAlive: false,
    rttMs: null,
  };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private inFlight = new Map<ActionType, string>();
  private verifyTimer: number | null = null;
  private readonly verifyMs: number;
  private readonly degradedMs: number;
  readonly clock: ServerClockEstimate;

  constructor(private readonly opts: LiveStoreOptions) {
    this.clock = new ServerClockEstimate(opts.mono);
    this.verifyMs = opts.verifyIntervalMs ?? VERIFY_INTERVAL_MS;
    this.degradedMs = opts.degradedAfterMs ?? DEGRADED_AFTER_MS;
  }

  /* ---------------------------------------------------- useSyncExternalStore */

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): StoreState => this.state;

  private patch(next: Partial<StoreState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  /* --------------------------------------------------------------- lifecycle */

  async start(): Promise<void> {
    // Boot overlap: the clock probe and the first authoritative read go out on the
    // wire together instead of one after the other, so a phone on field Wi-Fi pays
    // one round trip before the dashboard appears instead of two. The results are
    // still applied in the original order — probe first, then snapshot — so every
    // patch, including every failure path, lands exactly as it did serially.
    const firstRead = this.readSnapshot();
    await this.probeClock();
    await this.commitRead(firstRead);
    this.unsubscribe = this.opts.gateway.subscribe({
      onRevision: (hint) => {
        const current = this.state.snapshot;
        // Ignore stale revisions, duplicate events and our own echo; still use the
        // server timestamp carried by the frame to refine the clock estimate.
        if (hint.server_now_ms) this.clock.observe(hint.server_now_ms, this.now());
        this.patch({ lastVerifiedMono: this.now(), streamAlive: true, status: this.state.snapshot ? 'CONNECTED' : 'SYNCING' });
        if (current && hint.revision <= current.revision) return;
        void this.refresh(hint.revision);
      },
      onStatus: (status) => {
        // A healthy stream is not proof of a readable server: never claim
        // CONNECTED before the first authoritative snapshot has been applied.
        const next = status === 'CONNECTED' && !this.state.snapshot ? 'OFFLINE' : status;
        this.patch({ status: next, streamAlive: status === 'CONNECTED' });
      },
    });
    this.verifyTimer = setInterval(this.verifyTick, this.verifyMs) as unknown as number;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisible);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.verifyTimer !== null) clearInterval(this.verifyTimer);
    this.verifyTimer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
  }

  /** Re-anchor the clock and re-fetch when the app returns to the foreground. */
  private onVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    void this.recover();
  };

  /** Called after a reconnect, a foreground resume or a manual retry. */
  async recover(): Promise<void> {
    this.clock.reset();
    await this.probeClock();
    await this.refresh();
  }

  /**
   * P0-02 fallback: an independent periodic check that the revision we are
   * rendering really is the server's, plus stale-stream detection. Runs whether or
   * not realtime notifications are arriving, because a silent channel must not be
   * mistaken for a healthy one.
   */
  checkFreshness(): void {
    const age = this.dataAgeMs();
    if (age === null || this.state.status !== 'CONNECTED') return;
    if (age > this.degradedMs) this.patch({ status: 'DEGRADED' });
  }

  private verifyTick = () => {
    this.checkFreshness();
    void this.verifyNow();
  };

  async verifyNow(): Promise<void> {
    try {
      const started = this.now();
      const rev = await this.opts.gateway.revision();
      this.clock.observe(rev.server_now_ms, started);
      const fresh = rev.event_id === (this.state.snapshot?.event.id ?? rev.event_id) && rev.revision === this.state.snapshot?.revision;
      this.patch({
        status: 'CONNECTED',
        lastVerifiedMono: this.now(),
        rttMs: this.clock.medianRtt,
        maxDisplayErrorMs: this.clock.maxErrorMs,
        clockReady: true,
      });
      if (!fresh) await this.refresh(rev.revision);
    } catch {
      this.patch({ status: 'OFFLINE' });
    }
  }

  async probeClock(): Promise<void> {
    try {
      const started = this.now();
      const serverMs = await this.opts.gateway.time();
      this.clock.observe(serverMs, started);
      this.patch({ clockReady: true, maxDisplayErrorMs: this.clock.maxErrorMs, rttMs: this.clock.medianRtt });
    } catch {
      this.patch({ clockReady: false, status: 'OFFLINE' });
    }
  }

  /**
   * Issues an authoritative read without waiting for it. A failed read becomes
   * `null` rather than a rejection, so a read started before its consumer awaits
   * it can never surface as an unhandled rejection.
   */
  private readSnapshot(): Promise<Snapshot | null> {
    return this.opts.gateway.snapshot().then(
      (snap) => snap,
      () => null,
    );
  }

  /** Applies a read that was already issued: the only place a snapshot is adopted. */
  private async commitRead(read: Promise<Snapshot | null>, hintRevision?: number): Promise<void> {
    try {
      const snap = await read;
      if (!snap) {
        this.patch({ status: 'OFFLINE' });
        return;
      }
      this.applySnapshot(snap, hintRevision);
      this.patch({ status: 'CONNECTED', error: null, lastVerifiedMono: this.now() });
    } catch {
      this.patch({ status: 'OFFLINE' });
    }
  }

  /** Best-effort authoritative re-read; never lets a stale UI authorize an action. */
  async refresh(hintRevision?: number): Promise<void> {
    await this.commitRead(this.readSnapshot(), hintRevision);
  }

  private applySnapshot(snap: Snapshot, hintRevision?: number): void {
    const current = this.state.snapshot;
    // A different session id is a new event: always adopt it, revision aside.
    if (current && current.event.id !== snap.event.id) {
      this.clock.reset();
      this.patch({ snapshot: snap, revision: snap.revision });
      void this.probeClock();
      return;
    }
    if (current && snap.revision < current.revision) return; // stale / duplicate
    if (current && snap.revision === current.revision && current.server_now_ms >= snap.server_now_ms) return;
    if (hintRevision !== undefined && snap.revision < hintRevision) return; // ignore out-of-order hints
    this.patch({ snapshot: snap, revision: snap.revision });
  }

  /* ---------------------------------------------------------------- commands */

  /**
   * Sends one transactional command. Double taps are collapsed by the in-flight
   * lock plus a server-side idempotency key. If the response is lost, the outcome
   * is resolved by querying that key — never guessed (R08).
   */
  async act(
    action: ActionType,
    meta: CommandRequest['meta'] = {},
    options: { force?: boolean; dropResponseOnce?: boolean; dropAllResponses?: boolean; idempotencyKey?: string } = {},
  ): Promise<CommandResult | null> {
    if (!options.force && this.inFlight.has(action)) return null;
    const snapshot = this.state.snapshot;
    if (!snapshot) {
      this.patch({ error: 'CHƯA ĐỒNG BỘ ĐƯỢC TRẠNG THÁI' });
      return null;
    }
    // Cannot act on state we could not verify recently.
    if (this.state.status === 'OFFLINE') {
      this.patch({ error: 'MẤT KẾT NỐI — chưa gửi thao tác' });
      return null;
    }
    // An explicit key lets a "retry" reuse the original operation identity, so a
    // late-landing first attempt can never be duplicated.
    const key = options.idempotencyKey ?? this.inFlight.get(action) ?? nextKey();
    this.inFlight.set(action, key);
    // Physical press instant, expressed in server time by the calibrated clock.
    // Whole milliseconds only: the estimate is fractional because it is derived
    // from performance.now(), and the server stores the press as a bigint.
    const press: CommandRequest['press'] = {
      press_ms: Math.round(this.clock.now()),
      local_press_ms: Date.now(),
      rtt_ms: this.clock.medianRtt === null ? null : Math.round(this.clock.medianRtt),
    };
    this.patch({ pending: action, error: null, notice: null });
    const req: CommandRequest = {
      action,
      actor: { id: this.opts.account.id, role: this.opts.account.role, display_name: this.opts.account.display_name },
      expected_revision: snapshot.revision,
      idempotency_key: key,
      meta,
      press,
    };

    let result: CommandResult | null = null;
    try {
      result = await this.sendWithRetry(req, options);
      if (result.ok) {
        // Apply the acknowledged state before releasing the lock, so the next press
        // can never be built on a superseded revision.
        if (result.snapshot) this.applySnapshot(result.snapshot);
        else await this.refresh();
      }
    } catch {
      result = await this.reconcileUnknown(action, key);
    } finally {
      this.inFlight.delete(action);
      this.patch({ pending: null, verifying: null });
    }

    if (!result) return null;
    if (!result.ok) {
      if (result.code === 'STALE_REVISION') {
        await this.refresh();
        this.patch({ notice: 'Trạng thái đã thay đổi từ thiết bị khác. Màn hình đã đồng bộ lại.' });
      }
      this.patch({ error: result.message });
      return result;
    }
    this.patch({ error: null, notice: result.message });
    this.opts.onCommitted?.(result, action);
    return result;
  }

  private async sendWithRetry(
    req: CommandRequest,
    options: { dropResponseOnce?: boolean; dropAllResponses?: boolean },
    attempts = 2,
  ): Promise<CommandResult> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      const drop = options.dropAllResponses === true || (options.dropResponseOnce === true && i === 0);
      try {
        return await this.opts.gateway.command(req, drop ? { dropResponseOnce: true } : {});
      } catch (err) {
        lastError = err;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 350 * (i + 1)));
      }
    }
    throw lastError;
  }

  /**
   * Scenario G: the request may have committed even though we never saw the
   * reply. Ask the server for the operation by its idempotency key, then either
   * adopt the authoritative state (it landed) or report that it did not.
   */
  private async reconcileUnknown(action: ActionType, key: string): Promise<CommandResult | null> {
    this.patch({ verifying: action, status: 'SYNCING' });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const status = await this.opts.gateway.operationStatus(key);
        if (status && status.found === true) {
          await this.refresh(status.revision);
          this.patch({ notice: 'ĐÃ GHI NHẬN (xác minh với máy chủ)' });
          return {
            ok: true,
            code: 'OK',
            message: 'Đã ghi nhận (phản hồi bị mất, đã xác minh)',
            revision: status.revision ?? this.state.revision,
            server_now_ms: this.clock.now(),
            snapshot: this.state.snapshot ?? undefined,
          };
        }
        // A well-formed "not found" answer is proof nothing committed: safe to retry.
        if (status && status.found === false) {
          this.patch({ error: 'CHƯA ĐƯỢC GHI NHẬN — nhấn lại để thử' });
          return {
            ok: false,
            code: 'BLOCKED',
            message: 'CHƯA ĐƯỢC GHI NHẬN — nhấn lại để thử',
            revision: this.state.revision,
            server_now_ms: this.clock.now(),
          };
        }
      } catch {
        /* keep probing: an unread answer is not evidence of failure */
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    this.patch({ error: 'ĐANG XÁC MINH — chưa xác nhận được với máy chủ', status: 'DEGRADED' });
    return null;
  }

  clearMessages(): void {
    if (this.state.error || this.state.notice) this.patch({ error: null, notice: null });
  }

  /* ------------------------------------------------------------------ clock */

  /** Estimated authoritative now. Falls back to wall clock until calibrated. */
  serverNow(): number {
    return this.clock.now();
  }

  /** Age of the last verified authoritative read, in milliseconds. */
  dataAgeMs(): number | null {
    return this.state.lastVerifiedMono === null ? null : Math.max(0, this.now() - this.state.lastVerifiedMono);
  }

  private now(): number {
    return this.opts.mono ? this.opts.mono() : performance.now();
  }
}
