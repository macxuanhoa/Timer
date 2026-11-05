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
 * V3.2 removes every typed secret: the four operating seats and the viewer seat
 * bind with no credential at all. The only gated seat is the retained admin, and
 * it is gated by an allow-list table — --allow-admin-device records one device
 * uuid there, which is an identifier the /admin screen shows, not a secret.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './lib/pooler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const baseline = process.argv.includes('--baseline');
const singleUrl = process.argv.includes('--single-url');
const allowAdminDevice = process.argv.includes('--allow-admin-device');
const reportPath = path.join(root, '.git', 'production-migration.json');

async function fingerprint(client) {
  // Business rows must survive the upgrade intact, but 0016 legitimately rewrites
  // the status vocabulary and 0017 drops credential columns: comparing whole-row
  // hashes would fail on every real upgrade. So the fingerprint pins the IDENTITY
  // of each row set — counts and primary keys — not column values.
  const sets = [
    ['events', "select count(*)::int as count, md5(string_agg(id::text, ',' order by id)) as hash from sc.events"],
    ['rounds', "select count(*)::int as count, md5(string_agg(id::text, ',' order by id)) as hash from sc.rounds"],
    ['action_log', "select count(*)::int as count, md5(string_agg(seq::text, ',' order by seq)) as hash from sc.action_log"],
    ['reset_tasks', "select count(*)::int as count, md5(string_agg(round_id::text || '/' || task_key, ',' order by round_id, task_key)) as hash from sc.reset_tasks"],
    ['state', 'select count(*)::int as count, md5(string_agg(event_id::text, \',\' order by event_id)) as hash from sc.state'],
  ];
  const out = {};
  for (const [table, sql] of sets) {
    try { out[table] = (await client.query(sql)).rows[0]; }
    catch { out[table] = { count: 0, hash: null }; }
  }
  const { rows } = await client.query(`select count(*)::int as count,
    md5(coalesce(string_agg(user_id::text || '/' || role, ',' order by user_id, role), '')) as hash
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
      // V3.2+ follow-up: adds the SUPERVISOR OPEN_NEW_EVENT action so a shift can
      // hand the room to the next one without SQL surgery. Forward-only and
      // history-preserving — every existing sc.events row and every audit entry
      // stays exactly where it was.
      '0018_open_new_event.sql',
      // V3.3 operations: per-seat supervisor release (fixes the stuck-NPC1 case)
      // plus the forced-update version gate inside sc.handle_command. Two partial
      // indexes back the live-round and outstanding-task probes. No rewrite of
      // any historical row.
      '0019_v33_operations.sql',
      // V3.3 P0 diagnostics: the public board now carries the event's real state
      // and the version floor (so "ĐANG ĐỒNG BỘ" and "the night is closed" are
      // distinguishable without a session), plus public.min_client_version().
      // Additive to the board payload; board_version stays 3.
      '0020_v33_board_diagnostics.sql',
      // V3.3 P0: sc.station_admin() (who holds which seat) and the live-round
      // guard on sc.release_station(). Additive RPC surface plus one function
      // redefinition; no table, no data and no grant broadened.
      '0021_v33_seat_management.sql',
    ]);
    if (singleUrl && pending.some(f => !allowed.has(f))) throw new Error('Unexpected pending migration; review required.');
    // V3.2: no secret is ever typed, stored or hashed. The one optional set-up act
    // is recording an organiser device uuid on the admin allow-list; SC_ADMIN_DEVICE
    // carries an identifier the /admin screen displays, so nothing secret is kept in
    // argv or history (the ps1 reads it through a hidden prompt for tidiness only).
    let adminDevice = null;
    if (allowAdminDevice) {
      adminDevice = (process.env.SC_ADMIN_DEVICE ?? '').trim().toLowerCase();
      delete process.env.SC_ADMIN_DEVICE;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(adminDevice)) {
        throw new Error('SC_ADMIN_DEVICE must be a device uuid shown by the /admin screen (8-4-4-4-12 hex).');
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
      // Postgres analyses every table name at parse time, so sc.completion_attempts
      // (created by 0016) may only be queried once the probe says it exists — never
      // behind a CASE arm. An active round is never judged ready by exit_confirmed_at
      // alone: crew verification and pending claims are reported too. A legacy
      // GATE_CLEARED round that was already finalised is NOT live — the floor is idle
      // and 0016's own upgrade maps it to CLOSED — so it does not block the migration.
      if (schemaExists) {
        const { rows: relRows } = await client.query(
          "select to_regclass('sc.completion_attempts') is not null as has_attempts");
        const live = (await client.query(relRows[0].has_attempts ? `
          select r.id, r.team_number, r.status,
                 (select count(*) from sc.completion_attempts a
                    where a.round_id = r.id and a.status in ('PENDING','LATE'))
                   as pending_claims
          from sc.rounds r
          where r.status <> 'CLOSED'
            and not (r.status = 'GATE_CLEARED' and r.system_ready_at is not null)
          order by r.id` : `
          select r.id, r.team_number, r.status, 0::bigint as pending_claims
          from sc.rounds r
          where r.status <> 'CLOSED'
            and not (r.status = 'GATE_CLEARED' and r.system_ready_at is not null)
          order by r.id`)).rows;
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
        // The upgrade rewrites several tables: reading them in share mode proves the
        // fingerprint covers the bindings and seats that must survive. Tables created
        // by the pending migrations themselves cannot be locked yet, so lock only
        // relations that exist right now — built from a catalogue probe, not a literal.
        const { rows: existRows } = await client.query(`
          select name, to_regclass('sc.' || name) is not null as present
          from unnest(array['events','rounds','action_log','reset_tasks','state',
                            'completion_attempts','observer_seats']) as name`);
        const lockTargets = existRows.filter((r) => r.present).map((r) => `sc.${r.name}`).join(', ');
        if (lockTargets) await client.query(`lock table ${lockTargets} in share mode`);
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
      if (adminDevice) {
        // Idempotent: re-running with the same uuid just refreshes the note.
        await client.query(
          'insert into sc.admin_devices (user_id, note) values ($1, $2) on conflict (user_id) do update set note = excluded.note',
          [adminDevice, 'db-push'],
        );
        console.log('staged admin device on the allow-list');
      }
      if (singleUrl) {
        report.after = await fingerprint(client);
        if (JSON.stringify(report.before) !== JSON.stringify(report.after)) throw new Error('Event data or duty bindings changed; rolling back.');
        report.occupancy = (await client.query('select sc.station_board() as board')).rows[0].board;
        // Every retired function may be absent, and has_function_privilege('name(sig)')
        // raises on a missing function — so walk pg_proc instead: whatever exists must
        // follow the V3.2 rule, and the two public wrappers must be executable.
        const { rows } = await client.query(`
          select
            coalesce(bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) filter (where
              (n.nspname = 'public' and p.proname in ('redeem_invitation', 'accept_invitation'))
              or (n.nspname = 'sc' and p.proname in ('configure_station_access', 'configure_station_reset',
                    'configure_station_code', 'claim_station', 'reset_all_stations'))), false) as internal_exposed,
            coalesce(bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) filter (where
              n.nspname = 'public' and p.proname in ('reset_all_stations', 'claim_station', 'handle_command')),
              false) as anon_exposed,
            coalesce(bool_or(true) filter (where n.nspname = 'public'
              and p.proname = 'reset_all_stations'
              and has_function_privilege('authenticated', p.oid, 'EXECUTE')), false) as reset_granted,
            coalesce(bool_or(true) filter (where n.nspname = 'public'
              and p.proname = 'claim_station'
              and has_function_privilege('authenticated', p.oid, 'EXECUTE')), false) as claim_granted,
            coalesce(bool_or(has_column_privilege('authenticated', 'sc.admin_devices'::regclass, 'user_id', 'SELECT'))
              filter (where to_regclass('sc.admin_devices') is not null), false) as allowlist_readable
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'sc')`);
        if (rows[0].internal_exposed || rows[0].anon_exposed
          || !rows[0].reset_granted || !rows[0].claim_granted || rows[0].allowlist_readable) {
          throw new Error(`Unsafe access grants; rolling back. ${JSON.stringify(rows[0])}`);
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
