import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
/* 经设置 API 修改配置，再观察实际会话、登录限流和监控行为。
 * Change configuration through the settings API, then observe sessions, login limits, and monitor behavior. */
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';

const ADMIN_TOKEN = 'settings-wiring-token';
const SEED_PASSWORD = 'chosen-password';

const watchdog = setTimeout(() => {
  console.error('FAIL settings-wiring fixture timed out before completion');
  process.exit(2);
}, 90_000);

const HARNESS = `
import { api } from './backends/worker/src/api';
import { hashPassword, findUser, recordFailure, sha256Hex, createSession } from './backends/worker/src/lib/auth/service.ts';
import { resetSettingsCache } from './backends/worker/src/lib/settings/store.ts';
import { runTick } from './backends/worker/src/lib/jobs/tick.ts';
import { loadLiveFresh } from './backends/worker/src/lib/monitor/store.ts';
globalThis.fetch = async () => new Response('unavailable', { status: 503 });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    /** Reset the cache after direct row seeds; settings writes already do this. / 直接写行后重置缓存；设置写入本来就会重置。 */
    if (url.pathname === '/__reset-cache') {
      resetSettingsCache();
      return Response.json({ ok: true });
    }

    if (url.pathname === '/__user') {
      const { username, password } = await req.json();
      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        'INSERT INTO users (id, username, password_hash, created_at, updated_at, failed_count, locked_until) VALUES (?,?,?,?,?,0,0)',
      ).bind(id, username, await hashPassword(password), now, now).run();
      return Response.json({ id });
    }

    if (url.pathname === '/__hash') {
      return Response.json({ hash: await sha256Hex(url.searchParams.get('value') || '') });
    }

    /** Exercise recordFailure directly; the limiter normally shadows it. / 直接测试 recordFailure；限流器通常会遮住它。 */
    if (url.pathname === '/__record-failure') {
      const username = url.searchParams.get('username') || '';
      const user = await findUser(env, username);
      if (!user) return Response.json({ error: 'no_user' }, { status: 404 });
      await recordFailure(env, user);
      const row = await env.DB.prepare('SELECT failed_count, locked_until FROM users WHERE id = ?').bind(user.id).first();
      return Response.json(row);
    }

    if (url.pathname === '/__seed-limit') {
      const key = url.searchParams.get('key') || '';
      const attempts = Number(url.searchParams.get('attempts'));
      const windowStarted = Number(url.searchParams.get('window_started'));
      await env.DB.prepare(
        'INSERT INTO auth_login_limits (key_hash, attempts, window_started, locked_until) VALUES (?,?,?,0)',
      ).bind(key, attempts, windowStarted).run();
      return Response.json({ ok: true });
    }

    if (url.pathname === '/__session-ttl') {
      const { userId } = await req.json();
      const s = await createSession(env, userId, null);
      return Response.json({ expiresAt: s.expiresAt });
    }

    /** Drive one tick with an explicit \`now\` so retries need no wall-clock wait. / 用显式 \`now\` 驱动一次 tick，重试无需等待。 */
    if (url.pathname === '/__tick') {
      const now = Number(url.searchParams.get('now'));
      await runTick(env, now);
      const live = await loadLiveFresh(env);
      return Response.json({ live: live['retry-monitor'] || null });
    }

    return api.fetch(req, env, ctx);
  },
};
`;

const built = await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'esm',
  write: false,
  target: 'es2022',
  logLevel: 'error',
  plugins: [
    {
      name: 'settings-wiring-stubs',
      setup(b) {
        b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'stub' }));
        b.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'pgstub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const connect = () => { throw new Error("no sockets in this test"); };',
        }));
        b.onLoad({ filter: /.*/, namespace: 'pgstub' }, () => ({
          contents: `export default function postgres() { throw new Error('postgres is stubbed in this test bundle'); }`,
        }));
      },
    },
  ],
});

const mf = new Miniflare({
  modules: true,
  script: built.outputFiles[0].text,
  compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'],
  bindings: { ADMIN_TOKEN, PBKDF2_ITERATIONS: '3000' },
  d1Databases: { DB: 'settings-wiring-test' },
});

const origin = 'http://localhost';
const db = await mf.getD1Database('DB');
await applyD1Migrations(db);

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
}
function eq(label, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  check(label, same, same ? undefined : { got, want });
}

async function req(path, init) {
  const res = await mf.dispatchFetch(origin + path, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, headers: res.headers, body };
}

const authed = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };

async function putSettings(values) {
  const r = await req('/api/admin/settings', { method: 'PUT', headers: authed, body: JSON.stringify(values) });
  if (r.status !== 200) throw new Error(`PUT settings -> ${r.status}: ${JSON.stringify(r.body)}`);
  return r;
}

async function createMonitor(body) {
  const r = await req('/api/monitors', { method: 'POST', headers: authed, body: JSON.stringify(body) });
  if (r.status !== 201) throw new Error(`POST monitor -> ${r.status}: ${JSON.stringify(r.body)}`);
  const row = await db.prepare('SELECT interval_sec, timeout_ms FROM monitors WHERE id = ?').bind(r.body.id).first();
  return row;
}

async function login(username, password, ip) {
  return req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ username, password }),
  });
}

/** The Max-Age the login response asked for, or null. / 登录响应请求的 Max-Age，或 null。 */
function maxAgeOf(headers) {
  const cookie = headers.get('set-cookie');
  if (!cookie) return null;
  const match = cookie.match(/Max-Age=(\d+)/);
  return match ? Number(match[1]) : null;
}

try {
  // ------------------------------------------------------------ monitor defaults
  // 监控默认值 / Monitor defaults

  console.log('\nmonitor.defaultIntervalSec / defaultTimeoutMs\n');
  {
    /** A non-default valid value proves the setting was read. / 使用非默认合法值，证明设置被读取。 */
    await putSettings({ 'monitor.defaultIntervalSec': 300, 'monitor.defaultTimeoutMs': 5000 });

    const inherited = await createMonitor({ name: 'inherits', type: 'http', target: 'https://example.com' });
    eq('a create with no interval_sec takes the setting', inherited.interval_sec, 300);
    eq('and no timeout_ms takes the setting too', inherited.timeout_ms, 5000);

    /** An explicit value still wins over the default. / 显式值仍然优先于默认值。 */
    const explicit = await createMonitor({
      name: 'explicit', type: 'http', target: 'https://example.com',
      interval_sec: 120, timeout_ms: 20000,
    });
    eq('an explicit interval_sec beats the setting', explicit.interval_sec, 120);
    eq('and an explicit timeout_ms too', explicit.timeout_ms, 20000);

    // Back to the shipped defaults, so the later login/monitor cases are not
    // quietly running under this section's configuration.
    // 恢复发布默认值，避免后续登录和监控案例静默沿用本节配置。
    await req('/api/admin/settings/monitor.defaultIntervalSec', { method: 'DELETE', headers: authed });
    await req('/api/admin/settings/monitor.defaultTimeoutMs', { method: 'DELETE', headers: authed });
    const back = await createMonitor({ name: 'restored', type: 'http', target: 'https://example.com' });
    eq('clearing the setting restores the 60s default', back.interval_sec, 60);
    eq('and the 10000ms default', back.timeout_ms, 10000);

    /** `/api/overview` must report the same defaults `POST` would save. / `/api/overview` 报告的默认值必须与 `POST` 保存值一致。 */
    await putSettings({ 'monitor.defaultIntervalSec': 900, 'monitor.defaultTimeoutMs': 15000 });
    const overview = await req('/api/overview', { headers: authed });
    eq('the overview carries the interval default', overview.body.defaults?.interval_sec, 900);
    eq('and the timeout default', overview.body.defaults?.timeout_ms, 15000);
    const shown = overview.body.defaults;
    const saved = await createMonitor({ name: 'matches-form', type: 'http', target: 'https://example.com' });
    eq(
      'the value the form would show is the value that gets saved',
      [saved.interval_sec, saved.timeout_ms],
      [shown.interval_sec, shown.timeout_ms],
    );

    await req('/api/admin/settings/monitor.defaultIntervalSec', { method: 'DELETE', headers: authed });
    await req('/api/admin/settings/monitor.defaultTimeoutMs', { method: 'DELETE', headers: authed });
    const reset = await req('/api/overview', { headers: authed });
    eq('clearing them puts the overview back to 60', reset.body.defaults?.interval_sec, 60);
    eq('and 10000', reset.body.defaults?.timeout_ms, 10000);
  }

  // ------------------------------------------------------------ retry budget
  // 重试预算 / Retry budget

  console.log('\nmonitor.defaultRetries\n');
  {
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      `INSERT INTO monitors (id, num_id, name, type, target, method, expected_status,
         interval_sec, timeout_ms, warn_days, check_ssl, check_domain, options_json,
         push_token, active, created_at, updated_at)
       VALUES ('retry-monitor', 901, 'retry', 'http', 'https://retry.example.test', 'GET', '200-299', 60, 10000, 14, 0, 0, '{}',
         NULL, 1, ?, ?)`,
    ).bind(now - 600, now - 600).run();

    await putSettings({ 'monitor.defaultRetries': 1 });

    const tick = async (at) => (await req(`/__tick?now=${at}`)).body.live;
    const resetLive = () => db.prepare("UPDATE live_state SET json = '{}' WHERE id = 'all'").run();

    /** Budget 1 settles on the first failure; budget 3 stays PENDING. / 预算 1 首次失败即确认；预算 3 保持 PENDING。 */
    const first = await tick(now);
    eq('with a budget of 1 the first failure is already settled DOWN', first?.st, 0);
    eq('and the counter reads 1', first?.fails, 1);

    /** Control: the same first failure under budget 3 stays PENDING. / 对照：预算 3 下同样的首次失败保持 PENDING。 */
    await resetLive();
    await req('/api/admin/settings/monitor.defaultRetries', { method: 'DELETE', headers: authed });
    const control1 = await tick(now + 120);
    eq('with the default budget of 3 the first failure is PENDING', control1?.st, 4);
    const control2 = await tick(now + 240);
    eq('and the second failure is still PENDING', control2?.st, 4);
    const control3 = await tick(now + 360);
    eq('the third failure is the one that settles DOWN', control3?.st, 0);
    eq('with fails=3', control3?.fails, 3);

    await db.prepare('DELETE FROM monitors WHERE id = ?').bind('retry-monitor').run();
    await db.prepare("DELETE FROM live_state WHERE id = 'all'").run();
    await db.prepare('DELETE FROM events WHERE monitor_id = ?').bind('retry-monitor').run();
    await req('/api/admin/settings/monitor.defaultRetries', { method: 'DELETE', headers: authed });
  }

  // ------------------------------------------------------------ session ttl
  // 会话 TTL / Session TTL

  console.log('\nsecurity.sessionTtlDays\n');
  {
    const user = (await req('/__user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ttl-user', password: SEED_PASSWORD }),
    })).body;

    // Default first: the shipped session is 14 days.
    // 先检查默认值：发布配置的会话有效期为 14 天。
    const before = await login('ttl-user', SEED_PASSWORD, '198.51.100.1');
    check('the default session lives 14 days', Math.abs(maxAgeOf(before.headers) - 14 * 86400) <= 5);

    await putSettings({ 'security.sessionTtlDays': 2 });
    const after = await login('ttl-user', SEED_PASSWORD, '198.51.100.2');
    check('the configured session lives 2 days', Math.abs(maxAgeOf(after.headers) - 2 * 86400) <= 5);

    /** The cookie TTL and the stored row must agree. / Cookie 有效期与存储行必须一致。 */
    const stored = await db.prepare(
      'SELECT expires_at FROM sessions WHERE token_hash = ?',
    ).bind((await req(`/__hash?value=${encodeURIComponent(after.headers.get('set-cookie').split(';')[0].split('=').slice(1).join('='))}`)).body.hash).first();
    const ttl = stored ? stored.expires_at - Math.floor(Date.now() / 1000) : null;
    check('the sessions row agrees with the cookie', ttl !== null && Math.abs(ttl - 2 * 86400) <= 5, ttl);

    await req('/api/admin/settings/security.sessionTtlDays', { method: 'DELETE', headers: authed });
  }

  // ------------------------------------------------------------ login throttle
  // 登录限流 / Login throttle

  console.log('\nsecurity.loginMaxAttempts\n');
  {
    await req('/__user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'lock-user', password: SEED_PASSWORD }),
    });

    await putSettings({ 'security.loginMaxAttempts': 3 });

    // Two wrong guesses: under the default ceiling of 8 the correct password
    // would still be accepted here. With the setting read, the third attempt is
    // refused by the limiter before the password is even hashed.
    // 两次错误猜测后，默认上限 8 仍会接受正确密码；读取新设置时，第三次尝试在哈希密码前被限流器拒绝。
    eq('wrong guess 1 is rejected', (await login('lock-user', 'nope', '203.0.113.1')).status, 401);
    eq('wrong guess 2 is rejected', (await login('lock-user', 'nope', '203.0.113.1')).status, 401);
    eq(
      'the correct password is refused on attempt 3, so the ceiling is 3 and not 8',
      (await login('lock-user', SEED_PASSWORD, '203.0.113.1')).status,
      401,
    );

    /** The per-account ceiling is a second statement; setting 3 must lock on the third failure. / 账号上限是第二条语句；设为 3 时第三次失败必须锁定。 */
    await db.prepare("DELETE FROM auth_login_limits").run();
    await db.prepare("UPDATE users SET failed_count = 0, locked_until = 0 WHERE username = 'lock-user'").run();
    const f1 = (await req('/__record-failure?username=lock-user')).body;
    const f2 = (await req('/__record-failure?username=lock-user')).body;
    const f3 = (await req('/__record-failure?username=lock-user')).body;
    eq('the counter increments per failure', [f1.failed_count, f2.failed_count, f3.failed_count], [1, 2, 3]);
    check('and the account locks on the third, not the eighth', f3.locked_until > 0, f3);
    eq('the two earlier failures did not lock it', [f1.locked_until, f2.locked_until], [0, 0]);

    await req('/api/admin/settings/security.loginMaxAttempts', { method: 'DELETE', headers: authed });
    await db.prepare("DELETE FROM auth_login_limits").run();
    await db.prepare("UPDATE users SET failed_count = 0, locked_until = 0 WHERE username = 'lock-user'").run();
    eq(
      'after clearing the setting, the third attempt with the right password works again',
      (await login('lock-user', SEED_PASSWORD, '203.0.113.2')).status,
      200,
    );
  }

  console.log('\nsecurity.loginWindowSec\n');
  {
    /* 使用已有失败记录区分短窗口重置与长窗口锁定。
     * Use an existing failure row to distinguish a short-window reset from a long-window lock. */
    await req('/__user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'window-user', password: SEED_PASSWORD }),
    });
    await putSettings({ 'security.loginWindowSec': 60 });

    /** The limiter key hashes only the lowercased name. / 限流键只哈希小写后的名称。 */
    const nameHash = (await req('/__hash?value=window-user')).body.hash;
    const keyHash = `account:${nameHash}`;
    const now = Math.floor(Date.now() / 1000);

    /** A wrong password is required: success deletes the limiter row. / 必须用错密码：成功登录会删除限流行。 */
    await req(`/__seed-limit?key=${encodeURIComponent(keyHash)}&attempts=7&window_started=${now - 120}`);
    eq(
      'a wrong password is still refused',
      (await login('window-user', 'wrong-password', '203.0.113.9')).status,
      401,
    );
    const reset = await db.prepare('SELECT attempts, locked_until FROM auth_login_limits WHERE key_hash = ?')
      .bind(keyHash).first();
    eq(
      'but the stale row was reset by the 60s window rather than counted to the ceiling',
      [reset?.attempts, reset?.locked_until],
      [1, 0],
    );

    /** Control: the same row inside the window locks at 8. / 对照：窗口内的同一行在 8 次时锁定。 */
    await db.prepare('DELETE FROM auth_login_limits').run();
    await db.prepare("UPDATE users SET failed_count = 0, locked_until = 0 WHERE username = 'window-user'").run();
    await putSettings({ 'security.loginWindowSec': 300 });
    await req(`/__seed-limit?key=${encodeURIComponent(keyHash)}&attempts=7&window_started=${now - 120}`);
    eq(
      'the same row inside a 300s window counts: the 8th attempt is refused',
      (await login('window-user', 'wrong-password', '203.0.113.10')).status,
      401,
    );
    const counted = await db.prepare('SELECT attempts, locked_until FROM auth_login_limits WHERE key_hash = ?')
      .bind(keyHash).first();
    eq('the counter reached the ceiling', counted?.attempts, 8);
    check('and the limiter locked the key', counted?.locked_until > now, counted);

    await req('/api/admin/settings/security.loginWindowSec', { method: 'DELETE', headers: authed });
  }

  // ------------------------------------------------------------ visibility
  // 可见性 / Visibility

  console.log('\nGET /api/admin/settings\n');
  {
    const r = await req('/api/admin/settings', { headers: authed });
    eq('the settings endpoint still answers 200', r.status, 200);
    // Read-only is a write rule, not a visibility rule; this pins the half of
    // the contract that a future "make it read-only" change must not break.
    // 只读是写入规则而非可见性规则；固定此契约，防止将来改为只读时破坏读取。
    for (const key of [
      'monitor.defaultIntervalSec',
      'monitor.defaultTimeoutMs',
      'monitor.defaultRetries',
      'security.sessionTtlDays',
      'security.loginMaxAttempts',
      'security.loginWindowSec',
    ]) {
      check(`${key} is present in the GET payload`, key in r.body.values, Object.keys(r.body.values));
    }
  }
  // 查询失败与未配置是不同状态；缓存清空后不得返回默认维护状态。
  // A query failure is distinct from unset values; do not return default maintenance state.
  await db.prepare('ALTER TABLE app_settings RENAME TO unavailable_settings').run();
  await req('/__reset-cache');
  eq('unreadable settings reject public maintenance', (await req('/api/public/maintenance')).status, 500);
  await db.prepare('ALTER TABLE unavailable_settings RENAME TO app_settings').run();
  eq('settings recover after the table is restored', (await req('/api/admin/settings', { headers: authed })).status, 200);
} finally {
  await mf.dispose();
  clearTimeout(watchdog);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
