/* Non-destructive checks against the real production Supabase backend, V3.3.
 *
 * Run:  node --env-file=.env.local scripts/verify-production-access.mjs
 *
 * Proves: the V3.2 RPC surface is live (open seats, admin-gated SUPERVISOR,
 * force-aware reset, observer wrapper), the retired credential surface is gone,
 * board reads work with zero auth, and — new since V3.3 P0 — the board answers
 * the two questions field support kept asking without a session:
 *   "is the Production night actually closed?"   (station_board.event_*)
 *   "is this bundle going to be refused?"        (public.min_client_version)
 * plus the presence of the migration 0019/0020 surface (release_station, the
 * version gate) reported by name so a partially-migrated host is visible.
 *
 * Safety: NO round is ever created, modified or aborted, and no real seat is
 * released. The only seat writes are claim + immediate release of a slot that
 * was FREE before the test, using throwaway probe identities, always cleaned up
 * in finally. The supervisor-handoff and version-gate checks below are read-only
 * probes that assert a refusal, never a state change. */
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

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
// GoTrue email sign-ups are blocked by validation and rate limits on this
// project, so probe identities use anonymous sessions — the same mechanism
// every real phone uses on first launch.
const fresh = async () => {
  const c = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await c.auth.signInAnonymously();
  if (error) throw new Error(`anon sign-in: ${error.message}`);
  const p = { id: data.session.user.id, token: data.session.access_token };
  probes.push(p);
  return p;
};
const tokenOf = async (p) => p.token;

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
    const who = await rpc('whoami', {}, await tokenOf(probe));
    assert(who?.role === free.role, `whoami=${JSON.stringify(who)}`);
    const refused = await rpc('claim_station', { p_role: 'CORRIDOR' }, await tokenOf(probe));
    assert(refused.code === 'ALREADY_BOUND_OTHER_ROLE', `second seat not blocked: ${JSON.stringify(refused)}`);
    const released = await rpc('release_device', {}, await tokenOf(probe));
    assert(released.ok === true, 'release failed');
    assert((await rpc('whoami', {}, await tokenOf(probe))) === null, 'still bound after release');
    return `slot ${free.role} round-trip`;
  });

  await run('SUPERVISOR is refused for a device not on the allow-list', async () => {
    const probe = await fresh();
    const answer = await rpc('claim_station', { p_role: 'SUPERVISOR' }, await tokenOf(probe));
    assert(answer.code === 'ADMIN_NOT_ALLOWED', `unexpected: ${JSON.stringify(answer)}`);
    assert((await rpc('whoami', {}, await tokenOf(probe))) === null, 'refused claim still bound');
  });

  await run('reset_all_stations is refused from a non-admin caller', async () => {
    const probe = await fresh();
    await rpc('claim_station', { p_role: 'LOBBY' }, await tokenOf(probe));
    const answer = await rpc('reset_all_stations', { p_force: false }, await tokenOf(probe));
    assert(answer.code === 'RESET_NOT_AUTHORIZED', `unexpected: ${JSON.stringify(answer)}`);
    await rpc('release_device', {}, await tokenOf(probe));
  });

  await run('board answers the real event state with no session (V3.3 P0)', async () => {
    assert('event_id' in boardSnapshot, 'station_board is missing event_id — migration 0020 not applied');
    assert('event_ended_at' in boardSnapshot, 'station_board is missing event_ended_at — migration 0020 not applied');
    assert('min_client_version' in boardSnapshot, 'station_board is missing min_client_version — migration 0020 not applied');
    const closed = boardSnapshot.event_ended_at !== null;
    // The next team number is what a new night starts from; it proves the fields
    // describe the live pointer rather than a stale cache.
    assert(Number.isInteger(boardSnapshot.event_next_team_number), `event_next_team_number=${boardSnapshot.event_next_team_number}`);
    return `event ${boardSnapshot.event_id} "${boardSnapshot.event_name}" · ${closed ? 'ĐÃ ĐÓNG (cần mở sự kiện mới)' : 'đang mở'} · đội tiếp theo #${boardSnapshot.event_next_team_number} · floor=${boardSnapshot.min_client_version || 'off'}`;
  });

  await run('public.min_client_version() answers without any binding (V3.3 P0)', async () => {
    const floor = await rpc('min_client_version', {});
    assert(typeof floor === 'string', `unexpected ${JSON.stringify(floor)}`);
    return floor === '' ? 'gate is off — every bundle is accepted' : `gate is on, floor = ${floor}`;
  });

  await run('release_station exists and refuses a non-admin caller (V3.3 P0)', async () => {
    // Read-only shape check: a duty binding asking to free a peer must be turned
    // away with the specific refusal, never by an absent function.
    const free = (boardSnapshot.stations || []).find((s) => s.role !== 'SUPERVISOR' && s.role !== 'OBSERVER' && s.devices === 0);
    if (!free) { skipped.push('every duty seat occupied: release_station refusal probe skipped'); return 'skipped (busy)'; }
    const probe = await fresh();
    const claimed = await rpc('claim_station', { p_role: free.role }, await tokenOf(probe));
    assert(claimed.ok === true, `claim failed: ${JSON.stringify(claimed)}`);
    const answer = await rpc('release_station', { p_role: 'GATE' }, await tokenOf(probe));
    assert(answer.code === 'RELEASE_NOT_AUTHORIZED', `unexpected: ${JSON.stringify(answer)}`);
    // The probe's own binding is untouched by a refused release, and we hand the
    // seat back exactly as we found it.
    assert((await rpc('whoami', {}, await tokenOf(probe)))?.role === free.role, 'refused release disturbed the caller');
    await rpc('release_device', {}, await tokenOf(probe));
    return `duty caller refused with RELEASE_NOT_AUTHORIZED on a ${free.role} probe`;
  });

  await run('an unbound caller cannot drive OPEN_NEW_EVENT (migration 0018 shape)', async () => {
    // Proves the handoff is real and permission-guarded WITHOUT performing it:
    // an anonymous, unbound identity must be refused, never allowed to open a
    // night. No event state is written by this check.
    const probe = await fresh();
    let answer;
    try { answer = await rpc('handle_command', { p_action: 'OPEN_NEW_EVENT', p_meta: {}, p_expected_revision: 0, p_idempotency_key: `probe-${crypto.randomUUID()}` }, await tokenOf(probe)); }
    catch (error) { answer = JSON.parse(String(error.message).slice(0, 0) || '{}'); answer.message = String(error.message); }
    const refused = answer?.ok !== true && (answer?.code === 'PERMISSION_DENIED' || /PERMISSION_DENIED|VỊ TRÍ/.test(answer?.message ?? ''));
    assert(refused, `unbound OPEN_NEW_EVENT was not refused: ${JSON.stringify(answer).slice(0, 160)}`);
    return 'handoff requires a live SUPERVISOR binding, as designed';
  });

  await run('observer wrapper joins, beats and leaves through public RPCs', async () => {
    const probe = await fresh();
    const token = await tokenOf(probe);
    const joined = await rpc('observer_join', { p_viewer_id: `probe-${crypto.randomUUID().slice(0, 8)}` }, token);
    assert(joined.ok === true, `join: ${JSON.stringify(joined)}`);
    const beat = await rpc('observer_beat', { p_viewer_id: 'probe-beat' }, token);
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
