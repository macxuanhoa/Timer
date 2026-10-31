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
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');

const ref = process.env.SUPABASE_PROJECT_REF ?? 'efsamoxceegkrwucpqkq';
const region = process.env.SUPABASE_REGION ?? 'eu-west-1';
const password = process.env.PGPASSWORD;
const baseline = process.argv.includes('--baseline');

if (!password) {
  console.error('PGPASSWORD is empty — run scripts/db-push.ps1 so the password is prompted for.');
  process.exit(1);
}

const hosts = [`aws-0-${region}.pooler.supabase.com`, `aws-1-${region}.pooler.supabase.com`];

async function connect() {
  let lastError;
  for (const host of hosts) {
    const client = new pg.Client({
      host,
      port: 5432,
      user: `postgres.${ref}`,
      password,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15_000,
      statement_timeout: 0,
    });
    try {
      await client.connect();
      console.log(`connected: ${host} as postgres.${ref}`);
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      lastError = error;
      const message = String(error.message ?? '');
      // The pooler answers "tenant/user ... not found" when the project lives
      // behind the other pooler shard, so that one is worth retrying.
      if (!/tenant|not found|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(message)) throw error;
      console.warn(`  ${host}: ${message.split('\n')[0]}`);
    }
  }
  throw lastError ?? new Error('no pooler host answered');
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

    for (const name of files) {
      if (applied.has(name)) {
        console.log(`skip    ${name}`);
        continue;
      }
      const sql = await readFile(path.join(migrationsDir, name), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into public._sc_migrations (name) values ($1)', [name]);
        await client.query('commit');
        console.log(`applied ${name}`);
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        console.error(`\nfailed  ${name}`);
        console.error(`  ${error.message}`);
        if (error.detail) console.error(`  detail: ${error.detail}`);
        if (error.hint) console.error(`  hint:   ${error.hint}`);
        process.exitCode = 1;
        return;
      }
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
  process.exit(1);
});
