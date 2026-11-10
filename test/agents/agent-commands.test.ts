/* 验证命令准入、版本比较和 SQL 参数形状。
 * Check command gates, version comparisons, and SQL parameter shapes. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { COMMAND_ACTIONS, COMMAND_CAPABILITY, enqueueCommands, isCommandAction, supportsCommands } from '../../backends/worker/src/lib/agent/commands';
import { commandsSQL } from '../../backends/worker/src/lib/db/sql/commands';

/* 测试从仓库根目录运行；打包输出位于 artifacts/tmp。
 * Tests run from the repository root; bundled output lives in artifacts/tmp. */
const readSource = (relative: string): string => readFileSync(resolve(process.cwd(), relative), 'utf8');
const AGENT_SQL = 'backends/worker/src/lib/db/sql/agent.ts';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}`);
    throw error;
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}`);
    throw error;
  }
}

// ------------------------------------------------------------------ whitelist
// 白名单 / Whitelist

check('the whitelist is exactly the four documented actions', () => {
  assert.deepEqual([...COMMAND_ACTIONS], ['upgrade', 'restart', 're_report', 'check_update']);
});

check('only whitelisted actions are accepted', () => {
  for (const action of COMMAND_ACTIONS) assert.equal(isCommandAction(action), true, action);
});

check('check_update is accepted and still exact', () => {
  assert.equal(isCommandAction('check_update'), true);
  assert.equal(isCommandAction('check-update'), false);
  assert.equal(isCommandAction('check_update '), false);
});

check('arbitrary strings are refused', () => {
  // The whitelist has no free-form action, so console input cannot become a shell command. / 白名单没有自由动作，控制台输入不会变成 shell 命令。
  for (const bad of ['exec', 'shell', 'rm -rf /', 'UPGRADE', 'Upgrade', 'upgrade ', ' upgrade', '', 'null']) {
    assert.equal(isCommandAction(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

check('non-string actions are refused', () => {
  // A JSON body can carry any type; `{action: {toString(){...}}}` and
  // `{action: ['upgrade']}` must not slip through a loose comparison.
  // JSON 正文可携带任意类型；对象的自定义 toString 和 ['upgrade'] 不得通过宽松比较绕过检查。
  for (const bad of [null, undefined, 1, true, {}, [], ['upgrade'], { toString: () => 'upgrade' }]) {
    assert.equal(isCommandAction(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

check('prototype properties are not treated as actions', () => {
  // `['upgrade'].includes('constructor')` is false, which is the wanted
  // behaviour - this pins it so a future refactor to `in` or a Set built from
  // Object.keys cannot quietly make inherited names valid.
  // ['upgrade'].includes('constructor') 应为 false；固定此行为，防止未来改用 in 或
  // 基于 Object.keys 构造的 Set 时悄悄接受继承属性名。
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(isCommandAction(bad), false, bad);
  }
});

// ---------------------------------------------------------- capability gating
// 能力准入 / Capability gating

/* 命令准入依据机器声明的能力，不要求机器版本等于站点版本。
 * Command gates use advertised capabilities, not equality with the site version. */
check('an agent announcing the capability supports commands', () => {
  assert.equal(supportsCommands('["probe_http","probe_tcp","commands"]'), true);
  assert.equal(supportsCommands('["commands"]'), true);
});

check('an agent that does not announce it is refused', () => {
  // The shape a deployed 0.3.0 agent actually sends.
  // 已部署的 0.3.0 Agent 实际发送的格式。
  assert.equal(supportsCommands('["probe_http","probe_tcp"]'), false);
  assert.equal(supportsCommands('[]'), false);
});

check('a missing or malformed capability column fails closed', () => {
  for (const bad of [null, undefined, '', 'not json', '{}', '"commands"', '[1,2,3]']) {
    assert.equal(supportsCommands(bad as string), false, `accepted ${JSON.stringify(bad)}`);
  }
});

check('the capability name is the one the agent announces', () => {
  // Must match the literal in `build_basic_report` in agent/src/rpc/protocol.rs.
  // 必须匹配 agent/src/rpc/protocol.rs 的 build_basic_report 中的字面量。
  assert.equal(COMMAND_CAPABILITY, 'commands');
});

check('a prefix or substring does not satisfy the check', () => {
  // `includes` on the parsed array is an exact match; a version-style startsWith
  // would let "commands_v2" through, and the agent would then receive actions it
  // does not implement.
  // 对解析数组使用 includes 是精确匹配；若像版本号一样用 startsWith，会允许 commands_v2，
  // 使 Agent 收到未实现的操作。
  assert.equal(supportsCommands('["commands_v2"]'), false);
  assert.equal(supportsCommands('["xcommands"]'), false);
});

// ------------------------------------------------------------- batch loop
// 批量循环 / Batch loop

/*
  The loop must answer per id, not stop at the first refusal. A batch is an
  operator's selection, and one stale host in it must not hide the rest.
  循环必须对每个 ID 返回结果，不能在首次拒绝时停止；批次是操作员的选择，
  其中一台失联主机不应掩盖其他结果。
*/
const failingEnv = { DB: { prepare() { throw new Error('db down'); } } } as unknown as Parameters<typeof enqueueCommands>[0];

await checkAsync('a batch reports one verdict per id and does not abort', async () => {
  const results = await enqueueCommands(failingEnv, ['a', 'b', 'c'], 'check_update', null, 0);
  assert.equal(results.length, 3);
  for (const id of ['a', 'b', 'c']) {
    assert.deepEqual(results.find((r) => r.id === id), { id, ok: false, error: 'commands_disabled' });
  }
});

await checkAsync('a batch refuses an unknown action for every id', async () => {
  const results = await enqueueCommands(failingEnv, ['a', 'b'], 'exec', null, 0);
  assert.deepEqual(results, [
    { id: 'a', ok: false, error: 'unknown_action' },
    { id: 'b', ok: false, error: 'unknown_action' },
  ]);
});

// -------------------------------------------------------------- sql parity
// SQL 一致性 / SQL parity

check('both dialects extend the action CHECK with check_update', () => {
  const sqlite = readSource('database/schema/d1/0030_agent_check_update.sql');
  const pg = readSource('database/schema/postgres/0011_agent_check_update.postgres.sql');
  for (const sql of [sqlite, pg]) {
    assert.match(sql, /CHECK \(action IN \([^)]*'check_update'\)/);
    for (const action of COMMAND_ACTIONS) assert.ok(sql.includes(`'${action}'`), `${action} missing`);
  }
  // SQLite cannot amend a CHECK, so the table is rebuilt; Postgres drops and re-adds.
  // SQLite 无法修改 CHECK，因此重建表；Postgres 删除并重新添加约束。
  assert.match(sqlite, /CREATE TABLE agent_commands_new[\s\S]*INSERT INTO agent_commands_new[\s\S]*DROP TABLE agent_commands[\s\S]*RENAME TO agent_commands/);
  assert.match(pg, /DROP CONSTRAINT[\s\S]*ADD CONSTRAINT/);
  assert.match(sqlite, /CREATE INDEX IF NOT EXISTS idx_agent_commands_poll/);
});

check('every backend defines the same command statements', () => {
  const keys = Object.keys(commandsSQL.d1).sort();
  assert.deepEqual(Object.keys(commandsSQL.postgres).sort(), keys);
});

check('placeholders match each backend dialect', () => {
  const parameterless = new Set<string>([]);
  for (const [key, sql] of Object.entries(commandsSQL.d1)) {
    assert.ok(!/\$\d/.test(sql), `d1.${key} must not use $n`);
    if (!parameterless.has(key)) assert.ok(sql.includes('?'), `d1.${key} should be positional`);
  }
  for (const [key, sql] of Object.entries(commandsSQL.postgres)) {
    assert.ok(!sql.includes('?'), `postgres.${key} must not use ?: ${sql}`);
    assert.ok(/\$\d/.test(sql), `postgres.${key} should use $n`);
  }
});

check('the claim re-checks state rather than trusting the earlier read', () => {
  // Without the repeated conditions, two isolates polling at once could both
  // lease the same command and the host would be upgraded twice.
  // 若不重复这些条件，两个 isolate 同时轮询可能租用同一命令，导致主机更新两次。
  assert.match(commandsSQL.d1.claim, /state = 'pending' OR \(state = 'leased' AND lease_until <= \?\)/);
  assert.match(commandsSQL.postgres.claim, /state = 'pending' OR \(state = 'leased' AND lease_until <= \$\d\)/);
});

check('completing a command is guarded on its lease token', () => {
  // A late result from an expired lease must not overwrite the attempt that
  // actually ran.
  // 过期租约迟到的结果不得覆盖实际执行的尝试。
  assert.match(commandsSQL.d1.complete, /WHERE id = \? AND lease_token = \?/);
  assert.match(commandsSQL.postgres.complete, /WHERE id = \$\d+ AND lease_token = \$\d+/);
  assert.match(commandsSQL.d1.complete, /state = 'leased' AND lease_until >= \?/);
  assert.match(commandsSQL.postgres.complete, /state = 'leased' AND lease_until >= \$6/);
});

check('the prune only touches terminal rows', () => {
  // A prune that could match 'pending' would delete work that has not run.
  // 清理若匹配 pending，会删除尚未执行的任务。
  for (const sql of [commandsSQL.d1.pruneOld, commandsSQL.postgres.pruneOld]) {
    assert.match(sql, /state IN \('completed', 'expired'\)/);
    assert.ok(!/state\s*(=|IN)\s*\(?'pending'/.test(sql), sql);
  }
});

/* 两种 SQL 方言须接受调用方提供的同一组字段。
 * Both SQL dialects must accept the same fields supplied by the caller. */
check('both upsertStatic variants supply the same columns', () => {
  const source = readSource(AGENT_SQL);
  const blocks = [...source.matchAll(/upsertStatic: `([\s\S]*?)`/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2, 'expected a d1 and a postgres upsertStatic');

  const columns = (sql: string): string[] => {
    const match = /INSERT INTO machine_live\s*\(([\s\S]*?)\)\s*VALUES/.exec(sql);
    return match ? match[1].split(',').map((c) => c.trim()).filter(Boolean) : [];
  };

  const [d1, postgres] = blocks;
  const d1Cols = columns(d1);
  const pgCols = columns(postgres);

  assert.deepEqual(pgCols, d1Cols, 'the two backends insert different columns');
  // 16 is the number of values `handler.ts` binds; a mismatch is a runtime error
  // on whichever backend is short.
  // 16 是 handler.ts 绑定的值数；任一后端占位符不足都会在运行时出错。
  assert.equal(d1Cols.length, 16);
  assert.ok(d1Cols.includes('probe_capabilities'), 'probe_capabilities must be inserted');

  assert.equal((d1.match(/\?/g) ?? []).length, d1Cols.length);
  const highest = Math.max(0, ...[...postgres.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  assert.equal(highest, pgCols.length);
});

check('every ON CONFLICT assignment names a column the INSERT supplies', () => {
  const source = readSource(AGENT_SQL);
  const blocks = [...source.matchAll(/upsertStatic: `([\s\S]*?)`/g)].map((m) => m[1]);
  for (const sql of blocks) {
    const columnList = /INSERT INTO machine_live\s*\(([\s\S]*?)\)\s*VALUES/.exec(sql);
    const cols = columnList ? columnList[1].split(',').map((c) => c.trim()) : [];
    const setClause = /DO UPDATE SET([\s\S]*)$/.exec(sql);
    const assigned = setClause
      ? [...setClause[1].matchAll(/(\w+)\s*=\s*(?:excluded|EXCLUDED)\.(\w+)/g)].map((m) => m[2])
      : [];
    for (const column of assigned) {
      // `EXCLUDED.<col>` for a column the INSERT never supplies is a runtime error.
      // 对 INSERT 未提供的列使用 EXCLUDED.<col> 会导致运行时错误。
      assert.ok(cols.includes(column), `EXCLUDED.${column} is not in the insert column list`);
    }
  }
});

console.log(`\n${passed} command-gate checks passed`);
