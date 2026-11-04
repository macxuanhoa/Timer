/**
 * Shared Supabase connection for the organiser scripts.
 *
 * The direct host `db.<ref>.supabase.co` only publishes an AAAA record, so it
 * fails on IPv4-only networks and inside Docker. Everything goes through the
 * Supavisor pooler instead, which is dual-stack. The password is read from
 * PGPASSWORD so it never lands in argv or in the shell history.
 */
import pg from 'pg';

export const projectRef = process.env.SUPABASE_PROJECT_REF ?? 'efsamoxceegkrwucpqkq';
export const region = process.env.SUPABASE_REGION ?? 'eu-west-1';

const hosts = [`aws-0-${region}.pooler.supabase.com`, `aws-1-${region}.pooler.supabase.com`];

export function requirePassword() {
  const password = process.env.PGPASSWORD;
  if (!password) {
    throw new Error('PGPASSWORD is empty — run the matching scripts/*.ps1 so the password is prompted for.');
  }
  return password;
}

export async function connect() {
  const password = requirePassword();

  // Target guard: an ambient DB_HOST (a leftover from an isolated rehearsal
  // shell) must NEVER silently redirect a production script. The override is
  // honoured only when the operator opts in explicitly with
  // SC_ALLOW_ISOLATED_DB=yes; otherwise the script refuses and says why.
  if (process.env.DB_HOST && process.env.SC_ALLOW_ISOLATED_DB !== 'yes') {
    throw new Error(
      `TargetGuard: DB_HOST=${process.env.DB_HOST} is set in this shell. Production scripts refuse an ambient database override. Open a fresh terminal, or set SC_ALLOW_ISOLATED_DB=yes deliberately for an isolated rehearsal database.`);
  }
  if (process.env.DB_HOST) {
    const client = new pg.Client({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER || 'postgres',
      password,
      database: process.env.DB_NAME || 'postgres',
      ssl: process.env.DB_SSL === 'disable' ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 15_000,
      statement_timeout: 0,
    });
    await client.connect();
    console.log(`connected: ${process.env.DB_HOST}:${process.env.DB_PORT || 5432} (ISOLATED REHEARSAL — not production)`);
    return client;
  }

  // Production path: the only accepted target is the verified Supavisor pooler
  // for the configured project. Both are printed WITHOUT any credential, and a
  // foreign project ref is refused before a single byte is sent.
  if (!hosts.some((h) => /pooler\.supabase\.com$/.test(h)) || !/^[a-z]{20}$/.test(projectRef)) {
    throw new Error(`TargetGuard: unexpected pooler configuration for ref "${projectRef}" — refusing to connect.`);
  }
  console.log(`target: supavisor ${region} · project ${projectRef} · database postgres (no credentials shown)`);

  let lastError;

  for (const host of hosts) {
    const client = new pg.Client({
      host,
      port: 5432,
      user: `postgres.${projectRef}`,
      password,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15_000,
      statement_timeout: 0,
    });
    try {
      await client.connect();
      console.log(`connected: ${host} as postgres.${projectRef}`);
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
