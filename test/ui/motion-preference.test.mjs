// 验证动效偏好、存储失败与跨标签页更新。
// Check motion preferences, storage failures, and cross-tab updates.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const key = 'uptime-polaris.motion';
let sequence = 0;
const built = await build({
  entryPoints: ['frontend/src/lib/motion-preference.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'motion-runtime', setup(builder) {
    builder.onResolve({ filter: /^framer-motion$/ }, () => ({ path: 'motion-runtime', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const MotionGlobalConfig = globalThis.motionFixture.config;' }));
  } }],
});

async function fixture({ system = false, stored, blocked = false } = {}) {
  const storage = new Map(stored === undefined ? [] : [[key, stored]]);
  const listeners = new Map(), mediaListeners = new Set();
  const media = { matches: system, addEventListener: (_event, fn) => mediaListeners.add(fn), removeEventListener: (_event, fn) => mediaListeners.delete(fn) };
  const config = {};
  globalThis.motionFixture = { config };
  globalThis.document = { documentElement: { dataset: {} } };
  globalThis.window = {
    localStorage: { getItem: item => { if (blocked) throw Error('blocked'); return storage.get(item) ?? null; }, setItem: (item, value) => { if (blocked) throw Error('blocked'); storage.set(item, value); } },
    matchMedia: () => media,
    addEventListener: (event, fn) => listeners.set(event, fn), removeEventListener: event => listeners.delete(event),
  };
  const api = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}#${sequence++}`);
  api.initializeMotionPreference();
  return { api, storage, config, listeners, mediaListeners, setSystem(value) { media.matches = value; for (const listener of mediaListeners) listener(); } };
}

test('full motion is the default even when the system reduces motion', async () => {
  const { api, config } = await fixture({ system: true });
  assert.equal(api.getMotionPreference(), 'full');
  assert.equal(api.getReducedMotion(), false);
  assert.equal(config.skipAnimations, false);
  assert.equal(document.documentElement.dataset.motion, 'full');
});

test('all modes update immediately and only system mode follows OS changes', async () => {
  const f = await fixture({ system: true });
  let notifications = 0;
  const unsubscribe = f.api.subscribeMotionPreference(() => notifications++);
  assert.equal(f.api.setMotionPreference('system'), true);
  assert.equal(f.api.getReducedMotion(), true);
  assert.equal(f.config.skipAnimations, true);
  f.setSystem(false);
  assert.equal(f.api.getReducedMotion(), false);
  f.api.setMotionPreference('reduced');
  assert.equal(f.api.getReducedMotion(), true);
  f.setSystem(false);
  assert.equal(f.api.getReducedMotion(), true);
  f.api.setMotionPreference('full');
  f.setSystem(true);
  assert.equal(f.api.getReducedMotion(), false);
  assert.equal(f.storage.get(key), 'full');
  assert.equal(notifications, 4);
  unsubscribe();
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.listeners.size, 0);
});

test('saved preference survives reload, invalid values use the full-motion default', async () => {
  let f = await fixture();
  f.api.setMotionPreference('reduced');
  f = await fixture({ stored: f.storage.get(key) });
  assert.equal(f.api.getReducedMotion(), true);
  assert.equal((await fixture({ stored: 'invalid', system: true })).api.getMotionPreference(), 'full');
});

test('storage changes sync tabs and blocked storage retains the current choice', async () => {
  let f = await fixture();
  const unsubscribe = f.api.subscribeMotionPreference(() => {});
  f.storage.set(key, 'reduced'); f.listeners.get('storage')({ key });
  assert.equal(f.api.getReducedMotion(), true);
  f.storage.clear(); f.listeners.get('storage')({ key: null });
  assert.equal(f.api.getMotionPreference(), 'full');
  unsubscribe();
  f = await fixture({ blocked: true, system: true });
  assert.equal(f.api.setMotionPreference('reduced'), false);
  assert.equal(f.api.getReducedMotion(), true);
  assert.equal(document.documentElement.dataset.motion, 'reduced');
});
