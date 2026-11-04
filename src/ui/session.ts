import { createGateway, USING_SUPABASE, type Gateway } from '../client/gateway';
import { ROLES, type Role } from '../shared/constants';

export interface StoredSession {
  token: string;
  account: { id: string; role: Role; display_name: string };
}
const KEY = 'sc305.session.v1';
export function loadSession(): StoredSession | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as StoredSession | null;
    return parsed?.token && parsed?.account ? parsed : null;
  } catch { return null; }
}
export function saveSession(session: StoredSession | null): void {
  if (session) localStorage.setItem(KEY, JSON.stringify(session));
  else localStorage.removeItem(KEY);
}

// Legacy parsing is only for scrubbing old credentials; never redeem a token.
const TOKEN_IN_PATH = /^\/i\/([A-Za-z0-9_-]{20,})$/;
export function parseInviteToken(pathname: string, search: string): string | null {
  const fromPath = pathname.match(TOKEN_IN_PATH);
  const fromQuery = new URLSearchParams(search).get('i');
  return fromPath?.[1] ?? (fromQuery && fromQuery.length >= 20 ? fromQuery : null);
}
export function clearInviteFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.pathname.startsWith('/i/') && !url.searchParams.has('i')) return;
  url.searchParams.delete('i');
  const path = url.pathname.startsWith('/i/') ? '/' : url.pathname;
  history.replaceState(null, '', `${path}${url.search}${url.hash}`);
}
export class AccessError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'AccessError'; }
}

const ACCOUNT_BY_ROLE: Record<Role, string> = {
  LOBBY: 'lobby', CORRIDOR: 'corridor', GATE: 'gate', ROOM305: 'room305', SUPERVISOR: 'supervisor',
  OBSERVER: 'observer',
};
export function readStationParam(): Role | null {
  const role = new URLSearchParams(window.location.search).get('station')?.toUpperCase() as Role | undefined;
  return role && ROLES.includes(role) ? role : null;
}
/** True when this phone was opened through the private organiser route. */
export function isAdminRoute(): boolean {
  return window.location.pathname.replace(/\/+$/, '').toLowerCase() === '/admin';
}
export async function localStationLogin(station: Role): Promise<StoredSession> {
  // V3.2: the self-hosted dev engine binds a seat with no passcode at all, exactly
  // like the hosted path. The body carries only the chosen account.
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: ACCOUNT_BY_ROLE[station] }),
  });
  if (!res.ok) throw new Error('KHÔNG VÀO ĐƯỢC VỊ TRÍ NÀY');
  const session = await res.json() as StoredSession;
  saveSession(session);
  return session;
}
export async function refreshSession(): Promise<StoredSession | null> {
  const { currentProfile, supabase } = await import('../client/supabaseAuth');
  const profile = await currentProfile();
  if (!profile) { saveSession(null); return null; }
  const { data } = await supabase().auth.getSession();
  if (!data.session) { saveSession(null); return null; }
  const session: StoredSession = {
    token: data.session.access_token,
    account: { id: data.session.user.id, role: profile.role, display_name: profile.display_name },
  };
  saveSession(session);
  return session;
}
export async function enterStation(): Promise<StoredSession | null> {
  clearInviteFromUrl();
  if (!USING_SUPABASE) {
    const station = readStationParam();
    return station ? localStationLogin(station) : loadSession();
  }
  return refreshSession();
}
export async function selectStation(role: Role): Promise<StoredSession> {
  if (!USING_SUPABASE) return localStationLogin(role);
  const { claimStation, claimErrorMessage } = await import('../client/supabaseAuth');
  const result = await claimStation(role);
  const current = await refreshSession();
  if (current) return current;
  if (!result?.ok) throw new AccessError(claimErrorMessage(result), result?.code ?? 'UNKNOWN');
  throw new Error('CHƯA XÁC MINH ĐƯỢC VỊ TRÍ — KIỂM TRA KẾT NỐI');
}
export async function gatewayFor(session: StoredSession): Promise<Gateway> {
  return createGateway({ token: session.token });
}
export async function logout(): Promise<void> {
  if (USING_SUPABASE) {
    const { leaveStation } = await import('../client/supabaseAuth');
    await leaveStation();
  }
  saveSession(null);
}
