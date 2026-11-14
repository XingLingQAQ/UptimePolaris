import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('../../frontend/node_modules/esbuild');
const source = readFileSync('frontend/src/routes/NotFoundRoute.tsx', 'utf8');
const part = source.slice(source.indexOf('function SetupAwareNotFound'), source.indexOf('export function NotFoundRoute'));
const code = esbuild.transformSync(part + '\nreturn SetupAwareNotFound;', { loader: 'tsx', jsx: 'transform' }).code;
let state, refreshed = 0;
const scope = {
  React: { createElement: (type, props) => ({ type, props }) },
  useAuth: () => ({ ...state, refresh: () => { refreshed++; } }),
  useLocation: () => ({ pathname: '/unknown/deep', search: '?from=bookmark' }),
  RouteLoading: 'RouteLoading', RouteError: 'RouteError', Navigate: 'Navigate',
};
const render = Function(...Object.keys(scope), code)(...Object.values(scope));
state = { session: null, sessionError: false };
assert.equal(render().type, 'RouteLoading');
state = { session: { needsSetup: true }, sessionError: false };
assert.deepEqual(render(), { type: 'Navigate', props: { to: '/setup', replace: true, state: { from: '/unknown/deep?from=bookmark' } } });
state = { session: { needsSetup: false }, sessionError: false };
assert.deepEqual(render(), { type: 'RouteError', props: { code: 'notFound' } });
state = { session: null, sessionError: true };
const failed = render();
assert.equal(failed.type, 'RouteError');
assert.equal(failed.props.code, 'render');
failed.props.onRetry();
assert.equal(refreshed, 1);
console.log('PASS unknown-page setup gate, configured 404 and retryable session failure');
