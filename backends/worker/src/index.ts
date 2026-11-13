import { api } from './api';
import { setupRedirect } from './lib/auth/setup-redirect';
import { databaseConfigured, setupRequirements } from './lib/auth/setup-requirements';
import { bootstrapSchema } from './lib/db/bootstrap';
import { withDBScope } from './lib/db/factory';
import { ensureSchemaReady } from './lib/db/schema-guard';
import { postgresIsEmpty } from './lib/db/setup-postgres';
import { DatabaseConfigurationError, databaseType, pendingDatabase, requireReadyDatabase } from './lib/db/setup-control';
import { internalErrorResponse } from './lib/http/errors';
import { runSync } from './lib/jobs/daily-sync';
import { CRON_SYNC, CRON_TICK } from './lib/jobs/schedules';
import { runTick } from './lib/jobs/tick';
import { handlePageRequest } from './lib/theme/page-handler';
import type { Env } from './types';
import { isSetupAsset, setupRequiredResponse } from '../../../shared/setup';
import { brandIconSvg } from './lib/brand';

/**
 * Same-isolate fast path; the database lease covers other isolates.
 *
 * This avoids starting duplicate work before either invocation reaches the
 * persistent claim.
 * 同一 isolate 内的快速防重；跨 isolate 由数据库租约保护，避免持久化抢占前启动重复任务。
 */
let ticking = false;

/** 结构检查失败返回不可缓存的 JSON；missing 数组最多包含二十项。 / Return uncached JSON for a failed schema check, with at most twenty missing entries. */
function schemaBlocked(check: { error: string; missing?: string[]; message: string }): Response {
  const missing = (check.missing ?? []).slice(0, 20);
  return new Response(
    JSON.stringify({
      error: check.error,
      message: check.message,
      ...(missing.length ? { missing } : {}),
    }),
    {
      status: 500,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}

// Apply the same gate during database selection before business-table handlers can run.
// 选库未完成时也执行同一门禁，不能进入依赖业务表的处理器。
async function routeBeforeReady(request: Request, env: Env, ctx: ExecutionContext, error: 'setup_in_progress' | 'setup_required' | 'deployment_incomplete'): Promise<Response> {
  const blocked = setupRequiredResponse(request, error);
  if (blocked) return blocked;
  const path = new URL(request.url).pathname;
  if (path === '/api/public/icon') {
    return new Response(request.method === 'HEAD' ? null : brandIconSvg({ tight: new URL(request.url).searchParams.get('tight') === '1' }), {
      headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' },
    });
  }
  if (path.startsWith('/api/')) {
    return api.fetch(request, env, ctx);
  }
  return env.ASSETS?.fetch(request) ?? new Response('not found', { status: 404 });
}

async function handleDatabaseRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if ((request.method === 'GET' || request.method === 'HEAD') && isSetupAsset(path)) {
    return env.ASSETS?.fetch(request) ?? new Response('not found', { status: 404 });
  }
  // Initialize D1 before schema and session checks; pending setup must resume first.
  // 在结构与会话检查前初始化 D1；未完成的选库须先恢复。
  const pending = await pendingDatabase(env);
  if (!pending) await bootstrapSchema(env);
  let emptyPostgres = false;
  if (!pending && databaseType(env) === 'postgres') {
    try { emptyPostgres = await postgresIsEmpty(env); }
    catch { return Response.json({ error: 'database_connection_failed' }, { status: 503, headers: { 'cache-control': 'private, no-store' } }); }
  }
  if (pending || emptyPostgres) return routeBeforeReady(request, env, ctx, pending ? 'setup_in_progress' : 'setup_required');

  const schema = await ensureSchemaReady(env);
  if (!schema.ok) return schemaBlocked(schema);

  // Check setup before themes so an uninitialized site cannot serve its public page.
  // 初始化检查先于主题路由，避免无账户时显示公开页面。
  const setup = await setupRedirect(request, env);
  if (setup) return setup;

  if (path.startsWith('/agent/')) return new Response('Not found', { status: 404 });

  const page = await handlePageRequest(request, env);
  if (page) return page;
  if ((request.method === 'GET' || request.method === 'HEAD') && path !== '/api' && !path.startsWith('/api/') && path !== '/install.sh' && path !== '/install.ps1') {
    return env.ASSETS?.fetch(request) ?? new Response('not found', { status: 404 });
  }

  return api.fetch(request, env, ctx);
}

export default {
  /** 在请求数据库作用域内处理初始化和结构检查，再进入页面或 API 路由。 / Handle setup and schema checks in the request database scope before page or API routing. */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      // 未绑定数据库时只开放初始化检查所需的入口，其他页面转到 /setup。
      // Without a database binding, serve only what the setup check needs and send other pages to /setup.
      if (!databaseConfigured(env)) {
        const path = new URL(request.url).pathname;
        if ((request.method === 'GET' || request.method === 'HEAD') && isSetupAsset(path)) {
          return env.ASSETS?.fetch(request) ?? new Response('not found', { status: 404 });
        }
        const incomplete = setupRequirements(env).some((item) => item.required && !item.ok);
        return await routeBeforeReady(request, env, ctx, incomplete ? 'deployment_incomplete' : 'setup_required');
      }
      return await withDBScope(env, async (scopedEnv, scopedCtx) => {
        return handleDatabaseRequest(request, scopedEnv, scopedCtx ?? ctx);
      }, ctx);
    } catch (error) {
      if (error instanceof DatabaseConfigurationError) {
        return Response.json({ error: 'database_configuration_failed' }, { status: 503, headers: { 'cache-control': 'private, no-store' } });
      }
      return internalErrorResponse(error, request.method);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!databaseConfigured(env)) return;
    switch (controller.cron) {
      case CRON_TICK: {
        if (ticking) return;
        ticking = true;
        ctx.waitUntil(
          withDBScope(env, async (scopedEnv) => { await requireReadyDatabase(scopedEnv); return runTick(scopedEnv, Math.floor(Date.now() / 1000)); })
            .catch(() => console.error(JSON.stringify({ event: 'tick_failed' })))
            .finally(() => {
              ticking = false;
            }),
        );
        break;
      }

      case CRON_SYNC:
        ctx.waitUntil(
          withDBScope(env, async (scopedEnv) => { await requireReadyDatabase(scopedEnv); return runSync(scopedEnv); })
            .then((r) => console.log(JSON.stringify({ event: 'sync_ok', ...r })))
            .catch(() => console.error(JSON.stringify({ event: 'sync_failed' }))),
        );
        break;

      default:
        console.warn(JSON.stringify({ event: 'unknown_cron', cron: controller.cron }));
    }
  },
};
