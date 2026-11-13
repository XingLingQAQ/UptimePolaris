// 使用实际二进制验证运行配置生效、冲突和重启持久化。
// Use a binary to check runtime configuration application, conflicts, and restart persistence.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { workerBundlePlugins } from '../helpers/bundle-worker.mjs';

const binary = resolve(process.env.AGENT_RUNTIME_TEST_BIN ?? join(process.env.CARGO_TARGET_DIR ?? 'agent/target', 'debug', process.platform === 'win32' ? 'polaris-agent.exe' : 'polaris-agent'));
await readFile(binary);
const versionResult = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
assert.equal(versionResult.status, 0, versionResult.error?.message ?? versionResult.stderr);
const version = versionResult.stdout.trim().match(/^polaris-agent (\S+)$/)?.[1];
assert.ok(version, 'Agent binary must report its version');
const bundle = await build({ stdin: { contents: `import worker from './backends/worker/src/index.ts'; export default { ...worker, fetch(request,env,ctx) { if(env.RUNTIME_TEST_HTTP && request.headers.get('upgrade')==='websocket') return new Response('fixture forces HTTP fallback',{status:426}); return worker.fetch(request,env,ctx); } };`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', plugins: workerBundlePlugins(), logLevel: 'error' });
const pause = ms => new Promise(done=>setTimeout(done,ms));

async function run(transport, locked = null) {
  const owner=crypto.randomUUID();
  const directory=await mkdtemp(join(tmpdir(),'uptime-polaris-runtime-native-'));
  await writeFile(join(directory,'.owner'),owner);
  const executable=join(directory,process.platform==='win32'?'polaris-agent.exe':'polaris-agent');
  const mf=new Miniflare({ modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-01-01',compatibilityFlags:['nodejs_compat'],host:'127.0.0.1',port:0,analyticsEngineDatasets: { UPTIME: { dataset: 'setup_fixture' } }, d1Databases:['DB'],bindings:{ADMIN_TOKEN:'runtime-native-secret',RUNTIME_TEST_HTTP:transport==='http'} });
  let child;
  let exited;
  let diagnostics='';
  const stop=async()=>{
    if(!child)return;
    child.kill();
    await Promise.race([exited,pause(3000)]);
    if(child.exitCode===null)child.kill('SIGKILL');
    child=null;
  };
  try {
    await copyFile(binary,executable);
    const origin=(await mf.ready).origin;
    const request=async(path,method='GET',body)=>{
      const response=await fetch(origin+path,{method,headers:{authorization:'Bearer runtime-native-secret','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      assert.equal(response.status>=200&&response.status<300,true,await response.clone().text());
      return response.json();
    };
    const until=async(read,predicate,label)=>{
      for(let i=0;i<180;i++){
        if(child?.exitCode!==null&&child)throw new Error(`Agent exited during ${label}: ${diagnostics.slice(-1000)}`);
        const value=await read();
        if(predicate(value))return value;
        await pause(500);
      }
      throw new Error(`${transport}: ${label} timed out: ${diagnostics.slice(-1000)}`);
    };
    await request('/api/auth/setup','POST',{credential:'runtime-native-secret',username:'runtime-native',password:'runtime-native-password'});
    await request('/api/admin/settings','PUT',{'security.allowAgentCommands':true});
    const agent=await request('/api/admin/agents','POST',{ name: `Runtime ${transport}` });
    const file=join(directory,'config.json');
    await writeFile(file,JSON.stringify({endpoint:origin,token:agent.token,sample_interval:1,report_interval:2,auto_update:false,insecure:false}));
    const start=()=>{
      const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('POLARIS_AGENT_')));
      if(locked==='env'){env.POLARIS_AGENT_SAMPLE_INTERVAL='1';env.POLARIS_AGENT_INCLUDE_NICS='fixture-a,fixture-b,fixture-a';}
      child=spawn(executable,['run','--config',file,...(locked==='cli'?['--sample-interval','1','--include-nics','fixture-a,fixture-b,fixture-a']:[])],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...env,RUST_LOG:'warn',NO_PROXY:'127.0.0.1,localhost'}});
      child.stdout.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-5000);});
      child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-5000);});
      exited=new Promise(done=>child.once('exit',done));
    };
    start();
    const pid=child.pid;
    const configuration=()=>request(`/api/admin/agents/${agent.id}/config`);
    const first=await until(configuration,value=>value.supported,'initial actual configuration report');
    assert.equal(first.current.sample_interval_secs,1);
    assert.equal(first.current.report_interval_secs,2);
    const reported = await until(()=>request('/api/admin/agents'),value=>value.agents[0]?.transport===transport,`${transport} transport report`);
    if (process.platform === 'win32') {
      assert.match(reported.agents[0].os, /^Windows /);
      assert.doesNotMatch(reported.agents[0].os, /\uFFFD/);
    }
    assert.equal(first.installation.auto_update_supported, false, 'manual fixture must not promise a managed restart');
    if (locked) {
      assert.deepEqual(first.current.include_nics,['fixture-a','fixture-b']);
      const equivalent={...first.current,report_interval_secs:4,include_nics:['fixture-b','fixture-a']};
      const accepted=await request(`/api/admin/agents/${agent.id}/config`,'PUT',{config:equivalent,expected_revision:first.desired_revision});
      const applied=await until(configuration,value=>value.status==='synced'&&value.applied_revision===accepted.revision,'equivalent locked filters');
      assert.equal(applied.current.report_interval_secs,4);
      assert.deepEqual(applied.current.include_nics,['fixture-a','fixture-b']);
      await stop();
      const db=await mf.getD1Database('DB');
      await db.prepare('UPDATE agent_runtime_configs SET reported_json=NULL,applied_revision=NULL,last_error=NULL WHERE agent_id=?').bind(agent.id).run();
      start();
      const reloaded=await until(configuration,value=>value.status==='synced'&&value.applied_revision===accepted.revision,'equivalent filters after restart');
      assert.equal(reloaded.current.report_interval_secs,4);
      assert.deepEqual(reloaded.current.include_nics,['fixture-a','fixture-b']);
      const changed={...equivalent,include_nics:['fixture-a','fixture-c']};
      const rejected=await request(`/api/admin/agents/${agent.id}/config`,'PUT',{config:changed,expected_revision:accepted.revision});
      const filterConflict=await until(configuration,value=>value.status==='error'&&value.error?.includes('include_nics'),'changed filter conflict');
      assert.equal(filterConflict.current.report_interval_secs,4);
      assert.notEqual(filterConflict.applied_revision,rejected.revision);
      const desired={...equivalent,sample_interval_secs:2,report_interval_secs:6};
      const saved=await request(`/api/admin/agents/${agent.id}/config`,'PUT',{config:desired,expected_revision:rejected.revision});
      const conflict=await until(configuration,value=>value.status==='error'&&value.error?.includes('sample_interval'),'explicit interval conflict');
      assert.equal(conflict.current.sample_interval_secs,1);
      assert.notEqual(conflict.applied_revision,saved.revision);
      const persisted=JSON.parse(await readFile(file,'utf8'));
      assert.equal(persisted.sample_interval,1);
      assert.equal(persisted.report_interval,4);
      assert.equal(persisted.runtime_revision,accepted.revision);
      await stop();
      await db.prepare('UPDATE agent_runtime_configs SET reported_json=NULL,applied_revision=NULL,last_error=NULL WHERE agent_id=?').bind(agent.id).run();
      start();
      const stillLocked=await until(configuration,value=>value.status==='error'&&value.error?.includes('sample_interval'),'override retained after restart');
      assert.equal(stillLocked.current.sample_interval_secs,1);
      assert.equal(stillLocked.current.report_interval_secs,4);
      console.log(`PASS native ${transport}: ${locked} filter equivalence and conflict, explicit interval conflict, and restart consistency`);
      return;
    }
    const next={...first.current,sample_interval_secs:2,report_interval_secs:4,exclude_nics:['lo','fixture-never-match'],exclude_mounts:['/fixture-never-match']};
    const save=await request(`/api/admin/agents/${agent.id}/config`,'PUT',{config:next,expected_revision:first.desired_revision});
    const applied=await until(configuration,value=>value.applied_revision===save.revision&&value.status==='synced','hot reload acknowledgement');
    assert.deepEqual(applied.current,next);
    assert.equal(child.pid,pid);
    assert.equal(child.exitCode,null);
    const persisted=JSON.parse(await readFile(file,'utf8'));
    assert.equal(persisted.sample_interval,2);
    assert.equal(persisted.report_interval,4);
    assert.equal(persisted.runtime_revision,save.revision);
    assert.equal(Object.hasOwn(persisted,'interval'),false);
    assert.equal(persisted.endpoint,origin);
    assert.equal(persisted.token,agent.token);
    assert.equal(persisted.insecure,false);
    await until(()=>request('/api/admin/agents'),value=>value.agents[0]?.report_interval_secs===4,'fresh identity with applied report interval');
    await stop();
    const db=await mf.getD1Database('DB');
    await db.prepare('UPDATE agent_runtime_configs SET reported_json=NULL,applied_revision=NULL WHERE agent_id=?').bind(agent.id).run();
    await db.prepare('UPDATE machine_live SET reported_at=0 WHERE agent_id=?').bind(agent.id).run();
    start();
    await until(configuration,value=>value.applied_revision===save.revision&&value.current?.report_interval_secs===4,'persisted configuration after restart');
    await until(()=>request('/api/admin/agents'),value=>value.agents[0]?.version===version&&value.agents[0]?.last_reported_at>0&&value.agents[0]?.report_interval_secs===4,'new Agent version and report after restart');
    console.log(`PASS native ${transport}: reported actual configuration, applied desired revision without process restart, persisted settings and credentials, refreshed identity and retained configuration after restart`);
  } finally {
    await stop();
    await mf.dispose();
    const childPath=relative(resolve(tmpdir()),resolve(directory));
    if(!childPath.startsWith('uptime-polaris-runtime-native-')||childPath.includes(sep)||await readFile(join(directory,'.owner'),'utf8')!==owner)throw new Error('Refusing to remove unowned native fixture');
    await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
const outcomes=await Promise.allSettled([run('ws'),run('http')]);
for(const outcome of outcomes)if(outcome.status==='rejected')throw outcome.reason;

await run('ws', 'cli');
await run('ws', 'env');
