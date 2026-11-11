// 验证首次初始化、重复提交和账号创建边界。
// Check initial setup, repeated submissions, and account creation boundaries.

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const watchdog = setTimeout(() => { console.error('Auth setup fixture timed out'); process.exit(2); }, 60_000);
const harness = [
  "import { authRoutes } from './backends/worker/src/lib/auth/routes.ts';",
  'let calls = 0;',
  'const derive = crypto.subtle.deriveBits.bind(crypto.subtle);',
  'crypto.subtle.deriveBits = (...args) => { calls++; return derive(...args); };',
  'export default { fetch(request, env) {',
  "if (new URL(request.url).pathname === '/_derive-count') return Response.json({ calls });",
  "if (new URL(request.url).pathname === '/_derive-reset') { calls = 0; return Response.json({ ok: true }); }",
  'return authRoutes.fetch(request, env);',
  '} };',
].join('\n');

const built = await build({
  stdin: { contents: harness, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', write: false, target: 'es2022',
  plugins: [{ name: 'unused-adapter-stubs', setup(builder) {
    builder.onResolve({ filter: /^(cloudflare:sockets|postgres)$/ }, () => ({ path: 'adapter', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const connect = () => { throw new Error("unused"); }; export default connect;' }));
  } }],
});

async function worker(bindings) {
  const instance = new Miniflare({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'],
    bindings: { PBKDF2_ITERATIONS: '3000', ...bindings }, d1Databases: { DB: crypto.randomUUID() } });
  const db = await instance.getD1Database('DB');
  await applyD1Migrations(db);
  return { instance, db };
}

async function request(instance, path, body, cookie = '', ip = '192.0.2.1') {
  const response = await instance.dispatchFetch('http://localhost' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = text; }
  return { response, body: result };
}

const { instance, db } = await worker({ ADMIN_TOKEN: 'setup-secret' });
try {
  const initial = await request(instance, '/api/auth/session');
  assert.equal(initial.body.needsSetup, true);
  assert.equal(initial.body.setupCredential, 'ADMIN_TOKEN');
  assert.deepEqual(initial.body.setupRequirements, [
    { key: 'database', required: true, ok: true },
    { key: 'adminToken', required: true, ok: true },
    { key: 'themes', required: false, ok: false },
    { key: 'analytics', required: false, ok: false },
  ]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').first()).n, 0);
  assert.match(initial.response.headers.get('cache-control'), /private, no-store/);
  for (const malformed of ['null', '[]', '3']) assert.equal((await request(instance, '/api/auth/setup', malformed)).response.status, 400);
  assert.equal((await request(instance, '/api/auth/setup', { credential: 'incorrect', username: 'owner', password: 'private-password' })).response.status, 401);

  const candidates = [
    { credential: 'setup-secret', username: 'owner-a', password: 'password-owner-a' },
    { credential: 'setup-secret', username: 'owner-b', password: 'password-owner-b' },
  ];
  const results = await Promise.all(candidates.map((body, index) => request(instance, '/api/auth/setup', body, '', '192.0.2.' + (index + 10))));
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
  const winner = results.findIndex(result => result.response.status === 200);
  const owner = candidates[winner];
  let cookie = results[winner].response.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^polaris_session=/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').first()).n, 1);
  const session = await request(instance, '/api/auth/session', undefined, cookie);
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.user.username, owner.username);
  assert.equal(session.body.setupCredential, null);
  assert.equal(session.body.setupRequirements, null);
  assert.equal(session.body.needsSetup, false);
  assert.equal(Object.hasOwn(session.body, 'mustChangePassword'), false);
  assert.equal((await request(instance, '/api/auth/setup', { credential: 'setup-secret', username: 'extra', password: 'extra-password' })).response.status, 409);

  const stale = Math.floor(Date.now() / 1000) - 901;
  await db.prepare('INSERT INTO auth_login_limits (key_hash, attempts, window_started, locked_until) VALUES (?, 1, ?, 0)').bind('account:stale-fixture', stale).run();
  assert.equal((await request(instance, '/api/auth/login', owner)).response.status, 200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM auth_login_limits WHERE key_hash = ?').bind('account:stale-fixture').first()).n, 0);

  const rename = await request(instance, '/api/auth/account', { current: owner.password, username: 'renamed-owner' }, cookie);
  assert.equal(rename.response.status, 200);
  const passwordChange = await request(instance, '/api/auth/account', { current: owner.password, next: 'replacement-password' }, cookie);
  assert.equal(passwordChange.response.status, 200);
  const oldCookie = cookie;
  cookie = passwordChange.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(instance, '/api/auth/session', undefined, oldCookie)).body.authenticated, false);
  assert.equal((await request(instance, '/api/auth/session', undefined, cookie)).body.authenticated, true);
  for (const path of ['/api/auth/password', '/api/auth/account/password']) assert.equal((await request(instance, path, {})).response.status, 404);

  for (let index = 0; index < 8; index++) assert.equal((await request(instance, '/api/auth/login', { username: 'renamed-owner', password: 'wrong-password' }, '', '192.0.2.20')).response.status, 401);
  await request(instance, '/_derive-reset');
  for (let index = 0; index < 5; index++) await request(instance, '/api/auth/login', { username: 'unknown-' + index, password: 'guess' }, '', '192.0.2.20');
  assert.equal((await request(instance, '/_derive-count')).body.calls, 0);
} finally { await instance.dispose(); }

const bare = await worker({});
try {
  const bareSession = (await request(bare.instance, '/api/auth/session')).body;
  assert.equal(bareSession.setupCredential, null);
  assert.deepEqual(bareSession.setupRequirements.find(item => item.key === 'adminToken'), { key: 'adminToken', required: true, ok: false });
  const rejected = await request(bare.instance, '/api/auth/setup', { credential: 'anything', username: 'owner', password: 'private-password' });
  assert.equal(rejected.response.status, 503);
  assert.equal(rejected.body.error, 'credential_unconfigured');
  assert.equal((await request(bare.instance, '/_derive-count')).body.calls, 0);
} finally { await bare.instance.dispose(); }

const recovered = await worker({});
try {
  // 执行恢复脚本的实际 SQL；创建首个账户时也必须完成初始化状态。
  // Execute the recovery script's SQL; creating the first account must also complete setup.
  const source = readFileSync('scripts/db/create-user.mjs', 'utf8');
  const template = source.match(/const sql = `([\s\S]*?)`;/)[1];
  const values = { id:'cli-owner', normalized:'cli-owner', hash:'fixture-hash', now:'1' };
  const sql = template.replace(/\$\{(id|normalized|hash|now)\}/g, (_, key) => values[key]);
  for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await recovered.db.prepare(statement).run();
  assert.equal((await recovered.db.prepare('SELECT COUNT(*) AS n FROM users').first()).n, 1);
  assert.equal((await request(recovered.instance, '/api/auth/session')).body.needsSetup, false);
} finally { await recovered.instance.dispose(); clearTimeout(watchdog); }
console.log('First-run setup, account changes and login protection passed');
