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
  // V3.2 stores no bcrypt hashes any more: pgcrypto is nice to have, not required.
  log('pgcrypto: ' + (ext.length ? 'installed' : 'missing (harmless since V3.2 removed every bcrypt secret)'));

  const { rows: led } = await client.query('select name from public._sc_migrations order by name');
  const applied = new Set(led.map((r) => r.name));
  log(`\nLedger (${applied.size}/18 applied):`);
  for (const r of led) log('  ✓ ' + r.name);

  const { rows: files } = await client.query("select name from public._sc_migrations");
  // Enumerate pending by comparing with the migrations dir (from db-push.mjs pattern)
  const { readdirSync } = await import('node:fs');
  const all = readdirSync(resolve(root, 'supabase/migrations')).filter(n => /^\d+_.*\.sql$/.test(n)).sort();
  const pending = all.filter(n => !applied.has(n));
  log(`\nPending: ${pending.length ? pending.join(', ') : '(none — hosted đã 0018)'}`);

  const { rows: rounds } = await client.query(`
    select id, team_number, status, game_started_at, exit_confirmed_at, aborted_at,
           system_ready_at is not null as gate_finalised
    from sc.rounds where status <> 'CLOSED' order by id`);
  log(`\nActive rounds (status <> CLOSED): ${rounds.length}`);
  for (const r of rounds) {
    // A legacy GATE_CLEARED round with the gate already finalised is idle history:
    // migration 0016 itself maps it to CLOSED, so it is not live activity.
    const legacyClosed = r.status === 'GATE_CLEARED' && r.gate_finalised;
    log('  ' + JSON.stringify(r) + (legacyClosed ? '  [sẽ thành CLOSED khi upgrade 0016]' : ''));
    if (!legacyClosed) hasActive = true;
  }

  // sc.completion_attempts chỉ tồn tại từ migration 0016. Postgres parse toàn bộ
  // câu query, nên KHÔNG được tham chiếu bảng này khi nó chưa tồn tại — dù nằm
  // trong nhánh điều kiện. Probe to_regclass trước, rồi mới truy vấn.
  const { rows: relCheck } = await client.query(
    "select to_regclass('sc.completion_attempts') is not null as has_attempts");
  let pendingClaims = [];
  if (relCheck[0].has_attempts) {
    ({ rows: pendingClaims } = await client.query(`
      select a.id, a.round_id, a.seq, a.claimed_at, a.status
      from sc.completion_attempts a join sc.rounds r on r.id = a.round_id
      where a.status in ('PENDING','LATE') and r.status <> 'CLOSED'`));
  } else {
    log('\ncompletion_attempts chưa tồn tại (hosted dưới 0016) — bỏ qua kiểm tra claim pending.');
  }
  log(`\nPending claims on non-closed rounds: ${pendingClaims.length}`);
  for (const a of pendingClaims) log('  ' + JSON.stringify(a));
  if (pendingClaims.length) hasActive = true;

  const { rows: ops } = await client.query(`
    select role, seat_slot, display_name, bound_at from sc.operators
     where revoked_at is null order by role, seat_slot`);
  log(`\nLive bindings: ${ops.length}`);
  for (const o of ops) log('  ' + o.role + ' slot=' + o.seat_slot + ' bound ' + o.bound_at.toISOString() + ' by ' + o.display_name);

  // Open reset tasks of non-closed rounds — the exact checklist that blocks
  // GATE_FINALIZE at the 0014 machine. Read-only, with a relation probe.
  try {
    const { rows: tasks } = await client.query(`
      select r.team_number, t.task_key, t.required_role,
             t.completed_at is not null and t.cycle = r.reset_cycle as signed
      from sc.reset_tasks t join sc.rounds r on r.id = t.round_id
      where r.status not in ('CLOSED')
      order by r.id, t.task_key`);
    if (tasks.length) {
      log('\nReset tasks on non-closed rounds:');
      for (const t of tasks) log('  team #' + t.team_number + '  ' + t.task_key + '  role=' + t.required_role + '  ' + (t.signed ? 'SIGNED' : 'OPEN'));
    } else log('\nReset tasks on non-closed rounds: (none)');
  } catch (e) { log('\nreset tasks probe: ' + e.message.split('\n')[0]); }

  // Read-only diagnostics that explain WHY nothing is bound and what the last
  // access actions were — decisive for the 0014 → V3.2 release path.
  try {
    const { rows: cfg } = await client.query(`
      select supervisor_pin_hash is not null as pin_set,
             reset_secret_hash is not null as reset_set
      from sc.station_access_config where id`);
    if (cfg.length) log('\nAccess config: supervisor PIN ' + (cfg[0].pin_set ? 'ĐÃ đặt' : 'chưa đặt (claim SUPERVISOR sẽ báo PIN_NOT_CONFIGURED)')
      + ' · reset secret ' + (cfg[0].reset_set ? 'đã đặt' : 'chưa đặt'));
  } catch { /* schema under 0010 — nothing to report */ }
  try {
    const { rows: audit } = await client.query(`
      select to_char(at, 'YYYY-MM-DD HH24:MI') as at, action, coalesce(role, '-') as role
      from sc.access_audit order by id desc limit 6`);
    log('\nAudit tail (6 access actions gần nhất):');
    for (const a of audit) log('  ' + a.at + '  ' + a.action + '  ' + a.role);
  } catch { /* audit table absent — pre-0010 database */ }

  if (hasActive) {
    log('\n*** DỪNG: có lượt chơi hoặc claim đang chạy. Không migrate. ***');
    log('Để sự kiện kết thúc (đội hiện tại đóng round + reset xong) rồi chạy lại pre-flight.');
    appendFileSync(marker, 'ABORTED: live activity\n');
    process.exitCode = 2;
  } else {
    log('\nAn toàn: không có lượt chơi đang chạy, không có claim pending.');
    log('\nChạy lệnh sau tại PowerShell thường để migrate:');
    log('  powershell -ExecutionPolicy Bypass -File scripts\\db-push.ps1');
    log('\nRồi cấp máy quản trị (uuid hiển thị trên /admin) bằng:');
    log('  powershell -ExecutionPolicy Bypass -File scripts\\db-push.ps1 -AllowAdminDevice');
    appendFileSync(marker, 'SAFE: proceed with db-push.ps1\n');
  }
} catch (e) {
  log('ERROR ' + e.message);
  appendFileSync(marker, 'ERROR: ' + e.message + '\n');
  process.exitCode = 4;
} finally {
  await client.end().catch(() => undefined);
}
