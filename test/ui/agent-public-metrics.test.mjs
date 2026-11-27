import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('../../frontend/node_modules/esbuild');
const React = require('../../frontend/node_modules/react');
const { renderToStaticMarkup } = require('../../frontend/node_modules/react-dom/server');
const clsx = require('../../frontend/node_modules/clsx');
const publicUrlBundle = esbuild.buildSync({
  entryPoints: ['frontend/src/api/public-url.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm',
});
const { publicApiUrl } = await import(`data:text/javascript;base64,${Buffer.from(publicUrlBundle.outputFiles[0].text).toString('base64')}`);
const compile = (file, name, env = {}) => {
  const source = readFileSync(`frontend/src/components/agent/${file}`, 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replaceAll('export ', '');
  const code = esbuild.transformSync(`${source}\nreturn ${name};`, { loader: 'tsx', jsx: 'transform' }).code;
  return Function('React', ...Object.keys(env), code)(React, ...Object.values(env));
};
const PercentGauge = compile('widgets/PercentGauge.tsx', 'PercentGauge');
const gauge = value => renderToStaticMarkup(React.createElement(PercentGauge, { value, label: 'CPU' }));
for (const missing of [null, NaN, Infinity]) {
  const html = gauge(missing);
  assert.match(html, /aria-label="CPU: —"/);
  assert.match(html, /visibility="hidden"/);
  assert.doesNotMatch(html, /text-success|>0%</);
}
assert.match(gauge(0), /aria-label="CPU: 0%"/);
assert.match(gauge(0), /text-success/);
assert.match(gauge(150), /aria-label="CPU: 100%"/);
assert.match(gauge(-5), /aria-label="CPU: 0%"/);

class ApiError extends Error {
  constructor(status) { super('fixture'); this.status = status; }
}
const data = {
  monitor: { active: 1, name: 'Private fixture name' },
  online: true, staleAfterSec: 180, now: Math.floor(Date.now() / 1000),
  live: { reported_at: Math.floor(Date.now() / 1000), cpu_usage: null }, buckets: [],
};
let state = { data, isLoading: false, isValidating: false };
let pageId = 'default';
let requestKey;
let swrOptions;
let capturedCharts = [];
let searchParams = new URLSearchParams();
const stateSlots = [];
const refSlots = [];
let stateIndex = 0;
let refIndex = 0;
const location = new URL('https://status.example/monitor/1');
const empty = () => null;
const AgentDetailContent = compile('AgentDetailContent.tsx', 'AgentDetailContent', {
  ApiError, PercentGauge, clsx,
  useSWR: (key, _fetcher, opts) => { requestKey = key; swrOptions = opts; return state; },
  usePageConfig: () => ({ pageId }),
  publicApiUrl: (path, pageId) => publicApiUrl(path, pageId, location),
  useTranslations: () => key => key,
  useSearchParams: () => [
    searchParams,
    updater => {
      const next = typeof updater === 'function' ? updater(new URLSearchParams(searchParams)) : new URLSearchParams(updater);
      searchParams = next;
    },
  ],
  useEffect: () => {},
  useMemo: fn => fn(),
  useCallback: fn => fn,
  useRef: init => {
    const idx = refIndex++;
    if (!(idx in refSlots)) refSlots[idx] = { current: init };
    return refSlots[idx];
  },
  useState: init => {
    const idx = stateIndex++;
    if (!(idx in stateSlots)) stateSlots[idx] = typeof init === 'function' ? init() : init;
    return [stateSlots[idx], next => { stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next; }];
  },
  requestJson: empty, isRetryableApiError: empty,
  HistoryNotice: empty,
  TimeSeriesChart: props => { capturedCharts.push(props); return null; },
  AvailabilityRail: empty,
  Card: 'section', CardBody: 'div', CardHeader: 'header',
  Chip: ({ children, className }) => React.createElement('span', { className }, children),
  ...Object.fromEntries(['Activity', 'AlertTriangle', 'Check', 'Clock', 'Cpu', 'HardDrive', 'Layers', 'MemoryStick'].map(key => [key, empty])),
  RefreshCw: ({ className }) => React.createElement('svg', { className }),
});
const render = () => {
  stateIndex = 0;
  refIndex = 0;
  capturedCharts = [];
  return renderToStaticMarkup(React.createElement(AgentDetailContent, { numId: 1 }));
};
render();
const defaultKey = requestKey;
assert.equal(new URL(requestKey, location).searchParams.get('pageId'), 'default');
pageId = 'custom/page & team';
render();
const publicKey = requestKey;
assert.notEqual(publicKey, defaultKey);
assert.equal(new URL(publicKey, location).searchParams.get('pageId'), pageId);
assert.equal(new URL(publicKey, location).searchParams.has('preview'), false);
location.search = '?preview=monitor&unused=1';
render();
const previewUrl = new URL(requestKey, location);
assert.notEqual(requestKey, publicKey);
assert.equal(previewUrl.pathname, '/api/public/agent/detail/1');
assert.deepEqual(Object.fromEntries(previewUrl.searchParams), { minutes: '60', pageId, preview: 'monitor' });
location.search = '';
render();
assert.equal(requestKey, publicKey);
console.log('PASS public Agent detail page context, preview and separate cache keys');
assert.match(render(), />detail.up</);
assert.match(render(), /aria-label="detail.cpuUsage: —"/);
data.online = false;
assert.match(render(), />detail.down</);
assert.doesNotMatch(render(), />detail.up</);
const reportedAt = data.live.reported_at;
data.live.reported_at = null;
assert.match(render(), />detail.down</);
data.live.reported_at = reportedAt;
data.online = null;
assert.match(render(), />detail.unknown</);
data.online = true;
data.live.reported_at -= 200;
assert.match(render(), />detail.down</);
data.monitor.active = 0;
assert.match(render(), />timer.paused</);
assert.doesNotMatch(render(), />detail.down</);
state.error = new ApiError(503);
assert.match(render(), /Private fixture name/);
for (const status of [401, 403, 404]) {
  state.error = new ApiError(status);
  assert.doesNotMatch(render(), /Private fixture name/);
}
console.log('PASS public Agent gauges, disabled/fresh/stale states and revoked visibility');

state = { data, isLoading: false, isValidating: false };
const alignedNow = Math.floor(Date.now() / 60_000) * 60;
data.now = alignedNow;
data.buckets = [
  {
    bucket_ts: alignedNow - 120,
    cpu_avg: 42.5,
    mem_pct_avg: 61,
    load_1_avg: 1.25,
    net_up_bytes: 1200,
    net_down_bytes: 2400,
    network_duration_sec: 60,
    quality: 'aggregate',
  },
  {
    bucket_ts: alignedNow - 60,
    cpu_avg: 88,
    mem_pct_avg: 70,
    load_1_avg: 2.5,
    net_up_bytes: 600,
    net_down_bytes: 600,
    network_duration_sec: 60,
    quality: 'other',
  },
];
const initialHtml = render();
assert.equal(swrOptions.keepPreviousData, true);
assert.match(initialHtml, /role="group" aria-label="detail\.performanceRange"/);
assert.match(initialHtml, /aria-pressed="true"[^>]*>detail\.range1h</);
assert.match(initialHtml, /aria-pressed="false"[^>]*>detail\.range6h</);
assert.match(initialHtml, /aria-pressed="false"[^>]*>detail\.range24h</);
assert.equal(new URL(requestKey, location).searchParams.get('minutes'), '60');
assert.equal(capturedCharts.length, 4);
assert.equal(capturedCharts[0].data.length, 60);
assert.equal(capturedCharts[0].data[57].value, 42.5);
assert.equal(capturedCharts[0].data[58].value, null);
assert.equal(capturedCharts[0].data[59].value, null);

searchParams = new URLSearchParams('range=6h');
const html6h = render();
assert.equal(new URL(requestKey, location).searchParams.get('minutes'), '360');
assert.match(html6h, /aria-pressed="true"[^>]*>detail\.range6h</);
assert.equal(capturedCharts[0].data.length, 360);
assert.equal(capturedCharts[0].data[357].value, 42.5);
assert.equal(capturedCharts[0].data[358].value, null);
assert.equal(capturedCharts[0].data[359].value, null);

searchParams = new URLSearchParams('range=24h');
const html24h = render();
assert.equal(new URL(requestKey, location).searchParams.get('minutes'), '1440');
assert.match(html24h, /aria-pressed="true"[^>]*>detail\.range24h</);
assert.equal(capturedCharts[0].data.length, 1440);
assert.equal(capturedCharts[0].data[1437].value, 42.5);
assert.equal(capturedCharts[0].data[1438].value, null);
assert.equal(capturedCharts[0].data[1439].value, null);
assert.equal(capturedCharts[2].data[1437].value, 60);
assert.equal(capturedCharts[2].data[1438].value, null);
console.log('PASS public Agent detail range switcher (1h / 6h / 24h) and dynamic timeline gaps');

assert.doesNotMatch(initialHtml, /detail\.interfaces/);
assert.doesNotMatch(initialHtml, /detail\.disks/);

data.live = {
  ...data.live,
  interfaces_json: JSON.stringify([
    { name: 'eth0', up_rate: 1024, down_rate: 2048, total_up_bytes: 4096, total_down_bytes: 8192 },
  ]),
  mounts_json: null,
};
const bothFieldsHtml = render();
assert.match(bothFieldsHtml, /lg:grid-cols-2/);
assert.match(bothFieldsHtml, /detail\.interfaces/);
assert.match(bothFieldsHtml, />eth0</);
assert.match(bothFieldsHtml, /detail\.disks/);
assert.match(bothFieldsHtml, /detail\.noMounts/);

data.live = {
  reported_at: data.live.reported_at,
  cpu_usage: null,
  mounts_json: JSON.stringify([
    { name: '/data', total_bytes: 1000, used_bytes: 500, free_bytes: 500, used_percent: 50 },
  ]),
};
const mountsOnlyHtml = render();
assert.doesNotMatch(mountsOnlyHtml, /detail\.interfaces/);
assert.doesNotMatch(mountsOnlyHtml, /lg:grid-cols-2/);
assert.match(mountsOnlyHtml, /detail\.disks/);
assert.match(mountsOnlyHtml, />\/data</);
console.log('PASS public Agent detail hardware card visibility (redacted vs empty vs populated)');

state = { data, isLoading: false, isValidating: true };
const backgroundPollHtml = render();
assert.doesNotMatch(backgroundPollHtml, /animate-spin/);
assert.doesNotMatch(backgroundPollHtml, /opacity-60/);

// Simulate clicking 24h while `data` still holds the previous 60-minute payload:
// the timeline must stay at 60 points until the 1440-minute payload settles.
searchParams = new URLSearchParams('range=6h');
state = { data, isLoading: false, isValidating: false };
render();
assert.equal(capturedCharts[0].data.length, 360);

searchParams = new URLSearchParams('range=24h');
state = { data, isLoading: true, isValidating: true };
const rangeSwitchingHtml = render();
assert.match(rangeSwitchingHtml, /Private fixture name/);
assert.match(rangeSwitchingHtml, /opacity-60/);
assert.match(rangeSwitchingHtml, /animate-spin/);
assert.match(rangeSwitchingHtml, /cursor-pointer/);
assert.match(rangeSwitchingHtml, /focus-visible:ring-2/);
assert.equal(capturedCharts[0].data.length, 360);

const settled24h = { ...data, buckets: [...data.buckets] };
state = { data: settled24h, isLoading: false, isValidating: false };
render();
assert.equal(capturedCharts[0].data.length, 1440);

// Switching back to a previously cached 6h key: SWR yields `isLoading: false`
// and the cached `data` object reference immediately without a loading pass.
searchParams = new URLSearchParams('range=6h');
state = { data, isLoading: false, isValidating: true };
render();
assert.equal(capturedCharts[0].data.length, 360);

state = { data: undefined, isLoading: true, isValidating: true };
const initialLoadingHtml = render();
assert.doesNotMatch(initialLoadingHtml, /Private fixture name/);
assert.match(initialLoadingHtml, /bg-default-100/);
console.log('PASS public Agent detail keeps settled timeline, avoids poll flicker, and stays mounted while switching range');
