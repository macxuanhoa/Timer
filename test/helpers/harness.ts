import { ScreamEngine, initialState, type Account, type PersistedState } from '../../src/server/engine';
import { FakeClock, type Clock, type CommandRequest, type CommandResult, type CompletionAttempt, type Snapshot } from '../../src/shared/types';
import { MemoryStore } from '../../src/server/store';
import type { ConnectionStatus, Gateway, RevisionHint } from '../../src/client/gateway';
import { LiveStore, type StoreAccount } from '../../src/client/liveStore';
import type { HiddenObjectOwner, Role } from '../../src/shared/constants';

export const T0 = 1_730_000_000_000;
export const SEC = 1000;
export const MIN = 60 * SEC;

export interface OperatorDef {
  id: string;
  role: Role;
  display_name: string;
}

/** The four floor positions, the retained admin, and one open viewer. */
export const OPERATORS: OperatorDef[] = [
  { id: 'lobby', role: 'LOBBY', display_name: 'Lan' },
  { id: 'corridor', role: 'CORRIDOR', display_name: 'Ngoc' },
  { id: 'gate', role: 'GATE', display_name: 'Hung' },
  { id: 'room305', role: 'ROOM305', display_name: 'Tuan' },
  { id: 'supervisor', role: 'SUPERVISOR', display_name: 'Mai' },
  { id: 'observer', role: 'OBSERVER', display_name: 'Viewer' },
];

type Listener = (hint: RevisionHint) => void;

/**
 * In-process authoritative hub: one engine, one fake clock, N gateway views.
 * Lets long sessions be replayed without waiting in real time.
 */
export class TestHub {
  clock: Clock;
  engine: ScreamEngine;
  private listeners = new Set<Listener>();
  /** Number of broadcast hints delivered, for convergence assertions. */
  broadcasts = 0;

  constructor(options: { fake?: boolean; store?: MemoryStore; hiddenObjectOwner?: HiddenObjectOwner; prepAllowanceMs?: number } = {}) {
    this.clock = options.fake === false ? new (class implements Clock { nowMs() { return Date.now(); } })() : new FakeClock(T0);
    const store = options.store ?? new MemoryStore();
    const state: PersistedState =
      store.load() ??
      initialState(this.clock.nowMs(), {
        ...(options.hiddenObjectOwner ? { hidden_object_owner: options.hiddenObjectOwner } : {}),
        ...(options.prepAllowanceMs === undefined ? {} : { prep_allowance_ms: options.prepAllowanceMs }),
      });
    const accounts: Record<string, Account> = Object.fromEntries(OPERATORS.map((o) => [o.id, { ...o }]));
    this.engine = new ScreamEngine(state, this.clock, accounts);
  }

  now(): number {
    return this.clock.nowMs();
  }

  advance(ms: number): void {
    const fake = this.clock as FakeClock;
    if (typeof fake.advance !== 'function') throw new Error('clock is not fakeable');
    fake.advance(ms);
    const revision = this.engine.revision;
    this.engine.snapshot();
    if (this.engine.revision !== revision) this.emit({ revision: this.engine.revision, server_now_ms: this.now() });
  }

  private emit(hint: RevisionHint): void {
    this.broadcasts += 1;
    for (const l of this.listeners) l(hint);
  }

  /** Direct engine command; bypasses HTTP but keeps every server-side check. */
  command(
    operatorId: string,
    action: CommandRequest['action'],
    meta: CommandRequest['meta'] = {},
    expectedRevision?: number,
    idempotencyKey = `test:${operatorId}:${action}:${Math.random().toString(36).slice(2)}`,
    press?: CommandRequest['press'],
  ): CommandResult {
    const operator = OPERATORS.find((o) => o.id === operatorId)!;
    const before = this.engine.revision;
    const result = this.engine.dispatch({
      action,
      actor: { id: operator.id, role: operator.role, display_name: operator.display_name },
      expected_revision: expectedRevision ?? before,
      idempotency_key: idempotencyKey,
      meta,
      press: press ?? { press_ms: this.clock.nowMs(), local_press_ms: Date.now(), rtt_ms: 0 },
    });
    if (result.ok && this.engine.revision !== before) this.emit({ revision: this.engine.revision, server_now_ms: this.now() });
    return result;
  }

  gateway(operatorId: string): Gateway {
    const self = this;
    return {
      kind: 'local',
      snapshot: async () => self.engine.snapshot(),
      revision: async () => self.engine.revisionProbe(),
      operationStatus: async (key: string) => self.engine.operationStatus(operatorId, key),
      time: async () => self.now(),
      async command(req: CommandRequest, opts?: { dropResponseOnce?: boolean }): Promise<CommandResult> {
        const result = self.command(req.actor.id, req.action, req.meta, req.expected_revision, req.idempotency_key, req.press);
        // Scenario G: the server committed, the reply never arrived.
        if (opts?.dropResponseOnce && result.ok) throw new Error('ECONNRESET after commit');
        return result;
      },
      subscribe(handlers: { onRevision(h: RevisionHint): void; onStatus(s: ConnectionStatus): void }) {
        const listener: Listener = (hint) => handlers.onRevision(hint);
        self.listeners.add(listener);
        handlers.onStatus('CONNECTED');
        return () => self.listeners.delete(listener);
      },
    };
  }

  /** A connected operator client with its own estimated server clock. */
  client(
    operatorId: string,
    fault: { failCommands?: boolean; failSnapshot?: boolean; silentStream?: boolean } = {},
  ): { store: LiveStore; account: StoreAccount } {
    const operator = OPERATORS.find((o) => o.id === operatorId)!;
    const account: StoreAccount = { id: operator.id, role: operator.role, display_name: operator.display_name };
    const gateway = this.gateway(operatorId);
    if (fault.failCommands) {
      gateway.command = async () => {
        throw new Error('ECONNRESET');
      };
    }
    if (fault.failSnapshot) {
      gateway.snapshot = async () => {
        throw new Error('ECONNRESET');
      };
      gateway.revision = async () => {
        throw new Error('ECONNRESET');
      };
    }
    // A dropped realtime channel with still-readable state: the periodic
    // verification must keep the phone correct without any broadcast.
    if (fault.silentStream) {
      gateway.subscribe = (handlers) => {
        handlers.onStatus('CONNECTED');
        return () => undefined;
      };
    }
    const store = new LiveStore({ gateway, account, mono: () => this.clock.nowMs() });
    return { store, account };
  }

  snapshot(): Snapshot {
    return this.engine.snapshot();
  }

  /** Claims recorded on the round currently in play, in recording order. */
  attempts(roundId?: string): CompletionAttempt[] {
    const snap = this.snapshot();
    const id = roundId ?? snap.active_round?.id;
    return snap.attempts.filter((a) => a.round_id === id);
  }
}

/** Flattened log for assertions about what was recorded. */
export function actions(hub: TestHub): string[] {
  return hub.engine.fullLog().map((l) => `${l.action}:${l.actor_role}`);
}

export function entries(hub: TestHub) {
  return hub.engine.fullLog();
}

export function latest(hub: TestHub, action: CommandRequest['action']) {
  const all = hub.engine.fullLog().filter((l) => l.action === action);
  return all[all.length - 1] ?? null;
}

/**
 * Plays one complete round through the positions that own each step, exactly as the
 * four phones would. `claimMs` is the instant the players say they are finished and
 * therefore the official duration; `verifyMs` is how long NPC2 then takes, which
 * must not change the score.
 */
export function playRound(
  hub: TestHub,
  opts: {
    prepMs?: number;
    claimMs?: number;
    verifyMs?: number;
    /** Record the claim but never validate it, so the round ends as TIME UP. */
    puzzle?: boolean;
    /** Let NPC1 bypass the floor-2 confirmation instead of OPERATOR_02 confirming. */
    bypass?: boolean;
    exitMs?: number;
    resetMs?: number;
    /** The round's window. Defaults to the duration the event is configured with. */
    durationMs?: number;
  } = {},
) {
  const configured = hub.snapshot().event.config.game_limit_ms;
  const {
    prepMs = 60 * SEC,
    claimMs = 150 * SEC,
    verifyMs = 12 * SEC,
    puzzle = true,
    bypass = false,
    exitMs = 20 * SEC,
    resetMs = 40 * SEC,
    durationMs = configured,
  } = opts;
  hub.command('lobby', 'CALL_TEAM');
  hub.advance(prepMs);
  if (bypass) hub.command('gate', 'FLOOR2_BYPASS', { reason: 'Đội đã lên thẳng tầng 3' });
  else hub.command('corridor', 'CONFIRM_FLOOR2');
  hub.advance(20 * SEC);
  hub.command('gate', 'START_GAME');
  hub.advance(claimMs);
  let attempt: CompletionAttempt | null = null;
  if (puzzle) {
    hub.command('room305', 'CLAIM_COMPLETE');
    attempt = hub.attempts().at(-1) ?? null;
    hub.advance(verifyMs);
    if (attempt) hub.command('room305', 'VERIFY_ATTEMPT', { attempt_id: attempt.id, decision: 'VALID' });
    // Verification delay plus the walk out, so the exit is measurably later than the claim.
    hub.advance(Math.max(0, exitMs - verifyMs));
  } else {
    // Without a validated claim the clock has to run out before the round can close.
    hub.advance(Math.max(0, durationMs - claimMs + exitMs));
  }
  hub.command('gate', 'CONFIRM_EXIT');
  hub.advance(resetMs);
  // The floor-3 checks are confirmed concurrently by the staff who own them.
  hub.command('gate', 'RESET_DONE');
  hub.command('room305', 'RESET_DONE');
  hub.command('gate', 'GATE_FINALIZE');
  return { attempt, round: hub.snapshot().rounds.at(-1)! };
}
