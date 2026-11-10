// 验证 UDP 和 ICMP 的能力准入、任务分发与结果持久化。
// Check UDP and ICMP capability gates, job dispatch, and result persistence.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import { workerBundlePlugins } from '../helpers/bundle-worker.mjs';

const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import {api} from './backends/worker/src/api';
import {runTick} from './backends/worker/src/lib/jobs/tick';
let clock=1800000000;Date.now=()=>clock*1000;
export default {async fetch(request,env,ctx){const url=new URL(request.url);
 if(url.pathname==='/__tick'){clock=Number(url.searchParams.get('now'));await runTick(env,clock);return Response.json({ok:true});}
 return api.fetch(request,env,ctx);
}};`},bundle:true,write:false,format:'esm',target:'es2022',plugins:workerBundlePlugins(),logLevel:'error'});
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-01-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'native-network'},bindings:{ADMIN_TOKEN:'fixture'}});
async function request(path,body,admin=true,method=body===undefined?'GET':'POST'){
 const response=await mf.dispatchFetch('http://localhost'+path,{method,headers:{...(admin?{authorization:'Bearer fixture'}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {status:response.status,body:await response.json()};
}
const ok=async(...args)=>{const r=await request(...args);assert.ok(r.status<300,JSON.stringify(r));return r.body;};
try{
 const db=await mf.getD1Database('DB');await applyD1Migrations(db);
 const machine=await ok('/api/admin/agents',{name:'Native network node'});
 const now=1800000000;
 await db.prepare('INSERT INTO machine_live(agent_id,version,probe_capabilities,reported_at,report_interval_secs,updated_at) VALUES(?,?,?,?,60,?)')
  .bind(machine.id,'0.1.0',JSON.stringify(['probe_http','probe_tcp','probe_udp','probe_icmp']),now,now).run();
 const source={check_source:{type:'agent',agent_id:machine.id}};
 for(const type of ['udp','icmp']){
  const target=type==='udp'?'127.0.0.1:9000':'::1';
  for(const options_json of [{},{check_source:{type:'worker'}}]){
   const rejected=await request('/api/monitors',{name:'Rejected Worker source',type,target,options_json});
   assert.equal(rejected.status,400);assert.equal(rejected.body.error,'agent_source_required');
  }
 }
 await db.prepare('UPDATE machine_live SET reported_at=? WHERE agent_id=?').bind(now-1000,machine.id).run();
 assert.equal((await request('/api/monitors',{name:'Offline source',type:'udp',target:'127.0.0.1:9000',options_json:source})).body.error,'agent_offline');
 await db.prepare('UPDATE machine_live SET reported_at=? WHERE agent_id=?').bind(now,machine.id).run();
 const malformed=await request('/api/monitors',{name:'Bad hex',type:'udp',target:'127.0.0.1:9000',options_json:{...source,send:'abc',encoding:'hex'}});
 assert.equal(malformed.body.error,'udp_options_invalid');
 const udp=await ok('/api/monitors',{name:'UDP',type:'udp',target:'127.0.0.1:9000',options_json:{...source,send:'70696e67',expect:'706f6e67',encoding:'hex'}});
 const icmp=await ok('/api/monitors',{name:'ICMP',type:'icmp',target:'::1',options_json:source});
 await ok('/__tick?now='+now);
 const jobs=(await ok('/api/public/agent/jobs/'+machine.token,undefined,false)).jobs;
 assert.deepEqual(jobs.map(job=>job.type).sort(),['icmp','udp']);
 for(const job of jobs)await ok('/api/public/agent/results/'+machine.token,{run_id:job.run_id,lease_token:job.lease_token,observed_at:now,status:1,status_code:0,latency_ms:2.5,message:'',addons:{}},false);
 await ok('/__tick?now='+(now+60));
 const status=(await ok('/api/public/status',undefined,false)).monitors;
 assert.ok(status.every(m=>m.st===1&&m.source==='agent'));
 assert.equal(status.find(m=>m.id===icmp.id).target,'::1');
 const forcedWorker=await request('/api/monitors/'+udp.id,{options_json:{check_source:{type:'worker'}}},true,'PUT');
 assert.equal(forcedWorker.body.error,'agent_source_required');
 await db.prepare('UPDATE monitors SET options_json=? WHERE id=?').bind('{}',udp.id).run();
 await ok('/__tick?now='+(now+120));
 const persisted=JSON.parse((await db.prepare("SELECT json FROM live_state WHERE id='all'").first()).json);
 assert.equal(persisted[udp.id].source_available,false);
 console.log('PASS Agent-only UDP/ICMP: required online capable source, Worker rejection, hex validation, job dispatch, persisted readings and no Worker fallback');
}finally{await mf.dispose();}
