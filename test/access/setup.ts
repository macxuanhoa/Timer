import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
const NAME = 'sc305-access-e2e';
const docker = (args: string[], input?: string) => execFileSync('docker', args, { encoding: 'utf8', input, stdio: ['pipe','pipe','pipe'] });
export default async function setup() {
  try { docker(['rm','-f',NAME]); } catch { /* only our named test container */ }
  docker(['run','-d','--name',NAME,'-p','127.0.0.1:55436:5432','-e','POSTGRES_PASSWORD=postgres','postgres:16-alpine']);
  try {
    for (let i=0;i<40;i++) {
      try { docker(['exec',NAME,'pg_isready','-U','postgres']); break; }
      catch { if (i===39) throw new Error('Local test database unavailable'); await new Promise(r=>setTimeout(r,500)); }
    }
    docker(['exec',NAME,'createdb','-U','postgres','sc305_access']);
    const files = ['supabase/tests/000_local_auth_stub.sql', ...readdirSync('supabase/migrations').sort().map(f=>'supabase/migrations/'+f)];
    for (const f of files) docker(['exec','-i',NAME,'psql','-U','postgres','-d','sc305_access','-v','ON_ERROR_STOP=1','-q'],readFileSync(f,'utf8'));
    docker(['exec','-i',NAME,'psql','-U','postgres','-d','sc305_access','-v','ON_ERROR_STOP=1','-q'],
      "select sc._ensure_event();");
  } catch (err) { docker(['rm','-f',NAME]); throw err; }
  return () => { docker(['rm','-f',NAME]); };
}
