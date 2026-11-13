// Check avatar upload, reads, replacement, and deletion.
// 验证头像上传、读取、替换与删除。

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { workerBundlePlugins } from '../helpers/bundle-worker.mjs';

const bundle = await build({
  entryPoints: ['backends/worker/src/index.ts'], bundle: true, write: false, format: 'esm',
  target: 'es2022', plugins: workerBundlePlugins(), logLevel: 'error',
});
const mf = new Miniflare({
  modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'],
  analyticsEngineDatasets: { UPTIME: { dataset: 'setup_fixture' } }, d1Databases: ['DB'], bindings: { ADMIN_TOKEN: 'avatar-fixture-secret' },
});
const origin = 'http://avatar-fixture.test';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR4nGNgYGD4z8Dwn4GBAQAAAAD//wMAAP8A//8AAoAAAf+amj8cAAAAAElFTkSuQmCC', 'base64');
const request = (path, cookie, options = {}) => mf.dispatchFetch(origin + path, {
  ...options, headers: { ...(cookie ? { cookie } : {}), ...options.headers },
});
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const upload = (cookie, body = png, headers = {}) => request('/api/auth/avatar', cookie, {
  method: 'POST', headers: { 'content-type': 'image/png', ...headers }, body,
});
const metadata = async (cookie) => {
  const result = await request('/api/auth/avatar', cookie);
  assert.equal(result.status, 200);
  assert.match(result.headers.get('cache-control'), /private.*no-store/);
  return result.json();
};

try {
  const setup = await request('/api/auth/setup', null, json({ credential: 'avatar-fixture-secret', username: 'avatar-one', password: 'avatar-password' }));
  assert.equal(setup.status, 200, await setup.clone().text());
  const user = (await setup.json()).user;
  const cookie = setup.headers.get('set-cookie').split(';')[0];

  // Omit the setup session from anonymous requests to verify avatar authentication.
  // 初始化会话不传入匿名请求，继续验证头像入口的账户鉴权。
  for (const [path, options] of [
    ['/api/auth/avatar', {}], ['/api/auth/avatar/image', {}],
    ['/api/auth/avatar', { method: 'POST', body: png }], ['/api/auth/avatar', { method: 'DELETE' }],
  ]) assert.equal((await request(path, null, options)).status, 401);

  assert.deepEqual(await metadata(cookie), { uploaded: false, url: null });

  const db = await mf.getD1Database('DB');
  await db.prepare(`INSERT INTO users (id, username, password_hash, created_at, updated_at, failed_count, locked_until)
    SELECT 'avatar-other-user', 'avatar-two', password_hash, created_at, updated_at, 0, 0 FROM users WHERE id = ?`).bind(user.id).run();
  const secondLogin = await request('/api/auth/login', null, json({ username: 'avatar-two', password: 'avatar-password' }));
  assert.equal(secondLogin.status, 200);
  const otherCookie = secondLogin.headers.get('set-cookie').split(';')[0];

  const firstUpload = await upload(cookie);
  assert.equal(firstUpload.status, 200, await firstUpload.clone().text());
  const first = await firstUpload.json();
  assert.equal(first.uploaded, true);
  assert.match(first.url, /^\/api\/auth\/avatar\/image\?v=/);
  assert.deepEqual(await metadata(cookie), first);
  const image = await request(first.url, cookie);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.match(image.headers.get('cache-control'), /private.*no-store/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

  assert.deepEqual(await metadata(otherCookie), { uploaded: false, url: null });
  assert.equal((await request(first.url, otherCookie)).status, 404);
  assert.equal((await request(first.url, null)).status, 401);
  assert.deepEqual(await (await request('/api/auth/avatar?user_id=' + user.id, otherCookie)).json(), { uploaded: false, url: null });

  for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), png.subarray(0, 30), Buffer.alloc(0)]) {
    const rejected = await upload(cookie, bad);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, 'avatar_invalid');
    assert.deepEqual(await metadata(cookie), first);
  }
  const oversized = await upload(cookie, Buffer.alloc(384 * 1024 + 1));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await metadata(cookie), first);

  const replacement = await upload(cookie, png, { 'content-type': 'application/octet-stream' });
  assert.equal(replacement.status, 200);
  const replaced = await replacement.json();
  assert.notEqual(replaced.url, first.url);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM user_avatars WHERE user_id = ?').bind(user.id).first()).n, 1);

  const relogin = await request('/api/auth/login', null, json({ username: 'avatar-one', password: 'avatar-password' }));
  assert.equal(relogin.status, 200);
  assert.deepEqual(await metadata(relogin.headers.get('set-cookie').split(';')[0]), replaced);

  const removed = await request('/api/auth/avatar', cookie, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(await metadata(cookie), { uploaded: false, url: null });
  assert.equal((await request(replaced.url, cookie)).status, 404);
  assert.equal((await request('/api/auth/avatar', cookie, { method: 'DELETE' })).status, 200);

  await upload(otherCookie);
  await db.prepare('DELETE FROM users WHERE id = ?').bind('avatar-other-user').run();
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM user_avatars WHERE user_id = ?').bind('avatar-other-user').first()).n, 0);
  console.log('PASS: avatar authentication, persistence, replacement, account isolation, validation, deletion and user cleanup');
} finally {
  await mf.dispose();
}
