#!/usr/bin/env node
/**
 * Apply supabase/migrations/*.sql to the hosted Supabase database.
 *
 * The direct host (db.<ref>.supabase.co) only publishes an AAAA record, so the
 * connection fails on networks without IPv6 and inside Docker. This script goes
 * through the Supavisor pooler instead, which is dual-stack.
 *
 * The password is read from PGPASSWORD so it never lands in argv or in the shell
 * history — scripts/db-push.ps1 prompts for it without echoing.
 *
 *   npm run db:push              apply every migration not yet recorded
 *   npm run db:push -- --baseline  record 0001_init.sql as already applied
 *
 * Env overrides: SUPABASE_PROJECT_REF, SUPABASE_REGION.
 * The supervisor PIN, the station reset secret and the four crew codes are read from
 * the environment only when the matching flag is set, and are installed as bcrypt
 * hashes — the values themselves never reach a table, a log, a file or the browser.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './lib/pooler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const baseline = process.argv.includes('--baseline');
const singleUrl = process.argv.includes('--single-url');
const configurePin = process.argv.includes('--configure-supervisor-pin');
const configureReset = process.argv.includes('--configure-station-reset');
const configureCodes = process.argv.includes('--configure-station-codes');
const reportPath = path.join(root, '.git', 'production-migration.json');

async function fingerprint(client) {
  const out = {};
  for (const table of ['events', 'rounds', 'action_log', 'reset_tasks', 'state']) {
    const { rows } = await client.query(`select count(*)::int as count,
      md5(coalesce(string_agg(row_hash, ',' order by row_hash), '')) as hash
      from (select md5(to_jsonb(t)::text) as row_hash from sc.${table} t) q`);
    out[table] = rows[0];
  }
  const { rows } = await client.query(`select count(*)::int as count,
    md5(coalesce(string_agg(user_id::text || role || display_name || bound_at::text || coalesce(device_id,''), ',' order by user_id),'')) as hash
    from sc.operators where revoked_at is null`);
  out.active_bindings = rows[0];
  return out;
}

async function main() {
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql') && /^\d+_/.test(name))
    .sort();

  const client = await connect();
  try {
    const { rows: who } = await client.query('select current_user, version() as version');
    console.log(`${who[0].version.split(',')[0]} · user ${who[0].current_user}`);

    await client.query(`
      create table if not exists public._sc_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )`);

    const { rows: done } = await client.query('select name from public._sc_migrations');
    const applied = new Set(done.map((row) => row.name));
    const { rows: existing } = await client.query("select to_regclass('sc.rounds') as rounds");
    const schemaExists = existing[0].rounds !== null;

    if (schemaExists && applied.size === 0 && !baseline && files.length > 0) {
      console.error('\nThe sc.* schema already exists but no migration is recorded here.');
      console.error('If it was created from these same files, re-run with --baseline so 0001 is not applied twice.');
      console.error('  npm run db:push -- --baseline\n');
      process.exitCode = 1;
      return;
    }

    if (baseline && applied.size === 0) {
      await client.query('insert into public._sc_migrations (name) values ($1) on conflict do nothing', [
        files[0],
      ]);
      applied.add(files[0]);
      console.log(`baseline: ${files[0]} recorded as already applied`);
    }

    const pending = files.filter(name => !applied.has(name));
    if (singleUrl && (!schemaExists || files.filter(f => /^000[1-7]_/.test(f)).some(f => !applied.has(f)))) {
      throw new Error('Single-URL deployment requires the existing 0001–0007 ledger. Refusing to replay historical migrations.');
    }
    const allowed = new Set([
      '0008_supervisor_pair.sql',
      '0009_board_capacity.sql',
      '0010_single_url_roles.sql',
      '0011_command_press_integer.sql',
      '0012_round_clock_only.sql',
      '0013_team_name.sql',
      '0014_station_reset.sql',
      '0015_reset_guard.sql',
      '0016_unified_flow.sql',
      '0017_v31_hardening.sql',
    ]);
    if (singleUrl && pending.some(f => !allowed.has(f))) throw new Error('Unexpected pending migration; review required.');
    const pin = configurePin ? process.env.SC_SUPERVISOR_PIN : null;
    delete process.env.SC_SUPERVISOR_PIN;
    if (configurePin && !/^\d{8,12}$/.test(pin ?? '')) throw new Error('An 8–12 digit PIN is required through the hidden prompt.');
    const resetSecret = configureReset ? process.env.SC_STATION_RESET_SECRET : null;
    delete process.env.SC_STATION_RESET_SECRET;
    const resetLength = (resetSecret ?? '').length;
    if (configureReset && (resetLength < 10 || resetLength > 64)) {
      throw new Error('The station reset secret must be 10–64 characters, entered through the hidden prompt.');
    }
    // Crew codes arrive as one JSON map from the hidden prompts; each value is a
    // 4–12 character A–Z0–9 code for exactly one operating position (§5.3).
    let codes = null;
    if (configureCodes) {
      const raw = process.env.SC_STATION_CODES;
      delete process.env.SC_STATION_CODES;
      try { codes = JSON.parse(raw ?? ''); } catch { codes = null; }
      const entries = Object.entries(codes ?? {});
      if (entries.length !== 4 || !['LOBBY', 'CORRIDOR', 'GATE', 'ROOM305'].every(r => entries.some(([k]) => k === r))) {
        throw new Error('All four crew codes (LOBBY, CORRIDOR, GATE, ROOM305) must be provided.');
      }
      for (const [role, code] of entries) {
        if (!/^[A-Z0-9]{4,12}$/.test(String(code ?? '').toUpperCase())) {
          throw new Error(`The crew code for ${role} must be 4–12 characters of A-Z or 0-9.`);
        }
      }
    }
    const report = { status: 'pending', at: new Date().toISOString(), pending };
    await client.query('begin');
    try {
      await client.query("set local lock_timeout = '8s'; set local statement_timeout = '120s'");
      await client.query('select pg_advisory_xact_lock(30501)');
      // Safety: refuse to migrate while an event is running. The advisory lock
      // serialises against claim_station/reset_all_stations, but not against a
      // half-open round. If sc.rounds is not yet present (a fresh DB), skip.
      if (schemaExists) {
        const { rows: live } = await client.query(`
          select r.id, r.team_number, r.status,
                 case when to_regclass('sc.completion_attempts') is null then 0
                      else (select count(*) from sc.completion_attempts a
                             where a.round_id = r.id and a.status in ('PENDING','LATE')) end
                   as pending_claims
          from sc.rounds r where r.status <> 'CLOSED' order by r.id`);
        if (live.length) {
          const detail = live.map(r => `#${r.team_number} ${r.status}${r.pending_claims > 0 ? ` (${r.pending_claims} pending)` : ''}`).join(', ');
          throw new Error(`Refusing to migrate: ${live.length} round(s) still open — ${detail}. Đóng sự kiện và reset xong trước khi chạy db-push.`);
        }
        console.log('Safety check: no active round, no pending claim.');
      }
      if (singleUrl) {
        const { rows: flags } = await client.query('select allow_test_clock from sc.runtime_flags where id');
        if (flags[0]?.allow_test_clock !== false) throw new Error('Production test clock is enabled; review required.');
        await client.query('lock table sc.operators in share row exclusive mode');
        // The unified flow adds two tables the upgrade itself rewrites: reading them in
        // share mode proves the fingerprint covers the claims and seats that must survive.
        await client.query(
          'lock table sc.events, sc.rounds, sc.action_log, sc.reset_tasks, sc.state, sc.completion_attempts, sc.observer_seats in share mode',
        );
        report.before = await fingerprint(client);
        console.log('Production baseline:', JSON.stringify(report.before));
      }
      // All pending files commit together. Old invitation grants are disabled
      // in the same transaction that enables role selection and the second seat.
      for (const name of pending) {
        const sql = await readFile(path.join(migrationsDir, name), 'utf8');
        await client.query(sql);
        await client.query('insert into public._sc_migrations (name) values ($1)', [name]);
        console.log(`staged ${name}`);
      }
      if (configurePin) await client.query('select sc.configure_station_access($1, false)', [pin]);
      // Hashes only: the secret itself is never written to a table, log or file.
      if (configureReset) await client.query('select sc.configure_station_reset($1)', [resetSecret]);
      // Hashes only, and never the same code twice in the same statement text.
      for (const [role, code] of Object.entries(codes ?? {})) {
        await client.query('select sc.configure_station_code($1, $2)', [role, String(code).toUpperCase()]);
        console.log(`staged crew code for ${role}`);
      }
      if (singleUrl) {
        report.after = await fingerprint(client);
        if (JSON.stringify(report.before) !== JSON.stringify(report.after)) throw new Error('Event data or duty bindings changed; rolling back.');
        report.occupancy = (await client.query('select sc.station_board() as board')).rows[0].board;
        const { rows } = await client.query(`select
          has_function_privilege('authenticated','public.redeem_invitation(text,text)','EXECUTE') as legacy,
          has_function_privilege('authenticated','sc.configure_station_access(text,boolean)','EXECUTE') as pin_exposed,
          has_function_privilege('authenticated','sc.reset_all_stations(text)','EXECUTE') as reset_exposed,
          has_function_privilege('authenticated','sc.configure_station_code(text,text)','EXECUTE') as codes_exposed,
          has_function_privilege('authenticated','sc.station_code_state()','EXECUTE') as codes_listed,
          has_function_privilege('anon','public.reset_all_stations(text)','EXECUTE') as reset_unsigned,
          has_function_privilege('authenticated','public.reset_all_stations(text)','EXECUTE') as reset_granted`);
        if (rows[0].legacy || rows[0].pin_exposed || rows[0].reset_exposed || rows[0].reset_unsigned || !rows[0].reset_granted
          || rows[0].codes_exposed || rows[0].codes_listed) {
          throw new Error('Unsafe access grants; rolling back.');
        }
      }
      await client.query('commit');
      report.status = 'applied';
      if (singleUrl) await writeFile(reportPath, JSON.stringify(report, null, 2));
      console.log(`Committed ${pending.length} migration(s). Existing event data and duty devices preserved.`);
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      report.status = 'failed'; report.error = error.message;
      if (singleUrl) await writeFile(reportPath, JSON.stringify(report, null, 2));
      throw error;
    }

    const { rows: tables } = await client.query(
      "select table_name from information_schema.tables where table_schema = 'sc' order by 1",
    );
    const { rows: fns } = await client.query(
      "select count(*)::int as n from information_schema.routines where routine_schema = 'sc'",
    );
    const { rows: rev } = await client.query('select count(*)::int as n from sc.state');
    console.log(`\nsc tables: ${tables.map((row) => row.table_name).join(', ') || '(none)'}`);
    console.log(`sc functions: ${fns[0].n} · sc.state rows: ${rev[0].n}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  if (singleUrl) void writeFile(reportPath, JSON.stringify({ status: 'failed', at: new Date().toISOString(), error: error.message }, null, 2));
  process.exitCode = 1;
});
