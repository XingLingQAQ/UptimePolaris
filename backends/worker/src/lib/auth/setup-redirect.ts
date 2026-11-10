import type { Env } from '../../types';
import { isSetupRequired } from './service';
import { databaseIdentity } from '../db/setup-control';
import { isSetupAsset, isSetupEndpoint, setupRequiredResponse } from '../../../../../shared/setup';

// Remember completed setup by database identity; never cache pending or failed checks.
// 只按数据库身份记住已完成状态；初始化失败或尚未完成的结果不缓存。
let initialized: string | D1Database | null = null;

export function resetSetupRedirectCache(): void {
  initialized = null;
}

export async function setupRedirect(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (isSetupEndpoint(request.method, path) || (request.method === 'GET' || request.method === 'HEAD') && isSetupAsset(path)) return null;
  if (initialized === databaseIdentity(env)) return null;
  try {
    if (!(await isSetupRequired(env))) {
      initialized = databaseIdentity(env);
      return null;
    }
  } catch {
    return Response.json({ error: 'database_unavailable' }, { status: 503, headers: { 'cache-control': 'private, no-store' } });
  }
  return setupRequiredResponse(request);
}
