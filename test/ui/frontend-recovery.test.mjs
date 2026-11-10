// 使用受控 hook 替身验证表单恢复；不模拟浏览器布局。
// Use controlled hook stubs to check form recovery without simulating browser layout.

﻿import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('../../frontend/node_modules/esbuild');
const source = path => readFileSync(path, 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

{
  const src = source('frontend/src/admin/useAutoSave.tsx');
  const part = src.slice(src.indexOf('export function useAutoSave'), src.indexOf('export function AutoSaveStatus')).replace('export function', 'function');
  const code = esbuild.transformSync(part + '\nreturn useAutoSave;', { loader: 'tsx' }).code;
  let state = [], cursor = 0, effects = [];
  const useRef = initial => { const i = cursor++; return state[i] ??= { current: initial }; };
  const useState = initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], v => { state[i] = typeof v === 'function' ? v(state[i]) : v; }]; };
  const useEffect = fn => { effects.push(fn); cursor++; };
  const useCallback = fn => { cursor++; return fn; };
  const hook = Function('useRef', 'useState', 'useEffect', 'useCallback', code)(useRef,useState,useEffect,useCallback);
  const writes = [];
  let fail = false;
  const write = async patch => { writes.push(patch); if (fail) throw Error('503'); };
  function render() { cursor = 0; effects = []; const out = hook(write); for (const f of effects) f(); return out; }
  let api = render();
  api.schedule({ domains: ['valid.example'] });
  api.cancel('domains');
  await api.flush(); await wait(650);
  assert.deepEqual(writes, [], 'invalid draft must cancel an unsent valid domain');
  api = render(); api.schedule({ domains: ['retry.example'] }); fail = true; await api.flush();
  api = render(); assert.equal(api.state, 'error'); fail = false; api.retry(); await wait(10);
  assert.deepEqual(writes, [{ domains: ['retry.example'] }, { domains: ['retry.example'] }], 'a real 503 remains retryable');
  api = render(); assert.equal(api.state, 'saved');
}

{
  const src = source('frontend/src/admin/notifications/NotificationsPanel.tsx');
  const part = src.slice(src.indexOf('function ChannelForm('));
  const code = esbuild.transformSync(part + '\nreturn ChannelForm;', { loader: 'tsx', jsx: 'transform' }).code;
  let states = [], deps = [], cursor = 0, effects = [];
  const useState = initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], v => { states[i] = typeof v === 'function' ? v(states[i]) : v; }]; };
  const useRef = initial => { const i = cursor++; return states[i] ??= { current: initial }; };
  const useEffect = (fn, next) => { const i = cursor++; if (!deps[i] || next.some((v,j) => v !== deps[i][j])) { deps[i] = next; effects.push(fn); } };
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const env = {React,useState,useRef,useEffect,notificationFieldRequired:()=>true,useTranslations:()=>key=>key,useLocale:()=>({locale:'en-US'}),useApiErrorMessage:()=>String,defaultNotificationLanguage:'en-US',resolveNotificationLanguage:()=> 'en-US',isNotificationLanguage:()=>true,messageLanguages:[],NOTIFICATION_META:{telegram:{fields:[],labelKey:'provider',hintKey:'hint'}},scopeIds:()=>[],notificationsApi:{createNotification:()=>pending}};
  for (const name of ['Drawer','DrawerBody','DrawerContent','DrawerFooter','DrawerHeader','Input','Select','SelectItem','Switch','Button','ProviderTile','Loader2']) env[name]=name;
  const Form = Function(...Object.keys(env),code)(...Object.values(env));
  let currentSession = 1, open = true;
  const props = {open,session:1,channel:null,isCreate:true,groups:[],initialType:null,onClose:()=>{},onSaved:id=>{ if (id===currentSession) open=false; }};
  const render = () => {cursor=0;effects=[];props.open=open;props.session=currentSession;const tree=Form(props);effects.forEach(fn=>fn());return tree;};
  const find = (node,pred) => !node || typeof node !== 'object' ? undefined : pred(node) ? node : (node.props?.children ?? []).flat(Infinity).map(c=>find(c,pred)).find(Boolean);
  render(); let tree=render(); find(tree,n=>n.type==='Input'&&n.props.label==='notify.name').props.onValueChange('first'); tree=render();
  find(tree,n=>n.type==='Button'&&n.props.children.includes('action.save')).props.onPress();
  open=false; currentSession++; render();
  props.channel={id:'second',name:'second',type:'telegram',config:{},active:1};props.isCreate=false;open=true;currentSession++;render();tree=render();
  const toggle=find(tree,n=>n.type==='Switch'); assert.equal(toggle.props.isDisabled,false);toggle.props.onValueChange(false);render();resolve({});await wait(0);tree=render();
  assert.equal(open,true,'old save must not close newer form'); assert.equal(find(tree,n=>n.type==='Switch').props.isSelected,false,'new draft remains intact');
}
console.log('frontend recovery: autosave cancellation/retry and notification session race passed');

function extractFunction(text, marker) {
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, marker);
  const body = text.indexOf('{', text.indexOf(')', start));
  let depth = 0;
  for (let i = body; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw Error(`unclosed ${marker}`);
}
function compile(part, name, env) {
  const code = esbuild.transformSync(part + `\nreturn ${name};`, { loader:'tsx', jsx:'transform' }).code;
  return Function(...Object.keys(env), code)(...Object.values(env));
}
{
  const src=source('frontend/src/admin/monitors/MonitorForm.tsx');
  const part=extractFunction(src,'function normalizeForSubmit(');
  const normalize=compile(part,'normalizeForSubmit',{addonsDisabled:false,selectedSource:'',backendSource:'server',isProbeMonitorType:()=>false,parseOptions:JSON.parse});
  const tcp={type:'tcp',target:'example:1',options_json:'{"send":"PING"}'};
  const push=normalize({...tcp,type:'push'});
  assert.equal(push.target,'');assert.equal(push.options_json,'{}');assert.equal(tcp.options_json,'{"send":"PING"}');
}
{
  const src=source('frontend/src/admin/themes/ThemesPage.tsx');
  const part=extractFunction(src,'async function openPreview(');
  const requests={}; const previewRequest={current:0}; let visible=null,busy=null;
  const themesApi={preview:(id)=>new Promise(resolve=>requests[id]=resolve)};
  const fn=compile(part,'openPreview',{previewRequest,themesApi,setPreview:value=>visible=value,setPreviewBusy:value=>busy=value,UnauthorizedError:class extends Error{},login:()=>{},toast:{error:()=>{}},apiErrorMessage:String});
  const a=fn('a','v1','a'), b=fn('b','v1','b');requests.b('B');await b;requests.a('A');await a;assert.equal(visible,'B');assert.equal(busy,null);
  const c=fn('c','v1','c');previewRequest.current++;visible=null;requests.c('C');await c;assert.equal(visible,null);
}
{
  const src=source('frontend/src/admin/notifications/NotificationsPanel.tsx');
  const part=extractFunction(src,'async function test(c:');
  const calls=[];const test=compile(part,'test',{setBusy:id=>calls.push(['busy',id]),notificationsApi:{testNotification:async id=>{calls.push(['POST',id]);return {ok:true}}},toast:{success:()=>{},error:()=>{}},t:k=>k,apiErrorMessage:String,refreshStats:async()=>calls.push(['stats']),setLogRevision:fn=>{fn(0);calls.push(['log'])}});
  await test({id:'a',name:'A'});assert.deepEqual(calls,[['busy','a'],['POST','a'],['stats'],['log'],['busy',null]]);
}
console.log('frontend recovery: Push normalization, preview ordering and read-only refresh passed');

{
  const src=source('frontend/src/admin/notifications/providers.ts').replace(/^import type[^\n]*\n/, '').replaceAll('export const ', 'const ').replaceAll('export function ', 'function ');
  const compiled=esbuild.transformSync(src + '\nreturn {NOTIFICATION_META,notificationFieldRequired};', {loader:'ts'}).code;
  const {NOTIFICATION_META,notificationFieldRequired}=Function(compiled)();
  const missing=(type,config)=>NOTIFICATION_META[type].fields.filter(f=>notificationFieldRequired(type,f.key,config)&&!String(config[f.key]??'').trim()).map(f=>f.key);
  assert.deepEqual(missing('webhook',{url:'https://example.invalid'}),[]);
  assert.deepEqual(missing('webhook',{secret:'secret'}),['url']);
  assert.deepEqual(missing('apprise',{url:'https://example.invalid',urls:'tgram://destination'}),[]);
  assert.deepEqual(missing('apprise',{url:'https://example.invalid',key:'stored'}),[]);
  assert.deepEqual(missing('apprise',{url:'https://example.invalid'}),['urls']);
  assert.deepEqual(missing('telegram',{chat_id:'1'}),['bot_token']);
}
console.log('frontend recovery: optional provider secrets and required fields passed');
await import('./public-servers.test.mjs');
{
  const src=source('frontend/src/admin/notifications/NotificationsPanel.tsx');
  const part=src.slice(src.indexOf('function DeliveryStrip('),src.indexOf('/**\n * Recent delivery attempts'));
  const React={createElement:(type,props,...children)=>({type,props:{...props,children}})};
  const strip=compile(part,'DeliveryStrip',{React,useTranslations:()=>k=>k,StatBand:'Band',StatCell:'Cell',BellRing:'Bell',Send:'Send',CircleCheck:'Check',Timer:'Timer',HourlyBars:'Bars',Meter:'Meter',formatPercent:String,formatMs:x=>x});
  const out=strip({channels:[{active:1},{active:1}],stats:{a:{sent24h:100,failed24h:0,avgLatencyMs:10,hourly:[]},b:{sent24h:1,failed24h:0,avgLatencyMs:1000,hourly:[]}}});
  assert.equal(out.props.children[3].props.value,2000/101);
}
console.log('frontend recovery: weighted notification latency passed');
{
  const src=source('frontend/src/admin/settings/MaintenanceWindowEditor.tsx');
  const part=src.slice(src.indexOf('export function MaintenanceWindowEditor')).replace('export function','function');
  let states=[],deps=[],cursor=0,effects=[];
  const useState=initial=>{const i=cursor++;if(!(i in states))states[i]=initial;return [states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v}];};
  const useRef=initial=>{const i=cursor++;return states[i]??={current:initial};};
  const useEffect=(fn,next)=>{const i=cursor++;if(!deps[i]||next.some((v,j)=>v!==deps[i][j])){deps[i]=next;effects.push(fn);}};
  const React={createElement:(type,props,...children)=>({type,props:{...props,children}})};
  const env={useState,useRef,useEffect,React,useTranslations:()=>k=>k,useMotionList:()=>null,crypto:{randomUUID:()=> 'row'},parseWindow:w=>w.startsAt&&w.endsAt&&w.startsAt<w.endsAt,Select:'Select',Button:'Button',Input:'Input',SelectItem:'Item',Clock:'Clock',Plus:'Plus',Trash2:'Trash',once:()=>({kind:'once',startsAt:'2026-01-01T01:00:00.000Z',endsAt:'2026-01-01T02:00:00.000Z'})};
  const Editor=compile(part,'MaintenanceWindowEditor',env);
  let windows=[{kind:'once',startsAt:'2026-01-01T01:00:00.000Z',endsAt:'2026-01-01T02:00:00.000Z'}],valid=0,invalid=0;
  const render=()=>{cursor=0;effects=[];const tree=Editor({windows,onChange:v=>{windows=v;valid++},onInvalid:()=>invalid++});effects.forEach(fn=>fn());return tree;};
  const find=(n,p)=>!n||typeof n!=='object'?undefined:p(n)?n:(n.props?.children??[]).flat(Infinity).map(c=>find(c,p)).find(Boolean);
  let tree=render();find(tree,n=>n.type==='Input'&&n.props.label==='endTime').props.onValueChange('2026-01-01T03:00');tree=render();
  find(tree,n=>n.type==='Input'&&n.props.label==='endTime').props.onValueChange('');tree=render();
  assert.equal(valid,1);assert.equal(invalid,1);assert.equal(find(tree,n=>n.type==='Input'&&n.props.label==='endTime').props.value,'');
  find(tree,n=>n.type==='Input'&&n.props.label==='endTime').props.onValueChange('2026-01-01T04:00');tree=render();assert.equal(valid,2);assert.equal(windows[0].endsAt,'2026-01-01T04:00:00.000Z');
}
console.log('frontend recovery: maintenance invalid draft and valid recovery passed');

{
  const src = source('frontend/src/admin/layout/ConsoleStatus.tsx');
  assert.doesNotMatch(src, /<MotionConfig/, 'the status island inherits the shared motion preference');
}
console.log('frontend recovery: status island full-motion default passed');
