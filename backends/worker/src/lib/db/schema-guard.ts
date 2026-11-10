/**
 * PostgreSQL 结构检查按连接目标缓存；成功五分钟、失败三十秒。
 * Cache PostgreSQL schema checks by connection target: five minutes on success, thirty seconds on failure.
 * 不共享进行中的查询，避免跨请求依赖另一个数据库作用域的连接。
 * Do not share in-flight queries across requests with separate database connection scopes.
 */

import type { Env } from '../../types';
import { probeSchema, schemaBehindMessage } from './migrate';

/** How long a passing probe is trusted, in milliseconds. / 成功探测结果的可信时长（毫秒）。 */
const OK_TTL_MS = 5 * 60_000;

/** 失败结果缓存三十秒，缓存有效期内不会重新探测。 / Cache failed results for thirty seconds without probing again during that interval. */
const FAIL_TTL_MS = 30_000;

interface ProbeEntry {
  at: number;
  ok: boolean;
  missing: string[];
}

/** 当前 isolate 内按目标和 TTL 复用结果。 / Reuse results by target and TTL within the current isolate. */
let cache: (ProbeEntry & { target: string }) | null = null;

/** Test hook: drop the cache so a suite can assert a state it just changed. / 测试钩子：清除缓存，使测试可断言刚改变的状态。 */
export function resetSchemaGuardCache(): void {
  cache = null;
}

export type SchemaCheck =
  | { ok: true }
  | { ok: false; error: 'schema_behind'; missing: string[]; message: string }
  | { ok: false; error: 'database_unavailable'; message: string };

/** D1 直接通过；PostgreSQL 返回结构状态或查询失败信息。 / Pass D1 through; return PostgreSQL schema status or a probe failure. */
export async function ensureSchemaReady(env: Env): Promise<SchemaCheck> {
  if ((env.DATABASE_TYPE ?? 'd1') !== 'postgres') return { ok: true };

  const now = Date.now();
  const target = env.DATABASE_URL ?? '';
  if (cache && cache.target === target && now - cache.at < (cache.ok ? OK_TTL_MS : FAIL_TTL_MS)) return toCheck(cache);

  let entry: ProbeEntry;
  try {
    const result = await probeSchema(env);
    entry = { at: now, ok: result.ok, missing: result.missing };
  } catch (e) {
    // The probe itself failed - the server is unreachable, the role lacks
    // permission, or a query errored for a reason that is not "table does not
    // exist". That is not the same state as a schema that is merely behind, and
    // it must not be reported as one, or an operator would run a migration
    // against a database whose real problem is connectivity.
    // 探测本身失败：可能是服务器不可达、角色缺少权限，或查询因“表不存在”以外的原因出错。
    // 这不同于结构落后，不能误报；否则管理员可能对真正问题是连接性的数据库运行迁移。
    console.error(JSON.stringify({ event: 'schema_probe_failed' }));
    cache = { at: now, ok: false, missing: [], target };
    return {
      ok: false,
      error: 'database_unavailable',
      message:
        'Could not verify the Postgres schema: the probe query failed. ' +
        'Check DATABASE_URL and that the database is reachable.',
    };
  }

  cache = { ...entry, target };
  return toCheck(entry);
}

function toCheck(entry: ProbeEntry): SchemaCheck {
  if (entry.ok) return { ok: true };
  return {
    ok: false,
    error: 'schema_behind',
    missing: entry.missing,
    message: schemaBehindMessage(entry.missing),
  };
}
