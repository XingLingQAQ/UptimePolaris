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
const { formatBytes, formatPercent } = await import(`data:text/javascript;base64,${Buffer.from(formats.outputFiles[0].text).toString('base64')}`);
const catalogs = Object.fromEntries(['en-US','zh-CN','zh-HK','zh-TW','ja-JP','ko-KR','fr-FR','pt-BR','ru-RU'].map(locale =>
  [locale, JSON.parse(readFileSync(`frontend/src/locales/admin/${locale}.json`, 'utf8'))]));
let locale = 'en-US';
const icon = () => null;
const bindings = { React, useMemo: fn => fn(), useTranslations: () => createTranslator({ locale, messages: { admin: catalogs[locale] }, namespace: 'admin.agents' }),
  Cpu: icon, Thermometer: icon, AlertTriangle: icon, IconTile: icon, asGpuStats, asSensorStats, formatBytes, formatPercent,
  Meter: ({ value, label }) => React.createElement('meter', { value, min: 0, max: 100, 'aria-label': label }),
};
const module = { exports: {} };
Function('module', 'exports', ...Object.keys(bindings), compiled.outputFiles[0].text)(module, module.exports, ...Object.values(bindings));
const render = props => renderToStaticMarkup(React.createElement(module.exports.AgentHardwareCards, props));
for (const props of [{}, { gpusJson: null, sensorsJson: null }, { gpusJson: '[]', sensorsJson: '[]' }, { gpusJson: '{bad', sensorsJson: 'null' }]) assert.equal(render(props), '');
const gpus = [{ index: 0, name: '<GPU>', util_pct: 0, mem_used_bytes: 0, mem_total_bytes: 1024, temp_c: 85, power_w: 0 }, { index: 1, name: 'Missing readings' }];
const props = { gpusJson: JSON.stringify(gpus), sensorsJson: JSON.stringify([{ name: 'CPU', temp_c: 85 }, { name: 'Disk', temp_c: 84 }]) };
const html = render(props);
assert.match(html, /&lt;GPU&gt;/);
assert.match(html, /0\.0%/);
assert.match(html, /0 B \/ 1.0 KB/);
assert.match(html, /0 W/);
assert.match(html, /High temperature/);
assert.equal((html.match(/<meter/g) ?? []).length, 1);
assert.match(html, /—/);
assert.doesNotMatch(render({ gpusJson: props.gpusJson }), /Hardware temperatures/);
assert.doesNotMatch(render({ sensorsJson: props.sensorsJson }), /aria-label="GPUs"/);
for (locale of Object.keys(catalogs)) {
  const localized = render(props);
  assert.ok(localized.includes(catalogs[locale].agents.sectionSensors));
  assert.doesNotMatch(localized, /admin\.agents\.|\?\?\?/);
}
console.log('PASS hardware cards: conditional rendering, zero/missing readings, warning, escaping and nine locales');
