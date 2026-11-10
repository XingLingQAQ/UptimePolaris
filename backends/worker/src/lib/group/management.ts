import type { DBAdapter } from '../db/adapter';
import { Hono } from 'hono';
import type { Env } from '../../types';
import type { ManagedGroup, GroupType } from '../../../../../shared/groups';
import { getDB } from '../db/factory';
import { agentPresentationEnabled } from '../presentation/store';
import { visibilityRevisionWrite } from '../public/cache';
import { invalidateConfig } from '../monitor/store';

// 同名监控分组与 Agent 分组合并展示，写入仍保留各自的 ID 和作用域。
// Display same-name monitor and Agent groups together while retaining separate IDs and write scopes.
export async function managedGroups(
  env: Env,
): Promise<{ groups: ManagedGroup[]; agentEnabled: boolean }> {
  const db = getDB(env),
    agentEnabled = await agentPresentationEnabled(env);
  type Row = { id: string; name: string; weight: number; count: number };
  const monitors = await db.query<Row>(
    'SELECT g.id,g.name,g.weight,COUNT(m.id) AS count FROM monitor_groups g LEFT JOIN monitors m ON m.group_id=g.id GROUP BY g.id,g.name,g.weight',
  );
  const agents = agentEnabled
    ? await db.query<Row>(
        'SELECT g.id,g.name,g.weight,COUNT(a.id) AS count FROM agent_groups g LEFT JOIN agents a ON a.group_id=g.id GROUP BY g.id,g.name,g.weight',
      )
    : [];
  const byName = new Map<string, ManagedGroup>();
  for (const row of monitors)
    byName.set(row.name, {
      key: `monitor:${row.id}`,
      name: row.name,
      type: 'monitor',
      weight: Number(row.weight),
      monitorId: row.id,
      agentId: null,
      monitorCount: Number(row.count),
      agentCount: 0,
    });
  for (const row of agents) {
    const existing = byName.get(row.name);
    if (existing) {
      existing.type = 'common';
      existing.agentId = row.id;
      existing.agentCount = Number(row.count);
    } else
      byName.set(row.name, {
        key: `agent:${row.id}`,
        name: row.name,
        type: 'agent',
        weight: Number(row.weight),
        monitorId: null,
        agentId: row.id,
        monitorCount: 0,
        agentCount: Number(row.count),
      });
  }
  return {
    agentEnabled,
    groups: [...byName.values()].sort(
      (a, b) => a.weight - b.weight || a.name.localeCompare(b.name),
    ),
  };
}
const resetWrites = (pg: boolean, kind: 'monitor' | 'agent', id: string) => {
  const arg = pg ? '$1' : '?';
  return kind === 'monitor'
    ? [
        {
          sql: `UPDATE monitors SET group_id=NULL WHERE group_id=${arg}`,
          params: [id],
        },
        {
          sql: `DELETE FROM notification_groups WHERE group_id=${arg}`,
          params: [id],
        },
        { sql: `DELETE FROM monitor_groups WHERE id=${arg}`, params: [id] },
      ]
    : [
        {
          sql: `UPDATE agents SET group_id=NULL WHERE group_id=${arg}`,
          params: [id],
        },
        { sql: `DELETE FROM agent_groups WHERE id=${arg}`, params: [id] },
      ];
};
export const groupManagementRoutes = new Hono<{ Bindings: Env }>();
groupManagementRoutes.get('/api/admin/groups', async (c) =>
  c.json(await managedGroups(c.env), 200, {
    'cache-control': 'private, no-store',
  }),
);
groupManagementRoutes.on(
  ['POST', 'PUT'],
  ['/api/admin/groups', '/api/admin/groups/:key'],
  async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) =>
          !['name', 'weight', 'type', 'confirm_membership_reset'].includes(k),
      )
    )
      return c.json({ error: 'invalid_request' }, 400);
    const name =
      typeof body.name === 'string' ? body.name.trim().normalize('NFC') : '';
    const type = body.type as GroupType,
      weight = body.weight;
    if (
      !name ||
      name.length > 100 ||
      !['monitor', 'agent', 'common'].includes(type) ||
      !Number.isInteger(weight) ||
      Math.abs(weight) > 100000
    )
      return c.json({ error: 'invalid_request' }, 400);
    const { groups, agentEnabled } = await managedGroups(c.env),
      key = c.req.param('key');
    if ((c.req.method === 'POST') !== !key)
      return c.json({ error: 'invalid_request' }, 400);
    if (!agentEnabled && type !== 'monitor')
      return c.json({ error: 'agent_page_disabled' }, 409);
    const current = key ? groups.find((group) => group.key === key) : undefined;
    if (key && !current) return c.json({ error: 'not_found' }, 404);
    if (groups.some((group) => group.name === name && group.key !== key))
      return c.json({ error: 'name_exists' }, 409);
    const monitor = type !== 'agent',
      agent = type !== 'monitor';
    if (
      current &&
      ((!monitor && current.monitorCount > 0) ||
        (!agent && current.agentCount > 0)) &&
      body.confirm_membership_reset !== true
    )
      return c.json({ error: 'group_members_reset_required' }, 409);
    const db = getDB(c.env),
      pg = db.type === 'postgres',
      arg = (n: number) => (pg ? `$${n}` : '?'),
      now = Math.floor(Date.now() / 1000);
    const writes: { sql: string; params: unknown[] }[] = [];
    let monitorId = current?.monitorId ?? null,
      agentId = current?.agentId ?? null;
    for (const kind of ['monitor', 'agent'] as const) {
      const keep = kind === 'monitor' ? monitor : agent,
        previous = kind === 'monitor' ? monitorId : agentId,
        table = kind === 'monitor' ? 'monitor_groups' : 'agent_groups';
      if (!keep) {
        if (previous) writes.push(...resetWrites(pg, kind, previous));
        if (kind === 'monitor') monitorId = null;
        else agentId = null;
        continue;
      }
      const id = previous ?? crypto.randomUUID();
      writes.push(
        previous
          ? {
              sql: `UPDATE ${table} SET name=${arg(1)},weight=${arg(2)},updated_at=${arg(3)} WHERE id=${arg(4)}`,
              params: [name, weight, now, id],
            }
          : {
              sql: `INSERT INTO ${table}(id,name,weight,created_at,updated_at) VALUES(${[1, 2, 3, 4, 5].map(arg).join(',')})`,
              params: [id, name, weight, now, now],
            },
      );
      if (kind === 'monitor') monitorId = id;
      else agentId = id;
    }
    try {
      await db.commit([...writes, visibilityRevisionWrite(now, pg)]);
    } catch (error) {
      if (
        (error as { code?: string }).code === '23505' ||
        /UNIQUE constraint failed/i.test(String(error))
      )
        return c.json({ error: 'name_exists' }, 409);
      throw error;
    }
    invalidateConfig();
    return c.json(
      {
        ok: true,
        key: monitorId ? `monitor:${monitorId}` : `agent:${agentId}`,
      },
      current ? 200 : 201,
    );
  },
);
groupManagementRoutes.delete('/api/admin/groups/:key', async (c) => {
  const { groups } = await managedGroups(c.env),
    group = groups.find((item) => item.key === c.req.param('key'));
  if (!group) return c.json({ error: 'not_found' }, 404);
  const scope = c.req.query('scope') ?? 'all';
  if (!['all', 'monitor', 'agent'].includes(scope))
    return c.json({ error: 'invalid_request' }, 400);
  const db = getDB(c.env),
    pg = db.type === 'postgres',
    writes: { sql: string; params: unknown[] }[] = [];
  if (scope !== 'agent' && group.monitorId)
    writes.push(...resetWrites(pg, 'monitor', group.monitorId));
  if (scope !== 'monitor' && group.agentId)
    writes.push(...resetWrites(pg, 'agent', group.agentId));
  await db.commit([
    ...writes,
    visibilityRevisionWrite(Math.floor(Date.now() / 1000), pg),
  ]);
  invalidateConfig();
  return c.json({ ok: true });
});
groupManagementRoutes.put('/api/admin/groups/:key/members', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (
    !body ||
    !['monitor', 'agent'].includes(body.kind) ||
    !['add', 'remove'].includes(body.action) ||
    !Array.isArray(body.ids) ||
    !body.ids.length ||
    body.ids.length > 500 ||
    body.ids.some(
      (id: unknown) => typeof id !== 'string' || !id || id.length > 128,
    )
  )
    return c.json({ error: 'invalid_request' }, 400);
  const { groups } = await managedGroups(c.env),
    group = groups.find((item) => item.key === c.req.param('key'));
  if (!group) return c.json({ error: 'not_found' }, 404);
  const id = body.kind === 'monitor' ? group.monitorId : group.agentId;
  if (!id) return c.json({ error: 'invalid_group' }, 400);
  const db = getDB(c.env),
    pg = db.type === 'postgres';
  const table = body.kind === 'monitor' ? 'monitors' : 'agents';
  const groupTable =
    body.kind === 'monitor' ? 'monitor_groups' : 'agent_groups';
  const ids = [...new Set(body.ids as string[])],
    selected = JSON.stringify(ids),
    now = Math.floor(Date.now() / 1000);
  const arg = (n: number) => (pg ? '$' + n : '?' + n);
  const selection = (n: number) =>
    pg
      ? 'SELECT jsonb_array_elements_text(' + arg(n) + '::jsonb)'
      : 'SELECT value FROM json_each(' + arg(n) + ')';
  async function write(
    adapter: DBAdapter,
    locked: boolean,
  ): Promise<'not_found' | 'group_members_assigned' | null> {
    const rows = await adapter.query<{ id: string; group_id: string | null }>(
      'SELECT id,group_id FROM ' +
        table +
        ' WHERE id IN (' +
        selection(1) +
        ')' +
        (locked ? ' FOR UPDATE' : ''),
      [selected],
    );
    if (rows.length !== ids.length) return 'not_found';
    if (body.action === 'add' && rows.some((row) => row.group_id !== null))
      return 'group_members_assigned';
    const guard =
      body.action === 'add'
        ? ' AND (SELECT COUNT(*) FROM ' +
          table +
          ' WHERE id IN (' +
          selection(3) +
          ') AND group_id IS NULL)=' +
          arg(5)
        : ' AND group_id=' + arg(4);
    const statement = {
      sql:
        'UPDATE ' +
        table +
        ' SET group_id=' +
        arg(1) +
        ',updated_at=' +
        arg(2) +
        ' WHERE id IN (' +
        selection(3) +
        ') AND EXISTS(SELECT 1 FROM ' +
        groupTable +
        ' WHERE id=' +
        arg(4) +
        ')' +
        guard,
      params: [
        body.action === 'add' ? id : null,
        now,
        selected,
        id,
        ...(body.action === 'add' ? [ids.length] : []),
      ],
    };
    const revision = visibilityRevisionWrite(now, pg);
    const changed = locked
      ? (await adapter.execute(statement.sql, statement.params)).rowsAffected
      : (await adapter.commit([statement, revision]))[0];
    if (locked) await adapter.execute(revision.sql, revision.params);
    return body.action === 'add' && changed !== ids.length
      ? 'group_members_assigned'
      : null;
  }
  const failure = pg
    ? await db.transaction((tx) => write(tx, true))
    : await write(db, false);
  if (failure)
    return c.json({ error: failure }, failure === 'not_found' ? 404 : 409);
  invalidateConfig();
  return c.json({ ok: true });
});
