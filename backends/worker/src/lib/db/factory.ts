import { createMiddleware } from 'hono/factory';
import type { Env } from '../../types';
import type { DBAdapter } from './adapter';
import { D1Adapter } from './d1';
import { PostgresAdapter } from './postgres';
import { deploymentEnv, pendingDatabase, rememberDeployment, resolveDatabase } from './setup-control';

interface Scope {
  adapter?: DBAdapter;
  active: boolean;
  pending: number;
  closing?: Promise<void>;
  closed?: boolean;
}

const scopes = new WeakMap<Env, Scope>();

function createDB(env: Env): DBAdapter {
  const dbType = env.DATABASE_TYPE ?? 'd1';

  switch (dbType) {
    case 'd1':
      return new D1Adapter(env.DB);
    case 'postgres':
      if (!env.DATABASE_URL) {
        throw new Error(
          'DATABASE_TYPE=postgres requires DATABASE_URL - set it with `wrangler secret put DATABASE_URL`',
        );
      }
      return new PostgresAdapter(env.DATABASE_URL);
    default:
      throw new Error(`Unknown DATABASE_TYPE: ${String(dbType)}`);
  }
}

/** 获取作用域内延迟创建的适配器；无作用域时创建独立适配器。 / Get the lazily created scoped adapter, or create a standalone adapter outside a scope. */
export function getDB(env: Env): DBAdapter {
  const scope = scopes.get(env);
  if (!scope) return createDB(env);
  if (scope.closed || scope.closing) throw new Error('Database scope is closed; start a new scope for this work.');
  return (scope.adapter ??= createDB(env));
}

async function closeWhenIdle(scope: Scope): Promise<void> {
  if (scope.active || scope.pending || scope.closed) return;
  scope.closing ??= Promise.resolve(scope.adapter?.close?.()).then(() => {
    scope.closed = true;
  });
  await scope.closing;
}

async function runInScope<T, C extends { waitUntil(promise: Promise<unknown>): void } = ExecutionContext>(
  env: Env,
  work: (scopedEnv: Env, scopedContext?: C) => Promise<T>,
  executionCtx?: C,
  independent = false,
  selection?: Pick<Env, 'DATABASE_TYPE' | 'DATABASE_URL'>,
): Promise<T> {
  const inherited = scopes.get(env);
  if (!independent && inherited && !inherited.closed && !inherited.closing &&
      (inherited.active || inherited.pending > 0)) return work(env, executionCtx);

  const scope: Scope = { active: true, pending: 0 };
  const deployment = deploymentEnv(env);
  if (independent && !selection && await pendingDatabase(deployment)) throw new Error('database_configuration_failed');
  const scopedEnv = Object.assign(Object.create(env), selection ?? await resolveDatabase(deployment)) as Env;
  rememberDeployment(scopedEnv, env);
  scopes.set(scopedEnv, scope);

  // waitUntil 的后台任务完成后才关闭连接，避免作用域结束过早。
  // Keep the connection open until waitUntil background tasks finish.
  const scopedContext = executionCtx && new Proxy(executionCtx, {
    get(target, property) {
      if (property === 'waitUntil') {
        return (promise: Promise<unknown>) => {
          scope.pending++;
          const tracked = Promise.resolve(promise).finally(async () => {
            scope.pending--;
            await closeWhenIdle(scope);
          });
          try {
            target.waitUntil(tracked);
          } catch (error) {
            scope.pending--;
            void closeWhenIdle(scope);
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as C;

  try {
    return await work(scopedEnv, scopedContext);
  } finally {
    scope.active = false;
    await closeWhenIdle(scope);
  }
}

/** 复用活动作用域，并在请求及其后台任务结束后释放适配器。 / Reuse the active scope and release its adapter after the request and background tasks finish. */
export function withDBScope<T, C extends { waitUntil(promise: Promise<unknown>): void } = ExecutionContext>(
  env: Env,
  work: (scopedEnv: Env, scopedContext?: C) => Promise<T>,
  executionCtx?: C,
): Promise<T> {
  return runInScope(env, work, executionCtx);
}

/** 为独立执行的工作创建单独的适配器生命周期。 / Create a separate adapter lifecycle for independent work. */
export function withIndependentDBScope<T>(
  env: Env,
  work: (scopedEnv: Env) => Promise<T>,
): Promise<T> {
  return runInScope(env, work, undefined, true);
}

/** 初始化时独立访问指定数据库，不修改部署配置或已保存的选择。 / Access a selected database independently during setup without changing deployment or saved settings. */
export function withSelectedDatabase<T>(
  env: Env,
  selection: Pick<Env, 'DATABASE_TYPE' | 'DATABASE_URL'>,
  work: (scopedEnv: Env) => Promise<T>,
): Promise<T> {
  return runInScope(env, work, undefined, true, selection);
}

export const dbScopeMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const executionCtx = c.executionCtx;
  await withDBScope(c.env, async (scopedEnv, scopedCtx) => {
    c.env = scopedEnv;
    if (scopedCtx) Object.defineProperty(c, 'executionCtx', { value: scopedCtx, configurable: true });
    await next();
  }, executionCtx);
});
