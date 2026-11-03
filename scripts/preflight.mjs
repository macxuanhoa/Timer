#!/usr/bin/env node
// SCREAM CONTROL V3.1 pre-flight: đọc migration ledger + phát hiện lượt
// chơi đang chạy + pending claim. Nếu có bất kỳ hoạt động nào, KHÔNG migrate.
// Nếu sạch, in hướng dẫn db-push tương tác để chủ dự án tự chạy ở
// PowerShell thường (nơi Read-Host -AsSecureString hoạt động).
import { connect } from './lib/pooler.mjs';
import { writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const marker = resolve(root, '.audit-tmp/preflight.out');
const log = (line) => { const s = String(line); console.log(s); appendFileSync(marker, s + '\n'); };
writeFileSync(marker, '');

const client = await connect();
let hasActive = false;
try {
  log(`=== SCREAM CONTROL V3.1 pre-flight · ${new Date().toISOString()} ===`);

  const { rows: ver } = await client.query('select version(), current_database()');
  log('postgres: ' + ver[0].version.split(',')[0] + ' · db ' + ver[0].current_database);

  const { rows: ext } = await client.query("select extname from pg_extension where extname = 'pgcrypto'");
  log('pgcrypto: ' + (ext.length ? 'installed ✓' : 'MISSING — bcrypt cho crew codes/PIN sẽ fail'));

  const { rows: led } = await client.query('select name from public._sc_migrations order by name');
  const applied = new Set(led.map((r) => r.name));
  log(`\nLedger (${applied.size}/17 applied):`);
  for (const r of led) log('  ✓ ' + r.name);

  const { rows: files } = await client.query("select name from public._sc_migrations");
  // Enumerate pending by comparing with the migrations dir (from db-push.mjs pattern)
  const { readdirSync } = await import('node:fs');
  const all = readdirSync(resolve(root, 'supabase/migrations')).filter(n => /^\d+_.*\.sql$/.test(n)).sort();
  const pending = all.filter(n => !applied.has(n));
  log(`\nPending: ${pending.length ? pending.join(', ') : '(none — hosted đã 0017)'}`);

  const { rows: rounds } = await client.query(`
    select id, team_number, status, game_started_at, exit_confirmed_at, aborted_at
    from sc.rounds where status <> 'CLOSED' order by id`);
  log(`\nActive rounds (status <> CLOSED): ${rounds.length}`);
  for (const r of rounds) {
    log('  ' + JSON.stringify(r));
    hasActive = true;
  }

  const { rows: pendingClaims } = await client.query(`
    select a.id, a.round_id, a.seq, a.claimed_at, a.status
    from sc.completion_attempts a join sc.rounds r on r.id = a.round_id
    where a.status in ('PENDING','LATE') and r.status <> 'CLOSED'`);
  log(`\nPending claims on non-closed rounds: ${pendingClaims.length}`);
  for (const a of pendingClaims) log('  ' + JSON.stringify(a));
  if (pendingClaims.length) hasActive = true;

  const { rows: ops } = await client.query(`
    select role, seat_slot, display_name, bound_at from sc.operators
     where revoked_at is null order by role, seat_slot`);
  log(`\nLive bindings: ${ops.length}`);
  for (const o of ops) log('  ' + o.role + ' slot=' + o.seat_slot + ' bound ' + o.bound_at.toISOString() + ' by ' + o.display_name);

  if (hasActive) {
    log('\n*** DỪNG: có lượt chơi hoặc claim đang chạy. Không migrate. ***');
    log('Để sự kiện kết thúc (đội hiện tại đóng round + reset xong) rồi chạy lại pre-flight.');
    appendFileSync(marker, 'ABORTED: live activity\n');
    process.exitCode = 2;
  } else if (!ext.length) {
    log('\n*** DỪNG: pgcrypto extension chưa bật. Bật ở Supabase → Database → Extensions. ***');
    appendFileSync(marker, 'ABORTED: pgcrypto missing\n');
    process.exitCode = 3;
  } else {
    log('\nAn toàn: không có lượt chơi đang chạy, không có claim pending, pgcrypto có sẵn.');
    log('\nChạy lệnh sau tại PowerShell thường để migrate + cấu hình crew codes/PIN/reset secret:');
    log('  powershell -ExecutionPolicy Bypass -File scripts\\db-push.ps1 ' +
        '-ConfigureSupervisorPin -ConfigureStationReset -ConfigureStationCodes');
    appendFileSync(marker, 'SAFE: proceed with db-push.ps1\n');
  }
} catch (e) {
  log('ERROR ' + e.message);
  appendFileSync(marker, 'ERROR: ' + e.message + '\n');
  process.exitCode = 4;
} finally {
  await client.end().catch(() => undefined);
}
