import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  profile: null as { role: string; display_name: string } | null,
  uid: null as string | null,
  claim: vi.fn(), release: vi.fn(),
}));
vi.mock('../src/client/supabaseAuth', () => ({
  supabase: () => ({ auth: { getSession: async () => ({ data: { session: mock.uid ?
    { access_token: 'jwt', user: { id: mock.uid } } : null } }) } }),
  currentProfile: async () => mock.profile,
  claimStation: mock.claim,
  leaveStation: mock.release,
  claimErrorMessage: (r: { code: string }) => r.code,
}));
let cleanUrl = '';
async function boot(path = '/', search = '') {
  vi.resetModules(); vi.stubEnv('VITE_BACKEND', 'supabase');
  vi.stubGlobal('window', { location: { pathname: path, search, href: `https://app.test${path}${search}` } });
  vi.stubGlobal('history', { replaceState: (_a: unknown, _b: unknown, url: string) => { cleanUrl = url; } });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mock.storage.get(k) ?? null,
    setItem: (k: string, v: string) => mock.storage.set(k, v),
    removeItem: (k: string) => mock.storage.delete(k),
  });
  return import('../src/ui/session');
}
beforeEach(() => {
  mock.storage.clear(); mock.profile = null; mock.uid = null; cleanUrl = '';
  mock.claim.mockReset(); mock.release.mockReset();
});
describe('single URL: authority comes from whoami, never a token or cached role', () => {
  it('opens root as Home without creating or claiming an identity', async () => {
    const s = await boot();
    expect(await s.enterStation()).toBeNull(); expect(mock.claim).not.toHaveBeenCalled();
  });
  it('scrubs legacy links without redeeming them', async () => {
    const s = await boot('/i/' + 'x'.repeat(43), '?i=' + 'y'.repeat(43));
    expect(await s.enterStation()).toBeNull(); expect(cleanUrl).toBe('/');
    expect(mock.claim).not.toHaveBeenCalled();
  });
  it('restores a server binding directly, including when an old foreign link is opened', async () => {
    const s = await boot('/i/' + 'x'.repeat(43));
    mock.uid = 'gate'; mock.profile = { role: 'GATE', display_name: 'NPC 1' };
    expect((await s.enterStation())?.account.role).toBe('GATE');
    expect(mock.claim).not.toHaveBeenCalled();
  });
  it('rejects a forged cached role and query string, clears revoked binding cache', async () => {
    const s = await boot('/', '?role=SUPERVISOR&station=SUPERVISOR');
    mock.uid = 'outsider'; mock.storage.set('sc305.session.v1', JSON.stringify({ token: 'jwt', account: { role: 'SUPERVISOR' } }));
    expect(await s.enterStation()).toBeNull(); expect(s.loadSession()).toBeNull();
  });
  it('claims once, then uses the server-verified profile for the dashboard', async () => {
    const s = await boot(); mock.uid = 'room';
    mock.claim.mockImplementation(async () => {
      mock.profile = { role: 'ROOM305', display_name: 'NPC 3' };
      return { ok: true, code: 'CLAIMED', role: 'SUPERVISOR' };
    });
    expect((await s.selectStation('ROOM305')).account.role).toBe('ROOM305');
    expect(mock.claim).toHaveBeenCalledWith('ROOM305');
  });
  it('shows a capacity/PIN refusal and stores no binding', async () => {
    const s = await boot(); mock.claim.mockResolvedValue({ ok: false, code: 'ROLE_TAKEN' });
    await expect(s.selectStation('GATE')).rejects.toThrow('ROLE_TAKEN');
    expect(s.loadSession()).toBeNull();
  });
  it('keeps the current binding if a parallel tab already holds another role', async () => {
    const s = await boot(); mock.uid = 'gate'; mock.profile = { role: 'GATE', display_name: 'GATE' };
    mock.claim.mockResolvedValue({ ok: false, code: 'ALREADY_BOUND_OTHER_ROLE' });
    expect((await s.selectStation('CORRIDOR')).account.role).toBe('GATE');
  });
  it('does not forget a station when release fails', async () => {
    const s = await boot(); mock.uid = 'gate'; mock.profile = { role: 'GATE', display_name: 'GATE' };
    await s.enterStation(); mock.release.mockRejectedValue(new Error('offline'));
    await expect(s.logout()).rejects.toThrow('offline'); expect(s.loadSession()?.account.role).toBe('GATE');
  });
  it('clears the binding cache only after acknowledged release', async () => {
    const s = await boot(); mock.uid = 'gate'; mock.profile = { role: 'GATE', display_name: 'GATE' };
    await s.enterStation(); mock.release.mockResolvedValue(undefined);
    await s.logout(); expect(s.loadSession()).toBeNull(); expect(mock.uid).toBe('gate');
  });
});
