import { USING_SUPABASE } from './gateway';
import { OBSERVER_HEARTBEAT_MS } from '../shared/constants';

/**
 * Observer presence.
 *
 * A viewer identity is one anonymous id kept in local storage: refreshing the page
 * beats for the seat it already holds instead of taking a second one, while closing
 * the tab stops the beats and the server frees the seat after its own timeout.
 * Capacity is enforced where it matters — on the server — this module only asks.
 */

const KEY = 'sc305.viewer.v1';

export interface PresenceResult {
  ok: boolean;
  code: string;
  devices: number;
  capacity: number;
}

/** The stable id for this browser, created once and reused by every later visit. */
export function viewerId(): string {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
  } catch {
    /* storage may be blocked; a per-load id still behaves correctly, just not across refresh */
  }
  const fresh =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  try {
    localStorage.setItem(KEY, fresh);
  } catch {
    /* not fatal: the seat simply cannot be recognised after a refresh */
  }
  return fresh;
}

async function localCall(path: 'join' | 'beat' | 'leave', token: string): Promise<PresenceResult> {
  const res = await fetch(`/api/observer/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ viewer_id: viewerId() }),
  });
  const body = (await res.json().catch(() => null)) as Partial<PresenceResult> | null;
  return {
    ok: Boolean(body?.ok),
    code: String(body?.code ?? (res.status === 429 ? 'OBSERVER_FULL' : `HTTP_${res.status}`)),
    devices: Number(body?.devices ?? 0),
    capacity: Number(body?.capacity ?? 10),
  };
}

async function rpcCall(rpc: 'observer_join' | 'observer_beat' | 'observer_leave'): Promise<PresenceResult> {
  const { supabase } = await import('./supabaseAuth');
  // PostgREST resolves a function by its exact parameter set, so only the RPCs that
  // declare a viewer id receive one.
  const args = rpc === 'observer_leave' ? undefined : { p_viewer_id: viewerId() };
  const { data, error } = await supabase().rpc(rpc, args ?? {});
  if (error) return { ok: false, code: 'NETWORK', devices: 0, capacity: 10 };
  const row = (data ?? {}) as Partial<PresenceResult> & { ok?: boolean };
  return {
    ok: Boolean(row.ok),
    code: String(row.code ?? (row.ok ? 'JOINED' : 'OBSERVER_FULL')),
    devices: Number(row.devices ?? 0),
    capacity: Number(row.capacity ?? 10),
  };
}

export async function observerJoin(token: string): Promise<PresenceResult> {
  return USING_SUPABASE ? rpcCall('observer_join') : localCall('join', token);
}

export async function observerBeat(token: string): Promise<PresenceResult> {
  return USING_SUPABASE ? rpcCall('observer_beat') : localCall('beat', token);
}

/** Best effort: an unacknowledged leave still expires on the server. */
export async function observerLeave(token: string): Promise<void> {
  try {
    if (USING_SUPABASE) await rpcCall('observer_leave');
    else await localCall('leave', token);
  } catch {
    /* the seat is released by timeout instead */
  }
}

/**
 * Holds the seat for as long as the page is open. `onResult` receives every answer,
 * including refusals, so the view can say plainly that the room is full.
 *
 * Detaching stops the heartbeat but deliberately does *not* release the seat: a
 * component can be re-mounted (a dev double-invoke, a screen flip back from the
 * full-room message) faster than the join it issues, and a release from the earlier
 * mount would then land after the join and throw the viewer out of a seat it is
 * sitting in. Real exits are explicit — the leave button, and `pagehide` — and an
 * abandoned tab is freed by the server's own timeout instead.
 */
export function watchPresence(token: string, onResult: (r: PresenceResult) => void): () => void {
  let closed = false;
  const report = (r: PresenceResult) => {
    if (!closed) onResult(r);
  };
  void observerJoin(token).then(report);
  const timer = setInterval(() => void observerBeat(token).then(report), OBSERVER_HEARTBEAT_MS);
  const onVisible = () => {
    // Coming back to the foreground re-claims immediately: the tab may have been
    // throttled long enough for the server to consider the seat abandoned.
    if (document.visibilityState === 'visible') void observerJoin(token).then(report);
  };
  const onUnload = () => void observerLeave(token);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pagehide', onUnload);
  return () => {
    closed = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', onUnload);
  };
}
