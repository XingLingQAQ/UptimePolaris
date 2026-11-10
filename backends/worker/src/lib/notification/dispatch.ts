import type { Env } from '../../types';
import { mapConcurrent } from '../concurrency';
import { getDB } from '../db/factory';
import { eventsSQL } from '../db/sql/events';
import type { ExternalRequestBudget } from '../http/request-budget';
import { alertsSuppressed } from '../settings/maintenance';
import { errMsg } from '../util';
import type { NotificationChannel } from './channels';
import { loadChannels } from './channels';
import { recordDelivery } from './delivery-history';
import type { NotifyEvent } from './message';
import { scopeMatches } from './scope';
import { SEND_TIMEOUT_MS, sendToChannel } from './send';

/** Bound simultaneous sends; callers coordinate this with probe egress. / 限制并发发送数；调用方将其与探测外部请求协调。 */
const CONCURRENCY = 6;

/** Queue events for matching active channels, then claim eligible sends; SQL preserves monitor/channel order. / 为匹配的启用渠道将事件入队，再领取可发送项；SQL 保持监控及渠道顺序。 */
export async function dispatch(
  env: Env,
  events: NotifyEvent[],
  timeoutMs = SEND_TIMEOUT_MS,
  budget?: ExternalRequestBudget,
): Promise<void> {
  if (env.AUTOMATIC_NOTIFICATIONS_DISABLED === 'true') return;
  if (events.length === 0) return;
  if ((await alertsSuppressed(env, new Date(Date.now()))).suppressed) return;

  let channels: NotificationChannel[];
  try {
    channels = await loadChannels(env, { activeOnly: true });
  } catch (e) {
    console.error(JSON.stringify({ event: 'notify_failed', phase: 'load', err: errMsg(e) }));
    return;
  }
  if (channels.length === 0) return;

  const sends = channels.flatMap((channel) =>
    events
      .filter((event) => scopeMatches(channel.group_ids, event.groupId))
      .map((event) => ({ channel, event })),
  );

  /** Event references identify transitions that matched no channel. / 使用事件引用识别未匹配任何渠道的状态变化。 */
  const wanted = new Set(sends.map((s) => s.event));
  for (const event of events) {
    if (wanted.has(event)) continue;
    console.error(
      JSON.stringify({
        event: 'notify_unmatched',
        monitor: event.monitorName,
        // The id, not a name: this is a log line, and the name would have to be
        // resolved here with a query whose only reader is a human reading logs.
        // 日志记录 ID 而非名称：解析名称需要额外查询，而结果仅供阅读日志的人使用。
        group: event.groupId ?? null,
        // Stated so the line is not read as "no channels configured" - they
        // exist, they just all named groups this monitor is not in.
        // 明确记录渠道数，避免被误读为“没有配置渠道”；渠道存在，只是其分组都不含此监控。
        channels: channels.length,
      }),
    );
  }

  /** Persist before sending; a failed attempt stays in the outbox for retry. / 发送前先持久化；失败的尝试留在发件箱等待重试。 */
  const db = getDB(env);
  await mapConcurrent(sends, CONCURRENCY, async ({ channel, event }) => {
    const transitionId = `${event.prevStatus ?? 'new'}-${event.status}`;
    const eventId = `${event.monitorId ?? event.monitorName}:${event.eventKey ?? transitionId}@${event.at}`;
    const outboxId = crypto.randomUUID();
    try {
      const inserted = await db.execute(eventsSQL[db.type].insertPending, [outboxId, eventId, channel.id, JSON.stringify({ event, channelId: channel.id }), event.at]);
      if (inserted.rowsAffected === 0) return;
      const now = Math.floor(Date.now() / 1000);
      const claim = await db.execute(eventsSQL[db.type].claimPending, [now + 90, outboxId, now, now, now - 7 * 86400, now - 7 * 86400]);
      if (claim.rowsAffected === 0) return;
    } catch (e) {
      console.error(JSON.stringify({ event: 'notify_outbox_failed', err: errMsg(e) }));
      return;
    }
    const startedAt = Date.now();
    const r = await sendToChannel(channel, event, timeoutMs, budget);
    const elapsed = Date.now() - startedAt;

    /** Delivery-log failures must not turn a successful send into a retry. / 投递日志失败不能使已成功发送的通知被重试。 */
    await recordDelivery(env, {
      channelId: channel.id,
      monitorId: event.monitorId ?? null,
      monitorName: event.monitorName,
      status: event.status,
      ok: r.ok,
      latencyMs: elapsed,
      error: r.error ?? null,
      at: event.at,
    });

    if (!r.ok) {
      // The channel **name** and never its config: this line goes to the log,
      // and a Telegram bot token or a Feishu webhook URL is a credential that
      // would then be readable by anyone with log access.
      // 日志只记录渠道名称，绝不记录配置：Telegram 机器人令牌和飞书 webhook URL
      // 都是凭据，否则任何能读取日志的人都可看到。
      console.error(
        JSON.stringify({
          event: 'notify_failed',
          channel: channel.id,
          name: channel.name,
          type: channel.type,
          monitor: event.monitorName,
          err: r.error ?? 'unknown',
        }),
      );
      const now = Math.floor(Date.now() / 1000);
      try { await db.execute(eventsSQL[db.type].failPending, [now + 30, outboxId]); }
      catch (e) { console.error(JSON.stringify({ event: 'notify_outbox_failed', err: errMsg(e) })); }
    } else {
      try {
        await db.execute(eventsSQL[db.type].deletePending, [eventId, channel.id]);
      } catch (e) {
        console.error(JSON.stringify({ event: 'notify_outbox_delete_failed', err: String(e) }));
      }
    }
    return r;
  });
}

export async function prepareNotificationOutbox(
  env: Env,
  events: NotifyEvent[],
  createdAt: number,
): Promise<{ sql: string; params: unknown[] }[]> {
  // 返回写入语句供调用方与状态变更一起提交，避免事件与通知脱节。
  // Return writes for the caller to commit with the state change, keeping events and notifications together.
  if (env.AUTOMATIC_NOTIFICATIONS_DISABLED === 'true') return [];
  if (events.length === 0) return [];
  const channels = await loadChannels(env, { activeOnly: true });
  if (channels.length === 0) return [];
  const db = getDB(env);
  const writes: { sql: string; params: unknown[] }[] = [];
  const matched = new Set<NotifyEvent>();
  for (const channel of channels) {
    for (const event of events) {
      if (!scopeMatches(channel.group_ids, event.groupId)) continue;
      matched.add(event);
      const transitionId = `${event.prevStatus ?? 'new'}-${event.status}`;
      const eventId = `${event.monitorId ?? event.monitorName}:${event.eventKey ?? transitionId}@${event.at}`;
      writes.push({
        sql: eventsSQL[db.type].insertPending,
        params: [crypto.randomUUID(), eventId, channel.id, JSON.stringify({ event, channelId: channel.id }), createdAt],
      });
    }
  }
  for (const event of events) {
    if (matched.has(event)) continue;
    console.error(JSON.stringify({
      event: 'notify_unmatched',
      monitor: event.monitorName,
      group: event.groupId ?? null,
      channels: channels.length,
    }));
  }
  return writes;
}

export async function retryPending(env: Env, now: number, budget?: ExternalRequestBudget, maxSends = 20): Promise<void> {
  if (env.AUTOMATIC_NOTIFICATIONS_DISABLED === 'true') return;
  if ((await alertsSuppressed(env, new Date(now * 1000))).suppressed) return;
  const db = getDB(env);
  if (now % 86400 < 60) {
    try { await db.execute(eventsSQL[db.type].prunePending, [now - 7 * 86400]); }
    catch (e) { console.error(JSON.stringify({ event: 'notify_outbox_prune_failed', err: errMsg(e) })); }
  }
  let rows: { id: string; event_id: string; channel_id: string; payload_json: string; attempts: number }[];
  try {
    rows = await db.query(eventsSQL[db.type].listPending, [now, now, now - 7 * 86400, now - 7 * 86400, Math.min(20, maxSends)]);
  } catch (e) {
    console.error(JSON.stringify({ event: 'notify_outbox_load_failed', err: errMsg(e) }));
    return;
  }
  if (!rows.length) return;
  let channels: NotificationChannel[];
  try { channels = await loadChannels(env, { activeOnly: true }); }
  catch (e) { console.error(JSON.stringify({ event: 'notify_outbox_channels_failed', err: errMsg(e) })); return; }
  await mapConcurrent(rows, 4, async (row) => {
    if (budget && budget.remaining === 0) return;
    // 领取租约后再发送，避免并发重试重复投递。
    // Claim the lease before sending to prevent duplicate concurrent retries.
    const claim = await db.execute(eventsSQL[db.type].claimPending, [now + 90, row.id, now, now, now - 7 * 86400, now - 7 * 86400]);
    if (claim.rowsAffected === 0) return;
    let payload: { event: NotifyEvent; channelId: string };
    try { payload = JSON.parse(row.payload_json) as typeof payload; }
    catch { await db.execute(eventsSQL[db.type].deletePending, [row.event_id, row.channel_id]); return; }
    const channel = channels.find((item) => item.id === row.channel_id && item.id === payload.channelId);
    if (!channel || !scopeMatches(channel.group_ids, payload.event.groupId)) {
      await db.execute(eventsSQL[db.type].deletePending, [row.event_id, row.channel_id]);
      return;
    }
    const startedAt = Date.now();
    const result = await sendToChannel(channel, payload.event, SEND_TIMEOUT_MS, budget);
    const elapsed = Date.now() - startedAt;

    // A retry is an attempt like any other, so it lands in the same log. Its
    // `at` is the retry's own clock, not the original transition's, which is
    // what lets the console show "last attempt" honestly.
    // 重试也是一次投递尝试，写入同一日志。其 `at` 使用本次重试的时间，而非原状态变化时间，
    // 使控制台显示的“最近尝试”准确。
    await recordDelivery(env, {
      channelId: channel.id,
      monitorId: payload.event.monitorId ?? null,
      monitorName: payload.event.monitorName,
      status: payload.event.status,
      ok: result.ok,
      latencyMs: elapsed,
      error: result.error ?? null,
      at: now,
    });

    if (result.ok) {
      await db.execute(eventsSQL[db.type].deletePending, [row.event_id, row.channel_id]);
      return;
    }
    if (result.error === 'Worker external request budget exhausted') return;
    const delay = Math.min(3600, 30 * 2 ** Math.min(7, row.attempts));
    await db.execute(eventsSQL[db.type].failPending, [now + delay, row.id]);
    console.error(JSON.stringify({ event: 'notify_outbox_retry_failed', channel: channel.id, err: result.error ?? 'unknown' }));
  });
}
