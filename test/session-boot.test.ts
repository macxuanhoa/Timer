import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The boot path of the production build: an invitation link, a restored session,
 * or the gate. Authorization always comes from the server-side binding, so these
 * cases pin down requirement 8 — neither the URL nor localStorage can hand out a
 * role, and a phone that is already on duty never loses it to a bad link.
 */

const TOKEN = 'Xy7' + 'k'.repeat(40); // shape of a minted 256-bit base64url token

const mock = vi.hoisted(() => ({
  store: new Map<string, string>(),
  state: {
    redeem: { ok: false, code: 'INVITATION_INVALID' } as Record<string, unknown>,
    profile: null as { role: string; display_name: string } | null,
    userId: null as string | null,
    thrown: null as string | null,
    released: false,
    redeemedWith: null as string | null,
  },
}));

vi.mock('../src/client/supabaseAuth', () => ({
  supabase: () => ({
    auth: {
      getSession: async () => ({
        data: { session: mock.state.userId ? { access_token: 'jwt', user: { id: mock.state.userId } } : null },
      }),
      signOut: async () => {
        mock.state.userId = null;
      },
    },
  }),
  ensureAnonymousSession: async () => undefined,
  redeemInvitation: async (token: string) => {
    if (mock.state.thrown) throw new Error(mock.state.thrown);
    mock.state.redeemedWith = token;
    return mock.state.redeem;
  },
  currentProfile: async () => mock.state.profile,
  leaveStation: async () => {
    mock.state.released = true;
    mock.state.userId = null;
    mock.state.profile = null;
  },
  inviteErrorMessage: (r: Record<string, unknown> | null) => String(r?.message ?? 'KHÔNG MỞ ĐƯỢC LIÊN KẾT'),
}));

let lastUrl = '';

/** Minimal browser surface that `session.ts` touches, plus a working storage shim. */
function installBrowser(pathname: string, search = '') {
  const storage = {
    getItem: (k: string) => mock.store.get(k) ?? null,
    setItem: (k: string, v: string) => void mock.store.set(k, v),
    removeItem: (k: string) => void mock.store.delete(k),
  };
  vi.stubGlobal('window', { location: { pathname, search, href: `https://app.test${pathname}${search}` } });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => (lastUrl = url) });
}

async function boot(pathname: string, search = '') {
  vi.resetModules();
  vi.stubEnv('VITE_BACKEND', 'supabase');
  installBrowser(pathname, search);
  return import('../src/ui/session');
}

beforeEach(() => {
  mock.store.clear();
  Object.assign(mock.state, {
    redeem: { ok: false, code: 'INVITATION_INVALID' },
    profile: null,
    userId: null,
    thrown: null,
    released: false,
    redeemedWith: null,
  });
  lastUrl = '';
});

describe('invitation boot — the server binding is the only authority', () => {
  it('opens the station dashboard straight from a fresh link and drops the token', async () => {
    const s = await boot(`/i/${TOKEN}`);
    mock.state.redeem = { ok: true, code: 'BOUND', role: 'GATE' };
    mock.state.userId = 'u-gate';
    mock.state.profile = { role: 'GATE', display_name: 'NPC 1' };

    const session = await s.enterStation();
    expect(session?.account).toEqual({ id: 'u-gate', role: 'GATE', display_name: 'NPC 1' });
    expect(mock.state.redeemedWith).toBe(TOKEN);
    // The credential must not survive in the address bar or in app state.
    expect(lastUrl).toBe('/');
    expect(s.pendingInviteToken()).toBeNull();
  });

  it('restores the role on PWA reopen with no link at all', async () => {
    const s = await boot('/');
    mock.store.set('sc305.session.v1', JSON.stringify({ token: 'jwt', account: { id: 'u-old', role: 'GATE', display_name: 'NPC 1' } }));
    mock.state.userId = 'u-lobby';
    mock.state.profile = { role: 'LOBBY', display_name: 'LOBBY' };

    const session = await s.enterStation();
    // The stored session is a hint only: the account comes from whoami().
    expect(session?.account.id).toBe('u-lobby');
    expect(session?.account.role).toBe('LOBBY');
    expect(mock.state.redeemedWith).toBeNull();
  });

  it('refuses a role that was forged into localStorage or into the query string', async () => {
    const s = await boot('/', `?role=SUPERVISOR&station=SUPERVISOR`);
    mock.store.set(
      'sc305.session.v1',
      JSON.stringify({ token: 'jwt', account: { id: 'u-x', role: 'SUPERVISOR', display_name: 'SUP' } }),
    );
    mock.state.userId = 'u-x';
    mock.state.profile = null; // the server knows no binding for this device

    expect(await s.enterStation()).toBeNull();
  });

  it('keeps the live station when an on-duty phone re-opens a spent or foreign link', async () => {
    const s = await boot(`/i/${TOKEN}`);
    mock.state.redeem = { ok: false, code: 'ROLE_TAKEN', message: 'VỊ TRÍ NÀY ĐANG TRỰC Ở MÁY KHÁC' };
    mock.state.userId = 'u-lobby';
    mock.state.profile = { role: 'LOBBY', display_name: 'LOBBY' };

    const session = await s.enterStation();
    expect(session?.account.role).toBe('LOBBY');
  });

  it('reports an offline activation and keeps the link for one retry', async () => {
    const s = await boot(`/i/${TOKEN}`);
    mock.state.thrown = 'Failed to fetch';

    await expect(s.enterStation()).rejects.toThrow(/fetch/);
    expect(s.pendingInviteToken()).toBe(TOKEN);

    mock.state.thrown = null;
    mock.state.redeem = { ok: true, code: 'BOUND', role: 'GATE' };
    mock.state.userId = 'u-gate';
    mock.state.profile = { role: 'GATE', display_name: 'NPC 1' };
    const retry = await s.retryPendingInvite();
    expect(retry.account.role).toBe('GATE');
  });

  it('releases the station server-side before forgetting the anonymous identity', async () => {
    const s = await boot('/');
    mock.state.userId = 'u-gate';
    mock.state.profile = { role: 'GATE', display_name: 'NPC 1' };
    await s.enterStation();

    await s.logout();
    expect(mock.state.released).toBe(true);
    expect(mock.store.has('sc305.session.v1')).toBe(false);
  });

  it('never treats a query parameter as an invitation token', async () => {
    const s = await boot('/');
    expect(s.parseInviteToken('/', `?role=SUPERVISOR`)).toBeNull();
    expect(s.parseInviteToken(`/i/${TOKEN}`, '')).toBe(TOKEN);
  });
});
