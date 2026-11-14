import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('../../frontend/node_modules/esbuild');

const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
const find = (node, predicate) => !node || typeof node !== 'object' ? undefined : predicate(node) ? node :
  (node.props?.children ?? []).flat(Infinity).map(child => find(child, predicate)).find(Boolean);
const t = key => key;

function harness(file, start, name, env, end) {
  const source = readFileSync(file, 'utf8');
  const begin = source.indexOf(start);
  const part = source.slice(begin, end ? source.indexOf(end, begin) : undefined).replaceAll('export function', 'function');
  const code = esbuild.transformSync(part + `\nreturn ${name};`, { loader: 'tsx', jsx: 'transform' }).code;
  const state = [], dependencies = [], cleanups = [];
  let cursor = 0, effects = [];
  const useState = initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  };
  const useRef = initial => { const index = cursor++; return state[index] ??= { current: initial }; };
  const useCallback = callback => { cursor++; return callback; };
  const useEffect = (callback, deps) => {
    const index = cursor++;
    if (!dependencies[index] || deps.some((dep, i) => dep !== dependencies[index][i])) {
      dependencies[index] = deps;
      effects.push(() => { cleanups[index]?.(); cleanups[index] = callback(); });
    }
  };
  const scope = { React, useState, useRef, useCallback, useEffect, useTranslations: () => t, ...env };
  const Component = Function(...Object.keys(scope), code)(...Object.values(scope));
  return props => {
    cursor = 0; effects = [];
    const tree = Component(props);
    effects.forEach(effect => effect());
    return tree;
  };
}

const requirementList = analytics => [
  { key: 'database', required: false, ok: false },
  { key: 'config', required: false, ok: false },
  { key: 'adminToken', required: true, ok: true },
  { key: 'themes', required: false, ok: false },
  { key: 'analytics', required: true, ok: analytics },
];
const options = { types: ['postgres'], defaultType: 'postgres', postgresConfigured: true, postgresUrlEditable: false };
const session = requirements => ({ authenticated: false, user: null, needsSetup: true, setupCredential: 'ADMIN_TOKEN', setupDatabase: options, setupRequirements: requirements });

{
  let response = session(requirementList(true));
  let fail = false;
  const render = harness('frontend/src/auth/AuthContext.tsx', 'export function AuthProvider(', 'AuthProvider', {
    useMemo: compute => compute(), AuthContext: { Provider: 'Provider' },
    authApi: { session: async () => { if (fail) throw new Error('network'); return response; } },
    window: { addEventListener() {}, removeEventListener() {} }, SESSION_EXPIRED_EVENT: 'expired',
  }, 'export function useAuth()');
  render({ children: null });
  await new Promise(resolve => setImmediate(resolve));
  let state = render({ children: null }).props.value;
  assert.equal(state.session, response);
  response = session(requirementList(false));
  assert.equal(await state.refresh(), response);
  state = render({ children: null }).props.value;
  assert.equal(state.session, response);
  fail = true;
  assert.equal(await state.refresh(), null);
  state = render({ children: null }).props.value;
  assert.equal(state.session, response, 'failed refresh retains the last session for recovery');
  assert.equal(state.sessionError, true);
}

{
  let current = session(requirementList(false));
  let sessionError = false, calls = 0, advances = 0;
  let response = current, pending;
  const events = new Map();
  const refresh = async () => {
    calls++;
    sessionError = false;
    const next = pending ? await pending : response;
    if (next) current = next;
    else sessionError = true;
    return next;
  };
  const render = harness('frontend/src/auth/DeploymentCheck.tsx', 'const REQUIREMENT_TEXT:', 'DeploymentCheck', {
    useAuth: () => ({ refresh, sessionError }),
    Button: 'Button', AlertCircle: 'AlertCircle', CircleCheck: 'CircleCheck', CircleDashed: 'CircleDashed', ArrowRight: 'ArrowRight', RefreshCw: 'RefreshCw',
    document: { visibilityState: 'visible' },
    window: { addEventListener: (name, handler) => events.set(name, handler), removeEventListener: name => events.delete(name) },
  });
  const onNext = () => { advances++; };
  const draw = () => render({ requirements: current.setupRequirements, ready: current.setupRequirements.every(item => !item.required || item.ok), onNext });
  const button = (tree, label) => find(tree, node => node.type === 'Button' && node.props.children.includes(label));
  let tree = draw();
  assert.equal(button(tree, 'setup.checkNext').props.isDisabled, true);
  assert.ok(JSON.stringify(tree).includes('setup.checkOptionalMissing'));

  response = session(requirementList(true));
  button(tree, 'setup.checkRetry').props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  tree = draw();
  assert.equal(button(tree, 'setup.checkNext').props.isDisabled, false);
  assert.ok(JSON.stringify(tree).includes('setup.checkReady'));

  response = session(requirementList(false));
  button(tree, 'setup.checkNext').props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(advances, 0, 'Next must recheck bindings instead of accepting stale results');
  assert.equal(button(draw(), 'setup.checkNext').props.isDisabled, true);

  current = session(requirementList(true)); response = null;
  tree = draw(); button(tree, 'setup.checkRetry').props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  tree = draw();
  assert.equal(button(tree, 'setup.checkNext').props.isDisabled, true);
  assert.ok(find(tree, node => node.props?.role === 'alert'));

  response = session(requirementList(true));
  events.get('focus')();
  await new Promise(resolve => setImmediate(resolve));
  tree = draw();
  assert.equal(button(tree, 'setup.checkNext').props.isDisabled, false);
  assert.equal(find(tree, node => node.props?.role === 'alert'), undefined);

  let resolve;
  pending = new Promise(done => { resolve = done; });
  const before = calls;
  button(tree, 'setup.checkNext').props.onPress();
  button(tree, 'setup.checkNext').props.onPress();
  assert.equal(calls, before + 1);
  assert.equal(button(draw(), 'setup.checkNext').props.isDisabled, true);
  resolve(response);
  await new Promise(done => setImmediate(done));
  assert.equal(advances, 1);
}

{
  let current = { ...session(requirementList(true)), setupDatabase: { ...options, postgresConfigured: false, postgresUrlEditable: true } };
  let attempts = 0, checks = 0, failCheck = true;
  const env = {
    useAuth: () => ({ session: current, sessionError: false, refresh: async () => current, setup: async () => { attempts++; } }),
    authApi: { configureDatabase: async () => { checks++; if (failCheck) throw new Error('database_connection_failed'); return { ok: true, type: 'postgres', configurationId: 'configuration-1' }; } },
    useNavigate: () => () => {}, buildIconProxyUrl: () => '/icon', PROJECT_NAME: 'Uptime Polaris',
    document: { title: 'fixture' }, CONTENT_TRANSITION: {}, motion: { div: 'div' },
    settingsApi: { updateSettings: async () => {} }, ApiError: class extends Error {},
  };
  for (const name of ['Navigate', 'AuthSplash', 'AuthProductPanel', 'ThemeSwitch', 'LocaleSwitch', 'DeploymentCheck', 'Button', 'Input', 'PasswordInput', 'Select', 'SelectItem', 'Sparkles', 'KeyRound', 'UserRound', 'Lock', 'AlertCircle', 'ArrowRight', 'Loader2', 'Check', 'RefreshCw']) env[name] = name;
  const render = harness('frontend/src/auth/SetupPage.tsx', 'const BRAND_ICON =', 'SetupPage', env);
  const field = (tree, label) => find(tree, node => node.props?.label === label);
  const submit = tree => find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  let tree = render();
  find(tree, node => node.type === 'DeploymentCheck').props.onNext();
  render(); tree = render();
  assert.deepEqual(find(tree, node => node.type === 'Select').props.selectedKeys, ['postgres']);
  assert.equal(JSON.stringify(tree).includes('Cloudflare D1'), false);
  assert.equal(field(tree, 'login.username'), undefined, 'the database step must not collect account details');
  assert.ok(field(tree, 'setup.databaseUrl'), 'PostgreSQL can be configured in the page without D1');
  assert.equal(find(tree, node => node.type === 'Button' && node.props.type === 'submit').props.isDisabled, true);
  field(tree, 'setup.databaseUrl').props.onValueChange('postgresql://fixture:secret@db.example.com/polaris');
  field(tree, 'login.installationCredential').props.onValueChange('setup-secret');
  tree = render();
  const first = submit(tree);
  await submit(tree);
  await first;
  assert.equal(checks, 1, 'duplicate database verification is blocked');
  tree = render();
  assert.equal(attempts, 0);
  assert.equal(field(tree, 'login.username'), undefined, 'a failed database check cannot advance');
  assert.equal(field(tree, 'setup.databaseUrl').props.value, 'postgresql://fixture:secret@db.example.com/polaris');
  failCheck = false;
  await submit(tree);
  tree = render();
  assert.equal(field(tree, 'login.username'), undefined, 'KV propagation must complete before account setup');
  assert.ok(find(tree, node => node.props?.role === 'status'), 'propagation is shown as a waiting state, not an error');
  assert.equal(field(tree, 'setup.databaseUrl').props.value, 'postgresql://fixture:secret@db.example.com/polaris');
  current = { ...current, setupDatabase: { ...current.setupDatabase, postgresConfigured: true, configurationId: 'configuration-1' } };
  await submit(tree);
  assert.equal(checks, 2, 'waiting for KV only refreshes state instead of rewriting the key');
  render(); tree = render();
  assert.ok(field(tree, 'login.username'));
  assert.equal(field(tree, 'setup.databaseUrl'), undefined, 'database configuration is separate from the account step');
  assert.equal(field(tree, 'login.installationCredential'), undefined);
  field(tree, 'login.username').props.onValueChange('owner');
  field(tree, 'login.password').props.onValueChange('private-password');
  field(tree, 'setup.confirmPassword').props.onValueChange('private-password');
  tree = render();
  const back = find(tree, node => node.type === 'button' && node.props.children.includes('setup.databaseBack'));
  back.props.onClick();
  tree = render();
  assert.equal(field(tree, 'setup.databaseUrl').props.value, '', 'the verified URL is no longer retained in the form');
  await submit(tree);
  render(); tree = render();
  assert.equal(field(tree, 'login.username').props.value, 'owner');
  assert.equal(field(tree, 'login.password').props.value, 'private-password');
  await submit(tree);
  assert.equal(attempts, 1, 'account creation is the final step');
}

console.log('Worker setup: late bindings, stale checks, retry, selection and form recovery passed');
