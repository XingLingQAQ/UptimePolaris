import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
/* 通过实际 API 和 D1 验证分组删除、标签关联与公开凭据脱敏。
 * Use the API and D1 to check group deletion, tag associations, and public credential redaction. */
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';

const ADMIN_TOKEN = 'test-admin-token';

/* 直接测试实际 API 的挂载与认证顺序。
 * Exercise the actual API mounting and authentication order. */
const HARNESS = `
export { default } from './backends/worker/src/index.ts';
`;

async function harness() {
  const built = await build({
    stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
    target: 'es2022',
    logLevel: 'error',
    // Workers-only module, reached through checks.ts. The connect path is never
    // run here; the stub is what lets the bundle resolve at all.
    // 仅供 Workers 的模块经 checks.ts 到达；此处不会执行 connect，替身让打包器能够解析依赖。
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
    bindings: {
      CF_ACCOUNT_ID: 'test-account',
      CF_API_TOKEN: 'test-api-token',
      // Set, so "these routes need a session" is a statement about the gate
      // rather than about a deployment that happens to have no token.
      // 设置令牌，确保“路由需要会话”验证的是门禁，而非部署恰好没有令牌。
      ADMIN_TOKEN,
    },
    d1Databases: { DB: 'groups-tags-test' },
    analyticsEngineDatasets: { UPTIME: { dataset: 'uptime_heartbeats' } },
  });

  // Apply all migrations in filename order; split statements manually for miniflare. / 按文件名应用迁移；为 miniflare 手动拆分语句。
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);

  // Complete real setup first; later requests keep testing bearer authentication without cookies.
  // 功能夹具先走真实初始化入口，随后仍以无 Cookie 请求测试令牌鉴权。
  const setup = await mf.dispatchFetch('http://localhost/api/auth/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: ADMIN_TOKEN, username: 'fixture-owner', password: 'fixture-owner-secret' }),
  });
  if (setup.status !== 200) throw new Error(`fixture setup failed: ${setup.status} ${await setup.text()}`);

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
const authed = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };

const req = (path, init) => mf.dispatchFetch(origin + path, init);
const send = (path, body, method = 'POST') =>
  req(path, { method, headers: authed, body: JSON.stringify(body) });

/** A JSON call, asserting the status so a failure is reported where it happened. / JSON 请求并断言状态，使失败在发生处报告。 */
async function json(path, init) {
  const res = await req(path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

/** Create a monitor; the returned id is the UUID everything else is keyed by. / 创建监控；返回的 UUID 是其他数据使用的键。 */
async function makeMonitor(body) {
  const res = await send('/api/monitors', body);
  const text = await res.text();
  if (res.status !== 201) throw new Error(`create monitor -> ${res.status}: ${text}`);
  return JSON.parse(text).id;
}

const monitors = () => json('/api/monitors', { headers: authed }).then((r) => r.monitors);
const findMonitor = async (id) => (await monitors()).find((m) => m.id === id);

// ------------------------------------------------------------------ 1. CRUD
// 1. 增删改查 / CRUD

console.log('\na group can be created, listed, renamed, reordered and deleted\n');
{
  const created = await send('/api/groups', { name: 'Production' });
  check('POST /api/groups is 201', created.status === 201, created.status);
  const { id } = await created.json();

  const listed = await json('/api/groups', { headers: authed });
  check(
    'GET /api/groups returns it, with the default weight',
    listed.groups.length === 1 && listed.groups[0].id === id && listed.groups[0].weight === 0,
    listed.groups,
  );

  const renamed = await send(`/api/groups/${id}`, { name: 'Prod', weight: -5 }, 'PUT');
  check('PUT /api/groups/:id is 200', renamed.status === 200, renamed.status);

  const after = (await json('/api/groups', { headers: authed })).groups[0];
  eq('the rename and the reorder both stuck', [after.name, after.weight], ['Prod', -5]);

  // A second group, to prove the ordering is by weight and not by insertion.
  // 创建第二个分组，证明按权重而非插入顺序排序。
  const { id: second } = await (await send('/api/groups', { name: 'Staging', weight: 10 })).json();
  const ordered = (await json('/api/groups', { headers: authed })).groups.map((g) => g.name);
  eq('groups are listed by weight', ordered, ['Prod', 'Staging']);

  const del = await req(`/api/groups/${id}`, { method: 'DELETE', headers: authed });
  check('DELETE /api/groups/:id is 200', del.status === 200, del.status);
  const gone = await req(`/api/groups/${id}`, { method: 'DELETE', headers: authed });
  check('a second DELETE is 404', gone.status === 404, gone.status);

  await req(`/api/groups/${second}`, { method: 'DELETE', headers: authed });

  // Duplicate names are the UNIQUE index's job, and they arrive as 400 rather
  // than the 500 an unhandled constraint violation would be.
  // UNIQUE 索引负责拒绝重名，响应应为 400，而非未处理约束错误产生的 500。
  await send('/api/groups', { name: 'Dup' });
  const dup = await send('/api/groups', { name: 'Dup' });
  check('a duplicate group name is 400', dup.status === 400, dup.status);
  eq('and reports name_taken', (await dup.json()).error, 'name_taken');

  const noName = await send('/api/groups', { name: '   ' });
  eq('a blank name reports name_required', (await noName.json()).error, 'name_required');
  eq('and is 400', noName.status, 400);

  const longName = await send('/api/groups', { name: 'x'.repeat(65) });
  eq('an over-long name reports name_invalid', (await longName.json()).error, 'name_invalid');

  const badWeight = await send('/api/groups', { name: 'W', weight: 1.5 });
  eq('a fractional weight reports weight_invalid', (await badWeight.json()).error, 'weight_invalid');

  const unknown = await send('/api/groups/no-such-id', { name: 'X' }, 'PUT');
  check('PUT on an unknown group is 404', unknown.status === 404, unknown.status);

  // Cleanup for the sections below, which assert exact group lists.
  // 为下方断言精确分组列表的部分清理数据。
  const rest = (await json('/api/groups', { headers: authed })).groups;
  for (const g of rest) await req(`/api/groups/${g.id}`, { method: 'DELETE', headers: authed });
}

// ------------------------------------------ 2. deleting a group ungroups
// 2. 删除分组后监控变为未分组 / Deleting a group ungroups monitors

console.log('\ndeleting a group ungroups its monitors rather than deleting them\n');
{
  const { id: groupId } = await (await send('/api/groups', { name: 'Doomed' })).json();

  const inGroup = await makeMonitor({
    name: 'grouped',
    type: 'http',
    target: 'https://example.com',
    group_id: groupId,
  });

  // The premise: the monitor really is in the group, so the assertion after the
  // delete is about the delete and not about a group_id that never stored.
  // 确认前提：监控确实位于分组中，使删除后的断言验证删除本身，而非从未存储的 group_id。
  eq('the monitor is in the group before the delete', (await findMonitor(inGroup)).group_id, groupId);

  const del = await req(`/api/groups/${groupId}`, { method: 'DELETE', headers: authed });
  check('DELETE /api/groups/:id is 200', del.status === 200, del.status);

  /** A cascade would delete monitors with the label; groups never do that. / 级联会连监控一起删；分组不会。 */
  const survivor = await findMonitor(inGroup);
  check('the monitor still exists', survivor !== undefined);
  eq('and is ungrouped rather than deleted', survivor?.group_id, null);

  // And at the SQL level, not just through the API's own filter.
  // 在 SQL 层也验证，而非仅经 API 自身过滤。
  const row = await (await mf.getD1Database('DB'))
    .prepare('SELECT group_id FROM monitors WHERE id = ?')
    .bind(inGroup)
    .first();
  eq('the stored column is NULL', row.group_id, null);

  await req(`/api/monitors/${inGroup}`, { method: 'DELETE', headers: authed });
}

// --------------------------------------------------- 3. deleting a tag
// 3. 删除标签 / Deleting a tag

console.log('\ndeleting a tag removes its join rows and keeps the monitors\n');
{
  const db = await mf.getD1Database('DB');

  const { id: tagId } = await (await send('/api/tags', { name: 'critical', color: '#FF0000' })).json();
  const monitorId = await makeMonitor({
    name: 'tagged',
    type: 'http',
    target: 'https://example.com',
    tag_ids: [tagId],
  });

  const before = await db
    .prepare('SELECT COUNT(*) AS n FROM monitor_tags WHERE tag_id = ?')
    .bind(tagId)
    .first();
  eq('the join row exists', before.n, 1);

  const del = await req(`/api/tags/${tagId}`, { method: 'DELETE', headers: authed });
  check('DELETE /api/tags/:id is 200', del.status === 200, del.status);

  const after = await db
    .prepare('SELECT COUNT(*) AS n FROM monitor_tags WHERE tag_id = ?')
    .bind(tagId)
    .first();
  eq('its join rows are gone', after.n, 0);

  const survivor = await findMonitor(monitorId);
  check('the monitor it labelled still exists', survivor !== undefined);
  eq('with no tags left', survivor?.tags, []);

  await req(`/api/monitors/${monitorId}`, { method: 'DELETE', headers: authed });
}

// ------------------------- 4 & 5. a monitor with a group and tags, and refs
// 4、5. 带分组和标签的监控及引用 / Monitor group, tags, and references

console.log('\na monitor can carry a group and tags, and unknown references are refused\n');
{
  const { id: groupId } = await (await send('/api/groups', { name: 'Web', weight: 1 })).json();
  const { id: tagA } = await (await send('/api/tags', { name: 'prod', color: '#00AA55' })).json();
  const { id: tagB } = await (await send('/api/tags', { name: 'edge' })).json();

  const monitorId = await makeMonitor({
    name: 'with-labels',
    type: 'http',
    target: 'https://example.com',
    group_id: groupId,
    tag_ids: [tagA, tagB],
  });

  const row = await findMonitor(monitorId);
  eq('GET /api/monitors returns the group_id', row?.group_id, groupId);
  eq(
    'and both tags, with the name and colour the chip draws',
    row?.tags.map((t) => ({ name: t.name, color: t.color })).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'edge', color: '#006FEE' },
      { name: 'prod', color: '#00AA55' },
    ],
  );

  /* tag_id 为可回传的标签 UUID；关联行 id 和 monitor_id 仍为整数。
   * tag_id is the tag UUID accepted on writes; association id and monitor_id remain integers. */
  const tagIds = (await json('/api/tags', { headers: authed })).tags.map((t) => t.id);
  const tagNames = row.tags.map((t) => t.name).sort();
  eq('tags come back sorted by name', tagNames, ['edge', 'prod']);
  check(
    'tag_id is the tag UUID, which is what the console sends back as tag_ids',
    row.tags.every((t) => typeof t.tag_id === 'string' && tagIds.includes(t.tag_id)),
    row.tags.map((t) => t.tag_id),
  );
  check('id is the join row integer the status page keys by', row.tags.every((t) => typeof t.id === 'number'), row.tags);
  check('monitor_id is the monitor integer id', row.tags.every((t) => typeof t.monitor_id === 'number'), row.tags);
  eq('and matches the monitor num_id', row.tags[0]?.monitor_id, row.num_id);

  // Round-trip the console flow: read tags, map with `tagKey`, send back. / 往返验证控制台流程：读标签、用 `tagKey` 映射、再提交。
  const roundTripped = row.tags.map((t) => String(t.tag_id ?? t.id));
  await send(`/api/monitors/${monitorId}`, { tag_ids: roundTripped }, 'PUT');
  eq(
    'the set the console would send back is accepted unchanged',
    (await findMonitor(monitorId))?.tags.map((t) => t.name).sort(),
    tagNames,
  );

  // A duplicate in the array is the same intent expressed twice, so it is
  // accepted and stored once rather than aborting the batch on the join table's
  // primary key.
  // 数组重复项表示同一意图，因此接受并只存一次，而非因关联表主键中止批次。
  await send(`/api/monitors/${monitorId}`, { tag_ids: [tagA, tagA] }, 'PUT');
  eq('a repeated tag id is stored once', (await findMonitor(monitorId))?.tags.length, 1);

  /** Substitute for the missing foreign key on `monitors.group_id`. / 替代 `monitors.group_id` 缺失的外键。 */
  const dangling = await send('/api/monitors', {
    name: 'dangling',
    type: 'http',
    target: 'https://example.com',
    group_id: 'no-such-group',
  });
  check('an unknown group_id on POST is 400', dangling.status === 400, dangling.status);
  eq('and reports group_not_found', (await dangling.json()).error, 'group_not_found');

  const danglingPut = await send(`/api/monitors/${monitorId}`, { group_id: 'no-such-group' }, 'PUT');
  eq('an unknown group_id on PUT reports group_not_found', (await danglingPut.json()).error, 'group_not_found');

  const danglingTag = await send('/api/monitors', {
    name: 'bad-tag',
    type: 'http',
    target: 'https://example.com',
    tag_ids: ['no-such-tag'],
  });
  eq('an unknown tag id reports tag_not_found', (await danglingTag.json()).error, 'tag_not_found');
  eq('and is 400', danglingTag.status, 400);

  // A refused create leaves nothing behind: the count is what proves the checks
  // run *before* the INSERT rather than after it.
  // 被拒绝的创建不留下数据；通过行数证明检查发生在 INSERT 之前。
  const names = (await monitors()).map((m) => m.name);
  check('no row was created by either refused request', !names.includes('dangling') && !names.includes('bad-tag'), names);

  // The partial semantics the rest of the PUT has: an omitted field is left
  // alone, and an explicit null is how a monitor leaves its group.
  // 与其他 PUT 一样采用部分更新：省略字段保持原值，显式 null 使监控离开分组。
  await send(`/api/monitors/${monitorId}`, { name: 'renamed-only' }, 'PUT');
  const kept = await findMonitor(monitorId);
  eq('a PUT that omits group_id leaves it', kept?.group_id, groupId);
  eq('and leaves the tags', kept?.tags.length, 1);

  await send(`/api/monitors/${monitorId}`, { group_id: null }, 'PUT');
  eq('an explicit null clears the group', (await findMonitor(monitorId))?.group_id, null);

  // The tag routes' own validation.
  // 标签路由自身的校验。
  const badColor = await send('/api/tags', { name: 'nope', color: 'red' });
  eq('a colour that is not #RRGGBB reports color_invalid', (await badColor.json()).error, 'color_invalid');
  const shortColor = await send('/api/tags', { name: 'nope2', color: '#abc' });
  eq('three-digit shorthand is refused too', (await shortColor.json()).error, 'color_invalid');
  const dupTag = await send('/api/tags', { name: 'prod' });
  eq('a duplicate tag name reports name_taken', (await dupTag.json()).error, 'name_taken');

  const tagUnknown = await send('/api/tags/no-such-id', { name: 'x' }, 'PUT');
  check('PUT on an unknown tag is 404', tagUnknown.status === 404, tagUnknown.status);

  // Leave a clean, known set for the UI sections below.
  // 为下方界面测试留下干净且已知的数据集合。
  for (const m of await monitors()) {
    await req(`/api/monitors/${m.id}`, { method: 'DELETE', headers: authed });
  }
}

// ------------------------------------------------------ 6 & 7. the status page
// 6、7. 状态页 / Status page

console.log('\n/api/public/monitors: real groups, ordered, with tags attached\n');
{
  const { id: heavy } = await (await send('/api/groups', { name: 'Later', weight: 50 })).json();
  const { id: light } = await (await send('/api/groups', { name: 'First', weight: 1 })).json();
  const { id: tagId } = await (await send('/api/tags', { name: 'chip', color: '#123456' })).json();

  await makeMonitor({ name: 'in-later', type: 'http', target: 'https://example.com', group_id: heavy });
  await makeMonitor({
    name: 'in-first',
    type: 'http',
    target: 'https://example.com',
    group_id: light,
    tag_ids: [tagId],
  });
  await makeMonitor({ name: 'nowhere', type: 'http', target: 'https://example.com' });

  const ui = await json('/api/public/monitors');

  check('more than one group comes back', ui.monitorGroups.length > 2, ui.monitorGroups.map((g) => g.name));

  const names = ui.monitorGroups.map((g) => g.name);
  eq('ordered by weight, ungrouped last', names, ['First', 'Later', null]);

  const first = ui.monitorGroups.find((g) => g.name === 'First');
  eq('the group holds its own monitor', first.monitorList.map((m) => m.name), ['in-first']);

  // Ungrouped monitors use a synthetic bucket; the Worker sends a flag, not a localized name. / 未分组监控使用合成桶；Worker 传标志，不传本地化名称。
  const rest = ui.monitorGroups.find((g) => g.isUngrouped);
  eq('ungrouped monitors still appear', rest.monitorList.map((m) => m.name), ['nowhere']);
  eq('the ungrouped bucket has no server-side label', rest.name, null);
  check(
    'and no group name contains a CJK literal',
    ui.monitorGroups.every((g) => g.name === null || !/[\u4e00-\u9fff]/.test(g.name)),
    names,
  );
  check(
    'exactly one bucket is flagged ungrouped',
    ui.monitorGroups.filter((g) => g.isUngrouped === true).length === 1,
    ui.monitorGroups.map((g) => [g.name, g.isUngrouped]),
  );
  check(
    'a real group is never flagged ungrouped',
    ui.monitorGroups.filter((g) => g.name !== null).every((g) => !g.isUngrouped),
    ui.monitorGroups.map((g) => [g.name, g.isUngrouped]),
  );

  // The status page keys tags by id and displays their name and color.
  // 状态页使用 id 作为标签 key，显示名称和颜色。
  const tagged = first.monitorList[0];
  check('the tagged monitor carries its tag', tagged.tags.length === 1, tagged.tags);
  eq('with the name', tagged.tags[0]?.name, 'chip');
  eq('and the colour', tagged.tags[0]?.color, '#123456');
  eq('and a numeric join id, which is what the UI keys by', typeof tagged.tags[0]?.id, 'number');
  eq('and a numeric monitor_id', typeof tagged.tags[0]?.monitor_id, 'number');
  const untagged = rest.monitorList[0];
  eq('a monitor with no tags carries an empty array', untagged.tags, []);

  // `config.showTags` gates the whole chip row on the status page, so a false
  // value would attach the tags above and then hide them.
  // config.showTags 控制状态页整行标签；false 会附加上述标签后将其隐藏。
  const config = await json('/api/public/config');
  eq('showTags is on, or the tags above are never drawn', config.config.showTags, true);
}

// ------------------------------- 8. the credential must not reach a public page
// 8. 凭据不得到达公开页面 / Credentials must not reach a public page

console.log('\nno public endpoint leaks push_token\n');
{
  const monitorId = await makeMonitor({ name: 'pushed', type: 'push' });

  /** Read the token from the database so the assertion covers what was stored. / 从数据库读取 Token，断言覆盖实际存储值。 */
  const db = await mf.getD1Database('DB');
  const stored = await db
    .prepare('SELECT push_token FROM monitors WHERE id = ?')
    .bind(monitorId)
    .first();
  check('the push monitor really has a token', typeof stored.push_token === 'string' && stored.push_token.length > 0, stored);

  const token = stored.push_token;

  /** Search the whole serialized body for the token, not one field. / 在整个序列化正文中搜索 Token，而不只查一个字段。 */
  const statusText = await (await req('/api/public/status')).text();
  check('push_token is absent from /api/public/status', !statusText.includes(token), statusText.slice(0, 200));
  check('/api/public/status still describes the monitor', statusText.includes('pushed'));

  const uiText = await (await req('/api/public/monitors')).text();
  check('push_token is absent from /api/public/monitors', !uiText.includes(token), uiText.slice(0, 200));
  check('/api/public/monitors still describes the monitor', uiText.includes('pushed'));

  // Control: the authenticated listing is supposed to carry it. / 对照：认证后的列表本应包含它。
  const adminText = await (await req('/api/monitors', { headers: authed })).text();
  check('the authenticated listing does carry it, by design', adminText.includes(token));

  /** Public status exposes group and tags because the page renders them. / 公开状态接口会返回分组和标签，因为页面要渲染。 */
  const status = await (await req('/api/public/status')).json();
  const pushed = status.monitors.find((m) => m.name === 'pushed');
  check('the status row carries a group field', 'group' in pushed, Object.keys(pushed));
  eq('an ungrouped monitor carries no server-side label', pushed.group, null);
  eq('and says so explicitly, so a client need not infer it from null', pushed.is_ungrouped, true);
  eq('and a tags array', pushed.tags, []);

  await req(`/api/monitors/${monitorId}`, { method: 'DELETE', headers: authed });
}

// ------------------------------------------- 9. deleting a monitor untags it
// 9. 删除监控时解除标签 / Deleting a monitor removes its tags

console.log('\ndeleting a monitor removes its monitor_tags rows\n');
{
  const db = await mf.getD1Database('DB');
  const { id: tagId } = await (await send('/api/tags', { name: 'doomed', color: '#ABCDEF' })).json();
  const monitorId = await makeMonitor({
    name: 'to-delete',
    type: 'http',
    target: 'https://example.com',
    tag_ids: [tagId],
  });

  const before = await db
    .prepare('SELECT COUNT(*) AS n FROM monitor_tags WHERE monitor_id = ?')
    .bind(monitorId)
    .first();
  eq('the join row exists', before.n, 1);

  const del = await req(`/api/monitors/${monitorId}`, { method: 'DELETE', headers: authed });
  check('DELETE /api/monitors/:id is 200', del.status === 200, del.status);

  const after = await db
    .prepare('SELECT COUNT(*) AS n FROM monitor_tags WHERE monitor_id = ?')
    .bind(monitorId)
    .first();
  eq('its join rows are gone with it', after.n, 0);

  // The tag itself is untouched: deleting a monitor must not delete the label
  // other monitors may also carry.
  // 标签本身保持不变；删除监控不能删除其他监控也可能使用的标签。
  const tag = await db.prepare('SELECT COUNT(*) AS n FROM tags WHERE id = ?').bind(tagId).first();
  eq('the tag it carried survives', tag.n, 1);
}

// ----------------------------------- more monitors than one D1 statement allows
// 监控数超过单条 D1 语句限制 / More monitors than one D1 statement allows

console.log('\nloadMonitorTags batches its id list above the D1 bind limit\n');
{
  /* 用 130 个监控跨越多个查询批次，检查最后一批仍保留标签。
   * Use 130 monitors across query batches and check that the final batch retains its tags. */
  const db = await mf.getD1Database('DB');
  const { id: tagId } = await (await send('/api/tags', { name: 'bulk', color: '#654321' })).json();
  const now = Math.floor(Date.now() / 1000);
  const total = 130;
  const ids = [];
  for (let i = 0; i < total; i++) {
    const id = `bulk-monitor-${String(i).padStart(3, '0')}`;
    ids.push(id);
    await db.prepare(
      'INSERT INTO monitors (id, num_id, name, type, target, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).bind(id, 10_000 + i, `bulk ${i}`, 'http', 'https://example.com', 1, now, now).run();
    await db.prepare('INSERT INTO monitor_tags (monitor_id, tag_id) VALUES (?,?)').bind(id, tagId).run();
  }

  /** Go through `GET /api/monitors`, the read the console actually performs. / 走 `GET /api/monitors`，也就是控制台实际执行的读取。 */
  const listed = (await json('/api/monitors', { headers: authed })).monitors.filter((m) => m.id.startsWith('bulk-monitor-'));
  eq('every bulk monitor is returned', listed.length, total);
  check(
    'and every one of them carries its tag across the batch boundary',
    listed.every((m) => m.tags.length === 1 && m.tags[0].name === 'bulk'),
    listed.filter((m) => m.tags.length !== 1).map((m) => [m.id, m.tags]),
  );
  check(
    'including the last id, which only the final chunk asks about',
    listed.find((m) => m.id === ids[ids.length - 1])?.tags[0]?.tag_id === tagId,
    listed.find((m) => m.id === ids[ids.length - 1])?.tags,
  );

  /** Prove the 100-bind ceiling; without chunking this is the statement that fails. / 证明 100 绑定上限；不分块时正是这条语句失败。 */
  const placeholders = ids.map(() => '?').join(',');
  let unbatchable = false;
  try {
    await db.prepare(`SELECT monitor_id FROM monitor_tags WHERE monitor_id IN (${placeholders})`).bind(...ids).all();
  } catch (e) {
    unbatchable = /too many SQL variables/i.test(String(e));
  }
  check('one statement over 130 ids is refused by D1, so batching is required', unbatchable);

  for (const id of ids) await req(`/api/monitors/${id}`, { method: 'DELETE', headers: authed });
  await req(`/api/tags/${tagId}`, { method: 'DELETE', headers: authed });
}

// ------------------------------------------------- the routes are not public
// 路由不公开 / Routes are not public

console.log('\nthe group and tag routes sit behind the auth gate\n');
{
  /** Assert mounting order through the real api.ts, not test-only wiring. / 通过真实 api.ts 断言挂载顺序，不用测试专用接线。 */
  const read = await req('/api/groups');
  check('an unauthenticated GET /api/groups is 401', read.status === 401, read.status);

  const tags = await req('/api/tags');
  check('an unauthenticated GET /api/tags is 401', tags.status === 401, tags.status);

  const write = await req('/api/tags', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  });
  check('an unauthenticated POST /api/tags is 401', write.status === 401, write.status);

  const del = await req('/api/groups/anything', { method: 'DELETE' });
  check('an unauthenticated DELETE is 401', del.status === 401, del.status);

  // And the same paths work with the machine credential, so the 401s above are
  // about the gate and not about the routes being broken.
  // 相同路径使用机器凭据时可用，证明上面的 401 来自门禁而非路由损坏。
  const okGroups = await req('/api/groups', { headers: authed });
  check('the same GET is 200 with a token', okGroups.status === 200, okGroups.status);
}

await mf.dispose();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
