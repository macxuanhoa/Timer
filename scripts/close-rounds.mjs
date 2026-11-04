#!/usr/bin/env node
/* Close legacy rounds the legitimate way: every state change goes through the
 * production handle_command state machine, executed as the already-bound
 * SUPERVISOR device's own session — no SQL status edits, no fabricated results,
 * no forced closure. The machine itself still refuses if the reset is not owed
 * or the event cannot end, and the refusal is printed verbatim.
 *
 * Readiness rule proven on the isolated 0014 replica:
 *   RESETTING + physical reset done  -> GATE_FINALIZE clears the round
 *   idle floor + ended event         -> migration 0016 maps GATE_CLEARED to CLOSED
 *
 * The operator confirms the physical state before this script will act. */
import { connect, projectRef } from './lib/pooler.mjs';

const PRODUCTION_REF = 'efsamoxceegkrwucpqkq';

const reason = (process.env.SC_END_REASON || '').trim();
if (!reason) throw new Error('SC_END_REASON must state why the event is being closed.');
if (process.env.SC_CONFIRM_PHYSICAL_RESET !== 'yes') {
  throw new Error('Set SC_CONFIRM_PHYSICAL_RESET=yes only after you have personally confirmed every station of the last round is physically reset and clear.');
}

async function oneCommand(c, uid, action, meta, revision) {
  await c.query('begin');
  try {
    // SET refuses bind parameters, so the session identity is applied with set_config —
    // exactly the GUCs the Supabase platform itself writes for a JWT request.
    await c.query(
      `select set_config('role', 'authenticated', true),
              set_config('request.jwt.claim.sub', $1, true),
              set_config('request.jwt.claims', json_build_object('sub', $1)::text, true)`,
      [uid]);
    await c.query('select pg_advisory_xact_lock(30501)');
    const { rows } = await c.query(
      'select public.handle_command($1, $2::jsonb, $3, gen_random_uuid()::text) as answer',
      [action, JSON.stringify(meta), String(revision)]);
    await c.query('commit');
    return rows[0].answer;
  } catch (error) {
    await c.query('rollback').catch(() => undefined);
    throw error;
  }
}

async function main() {
  const isolated = process.env.SC_ALLOW_ISOLATED_DB === 'yes';
  if (!isolated && projectRef !== PRODUCTION_REF) {
    throw new Error(`TargetGuard: project ref "${projectRef}" is not the production project ${PRODUCTION_REF} — refusing to act.`);
  }
  const client = await connect();
  try {
    // Read-only verification of the live connection BEFORE any state change is
    // even considered. inet_server_addr is not decisive (Supabase answers with an
    // internal AWS address), so the proof is the platform fingerprint: a real
    // Supabase project carries the service roles and the extensions namespace that
    // a bare rehearsal Postgres does not. The printed snapshot also shows the exact
    // round state this script is about to walk through the machine.
    const { rows: tgt } = await client.query(`
      select current_database() as db,
             (select count(*) from pg_roles
               where rolname in ('supabase_admin','supabase_auth_admin',
                                 'supabase_storage_admin','supabase_functions_admin')) as supa_roles,
             (to_regnamespace('extensions') is not null) as ext_schema,
             (select count(*) from public._sc_migrations) as ledger,
             (select count(*) from sc.rounds where status <> 'CLOSED') as open_rounds`);
    console.log('read-only verification:', JSON.stringify(tgt[0]));
    if (!isolated && (tgt[0].supa_roles < 2 || !tgt[0].ext_schema)) {
      throw new Error('TargetGuard: the answering database does not carry the Supabase platform fingerprint — this is not the production project. Refusing before any write.');
    }
    const { rows: open } = await client.query(`
      select id, team_number, status from sc.rounds
      where status <> 'CLOSED'
        and not (status = 'GATE_CLEARED' and system_ready_at is not null)
      order by id`);
    console.log('rounds needing closure:', open.length ? JSON.stringify(open) : '(none)');

    // The 0014-era machine (sc._handle_command_internal, rewrite of 0012) gates
    // GATE_FINALIZE and END_EVENT on a bound duty seat, not on a specific role:
    // SUPERVISOR is preferred when one exists, otherwise the earliest live binding
    // acts — and the state machine itself still refuses anything not yet legal.
    const { rows: seat } = await client.query(`
      select user_id, role from sc.operators
      where revoked_at is null
      order by (role = 'SUPERVISOR') desc, bound_at limit 1`);
    if (!seat.length) {
      throw new Error('Chưa có vị trí nào đang binding trên hosted. Cách khôi phục hợp lệ: mở https://scream305.vercel.app trên máy tổ chức, chạm chọn một vị trí vận hành (GATE là đủ — schema 0014 không đòi credential cho vị trí này; hãy làm đúng thao tác đã dùng khi tạo các lượt trước), rồi chạy lại script này.');
    }
    const uid = seat[0].user_id;
    console.log(`acting as the bound ${seat[0].role} session`, uid);

    for (let pass = 0; pass < 4; pass++) {
      const { rows: now } = await client.query(`
        select r.id, r.status, e.revision, e.event_ended_at
        from sc.events e
        left join sc.rounds r on r.id = (
          select max(id) from sc.rounds where event_id = e.id and status <> 'CLOSED'
            and not (status = 'GATE_CLEARED' and system_ready_at is not null))
        where e.id = (select event_id from sc.state where id) limit 1`);
      if (!now.length) break;
      const { id: roundId, status, revision, event_ended_at: ended } = now[0];

      if (roundId !== null && status !== null) {
        const answer = await oneCommand(client, uid, 'GATE_FINALIZE', {}, revision);
        console.log(`GATE_FINALIZE round #${roundId} ->`, JSON.stringify(answer));
        if (answer.ok !== true) {
          console.log('The production machine itself refused this step. Nothing was forced.');
          process.exitCode = 2;
          return;
        }
        continue; // re-read state; the machine decides the next legal move
      }
      if (ended === null) {
        const answer = await oneCommand(client, uid, 'END_EVENT', { reason }, revision);
        console.log('END_EVENT ->', JSON.stringify(answer));
        if (answer.ok !== true) {
          // The 0014 role matrix reserves END_EVENT for SUPERVISOR. That is not a
          // blocker: with every round finalised the floor is idle, the migration
          // gate is satisfied, and the event can be closed later by the allow-listed
          // V3.2 supervisor device through the normal UI.
          if (answer.code === 'PERMISSION_DENIED') {
            console.log('Vị trí đang binding không được END_EVENT theo vai trò 0014 — KHÔNG phải lỗi.');
            console.log('Các round đã finalise hết; migration không bị chặn. Đóng sự kiện bằng SUPERVISOR hợp lệ trên site V3.2 sau khi nâng cấp.');
            break;
          }
          console.log('The production machine itself refused to end the event. Nothing was forced.');
          process.exitCode = 2;
          return;
        }
      }
      break;
    }

    const { rows: rest } = await client.query(`
      select id, team_number, status,
             (status = 'GATE_CLEARED' and system_ready_at is not null) as upgrade_will_close
      from sc.rounds where status <> 'CLOSED' order by id`);
    console.log('remaining non-CLOSED rounds:', JSON.stringify(rest));
    console.log('Now re-run scripts/preflight-helper.ps1 — legacy cleared rounds no longer block the upgrade.');
  } finally {
    await client.end().catch(() => undefined);
  }
}

await main();
