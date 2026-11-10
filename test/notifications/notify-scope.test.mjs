import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
/* 使用 D1 和受控发送端验证渠道范围、更新语义、删除及重试租约。
 * Use D1 and controlled delivery to check channel scopes, update semantics, deletion, and retry leases. */
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';

const HARNESS = `
import { Hono } from 'hono';
import { dispatch, retryPending } from './backends/worker/src/lib/notification/dispatch';
import { loadChannels, createChannel, deleteChannel } from './backends/worker/src/lib/notification/channels';
import { scopeMatches } from './backends/worker/src/lib/notification/scope.ts';
import { notifyRoutes } from './backends/worker/src/lib/notification/routes.ts';
import { groupTagRoutes } from './backends/worker/src/lib/group/routes.ts';
import { createGroup, deleteGroup } from './backends/worker/src/lib/group/groups.ts';

/**
 * The two route apps, mounted the way backends/worker/src/api.ts mounts them - at the root, with
 * the auth gate omitted. The gate is not part of either app; these tests are
 * about what the routes do once authorised.
 * 两个路由应用按 backends/worker/src/api.ts 的方式挂载在根路径，省略认证门禁；门禁不属于应用本身，
 * 这里测试授权之后的路由行为。
 */
const routes = new Hono();
routes.route('/', notifyRoutes);
routes.route('/', groupTagRoutes);

/**
 * The fake transport, and the record of what it was asked to send.
 *
 * notify.ts calls the global fetch, so this is the whole injection. Each channel
 * is given a distinct URL by the scenarios below, which is what lets an
 * assertion name the channel rather than count requests.
 * 模拟传输及发送记录。notify.ts 调用全局 fetch，因此替换它即可注入；
 * 各渠道使用独立 URL，使断言可识别具体渠道而不只统计请求次数。
 */
let fake = null;
const sent = [];

/**
 * Structured log lines are captured rather than printed: dispatch is expected to
 * log when an event matches no channel, and echoing it would bury the test's own
 * output. Anything that is not JSON goes to the real stderr.
 * 捕获结构化日志而不打印：事件无匹配渠道时 dispatch 预期会记录日志，直接输出会淹没测试结果；
 * 非 JSON 内容仍写入真实 stderr。
 */
const logs = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const line = args.map(String).join(' ');
  try { JSON.parse(line); logs.push(line); } catch { realError(line); }
};

globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url) });
  if (!fake) throw new Error('no fake transport installed');
  return fake(String(url), init);
};

/** A generic webhook treats any 2xx as delivered, so this is a whole success. / 通用 webhook 将任意 2xx 视为送达，因此这是完整成功响应。 */
const ok = async () => new Response('', { status: 200 });

function reset() { sent.length = 0; logs.length = 0; }
const urls = () => sent.map((s) => s.url).sort();
const parsedLogs = () => logs.map((l) => JSON.parse(l));

const event = (over) => Object.assign({
  monitorName: 'prod site',
  monitorTarget: 'https://example.com',
  monitorType: 'http',
  status: 0,
  prevStatus: 1,
  message: 'HTTP 500',
  at: Math.floor(Date.now() / 1000),
}, over || {});


async function mk(env, name, url, groupIds) {
  const id = await createChannel(env, {
    name,
    type: 'webhook',
    config: { url },
    ...(groupIds !== undefined ? { group_ids: groupIds } : {}),
  });
  return (await loadChannels(env)).find((c) => c.id === id);
}

async function clean(env) {
  await env.DB.prepare('DELETE FROM notification_deliveries').run();
  await env.DB.prepare('DELETE FROM pending_notifications').run();
  await env.DB.prepare('DELETE FROM notification_groups').run();
  await env.DB.prepare('DELETE FROM notifications').run();
  await env.DB.prepare('DELETE FROM monitor_groups').run();
}

async function count(env, sql, ...params) {
  const row = await env.DB.prepare(sql).bind(...params).first();
  return row.n;
}

const list = async (env) =>
  (await (await routes.fetch(new Request('http://localhost/api/notifications'), env)).json()).channels;

const api = (env, path, body, method) =>
  routes.fetch(new Request('http://localhost' + path, {
    method: method || 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    const json = (o) => Response.json(o);
    if (p.startsWith('/api/')) return routes.fetch(req, env);

    if (p === '/scope-matches') {
      /**
       * The rule, called directly and with no database anywhere near it. The
       * first three are the guarantee that an unscoped channel keeps receiving
       * everything, including from a monitor in no group; the last five are
       * membership and the gap.
       * 不访问数据库直接调用规则。前三项保证无范围渠道接收所有事件（包括未分组监控），
       * 后五项验证成员关系和未分组缺口。
       */
      return json({
        emptyGrouped: scopeMatches([], 'group-a'),
        emptyUngrouped: scopeMatches([], null),
        emptyAbsent: scopeMatches([], undefined),
        own: scopeMatches(['group-a'], 'group-a'),
        other: scopeMatches(['group-a'], 'group-b'),
        ungroupedIsNotAMember: scopeMatches(['group-a'], null),
        absentIsNotAMember: scopeMatches(['group-a'], undefined),
        secondOfTwo: scopeMatches(['group-a', 'group-b'], 'group-b'),
      });
    }

    if (p === '/dispatch-two-channels') {
      reset(); await clean(env);
      // One channel scoped to group A, one unscoped. Both are webhooks, so
      // success is a plain 2xx and the URL is the only thing under test.
      // 一个渠道限定组 A，另一个无范围；两者都是 webhook，2xx 即成功，只需检查 URL。
      await mk(env, 'scoped-a', 'https://example.com/a', ['group-a']);
      await mk(env, 'everyone', 'https://example.com/all');
      fake = ok;

      // An event from a monitor in group A: both channels want it.
      // 组 A 中监控的事件应发送给两个渠道。
      await dispatch(env, [event({ groupId: 'group-a' })]);
      const forA = urls();
      reset();

      // An event from group B: only the unscoped channel does. This is the
      // feature - the scoped channel must not receive it.
      // 组 B 的事件只发送给无范围渠道；限定范围的渠道不得接收。
      await dispatch(env, [event({ groupId: 'group-b' })]);
      const forB = urls();
      reset();

      // And an ungrouped monitor, which the unscoped channel still receives.
      // 未分组监控仍由无范围渠道接收。
      await dispatch(env, [event({ groupId: null })]);
      const forUngrouped = urls();

      return json({ forA, forB, forUngrouped });
    }

    if (p === '/outbox-retry') {
      reset(); await clean(env);
      await mk(env, 'delivered', 'https://example.com/delivered');
      await mk(env, 'retry-only', 'https://example.com/retry', ['group-a']);
      await mk(env, 'out-of-scope', 'https://example.com/excluded', ['group-b']);
      fake = async (url) => new Response('', { status: url.endsWith('/retry') ? 503 : 200 });
      await dispatch(env, [
        event({ monitorType: 'agent', eventKey: 'resource:cpu:entry', groupId: 'group-a' }),
        event({ monitorType: 'agent', eventKey: 'resource:memory:entry', groupId: 'group-a' }),
      ]);
      const firstSend = urls();
      reset(); fake = ok;
      const now = Math.floor(Date.now() / 1000) + 60;
      for (let round = 0; round < 4; round++) await Promise.all([retryPending(env, now + round * 60), retryPending(env, now + round * 60)]);
      return json({ firstSend, successful: await count(env, 'SELECT COUNT(*) AS n FROM notification_deliveries WHERE ok = 1'), retried: urls(), pending: await count(env, 'SELECT COUNT(*) AS n FROM pending_notifications WHERE channel_id = ?', (await loadChannels(env)).find((c) => c.name === 'retry-only').id) });
    }

    if (p === '/outbox-inflight-race') {
      reset(); await clean(env);
      await mk(env, 'race', 'https://example.com/race');
      let startedResolve;
      let releaseResolve;
      const started = new Promise((resolve) => { startedResolve = resolve; });
      const release = new Promise((resolve) => { releaseResolve = resolve; });
      fake = async () => { startedResolve(); await release; return ok(); };
      const sending = dispatch(env, [event({ monitorId: 'agent-1', eventKey: 'resource:cpu:entry', monitorType: 'agent' })]);
      await started;
      await retryPending(env, Math.floor(Date.now() / 1000));
      const duringSend = urls();
      releaseResolve();
      await sending;
      return json({ duringSend, total: urls() });
    }

    if (p === '/dispatch-all-scoped-ungrouped') {
      reset(); await clean(env);
      await mk(env, 'a', 'https://example.com/a', ['group-a']);
      await mk(env, 'b', 'https://example.com/b', ['group-b']);
      fake = ok;

      await dispatch(env, [event({ groupId: null })]);
      return json({ urls: urls(), unmatched: parsedLogs().filter((o) => o.event === 'notify_unmatched') });
    }

    if (p === '/api-default-scope') {
      reset(); await clean(env);
      fake = ok;

      // Created through the API and never mentioning group_ids, which is what
      // every existing client does.
      // 通过 API 创建且不提供 group_ids，与现有客户端的调用方式一致。
      const created = await api(env, '/api/notifications', {
        name: 'ops', type: 'webhook', config: { url: 'https://example.com/everyone' },
      });
      const { id } = await created.json();
      const stored = (await list(env)).find((c) => c.id === id);

      // Both a grouped and an ungrouped monitor must reach it.
      // 已分组和未分组监控的事件都必须送达。
      await dispatch(env, [event({ groupId: 'group-a' }), event({ groupId: null })]);
      return json({ status: created.status, group_ids: stored.group_ids, urls: urls() });
    }

    if (p === '/api-put-scope') {
      reset(); await clean(env);
      const g1 = await createGroup(env, { name: 'G1' });
      const g2 = await createGroup(env, { name: 'G2' });

      const { id } = await (await api(env, '/api/notifications', {
        name: 'ops', type: 'webhook', config: { url: 'https://example.com/x' }, group_ids: [g1],
      })).json();

      const read = async () => (await list(env)).find((c) => c.id === id).group_ids;
      const created = await read();

      // Omitting the field - a rename, a config fix, a pause - must leave the
      // scope exactly as it was. This is the case a truthiness test gets wrong.
      // 省略字段（重命名、修正配置或暂停）必须原样保留范围；简单真假值判断容易处理错误。
      await api(env, '/api/notifications/' + id, { name: 'renamed' }, 'PUT');
      const afterRename = await read();

      // An explicit [] is an instruction, not an absence: it clears the scope,
      // which returns the channel to receiving every monitor.
      // 显式 [] 是清空范围的指令而非缺省，使渠道重新接收所有监控。
      await api(env, '/api/notifications/' + id, { group_ids: [] }, 'PUT');
      const afterClear = await read();

      // A non-empty array replaces the set wholesale.
      // 非空数组整体替换范围集合。
      await api(env, '/api/notifications/' + id, { group_ids: [g2] }, 'PUT');
      const afterReplace = await read();

      // And omitted again, with a scope now present, to prove the two directions
      // are told apart in both orders.
      // 范围存在时再次省略字段，验证两种顺序都能区分。
      await api(env, '/api/notifications/' + id, { active: 1 }, 'PUT');
      const afterOmitAgain = await read();

      return json({ created, afterRename, afterClear, afterReplace, afterOmitAgain, g1, g2 });
    }

    if (p === '/api-bad-group') {
      reset(); await clean(env);
      const g1 = await createGroup(env, { name: 'G1' });

      const created = await api(env, '/api/notifications', {
        name: 'ops', type: 'webhook', config: { url: 'https://example.com/x' }, group_ids: ['no-such-group'],
      });
      const createdBody = await created.json();

      // Nothing was created by the refused request - the check runs before the
      // INSERT, which is what makes a refusal cost nothing.
      // 被拒请求不得创建任何内容；检查在 INSERT 前执行，因此拒绝不会产生写入。
      const afterCreate = (await list(env)).length;

      const { id } = await (await api(env, '/api/notifications', {
        name: 'ops', type: 'webhook', config: { url: 'https://example.com/x' }, group_ids: [g1],
      })).json();

      const updated = await api(env, '/api/notifications/' + id, { group_ids: ['no-such-group'] }, 'PUT');
      const updatedBody = await updated.json();

      // The refused update left the stored scope alone, rather than half
      // applying an edit and then reporting the failure.
      // 被拒更新必须保留原有范围，不能部分应用后才报错。
      const storedAfter = (await list(env)).find((c) => c.id === id).group_ids;

      // A shape that is not an array names no group either, and is refused by
      // the same code rather than reaching the query builder.
      // 非数组也不能指定分组；由同一校验拒绝，不进入查询构造器。
      const notAnArray = await api(env, '/api/notifications', {
        name: 'other', type: 'webhook', config: { url: 'https://example.com/y' }, group_ids: 'no-such-group',
      });

      return json({
        g1,
        createStatus: created.status, createdBody, afterCreate,
        updateStatus: updated.status, updatedBody, storedAfter,
        notAnArrayStatus: notAnArray.status, notAnArrayBody: await notAnArray.json(),
      });
    }

    if (p === '/delete-channel') {
      reset(); await clean(env);
      const g1 = await createGroup(env, { name: 'G1' });
      const ch = await mk(env, 'ops', 'https://example.com/x', [g1]);

      const before = await count(env,
        'SELECT COUNT(*) AS n FROM notification_groups WHERE notification_id = ?', ch.id);
      const gone = await deleteChannel(env, ch.id);
      const after = await count(env,
        'SELECT COUNT(*) AS n FROM notification_groups WHERE notification_id = ?', ch.id);

      return json({ before, after, gone, remainingChannels: (await list(env)).length });
    }

    if (p === '/delete-group') {
      reset(); await clean(env);
      const g1 = await createGroup(env, { name: 'G1' });
      const ch = await mk(env, 'ops', 'https://example.com/x', [g1]);

      const read = async () => {
        const viaStorage = (await loadChannels(env)).find((c) => c.id === ch.id).group_ids;
        const viaApi = (await list(env)).find((c) => c.id === ch.id).group_ids;
        return { viaStorage, viaApi };
      };

      const before = await read();
      const gone = await deleteGroup(env, g1);
      const after = await read();
      const rows = await count(env,
        'SELECT COUNT(*) AS n FROM notification_groups WHERE group_id = ?', g1);

      return json({ before, after, rows, gone, channelSurvived: (await list(env)).length });
    }

    return json({ error: 'unknown route: ' + p }, 404);
  },
};
`;

async function harness() {
  const built = await build({
    stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
    target: 'es2022',
    logLevel: 'error',
    // Workers-only module, reached through notify.ts -> checks.ts -> check/tcp.ts.
    // The same stub notify.test.mjs uses, and the connect path is never run.
    // 仅供 Workers 的模块经 notify.ts -> checks.ts -> check/tcp.ts 到达；
    // 使用 notify.test.mjs 相同的替身，connect 路径不会执行。
    plugins: [
      {
        name: 'stub-sockets',
        setup(b) {
          b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'stub' }));
          b.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'pgstub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: 'export const connect = () => { throw new Error("no sockets"); };',
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
    d1Databases: { DB: 'notify-scope-test' },
  });

  // Every migration in filename order, so 0010's table and index are exercised
  // as they ship rather than as a copy - including the fact that it is entirely
  // repeatable, which is what lets the loop below apply it the same way as the
  // files that are not.
  // 按文件名顺序应用所有迁移，使 0010 的表和索引按实际发布内容接受测试；
  // 它可重复执行，因此下方循环可像处理其他文件一样处理它。
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);

  return mf;
}

// --- tiny assertion runner -------------------------------------------------
// 简易断言执行器 / Tiny assertion runner

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
}

function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
}

const mf = await harness();
const origin = 'http://localhost';
const call = async (path) => {
  const res = await mf.dispatchFetch(`${origin}${path}`);
  if (res.status !== 200) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
};

// --- 1. the rule, as a pure function ---------------------------------------
// 1. 纯函数规则 / The rule as a pure function

console.log('\nscopeMatches: empty means everything, non-empty means membership\n');
{
  const r = await call('/scope-matches');

  check('an empty scope matches a grouped event', r.emptyGrouped === true, r.emptyGrouped);
  // The guarantee: a monitor in no group is still received by a channel that
  // named no group. Reading the empty array as an empty set breaks this one.
  // 保证未分组监控仍由无范围渠道接收；若将空数组解释为空集合，此保证会失效。
  check('an empty scope matches an ungrouped event', r.emptyUngrouped === true, r.emptyUngrouped);
  check('an empty scope matches an event that never set the field', r.emptyAbsent === true, r.emptyAbsent);

  check('a scope matches its own group', r.own === true, r.own);
  check('a scope does not match another group', r.other === false, r.other);
  check('a scope matches the second of two groups', r.secondOfTwo === true, r.secondOfTwo);

  // The gap, asserted rather than assumed: an ungrouped monitor belongs to none
  // of the groups a scoped channel named, so it is not a member of any of them.
  // 显式断言缺口：未分组监控不属于限定范围渠道指定的任何分组。
  check('a scope does not match an ungrouped event', r.ungroupedIsNotAMember === false, r.ungroupedIsNotAMember);
  check('a scope does not match an event that never set the field', r.absentIsNotAMember === false, r.absentIsNotAMember);
}

// --- 2. dispatch actually filters ------------------------------------------
// 2. 验证 dispatch 实际过滤 / Verify dispatch filtering

console.log('\ndispatch routes by scope\n');
{
  const r = await call('/dispatch-two-channels');

  eq(
    'group A reaches the scoped channel and the unscoped one',
    r.forA,
    ['https://example.com/a', 'https://example.com/all'],
  );
  eq('group B reaches only the unscoped channel', r.forB, ['https://example.com/all']);
  eq('an ungrouped monitor reaches only the unscoped channel', r.forUngrouped, ['https://example.com/all']);
}

// --- 3. the ungrouped gap ---------------------------------------------------
// 3. 未分组缺口 / Ungrouped gap

console.log('\nan ungrouped monitor with every channel scoped notifies nobody\n');
{
  const r = await call('/dispatch-all-scoped-ungrouped');

  // The gap. Not a bug being reported - a consequence of scoping that is
  // deliberately not papered over, and this is where it is written down. The
  // console warns before the operator saves a configuration that does this.
  // 这是作用范围的已知结果而非报告中的缺陷；控制台会在保存此类配置前警告操作员。
  eq('no send happens at all', r.urls, []);
  eq('and one unmatched line is logged, one per event', r.unmatched.length, 1);
  check('the line names the monitor and its (absent) group', r.unmatched[0].monitor === 'prod site' && r.unmatched[0].group === null, r.unmatched[0]);
  check('and says how many channels declined it', r.unmatched[0].channels === 2, r.unmatched[0]);
}

// --- 4. default scope through the API ----------------------------
// 4. 经 API 验证默认范围 / Default scope through the API

console.log('\na channel created without group_ids receives everything\n');
{
  const r = await call('/api-default-scope');

  check('POST /api/notifications is 201', r.status === 201, r.status);
  eq('the stored scope is empty', r.group_ids, []);
  eq(
    'a duplicate transition is delivered only once',
    r.urls,
    ['https://example.com/everyone'],
  );
}

// --- 5. undefined / [] / non-empty on PUT ----------------------------------
// 5. PUT 的 undefined、空数组和非空数组 / PUT distinctions

console.log('\nPUT: omitted leaves the scope, [] clears it, a list replaces it\n');
{
  const r = await call('/api-put-scope');

  eq('POST stores the scope it was given', r.created, [r.g1]);
  eq('a PUT that omits group_ids leaves the scope alone', r.afterRename, [r.g1]);
  eq('PUT group_ids: [] clears it', r.afterClear, []);
  eq('PUT group_ids: [g2] replaces it', r.afterReplace, [r.g2]);
  eq('and omitting it again still leaves it alone', r.afterOmitAgain, [r.g2]);
}

// --- 6. an unknown group id -------------------------------------------------
// 6. 未知分组 ID / Unknown group ID

console.log('\nan unknown group id is refused before anything is written\n');
{
  const r = await call('/api-bad-group');

  check('an unknown group id on create is 400', r.createStatus === 400, r.createStatus);
  eq('and reports group_not_found', r.createdBody.error, 'group_not_found');
  eq('with no channel left behind', r.afterCreate, 0);

  check('an unknown group id on update is 400', r.updateStatus === 400, r.updateStatus);
  eq('and reports group_not_found', r.updatedBody.error, 'group_not_found');
  // The refusal has to be answerable *without* having changed anything, or a
  // typo in the picker would silently unscop the channel it failed to save. The
  // scope has to still be the group, not merely non-empty.
  // 拒绝必须不产生变更，否则选择器中的笔误会悄悄清空未能保存的渠道范围；
  // 范围必须仍是原分组，不能只断言非空。
  eq('and the stored scope is untouched', r.storedAfter, [r.g1]);

  eq('a group_ids that is not an array is refused too', r.notAnArrayBody.error, 'group_not_found');
  eq('and is 400', r.notAnArrayStatus, 400);
}

// --- 7. deleting a channel takes its scope with it -------------------------
// 7. 删除渠道时删除其范围 / Deleting a channel removes its scope

console.log('\ndeleting a channel removes its notification_groups rows\n');
{
  const r = await call('/delete-channel');

  eq('the scope row exists beforehand', r.before, 1);
  check('DELETE reports the channel existed', r.gone === true, r.gone);
  eq('its scope rows are gone with it', r.after, 0);
  eq('and no channel is left', r.remainingChannels, 0);
}

// --- 8. deleting a group takes its scopes with it --------------------------
// 8. 删除分组时删除其范围 / Deleting a group removes its scopes

console.log('\ndeleting a group removes it from every channel that was scoped to it\n');
{
  const r = await call('/delete-group');

  eq('the channel is scoped to the group beforehand', r.before.viaStorage.length, 1);
  eq('and the scope reads the same through the API', r.before.viaApi, r.before.viaStorage);

  check('DELETE reports the group existed', r.gone === true, r.gone);

  /**
   * The sharpest edge. A row left here would name a group that no longer
   * exists: the channel would still read as scoped, the picker could not draw a
   * name for the id, and the id would match no monitor's `group_id` again - so
   * the only symptom would be alerts that stopped arriving.
   * 最棘手的边界：若留下指向已删除分组的行，渠道仍会显示为受限，选择器无法显示该 ID 的名称，
   * 也不会再匹配任何监控的 group_id；唯一症状可能是告警不再到达。
   */
  eq('its rows are gone', r.rows, 0);
  eq('the scope no longer contains it', r.after.viaStorage, []);
  eq('and neither does the scope the API returns', r.after.viaApi, []);
  // The channel is unscoped, not deleted - the same "a label is not its
  // contents" rule deleting a group already followed for monitors.
  // 渠道变为无范围而非被删除；与删除分组时保留其中监控的规则一致，标签不是内容本身。
  eq('and the channel itself survives', r.channelSurvived, 1);
}

console.log('\noutbox retries only the failed channel and uses an atomic lease\n');
{
  const r = await call('/outbox-retry');
  check('agent rules route only to matching group channels', r.firstSend.length >= 2 && r.firstSend.every(url => url === 'https://example.com/delivered' || url === 'https://example.com/retry'));
  eq('same-timestamp rule events keep unique keys through ordered retry', r.successful, 4);
  eq('successful replay clears that channel row', r.pending, 0);
}
{
  const r = await call('/outbox-inflight-race');
  eq('retry sees the first send lease and does not race it', r.duringSend, ['https://example.com/race']);
  eq('in-flight delivery is sent once', r.total, ['https://example.com/race']);
}

await mf.dispose();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
