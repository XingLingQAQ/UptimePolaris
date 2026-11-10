import type { Env, NotificationScope } from '../../types';
import { D1Adapter } from '../db/d1';
import { getDB } from '../db/factory';
import { deliveriesSQL } from '../db/sql/deliveries';
import { placeholderFor } from '../db/sql/dialect';
import { notificationSQL } from '../db/sql/notifications';
import { isNotificationLanguage } from '../../../../../shared/notification-language';

/** Notification providers; keep validation, delivery and console fields aligned when adding one. / 通知提供商；新增时须保持验证、投递和控制台字段一致。 */
export type NotificationType =
  | 'telegram'
  | 'feishu'
  | 'slack'
  | 'discord'
  | 'webhook'
  | 'apprise'
  | 'serverchan';

/** Runtime provider allow-list, checked for completeness against NotificationType below. / 运行时提供商白名单，下方与 NotificationType 比较以检查完整性。 */
export const NOTIFICATION_TYPES = [
  'telegram',
  'feishu',
  'slack',
  'discord',
  'webhook',
  'apprise',
  'serverchan',
] as const;

/** Fail compilation when the runtime allow-list omits a NotificationType. / 运行时白名单遗漏 NotificationType 时使编译失败。 */
type MissingType = Exclude<NotificationType, (typeof NOTIFICATION_TYPES)[number]>;

const _allTypesListed: MissingType extends never ? true : never = true;

void _allTypesListed;

export interface NotificationChannel {
  id: string;
  name: string;
  type: NotificationType;
  /** Parsed from config_json. Never returned raw to a logger. / 从 config_json 解析，绝不向日志器返回原始内容。 */
  config: Record<string, string>;
  /** Group UUIDs; an empty scope accepts every monitor, including ungrouped monitors. / 分组 UUID；空范围接受所有监控，包括未分组监控。 */
  group_ids: NotificationScope;
  active: number;
  created_at: number;
  updated_at: number;
}

export async function loadChannels(
  env: Env,
  opts?: { activeOnly?: boolean },
): Promise<NotificationChannel[]> {
  const db = getDB(env);
  const sql = opts?.activeOnly
    ? notificationSQL[db.type].listActive
    : notificationSQL[db.type].listAll;
  const rows = await db.query<StoredChannel>(sql);
  const channels = rows.map(toChannel);
  if (channels.length === 0) return channels;

  const scopes: { notification_id: string; group_id: string }[] = [];
  for (let offset = 0; offset < channels.length; offset += 80) {
    const batch = channels.slice(offset, offset + 80);
    const placeholders = batch.map(() => '?').join(',');
    scopes.push(...await db.query<{ notification_id: string; group_id: string }>(
      notificationSQL[db.type].scopesForChannels(placeholders),
      batch.map((ch) => ch.id),
    ));
  }

  const byChannel = new Map<string, string[]>();
  for (const row of scopes) {
    const list = byChannel.get(row.notification_id) ?? [];
    list.push(row.group_id);
    byChannel.set(row.notification_id, list);
  }
  // channel with no rows is unscoped, and an unscoped channel is `[]`, which
  // `scopeMatches` reads as "every monitor".
  // 没有关联行的渠道不限制范围；其值为 `[]`，`scopeMatches` 将其解释为“所有监控”。
  for (const ch of channels) ch.group_ids = byChannel.get(ch.id) ?? [];
  return channels;
}

interface StoredChannel {
  id: string;
  name: string;
  type: NotificationType;
  config_json: string;
  active: number;
  created_at: number;
  updated_at: number;
}

function toChannel(row: StoredChannel): NotificationChannel {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: parseConfig(row.config_json),
    // `groups` is loaded with the channel; empty means every group. / `groups` 随渠道加载；空表示全部。
    group_ids: [],
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Keep only string config values; drop the rest instead of coercing. / 只保留字符串配置值，其余丢弃而不强转。 */
export function sanitizeConfig(v: unknown): Record<string, string> {
  if (v === null || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function parseConfig(json: string): Record<string, string> {
  try {
    return sanitizeConfig(JSON.parse(json));
  } catch {
    return {};
  }
}

/**
 * Create a channel; omitting `group_ids` stores no scope rows, which means
 * every monitor. Scope rows are a second statement, so a failure between them
 * leaves a channel that receives more than asked — the safe direction.
 * 创建渠道；省略 `group_ids` 表示全部监控，范围写入失败只会多收不会少收。
 */
export async function createChannel(
  env: Env,
  input: {
    name: string;
    type: NotificationType;
    config: Record<string, string>;
    group_ids?: string[];
    active?: number;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const db = getDB(env);
  await db.execute(notificationSQL[db.type].insert, [
    id,
    input.name,
    input.type,
    JSON.stringify(input.config),
    input.active ?? 1,
    now,
    now,
  ]);

  if (input.group_ids !== undefined) await setChannelGroups(env, id, input.group_ids);
  return id;
}

/**
 * Partial update; omitted fields keep their stored value.
 *
 * `config` replaces the whole object, because the form edits every provider
 * field at once and a merge would make an emptied input indistinguishable
 * from an omitted one. `group_ids` follows the same rule, with `[]` meaning
 * "clear the scope" and absent meaning "leave it alone" — test against
 * `undefined`, never truthiness or length.
 * `config` 整体替换；`group_ids` 用 undefined 判断，`[]` 清空范围。
 */
export async function updateChannel(
  env: Env,
  id: string,
  input: Partial<{
    name: string;
    type: NotificationType;
    config: Record<string, string>;
    group_ids: string[];
    active: number;
  }>,
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const db = getDB(env);
  let position = 1;
  const token = () => placeholderFor(db.type, position++);

  if (input.name !== undefined) {
    sets.push(`name = ${token()}`);
    values.push(input.name);
  }
  if (input.type !== undefined) {
    sets.push(`type = ${token()}`);
    values.push(input.type);
  }
  if (input.config !== undefined) {
    sets.push(`config_json = ${token()}`);
    values.push(JSON.stringify(input.config));
  }
  /** `active` is checked against undefined so paused (0) is not ignored. / `active` 用 undefined 判断，避免忽略暂停值 0。 */
  if (input.active !== undefined) {
    sets.push(`active = ${token()}`);
    values.push(input.active ? 1 : 0);
  }

  /** A scope-only update still touches `updated_at`; a no-op request reads, not writes. / 只改范围也要更新 `updated_at`；无变更请求只读不写。 */
  const touched = sets.length > 0 || input.group_ids !== undefined;
  if (!touched) return (await loadChannels(env)).some((ch) => ch.id === id);

  sets.push(`updated_at = ${token()}`);
  values.push(Math.floor(Date.now() / 1000));
  const idPlaceholder = placeholderFor(db.type, position);
  values.push(id);

  const r = await db.execute(
    notificationSQL[db.type].updateById(sets.join(', '), idPlaceholder),
    values,
  );
  if (r.rowsAffected === 0) return false;

  // After the column update, and only once the row is known to exist: the scope
  // write would otherwise create rows for a channel id that names nothing.
  // 在更新列之后且确认记录存在后才写范围，否则可能为不存在的渠道 ID 创建关联行。
  if (input.group_ids !== undefined) await setChannelGroups(env, id, input.group_ids);
  return true;
}

/**
 * Replace a channel's scope wholesale in one batch.
 *
 * Same reasoning as tag replacement: the picker sends the chosen set, merging
 * loses removals, and one transaction prevents a concurrent dispatch from
 * seeing the channel briefly unscoped. Caller validates ids first.
 * 整体替换；同事务避免并发发送读到未限定范围的中间态。
 */
async function setChannelGroups(env: Env, id: string, groupIds: string[]): Promise<void> {
  const unique = [...new Set(groupIds)];
  const db = getDB(env);

  // Atomic on D1 via `batchAll` (one transaction holding every DELETE/INSERT).
  // On a BEGIN/COMMIT backend the same invariant is expressed with a scope.
  // D1 通过 `batchAll` 原子提交（一个事务包含全部 DELETE/INSERT）；
  // BEGIN/COMMIT 后端通过事务作用域保证相同不变量。
  if (db instanceof D1Adapter) {
    const statements: { sql: string; params: unknown[] }[] = [
      { sql: notificationSQL.d1.deleteScopeForChannel, params: [id] },
    ];
    for (const groupId of unique) {
      statements.push({ sql: notificationSQL.d1.insertScope, params: [id, groupId] });
    }
    await db.batchAll(statements);
    return;
  }
  await db.transaction(async (tx) => {
    await tx.execute(notificationSQL[db.type].deleteScopeForChannel, [id]);
    for (const groupId of unique) {
      await tx.execute(notificationSQL[db.type].insertScope, [id, groupId]);
    }
  });
}

/**
 * Delete a channel, its scope rows and its delivery history in one batch.
 *
 * Delivery rows carry `channel_id` and `/stats` aggregates by that column
 * without joining `notifications`; if they survived, a deleted channel would
 * keep contributing to `sent24h` and look like sends from nowhere. The first
 * DELETE's `changes` answers whether the channel existed (the route's 404).
 * 一次批量删除渠道、范围行和投递历史；否则已删除渠道仍会计入统计。
 */
export async function deleteChannel(env: Env, id: string): Promise<boolean> {
  const db = getDB(env);

  // Single transaction; the first DELETE's changes is the 404 signal. / 单事务；首个 DELETE 的变更数决定 404。
  if (db instanceof D1Adapter) {
    const changes = await db.batchAll([
      { sql: notificationSQL.d1.delete, params: [id] },
      { sql: notificationSQL.d1.deleteScopeForChannel, params: [id] },
      { sql: deliveriesSQL.d1.deleteForChannel, params: [id] },
    ]);
    return (changes[0] ?? 0) > 0;
  }
  return db.transaction(async (tx) => {
    const r = await tx.execute(notificationSQL[db.type].delete, [id]);
    await tx.execute(notificationSQL[db.type].deleteScopeForChannel, [id]);
    await tx.execute(deliveriesSQL[db.type].deleteForChannel, [id]);
    return r.rowsAffected > 0;
  });
}

/**
 * Validate a channel config; returns an error code or null.
 *
 * Codes because the console translates them. URL fields must be `https:`:
 * these URLs carry a credential in the path or are the credential itself, and
 * `http://` would put it on the wire in the clear.
 * URL 字段必须是 https，否则凭据会明文传输。
 */
export function validateConfig(
  type: NotificationType,
  config: Record<string, string>,
): string | null {
  if (config.language !== undefined && !isNotificationLanguage(config.language)) return 'notification_language_invalid';
  /** Shared rule for the providers whose whole config is one webhook URL. / 整个配置只有一个 webhook URL 的提供商共用规则。 */
  const requireHttpsUrl = (field: string, code: string): string | null => {
    const url = config[field]?.trim();
    if (!url) return code;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return code;
      if (!parsed.hostname) return code;
    } catch {
      return code;
    }
    return null;
  };

  switch (type) {
    case 'telegram':
      if (!config.bot_token?.trim()) return 'telegram_token_required';
      if (!config.chat_id?.trim()) return 'telegram_chat_required';
      return null;

    case 'feishu':
      return requireHttpsUrl('webhook_url', 'feishu_url_invalid') === null
        ? null
        : config.webhook_url?.trim()
          ? 'feishu_url_invalid'
          : 'feishu_url_required';

    case 'slack':
      // A Slack incoming-webhook URL is a credential: anyone holding it can post
      // to the channel. Hence https, and hence not accepting a bare channel name.
      // Slack incoming-webhook URL 是凭据：持有者可向渠道发帖，因此要求 HTTPS，
      // 也不接受仅有渠道名称的值。
      return requireHttpsUrl('webhook_url', 'slack_url_invalid') === null
        ? null
        : config.webhook_url?.trim()
          ? 'slack_url_invalid'
          : 'slack_url_required';

    case 'discord':
      return requireHttpsUrl('webhook_url', 'discord_url_invalid') === null
        ? null
        : config.webhook_url?.trim()
          ? 'discord_url_invalid'
          : 'discord_url_required';

    case 'apprise': {
      /** Apprise needs `url` plus either `urls` or `key`; missing both would notify nobody. / Apprise 需要 `url` 加上 `urls` 或 `key`，两者都缺会无人收到通知。 */
      const urlError = requireHttpsUrl('url', 'apprise_url_invalid');
      if (urlError) return config.url?.trim() ? 'apprise_url_invalid' : 'apprise_url_required';
      if (!config.key?.trim() && !config.urls?.trim()) return 'apprise_urls_required';
      return null;
    }

    case 'serverchan':
      if (!config.sendkey?.trim()) return 'serverchan_key_required';
      return /^sctp\d+t[A-Za-z0-9_-]+$/.test(config.sendkey.trim()) ? null : 'serverchan_key_invalid';

    case 'webhook':
      return requireHttpsUrl('url', 'webhook_url_invalid') === null
        ? null
        : config.url?.trim()
          ? 'webhook_url_invalid'
          : 'webhook_url_required';

    default:
      // Unknown type from a newer deployment: refuse rather than pass silently. / 来自更新版本的未知类型：拒绝而不是静默通过。
      return 'unsupported_type';
  }
}
