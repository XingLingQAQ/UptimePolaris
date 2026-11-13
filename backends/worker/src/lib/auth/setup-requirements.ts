import type { SetupRequirement } from '../../../../../shared/setup';
import type { Env } from '../../types';
import { databaseType } from '../db/setup-control';

/**
 * Fork 和按钮部署不声明资源绑定，数据库由用户在控制台绑定；绑定前不能访问任何业务表。
 * D1 不是必需项：只配置 DATABASE_URL 时按 PostgreSQL 处理，可以省略 DATABASE_TYPE。
 * Fork and button deployments declare no resource bindings, so the database is bound in the dashboard; nothing that reads tables can run before that.
 * D1 is optional: with only DATABASE_URL configured the deployment is PostgreSQL, and DATABASE_TYPE may be omitted.
 */
export function databaseConfigured(env: Env): boolean {
  return Boolean(env.DB) || (databaseType(env) === 'postgres' && Boolean(env.DATABASE_URL));
}

export function setupRequirements(env: Env): SetupRequirement[] {
  return [
    { key: 'database', required: true, ok: databaseConfigured(env) },
    { key: 'adminToken', required: true, ok: Boolean(env.ADMIN_TOKEN) },
    { key: 'themes', required: false, ok: Boolean(env.THEMES) },
    { key: 'analytics', required: true, ok: Boolean(env.UPTIME) },
  ];
}
