// 验证主题删除确认、取消、重复提交与失败恢复。
// Check theme-deletion confirmation, cancellation, duplicate submission, and recovery.

import assert from 'node:assert/strict';
import { build } from 'esbuild';

globalThis.fixture = { state: [], index: 0, effects: [], themes: [], events: [], remove: null };
const mocks = {
  '../settings/presentation-api': `export const PRESENTATION_KEY = 'presentation'; export const usePresentation = () => ({ data: undefined, mutate: async () => {} }); export const updatePresentation = async () => {};`,
  swr: `export const mutate = async () => {};`,
  '@/api/backend': `export const useBackendCapabilities = () => ({ data: { runtime: 'worker', themes: { storage: 'r2' } } });`,
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
  // 展开实际子组件，确保拆分卡片后仍能断言同一按钮行为。
  // Render child components so card extraction preserves the same button assertions.
  'react/jsx-runtime': `export const Fragment = 'fragment'; export function jsx(type, props) { return typeof type === 'function' ? type(props) : { type, props }; } export const jsxs = jsx;`,
  'react-router': `export function useNavigate() { return (...args) => fixture.events.push(['navigate', ...args]); }`,
  'use-intl': `export function useTranslations() { return (key, args) => args?.name ? key + ':' + args.name : key; }`,
  '@heroui/react': `export const Button = 'button', Input = 'input', Skeleton = 'skeleton', Modal = 'modal', ModalBody = 'body', ModalContent = 'content', ModalFooter = 'footer', ModalHeader = 'header';`,
  'lucide-react': `export const Check = 'icon', ArrowDownToLine = 'icon', ArrowUpFromLine = 'icon', Eye = 'icon', FileArchive = 'icon', Layers = 'icon', Loader2 = 'icon', Package = 'icon', Palette = 'icon', RefreshCw = 'icon', RotateCcw = 'icon', Settings2 = 'icon', Trash2 = 'icon';`,
  '@/api/errors': `export class UnauthorizedError extends Error {}`,
  '@/api/useApiErrorMessage': `export function useApiErrorMessage() { return error => error.message; }`,
  '@/components/ui/toast': `export const toast = { success: value => fixture.events.push(['success', value]), error: value => fixture.events.push(['error', value]) };`,
  '../components/ConsolePrimitives': `export const EmptyState = 'empty';`,
  '../components/illustrations': `export const SwatchArt = 'art';`,
  '../components/Panel': `export const Panel = 'panel', PanelHeader = 'panel-header';`,
  '../layout/AdminPage': `export const AdminPage = 'page';`,
  '../monitors/MonitorIndicators': `export const StatusPill = 'pill';`,
  './api': `export const themesApi = {
    list: async () => ({ themes: fixture.themes, storageReady: fixture.storageReady }),
    remove: short => fixture.remove(short),
  };`,
  './ThemePreviewFrame': `export const ThemePreviewFrame = 'preview';`,
};
const bundle = await build({
  entryPoints: ['frontend/src/admin/themes/ThemesPage.tsx'],
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'theme-interactions', setup(builder) {
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
const findButton = (tree, label) => tree.find(node => node.type === 'button' && node.props.children === label);
const modal = tree => tree.find(node => node.type === 'modal');
const confirm = tree => findButton(flatten(modal(tree)), 'delete');

fixture.themes = [{ id: 'unusable', short: 'unusable', name: 'Unavailable', isActive: false, supported: false, hasEntry: false, versions: [] }];
fixture.storageReady = false;
render();
for (const effect of fixture.effects.splice(0)) effect();
await settle();
let tree = render();
assert.equal(findButton(tree, 'delete').props.isDisabled, false, 'unusable themes can be removed without storage');
findButton(tree, 'delete').props.onPress();
tree = render();
assert.equal(modal(tree).props.isOpen, true);
findButton(flatten(modal(tree)), 'cancel').props.onPress();
tree = render();
assert.equal(modal(tree).props.isOpen, false);

let attempts = 0;
let rejectRemoval;
fixture.remove = short => {
  assert.equal(short, 'unusable');
  attempts++;
  return new Promise((_, reject) => { rejectRemoval = reject; });
};
findButton(tree, 'delete').props.onPress();
tree = render();
confirm(tree).props.onPress();
confirm(tree).props.onPress();
tree = render();
assert.equal(attempts, 1, 'rapid confirmation sends only one deletion');
assert.equal(confirm(tree).props.isLoading, true);
assert.equal(modal(tree).props.isDismissable, false);
assert.equal(modal(tree).props.isKeyboardDismissDisabled, true);
modal(tree).props.onClose();
assert.equal(modal(render()).props.isOpen, true);
rejectRemoval(new Error('deleteFailed'));
await settle();
tree = render();
assert.equal(modal(tree).props.isOpen, true, 'failed deletion keeps its target and confirmation');
assert.ok(tree.some(node => node.props?.role === 'alert' && node.props.children === 'deleteFailed'));
assert.equal(confirm(tree).props.isDisabled, false);
assert.equal(fixture.events.some(event => event[0] === 'success'), false);

fixture.remove = async () => { attempts++; fixture.themes = []; return { ok: true }; };
confirm(tree).props.onPress();
await settle();
tree = render();
assert.equal(attempts, 2);
assert.equal(modal(tree).props.isOpen, false);
assert.equal(tree.some(node => node.type === 'button' && node.props['aria-label'] === 'deleteTitle:Unavailable'), false);
assert.deepEqual(fixture.events, [['success', 'deleted']]);

fixture.state = [];
fixture.index = 0;
fixture.themes = [{ id: 'active-theme', short: 'active', name: 'Active theme', isActive: true, supported: true, hasEntry: true, versions: [] }];
fixture.storageReady = true;
render();
for (const effect of fixture.effects.splice(0)) effect();
await settle();
tree = render();
findButton(tree, 'delete').props.onPress();
tree = render();
assert.ok(flatten(modal(tree)).some(node => node.props?.children === 'deletePageReferences'), 'deletion explains page reference removal');
console.log('PASS theme removal: unavailable records, confirmation, cancellation, duplicate submission, busy state, failure recovery and page reference warning');
