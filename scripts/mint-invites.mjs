#!/usr/bin/env node
/**
 * Mint the station invitation links.
 *
 *   npm run invite:mint -- --base https://timer-smoky-seven.vercel.app
 *   npm run invite:mint -- --role GATE --reassign --base https://…
 *   npm run invite:mint -- --release GATE
 *   npm run invite:mint -- --list
 *   npm run invite:mint -- --revoke GATE
 *
 * Redemption never evicts a phone that is on duty (0006), so freeing a station
 * is an organiser-side action: `--release` drops the live binding, and
 * `--role X --reassign` releases then mints, which is the one supported way to
 * move a station onto a replacement phone.
 *
 * A token is 256 bits from the OS entropy pool. Only its SHA-256 is stored, so
 * the database can verify a link but never reproduce one. The links are written
 * to a file outside the repository (mode 0600) and are never printed unless you
 * ask for --stdout, which keeps them out of terminal scrollback and CI logs.
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
  const out = { roles: [], labels: new Map(), revoke: [], release: [], base: DEFAULT_BASE, expires: 30, mode: 'claim' };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const [flag, inline] = raw.slice(2).split('=');
    const value = () => (inline !== undefined ? inline : argv[++i]);

    switch (flag) {
      case 'base': out.base = value().replace(/\/+$/, ''); break;
      case 'role': out.roles.push(value().toUpperCase()); break;
      case 'reassign': out.mode = 'reassign'; break;
      case 'keep': out.keep = true; break;
      case 'expires': out.expires = Number(value()); break;
      case 'out': out.out = value(); break;
      case 'stdout': out.stdout = true; break;
      case 'list': out.list = true; break;
      case 'revoke': out.revoke.push(value().toUpperCase()); break;
      case 'release': out.release.push(value().toUpperCase()); break;
      case 'label': {
        const [role, ...rest] = String(value()).split('=');
        out.labels.set(role.toUpperCase(), rest.join('='));
        break;
      }
      default:
        throw new Error(`unknown option --${flag}`);
    }
  }
  return out;
}

const STATE = (row) => {
  if (row.revoked_at) return row.claimed_at ? 'used' : 'revoked';
  if (row.expires_at && new Date(row.expires_at) <= new Date()) return 'expired';
  return 'open';
};

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

async function listInvitations(client) {
  const { rows } = await client.query(`
    select role, mode, label, claimed_at, expires_at, revoked_at, created_at
      from sc.invitations
     order by (revoked_at is null) desc, created_at desc
     limit 40`);
  if (rows.length === 0) {
    console.log('no invitations yet — mint a set first');
    return;
  }
  console.log('role        mode      state     expires');
  console.log('----------  --------  --------  -----------------------');
  for (const row of rows) {
    const expires = row.expires_at ? new Date(row.expires_at).toISOString().slice(0, 16).replace('T', ' ') : 'never';
    console.log(`${row.role.padEnd(10)}  ${row.mode.padEnd(8)}  ${STATE(row).padEnd(8)}  ${expires}`);
  }
  const bindings = await liveBindings(client);
  console.log(`\nlive bindings: ${bindings.length === 0 ? '(none)' : bindings.map((b) => `${b.role}=${b.display_name}`).join(', ')}`);
  console.log('\nLinks are not stored: only their SHA-256 is, so a lost or used link is re-minted, never recovered.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await connect();

  try {
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
    if (args.mode === 'reassign' && roles.length !== 1) {
      throw new Error('--reassign mints one replacement link at a time: add --role GATE');
    }
    if (args.mode === 'reassign') {
      // The whole point of a replacement: the old phone is off the station
      // before the new link exists. A link can never do this itself.
      await releaseBinding(client, roles[0]);
      // The freed seat takes an ordinary claim link; 'reassign' is no longer a
      // bypass, so the row records what actually happened.
      args.mode = 'claim';
    }

    if (!args.keep) {
      const { rowCount } = await client.query(
        'update sc.invitations set revoked_at = now() where revoked_at is null and role = any($1::text[])',
        [roles],
      );
      if (rowCount > 0) console.log(`revoked ${rowCount} earlier live invitation(s) for ${roles.join(', ')}`);
    }

    const links = [];
    const bindings = await liveBindings(client);
    if (args.mode === 'claim') {
      for (const role of roles.filter((r) => bindings.some((b) => b.role === r))) {
        const held = bindings.find((b) => b.role === role);
        console.warn(`\n! ${role} is already live on another phone (${held.display_name}).`);
        console.warn('  No link can evict it. Either have that phone tap ĐỔI MÁY,');
        console.warn(`  or release and re-issue:  --role ${role} --reassign`);
      }
    }

    for (const role of roles) {
      const token = randomBytes(32).toString('base64url');
      const label = args.labels.get(role) ?? STATION_LABEL[role];
      await client.query(
        `insert into sc.invitations (role, mode, token_hash, label, expires_at)
         values ($1, $2, extensions.digest($3, 'sha256'), $4,
                 case when $5::int > 0 then now() + make_interval(days => $5::int) else null end)`,
        [role, args.mode, token, label, Number.isFinite(args.expires) ? args.expires : 30],
      );
      links.push({ role, url: `${args.base}/i/${token}` });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const outPath = args.out ?? path.join(os.homedir(), '.scream-305', `invites-${stamp}.txt`);
    await mkdir(path.dirname(outPath), { recursive: true, mode: 0o700 });

    const body = [
      'SCREAM CONTROL — Room 305',
      `${links.length} invitation link(s), minted ${new Date().toISOString()}`,
      `mode: ${args.mode} · expires in ${args.expires} day(s)`,
      '',
      'Each link binds ONE phone to ONE station and is spent the moment it is',
      'opened — it cannot be handed on, replayed or reused after a release.',
      'Send it to that phone only, through a channel you control. Re-issue a new',
      'link for a swapped phone or a lost session.',
      'Do not commit this file, and delete it once the five phones are set up.',
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
