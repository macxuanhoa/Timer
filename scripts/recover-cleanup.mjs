#!/usr/bin/env node
/* Release ONLY the recovery bindings this agent created (stored sessions from
 * recover-bind / supervisor-recovery). Each release runs as that same real
 * session through public.release_device — the identical action a phone would
 * take when an operator walks away. The organiser's own pre-existing device
 * bindings are not in the store and are therefore never touched.
 * Run AFTER the V3.2 deploy: node --env-file=.env.local scripts/recover-cleanup.mjs */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const PRODUCTION_URL = 'https://efsamoxceegkrwucpqkq.supabase.co';
const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !anon) throw new Error('requires --env-file=.env.local');
if (url.replace(/\/$/, '') !== PRODUCTION_URL) throw new Error(`TargetGuard: ${url}`);

const store = JSON.parse(readFileSync('.audit-tmp/recovery-sessions.json', 'utf8'));
for (const [role, sess] of Object.entries(store)) {
  if (!sess.refresh_token) { console.log(`${role}: no stored session — skipped`); continue; }
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.refreshSession({ refresh_token: sess.refresh_token });
  if (error) { console.log(`${role}: refresh failed (${error.message}) — binding left as-is`); continue; }
  const { data: released, error: relErr } = await client.rpc('release_device');
  console.log(`${role} (${sess.user_id}) ->`, relErr ? relErr.message : JSON.stringify(released));
  if (!relErr) delete store[role];
}
const { writeFileSync } = await import('node:fs');
writeFileSync('.audit-tmp/recovery-sessions.json', JSON.stringify(store, null, 1));
const { data: board } = await createClient(url, anon, { auth: { persistSession: false } })
  .rpc('station_board');
console.log('board after cleanup: devices', board.devices, '/', board.device_capacity,
  '|', (board.stations || []).map((s) => `${s.role}:${s.devices}`).join(' '));
