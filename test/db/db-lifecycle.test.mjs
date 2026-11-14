// 验证请求数据库作用域的复用、隔离与用量计数。
// Check database scope reuse, isolation, and usage counts.

import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { D1Adapter } from '../../backends/worker/src/lib/db/d1.ts';
import { dbScopeMiddleware, getDB, withDBScope, withIndependentDBScope } from '../../backends/worker/src/lib/db/factory.ts';

let calls = 0;
let batches = 0;
const meta = (i) => ({ rows_read: i, rows_written: i + 1, duration: i / 10, changes: i, last_row_id: i });
// 查询序号固定用量元数据；绑定参数不影响本夹具的计数断言。
// Query indices determine usage metadata; bound values do not affect this fixture's count assertions.
function fakeStatement(index) {
  const result = {
    all: async () => ({ results: [{ index }], meta: meta(index) }),
    run: async () => ({ meta: meta(index) }),
  };
  return { bind: () => result };
}

const fakeD1 = {
  prepare(sql) {
    if (sql === "SELECT 1 AS n FROM sqlite_schema WHERE type = 'table' AND name = '_polaris_database'") {
      return { bind: () => ({ all: async () => ({ results: [], meta: { rows_read: 0, rows_written: 0, duration: 0 } }) }) };
    }
    const index = ++calls;
    return fakeStatement(index);
  },
  async batch(statements) {
    batches++;
    return statements.map((_, i) => ({ meta: meta(i + 4) }));
  },
};

const adapter = new D1Adapter(fakeD1);
await adapter.query('SELECT 1');
assert.deepEqual(await adapter.queryOne('SELECT 1'), { index: 2 });
await adapter.execute('UPDATE x SET y = 1');
assert.deepEqual(await adapter.commit([{ sql: 'A' }, { sql: 'B' }]), [4, 5]);
assert.equal(batches, 1);
assert.deepEqual(adapter.getUsage(), {
  binding_requests: 4,
  statements: 5,
  rows_read: 1 + 2 + 3 + 4 + 5,
  rows_written: 2 + 3 + 4 + 5 + 6,
  duration_ms: 0.1 + 0.2 + 0.3 + 0.4 + 0.5,
});
assert.equal(adapter.lastMeta.rows_read, 5);

const env = { DB: fakeD1 };
let first;
let second;
let closedEnv;
await withDBScope(env, async (scopedEnv) => {
  first = getDB(scopedEnv);
  closedEnv = scopedEnv;
  assert.equal(getDB(scopedEnv), first);
  await withDBScope(scopedEnv, async (nestedEnv) => assert.equal(getDB(nestedEnv), first));
});
assert.throws(() => getDB(closedEnv), /scope is closed/);
await withIndependentDBScope(env, async (scopedEnv) => { second = getDB(scopedEnv); });
assert.notEqual(first, second);

const app = new Hono();
app.use('*', dbScopeMiddleware);
app.get('/scope', async (c) => {
  const scopedAdapter = getDB(c.env);
  assert.equal(getDB(c.env), scopedAdapter);
  await scopedAdapter.query('SELECT 1');
  c.executionCtx.waitUntil(Promise.resolve().then(() => getDB(c.env).query('SELECT deferred')));
  return c.json({ bindingRequests: scopedAdapter.getUsage().binding_requests });
});
const middlewareTasks = [];
const response = await app.fetch(new Request('https://uptime-polaris.test/scope'), env, {
  waitUntil: (promise) => middlewareTasks.push(promise),
});
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { bindingRequests: 1 });
await Promise.all(middlewareTasks);

const retained = [];
let heldAdapter;
let release;
const delayed = new Promise((resolve) => { release = resolve; });
const scopeDone = withDBScope(env, async (scopedEnv, ctx) => {
  heldAdapter = getDB(scopedEnv);
  ctx.waitUntil(delayed.then(() => getDB(scopedEnv).query('SELECT delayed')));
  return 'response';
}, { waitUntil: (promise) => retained.push(promise) });
assert.equal(await scopeDone, 'response');
const frameAdapter = await withIndependentDBScope(env, async (scopedEnv) => getDB(scopedEnv));
assert.notEqual(frameAdapter, heldAdapter);
release();
await Promise.all(retained);

await assert.rejects(withDBScope(env, async (scopedEnv) => {
  getDB(scopedEnv);
  throw new Error('scope failure');
}), /scope failure/);

const virtualAE = { writeDataPoint() {} };
const inheritedEnv = Object.create({ DB: fakeD1, CF_ACCOUNT_ID: 'inherited-account' });
const assetBinding = { fetch: async () => new Response('fixture asset') };
Object.defineProperty(inheritedEnv, 'ASSETS', { value: assetBinding, enumerable: false });
const proxyEnv = new Proxy(inheritedEnv, {
  get(target, property, receiver) {
    return property === 'UPTIME' ? virtualAE : Reflect.get(target, property, receiver);
  },
});
assert.equal(Object.hasOwn(proxyEnv, 'UPTIME'), false);
let initialProxyScope;
let proxyAdapter;
await withDBScope(proxyEnv, async (scopedEnv) => {
  initialProxyScope = scopedEnv;
  assert.equal(scopedEnv.UPTIME, virtualAE);
  assert.equal(scopedEnv.ASSETS, assetBinding);
  assert.equal(scopedEnv.CF_ACCOUNT_ID, 'inherited-account');
  proxyAdapter = getDB(scopedEnv);
  assert.equal(getDB(scopedEnv), proxyAdapter);
});
await withIndependentDBScope(initialProxyScope, async (frameEnv) => {
  assert.equal(frameEnv.UPTIME, virtualAE);
  assert.equal(frameEnv.ASSETS, assetBinding);
  assert.notEqual(getDB(frameEnv), proxyAdapter);
});
const concurrentProxyAdapters = await Promise.all([1, 2].map(() => withDBScope(proxyEnv, async (scopedEnv) => {
  assert.equal(scopedEnv.UPTIME, virtualAE);
  return getDB(scopedEnv);
})));
assert.notEqual(concurrentProxyAdapters[0], concurrentProxyAdapters[1]);

console.log('PASS D1 usage totals and request scope reuse/isolation');
