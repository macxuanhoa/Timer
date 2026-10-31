#!/usr/bin/env node
/**
 * Mint the five PERMANENT station links.
 *
 *   npm run invite:mint -- --base https://timer-smoky-seven.vercel.app
 *   npm run invite:mint -- --list
 *   npm run invite:mint -- --release GATE      # lost phone: free the seat
 *   npm run invite:mint -- --release-all       # free every seat, links untouched
 *   npm run invite:mint -- --revoke GATE       # burn the link itself
 *   npm run invite:mint -- --role GATE         # replace ONLY GATE's link
 *
 * Official model since migration 0007: one link per station, no expiry, reusable
 * forever. What is exclusive is the SEAT — at most one live device per role. A
 * link never evicts a phone that is on duty; to move a station onto another
 * phone either tap ĐỔI MÁY on the old one or run `--release`, then simply open
 * the SAME link on the new phone. Minting again is only needed when a link
 * itself leaked or was lost, and it replaces that station's link.
 *
 * A token is 256 bits from the OS entropy pool. Only its SHA-256 is stored, so
 * the database can verify a link but never reproduce one: a lost file means a
 * new link. The links are written to a file outside the repository (mode 0600)
 * and are never printed unless you ask for --stdout.
 *
 * The database password comes from PGPASSWORD; use scripts/mint-invites.ps1 so
 * it is prompted for without echoing.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connect } from './lib/pooler.mjs';

const ROLES = ['LOBBY', 'GATE', 'CORRIDOR', 'ROOM305', 'SUPERVISOR'];
/** How the station is addressed on the floor; stored as the invitation label. */
const STATION_LABEL = { LOBBY: 'LOBBY', GATE: 'NPC 1', CORRIDOR: 'NPC 2', ROOM305: 'NPC 3', SUPERVISOR: 'SUPERVISOR' };
const DEFAULT_BASE = process.env.SCREAM_BASE_URL ?? 'https://timer-smoky-seven.vercel.app';

function parseArgs(argv) {
  const out = { roles: [], labels: new Map(), revoke: [], release: [], base: DEFAULT_BASE };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const [flag, inline] = raw.slice(2).split('=');
    const value = () => (inline !== undefined ? inline : argv[++i]);

    switch (flag) {
      case 'base': out.base = value().replace(/\/+$/, ''); break;
      case 'role': out.roles.push(value().toUpperCase()); break;
      case 'keep': out.keep = true; break;
      case 'out': out.out = value(); break;
      case 'stdout': out.stdout = true; break;
      case 'list': out.list = true; break;
      case 'revoke': out.revoke.push(value().toUpperCase()); break;
      case 'release': out.release.push(value().toUpperCase()); break;
      case 'release-all': out.releaseAll = true; break;
      case 'label': {
        const [role, ...rest] = String(value()).split('=');
        out.labels.set(role.toUpperCase(), rest.join('='));
        break;
      }
      case 'reassign':
        throw new Error('--reassign no longer exists: links are permanent. Free the seat with --release GATE, then open the same link on the new phone.');
      case 'expires':
        console.warn('--expires ignored: permanent station links never expire (0007).');
        value();
        break;
      default:
        throw new Error(`unknown option --${flag}`);
    }
  }
  return out;
}

const LINK_STATE = (row) => (row.revoked_at ? 'REVOKED' : 'ACTIVE');
const LINK_EXPIRY = (row) =>
  row.expires_at ? `LEGACY ${new Date(row.expires_at).toISOString().slice(0, 10)}` : 'NEVER EXPIRES';

/** Which station each live binding holds, so re-issuing can be advised correctly. */
async function liveBindings(client) {
  const { rows } = await client.query(
    'select role, display_name, device_id, bound_at from sc.operators where revoked_at is null order by role');
  return rows;
}

/**
 * Frees one station by retiring its live binding, exactly as ĐỔI MÁY does from
 * the phone itself. This is the only path that releases a station the phone
 * cannot or will not release: no invitation link can do it.
 */
async function releaseBinding(client, role) {
  const { rows } = await client.query(
    `update sc.operators set revoked_at = now()
      where role = $1 and revoked_at is null
      returning display_name, device_id, bound_at`,
    [role],
  );
  for (const row of rows) {
    console.log(`released ${role} from ${row.display_name} (device ${String(row.device_id).slice(0, 8)}…, since ${row.bound_at.toISOString()})`);
  }
  if (rows.length === 0) console.log(`${role}: no live binding to release`);
  return rows.length;
}

/**
 * Frees every station by retiring its live bindings — the reset the organizer
 * asks for before a rehearsal or a new crew. Links are not touched: they are
 * permanent, so each station simply becomes available again.
 */
async function releaseAllBindings(client) {
  const { rows } = await client.query(
    `update sc.operators set revoked_at = now()
      where revoked_at is null
      returning role, display_name, device_id`,
  );
  for (const row of rows) console.log(`released ${row.role} from ${row.display_name} (device ${String(row.device_id).slice(0, 8)}…)`);
  if (rows.length === 0) console.log('no live bindings: every station is already available');
  return rows.length;
}

async function listInvitations(client) {
  const { rows: links } = await client.query(`
    select role, label, claimed_at, expires_at, revoked_at, created_at
      from sc.invitations
     order by role, created_at desc`);
  if (links.length === 0) {
    console.log('no links yet — mint the five permanent station links first');
    return;
  }
  const bindings = await liveBindings(client);
  const byRole = new Map();
  for (const b of bindings) byRole.set(b.role, [...(byRole.get(b.role) ?? []), b]);

  console.log('role        link       device                         expires');
  console.log('----------  ---------  -----------------------------  -----------------');
  for (const role of ROLES) {
    const open = links.filter((r) => r.role === role && !r.revoked_at);
    const shown = open[0] ?? links.find((r) => r.role === role);
    if (!shown) {
      console.log(`${role.padEnd(10)}  ${'MISSING'.padEnd(9)}  ${'—'.padEnd(29)}  —`);
      continue;
    }
    const live = byRole.get(role) ?? [];
    const device =
      live.length === 0 ? 'available'
        : live.length === 1 ? `OCCUPIED ${live[0].display_name}`
          : `OCCUPIED ×${live.length} (${live.map((x) => x.display_name).join(', ')})`;
    console.log(`${role.padEnd(10)}  ${LINK_STATE(shown).padEnd(9)}  ${device.padEnd(29)}  ${LINK_EXPIRY(shown)}`);
  }

  const perRole = ROLES.map((role) => [role, links.filter((r) => r.role === role && !r.revoked_at).length]);
  const wrong = perRole.filter(([, n]) => n !== 1);
  console.log(`\nACTIVE links: ${perRole.filter(([, n]) => n === 1).length}/5 stations` +
    (wrong.length ? ` · ATTENTION: ${wrong.map(([r, n]) => `${r}=${n}`).join(', ')} (the model requires exactly one active link per station)` : ''));
  console.log(`LIVE devices: ${bindings.length}/6 · ${bindings.map((b) => `${b.role}=${b.display_name}`).join(', ') || '(none)'}`);
  console.log('\nA link is a station credential, not a ticket: it stays ACTIVE and NEVER EXPIRES, and it is reusable whenever its station is available.');
  console.log('Every station takes one phone; SUPERVISOR is the only one that may hold two (both openings use the same link).');
  console.log('Only SHA-256 is stored: a lost link is replaced with --role <ROLE>, which revokes the old one.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await connect();

  try {
    const { rows: model } = await client.query("select to_regprocedure('sc.claim_station(text,text)') as claim");
    if (model[0].claim) throw new Error('Invitation administration is retired (0010). Share the root URL; use db-push.ps1 -ConfigureSupervisorPin for PIN rotation.');
    const { rows: exists } = await client.query("select to_regclass('sc.invitations') as t");
    if (!exists[0].t) {
      throw new Error('sc.invitations is missing — run scripts/db-push.ps1 first');
    }

    if (args.list) {
      await listInvitations(client);
      return;
    }

    if (args.revoke.length > 0) {
      for (const role of args.revoke) {
        if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
        const { rowCount } = await client.query(
          'update sc.invitations set revoked_at = now() where role = $1 and revoked_at is null',
          [role],
        );
        console.log(`revoked ${rowCount} live invitation(s) for ${role}`);
      }
      return;
    }

    if (args.releaseAll) {
      // Links, event rows and history are deliberately untouched here.
      const freed = await releaseAllBindings(client);
      console.log(`\n${freed} device slot(s) freed · the five permanent links are unchanged`);
      return;
    }

    if (args.release.length > 0) {
      for (const role of args.release) {
        if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
        await releaseBinding(client, role);
      }
      // `--release` on its own is a complete action; it only mints when the
      // caller also named the stations to issue links for.
      if (args.roles.length === 0) return;
    }

    const roles = args.roles.length > 0 ? args.roles : ROLES;
    for (const role of roles) {
      if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
    }

    // Minting replaces a station's link, so fewer than five can be re-issued at
    // a time and the other stations keep the links already handed out.
    if (!args.keep) {
      const { rowCount } = await client.query(
        'update sc.invitations set revoked_at = now() where revoked_at is null and role = any($1::text[])',
        [roles],
      );
      if (rowCount > 0) console.log(`revoked ${rowCount} previous ACTIVE link(s) for ${roles.join(', ')}`);
    } else {
      console.warn('! --keep leaves the previous link(s) ACTIVE too: you will have more than one link for a station. The official model is exactly one.');
    }

    const links = [];
    const bindings = await liveBindings(client);
    for (const role of roles.filter((r) => bindings.some((b) => b.role === r))) {
      const held = bindings.find((b) => b.role === role);
      console.warn(`\n! ${role} is currently OCCUPIED by ${held.display_name}.`);
      console.warn('  A new link cannot evict that phone. Have it tap ĐỔI MÁY, or run --release ' + role + ' first.');
    }

    for (const role of roles) {
      const token = randomBytes(32).toString('base64url');
      const label = args.labels.get(role) ?? STATION_LABEL[role];
      await client.query(
        `insert into sc.invitations (role, mode, token_hash, label, expires_at)
         values ($1, 'claim', extensions.digest($2, 'sha256'), $3, null)`,
        [role, token, label],
      );
      links.push({ role, url: `${args.base}/i/${token}` });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const outPath = args.out ?? path.join(os.homedir(), '.scream-305', `invites-${stamp}.txt`);
    await mkdir(path.dirname(outPath), { recursive: true, mode: 0o700 });

    const body = [
      'SCREAM CONTROL — Room 305',
      `${links.length} PERMANENT station link(s), minted ${new Date().toISOString()}`,
      'No expiry. Each link is reusable for ever, but only one phone can hold',
      'its station at a time. Opening a link while the station is occupied is',
      'refused with "VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG".',
      '',
      'To move a station to a new phone: tap ĐỔI MÁY on the old phone (or run',
      'mint-invites.ps1 --release <ROLE>), then open the SAME link on the new one.',
      'Only re-mint when a link itself leaked or was lost — that revokes the old.',
      'Do not commit this file; keep it where only the organiser can read it.',
      '',
      ...links.flatMap((link) => [link.role, link.url, '']),
    ].join('\n');

    await writeFile(outPath, body, { mode: 0o600 });

    console.log(`\n${links.length} link(s) written to:\n  ${outPath}`);
    console.log(`stations: ${links.map((l) => l.role).join(', ')}`);
    console.log('The file is outside the repository. Tokens were not printed to this log.');
    if (args.stdout) console.log(`\n${body}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
