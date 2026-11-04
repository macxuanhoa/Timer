// Validates the production PostgreSQL migrations and RPCs against a real
// Postgres 16 instance, using the local auth stub (never run the stub against a
// real Supabase project).
//
//   node scripts/validate-sql.mjs [--keep]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'sc305-pg-validate';
const DB = 'sc305_test';
const keep = process.argv.includes('--keep');

const docker = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });

const run = (label, files) => {
  process.stdout.write(`  ${label.padEnd(28, ' ')} `);
  const sql = files.map((f) => readFileSync(resolve(root, f), 'utf8')).join('\n');
  try {
    const out = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-q'], {
      input: sql,
    });
    console.log('ok');
    if (out.trim()) console.log(out.trim().replace(/^/gm, '      '));
  } catch (err) {
    console.log('FAILED');
    console.error(String(err.stdout ?? '') + String(err.stderr ?? ''));
    throw new Error(`${label} failed`);
  }
};

try {
  console.log(`Preparing Postgres 16 container (${NAME})…`);
  try {
    docker(['rm', '-f', NAME]);
  } catch {
    /* not running */
  }
  docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=postgres', 'postgres:16-alpine']);

  for (let i = 0; i < 60; i++) {
    try {
      docker(['exec', NAME, 'pg_isready', '-U', 'postgres']);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      if (i === 59) throw new Error('Postgres did not become ready');
    }
  }
  docker(['exec', NAME, 'createdb', '-U', 'postgres', DB]);

  console.log('Applying migrations and running the RPC scenario:');
  run('000 local auth stub', ['supabase/tests/000_local_auth_stub.sql']);
  run('001 schema + RLS', ['supabase/migrations/0001_init.sql']);
  run('002 authoritative RPCs', ['supabase/migrations/0002_rpc.sql']);
  run('003 flexible window upgrade', ['supabase/migrations/0003_clock_window.sql']);
  run('004 invitations + binding', ['supabase/migrations/0004_invitations.sql']);
  run('005 public API surface', ['supabase/migrations/0005_public_api.sql']);
  run('006 station board + lock', ['supabase/migrations/0006_station_board.sql']);
  run('007 permanent links', ['supabase/migrations/0007_permanent_links.sql']);
  run('008 supervisor pair', ['supabase/migrations/0008_supervisor_pair.sql']);
  run('009 board capacity', ['supabase/migrations/0009_board_capacity.sql']);
  run('010 five-operator scenario', ['supabase/tests/010_scenario.sql']);
  run('020 hardening scenario', ['supabase/tests/020_hardening.sql']);
  run('030 invitation scenario', ['supabase/tests/030_invitations.sql']);
  run('031 permanent links', ['supabase/tests/031_permanent_links.sql']);
  run('032 supervisor pair', ['supabase/tests/032_supervisor_pair.sql']);
  run('010 single root URL', ['supabase/migrations/0010_single_url_roles.sql']);
  run('033 role access + PIN + RLS', ['supabase/tests/033_single_url_roles.sql']);
  run('011 press instant normalisation', ['supabase/migrations/0011_command_press_integer.sql']);
  run('034 fractional press instants', ['supabase/tests/034_press_integer.sql']);
  run('012 round clock only', ['supabase/migrations/0012_round_clock_only.sql']);
  run('035 no event deadline', ['supabase/tests/035_round_clock_only.sql']);
  run('013 revisioned team labels', ['supabase/migrations/0013_team_name.sql']);
  run('036 team label scenario', ['supabase/tests/036_team_name.sql']);
  run('014 secret-gated board reset', ['supabase/migrations/0014_station_reset.sql']);
  run('037 board reset scenario', ['supabase/tests/037_station_reset.sql']);
  run('015 reset guard + area-staff-only checks', ['supabase/migrations/0015_reset_guard.sql']);
  run('038 reset guard scenario', ['supabase/tests/038_reset_guard.sql']);
  run('016 unified flow + observer seats', ['supabase/migrations/0016_unified_flow.sql']);
  run('039 unified flow scenario', ['supabase/tests/039_unified_flow.sql']);
  run('017 v3.1 hardening', ['supabase/migrations/0017_v31_hardening.sql']);
  run('040 v3.1 scenario', ['supabase/tests/040_v31_hardening.sql']);
  run('018 open new event', ['supabase/migrations/0018_open_new_event.sql']);
  run('041 open new event scenario', ['supabase/tests/041_open_new_event.sql']);
  console.log('\n✓ Production SQL validated: migrations, RLS and every state transition.');
} finally {
  if (!keep) {
    try {
      docker(['rm', '-f', NAME]);
    } catch {
      /* ignore */
    }
  } else {
    console.log(`Container kept: docker exec -it ${NAME} psql -U postgres -d ${DB}`);
  }
}
