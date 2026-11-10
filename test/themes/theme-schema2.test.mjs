// 验证主题包安装、引用解除和删除。
// Check theme package installation, reference removal, and deletion.

﻿import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { makeStoredZip } from '../helpers/zip.mjs';

const code = `
import { installPackage } from './backends/worker/src/lib/theme/install';
import { removeTheme } from './backends/worker/src/lib/theme/registry';
import { defaultPresentation } from './shared/presentation';
let held = false;
export default { async fetch(request,env) {
 const u=new URL(request.url);
 if(u.pathname==='/held') return Response.json({held});
 if(u.pathname==='/hold-install') {
  const bucket=new Proxy(env.THEMES,{get(target,key){if(key==='put')return async(...args)=>{if(!held){held=true;await new Promise(resolve=>setTimeout(resolve,2000));}return target.put(...args);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
  return Response.json(await installPackage({...env,THEMES:bucket},new Uint8Array(await request.arrayBuffer())));
 }
 if(u.pathname==='/install') return Response.json(await installPackage(env,new Uint8Array(await request.arrayBuffer())));
 if(u.pathname==='/select') {
  const selection=await request.json(), config=defaultPresentation();
  for(const page of Object.values(config.pages)) { page.theme=selection; page.themeOptions={ headline:'chosen' }; }
  await env.DB.prepare("INSERT INTO presentation_state VALUES('main',?,?,?)").bind(JSON.stringify(config),'rev',0).run();
  return Response.json({ok:true});
 }
 if(u.pathname==='/remove') {
  let bucket=env.THEMES;
  if(u.searchParams.has('fail')) bucket=new Proxy(bucket,{get(target,key){if(key==='delete')return async()=>{throw new Error('injected')};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
  return Response.json(await removeTheme({...env,THEMES:bucket},'sample'));
 }
 return new Response('not found',{status:404});
}};`;
const bundle=await build({stdin:{contents:code,resolveDir:process.cwd(),sourcefile:'theme-test.ts'},bundle:true,format:'esm',platform:'neutral',target:'es2022',write:false,external:['cloudflare:sockets'],logLevel:'error',plugins:[{name:'pg',setup(b){b.onResolve({filter:/^postgres$/},()=>({path:'pg',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export default function() {}'}));}}]});
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-01-01',compatibilityFlags:['nodejs_compat','no_handle_cross_request_promise_resolution'],d1Databases:{DB:'theme-schema2'},r2Buckets:{THEMES:'theme-schema2'}});
const db=await mf.getD1Database('DB'), bucket=await mf.getR2Bucket('THEMES');
await db.exec(`CREATE TABLE themes(short TEXT PRIMARY KEY,id TEXT UNIQUE,name TEXT,version TEXT,description TEXT,author TEXT,source_url TEXT,manifest_json TEXT,installed_at INTEGER,updated_at INTEGER, deleting INTEGER NOT NULL DEFAULT 0);
CREATE TABLE theme_versions(id TEXT,version TEXT,digest TEXT,prefix TEXT,manifest_json TEXT,installed_at INTEGER,PRIMARY KEY(id,version,digest));
CREATE TABLE presentation_state(id TEXT PRIMARY KEY,config_json TEXT,revision TEXT,updated_at INTEGER);
CREATE TABLE live_state(id TEXT PRIMARY KEY,json TEXT,updated_at INTEGER);
CREATE TABLE theme_operations(id TEXT PRIMARY KEY,token TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
const manifest={schema:2,id:'sample',short:'sample',name:'Sample',version:'1.0.0',themes:[{id:'monitor',name:'Monitor',target:'monitor',entry:'monitor/index.html',capabilities:['public.status'],options:[]},{id:'agent',name:'Agent',target:'agent',entry:'agent/index.html',capabilities:['public.servers'],options:[]}]};
const zip=makeStoredZip({'polaris-theme.json':JSON.stringify(manifest),'monitor/index.html':'<link href="/assets/shared.css"><script src="/assets/app.js"></script>','agent/index.html':'<link href="/assets/shared.css"><script src="/assets/app.js"></script>','assets/shared.css':'body{background:url("/assets/pic.png")}','assets/app.js':'export const image="/assets/pic.png"','assets/pic.png':'pic'});
const req=(path,init)=>mf.dispatchFetch('http://localhost'+path,init);
try {
 const installed=await (await req('/install',{method:'POST',body:zip})).json();
 assert.equal(installed.ok,true,JSON.stringify(installed));
 for(const path of ['monitor/index.html','agent/index.html']) assert.match(await (await bucket.get(installed.prefix+'/'+path)).text(),/\.\.\/assets\/shared\.css/);
 assert.match(await (await bucket.get(installed.prefix+'/assets/app.js')).text(),new RegExp('/theme/'+installed.prefix+'/assets/pic\\.png'));
 const selection={short:'sample',version:installed.versionKey,theme:'monitor'};
 await req('/select',{method:'POST',body:JSON.stringify(selection)});
 const holding=req('/hold-install',{method:'POST',body:zip});
 for(let i=0;i<100;i++) { if((await (await req('/held')).json()).held) break; await new Promise(resolve=>setTimeout(resolve,10)); }
 assert.equal((await (await req('/held')).json()).held,true);
 assert.equal((await (await req('/remove')).json()).error,'theme_busy');
 assert.equal((await (await holding).json()).ok,true);
 const failure=await (await req('/remove?fail=1')).json(); assert.equal(failure.error,'theme_delete_failed');
 const deleting=await db.prepare('SELECT deleting FROM themes WHERE short=?').bind('sample').first();
 assert.equal(deleting.deleting,1);
 assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM theme_versions WHERE id=?').bind('sample').first()).count,0);
 const reinstall=await (await req('/install',{method:'POST',body:zip})).json();
 assert.equal(reinstall.error,'theme_id_short_conflict');
 let state=await db.prepare('SELECT * FROM presentation_state').first();
 for(const config of [JSON.parse(state.config_json)]) for(const page of Object.values(config.pages)) {assert.equal(page.theme,null);assert.deepEqual(page.themeOptions,{});}
 assert.equal((await (await req('/remove')).json()).ok,true);
 assert.equal(await db.prepare('SELECT short FROM themes WHERE short=?').bind('sample').first(),null);
 await db.prepare('INSERT INTO theme_operations(id,token,expires_at) VALUES (?,?,?)').bind('sample','expired',0).run();
 assert.equal((await (await req('/install',{method:'POST',body:zip})).json()).ok,true);
 assert.equal(await db.prepare('SELECT id FROM theme_operations WHERE id=?').bind('sample').first(),null);
 console.log('schema 2 theme installation and deletion passed');
} finally { await mf.dispose(); }
