import type { SetupRequirement } from '../../../../../shared/setup';
import type { Env } from '../../types';

/**
 * Fork 和按钮部署不声明资源绑定，数据库由用户在控制台绑定；绑定前不能访问任何业务表。
 * Fork and button deployments declare no resource bindings, so the database is bound in the dashboard; nothing that reads tables can run before that.
 */
export function databaseConfigured(env: Env): boolean {
  return Boolean(env.DB) || ((env.DATABASE_TYPE ?? 'd1') === 'postgres' && Boolean(env.DATABASE_URL));
}

export function setupRequirements(env: Env): SetupRequirement[] {
  return [
    { key: 'database', required: true, ok: databaseConfigured(env) },
    { key: 'adminToken', required: true, ok: Boolean(env.ADMIN_TOKEN) },
    { key: 'themes', required: false, ok: Boolean(env.THEMES) },
    { key: 'analytics', required: false, ok: Boolean(env.UPTIME) },
  ];
}
