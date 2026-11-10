// 验证机器公开数据、过滤、历史缺口和轮询恢复。
// Check public machine data, filters, history gaps, and polling recovery.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('../../frontend/node_modules/esbuild');
const source = path => readFileSync(`frontend/src/components/servers/${path}`, 'utf8');
const compile = (code, result, env = {}) => Function(...Object.keys(env), esbuild.transformSync(`${code.replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '')}\nreturn ${result};`, { loader: 'tsx', jsx: 'transform' }).code)(...Object.values(env));
const numeric = compile(readFileSync('frontend/src/lib/resource-metrics.ts', 'utf8'), '{percentOf, loadTone}');
const modelEnv = { percentOf: numeric.percentOf, numericLoadTone: numeric.loadTone };
const { serverFilters, selectServers, fleetSummary, percentage, accentInk, regionKey } = compile(source('model.ts'), '{serverFilters, selectServers, fleetSummary, percentage, accentInk, regionKey}', { ...modelEnv, countryCode: value => { const last = value?.split(',').pop()?.trim() ?? ''; return /^[A-Za-z]{2}$/.test(last) ? last.toUpperCase() : null; }, regionLabel: value => value });
const server = (id, props = {}) => ({ id, name: `Machine ${id}`, online: true, reportedAt: 10, group: null, tags: [], ...props });
const rows = [server('10', { cpu: null, memoryUsed: null }), server('2', { cpu: 0, memoryUsed: 0, memoryTotal: 100, upload: 0, uptime: 0 }), server('1', { cpu: 85, memoryUsed: 75, memoryTotal: 100, diskUsed: 50, diskTotal: 100, upload: 10, download: 15, uptime: 100, group: { id: 'prod', name: 'Production' }, tags: [{ id: 'edge', name: 'Edge' }] }), server('3', { online: false, cpu: 100, upload: 900 }), server('4', { online: null })];
const defaults = serverFilters(new URLSearchParams());
const select = filters => selectServers(rows, { ...defaults, ...filters }, 'en-US').map(row => row.id);
assert.deepEqual(select({}), ['10', '2', '1', '3', '4']);
assert.deepEqual(select({ sort: 'name' }), ['1', '2', '3', '4', '10']);
assert.deepEqual(select({ sort: 'cpu' }), ['3', '1', '2', '4', '10']);
assert.deepEqual(select({ sort: 'memory' }), ['1', '2', '3', '4', '10']);
assert.deepEqual(select({ sort: 'disk' }), ['1', '2', '3', '4', '10']);
assert.deepEqual(select({ sort: 'network' }), ['1', '2', '3', '4', '10']);
assert.deepEqual(selectServers([
  server('partial-upload', { upload: 999 }), server('partial-download', { download: 999 }),
  server('null-upload', { upload: null, download: 999 }), server('null-download', { upload: 999, download: null }),
  server('hidden'), server('null-both', { upload: null, download: null }),
  server('zero', { upload: 0, download: 0 }), server('complete', { upload: 10, download: 15 }),
], { ...defaults, sort: 'network' }, 'en-US').map(row => row.id), ['complete', 'zero', 'hidden', 'null-both', 'null-download', 'null-upload', 'partial-download', 'partial-upload']);
assert.deepEqual(select({ sort: 'uptime' }).slice(0, 2), ['1', '2']);
assert.deepEqual(select({ query: 'PrODUCTION', tag: 'edge', status: 'online', group: 'prod' }), ['1']);
assert.deepEqual(select({ status: 'offline' }), ['3']);
assert.deepEqual(select({ status: 'unknown' }), ['4']);
assert.deepEqual(select({ query: 'not found' }), []);
assert.equal(regionKey(server('region', { region: 'Frankfurt, de' })), 'DE');
assert.equal(regionKey(server('unknown-region', { region: null })), '-');
assert.deepEqual(serverFilters(new URLSearchParams('status=bad&sort=bad&preview=agent')), defaults);
assert.equal(percentage(0, 100), 0);
assert.equal(percentage(1, 0), null);
assert.equal(percentage(null, 100), null);
const summary = fleetSummary(rows);
assert.equal(summary.total, 5);
assert.deepEqual([summary.online, summary.offline, summary.unknown], [3, 1, 1]);
assert.equal(summary.cpu, 42.5);
assert.equal(summary.cpuSamples, 2);
assert.equal(summary.upload, null, 'an incomplete fleet is not a complete total');
assert.equal(summary.download, null);
for (const field of ['upload', 'download', 'sent', 'received']) {
  assert.equal(fleetSummary([server('zero', { [field]: 0 })])[field], 0);
  assert.equal(fleetSummary([server('a', { [field]: 1 }), server('b', { [field]: 2 })])[field], 3);
  for (const missing of [null, undefined, NaN]) {
    assert.equal(fleetSummary([server('a', { [field]: 1 }), server('b', { [field]: missing })])[field], null);
  }
}
assert.equal(fleetSummary([server('up', { upload: 1 }), server('down', { online: false })]).upload, 1);
assert.equal(fleetSummary([server('up', { sent: 1 }), server('down', { online: false })]).sent, null);
assert.equal(fleetSummary([server('x')]).cpu, null);
assert.equal(fleetSummary([server('x')]).upload, null);
assert.equal(accentInk('#ffffff'), '#18181b');
assert.equal(accentInk('#000000'), '#ffffff');

const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
const format = compile(readFileSync('frontend/src/admin/format.ts', 'utf8'), '{formatBytes, formatRate, formatDuration}');
const readings = compile(source('ServerParts.tsx'), '{ResourceLine, uptimeText, NetRates}', {
  React, ...format,
  ...compile(source('model.ts'), '{known,loadTone,percentText,publishes,resourcePercent,stateOf}', modelEnv),
  useTranslations: () => key => key,
  clsx: (...values) => values.filter(Boolean).join(' '),
  Meter: 'Meter', TONE_TEXT: { up: 'up', warn: 'warn', down: 'down', idle: 'idle' },
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
});
assert.equal(readings.ResourceLine({ kind: 'cpu', server: server('x') }), null);
assert.match(JSON.stringify(readings.ResourceLine({ kind: 'cpu', server: server('x', { cpu: 0 }) })), /0\.0%/);
assert.doesNotMatch(JSON.stringify(readings.ResourceLine({ kind: 'cpu', server: server('x', { cpu: null }) })), /0\.0%/);
assert.ok(readings.uptimeText(server('x')));
assert.match(readings.uptimeText(server('x', { uptime: 0 })), /0m/);
assert.doesNotMatch(JSON.stringify(readings.NetRates({ server: server('x') })), /ArrowUp|ArrowDown/);
const staleNetwork = JSON.stringify(readings.NetRates({ server: server('x', { online: false, upload: 1024, download: 2048 }) }));
assert.match(staleNetwork, /lastNetworkReading/);
assert.match(staleNetwork, /1\.0 KB\/s/);
assert.match(staleNetwork, /2\.0 KB\/s/);
assert.doesNotMatch(JSON.stringify(readings.NetRates({ server: server('x', { online: false }) })), /lastNetworkReading/);
console.log('public servers: filters, real sorting, summary samples, zero/unknown and hidden readings passed');

{
  const chartSource = source('HistoryChart.tsx');
  const chartModel = chartSource.slice(chartSource.indexOf('export function withGaps'), chartSource.indexOf('export const HistoryChart'));
  const { withGaps } = compile(chartModel, '{withGaps}');
  const rows = [{ t: 40, cpu: 0 }, { t: 100, cpu: 1 }, { t: 160, cpu: null }, { t: 400, cpu: 4 }];
  const filled = withGaps(rows, ['cpu']);
  assert.equal(filled.length, 5);
  assert.equal(filled[3].t, 220);
  assert.equal(filled[3].cpu, null);
  assert.equal(filled[4].t, 400);
}
console.log('public servers: history gap insertion and redaction model passed');

class ApiError extends Error { constructor(status) { super(String(status)); this.status = status; } }
function fixture() {
  const values = [], dependencies = [], cleanups = [], callbacks = [], requests = [], timers = new Set(), listeners = new Set();
  let cursor = 0, pending = [], path = '/servers', interval = 30_000;
  const equal = (a, b) => a && b.length === a.length && b.every((v, i) => Object.is(v, a[i]));
  const useState = initial => { const index = cursor++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }]; };
  const useRef = initial => { const index = cursor++; return values[index] ??= { current: initial }; };
  const useCallback = (fn, deps) => { const index = cursor++; if (!equal(dependencies[index], deps)) { callbacks[index] = fn; dependencies[index] = deps; } return callbacks[index]; };
  const useEffect = (fn, deps) => { const index = cursor++; if (!equal(dependencies[index], deps)) { dependencies[index] = deps; pending.push(() => { cleanups[index]?.(); cleanups[index] = fn(); }); } };
  const document = { hidden: false, addEventListener: (_event, fn) => listeners.add(fn), removeEventListener: (_event, fn) => listeners.delete(fn) };
  const window = { setInterval: (fn, ms) => { assert.equal(ms, 30_000); timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn) };
  const requestJson = (url, options) => new Promise((resolve, reject) => requests.push({ url, signal: options.signal, resolve, reject }));
  const hook = compile(source('useServerData.ts'), 'useServerData', { useState, useRef, useCallback, useEffect, requestJson, ApiError, window, document, AbortController });
  return { requests, document, timers, listeners,
    render(nextPath = path, nextInterval = interval) { path = nextPath; interval = nextInterval; cursor = 0; pending = []; const out = hook(path, interval); pending.forEach(fn => fn()); return out; },
    tick() { timers.forEach(fn => fn()); },
    visibility(hidden) { document.hidden = hidden; listeners.forEach(fn => fn()); },
    unmount() { cleanups.forEach(fn => fn?.()); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const f = fixture();
let api = f.render();
assert.equal(api.data, null);
f.requests[0].resolve({ name: 'Before' }); await flush();
assert.equal(f.render().data.name, 'Before');
f.tick(); f.requests[1].reject(new ApiError(503)); await flush();
api = f.render(); assert.equal(api.data.name, 'Before'); assert.equal(api.error.status, 503);
f.tick(); f.requests[2].resolve({ name: 'After' }); await flush();
api = f.render(); assert.equal(api.data.name, 'After'); assert.equal(api.error, null);
const old = api.refresh(); const fresh = api.refresh();
assert.equal(f.requests[3].signal.aborted, true);
f.requests[4].resolve({ name: 'Newest' }); await fresh;
f.requests[3].resolve({ name: 'Old' }); await old;
assert.equal(f.render().data.name, 'Newest');
f.tick(); f.tick(); assert.equal(f.requests.length, 6, 'polling cannot overlap pending requests');
api = f.render('/servers/other');
assert.equal(api.data, null, 'path changes mask old data before effects run');
assert.equal(f.requests[5].signal.aborted, true);
f.requests[5].resolve({ name: 'Wrong machine' });
f.requests[6].resolve({ name: 'Other' }); await flush();
assert.equal(f.render().data.name, 'Other');
for (const status of [401, 403, 404]) {
  const refreshing = f.render().refresh(); f.requests.at(-1).reject(new ApiError(status)); await refreshing;
  api = f.render(); assert.equal(api.data, null); assert.equal(api.error.status, status);
  const recovery = api.refresh(); f.requests.at(-1).resolve({ name: 'Restored' }); await recovery;
}
const count = f.requests.length;
f.visibility(true); f.tick(); assert.equal(f.requests.length, count);
f.visibility(false); assert.equal(f.requests.length, count + 1);
f.requests.at(-1).resolve({ name: 'Visible again' }); await flush();
f.render('/servers/other', 0); assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
const manual = f.render().refresh(); assert.equal(f.requests.length, count + 2);
f.unmount(); assert.equal(f.requests.at(-1).signal.aborted, true); f.requests.at(-1).resolve({ name: 'Unmounted' }); await manual;
const empty = fixture(); empty.render(null); assert.equal(empty.requests.length, 0); empty.unmount();
console.log('public servers: polling 200→503→200, ordering, cancellation, path changes, revoked visibility and paused refresh passed');

{
  const { historyWindow, publishesSeries } = compile(source('history-model.ts'), '{historyWindow, publishesSeries}');
  const { historyCsv } = compile(source('model.ts'), '{historyCsv}', { ...modelEnv, publishesSeries });
  const points = [6399, 6400, 10000, 10001, NaN, Infinity].map(ts => ({ ts, cpu: 0, memory: 99, upload: 1024 }));
  const window = historyWindow(points, 10000, 1);
  assert.deepEqual(window.map(point => point.ts), [6400, 10000]);
  assert.equal(publishesSeries(server('hidden'), 'cpu'), false);
  assert.equal(publishesSeries(server('unknown', { cpu: null }), 'cpu'), true);
  const csv = historyCsv(server('public', { cpu: null, upload: 0 }), window);
  assert.equal(csv.split('\n')[0], 'time,cpu_percent,upload_bytes_per_second');
  assert.equal(csv.split('\n').length, 3);
  assert.match(csv, /,0,1024/);
  assert.doesNotMatch(csv, /memory|99/);
  const { peakResourcePercent } = compile(readFileSync('frontend/src/admin/agents/resource-model.ts', 'utf8'), '{peakResourcePercent}', numeric);
  assert.equal(peakResourcePercent({ cpu_usage: null, mem_used: null, mem_total: null, disk_used: null, disk_total: null }), null);
  assert.equal(peakResourcePercent({ cpu_usage: 0 }), 0);
  assert.equal(peakResourcePercent({ cpu_usage: NaN, mem_used: 75, mem_total: 100 }), 75);
  assert.deepEqual([null, 0, 74.9, 75, 90, NaN].map(numeric.loadTone), ['idle', 'up', 'up', 'warn', 'down', 'idle']);
}
console.log('shared models: complete totals, zero/unknown, history windows, CSV visibility and admin peaks passed');
