import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHub, devAccounts } from '../src/server/hub';

let server: Server;
let base: string;
const pin = devAccounts().find(a => a.role === 'SUPERVISOR')!.secret;
beforeEach(async () => {
  server = createServer(createHub().handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
const login = (passcode?: string, account = 'supervisor') => fetch(base + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account, passcode }),
});
const snapshot = (token: string) => fetch(base + '/api/snapshot', { headers: { authorization: 'Bearer ' + token } });

describe('Admin PIN and per-device logout', () => {
  it('refuses missing and wrong PINs without issuing authority', async () => {
    for (const value of [undefined, '', '000000']) {
      const res = await login(value);
      expect(res.status).toBe(401);
      expect((await res.json()).token).toBeUndefined();
    }
    expect((await snapshot('supervisor.forged')).status).toBe(401);
  });
  it('grants an authenticated admin session after the correct PIN', async () => {
    const res = await login(pin);
    expect(res.ok).toBe(true);
    const session = await res.json();
    expect(session.account.role).toBe('SUPERVISOR');
    expect((await snapshot(session.token)).status).toBe(200);
  });
  it('revokes only the device that logged out, including on subsequent requests', async () => {
    const a = await (await login(pin)).json();
    const b = await (await login(pin)).json();
    expect(a.token).not.toBe(b.token);
    const exit = await fetch(base + '/api/logout', { method: 'POST', headers: { authorization: 'Bearer ' + a.token } });
    expect(exit.ok).toBe(true);
    expect((await snapshot(a.token)).status).toBe(401);
    expect((await snapshot(b.token)).status).toBe(200);
  });
  it('limits repeated PIN guesses without blocking ordinary station access', async () => {
    for (let attempt = 0; attempt < 5; attempt++) expect((await login('000000')).status).toBe(401);
    expect((await login(pin)).status).toBe(429);
    expect((await login(undefined, 'gate')).status).toBe(200);
  });
});
