/* 检查 SQL 方言与参数占位符；本文件不连接 PostgreSQL。
 * Check SQL dialects and placeholders without connecting to PostgreSQL. */
import { pgPlaceholders, placeholderFor } from '../../backends/worker/src/lib/db/sql/dialect.ts';
import { monitorSQL } from '../../backends/worker/src/lib/db/sql/monitors.ts';
import { liveStateSQL } from '../../backends/worker/src/lib/db/sql/live-state.ts';
import { authSQL } from '../../backends/worker/src/lib/db/sql/auth.ts';
import { eventsSQL } from '../../backends/worker/src/lib/db/sql/events.ts';
import { groupSQL } from '../../backends/worker/src/lib/db/sql/groups.ts';
import { heartbeatSQL } from '../../backends/worker/src/lib/db/sql/heartbeat.ts';
import { notificationSQL } from '../../backends/worker/src/lib/db/sql/notifications.ts';
import { tagSQL } from '../../backends/worker/src/lib/db/sql/tags.ts';
import { agentLiveSQL, agentHistorySQL } from '../../backends/worker/src/lib/db/sql/agent.ts';
import { PostgresAdapter } from '../../backends/worker/src/lib/db/postgres.ts';
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0;
let fail = 0;

function ok(label, cond) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
}
function eq(label, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  same ? pass++ : fail++;
  console.log(`  ${same ? 'PASS' : 'FAIL'}  ${label}`);
  if (!same) {
    console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
  }
}

console.log('\npgPlaceholders');
eq('empty', pgPlaceholders(''), '');
eq('one', pgPlaceholders('?'), '$1');
eq('three', pgPlaceholders('?,?,?'), '$1,$2,$3');
eq('ten', pgPlaceholders(Array(10).fill('?').join(',')),
  '$1,$2,$3,$4,$5,$6,$7,$8,$9,$10');

console.log('\nplaceholderFor');
eq('d1 first', placeholderFor('d1', 1), '?');
eq('d1 fifth', placeholderFor('d1', 5), '?');
eq('pg first', placeholderFor('postgres', 1), '$1');
eq('pg fifth', placeholderFor('postgres', 5), '$5');
eq('pg tenth', placeholderFor('postgres', 10), '$10');

console.log('\nSQL maps: same keys across backends');

{
  const migration = '0002_agent_aggregate_availability.postgres.sql';
  const discovered = readdirSync('database/schema/postgres').filter((file) => file.endsWith('.postgres.sql')).sort();
  ok('aggregate availability migration is discoverable by the PG runner', discovered.includes(migration));
  const sql = readFileSync(`database/schema/postgres/${migration}`, 'utf8');
  ok('PG migration adds daily availability and aggregate coverage fields',
    sql.includes('agent_uptime_daily') && sql.includes('network_duration_sec'));
}

function checkMapKeys(label, map) {
  const backends = ['d1', 'postgres'];
  const keySets = backends.map((b) => new Set(Object.keys(map[b])));
  const [first, ...rest] = keySets;
  const allSame = rest.every((s) => {
    if (s.size !== first.size) return false;
    for (const k of first) if (!s.has(k)) return false;
    return true;
  });
  ok(`${label}: all backends expose the same keys`, allSame);
}

checkMapKeys('monitorSQL', monitorSQL);
checkMapKeys('liveStateSQL', liveStateSQL);
checkMapKeys('authSQL', authSQL);
checkMapKeys('eventsSQL', eventsSQL);
checkMapKeys('groupSQL', groupSQL);
checkMapKeys('heartbeatSQL', heartbeatSQL);
checkMapKeys('notificationSQL', notificationSQL);
checkMapKeys('tagSQL', tagSQL);
checkMapKeys('agentLiveSQL', agentLiveSQL);
checkMapKeys('agentHistorySQL', agentHistorySQL);

ok('Postgres agent daily keys use UTC explicitly',
  agentLiveSQL.postgres.recordAvailability.includes("AT TIME ZONE 'UTC'") &&
  agentLiveSQL.postgres.dailyAvailability.includes("AT TIME ZONE 'UTC'") &&
  agentLiveSQL.postgres.deleteOldAvailability.includes("AT TIME ZONE 'UTC'"));

console.log('\nSQL maps: no cross-dialect placeholder leakage');

function sampleStrings(map, dialect) {
  const out = [];
  for (const v of Object.values(map)) {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') {
      // Generators take a placeholder string or (for updateById) a SET
      // clause in the caller's dialect. Sample each backend with its own
      // convention so a dialect-correct caller would pass these shapes.
      // 生成器接收占位符字符串，updateById 则接收调用方方言的 SET 子句；
      // 按各后端惯例取样，使输入符合该方言调用方传入的形式。
      const sample = dialect === 'postgres' ? '$1,$2' : '?,?';
      try {
        out.push(v(sample));
      } catch {
        // Some generators (e.g. two-arg updateById) accept optional extras;
        // single-arg sampling is enough for leak detection.
        // 部分生成器（如双参数 updateById）有可选参数；单参数取样足以检测占位符泄漏。
        out.push(v(sample));
      }
    }
  }
  return out;
}

function checkNoQMarkInPg(label, map) {
  const leaks = sampleStrings(map.postgres, 'postgres').filter((s) => s.includes('?'));
  ok(`${label}: PG statements contain no '?'`, leaks.length === 0);
  if (leaks.length) console.log(`        leaks: ${JSON.stringify(leaks)}`);
}
function checkNoDollarInD1(label, map) {
  const leaks = sampleStrings(map.d1, 'd1').filter((s) => /\$\d/.test(s));
  ok(`${label}: D1 statements contain no $n`, leaks.length === 0);
  if (leaks.length) console.log(`        leaks: ${JSON.stringify(leaks)}`);
}

for (const [label, map] of [
  ['monitorSQL', monitorSQL],
  ['liveStateSQL', liveStateSQL],
  ['authSQL', authSQL],
  ['eventsSQL', eventsSQL],
  ['groupSQL', groupSQL],
  ['heartbeatSQL', heartbeatSQL],
  ['notificationSQL', notificationSQL],
  ['tagSQL', tagSQL],
  ['agentLiveSQL', agentLiveSQL],
  ['agentHistorySQL', agentHistorySQL],
]) {
  checkNoQMarkInPg(label, map);
  checkNoDollarInD1(label, map);
}

console.log('\nSQL maps: no empty placeholder strings on PG');
function checkNoEmptyOnPg(label, map) {
  const bad = [];
  for (const [k, v] of Object.entries(map.postgres)) {
    if (typeof v === 'string' && v === '') bad.push(k);
    if (typeof v === 'function' && v('?,?') === '') bad.push(k);
  }
  ok(`${label}: no empty pg strings`, bad.length === 0);
  if (bad.length) console.log(`        empty: ${bad.join(', ')}`);
}
for (const [label, map] of [
  ['monitorSQL', monitorSQL],
  ['liveStateSQL', liveStateSQL],
  ['authSQL', authSQL],
  ['eventsSQL', eventsSQL],
  ['groupSQL', groupSQL],
  ['heartbeatSQL', heartbeatSQL],
  ['notificationSQL', notificationSQL],
  ['tagSQL', tagSQL],
  ['agentLiveSQL', agentLiveSQL],
  ['agentHistorySQL', agentHistorySQL],
]) checkNoEmptyOnPg(label, map);

console.log('\nPostgresAdapter construction');
{
  const a = new PostgresAdapter('postgres://u:p@localhost:5432/db');
  eq('adapter type', a.type, 'postgres');
  ok('close is a function', typeof a.close === 'function');
  await a.close();
}

console.log('\nfactory chooses adapter based on env');
const { getDB } = await import('../../backends/worker/src/lib/db/factory.ts');
{
  const d1ish = {};
  const fakeD1 = {
    prepare: () => ({ bind: () => ({ all: async () => ({}) }) }),
  };
  const d1 = getDB({ DB: fakeD1 });
  eq('default (no DATABASE_TYPE) resolves to d1', d1.type, 'd1');
  const d2 = getDB({ DB: fakeD1, DATABASE_TYPE: 'd1' });
  eq('explicit d1', d2.type, 'd1');
  const pg = getDB({
    DB: fakeD1,
    DATABASE_TYPE: 'postgres',
    DATABASE_URL: 'postgres://u:p@localhost/db',
  });
  eq('postgres when asked', pg.type, 'postgres');
  await pg.close();

  let threw = false;
  try {
    getDB({ DB: fakeD1, DATABASE_TYPE: 'postgres' });
  } catch (e) {
    threw = true;
    ok('missing DATABASE_URL error mentions it',
      String(e).includes('DATABASE_URL'));
  }
  ok('missing DATABASE_URL throws', threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
