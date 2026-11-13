import type { SetupRequirement } from '../../../../../shared/setup';
import type { Env } from '../../types';
import { databaseType } from '../db/setup-control';

// 数据库未配置时只能访问初始化入口。 / Keep business handlers closed until a database is configured.
export function databaseConfigured(env: Env): boolean {
  return Boolean(env.DB) || (databaseType(env) === 'postgres' && Boolean(env.DATABASE_URL));
}

export function setupRequirements(env: Env): SetupRequirement[] {
  return [
    { key: 'database', required: false, ok: Boolean(env.DB) },
    { key: 'adminToken', required: true, ok: Boolean(env.ADMIN_TOKEN) },
    { key: 'themes', required: false, ok: Boolean(env.THEMES) },
    { key: 'analytics', required: true, ok: Boolean(env.UPTIME) },
  ];
}
