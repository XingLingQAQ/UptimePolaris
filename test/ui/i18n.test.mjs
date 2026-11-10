// 验证语言包消息、复数与参数格式。
// Check locale messages, plural forms, and parameter formatting.

﻿import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const uiRequire = createRequire(new URL('../../frontend/package.json', import.meta.url));
const messages = JSON.parse(readFileSync('frontend/src/locales/en-US.json', 'utf8'));
messages.admin = JSON.parse(readFileSync('frontend/src/locales/admin/en-US.json', 'utf8'));
globalThis.__messages = messages;
globalThis.window = { location: { origin: 'https://example.test' } };
const mock = {
  '@/components/ui/MotionOverlays': `export const Modal = 'modal'; export const Drawer = 'drawer'; export const Popover = 'popover'; export const Select = 'select'; export const Dropdown = 'dropdown'; export const Autocomplete = 'autocomplete';`,
  react: `let index = 0; export function useState(value) { return [index++ === 0 ? [{ key: 'linux-amd64', version: '1' }] : value, () => {}]; } export function useEffect() {}`,
  'react/jsx-runtime': `export const Fragment = 'fragment'; export function jsx(type, props) { return {type, props}; } export const jsxs = jsx;`,
  'use-intl': `export function useTranslations(namespace = '') { return key => { const path = [namespace, key].filter(Boolean).join('.'); const value = path.split('.').reduce((v, part) => v?.[part], globalThis.__messages); if (typeof value !== 'string') throw new Error('Missing message: ' + path); return value; }; }`,
  '@heroui/react': `export const Button = 'button', Modal = 'modal', ModalBody = 'body', ModalContent = 'content', ModalFooter = 'footer', ModalHeader = 'header', Switch = 'switch';`,
  'lucide-react': `export const Check = 'check', Copy = 'copy';`,
  '@/api/client': `export const requestJson = () => {};`,
  '@/api/useApiErrorMessage': `export const useApiErrorMessage = () => () => '';`,
  './AgentCommandHelp': `export const AgentCommandHelp = 'help';`,
};
const result = await build({
  entryPoints: ['frontend/src/admin/agents/AgentReinstallDialog.tsx'], bundle: true, write: false,
  platform: 'node', format: 'esm', jsx: 'automatic',
  plugins: [{ name: 'dialog-fixtures', setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mock, args.path) ? { path: args.path, namespace: 'fixture' } : null);
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: mock[args.path], loader: 'js' }));
  } }],
});
const { AgentReinstallDialog } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const tree = AgentReinstallDialog({ token: '', config: null, onClose() {} });
function children(node) {
  if (Array.isArray(node)) return node.flatMap(children);
  if (!node || typeof node !== 'object') return [node];
  return [node, ...children(node.props?.children)];
}
const rendered = children(tree);
assert.ok(rendered.some((node) => node === messages.error.invalidRequest), 'failed command renders the root error translation');
assert.ok(rendered.some((node) => node?.type === 'button' && node.props.isDisabled), 'failed command disables copying');

const localeBundle = await build({ entryPoints: ['frontend/src/i18n/resolve-locale.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { resolveLocaleFromCandidates: resolve } = await import(`data:text/javascript;base64,${Buffer.from(localeBundle.outputFiles[0].text).toString('base64')}`);
for (const [input, expected] of [['zh-hk', 'zh-HK'], ['zh-Hant-TW', 'zh-TW'], ['zh-Hant', 'zh-TW'], ['zh-MO', 'zh-HK'], ['zh-Hans-HK', 'zh-CN'], ['FR-fr', 'fr-FR']]) {
  assert.equal(resolve([input]), expected, input);
}
assert.equal(resolve(['not_a_locale', 'zh-hk']), 'zh-HK');
assert.equal(resolve(['zz-ZZ']), 'en-US');
const IntlMessageFormat = uiRequire('intl-messageformat').default;
for (const [key, args, expected] of [
  ['groups.summary', { groups: 1, monitors: 2 }, '1 group · 2 monitors filed'],
  ['settings.eventsLoaded', { n: 1 }, 'Loaded 1 event'],
  ['console.statusIssues', { n: 2 }, '2 monitors need attention'],
]) {
  const message = key.split('.').reduce((value, part) => value[part], messages.admin);
  assert.equal(new IntlMessageFormat(message, 'en-US').format(args), expected);
}
for (const [locale, eventResults, groupResults] of [
  ['fr-FR', ['0 événements chargés', '1 événement chargé', '2 événements chargés'], [
    '1 groupe · 2 moniteurs classés', '2 groupes · 1 moniteur classé', '0 groupes · 0 moniteurs classés',
  ]],
  ['pt-BR', ['0 eventos carregados', '1 evento carregado', '2 eventos carregados'], [
    '1 grupo · 2 monitores organizados', '2 grupos · 1 monitor organizado', '0 grupos · 0 monitores organizados',
  ]],
]) {
  const admin = JSON.parse(readFileSync(`frontend/src/locales/admin/${locale}.json`, 'utf8'));
  const events = new IntlMessageFormat(admin.settings.eventsLoaded, locale);
  for (const [n, expected] of eventResults.entries()) assert.equal(events.format({ n }), expected);
  const groups = new IntlMessageFormat(admin.groups.summary, locale);
  for (const [index, values] of [[1, 2], [2, 1], [0, 0]].entries()) {
    assert.equal(groups.format({ groups: values[0], monitors: values[1] }), groupResults[index]);
  }
}
for (const [locale, key, results] of [
  ['en-US', 'agents.cores', ['0 cores', '1 core', '2 cores']],
  ['fr-FR', 'notify.scopeSelected', ['0 groupes sélectionnés', '1 groupe sélectionné', '2 groupes sélectionnés']],
  ['fr-FR', 'agents.cores', ['0 cœurs', '1 cœur', '2 cœurs']],
  ['pt-BR', 'console.statusIssues', ['0 monitores precisam de atenção', '1 monitor precisa de atenção', '2 monitores precisam de atenção']],
  ['pt-BR', 'notify.scopeSelected', ['0 grupos selecionados', '1 grupo selecionado', '2 grupos selecionados']],
  ['pt-BR', 'agents.cores', ['0 núcleos', '1 núcleo', '2 núcleos']],
  ['ru-RU', 'agents.cores', ['0 ядер', '1 ядро', '2 ядра']],
]) {
  const catalog = JSON.parse(readFileSync(`frontend/src/locales/admin/${locale}.json`, 'utf8'));
  const message = key.split('.').reduce((value, part) => value[part], catalog);
  const formatter = new IntlMessageFormat(message, locale);
  for (const [n, expected] of results.entries()) assert.equal(formatter.format({ n }), expected, `${locale} ${key} ${n}`);
}
const russian = JSON.parse(readFileSync('frontend/src/locales/admin/ru-RU.json', 'utf8'));
assert.equal(new IntlMessageFormat(russian.agents.batchPartial, 'ru-RU').format({ failed: 1, total: 3 }), 'Машин, не выполнивших команду: 1 из 3');
for (const [n, expected] of [[1, '1 ядро'], [2, '2 ядра'], [5, '5 ядер'], [11, '11 ядер'], [21, '21 ядро'], [22, '22 ядра'], [25, '25 ядер']]) {
  assert.equal(new IntlMessageFormat(russian.agents.cores, 'ru-RU').format({ n }), expected);
}
for (const [n, expected] of [[1, 'Будет обновлена (1)'], [2, 'Будут обновлены (2)'], [5, 'Будут обновлены (5)']]) {
  assert.equal(new IntlMessageFormat(russian.agents.batchUpgradeAffected, 'ru-RU').format({ n }), expected);
}
for (const [values, expected] of [
  [{ days: 1, n: 1 }, 'Свёрнуто 1 день по 1 монитору'],
  [{ days: 2, n: 5 }, 'Свёрнуто 2 дня по 5 мониторам'],
  [{ days: 5, n: 21 }, 'Свёрнуто 5 дней по 21 монитору'],
]) {
  assert.equal(new IntlMessageFormat(russian.toast.syncDone, 'ru-RU').format(values), expected);
}
const portuguese = JSON.parse(readFileSync('frontend/src/locales/admin/pt-BR.json', 'utf8'));
for (const [failed, total, expected] of [[0, 0, '0 de 0 máquinas falharam'], [1, 2, '1 de 2 máquinas falhou'], [2, 2, '2 de 2 máquinas falharam']]) {
  assert.equal(new IntlMessageFormat(portuguese.agents.batchPartial, 'pt-BR').format({ failed, total }), expected);
}
for (const [n, total, expected] of [[0, 0, '0 de 0 verificações falharam'], [1, 2, '1 de 2 verificações falhou'], [2, 2, '2 de 2 verificações falharam']]) {
  assert.equal(new IntlMessageFormat(portuguese.insights.failedNote, 'pt-BR').format({ n, total }), expected);
}
for (const locale of ['en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'pt-BR', 'ru-RU', 'zh-CN', 'zh-HK', 'zh-TW']) {
  const catalog = JSON.parse(readFileSync(`frontend/src/locales/${locale}.json`, 'utf8'));
  const tag = (chunks) => chunks;
  const warning = new IntlMessageFormat(catalog.statusPage.unavailablePages, locale).format({ pages: 'north', strong: tag });
  assert.ok(String(warning).includes('north'), `${locale}: unavailable page`);
  const credit = new IntlMessageFormat(catalog.statusPage.poweredByWithCredits, locale).format({
    projectName: 'Uptime Polaris v1', project: tag,
  });
  for (const name of ['Uptime Polaris v1']) {
    assert.ok(String(credit).includes(name), `${locale}: ${name} credit`);
  }
}
console.log('i18n locale, reinstall failure and plural tests passed');
