import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createTranslator } = require('use-intl');
const source = readFileSync('frontend/src/admin/agents/AgentHardwareCards.tsx', 'utf8');
const compiled = await build({
  stdin: { contents: source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export function', 'function') + '\nexport { AgentHardwareCards };',
    resolveDir: process.cwd(), loader: 'tsx' },
  write: false, format: 'cjs', jsx: 'transform',
});
const hardware = await build({ entryPoints: ['shared/agent-hardware.ts'], bundle: true, write: false, format: 'esm' });
const { asGpuStats, asSensorStats } = await import(`data:text/javascript;base64,${Buffer.from(hardware.outputFiles[0].text).toString('base64')}`);
const formats = await build({ entryPoints: ['frontend/src/admin/format.ts'], bundle: true, write: false, format: 'esm' });
const { formatBytes, formatPercent, formatOneDecimal } = await import(`data:text/javascript;base64,${Buffer.from(formats.outputFiles[0].text).toString('base64')}`);
const catalogs = Object.fromEntries(['en-US','zh-CN','zh-HK','zh-TW','ja-JP','ko-KR','fr-FR','pt-BR','ru-RU'].map(locale =>
  [locale, JSON.parse(readFileSync(`frontend/src/locales/admin/${locale}.json`, 'utf8'))]));
let locale = 'en-US';
let expandedSensors = false;
const icon = () => null;
const bindings = { React, useMemo: fn => fn(), useTranslations: () => createTranslator({ locale, messages: { admin: catalogs[locale] }, namespace: 'admin.agents' }),
  useState: initial => [expandedSensors ?? initial, update => { expandedSensors = typeof update === 'function' ? update(expandedSensors) : update; }],
  Monitor: icon, Zap: icon, ChevronDown: icon, Thermometer: icon, AlertTriangle: icon, IconTile: icon, asGpuStats, asSensorStats, formatBytes, formatPercent, formatOneDecimal,
  Meter: ({ value, label, tone }) => React.createElement('meter', { value, min: 0, max: 100, 'aria-label': label, 'data-tone': tone }),
};
const module = { exports: {} };
Function('module', 'exports', ...Object.keys(bindings), compiled.outputFiles[0].text)(module, module.exports, ...Object.values(bindings));
const tree = props => module.exports.AgentHardwareCards(props);
const render = props => renderToStaticMarkup(tree(props));
function findButton(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'button') return node;
  for (const child of React.Children.toArray(node.props?.children)) {
    const found = findButton(child);
    if (found) return found;
  }
  return null;
}
for (const props of [{}, { gpusJson: null, sensorsJson: null }, { gpusJson: '[]', sensorsJson: '[]' }, { gpusJson: '{bad', sensorsJson: 'null' }]) assert.equal(render(props), '');
const gpus = [{ index: 0, name: '<GPU>', util_pct: 0, mem_used_bytes: 0, mem_total_bytes: 1024, temp_c: 85, power_w: 0 }, { index: 1, name: 'Missing readings' }];
const props = { gpusJson: JSON.stringify(gpus), sensorsJson: JSON.stringify([{ name: 'CPU', temp_c: 85 }, { name: 'Disk', temp_c: 84 }]) };
const html = render(props);
assert.match(html, /&lt;GPU&gt;/);
assert.match(html, /0\.0%/);
assert.match(html, /0 B \/ 1.0 KB/);
assert.match(html, /0 W/);
assert.match(html, /High temperature/);
assert.equal((html.match(/<meter/g) ?? []).length, 2);
assert.match(html, /aria-label="GPU memory: &lt;GPU&gt;"/);
assert.doesNotMatch(html, /— \/ —/);
assert.match(html, /—/);
assert.doesNotMatch(render({ gpusJson: props.gpusJson }), /Hardware temperatures/);
assert.doesNotMatch(render({ sensorsJson: props.sensorsJson }), /aria-label="GPUs"/);

const gpuOnly = gpu => render({ gpusJson: JSON.stringify([{ index: 0, name: 'Fixture GPU', ...gpu }]) });
const sensorOnly = sensor => render({ sensorsJson: JSON.stringify([{ name: 'Fixture sensor', ...sensor }]) });
const decimal = gpuOnly({ temp_c: 64.375, power_w: 125.44 });
assert.match(decimal, /64\.4 °C/);
assert.match(decimal, /125\.4 W/);
assert.doesNotMatch(decimal, /64\.375|125\.44/);
assert.match(gpuOnly({ temp_c: 64, power_w: 125 }), /64 °C/);
assert.match(gpuOnly({ temp_c: 64, power_w: 125 }), /125 W/);
assert.doesNotMatch(gpuOnly({ temp_c: 64, power_w: 125 }), /64\.0|125\.0|High temperature/);
assert.match(sensorOnly({ temp_c: -12.375 }), /-12\.4 °C/);
for (const renderReading of [temp_c => gpuOnly({ temp_c }), temp_c => sensorOnly({ temp_c })]) {
  assert.doesNotMatch(renderReading(84.9), /High temperature|text-warning-700|text-danger-600/);
  assert.match(renderReading(85), /text-warning-700 dark:text-warning-400/);
  assert.match(renderReading(85), /class="sr-only">High temperature/);
  assert.match(renderReading(95), /text-danger-600 dark:text-danger-400/);
  assert.match(renderReading(95), /class="sr-only">High temperature/);
}
for (const gpu of [{}, { mem_used_bytes: null, mem_total_bytes: null }]) {
  const missing = gpuOnly(gpu);
  assert.match(missing, /Video memory used \/ total<\/span><span[^>]*>—<\/span>/);
  assert.doesNotMatch(missing, /— \/ —|<meter/);
}
assert.match(gpuOnly({ mem_total_bytes: 1024 }), /— \/ 1\.0 KB/);
assert.doesNotMatch(gpuOnly({ mem_total_bytes: 1024 }), /<meter/);
assert.doesNotMatch(gpuOnly({ mem_used_bytes: 0, mem_total_bytes: 0 }), /<meter/);
for (const [used, tone] of [[0, 'primary'], [75, 'warn'], [90, 'down']]) {
  assert.match(gpuOnly({ mem_used_bytes: used, mem_total_bytes: 100 }), new RegExp(`aria-label="GPU memory: Fixture GPU" data-tone="${tone}"`));
}
assert.match(gpuOnly({ util_pct: 90 }), /data-tone="warn"/);
assert.match(gpuOnly({ util_pct: 89.9 }), /data-tone="primary"/);

const sensorRows = Array.from({ length: 8 }, (_, i) => ({ name: `Sensor ${i}`, kind: ['cpu', 'disk', 'gpu', 'other'][i % 4], temp_c: i === 7 ? 96.25 : 30 + i }));
const many = { sensorsJson: JSON.stringify(sensorRows) };
const collapsed = render(many);
assert.equal((collapsed.match(/title="Sensor /g) ?? []).length, 6);
assert.match(collapsed, /title="Sensor 7"/);
assert.ok(collapsed.indexOf('title="Sensor 7"') < collapsed.indexOf('title="Sensor 0"'));
assert.match(collapsed, /Peak/);
assert.match(collapsed, /96\.3 °C/);
assert.match(collapsed, /aria-expanded="false"/);
assert.match(collapsed, /Show all 8/);
for (const kind of ['CPU', 'Disk', 'GPU', 'Other']) assert.match(collapsed, new RegExp(`>${kind}</span>`));
findButton(tree(many)).props.onClick();
const expanded = render(many);
assert.equal((expanded.match(/title="Sensor /g) ?? []).length, 8);
assert.match(expanded, /aria-expanded="true"/);
assert.match(expanded, /Show less/);
findButton(tree(many)).props.onClick();
assert.equal((render(many).match(/title="Sensor /g) ?? []).length, 6);
assert.doesNotMatch(render({ sensorsJson: JSON.stringify(sensorRows.slice(0, 6)) }), /<button/);

for (locale of Object.keys(catalogs)) {
  const localized = render(props);
  assert.ok(localized.includes(catalogs[locale].agents.sectionSensors));
  assert.doesNotMatch(localized, /admin\.agents\.|\?\?\?/);
  const sensorHtml = render(many);
  assert.ok(sensorHtml.includes(catalogs[locale].agents.hardwarePeakTemperature));
  for (const kind of Object.values(catalogs[locale].agents.sensorKind)) assert.ok(sensorHtml.includes(`>${kind}</span>`));
  assert.doesNotMatch(sensorHtml, /admin\.agents\.|\?\?\?/);
}
const dialog = readFileSync('frontend/src/admin/agents/AgentDetailDialog.tsx', 'utf8');
const hardwarePosition = dialog.indexOf('<AgentHardwareCards');
assert.ok(dialog.indexOf('<TrendCard') < dialog.indexOf("title={t('sectionRuntime')}"));
assert.ok(dialog.indexOf("title={t('sectionRuntime')}") < hardwarePosition);
assert.ok(hardwarePosition < dialog.indexOf('key={`mounts-${agent.id}`}'));
assert.match(dialog.slice(hardwarePosition, hardwarePosition + 180), /key=\{agent.id\}/);
console.log('PASS hardware cards: placement, dual meters, decimal formatting, temperature levels, sensor kinds, disclosure and nine locales');
