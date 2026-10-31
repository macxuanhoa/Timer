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
