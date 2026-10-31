#!/usr/bin/env node
/**
 * REHEARSAL driver — five logical devices, two complete rounds, against a
 * REHEARSAL Supabase project. It refuses to run against the official project.
 *
 *   node scripts/rehearsal.mjs --url https://<rehearsal-ref>.supabase.co \
 *                              --key <rehearsal publishable key> \
 *                              --links ~/.scream-305/invites-rehearsal.txt
 *
 * Proves, in order: invitation → server-issued role binding → CALL_TEAM →
 * TEAM_UPSTAIRS → START → hallway → room → PUZZLE_COMPLETE → RETURN → STOP →
 * READY gate refused too early → 3 reset marks → READY → leaderboard, then the
 * TIMEOUT path, the cross-role refusals, and realtime push convergence with a
 * measured per-device lag.
 *
 * Safety model:
 *   - the official project ref is refused, with no override flag;
 *   - aborts if the rehearsal event already holds an active round or an
 *     anchored 90-minute clock, so it can never silently resume someone else's
 *     live event;
 *   - TIMEOUT is reached by shortening game_limit_ms through CONFIGURE, so
 *     allow_test_clock stays false in every environment.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const PRODUCTION_REFS = ['efsamoxceegkrwucpqkq'];
const ROLES = ['LOBBY', 'GATE', 'CORRIDOR', 'ROOM305', 'SUPERVISOR'];

function parseArgs() {
  const out = { gameLimitMs: 20_000, patience: 4_000, links: null, keepBound: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].replace(/^--/, '');
    const value = () => argv[++i];
    switch (flag) {
      case 'url': out.url = value(); break;
      case 'key': out.key = value(); break;
      case 'links': out.links = value(); break;
      case 'game-limit-ms': out.gameLimitMs = Number(value()); break;
      case 'patience': out.patience = Number(value()); break;
      case 'keep-bound': out.keepBound = true; break;
      case 'dry-run': out.dryRun = true; break;
      default: throw new Error(`unknown option --${flag}`);
    }
  }
  return out;
}

const cfg = parseArgs();
if (!cfg.url || !cfg.key || !cfg.links) {
  console.error('need --url, --key and --links of the REHEARSAL project (README §Final rehearsal, option A)');
  process.exit(2);
}
const host = String(cfg.url).replace(/^https?:\/\//, '').split('/')[0];
if (PRODUCTION_REFS.some((ref) => host.includes(ref))) {
  console.error(`\nREFUSED: ${host} is the OFFICIAL event project.`);
  console.error('This driver commits rounds, action-log rows and anchors the 90-minute clock.');
  console.error('Create a separate Supabase project for rehearsal (README §Final rehearsal).');
  process.exit(3);
}
if (!Number.isFinite(cfg.gameLimitMs) || cfg.gameLimitMs < 5_000 || cfg.gameLimitMs > 300_000) {
  console.error('--game-limit-ms must be between 5000 and 300000');
  process.exit(2);
}
console.log(`\ntarget ${host} (rehearsal) · game limit ${cfg.gameLimitMs} ms · official refs blocked: ${PRODUCTION_REFS.join(', ')}`);
if (cfg.dryRun) {
  console.log('dry run: guards verified, nothing was sent.');
  process.exit(0);
}

/**
 * --links is mandatory and must name the file minted BY THE REHEARSAL PROJECT:
 * a token is bound to the project that stored its hash, so pointing the official
 * mint file at a rehearsal project simply fails, and pointing this script at the
 * official project is refused outright. Tokens are never printed.
 */
function linkTokens() {
  const file = path.resolve(cfg.links.replace(/^~(?=[/\\])/, os.homedir()));
  const map = new Map();
  for (const m of readFileSync(file, 'utf8').matchAll(/^(LOBBY|GATE|CORRIDOR|ROOM305|SUPERVISOR)\s*\n\s*(\S+)/gim)) {
    const role = m[1].toUpperCase();
    if (!map.has(role)) map.set(role, m[2].includes('/i/') ? m[2].split('/i/')[1] : m[2]);
  }
  return { file: path.basename(file), map };
}

const rows = [];
let stopping = false;
const verdict = (id, ok, detail = '') => {
  const status = ok === true ? 'PASS' : ok === 'BLOCK' ? 'BLOCKED' : 'FAIL';
  rows.push({ id, status, detail: String(detail).replace(/\s+/g, ' ').slice(0, 150) });
  if (status === 'FAIL' && !stopping) {
    stopping = true;
    throw new Error(`${id}: ${String(detail).slice(0, 160)}`);
  }
};
const pct = (xs, q) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round((s.length - 1) * q))];
};

const mk = () => createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });
const devices = {};
const released = [];

async function main() {
  const { file, map: tokens } = linkTokens();
  const missing = ROLES.filter((r) => !tokens.has(r));
  verdict('R0 five rehearsal links available (tokens not printed)', missing.length === 0,
    missing.length ? `${file}: missing ${missing.join(', ')}` : `${file}: all five`);

  // --------------------- two phones redeem the same permanent link at once
  // Exactly one may win the seat; the loser must get the official sentence.
  // Nothing is consumed: the link stays reusable, so the run continues below.
  const raceA = mk(), raceB = mk();
  await raceA.auth.signInAnonymously();
  await raceB.auth.signInAnonymously();
  const [ra, rb] = await Promise.all([
    raceA.rpc('redeem_invitation', { p_token: tokens.get('LOBBY'), p_device_id: 'race-A' }),
    raceB.rpc('redeem_invitation', { p_token: tokens.get('LOBBY'), p_device_id: 'race-B' }),
  ]);
  const racers = [{ sb: raceA, r: ra }, { sb: raceB, r: rb }];
  const winners = racers.filter((x) => x.r.data?.code === 'BOUND');
  const losers = racers.filter((x) => x.r.data?.code === 'ROLE_TAKEN');
  verdict('C1 simultaneous redeem: exactly one winner', winners.length === 1 && losers.length === 1,
    `${ra.data?.code} / ${rb.data?.code}`);
  verdict('C2 the loser gets "VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG"', losers[0]?.r.data?.message === 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG',
    losers[0]?.r.data?.message ?? '(none)');
  const racedWho = await losers[0]?.sb.rpc('whoami');
  verdict('C3 the loser holds no role', racedWho?.data == null, JSON.stringify(racedWho?.data ?? null));
  if (winners[0]) {
    const rel = await winners[0].sb.rpc('release_device');
    verdict('C4 the winner releases, so the same link is free again', rel.data?.code === 'RELEASED', JSON.stringify(rel.data));
  }

  for (const role of ROLES) {
    const sb = mk();
    const { data, error } = await sb.auth.signInAnonymously();
    verdict(`R1 anonymous identity for ${role}`, !error && !!data?.session, error?.message ?? `user ${data?.user?.id?.slice(0, 8)}…`);
    const r = (await sb.rpc('redeem_invitation', { p_token: tokens.get(role), p_device_id: `rehearsal-${role}` })).data;
    verdict(`R2 ${role} invitation binds`, r?.code === 'BOUND' || r?.code === 'ALREADY_BOUND', JSON.stringify(r));
    const who = (await sb.rpc('whoami')).data;
    verdict(`R3 ${role} role is issued by the server`, who?.role === role, JSON.stringify(who));
    devices[role] = { sb, role, revision: 0, hints: [] };
  }

  const hasWs = typeof globalThis.WebSocket !== 'undefined';
  if (hasWs) {
    for (const d of Object.values(devices)) {
      d.channel = d.sb
        .channel(`rehearsal-${d.role}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'sc', table: 'state' }, (p) => d.hints.push({ at: Date.now(), revision: Number(p.new.revision) }))
        .subscribe();
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const rpc = (d, action, meta = {}, key = `rh-${action}-${Math.random().toString(36).slice(2, 8)}`) =>
    d.sb.rpc('handle_command', { p_action: action, p_meta: meta, p_expected_revision: d.revision, p_idempotency_key: key });
  const snap = async (d) => {
    const { data, error } = await d.sb.rpc('snapshot');
    if (error) throw new Error(`snapshot ${d.role}: ${error.message}`);
    d.revision = Number(data.revision);
    return data;
  };
  const activeOf = (s) => (s.rounds ?? []).find((r) => r.status !== 'GATE_CLEARED' && r.status !== 'ABORTED') ?? null;

  // A rehearsal must never land on someone's live event.
  const sup = devices.SUPERVISOR, lobby = devices.LOBBY, gate = devices.GATE, corridor = devices.CORRIDOR, room = devices.ROOM305;
  const before = await snap(sup);
  verdict('R4 rehearsal event has no active round', activeOf(before) === null, `active=${activeOf(before)?.status ?? 'none'}`);
  verdict('R5 rehearsal 90-minute clock not yet anchored', before.event.event_started_at === null, `event_started_at=${before.event.event_started_at}`);

  const configure = await rpc(sup, 'CONFIGURE', { game_limit_ms: String(cfg.gameLimitMs), prep_allowance_ms: '10000' });
  verdict('R6 supervisor CONFIGURE works before the first dispatch', configure.data?.ok === true, JSON.stringify(configure.data));

  /** Press + wait until all five phones report that revision, and time the push. */
  const lags = [];
  async function press(d, action, meta = {}) {
    const t0 = Date.now();
    const r = await rpc(d, action, meta);
    verdict(`${d.role} ${action}`, r.data?.ok === true, JSON.stringify(r.data));
    const latest = await snap(sup);
    for (const other of Object.values(devices)) {
      while (other.revision < Number(latest.revision) && Date.now() - t0 < cfg.patience) {
        await new Promise((res) => setTimeout(res, 50));
        await snap(other);
      }
      verdict(`convergence ${other.role} → r${latest.revision}`, other.revision >= Number(latest.revision), `within ${Date.now() - t0}ms`);
      const hint = other.hints.find((h) => h.at >= t0 && h.revision >= Number(latest.revision));
      if (hint) lags.push(hint.at - t0);
    }
    return r.data;
  }

  // ---------------------------------------------------------------- round 1
  await press(lobby, 'CALL_TEAM', { team_name: 'REHEARSAL-1' });
  const opened = await snap(gate);
  verdict('W1 first dispatch anchored the clock', opened.event.event_started_at !== null, `event_started_at=${opened.event.event_started_at}`);
  verdict('W2 round status LOBBY_CALL everywhere', activeOf(opened)?.status === 'LOBBY_CALL', activeOf(opened)?.status);
  await press(lobby, 'TEAM_UPSTAIRS');
  await press(gate, 'START_GAME');
  await press(corridor, 'HALLWAY_PROGRESS');
  await press(room, 'ROOM_REACHED');
  await press(room, 'PUZZLE_COMPLETE');
  await press(room, 'RETURN_START');

  const running = activeOf(await snap(gate));
  verdict('W3 completion left the clock running', running.game_stopped_at === null, `game_stopped_at=${running.game_stopped_at}`);

  const early = await rpc(gate, 'GATE_FINALIZE');
  verdict('W4 READY refused while resets are missing', early.data?.code === 'BLOCKED', JSON.stringify(early.data));

  await press(gate, 'GAME_STOP');
  const stopped = activeOf(await snap(gate));
  verdict('W5 STOP wrote an official duration + outcome', Number.isFinite(Number(stopped.official_duration_ms)) && stopped.outcome !== 'IN_PROGRESS',
    `${stopped.outcome} ${stopped.official_duration_ms}ms`);
  const durations = new Set();
  for (const d of Object.values(devices)) durations.add(String(activeOf(await snap(d)).official_duration_ms));
  verdict('W6 all five phones agree on the duration', durations.size === 1, [...durations].join(' / '));

  const wrongStop = await rpc(room, 'GAME_STOP');
  verdict('A1 ROOM305 cannot STOP', wrongStop.data?.code === 'PERMISSION_DENIED', JSON.stringify(wrongStop.data));
  const wrongReady = await rpc(lobby, 'GATE_FINALIZE');
  verdict('A2 LOBBY cannot declare READY', wrongReady.data?.code === 'PERMISSION_DENIED', JSON.stringify(wrongReady.data));
  const wrongClose = await rpc(gate, 'END_EVENT', { reason: 'probe' });
  verdict('A3 GATE cannot close the event', wrongClose.data?.code === 'PERMISSION_DENIED', JSON.stringify(wrongClose.data));
  const wrongPromote = await devices.CORRIDOR.sb.rpc('redeem_invitation', { p_token: tokens.get('SUPERVISOR'), p_device_id: 'x' });
  verdict('A4 a bound phone cannot promote itself with another link', wrongPromote.data?.code === 'ALREADY_BOUND_OTHER_ROLE', JSON.stringify(wrongPromote.data));

  await press(corridor, 'RESET_DONE');
  const halfReset = activeOf(await snap(gate));
  verdict('W7 one reset mark leaves the round in RESETTING', halfReset.status !== 'RESET_CONFIRMED' && halfReset.status !== 'GATE_CLEARED', halfReset.status);
  await press(room, 'RESET_DONE');
  const allReset = activeOf(await snap(gate));
  verdict('W8 every reset task confirmed', allReset.status === 'RESET_CONFIRMED', `${allReset.status} missing=${(await snap(gate)).reset_tasks.filter((t) => t.completed_at === null && t.round_id === String(allReset.id)).length}`);
  await press(gate, 'GATE_FINALIZE');
  const cleared = await snap(gate);
  verdict('W9 round cleared → system READY for the next team', activeOf(cleared) === null, `active=${activeOf(cleared)?.status ?? 'none'}`);
  verdict('W10 leaderboard carries the finished round', cleared.rounds.some((r) => r.gate_finalized_at !== null && r.outcome !== 'IN_PROGRESS'),
    `rounds=${cleared.rounds.length} outcomes=${cleared.rounds.map((r) => r.outcome).join(',')}`);

  // ------------------------------------------------------- round 2: TIMEOUT
  await press(lobby, 'CALL_TEAM', { team_name: 'REHEARSAL-2' });
  await press(gate, 'START_GAME');
  console.log(`  crossing the ${Math.round(cfg.gameLimitMs / 1000)}s game limit…`);
  await new Promise((r) => setTimeout(r, cfg.gameLimitMs + 1500));
  await press(room, 'PUZZLE_COMPLETE');
  await press(gate, 'GAME_STOP');
  const timedOut = activeOf(await snap(gate));
  verdict('T1 over-limit finish scores TIMEOUT', timedOut.outcome === 'TIMEOUT', `outcome=${timedOut.outcome} duration=${timedOut.official_duration_ms} limit=${cfg.gameLimitMs}`);
  await press(corridor, 'RESET_DONE');
  await press(room, 'RESET_DONE');
  await press(gate, 'GATE_FINALIZE');
  verdict('T2 second round cleared as well', activeOf(await snap(gate)) === null, 'ready again');

  const late = (await sup.sb.rpc('operation_status', { p_idempotency_key: 'never-used-key' })).data;
  verdict('T3 operation_status answers for a lost reply', late?.found === false, JSON.stringify(late));

  // ---------------------------------------------------------------- realtime
  if (hasWs) {
    verdict('RT1 realtime hints arrived at every phone', ROLES.every((r) => devices[r].hints.length > 0),
      ROLES.map((r) => `${r}:${devices[r].hints.length}`).join(' '));
    console.log(`  push lag ms · p50=${pct(lags, 0.5)} p95=${pct(lags, 0.95)} max=${Math.max(...lags, 0)} (n=${lags.length})`);
    verdict('RT2 measured push lag under the patience window', pct(lags, 0.95) <= cfg.patience, `p95=${pct(lags, 0.95)}ms`);
  } else {
    verdict('RT1 realtime hints', 'BLOCK', 'this Node runtime has no global WebSocket; run the phone check on the devices themselves');
  }
}

try {
  await main();
} catch (err) {
  rows.push({ id: 'ABORT', status: 'FAIL', detail: String(err.message).slice(0, 150) });
} finally {
  if (!cfg.keepBound) {
    for (const d of Object.values(devices)) {
      if (!d?.sb) continue;
      try {
        released.push((await d.sb.rpc('release_device')).data?.code ?? 'NO-RESPONSE');
      } catch (err) {
        released.push(`${d.role}:release-failed(${String(err.message).slice(0, 24)})`);
      }
      if (d.channel) await d.sb.removeChannel(d.channel).catch(() => undefined);
    }
    console.log(`released rehearsal bindings: ${released.join(', ') || '(none bound)'}`);
  } else {
    console.log('--keep-bound: the five rehearsal seats stay live');
  }
  console.table(rows.map((r) => ({ check: r.id, result: r.status, detail: r.detail })));
  const fails = rows.filter((r) => r.status === 'FAIL').length;
  const blocks = rows.filter((r) => r.status === 'BLOCKED').length;
  console.log(`\nREHEARSAL RESULT: ${rows.length - fails - blocks} PASS · ${fails} FAIL · ${blocks} BLOCKED`);
  console.log(`official project ${PRODUCTION_REFS.join(', ')} received no request from this run`);
  process.exit(fails ? 1 : 0);
}
