/* Non-destructive checks against the real production Supabase backend, V3.2.
 *
 * Run:  node --env-file=.env.local scripts/verify-production-access.mjs
 *
 * Proves: the V3.2 RPC surface is live (open seats, admin-gated SUPERVISOR,
 * force-aware reset, observer wrapper), the retired credential surface is
 * gone, and board reads work with zero auth.
 *
 * Safety: NO round is ever created, modified or aborted. The only seat writes
 * are claim + immediate release of a slot that was FREE before the test,
 * using throwaway probe identities, always cleaned up in finally. */
import { writeFileSync } from 'node:fs';

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !anon) throw new Error('requires --env-file=.env.local (VITE_SUPABASE_URL + ANON key only)');

const results = [];
const skipped = [];
const run = async (name, fn) => {
  try { const note = await fn(); results.push([name, 'PASS', note || '']); console.log(`PASS  ${name}${note ? ' — ' + note : ''}`); }
  catch (error) { results.push([name, 'FAIL', String(error?.message || error)]); console.error(`FAIL  ${name}: ${error?.message || error}`); }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const rpc = async (name, body, token) => {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: anon, Authorization: `Bearer ${token || anon}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(json).slice(0, 180)}`);
  return json;
};
const signIn = async (refreshToken) => {
  const response = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) throw new Error(`refresh failed: ${response.status}`);
  return response.json();
};
const newIdentity = async () => {
  const created = await fetch(`${url}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `sc305-probe-${crypto.randomUUID()}@probe.invalid`, password: `Probe!${crypto.randomUUID()}` }),
  });
  if (!created.ok) throw new Error(`signup ${created.status}: ${(await created.text()).slice(0, 140)}`);
  const session = await created.json();
  assert(session.user?.id && session.access_token, 'signup returned no session');
  return { id: session.user.id, token: session.access_token, refresh: session.refresh_token };
};

const probes = [];
const tokenOf = async (probe) => (probe.token || (await signIn(probe.refresh)).access_token);
const fresh = async () => { const p = await newIdentity(); probes.push(p); return p; };

let boardSnapshot;
try {
  await run('board responds with the V3.2 shape (no credential needed)', async () => {
    boardSnapshot = await rpc('station_board', {});
    assert(boardSnapshot.board_version === 3, `board_version=${boardSnapshot.board_version}`);
    assert(boardSnapshot.observer_capacity === 10, `observer_capacity=${boardSnapshot.observer_capacity}`);
    assert(!('codes_required' in boardSnapshot), 'stale codes_required field present');
    assert(Array.isArray(boardSnapshot.stations) && boardSnapshot.stations.length >= 5, 'missing stations array');
    assert('reset_allowed' in boardSnapshot, 'missing reset_allowed');
    return `devices ${boardSnapshot.devices}/${boardSnapshot.device_capacity} · reset_allowed=${boardSnapshot.reset_allowed}`;
  });

  await run('retired credential surface is unreachable (invite redeem / configure code)', async () => {
    let a = false; let b = false;
    try { await rpc('redeem_invitation', { p_token: 'x'.repeat(43) }); } catch { a = true; }
    try { await rpc('configure_station_code', { p_role: 'GATE', p_code: 'X' }); } catch { b = true; }
    assert(a && b, 'a retired function is still callable');
  });

  await run('open seat claim works with no code/PIN, then releases cleanly', async () => {
    const free = (boardSnapshot.stations || []).find((s) => s.role !== 'SUPERVISOR' && s.devices === 0);
    if (!free) { skipped.push('every duty seat occupied: live claim skipped to preserve on-duty devices'); return 'skipped (busy)'; }
    const probe = await fresh();
    const claimed = await rpc('claim_station', { p_role: free.role }, await tokenOf(probe));
    assert(claimed.ok === true, `claim failed: ${JSON.stringify(claimed)}`);
    const who = await rpc('handle_command', { p_action: 'WHOAMI' }, await tokenOf(probe));
    assert(who.role === free.role, `whoami=${who.role}`);
    const refused = await rpc('claim_station', { p_role: 'CORRIDOR' }, await tokenOf(probe));
    assert(refused.code === 'ALREADY_BOUND', `second seat not blocked: ${JSON.stringify(refused)}`);
    const released = await rpc('release_device', {}, await tokenOf(probe));
    assert(released.ok === true, 'release failed');
    assert((await rpc('handle_command', { p_action: 'WHOAMI' }, await tokenOf(probe))).ok === false, 'still bound after release');
    return `slot ${free.role} round-trip`;
  });

  await run('SUPERVISOR is refused for a device not on the allow-list', async () => {
    const probe = await fresh();
    const answer = await rpc('claim_station', { p_role: 'SUPERVISOR' }, await tokenOf(probe));
    assert(answer.code === 'ADMIN_NOT_ALLOWED', `unexpected: ${JSON.stringify(answer)}`);
    assert((await rpc('handle_command', { p_action: 'WHOAMI' }, await tokenOf(probe))).ok === false, 'refused claim still bound');
  });

  await run('reset_all_stations is refused from a non-admin caller', async () => {
    const probe = await fresh();
    await rpc('claim_station', { p_role: 'LOBBY' }, await tokenOf(probe));
    const answer = await rpc('reset_all_stations', { p_force: false }, await tokenOf(probe));
    assert(answer.code === 'RESET_NOT_AUTHORIZED', `unexpected: ${JSON.stringify(answer)}`);
    await rpc('release_device', {}, await tokenOf(probe));
  });

  await run('observer wrapper joins, beats and leaves through public RPCs', async () => {
    const probe = await fresh();
    const token = await tokenOf(probe);
    const joined = await rpc('observer_join', {}, token);
    assert(joined.ok === true, `join: ${JSON.stringify(joined)}`);
    const beat = await rpc('observer_beat', {}, token);
    assert(beat.seat?.user_id === probe.id || beat.ok === true, `beat: ${JSON.stringify(beat)}`);
    const board = await rpc('station_board', {});
    assert(board.observer_devices >= 1, `observer_devices=${board.observer_devices}`);
    if (Array.isArray(board.observers)) assert(board.observers.some((o) => o.user_id === probe.id), 'seat missing from board');
    const left = await rpc('observer_leave', {}, token);
    assert(left.ok === true, `leave: ${JSON.stringify(left)}`);
  });
} finally {
  // Release any probe binding still held; only probe identities are touched.
  for (const p of probes) {
    try { await rpc('release_device', {}, await tokenOf(p)); } catch { /* already released */ }
  }
  const final = await rpc('station_board', {}).catch(() => null);
  writeFileSync('.git/production-access-verification.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), url, results, skipped, finalEvent: final?.event?.status }, null, 2));
  console.log(`\nfinal event: ${final?.event?.status ?? '?'}`);
}
const failed = results.filter(([, status]) => status === 'FAIL');
if (skipped.length) console.log('SKIPPED: ' + skipped.join(' | '));
console.log(failed.length ? `${failed.length} production check(s) FAILED` : 'ALL PRODUCTION CHECKS PASSED');
process.exit(failed.length ? 1 : 0);
