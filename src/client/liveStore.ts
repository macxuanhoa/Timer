import type { ConnectionStatus, Gateway, RevisionHint } from './gateway';
import { GATEWAY_TIMEOUT_MS, withTimeout } from './gateway';
import { ServerClockEstimate } from './clockSync';
import { DEGRADED_AFTER_MS, VERIFY_INTERVAL_MS } from '../shared/constants';
import { CLIENT_BUILD, isClientStale } from '../shared/version';
import type { ActionType, CommandRequest, CommandResult, Snapshot } from '../shared/types';
import type { Role } from '../shared/constants';

/**
 * Store-level ceiling for any single authoritative interaction. The gateways
 * already carry their own timeout; this one is defence in depth: the promise the
 * UI waits on ("ĐANG ĐỒNG BỘ …") must settle even if a gateway implementation
 * forgets to bound a request, so no screen can ever hang on a network that went
 * quiet. Slightly above the gateway budget so the gateway's sharper error
 * normally wins.
 */
const STORE_SETTLE_MS = GATEWAY_TIMEOUT_MS + 1_500;

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
  /**
   * V3.3 forced-update. True once the server has said "this bundle is stale" —
   * either by refusing a command with VERSION_STALE, or by reporting a
   * min_client_version above APP_VERSION on any periodic state_revision read.
   * Every write blocks while this is set, and the UI shows the update gate.
   */
  staleClient: boolean;
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
  /**
   * Store-level settle ceiling for one authoritative interaction; overridden by
   * tests that prove a hung transport still resolves quickly. Production uses the
   * default, which sits just above the gateway's own request timeout.
   */
  settleMs?: number;
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
    staleClient: false,
  };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private inFlight = new Map<ActionType, string>();
  private verifyTimer: number | null = null;
  private readonly verifyMs: number;
  private readonly degradedMs: number;
  private readonly settleMs: number;
  readonly clock: ServerClockEstimate;

  constructor(private readonly opts: LiveStoreOptions) {
    this.clock = new ServerClockEstimate(opts.mono);
    this.verifyMs = opts.verifyIntervalMs ?? VERIFY_INTERVAL_MS;
    this.degradedMs = opts.degradedAfterMs ?? DEGRADED_AFTER_MS;
    this.settleMs = opts.settleMs ?? STORE_SETTLE_MS;
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
    // V3.3 P0: neither await may hang. The clock probe is raced against the store
    // ceiling, and the first read carries its own deadline inside readSnapshot, so
    // `start()` always resolves and the periodic verification always gets its
    // timer — the old failure mode was a boot that never settled and left the
    // phone on "ĐANG ĐỒNG BỘ TRẠNG THÁI…" with no retry ever running.
    const firstRead = this.readSnapshot();
    await withTimeout(this.probeClock(), this.settleMs, 'boot clock').catch(() => undefined);
    await this.commitRead(firstRead);
    this.unsubscribe = this.opts.gateway.subscribe({
      onRevision: (hint) => {
        const current = this.state.snapshot;
        // Ignore stale revisions, duplicate events and our own echo; still use the
        // server timestamp carried by the frame to refine the clock estimate.
        if (hint.server_now_ms) this.clock.observe(hint.server_now_ms, this.now());
        this.patch({ lastVerifiedMono: this.now(), streamAlive: true, status: this.state.snapshot ? 'CONNECTED' : 'SYNCING' });
        // A revision drop is normally stale — unless the state pointer has just
        // moved to a fresh event via OPEN_NEW_EVENT, which restarts the sequence
        // at 1. Adopt that case; every other lower-revision hint stays ignored.
        if (current && hint.revision <= current.revision) {
          if (!hint.event_id || hint.event_id === current.event.id) return;
        }
        // A broadcast means the state pointer moved; a phone that is stale in
        // bundle terms picks that up on the verifyNow tick (which reads
        // sc.state_revision and carries the min_client_version field). A
        // realtime frame itself does not know the floor, so nothing to do here
        // except refresh.
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
    await withTimeout(this.probeClock(), this.settleMs, 'recover clock').catch(() => undefined);
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
    // V3.3 P0: a dead or silent realtime stream must never leave the phone waiting
    // on a "ĐANG ĐỒNG BỘ" that only resolves on the next slow poll. When the
    // stream claims to be alive but no authoritative read has landed for more
    // than a quarter of the verify window, the hint channel is lying — verify
    // again immediately instead of idling until the next tick.
    const since = this.dataAgeMs();
    if (!this.state.streamAlive || (since !== null && since > Math.max(2_500, this.verifyMs / 4))) {
      void this.verifyNow();
    }
  };

  async verifyNow(): Promise<void> {
    try {
      const started = this.now();
      const rev = await withTimeout(this.opts.gateway.revision(), this.settleMs, 'revision');
      this.clock.observe(rev.server_now_ms, started);
      const fresh = rev.event_id === (this.state.snapshot?.event.id ?? rev.event_id) && rev.revision === this.state.snapshot?.revision;
      // V3.3 forced-update: the same probe that checks freshness also reports the
      // minimum bundle the server will accept on the command surface. Read it
      // here so a stale phone learns about the ceiling without pressing anything.
      const stale = isClientStale(rev.min_client_version ?? '');
      this.patch({
        status: 'CONNECTED',
        lastVerifiedMono: this.now(),
        rttMs: this.clock.medianRtt,
        maxDisplayErrorMs: this.clock.maxErrorMs,
        clockReady: true,
        staleClient: stale || this.state.staleClient,
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
   * it can never surface as an unhandled rejection. V3.3 P0: the read is also
   * bounded at the store ceiling, so the boot snapshot and every hint-driven
   * refresh settle even when the transport never answers.
   */
  private readSnapshot(): Promise<Snapshot | null> {
    return withTimeout(this.opts.gateway.snapshot(), this.settleMs, 'snapshot').then(
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
    // V3.3 forced-update: a stale bundle never reaches the wire. The server
    // would refuse the command anyway, and the operator's screen already
    // carries the update gate — the local refusal is the belt to that braces.
    if (this.state.staleClient) {
      this.patch({ error: 'PHIÊN BẢN ỨNG DỤNG ĐÃ CŨ — CẬP NHẬT TRƯỚC KHI TIẾP TỤC' });
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
      // V3.3 forced-update: stamp the bundle the server should accept this
      // command from. The reserved `_v` key is stripped inside sc.handle_command
      // after the gate reads it, so no handler ever sees it in a business meta.
      meta: { ...meta, _v: CLIENT_BUILD },
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
      if (result.code === 'VERSION_STALE') {
        // The server rejected this phone's stamp — lock the surface on the
        // update gate. The UI reads state.staleClient and shows the screen; no
        // other action is offered until the fresh shell takes over.
        this.patch({ staleClient: true, error: result.message });
        return result;
      }
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
        // V3.3 P0: the store ceiling applies to writes as well. A command whose
        // reply never arrives must fall into the reconcile path (which asks the
        // server, by idempotency key, whether the action committed) instead of
        // leaving the phone holding `pending` forever with the CTA stuck on
        // "ĐANG GHI…". The timeout is a client-side give-up, never a claim that
        // the write did not happen.
        return await withTimeout(
          this.opts.gateway.command(req, drop ? { dropResponseOnce: true } : {}),
          this.settleMs, 'command',
        );
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
        const status = await withTimeout(this.opts.gateway.operationStatus(key), this.settleMs, 'operationStatus');
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
