import type { Context } from 'hono';
import type { Env } from '../../types';
import { parseAgentRuntimeConfig, sameAgentRuntimeConfig, type AgentConfigurationState, type AgentInstallationInfo, type AgentRuntimeConfig } from '../../../../../shared/agent-runtime-config';
import { getDB } from '../db/factory';
import { readBoundedBody } from '../http/binary';
import { commandsEnabled } from './commands';

type Row = { agent_id: string; desired_json: string | null; desired_revision: string | null; reported_json: string | null; applied_revision: string | null; last_error: string | null };
type Report = { config: AgentRuntimeConfig; installation: AgentInstallationInfo };
const placeholders = (postgres: boolean, count: number) => Array.from({ length: count }, (_, index) => postgres ? `$${index + 1}` : '?').join(',');

async function body(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(await readBoundedBody(c.req.raw.body, 64 * 1024)));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

async function rowFor(env: Env, id: string): Promise<Row | null> {
  const db = getDB(env);
  return db.queryOne<Row>(`SELECT * FROM agent_runtime_configs WHERE agent_id=${db.type === 'postgres' ? '$1' : '?'}`, [id]);
}

async function exists(env: Env, id: string): Promise<boolean> {
  const db = getDB(env);
  return Boolean(await db.queryOne(`SELECT id FROM agents WHERE id=${db.type === 'postgres' ? '$1' : '?'}`, [id]));
}

function state(row: Row | null, allowed: boolean): AgentConfigurationState {
  const report: Report | null = row?.reported_json ? JSON.parse(row.reported_json) : null;
  const desired: AgentRuntimeConfig | null = row?.desired_json ? JSON.parse(row.desired_json) : null;
  return {
    supported: report !== null, allowed, current: report?.config ?? null, installation: report?.installation ?? null,
    desired, desired_revision: row?.desired_revision ?? null, applied_revision: row?.applied_revision ?? null,
    status: !report ? 'unreported' : row?.last_error ? 'error' : row?.desired_revision && row.desired_revision !== row.applied_revision ? 'pending' : 'synced',
    error: row?.last_error ?? null,
  };
}

export async function handleGetAgentConfiguration(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header('cache-control', 'private, no-store');
  const id = c.req.param('id') ?? '';
  if (!(await exists(c.env, id))) return c.json({ error: 'agent_not_found' }, 404);
  return c.json(state(await rowFor(c.env, id), await commandsEnabled(c.env)));
}

/** 保存期望配置；版本不匹配时返回冲突，避免覆盖并发修改。 / Save desired configuration; return a conflict on revision mismatch to protect concurrent changes. */
export async function handleSaveAgentConfiguration(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header('cache-control', 'private, no-store');
  const id = c.req.param('id') ?? '';
  if (!(await exists(c.env, id))) return c.json({ error: 'agent_not_found' }, 404);
  if (!(await commandsEnabled(c.env))) return c.json({ error: 'commands_disabled' }, 403);
  const current = await rowFor(c.env, id);
  if (!current?.reported_json) return c.json({ error: 'agent_config_unsupported' }, 409);
  const input = await body(c);
  const config = parseAgentRuntimeConfig(input?.config);
  if (!config || !input || !(input.expected_revision === null || typeof input.expected_revision === 'string')) return c.json({ error: 'agent_config_invalid' }, 400);
  const report = JSON.parse(current.reported_json) as Report;
  if (config.auto_update && !report.installation.auto_update_supported) return c.json({ error: 'agent_config_invalid' }, 400);
  if (input.expected_revision !== current.desired_revision) return c.json({ error: 'agent_config_conflict' }, 409);
  const revision = crypto.randomUUID().replaceAll('-', '');
  const db = getDB(c.env);
  const pg = db.type === 'postgres';
  const result = await db.execute(pg
    ? 'UPDATE agent_runtime_configs SET desired_json=$1,desired_revision=$2,last_error=NULL,updated_at=$3 WHERE agent_id=$4 AND desired_revision IS NOT DISTINCT FROM $5'
    : 'UPDATE agent_runtime_configs SET desired_json=?,desired_revision=?,last_error=NULL,updated_at=? WHERE agent_id=? AND desired_revision IS ?',
    [JSON.stringify(config), revision, Math.floor(Date.now() / 1000), id, input.expected_revision]);
  if (!result.rowsAffected) return c.json({ error: 'agent_config_conflict' }, 409);
  return c.json({ ok: true, revision });
}

/** 接收 Agent 当前配置和应用结果，并返回尚待应用的期望版本。 / Accept the Agent's current configuration and apply result, then return any pending desired revision. */
export async function handleAgentConfigurationExchange(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header('cache-control', 'private, no-store');
  const db = getDB(c.env);
  const pg = db.type === 'postgres';
  const agent = await db.queryOne<{ id: string }>(`SELECT id FROM agents WHERE token=${pg ? '$1' : '?'}`, [c.req.param('token') ?? '']);
  if (!agent) return c.json({ error: 'invalid token' }, 401);
  const input = await body(c);
  const config = parseAgentRuntimeConfig(input?.config);
  const installation = input?.installation as Record<string, unknown> | undefined;
  if (!input || !config || !(input.revision === null || typeof input.revision === 'string' && /^[a-f0-9]{32}$/.test(input.revision)) ||
    !installation || typeof installation !== 'object' || Array.isArray(installation) ||
    !(installation.service_tier === null || typeof installation.service_tier === 'string' && installation.service_tier.length <= 64) ||
    typeof installation.config_path !== 'string' || installation.config_path.length > 1024 ||
    typeof installation.executable_path !== 'string' || installation.executable_path.length > 1024 ||
    typeof installation.auto_update_supported !== 'boolean' ||
    !(input.error === undefined || input.error === null || typeof input.error === 'string' && input.error.length <= 512)) return c.json({ error: 'agent_config_invalid' }, 400);
  const report: Report = { config, installation: {
    service_tier: installation.service_tier as string | null, config_path: installation.config_path,
    executable_path: installation.executable_path, auto_update_supported: installation.auto_update_supported,
  } };
  const reported = JSON.stringify(report);
  const previous = await rowFor(c.env, agent.id);
  const desiredConfig = previous?.desired_json ? parseAgentRuntimeConfig(JSON.parse(previous.desired_json)) : null;
  // 版本号和配置内容均一致且无错误，才视为应用成功。
  // Application succeeds only when revision and configuration match and no error is reported.
  const applied = previous?.desired_revision && input.revision === previous.desired_revision && desiredConfig && sameAgentRuntimeConfig(desiredConfig, config) && !input.error ? input.revision : null;
  const error = typeof input.error === 'string' && input.error ? input.error : null;
  if (!previous || previous.reported_json !== reported || previous.applied_revision !== applied || previous.last_error !== error) {
    await db.execute(`INSERT INTO agent_runtime_configs(agent_id,reported_json,applied_revision,last_error,updated_at) VALUES(${placeholders(pg, 5)})
      ON CONFLICT(agent_id) DO UPDATE SET reported_json=excluded.reported_json,applied_revision=excluded.applied_revision,last_error=excluded.last_error,updated_at=excluded.updated_at`,
    [agent.id, reported, applied, error, Math.floor(Date.now() / 1000)]);
  }
  const latest = await rowFor(c.env, agent.id);
  const desired = latest?.desired_revision && latest.desired_revision !== applied && latest.desired_json && await commandsEnabled(c.env)
    ? { revision: latest.desired_revision, config: JSON.parse(latest.desired_json) as AgentRuntimeConfig } : null;
  return c.json({ ok: true, runtime_config: desired });
}
