// 验证公开配置和预览导航的纯函数约束。
// Check pure public-configuration and preview-navigation contracts.

import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({
  stdin: {
    contents: `export { publicApiUrl } from './frontend/src/api/public-url.ts';
      export { toPageConfig } from './frontend/src/config/api.ts';
      export { readLocalPreference, writeLocalPreference, applyDefaultTheme, selectTheme } from './frontend/src/lib/browser-preferences.ts';
      export { getPreview, statusPagePath } from './frontend/src/lib/public-navigation.ts';
      export { getMonitorDetailPath } from './frontend/src/components/monitor/card-presentation.ts';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', tsconfig: 'frontend/tsconfig.json',
});
const { publicApiUrl, toPageConfig, getPreview, statusPagePath, getMonitorDetailPath, readLocalPreference, writeLocalPreference, applyDefaultTheme, selectTheme } =
  await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

const context = { origin: 'https://status.example', search: '?preview=agent' };
assert.equal(publicApiUrl('/api/public/config', undefined, context), 'https://status.example/api/public/config?preview=agent');
assert.notEqual(publicApiUrl('/api/public/config', undefined, context), publicApiUrl('/api/public/config', 'default', context));
assert.notEqual(publicApiUrl('/api/public/config', 'default', context), publicApiUrl('/api/public/config', 'default', { ...context, search: '?preview=monitor' }));
assert.notEqual(publicApiUrl('/api/public/config', 'default', context), publicApiUrl('/api/public/config', 'default', { ...context, origin: 'https://machines.example' }));
assert.equal(new URL(publicApiUrl('/api/public/config', 'a/b', context)).searchParams.get('pageId'), 'a/b');
const raw = { pageId: 'a', siteMeta: { title: 'one' }, config: { title: 'one' } };
assert.equal(toPageConfig(raw).siteMeta.title, 'one');
assert.equal(toPageConfig({ ...raw, siteMeta: { title: 'two' } }).siteMeta.title, 'two');
globalThis.window = {};
Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
assert.equal(readLocalPreference('locale'), null);
assert.doesNotThrow(() => writeLocalPreference('locale', 'en-US'));
const themes = [];
applyDefaultTheme('dark', value => themes.push(value));
selectTheme('light', value => themes.push(value));
applyDefaultTheme('dark', value => themes.push(value));
assert.deepEqual(themes, ['dark', 'light']);
delete globalThis.window;
for (const preview of ['monitor', 'agent']) {
  const search = `?preview=${preview}&unused=1`;
  assert.equal(getPreview(search), preview);
  assert.equal(statusPagePath('a/b', 'default', search), `/status/a%2Fb?preview=${preview}`);
  assert.equal(statusPagePath('default', 'default', search), `/?preview=${preview}`);
  const detail = new URL(getMonitorDetailPath(17, 'a/b', search), context.origin);
  assert.equal(detail.pathname, '/monitor/17');
  assert.equal(detail.searchParams.get('pageId'), 'a/b');
  assert.equal(detail.searchParams.get('preview'), preview);
}
assert.equal(getPreview('?preview=invalid'), null);
assert.equal(statusPagePath('default', 'default', '?preview=invalid'), '/');
assert.equal(new URL(getMonitorDetailPath(1, 'default', '?preview=invalid'), context.origin).searchParams.has('preview'), false);
console.log('frontend reuse: pure public configuration and navigation contracts');
