import { createGateway, USING_SUPABASE, type Gateway } from '../client/gateway';
import type { Role } from '../shared/constants';

export interface StoredSession {
  token: string;
  account: { id: string; role: Role; display_name: string };
}

const KEY = 'sc305.session.v1';

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

/** Login persists across PWA restarts (requirement §9). */
export async function login(accountId: string, passcode: string): Promise<StoredSession> {
  if (USING_SUPABASE) {
    const { supabaseLogin } = await import('../client/supabaseAuth');
    return supabaseLogin(accountId, passcode);
  }
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: accountId, passcode }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: 'SINGIN FAILED' }))).error);
  const session = (await res.json()) as StoredSession;
  saveSession(session);
  return session;
}

export async function gatewayFor(session: StoredSession): Promise<Gateway> {
  return createGateway({ token: session.token });
}

export async function logout(): Promise<void> {
  if (USING_SUPABASE) {
    const { supabaseLogout } = await import('../client/supabaseAuth');
    await supabaseLogout();
  }
  saveSession(null);
}
