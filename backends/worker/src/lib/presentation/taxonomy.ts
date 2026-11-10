import { Hono } from 'hono';
import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { visibilityRevisionWrite } from '../public/cache';
import { agentPresentationEnabled } from './store';

export interface AgentGroup { id: string; name: string; weight: number; count: number }
export interface AgentTag { id: string; name: string; color: string; count: number }
export async function loadAgentGroups(env: Env): Promise<AgentGroup[]> {
  const rows = await getDB(env).query<AgentGroup>('SELECT g.id,g.name,g.weight,COUNT(a.id) AS count FROM agent_groups g LEFT JOIN agents a ON a.group_id=g.id GROUP BY g.id,g.name,g.weight ORDER BY g.weight,g.name');
  return rows.map(row => ({ ...row, count: Number(row.count) }));
}
export async function loadAgentTags(env: Env): Promise<AgentTag[]> {
  const rows = await getDB(env).query<AgentTag>('SELECT t.id,t.name,t.color,COUNT(l.agent_id) AS count FROM agent_tags t LEFT JOIN agent_tag_links l ON l.tag_id=t.id GROUP BY t.id,t.name,t.color ORDER BY t.name');
  return rows.map(row => ({ ...row, count: Number(row.count) }));
}
export async function loadAgentTagLinks(env: Env) {
  return getDB(env).query<{ agent_id: string; id: string; name: string; color: string }>('SELECT l.agent_id,t.id,t.name,t.color FROM agent_tag_links l JOIN agent_tags t ON t.id=l.tag_id');
}

export const agentTaxonomyRoutes = new Hono<{ Bindings: Env }>();
for (const kind of ['groups', 'tags'] as const) {
  const path = `/api/admin/agent-${kind}`;
  const table = kind === 'groups' ? 'agent_groups' : 'agent_tags';
  agentTaxonomyRoutes.get(path, async c => c.json(kind === 'groups' ? { groups: await loadAgentGroups(c.env) } : { tags: await loadAgentTags(c.env) }, 200, { 'cache-control': 'private, no-store' }));
  agentTaxonomyRoutes.on(['POST', 'PUT'], [path, `${path}/:id`], async c => {
    if ((c.req.method === 'POST') !== !c.req.param('id')) return c.json({ error: 'invalid_request' }, 400);
    if (!await agentPresentationEnabled(c.env)) return c.json({ error: 'agent_page_disabled' }, 409);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const keys = kind === 'groups' ? ['name', 'weight'] : ['name', 'color'];
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) return c.json({ error: 'invalid_request' }, 400);
    const name = typeof body.name === 'string' ? body.name.trim().normalize('NFC') : '';
    const extra = kind === 'groups' ? body.weight ?? 0 : body.color ?? '#6366F1';
    if (!name || name.length > 100 || (kind === 'groups' ? !Number.isInteger(extra) || Math.abs(Number(extra)) > 100000 : typeof extra !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(extra))) return c.json({ error: 'invalid_request' }, 400);
    const db = getDB(c.env), id = c.req.param('id') ?? crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
    const arg = (n: number) => db.type === 'postgres' ? `$${n}` : '?';
    const duplicate = await db.queryOne(`SELECT id FROM ${table} WHERE name=${arg(1)} AND id<>${arg(2)}`, [name, id]);
    if (duplicate) return c.json({ error: 'name_exists' }, 409);
    const field = kind === 'groups' ? 'weight' : 'color';
    const update = c.req.method === 'PUT';
    const sql = update ? `UPDATE ${table} SET name=${arg(1)},${field}=${arg(2)},updated_at=${arg(3)} WHERE id=${arg(4)}` : `INSERT INTO ${table}(name,${field},updated_at,id,created_at) VALUES(${[1,2,3,4,5].map(arg).join(',')})`;
    let changes: number[];
    try {
      changes = await db.commit([{ sql, params: update ? [name, extra, now, id] : [name, extra, now, id, now] }, visibilityRevisionWrite(now, db.type === 'postgres')]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505' || /UNIQUE constraint failed/i.test(String(error))) return c.json({ error: 'name_exists' }, 409);
      throw error;
    }
    if (!changes[0]) return c.json({ error: 'not_found' }, 404);
    return c.json({ id, ok: true }, update ? 200 : 201);
  });
  agentTaxonomyRoutes.delete(`${path}/:id`, async c => {
    if (!await agentPresentationEnabled(c.env)) return c.json({ error: 'agent_page_disabled' }, 409);
    const db = getDB(c.env);
    await db.commit([{ sql: `DELETE FROM ${table} WHERE id=${db.type === 'postgres' ? '$1' : '?'}`, params: [c.req.param('id')] }, visibilityRevisionWrite(Math.floor(Date.now() / 1000), db.type === 'postgres')]);
    return c.json({ ok: true });
  });
}

agentTaxonomyRoutes.put('/api/admin/agents/:id/taxonomy', async c => {
  if (!await agentPresentationEnabled(c.env)) return c.json({ error: 'agent_page_disabled' }, 409);
  const body = await c.req.json().catch(() => null) as { group_id: unknown; tag_ids: unknown } | null;
  if (!body || Array.isArray(body) || Object.keys(body).some(key => !['group_id','tag_ids'].includes(key)) || (body.group_id !== null && typeof body.group_id !== 'string') || !Array.isArray(body.tag_ids) || body.tag_ids.length > 50 || body.tag_ids.some(id => typeof id !== 'string')) return c.json({ error: 'invalid_request' }, 400);
  const db = getDB(c.env), arg = (n: number) => db.type === 'postgres' ? `$${n}` : '?', id = c.req.param('id');
  if (!await db.queryOne(`SELECT id FROM agents WHERE id=${arg(1)}`, [id])) return c.json({ error: 'agent_not_found' }, 404);
  const groups = await loadAgentGroups(c.env), tags = await loadAgentTags(c.env);
  if (body.group_id !== null && !groups.some(g => g.id === body.group_id) || body.tag_ids.some(id => !tags.some(t => t.id === id))) return c.json({ error: 'invalid_reference' }, 400);
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.commit([
    { sql: `UPDATE agents SET group_id=${arg(1)},updated_at=${arg(2)} WHERE id=${arg(3)}`, params: [body.group_id, now, id] },
    { sql: `DELETE FROM agent_tag_links WHERE agent_id=${arg(1)}`, params: [id] },
    ...[...new Set(body.tag_ids as string[])].map(tag => ({ sql: `INSERT INTO agent_tag_links(agent_id,tag_id) VALUES(${arg(1)},${arg(2)})`, params: [id, tag] })),
    visibilityRevisionWrite(now, db.type === 'postgres'),
    ]);
  } catch (error) {
    if ((error as { code?: string }).code === '23503' || /FOREIGN KEY constraint failed/i.test(String(error))) return c.json({ error: 'invalid_reference' }, 400);
    throw error;
  }
  return c.json({ ok: true });
});
