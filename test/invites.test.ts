import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseInviteToken } from '../src/ui/session';

/**
 * The invitation link is the only credential a phone ever holds, so the parser
 * is the one place where "what counts as a link" is decided. These cases pin it
 * down: a station token is accepted from the path or the query, and nothing
 * else — no short strings, no lookalike paths, no role names.
 */
describe('invitation link parsing', () => {
  const token = randomBytes(32).toString('base64url');

  it('mints 256-bit, URL-safe tokens', () => {
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomBytes(32).toString('base64url')).not.toBe(token);
  });

  it('reads the token from /i/<token>', () => {
    expect(parseInviteToken(`/i/${token}`, '')).toBe(token);
  });

  it('reads the token from ?i=<token>', () => {
    expect(parseInviteToken('/', `?i=${token}`)).toBe(token);
    expect(parseInviteToken('/anything', `?station=GATE&i=${token}`)).toBe(token);
  });

  it('refuses anything that is not a token', () => {
    expect(parseInviteToken('/', '')).toBeNull();
    expect(parseInviteToken('/i/', '')).toBeNull();
    expect(parseInviteToken('/i/short', '')).toBeNull();
    expect(parseInviteToken(`/i/${token}/extra`, '')).toBeNull();
    expect(parseInviteToken(`/not-i/${token}`, '')).toBeNull();
    expect(parseInviteToken('/', '?i=short')).toBeNull();
    expect(parseInviteToken('/', '?role=SUPERVISOR')).toBeNull();
    // the five station names are never accepted on their own as a credential
    expect(parseInviteToken('/GATE', '')).toBeNull();
  });

  it('accepts every role name only inside a real token', () => {
    for (const role of ['LOBBY', 'GATE', 'CORRIDOR', 'ROOM305', 'SUPERVISOR']) {
      expect(parseInviteToken(`/${role}`, `?i=${token}`)).toBe(token);
      expect(parseInviteToken(`/${role}`, '')).toBeNull();
    }
  });
});
