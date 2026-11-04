#!/usr/bin/env node
/* Recovery bind for the 0014 deadlock: the deployed V3.1 UI cannot render a
 * 0014 board, so no operator device can tap a seat. This script performs the
 * SAME authenticated calls a working phone would make — a real Supabase
 * anonymous session, then public.claim_station through PostgREST — creating a
 * genuine new binding, never a forged one.
 *
 * Run: node --env-file=.env.local scripts/recover-bind.mjs
 *
 * Guards: production project URL is pinned; the seat must be free BEFORE the
 * call (an on-duty device is never evicted); read-only board evidence is
 * printed before and after. No round, clock or reset state is touched here. */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const PRODUCTION_URL = 'https://efsamoxceegkrwucpqkq.supabase.co';
const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !anon) throw new Error('requires --env-file=.env.local');
if (url.replace(/\/$/, '') !== PRODUCTION_URL) {
  throw new Error(`TargetGuard: expected production URL ${PRODUCTION_URL}, got ${url}`);
}

const role = (process.argv[2] || 'GATE').toUpperCase();
if (!['LOBBY', 'GATE', 'CORRIDOR', 'ROOM305'].includes(role)) {
  throw new Error('Recovery bind supports an NPC duty seat (LOBBY/GATE/CORRIDOR/ROOM305); SUPERVISOR is gated by PIN at 0014 and is not needed to finalise the round.');
}

const client = createClient(url, anon, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const board = async (label) => {
  const { data, error } = await client.rpc('station_board');
  if (error) throw new Error(`station_board ${label}: ${error.message}`);
  const seats = board_summary(data);
  console.log(`${label}: event=${data.event?.status ?? data.status ?? '?'} ${seats}`);
  return data;
};
const board_summary = (data) => (data.stations || data.npc || [])
  .map((s) => `${s.role}:${s.devices ?? (s.occupied ? 1 : 0)}`).join(' ');

const before = await board('board BEFORE');
const target = (before.stations || []).find((s) => s.role === role);
if (target && target.devices > 0) {
  console.log(`Position ${role} already has a live device — nothing to recover. If it is your own phone, run close-rounds.ps1 directly.`);
  process.exit(0);
}

const { data: signed, error: signError } = await client.auth.signInAnonymously();
if (signError) throw new Error(`anonymous sign-in refused: ${signError.message}`);
console.log('signed in with a new authenticated session (real GoTrue identity)');

const { data: claimed, error: claimError } = await client.rpc('claim_station', { p_role: role, p_pin: null });
if (claimError) throw new Error(`claim_station: ${claimError.message}`);
console.log(`claim ${role} ->`, JSON.stringify(claimed));
if (!claimed?.ok) throw new Error(`The machine refused the claim (${claimed?.code}). Nothing was bound.`);

// Persist this session's tokens ONLY in the git-ignored .audit-tmp store, so the
// same real identity can act again later (RESET_DONE sign-offs). Nothing is
// printed; refresh tokens are credentials and must never enter chat or logs.
if (signed?.session) {
  mkdirSync('.audit-tmp', { recursive: true });
  const store = '.audit-tmp/recovery-sessions.json';
  let sessions = {};
  try { sessions = JSON.parse(readFileSync(store, 'utf8')); } catch { /* first entry */ }
  sessions[role] = {
    user_id: signed.session.user?.id,
    refresh_token: signed.session.refresh_token,
    bound_at: new Date().toISOString(),
  };
  writeFileSync(store, JSON.stringify(sessions, null, 1));
  console.log(`session stored (local, git-ignored) for user_id ${signed.session.user?.id}`);
}

await board('board AFTER');
console.log('');
console.log('Recovery binding is LIVE. Now run, in order:');
console.log('  1) powershell -ExecutionPolicy Bypass -File .\\scripts\\close-rounds.ps1   (finalise round #2 through the state machine)');
console.log('  2) powershell -ExecutionPolicy Bypass -File .\\scripts\\preflight-helper.ps1  (must print SAFE)');
console.log('  3) powershell -ExecutionPolicy Bypass -File .\\scripts\\db-push.ps1           (backup + migration 0015-0017)');
console.log('After the upgrade, the organiser device claims SUPERVISOR via /admin + allow-list, and a normal Reset All sweeps every seat including this recovery one.');
