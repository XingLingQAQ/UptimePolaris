/**
 * Notification channel routes.
 *
 * Authentication is handled by the admin gate in `src/api.ts`; that gate is
 * also why GET can return each channel's full config, which the edit form
 * needs. Every refusal is a code.
 * 认证由管理入口处理，因此 GET 可以返回完整配置；拒绝一律返回错误码。
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { groupExists } from '../group/groups';
import type { NotificationChannel, NotificationType } from './channels';
import { createChannel, deleteChannel, loadChannels, NOTIFICATION_TYPES, sanitizeConfig, updateChannel, validateConfig } from './channels';
import { loadDeliveryStats, loadRecentDeliveries, recordDelivery } from './delivery-history';
import type { NotifyEvent } from './message';
import { sendToChannel } from './send';
import { isNotificationLanguage } from '../../../../../shared/notification-language';
import { notificationCopy } from './locales';

/** 通知渠道、测试发送和投递记录接口。 / Endpoints for notification channels, test sends, and delivery history. */
export const notifyRoutes = new Hono<{ Bindings: Env }>();

/** Provider types come from notify.ts so this list cannot drift. / 提供商类型来自 notify.ts，避免列表漂移。 */
const TYPES: readonly NotificationType[] = NOTIFICATION_TYPES;

function isType(v: unknown): v is NotificationType {
  return typeof v === 'string' && (TYPES as readonly string[]).includes(v);
}

function invalidLanguage(config: unknown): boolean {
  return config !== null && typeof config === 'object' && 'language' in config && !isNotificationLanguage(config.language);
}

/**
 * An optional field's verdict: absent, valid, or refused.
 *
 * Absent keeps the stored value; `[]` is a real value that clears the scope.
 * A nullable type could not express both, and collapsing them would silently
 * broaden a channel or make it impossible to un-narrow one.
 * 三态不能用可空类型表示；合并会静默扩大范围或无法取消限定。
 */
type Field<T> =
  | { kind: 'absent'; error?: undefined; value?: undefined }
  | { kind: 'ok'; value: T; error?: undefined }
  | { kind: 'bad'; error: string; value?: undefined };

/**
 * A submitted `group_ids`, checked against existing groups.
 *
 * `[]` is a real value: it clears the scope and makes the channel receive
 * every monitor. Only a missing key is "absent" (leave the scope alone).
 * Unknown ids are refused before the write so a half-applied edit cannot
 * exist. Duplicates are collapsed, not rejected.
 * `[]` 表示全部监控；缺失才是“保持不变”。未知 ID 写入前拒绝。
 */
async function readGroupIds(env: Env, raw: unknown): Promise<Field<string[]>> {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (!Array.isArray(raw)) return { kind: 'bad', error: 'group_not_found' };

  /** `[]` is a valid value, not an early return. / `[]` 是有效值，不提前返回。 */
  const ids = raw.filter((v): v is string => typeof v === 'string');
  if (ids.length !== raw.length) return { kind: 'bad', error: 'group_not_found' };

  const unique = [...new Set(ids)];
  if (unique.some((id) => id === '')) return { kind: 'bad', error: 'group_not_found' };

  for (const id of unique) {
    if (!(await groupExists(env, id))) return { kind: 'bad', error: 'group_not_found' };
  }

  return { kind: 'ok', value: unique };
}

// ---------------------------------------------------------------- read
// ---------------------------------------------------------------- 读取 / read

notifyRoutes.get('/api/notifications', async (c) => {
  const channels = await loadChannels(c.env);
  return c.json({ channels });
});

// ---------------------------------------------------------------- create
// ---------------------------------------------------------------- 创建 / create

notifyRoutes.post('/api/notifications', async (c) => {
  let body: {
    name?: string;
    type?: string;
    config?: unknown;
    active?: number;
    group_ids?: unknown;
  };
  try {
    body = await c.req.json<typeof body>();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }

  const name = (body.name ?? '').trim();
  if (!name) return c.json({ error: 'name_required' }, 400);
  if (!isType(body.type)) return c.json({ error: 'invalid_type' }, 400);

  /** Validate before writing so a rejected request leaves no partial channel. / 写入前校验，拒绝的请求不会留下半成品渠道。 */
  if (invalidLanguage(body.config)) return c.json({ error: 'notification_language_invalid' }, 400);
  const config = sanitizeConfig(body.config);
  const bad = validateConfig(body.type, config);
  if (bad) return c.json({ error: bad }, 400);

  /**
   * Omitted `group_ids` on create means every monitor.
   *
   * That is the same storage state as `[]` (no scope rows), and the only safe
   * default: existing clients and pre-scope channels omit the field. Treating
   * omission as "scope to nothing" would create a channel that alerts nobody.
   * 创建时省略 group_ids 表示全部监控；否则会建出谁都不通知的渠道。
   */
  const groupIds = await readGroupIds(c.env, body.group_ids);
  if (groupIds.kind === 'bad') return c.json({ error: groupIds.error }, 400);

  const id = await createChannel(c.env, {
    name,
    type: body.type,
    config,
    // Absent means active: creating a channel and then having to enable it is a
    // step nobody expects, and the console's toggle is right there.
    // 省略表示启用：创建渠道后还须手动启用是用户不会预期的额外步骤，控制台本身也有开关。
    active: body.active === undefined ? 1 : body.active ? 1 : 0,
    ...(groupIds.kind === 'ok' ? { group_ids: groupIds.value } : {}),
  });

  return c.json({ id }, 201);
});

// ---------------------------------------------------------------- update
// ---------------------------------------------------------------- 更新 / update

notifyRoutes.put('/api/notifications/:id', async (c) => {
  const id = c.req.param('id');

  let body: {
    name?: string;
    type?: string;
    config?: unknown;
    active?: number;
    group_ids?: unknown;
  };
  try {
    body = await c.req.json<typeof body>();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }

  const stored = (await loadChannels(c.env)).find((ch) => ch.id === id);
  if (!stored) return c.json({ error: 'not_found' }, 404);

  if (body.name !== undefined && !body.name.trim()) {
    return c.json({ error: 'name_required' }, 400);
  }
  if (body.type !== undefined && !isType(body.type)) {
    return c.json({ error: 'invalid_type' }, 400);
  }

  /** Validate config against the type the row will have after this update. / 按更新后的类型校验配置。 */
  const type = body.type ?? stored.type;
  if (invalidLanguage(body.config)) return c.json({ error: 'notification_language_invalid' }, 400);
  const config = body.config === undefined ? stored.config : sanitizeConfig(body.config);

  const bad = validateConfig(type, config);
  if (bad) return c.json({ error: bad }, 400);

  /**
   * The scope update, and the three-way distinction it must preserve.
   *
   * Absent leaves the stored scope alone; `[]` clears it (every monitor); a
   * non-empty list replaces it wholesale. Collapsing absent into `[]` would
   * silently broaden a channel the operator did not touch, and collapsing `[]`
   * into absent would make it impossible to un-narrow one.
   * 范围三态：缺失保留、`[]` 清空、列表整体替换；两者不能合并。
   */
  const groupIds = await readGroupIds(c.env, body.group_ids);
  if (groupIds.kind === 'bad') return c.json({ error: groupIds.error }, 400);

  const ok = await updateChannel(c.env, id, {
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.type !== undefined ? { type } : {}),
    ...(body.config !== undefined ? { config } : {}),
    ...(body.active !== undefined ? { active: body.active ? 1 : 0 } : {}),
    ...(groupIds.kind === 'ok' ? { group_ids: groupIds.value } : {}),
  });

  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// ------------------------------------------------------------- delivery log
// ------------------------------------------------------------- 投递日志 / delivery log

/**
 * Per-channel delivery stats for the last 24 hours.
 *
 * Kept out of `GET /api/notifications` because the lifetimes differ: a channel
 * row changes on edit, these figures change on every send. A channel with no
 * attempts is absent, not zeroed.
 * 与渠道配置分开，因为数据每次发送都变；无尝试的渠道不填零。
 */
notifyRoutes.get('/api/notifications/stats', async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const channels = await loadDeliveryStats(c.env, now);
  return c.json({ channels, now });
});

/** Recent deliveries, newest first; `limit` is clamped. / 最近投递记录，最新在前；`limit` 会被限制。 */
notifyRoutes.get('/api/notifications/deliveries', async (c) => {
  const raw = Number(c.req.query('limit') ?? 20);
  if (!Number.isInteger(raw)) return c.json({ error: 'invalid_limit' }, 400);
  const limit = Math.max(1, Math.min(100, raw));
  const deliveries = await loadRecentDeliveries(c.env, limit);
  return c.json({ deliveries });
});

// ---------------------------------------------------------------- delete
// ---------------------------------------------------------------- 删除 / delete

notifyRoutes.delete('/api/notifications/:id', async (c) => {
  const id = c.req.param('id');
  const ok = await deleteChannel(c.env, id);
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- test
// ---------------------------------------------------------------- 测试 / test

/** Test send always returns 200 and reports the outcome in `ok`/`error`. / 测试发送始终返回 200，结果放在 `ok`/`error`。 */
notifyRoutes.post('/api/notifications/:id/test', async (c) => {
  const id = c.req.param('id');

  const channel: NotificationChannel | undefined = (await loadChannels(c.env)).find(
    (ch) => ch.id === id,
  );
  if (!channel) return c.json({ ok: false, error: 'not_found' }, 200);

  const copy = notificationCopy(channel.config.language);
  const event: NotifyEvent = {
    monitorName: copy.testName,
    monitorTarget: 'https://example.com',
    monitorType: 'http',
    status: 0,
    prevStatus: 1,
    message: copy.testBody,
    at: Math.floor(Date.now() / 1000),
  };

  // `sendToChannel` does not throw, so there is no try/catch here - only the
  // result, which is what the body reports either way.
  // `sendToChannel` 不抛错，因此这里不需要 try/catch；响应体按结果报告成功或失败。
  const startedAt = Date.now();
  const result = await sendToChannel(channel, event);
  /** A test send is a delivery attempt and is recorded like one. / 测试发送也会写入投递记录。 */
  await recordDelivery(c.env, {
    channelId: channel.id,
    monitorId: null,
    monitorName: null,
    status: event.status,
    ok: result.ok,
    latencyMs: Date.now() - startedAt,
    error: result.error ?? null,
    at: event.at,
  });
  return c.json(result.ok ? { ok: true } : { ok: false, error: result.error }, 200);
});
