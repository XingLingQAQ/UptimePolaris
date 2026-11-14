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
    // KV 保存初始化选库和低频设置，未绑定则无法完成初始化。 / KV holds the selected database and low-frequency settings; setup cannot complete without it.
    { key: 'config', required: true, ok: Boolean(env.CONFIG) },
    { key: 'adminToken', required: true, ok: Boolean(env.ADMIN_TOKEN) },
    { key: 'themes', required: false, ok: Boolean(env.THEMES) },
    { key: 'analytics', required: true, ok: Boolean(env.UPTIME) },
  ];
}
