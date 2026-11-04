#!/usr/bin/env node
/* SUPERVISOR recovery for the 0014 deadlock — the ONLY sign-off channel the
 * organiser authorised: a real GoTrue session that claims the SUPERVISOR seat
 * with the organiser's own PIN (verified server-side by bcrypt), then confirms
 * every open reset task explicitly by task_key, finalises the gate and ends the
 * event through the production machine. Each step is one audited action_log row
 * under the supervisor identity; nothing is marked on behalf of duty staff
 * silently, nothing is edited in SQL, nothing bypasses a machine check.
 *
 * Run through scripts/supervisor-recovery.ps1 (hidden PIN prompt).
 *
 * PIN rule as enforced at 0014 (0010 body): 8-12 digits; refusals are counted
 * (5 per identity / 30 global per 15 min), so the client-side format check
 * exists only to avoid burning an attempt on a typo. */
import { createClient } from '@supabase/supabase-js';
import { connect } from './lib/pooler.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const PRODUCTION_URL = 'https://efsamoxceegkrwucpqkq.supabase.co';
const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !anon) throw new Error('run via supervisor-recovery.ps1 (needs VITE_SUPABASE_URL + ANON from .env.local)');
if (url.replace(/\/$/, '') !== PRODUCTION_URL) throw new Error(`TargetGuard: expected ${PRODUCTION_URL}, got ${url}`);
if (process.env.SC_CONFIRM_PHYSICAL_RESET !== 'yes') throw new Error('Physical reset not confirmed.');
const reason = (process.env.SC_END_REASON || '').trim();
if (!reason) throw new Error('SC_END_REASON is required and lands in the END_EVENT audit.');

const pin = process.env.SC_SUP_PIN || '';
delete process.env.SC_SUP_PIN;
if (!/^[0-9]{8,12}$/.test(pin)) throw new Error('Supervisor PIN must be 8-12 digits (checked locally first so a typo costs no server attempt).');

// ---- read-only state from the database owner session ------------------------
const db = await connect();
let state;
try {
  const { rows } = await db.query(`
    select e.id as event_id, e.revision, e.event_ended_at is not null as ended,
           (select jsonb_agg(jsonb_build_object('round', r.team_number, 'task', t.task_key, 'role', t.required_role))
              from sc.reset_tasks t join sc.rounds r on r.id = t.round_id
             where t.completed_at is null or t.cycle <> r.reset_cycle) as open_tasks,
           (select jsonb_agg(jsonb_build_object('round', r.team_number, 'status', r.status))
              from sc.rounds r where r.status <> 'CLOSED') as open_rounds
    from sc.events e join sc.state st on st.id where e.id = st.event_id`);
  if (!rows.length) throw new Error('no active event row in sc.state');
  state = rows[0];
} finally {
  await db.end().catch(() => undefined);
}
console.log('read-only state:', JSON.stringify({ revision: state.revision, ended: state.ended, open_rounds: state.open_rounds, open_tasks: state.open_tasks }));

const tasks = (state.open_tasks ?? []).map((t) => t.task);
if (state.ended) { console.log('event already ended — skipping END_EVENT'); }
if (!tasks.length) console.log('note: no open reset tasks found; the sign-off loop will be empty.');

// ---- real authenticated session: claim SUPERVISOR with the organiser's PIN --
const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const { data: signed, error: signError } = await client.auth.signInAnonymously();
if (signError) throw new Error(`anonymous sign-in refused: ${signError.message}`);
const { data: claim, error: claimError } = await client.rpc('claim_station', { p_role: 'SUPERVISOR', p_pin: pin });
if (claimError) throw new Error(`claim_station rpc: ${claimError.message}`);
console.log('claim SUPERVISOR ->', JSON.stringify(claim));
if (claim?.ok !== true) {
  if (claim?.code === 'PIN_INVALID') throw new Error('PIN refused by the server (one attempt counted: max 5 per identity / 30 global per 15 min). Re-run with the correct PIN.');
  throw new Error(`SUPERVISOR claim refused: ${claim?.code}`);
}
if (signed?.session) {
  mkdirSync('.audit-tmp', { recursive: true });
  const store = '.audit-tmp/recovery-sessions.json';
  let sessions = {};
  try { sessions = JSON.parse(readFileSync(store, 'utf8')); } catch { /* first */ }
  sessions.SUPERVISOR = { user_id: signed.session.user?.id, refresh_token: signed.session.refresh_token, bound_at: new Date().toISOString() };
  writeFileSync(store, JSON.stringify(sessions, null, 1));
}

let revision = Number(state.revision);
const call = async (action, meta) => {
  const { data, error } = await client.rpc('handle_command', {
    p_action: action, p_meta: meta ?? {}, p_expected_revision: revision, p_idempotency_key: crypto.randomUUID(),
  });
  if (error) throw new Error(`${action} rpc: ${error.message}`);
  console.log(`${action} ->`, JSON.stringify(data));
  if (data?.ok !== true) throw new Error(`machine refused ${action}: ${data?.code ?? '?'}`);
  if (typeof data.revision === 'number') revision = data.revision;
  return data;
};

for (const task of tasks) await call('RESET_DONE', { task_key: task });
await call('GATE_FINALIZE', {});
if (!state.ended) await call('END_EVENT', { reason });

// ---- final read-only confirmation --------------------------------------------
const db2 = await connect();
try {
  const { rows } = await db2.query(`
    select (select string_agg(status, ',' order by id) from sc.rounds) as rounds,
           (select count(*) from sc.reset_tasks where completed_at is null) as open_tasks,
           (select event_ended_at is not null from sc.events where id = (select event_id from sc.state where id)) as ended,
           (select count(*) from sc.action_log) as action_rows`);
  console.log('FINAL:', JSON.stringify(rows[0]));
  console.log('Next: preflight-helper.ps1 (must print SAFE), then db-push.ps1.');
} finally {
  await db2.end().catch(() => undefined);
}
