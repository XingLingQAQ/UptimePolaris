import { Hono } from 'hono';
import { parseOptions, type AgentMachineOptions, type Env } from '../../types';
import { getDB } from '../db/factory';
import { deleteAgent } from './registry';
import { randomToken } from '../auth/service';
import { loadFleetWithSummary } from './fleet';
import { handleGetAgentConfiguration, handleSaveAgentConfiguration } from './runtime-config';
import { agentPresentationEnabled } from '../presentation/store';
import { visibilityRevisionWrite } from '../public/cache';

/** 管理 Agent 清单、运行配置、命令及详情的接口。 / Endpoints for managing the Agent fleet, runtime configuration, commands, and details. */
export const agentRoutes = new Hono<{ Bindings: Env }>();
agentRoutes.get('/api/admin/agents/:id/config', handleGetAgentConfiguration);
agentRoutes.put('/api/admin/agents/:id/config', handleSaveAgentConfiguration);

agentRoutes.get('/api/admin/agents', async (c) => {
  c.header('cache-control', 'private, no-store');
  const now = Math.floor(Date.now() / 1000);
  const { agents, summary } = await loadFleetWithSummary(c.env, now);
  return c.json({ agents, summary });
});

agentRoutes.post('/api/admin/agents/visibility', async c => {
  if (!await agentPresentationEnabled(c.env)) return c.json({error:'agent_page_disabled'},409);
  const body = await c.req.json().catch(()=>null);
  if (!body || !Array.isArray(body.ids) || !body.ids.length || body.ids.length>500 || body.ids.some((id:unknown)=>typeof id!=='string'||!id||id.length>128)) return c.json({error:'invalid_ids'},400);
  if (typeof body.is_public!=='boolean') return c.json({error:'visibility_invalid'},400);
  const db=getDB(c.env), ids=[...new Set(body.ids as string[])], now=Math.floor(Date.now()/1000);
  const writes: {sql:string;params:unknown[]}[]=[];
  for(let offset=0;offset<ids.length;offset+=80){
    const chunk=ids.slice(offset,offset+80), arg=(n:number)=>db.type==='postgres'?`$${n}`:'?';
    const existing=await db.query<{id:string}>(`SELECT id FROM agents WHERE id IN (${chunk.map((_,i)=>arg(i+1)).join(',')})`,chunk);
    if(existing.length!==chunk.length)return c.json({error:'agent_not_found'},404);
    writes.push({sql:`UPDATE agents SET is_public=${arg(1)},updated_at=${arg(2)} WHERE id IN (${chunk.map((_,i)=>arg(i+3)).join(',')})`,params:[body.is_public?1:0,now,...chunk]});
  }
  const changes=await db.commit([...writes,visibilityRevisionWrite(now,db.type==='postgres')]);
  return c.json({ok:true,updated:changes.slice(0,writes.length).reduce((sum,n)=>sum+n,0),is_public:body.is_public});
});

agentRoutes.post('/api/admin/agents', async (c) => {
  c.header('cache-control', 'private, no-store');
  let body: { name?: unknown; probe_enabled?: unknown; is_public?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_request' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'probe_enabled','is_public'].includes(key))) return c.json({ error: 'invalid_request' }, 400);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 200) return c.json({ error: 'invalid_name' }, 400);
  if (body.probe_enabled !== undefined && typeof body.probe_enabled !== 'boolean') return c.json({ error: 'invalid_enabled' }, 400);
  if (body.is_public !== undefined && typeof body.is_public !== 'boolean') return c.json({error:'visibility_invalid'},400);
  if (body.is_public !== undefined && !await agentPresentationEnabled(c.env)) return c.json({error:'agent_page_disabled'},409);
  const id = crypto.randomUUID();
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  const db = getDB(c.env);
  const params = [id, name, token, JSON.stringify({ probe_enabled: body.probe_enabled !== false }), now, now,body.is_public===true?1:0];
  await db.execute(db.type === 'postgres'
    ? 'INSERT INTO agents (id,name,token,options_json,created_at,updated_at,is_public) VALUES ($1,$2,$3,$4,$5,$6,$7)'
    : 'INSERT INTO agents (id,name,token,options_json,created_at,updated_at,is_public) VALUES (?,?,?,?,?,?,?)', params);
  return c.json({ id, token }, 201);
});

agentRoutes.post('/api/admin/agents/:id/rename', async (c) => {
  c.header('cache-control', 'private, no-store');
  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const name = typeof (body as { name?: unknown })?.name === 'string' ? (body as { name: string }).name.trim() : '';
  if (name.length === 0 || name.length > 200) return c.json({ error: 'invalid_name' }, 400);

  const db = getDB(c.env);
  const result = await db.execute(
    db.type === 'postgres'
      ? "UPDATE agents SET name = $1, updated_at = $2 WHERE id = $3"
      : "UPDATE agents SET name = ?, updated_at = ? WHERE id = ?",
    [name, Math.floor(Date.now() / 1000), c.req.param('id')],
  );
  if (!result.rowsAffected) return c.json({ error: 'agent_not_found' }, 404);
  return c.json({ ok: true, name });
});

agentRoutes.post('/api/admin/agents/:id/active', async (c) => {
  c.header('cache-control', 'private, no-store');
  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const active = (body as { active?: unknown })?.active;
  if (typeof active !== 'boolean') return c.json({ error: 'invalid_active' }, 400);

  const db = getDB(c.env);
  const result = await db.execute(
    db.type === 'postgres'
      ? "UPDATE agents SET active = $1, updated_at = $2 WHERE id = $3"
      : "UPDATE agents SET active = ?, updated_at = ? WHERE id = ?",
    [active ? 1 : 0, Math.floor(Date.now() / 1000), c.req.param('id')],
  );
  if (!result.rowsAffected) return c.json({ error: 'agent_not_found' }, 404);
  return c.json({ ok: true, active });
});

agentRoutes.post('/api/admin/agents/:id/probe', async (c) => {
  c.header('cache-control', 'private, no-store');
  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const enabled = (body as { enabled?: unknown })?.enabled;
  if (typeof enabled !== 'boolean') return c.json({ error: 'invalid_enabled' }, 400);

  const db = getDB(c.env);
  const id = c.req.param('id');
  const row = await db.queryOne<{ options_json: string | null }>(
    db.type === 'postgres'
      ? 'SELECT options_json FROM agents WHERE id = $1'
      : 'SELECT options_json FROM agents WHERE id = ?',
    [id],
  );
  if (!row) return c.json({ error: 'agent_not_found' }, 404);

  const options = parseOptions<AgentMachineOptions>(row.options_json);
  options.probe_enabled = enabled;
  await db.execute(
    db.type === 'postgres'
      ? 'UPDATE agents SET options_json = $1, updated_at = $2 WHERE id = $3'
      : 'UPDATE agents SET options_json = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(options), Math.floor(Date.now() / 1000), id],
  );
  return c.json({ ok: true, probe_enabled: enabled });
});

agentRoutes.delete('/api/admin/agents/:id', async (c) => {
  const id = c.req.param('id');
  const result = await deleteAgent(c.env, id);
  if (result === 'missing') return c.json({ error: 'agent_not_found' }, 404);
  if (result === 'in_use') return c.json({ error: 'agent_in_use' }, 409);
  return c.json({ ok: true });
});

import { currentUser } from '../auth/routes';
import { clampInteger } from '../util';
import { COMMAND_CAPABILITY, commandsEnabled, enqueueCommand, enqueueCommands, isCommandAction, listCommandsForAgent } from './commands';
import { loadAgentDetail } from './detail';

agentRoutes.post('/api/admin/agents/:id/commands', async (c) => {
  c.header('cache-control', 'private, no-store');
  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const action = (body as { action?: unknown })?.action;

  let issuedBy: string | null = null;
  try {
    issuedBy = (await currentUser(c))?.user?.username ?? null;
  } catch {
    // A machine token has no username; the command is still attributable to the
    // token, and losing the audit name must not block the operation.
    // 机器令牌没有用户名；命令仍可归因于该令牌，不能因缺少审计名称而阻止操作。
  }

  let result;
  try {
    result = await enqueueCommand(c.env, c.req.param('id'), action, issuedBy, Math.floor(Date.now() / 1000));
  } catch {
    return c.json({ error: 'database_unavailable' }, 503);
  }
  if (!result.ok) {
    const status = result.error === 'unknown_action' ? 400
      : result.error === 'agent_not_found' ? 404
      // Both "too old to understand" and "offline right now" are conflicts with
      // the request as made, not authorization failures - and each is separately
      // actionable, so the console tells them apart.
      // “版本过旧无法理解”和“当前离线”都是请求冲突，而非鉴权失败；
      // 二者的处理方式不同，因此控制台分别显示。
      : result.error === 'agent_unsupported' ? 409
      : result.error === 'agent_offline' ? 409
      : 403;
    return c.json({ error: result.error }, status);
  }
  return c.json({ ok: true, id: result.id }, 202);
});

/** One command for several agents, with a per-id verdict. / 向多个 Agent 下发同一命令，并分别返回每个 ID 的结果。 */
agentRoutes.post('/api/admin/agents/batch-commands', async (c) => {
  c.header('cache-control', 'private, no-store');
  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const raw = body as { ids?: unknown; action?: unknown };
  const ids = Array.isArray(raw?.ids)
    ? [...new Set(raw.ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
  if (ids.length === 0 || ids.length > 100) return c.json({ error: 'invalid_ids' }, 400);
  if (!isCommandAction(raw?.action)) return c.json({ error: 'unknown_action' }, 400);

  let issuedBy: string | null = null;
  try {
    issuedBy = (await currentUser(c))?.user?.username ?? null;
  } catch {
    // Machine token: no username, but the command is still attributable to it.
    // 机器令牌没有用户名，但命令仍可归因于该令牌。
  }

  let results;
  try {
    results = await enqueueCommands(c.env, ids, raw.action, issuedBy, Math.floor(Date.now() / 1000));
  } catch {
    return c.json({ error: 'database_unavailable' }, 503);
  }
  return c.json({ results });
});

/** What happened to recent commands, so the console can show an outcome. / 最近命令的执行情况，供控制台展示结果。 */
agentRoutes.get('/api/admin/agents/:id/commands', async (c) => {
  c.header('cache-control', 'private, no-store');
  const requested = Number(c.req.query('limit') ?? 20);
  if (!Number.isInteger(requested)) return c.json({ error: 'invalid_limit' }, 400);
  const limit = clampInteger(requested, 1, 100);
  const rows = await listCommandsForAgent(c.env, c.req.param('id'), limit);
  return c.json({
    commands: rows,
    /**
     * Reported alongside the list so the console does not have to guess why a
     * button is inert. It reads the same setting the delivery path reads.
     * 与列表一起返回，避免控制台猜测按钮为何不可用；读取的设置与投递路径相同。
     */
    enabled: await commandsEnabled(c.env),
    capability: COMMAND_CAPABILITY,
  });
});

/** Fleet row, mounts, interfaces, alert rules and a day of history. / 集群记录、挂载点、网卡、告警规则及一天的历史。 */
agentRoutes.get('/api/admin/agents/:id/detail', async (c) => {
  c.header('cache-control', 'private, no-store');
  let detail;
  try {
    detail = await loadAgentDetail(c.env, c.req.param('id'), Math.floor(Date.now() / 1000));
  } catch {
    return c.json({ error: 'database_unavailable' }, 503);
  }
  if (!detail) return c.json({ error: 'agent_not_found' }, 404);
  return c.json(detail);
});

