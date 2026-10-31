/** Production access smoke only: never calls event/timer/snapshot commands.
 * Uses fresh anonymous identities, claims at most ONE vacant NPC slot briefly,
 * and releases only bindings owned by those identities in finally.
 * Run: node --env-file=.env.local scripts/verify-production-access.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { writeFile } from 'node:fs/promises';

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) throw new Error('Missing production publishable configuration');
const client = () => createClient(url, key, { auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false } });
const reader=client(), a=client(), b=client();
const report={ at:new Date().toISOString(), checks:[], unverified:[] };
const check=(name,ok)=>{report.checks.push({name,ok}); if(!ok)throw new Error(name);console.log('PASS',name);};
const rpc=async(c,name,args={})=>{const {data,error}=await c.rpc(name,args).abortSignal(AbortSignal.timeout(12000));if(error)throw new Error(error.message);return data;};
let channel;
const changes=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
try {
  const initial=await rpc(reader,'station_board');
  report.initial=initial;
  check('public board declares six slots',initial.device_capacity===6 && initial.stations.length===5 &&
    initial.stations.every(s=>s.capacity===(s.role==='SUPERVISOR'?2:1)&&s.devices<=s.capacity));
  const {error:unsigned}=await reader.rpc('claim_station',{p_role:'GATE',p_pin:null});
  check('unsigned caller cannot claim',Boolean(unsigned));
  for(const c of [a,b]){const {error}=await c.auth.signInAnonymously();if(error)throw new Error(error.message);}
  check('hosted anonymous auth',true);
  check('fresh identity has no station',(await rpc(a,'whoami'))===null);
  const {error:legacy}=await a.rpc('redeem_invitation',{p_token:'x'.repeat(43),p_device_id:'spoof'});
  check('legacy invitation grant revoked',Boolean(legacy));
  const denied=await rpc(a,'handle_command',{p_action:'GAME_STOP',p_meta:{},p_expected_revision:0,p_idempotency_key:crypto.randomUUID()});
  check('unbound identity cannot send an event command',denied.code==='PERMISSION_DENIED');
  const target=initial.stations.find(s=>s.role!=='SUPERVISOR'&&s.devices===0);
  if(target){
    let postgresReady=false;
    channel=reader.channel('access-smoke-'+crypto.randomUUID())
      .on('system',{},payload=>{if(payload.extension==='postgres_changes'&&payload.status==='ok')postgresReady=true;})
      .on('postgres_changes', {event:'UPDATE',schema:'public',table:'station_occupancy'},payload=>changes.push(payload.new));
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Realtime subscription timed out')),15000);
      channel.subscribe(status=>{if(status==='SUBSCRIBED'){clearTimeout(timer);resolve();}
        else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'){clearTimeout(timer);reject(new Error('Realtime '+status));}});
    });
    for(let i=0;i<100&&!postgresReady;i++)await pause(200);
    check('Postgres change stream registered',postgresReady);
    check('public occupancy Realtime subscribed',true);
    const results=await Promise.all([a,b].map(c=>rpc(c,'claim_station',{p_role:target.role,p_pin:null})));
    check('production final NPC slot is atomic',results.filter(r=>r.ok).length===1&&results.filter(r=>r.code==='ROLE_TAKEN').length===1);
    const winner=results[0].ok?a:b;
    check('whoami resolves claimed role',(await rpc(winner,'whoami'))?.role===target.role);
    check('same identity does not take another slot',(await rpc(winner,'claim_station',{p_role:target.role,p_pin:null})).code==='ALREADY_BOUND');
    check('same identity cannot claim supervisor',(await rpc(winner,'claim_station',{p_role:'SUPERVISOR',p_pin:null})).code==='ALREADY_BOUND_OTHER_ROLE');
    for(let i=0;i<30&&!changes.some(x=>x.role===target.role&&x.devices===1);i++)await pause(200);
    check('Realtime delivered committed claim',changes.some(x=>x.role===target.role&&x.devices===1));
    check('release acknowledged',(await rpc(winner,'release_device')).ok===true);
    check('released identity has no authority',(await rpc(winner,'whoami'))===null);
    for(let i=0;i<30&&!changes.some(x=>x.role===target.role&&x.devices===0);i++)await pause(200);
    check('Realtime delivered committed release',changes.some(x=>x.role===target.role&&x.devices===0));
    check('vacant slot immediately reclaimable',(await rpc(winner,'claim_station',{p_role:target.role,p_pin:null})).ok===true);
    await rpc(winner,'release_device');
  }else report.unverified.push('No vacant NPC slot: live claim/release skipped to preserve existing operators.');
  report.unverified.push('Two live supervisor claims: requires the privately entered PIN and available seats; proven locally.');
  report.status='passed';
}catch(error){report.status='failed';report.error=error.message;console.error(error.message);process.exitCode=1;}
finally {
  // These clients only know fresh test identities; no on-duty device can be released.
  for(const c of [a,b]){
    try {const {data}=await c.auth.getSession();if(data.session)await rpc(c,'release_device');}
    catch {report.unverified.push('A test identity release needs a retry; no other binding was modified.');process.exitCode=1;}
  }
  if(channel)await reader.removeChannel(channel);
  report.final=await rpc(reader,'station_board').catch(()=>null);
  await writeFile('.git/production-access-verification.json',JSON.stringify(report,null,2));
  console.log('Final occupancy',report.final?.devices+'/6');
  for(const c of [reader,a,b])await c.removeAllChannels();
}
process.exit(process.exitCode??0);
