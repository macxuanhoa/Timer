#!/usr/bin/env node
/* Read-only snapshot of every sc.* table to a local JSON file, run automatically
 * by db-push.ps1 BEFORE any migration. This is the recovery artefact for projects
 * whose plan has no dashboard backups; it never writes to the database. */
import { connect } from './lib/pooler.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const tables = [
  'events', 'rounds', 'action_log', 'reset_tasks', 'state', 'operators',
  'observer_seats', 'station_access_config', 'access_audit', 'runtime_flags',
  'admin_devices', 'device_claims', 'station_codes', 'station_occupancy',
];
const client = await connect();
const out = { at: new Date().toISOString(), note: 'read-only export, produced by db-push.ps1 before migration', tables: {} };
try {
  for (const t of tables) {
    // Whitelisted names only; the catalogue decides what actually exists on this schema.
    const { rows: reg } = await client.query('select to_regclass($1) as reg', [`sc.${t}`]);
    if (!reg[0].reg) continue;
    out.tables[t] = (await client.query(`select * from sc.${t}`)).rows;
  }
  mkdirSync('.audit-tmp/backups', { recursive: true });
  const file = `.audit-tmp/backups/hosted-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(out, null, 1));
  const counts = Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length]));
  console.log('BACKUP OK ->', file);
  console.log('rows:', JSON.stringify(counts));
  if (!counts.rounds) { console.error('BACKUP EMPTY: no sc.rounds table — is this the right database?'); process.exitCode = 3; }
} finally {
  await client.end().catch(() => undefined);
}
