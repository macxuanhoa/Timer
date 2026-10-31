#!/usr/bin/env node
/**
 * Mint the station invitation links.
 *
 *   npm run invite:mint -- --base https://timer-smoky-seven.vercel.app
 *   npm run invite:mint -- --role GATE --reassign --base https://…
 *   npm run invite:mint -- --list
 *   npm run invite:mint -- --revoke GATE
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
const DEFAULT_BASE = process.env.SCREAM_BASE_URL ?? 'https://timer-smoky-seven.vercel.app';

function parseArgs(argv) {
  const out = { roles: [], labels: new Map(), revoke: [], base: DEFAULT_BASE, expires: 30, mode: 'claim' };
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
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at) <= new Date()) return 'expired';
  if (row.claimed_at) return 'bound';
  return 'unused';
};

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
  console.log('\nLinks are not stored: only their SHA-256 is, so a lost link is re-minted, never recovered.');
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

    const roles = args.roles.length > 0 ? args.roles : ROLES;
    for (const role of roles) {
      if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
    }
    if (args.mode === 'reassign' && roles.length !== 1) {
      throw new Error('--reassign mints one replacement link at a time: add --role GATE');
    }

    if (!args.keep) {
      const { rowCount } = await client.query(
        'update sc.invitations set revoked_at = now() where revoked_at is null and role = any($1::text[])',
        [roles],
      );
      if (rowCount > 0) console.log(`revoked ${rowCount} earlier live invitation(s) for ${roles.join(', ')}`);
    }

    const links = [];
    for (const role of roles) {
      const token = randomBytes(32).toString('base64url');
      const label = args.labels.get(role) ?? '';
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
      'Each link binds ONE phone to ONE station. Send it to that phone only, and',
      'open it there: the app signs in silently and lands on the station dashboard.',
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
