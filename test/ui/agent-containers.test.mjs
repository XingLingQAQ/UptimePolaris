import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createTranslator } = require('use-intl');
const source = readFileSync('frontend/src/admin/agents/AgentContainersCard.tsx', 'utf8');
const compiled = await build({ stdin: {contents: source.replace(/^import[\s\S]*?;\r?\n/gm,'').replace('export function','function')+'\nexport { AgentContainersCard };',loader:'tsx'},write:false,format:'cjs',jsx:'transform'});
async function load(path) {
  const compiled = await build({entryPoints:[path],bundle:true,write:false,format:'esm'});
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
}
const {asContainerStats} = await load('shared/agent-containers.ts');
const {formatBytes,formatOneDecimal} = await load('frontend/src/admin/format.ts');
const catalogs = Object.fromEntries(['en-US','zh-CN','zh-HK','zh-TW','ja-JP','ko-KR','fr-FR','pt-BR','ru-RU'].map(locale=>[locale,JSON.parse(readFileSync(`frontend/src/locales/admin/${locale}.json`,'utf8'))]));
let locale='en-US', state=[], cursor=0;
const icon=()=>null;
const bindings={React,useMemo:fn=>fn(),useState:initial=>{const index=cursor++; state[index]??=initial;return [state[index],value=>state[index]=typeof value==='function'?value(state[index]):value];},useTranslations:()=>createTranslator({locale,messages:{admin:catalogs[locale]},namespace:'admin.agents'}),AlertTriangle:icon,Box:icon,ChevronDown:icon,IconTile:icon,asContainerStats,formatBytes,formatOneDecimal};
const module={exports:{}};
Function('module','exports',...Object.keys(bindings),compiled.outputFiles[0].text)(module,module.exports,...Object.values(bindings));
const tree=raw=>{cursor=0;return module.exports.AgentContainersCard({containersJson:raw});};
const render=raw=>renderToStaticMarkup(tree(raw));
function buttons(node) {
  if(!node||typeof node!=='object')return [];
  return [...(node.type==='button'?[node]:[]),...React.Children.toArray(node.props?.children).flatMap(buttons)];
}
for(const value of [undefined,null,'[]','null','{bad','[{}]'])assert.equal(render(value),'');
const base={id:'id',name:'Service',runtime:'docker',state:'running'};
const rows=[{...base,id:'exit',name:'Exited',state:'exited'},...Array.from({length:9},(_,i)=>({...base,id:`run${i}`,name:`Running ${i}`})),{...base,id:'unhealthy',name:'<Private>',runtime:'podman',health:'unhealthy',image:'registry/app:v1',cpu_pct:250.25,mem_used_bytes:0,mem_limit_bytes:1024,restart_count:2},{...base,id:'dead',name:'Dead',state:'dead'},{...base,id:'restart',name:'Restart',state:'restarting'}];
const raw=JSON.stringify(rows);
let html=render(raw);
assert.ok(html.indexOf('title="&lt;Private&gt;"')<html.indexOf('title="Running 0"'));
assert.equal((html.match(/class="polaris-well px-3 py-2.5"/g)||[]).length,8);
assert.match(html,/CPU 250.3%/);assert.match(html,/Memory 0 B \/ 1.0 KB/);assert.match(html,/Restarts 2/);
assert.match(html,/Issues 3/);assert.match(html,/Running 10/);assert.match(html,/aria-expanded="false"/);
const filterLabels=raw=>buttons(tree(raw)).filter(button=>button.props['aria-pressed']!==undefined).map(button=>renderToStaticMarkup(button).replace(/<[^>]+>/g,''));
assert.deepEqual(filterLabels(raw),['All 13','Running 10','Issues 3']);
assert.match(html,/rounded-medium bg-default-100 p-0.5/);
assert.match(html,/bg-content1 text-foreground shadow-small/);
assert.match(html,/font-mono text-default-400" title="registry\/app:v1"/);
assert.match(html,/class="text-default-600">CPU 250.3%/);
buttons(tree(raw)).find(button=>button.props['aria-expanded']!==undefined).props.onClick();
assert.equal((render(raw).match(/class="polaris-well px-3 py-2.5"/g)||[]).length,13);
buttons(tree(raw)).find(button=>button.props['aria-expanded']!==undefined).props.onClick();
assert.match(render(raw),/aria-expanded="false"/);
buttons(tree(raw))[2].props.onClick();
html=render(raw);assert.equal((html.match(/class="polaris-well px-3 py-2.5"/g)||[]).length,3);assert.doesNotMatch(html,/title="Running|aria-expanded/);
buttons(tree(raw))[1].props.onClick();
html=render(raw);assert.doesNotMatch(html,/title="Dead"|title="Restart"/);assert.match(html,/aria-expanded="false"/);
buttons(tree(raw))[0].props.onClick();
const noIssues=JSON.stringify([{...base,id:'up'},{...base,id:'off',state:'exited'}]);
assert.deepEqual(filterLabels(noIssues),['All 2','Running 1']);
buttons(tree(raw))[2].props.onClick();
html=render(noIssues);
assert.doesNotMatch(html,/No containers match this filter/);
assert.equal((html.match(/class="polaris-well px-3 py-2.5"/g)||[]).length,2);
assert.equal(buttons(tree(noIssues))[0].props['aria-pressed'],true);
buttons(tree(noIssues))[0].props.onClick();
assert.doesNotMatch(render(JSON.stringify([base])),/role="group"|mt-1.5|aria-expanded/);
const zero=render(JSON.stringify([{...base,cpu_pct:0,mem_used_bytes:0,restart_count:0}]));
assert.match(zero,/CPU 0%/);assert.match(zero,/Memory 0 B/);assert.doesNotMatch(zero,/Restarts|—/);
for(const [row,tone] of [
  [{state:'restarting'},'warning'],
  [{health:'starting'},'warning'],
  [{health:'unhealthy'},'danger'],
  [{state:'dead'},'danger'],
  [{state:'restarting',health:'unhealthy'},'danger'],
  [{state:'dead',health:'starting'},'danger'],
  [{health:'healthy'},'success'],
]) {
  html=render(JSON.stringify([{...base,...row}]));
  assert.match(html,new RegExp(`bg-${tone}-500`));
  assert.match(html,new RegExp(`text-${tone}-(600|700) dark:text-${tone}-400`));
  if(tone==='warning')assert.doesNotMatch(html,/text-danger-/);
}
const noRunning=JSON.stringify([{...base,id:'off',state:'exited'},{...base,id:'dead',state:'dead'}]);
assert.deepEqual(filterLabels(noRunning),['All 2','Issues 1']);
const allStates=['running','exited','restarting','paused','dead','created','unknown'].map((s,i)=>({...base,id:`s${i}`,state:s,name:`State ${s}`}));
const allHealth=['healthy','unhealthy','starting','none'].map((health,i)=>({...base,id:`h${i}`,name:`Health ${health}`,health}));
for(locale of Object.keys(catalogs)) {
  state=['all',true];
  html=render(JSON.stringify([...allStates,...allHealth]));
  assert.ok(html.includes(catalogs[locale].agents.sectionContainers));
  for(const label of Object.values(catalogs[locale].agents.containerState))assert.ok(html.includes(label));
  for(const health of ['healthy','unhealthy','starting'])assert.ok(html.includes(catalogs[locale].agents.containerHealth[health]));
  assert.doesNotMatch(html,/admin\.agents\.|\?\?\?/);
}
const dialog=readFileSync('frontend/src/admin/agents/AgentDetailDialog.tsx','utf8');
const position=dialog.indexOf('<AgentContainersCard');
assert.ok(position>dialog.indexOf('<AgentHardwareCards'));
assert.ok(position<dialog.indexOf('key={`mounts-${agent.id}`}'));
assert.match(dialog.slice(position,position+130),/key=\{agent.id\}/);
console.log('PASS container UI: sorting, filters, disclosure, metrics, empty payloads and nine locales');
