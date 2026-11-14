// 验证主题页拖放上传：拖入状态、ZIP 校验与禁用行为。
// Check theme-page drag and drop: dragging state, ZIP validation, and disabled behavior.

import assert from 'node:assert/strict';
import { build } from 'esbuild';

globalThis.fixture = { state: [], index: 0, effects: [], themes: [], storageReady: false, loaded: false, events: [] };
const mocks = {
  '../settings/presentation-api': `export const PRESENTATION_KEY = 'presentation'; export const usePresentation = () => ({ data: undefined, mutate: async () => {} }); export const updatePresentation = async () => {};`,
  swr: `export const mutate = async () => {};`,
  '@/api/backend': `export const useBackendCapabilities = () => ({ data: { runtime: 'worker', themes: { storage: 'r2', installationAvailable: true } }, mutate: async () => {} });`,
  '@/lib/useMotionList': `export const useMotionList = () => () => {};`,
  '@/components/ui/MotionOverlays': `export const Modal = 'modal';`,
  './PageThemes': `export const PageThemes = 'page-themes';`,
  react: `
    export function useState(initial) {
      const index = fixture.index++;
      if (!(index in fixture.state)) fixture.state[index] = initial;
      return [fixture.state[index], value => { fixture.state[index] = typeof value === 'function' ? value(fixture.state[index]) : value; }];
    }
    export function useRef(initial) {
      const index = fixture.index++;
      return fixture.state[index] ??= { current: initial };
    }
    export const useCallback = callback => callback;
    export function useEffect(effect) {
      const index = fixture.index++;
      if (!(index in fixture.state)) { fixture.state[index] = true; fixture.effects.push(effect); }
    }
  `,
  'react/jsx-runtime': `export const Fragment = 'fragment'; export function jsx(type, props) { return typeof type === 'function' ? type(props) : { type, props }; } export const jsxs = jsx;`,
  'react-router': `export function useNavigate() { return (...args) => fixture.events.push(['navigate', ...args]); }`,
  'use-intl': `export function useTranslations() { return (key, args) => args?.name ? key + ':' + args.name : key; }`,
  '@heroui/react': `export const Button = 'button', Input = 'input', Skeleton = 'skeleton', Modal = 'modal', ModalBody = 'body', ModalContent = 'content', ModalFooter = 'footer', ModalHeader = 'header';`,
  'lucide-react': `export const Check = 'icon', ArrowDownToLine = 'icon', ArrowUpFromLine = 'icon', Eye = 'icon', FileArchive = 'icon', Layers = 'icon', Loader2 = 'icon', Package = 'icon', RefreshCw = 'icon', Trash2 = 'icon';`,
  '@/api/errors': `export class UnauthorizedError extends Error {}`,
  '@/api/useApiErrorMessage': `export function useApiErrorMessage() { return error => error.message; }`,
  '@/components/ui/toast': `export const toast = { success: value => fixture.events.push(['success', value]), error: value => fixture.events.push(['error', value]), info: value => fixture.events.push(['info', value]) };`,
  '../components/ConsolePrimitives': `export const EmptyState = 'empty';`,
  '../components/illustrations': `export const SwatchArt = 'art';`,
  '../components/Panel': `export const Panel = 'panel', PanelHeader = 'panel-header';`,
  '../layout/AdminPage': `export const AdminPage = 'page';`,
  './api': `export const themesApi = { list: async () => ({ themes: fixture.loaded ? fixture.themes : null, storageReady: fixture.storageReady }) };`,
  './ThemePreviewFrame': `export const ThemePreviewFrame = 'preview';`,
};
const bundle = await build({
  entryPoints: ['frontend/src/admin/themes/ThemesPage.tsx'],
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'theme-drop', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'fixture' } : null);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
  } }],
});
const { ThemesPage } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const flatten = node => Array.isArray(node) ? node.flatMap(flatten)
  : !node || typeof node !== 'object' ? [] : [node, ...flatten(node.props?.children)];
function render() {
  fixture.index = 0;
  return flatten(ThemesPage());
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const zone = tree => tree.find(node => node.type === 'label');
const text = (tree, value) => tree.some(node => node.props?.children === value);
const dragEvent = (files = []) => ({
  prevented: false,
  dataTransfer: { files, dropEffect: '' },
  preventDefault() { this.prevented = true; },
});
const drop = (files = []) => {
  const event = dragEvent(files);
  zone(tree).props.onDrop(event);
  tree = render();
  return event;
};
const zip = (name = 'theme.zip', type = 'application/zip') => ({ name, type });

fixture.themes = [];
render();
const loadEffects = fixture.effects.splice(0);
for (const effect of loadEffects) effect();
await settle();
let tree = render();
let event;

const refresh = async () => {
  for (const effect of loadEffects) await effect();
  await settle();
  tree = render();
};

// Nothing installed and no storage: the zone stays disabled and refuses a drop.
assert.equal(zone(tree).props['aria-disabled'], true, 'disabled zone is marked disabled');
const disabledEvent = dragEvent();
zone(tree).props.onDragOver(disabledEvent);
assert.equal(disabledEvent.dataTransfer.dropEffect, 'none', 'disabled zone refuses the drop');
zone(tree).props.onDragEnter(dragEvent());
tree = render();
assert.ok(!String(zone(tree).props.className).includes('ring-primary/20'), 'disabled zone never paints dragging');
drop([zip()]);
assert.ok(!text(tree, 'theme.zip'), 'disabled zone ignores a dropped file');

// Ready storage enables the zone.
fixture.loaded = true;
fixture.storageReady = true;
await refresh();
const enabled = zone(tree);
assert.equal(enabled.props['aria-disabled'], false, 'ready zone is enabled');

// Drag enter paints the zone; drag over advertises a copy.
enabled.props.onDragEnter(dragEvent());
tree = render();
assert.ok(String(zone(tree).props.className).includes('ring-primary/20'), 'drag enter paints the zone');
event = dragEvent();
zone(tree).props.onDragOver(event);
assert.equal(event.prevented, true, 'drag over prevents the browser default');
assert.equal(event.dataTransfer.dropEffect, 'copy', 'drag over advertises a copy');

// Child enter/leave pairs must not clear the state before the zone itself leaves.
zone(tree).props.onDragEnter(dragEvent());
tree = render();
zone(tree).props.onDragLeave();
tree = render();
assert.ok(String(zone(tree).props.className).includes('ring-primary/20'), 'nested drag enter/leave keeps the state');
zone(tree).props.onDragLeave();
tree = render();
assert.ok(!String(zone(tree).props.className).includes('ring-primary/20'), 'leaving the zone clears the state');

// A single ZIP is selected.
event = drop([zip()]);
assert.equal(event.prevented, true, 'drop prevents the browser default');
assert.ok(text(tree, 'theme.zip'), 'dropped ZIP is selected');
assert.ok(!text(tree, 'dropInvalid'), 'valid ZIP shows no error');

// Non-ZIP, ZIP with a foreign MIME type, and multi-file drops are rejected.
for (const files of [[zip('notes.txt', 'text/plain')], [zip('theme.zip', 'application/pdf')], [zip('a.zip'), zip('b.zip')], []]) {
  drop(files);
  assert.ok(text(tree, 'dropInvalid'), `rejected drop shows the validation error (${files.map(file => file.name).join(',') || 'empty'})`);
  assert.ok(text(tree, 'theme.zip'), 'rejected drop keeps the previous selection');
}

// Picking a file again clears the rejection.
const input = tree.find(node => node.type === 'input' && node.props.type === 'file');
input.props.onChange({ currentTarget: { files: [zip('picked.zip')] } });
tree = render();
assert.ok(text(tree, 'picked.zip'), 'picker selection replaces the file');
assert.ok(!text(tree, 'dropInvalid'), 'picker selection clears the error');

console.log('theme drag and drop tests passed');
