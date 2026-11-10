// 验证迁移表单预览、确认、目标变更与中断恢复。
// Check migration-form preview, confirmation, target changes, and interrupted-result handling.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const mocks = {
  '@/api/backend': `export const useBackendCapabilities = () => ({ data: { runtime: 'worker' } });`,
  react: `export function useState(initial) {
    const index = globalThis.fixture.index++;
    if (!(index in globalThis.fixture.state)) globalThis.fixture.state[index] = initial;
    return [globalThis.fixture.state[index], value => { globalThis.fixture.state[index] = value; }];
  }`,
  'react/jsx-runtime': `export const Fragment = 'fragment'; export function jsx(type, props) { return {type, props}; } export const jsxs = jsx;`,
  'use-intl': `export function useTranslations() { return key => key; }`,
  '@heroui/react': `export const Button = 'button', Input = 'input', Checkbox = 'checkbox';`,
  'lucide-react': `export const AlertTriangle = 'icon', ArrowRight = 'icon', CheckCircle2 = 'icon', Database = 'icon';`,
  '@/api/client': `export const requestJson = (...args) => globalThis.fixture.request(...args);`,
  '@/api/errors': `export class ApiError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } } globalThis.fixture.ApiError = ApiError;`,
};

globalThis.fixture = { state: [], index: 0, calls: [], request: null };
const result = await build({
  entryPoints: ['frontend/src/admin/settings/DatabaseMigration.tsx'],
  bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic',
  plugins: [{ name: 'fixtures', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'fixture' } : null);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
  } }],
});
const { DatabaseMigration } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
function children(node) {
  if (Array.isArray(node)) return node.flatMap(children);
  if (!node || typeof node !== 'object') return [];
  return [node, ...children(node.props?.children)];
}
function render() {
  fixture.index = 0;
  return children(DatabaseMigration());
}
const button = (tree, label) => tree.find(node => node.type === 'button' && node.props.children === label);
const settle = () => new Promise(resolve => setImmediate(resolve));
const preview = { ok: true, tables: [{ name: 'monitors', rows: 3 }], totalRows: 3, targetNeedsInitialization: true };
fixture.request = async (url, options) => {
  fixture.calls.push({ url, body: JSON.parse(options.body) });
  return preview;
};

let tree = render();
assert.equal(button(tree, 'preview').props.isDisabled, true);
tree.find(node => node.type === 'input').props.onValueChange('not-a-database-url');
tree = render();
button(tree, 'preview').props.onPress();
tree = render();
assert.ok(tree.some(node => node.props?.role === 'alert' && node.props.children === 'invalidUrl'));
assert.equal(fixture.calls.length, 0);

tree.find(node => node.type === 'input').props.onValueChange('postgresql://user:pass@db.example/test');
tree = render();
button(tree, 'preview').props.onPress();
await settle();
tree = render();
assert.equal(fixture.calls[0].url, '/api/admin/database-migration/preview');
assert.ok(tree.some(node => node.props?.children === 'targetWillInitialize'));
assert.equal(button(tree, 'execute').props.isDisabled, true);
tree.find(node => node.type === 'checkbox').props.onValueChange(true);
tree = render();
assert.equal(button(tree, 'execute').props.isDisabled, false);
button(tree, 'execute').props.onPress();
await settle();
tree = render();
assert.deepEqual(fixture.calls[1].body, { url: 'postgresql://user:pass@db.example/test', confirmed: true });
assert.ok(tree.some(node => Array.isArray(node.props?.children) && node.props.children.includes('complete')));
assert.equal(tree.find(node => node.type === 'input').props.value, '');
assert.equal(button(tree, 'execute'), undefined);

tree.find(node => node.type === 'input').props.onValueChange('postgresql://user:pass@db.example/test');
tree = render();
fixture.request = async () => { throw new fixture.ApiError('target_not_empty', 409); };
button(tree, 'preview').props.onPress();
await settle();
tree = render();
assert.ok(tree.some(node => node.props?.role === 'alert' && node.props.children === 'targetNotEmpty'));
assert.equal(button(tree, 'execute'), undefined);

fixture.request = async () => { throw new fixture.ApiError('source_changed', 409); };
button(tree, 'preview').props.onPress();
await settle();
tree = render();
assert.ok(tree.some(node => node.props?.role === 'alert' && node.props.children === 'sourceChanged'));

fixture.request = async () => ({ ...preview, targetNeedsInitialization: false });
button(tree, 'preview').props.onPress();
await settle();
tree = render();
assert.ok(tree.some(node => node.props?.children === 'targetAlreadyInitialized'));
tree.find(node => node.type === 'checkbox').props.onValueChange(true);
tree = render();
tree.find(node => node.type === 'input').props.onValueChange('postgresql://user:pass@other.example/test');
tree = render();
assert.equal(button(tree, 'execute'), undefined, 'changing the target requires a new preview');

button(tree, 'preview').props.onPress();
await settle();
tree = render();
tree.find(node => node.type === 'checkbox').props.onValueChange(true);
tree = render();
fixture.request = async () => { throw new fixture.ApiError('network_error', 0); };
button(tree, 'execute').props.onPress();
await settle();
tree = render();
assert.ok(tree.some(node => node.props?.role === 'alert' && node.props.children === 'resultUnknown'));
assert.equal(button(tree, 'execute'), undefined, 'an interrupted migration must be rechecked');

const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const IntlMessageFormat = require('intl-messageformat').default;
const locales = ['en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'pt-BR', 'ru-RU', 'zh-CN', 'zh-HK', 'zh-TW'];
const catalog = locale => JSON.parse(readFileSync(`frontend/src/locales/admin/${locale}.json`, 'utf8')).databaseMigration;
const expectedKeys = Object.keys(catalog('en-US')).sort();
for (const locale of locales) {
  const messages = catalog(locale);
  assert.deepEqual(Object.keys(messages).sort(), expectedKeys, `${locale} has all migration messages`);
  const summary = new IntlMessageFormat(messages.summary, locale).format({ tables: 7, rows: 30 });
  assert.ok(String(summary).includes('7') && String(summary).includes('30'), `${locale} displays both counts`);
}
console.log('database migration UI state tests passed');
