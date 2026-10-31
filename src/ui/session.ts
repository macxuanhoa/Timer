import { createGateway, USING_SUPABASE, type Gateway } from '../client/gateway';
import { ROLES, type Role } from '../shared/constants';

export interface StoredSession {
  token: string;
  account: { id: string; role: Role; display_name: string };
}

const KEY = 'sc305.session.v1';
const DEVICE_KEY = 'sc305.device.v1';

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    return parsed?.token && parsed?.account ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession | null): void {
  if (!session) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(session));
}

/** Stable per-install id, recorded on the binding for the audit trail. */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // Private mode / storage disabled: the id is audit metadata only.
    return 'unknown-device';
  }
}

/* ------------------------------------------------------------- invitations */

const TOKEN_IN_PATH = /^\/i\/([A-Za-z0-9_-]{20,})$/;

/** Pure parser for `/i/<token>` and `?i=<token>`; unit-tested without a DOM. */
export function parseInviteToken(pathname: string, search: string): string | null {
  const fromPath = pathname.match(TOKEN_IN_PATH);
  if (fromPath) return fromPath[1];
  const fromQuery = new URLSearchParams(search).get('i');
  return fromQuery && fromQuery.length >= 20 ? fromQuery : null;
}

/** The station token from `/i/<token>` or `?i=<token>`. */
export function readInviteToken(): string | null {
  return parseInviteToken(window.location.pathname, window.location.search);
}

/**
 * The link is the credential: it is removed from the address bar as soon as it
 * has been read, so it cannot be recovered from history or a shared screenshot.
 * The token stays in memory only, for the retry button.
 */
export function clearInviteFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('i');
  const path = TOKEN_IN_PATH.test(url.pathname) ? '/' : url.pathname;
  history.replaceState(null, '', `${path}${url.search}${url.hash}`);
}

let pendingToken: string | null = null;

export function pendingInviteToken(): string | null {
  return pendingToken;
}

async function redeemInvite(token: string): Promise<StoredSession> {
  const { redeemInvitation, inviteErrorMessage } = await import('../client/supabaseAuth');
  const result = await redeemInvitation(token, deviceId());
  if (!result?.ok) throw new Error(inviteErrorMessage(result));
  const session = await refreshSession();
  if (!session) throw new Error('KHÔNG ĐỌC ĐƯỢC VỊ TRÍ SAU KHI MỞ LIÊN KẾT');
  return session;
}

/** Retry after a transient failure, without needing the link again. */
export async function retryPendingInvite(): Promise<StoredSession> {
  if (!pendingToken) throw new Error('KHÔNG CÒN LIÊN KẾT ĐỂ THỬ LẠI — MỞ LẠI LIÊN KẾT ĐÃ NHẬN');
  return redeemInvite(pendingToken);
}

/* ------------------------------------------------------------- local mode */

const ACCOUNT_BY_ROLE: Record<Role, string> = {
  LOBBY: 'lobby',
  GATE: 'gate',
  CORRIDOR: 'corridor',
  ROOM305: 'room305',
  SUPERVISOR: 'supervisor',
};

const DEV_PASSCODE = (import.meta.env.VITE_DEV_PASSCODE as string | undefined) ?? '3110';

/** `?station=GATE` — the self-hosted engine's stand-in for an invitation link. */
export function readStationParam(): Role | null {
  const raw = new URLSearchParams(window.location.search).get('station');
  const role = raw?.toUpperCase() as Role | undefined;
  return role && ROLES.includes(role) ? role : null;
}

export async function localStationLogin(station: Role): Promise<StoredSession> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: ACCOUNT_BY_ROLE[station], passcode: DEV_PASSCODE }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'KHÔNG VÀO ĐƯỢC VỊ TRÍ NÀY');
  }
  const session = (await res.json()) as StoredSession;
  saveSession(session);
  return session;
}

/* ---------------------------------------------------------------- session */

/** Re-derives the live role of this device from the server. */
export async function refreshSession(): Promise<StoredSession | null> {
  const { currentProfile, supabase } = await import('../client/supabaseAuth');
  const profile = await currentProfile();
  if (!profile) return null;
  const { data } = await supabase().auth.getSession();
  const session: StoredSession = {
    token: data.session?.access_token ?? '',
    account: {
      id: data.session?.user.id ?? '',
      role: profile.role,
      display_name: profile.display_name,
    },
  };
  saveSession(session);
  return session;
}

/**
 * Boot path: an invitation link wins, then a session that already exists on
 * this device (PWA reopen, refresh, tablet left on the shelf) is restored.
 */
export async function enterStation(): Promise<StoredSession | null> {
  if (!USING_SUPABASE) {
    const station = readStationParam();
    if (station) return localStationLogin(station);
    return loadSession();
  }

  const token = readInviteToken();
  if (!token) return refreshSession();

  pendingToken = token;
  clearInviteFromUrl();
  try {
    return await redeemInvite(token);
  } catch (err) {
    // A phone already on duty that re-opens a spent link — or another station's
    // link — stays on its own station: the server-side binding is the authority,
    // never the URL.
    const current = await refreshSession().catch(() => null);
    if (current) return current;
    throw err;
  } finally {
    if (pendingToken === token && loadSession()) pendingToken = null;
  }
}

export async function gatewayFor(session: StoredSession): Promise<Gateway> {
  return createGateway({ token: session.token });
}

/**
 * "Đổi máy": the station is released server-side before the anonymous identity
 * is dropped, so the role becomes free. Links are one-shot, so the replacement
 * phone is issued a new link by the organizer. If the release fails (offline)
 * the error propagates and this phone keeps its station instead of losing it.
 */
export async function logout(): Promise<void> {
  if (USING_SUPABASE) {
    const { leaveStation } = await import('../client/supabaseAuth');
    await leaveStation();
  }
  pendingToken = null;
  saveSession(null);
}
