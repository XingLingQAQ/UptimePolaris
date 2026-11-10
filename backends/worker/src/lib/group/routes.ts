/**
 * Group and tag routes.
 *
 * The admin gate in `src/api.ts` handles authentication, so these paths must
 * not be added to its public list; a group or tag is console furniture. Every
 * refusal is a code, not a sentence, so the console can translate it.
 * 认证由管理入口处理；这些路径不能加入公开列表，拒绝一律返回错误码。
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { createGroup, deleteGroup, loadGroups, updateGroup } from './groups';
import { createTag, deleteTag, loadTags, updateTag } from './tags';

/** 监控分组和标签的管理接口。 / Management endpoints for monitor groups and tags. */
export const groupTagRoutes = new Hono<{ Bindings: Env }>();

/** The one length rule both names share. / 两种名称共用的长度规则。 */
const NAME_MAX = 64;

/** Tag colour must be `#RRGGBB`; shorthand and alpha are refused. / 标签颜色必须是 `#RRGGBB`，拒绝简写和透明通道。 */
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Optional field result: absent keeps the stored value, invalid is refused. / 可选字段结果：缺失保留原值，非法则拒绝。 */
type Field<T> =
  | { kind: 'absent'; error?: undefined; value?: undefined }
  | { kind: 'ok'; value: T; error?: undefined }
  | { kind: 'bad'; error: string; value?: undefined };

/** Trimmed non-empty name; blank and over-long are distinct codes. / 去除空白后的非空名称；空和超长使用不同错误码。 */
function readName(raw: unknown): Field<string> {
  if (typeof raw !== 'string') return { kind: 'absent' };
  const name = raw.trim();
  if (!name) return { kind: 'bad', error: 'name_required' };
  if (name.length > NAME_MAX) return { kind: 'bad', error: 'name_invalid' };
  return { kind: 'ok', value: name };
}

/** Integer weight only; fractional and numeric strings are refused. / 只接受整数权重；拒绝小数和数字字符串。 */
function readWeight(raw: unknown): Field<number> {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return { kind: 'bad', error: 'weight_invalid' };
  }
  return { kind: 'ok', value: raw };
}

/** A submitted `color`, against `COLOR_RE`. / 使用 `COLOR_RE` 验证提交的 `color`。 */
function readColor(raw: unknown): Field<string> {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (typeof raw !== 'string' || !COLOR_RE.test(raw)) {
    return { kind: 'bad', error: 'color_invalid' };
  }
  return { kind: 'ok', value: raw };
}

/** Read a JSON object body; malformed and missing both become `name_required`. / 读取 JSON 对象；格式错误和缺字段都返回 `name_required`。 */
async function readJson(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json<unknown>();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Did this write fail on the UNIQUE index for `<table>.name`?
 *
 * SQLite exposes the constraint only in the message, so match table and column,
 * not just "UNIQUE": a primary-key violation would be a bug in this file and
 * must not be reported as `name_taken`. A pre-check SELECT would race.
 * 只匹配表名和列名；主键冲突是代码 bug，不能报成 name_taken。
 */
function isNameTaken(e: unknown, table: 'monitor_groups' | 'tags'): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(message) && message.includes(`${table}.name`);
}

// ---------------------------------------------------------------- groups
// ---------------------------------------------------------------- 分组 / groups

groupTagRoutes.get('/api/groups', async (c) => {
  return c.json({ groups: await loadGroups(c.env) });
});

groupTagRoutes.post('/api/groups', async (c) => {
  const body = await readJson(c);

  const name = readName(body.name);
  if (name.kind === 'bad') return c.json({ error: name.error }, 400);
  if (name.kind === 'absent') return c.json({ error: 'name_required' }, 400);

  const weight = readWeight(body.weight);
  if (weight.kind === 'bad') return c.json({ error: weight.error }, 400);

  try {
    const id = await createGroup(c.env, {
      name: name.value,
      ...(weight.kind === 'ok' ? { weight: weight.value } : {}),
    });
    return c.json({ id }, 201);
  } catch (e) {
    if (isNameTaken(e, 'monitor_groups')) return c.json({ error: 'name_taken' }, 400);
    throw e;
  }
});

groupTagRoutes.put('/api/groups/:id', async (c) => {
  const id = c.req.param('id');
  const body = await readJson(c);

  /** Unmentioned fields stay; mentioned fields are validated even when unchanged. / 未提及字段保持；提及的字段即使未变也校验。 */
  const name = readName(body.name);
  if (name.kind === 'bad') return c.json({ error: name.error }, 400);

  const weight = readWeight(body.weight);
  if (weight.kind === 'bad') return c.json({ error: weight.error }, 400);

  let ok: boolean;
  try {
    ok = await updateGroup(c.env, id, {
      ...(name.kind === 'ok' ? { name: name.value } : {}),
      ...(weight.kind === 'ok' ? { weight: weight.value } : {}),
    });
  } catch (e) {
    if (isNameTaken(e, 'monitor_groups')) return c.json({ error: 'name_taken' }, 400);
    throw e;
  }

  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

groupTagRoutes.delete('/api/groups/:id', async (c) => {
  const ok = await deleteGroup(c.env, c.req.param('id'));
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- tags
// ---------------------------------------------------------------- 标签 / tags

groupTagRoutes.get('/api/tags', async (c) => {
  return c.json({ tags: await loadTags(c.env) });
});

groupTagRoutes.post('/api/tags', async (c) => {
  const body = await readJson(c);

  const name = readName(body.name);
  if (name.kind === 'bad') return c.json({ error: name.error }, 400);
  if (name.kind === 'absent') return c.json({ error: 'name_required' }, 400);

  const color = readColor(body.color);
  if (color.kind === 'bad') return c.json({ error: color.error }, 400);

  try {
    const id = await createTag(c.env, {
      name: name.value,
      ...(color.kind === 'ok' ? { color: color.value } : {}),
    });
    return c.json({ id }, 201);
  } catch (e) {
    if (isNameTaken(e, 'tags')) return c.json({ error: 'name_taken' }, 400);
    throw e;
  }
});

groupTagRoutes.put('/api/tags/:id', async (c) => {
  const id = c.req.param('id');
  const body = await readJson(c);

  const name = readName(body.name);
  if (name.kind === 'bad') return c.json({ error: name.error }, 400);

  const color = readColor(body.color);
  if (color.kind === 'bad') return c.json({ error: color.error }, 400);

  let ok: boolean;
  try {
    ok = await updateTag(c.env, id, {
      ...(name.kind === 'ok' ? { name: name.value } : {}),
      ...(color.kind === 'ok' ? { color: color.value } : {}),
    });
  } catch (e) {
    if (isNameTaken(e, 'tags')) return c.json({ error: 'name_taken' }, 400);
    throw e;
  }

  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

groupTagRoutes.delete('/api/tags/:id', async (c) => {
  const ok = await deleteTag(c.env, c.req.param('id'));
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});
