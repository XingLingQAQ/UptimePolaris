import type { SyncResult } from '../../../../../shared/contracts';
import type { DayStat, Env, LiveState } from '../../types';
import { pruneCommands } from '../agent/commands';
import { pruneAgentProbeJobs } from '../agent/probes';
import { queryDaily } from '../analytics-engine';
import { D1Adapter } from '../db/d1';
import { getDB, withDBScope } from '../db/factory';
import { agentLiveSQL } from '../db/sql/agent';
import { eventsSQL } from '../db/sql/events';
import { liveStateSQL } from '../db/sql/live-state';
import { monitorSQL } from '../db/sql/monitors';
import { closeEndedAvailabilityDays } from '../monitor/availability';
import { loadUptime, upsertDay } from '../monitor/store';
import { pruneDeliveries } from '../notification/delivery-history';
import { readAll } from '../settings/store';

/** Process bounded date batches with overlap so delayed Analytics Engine points can be read again. / 分批处理有限日期并保留重叠，使延迟到达的 Analytics Engine 数据可再次读取。 */
const MAX_SYNC_DAYS = 3;
const OVERLAP_DAYS = 2;

/** Retention defaults shared with settings.ts; cleanup uses the resolved runtime values. / 保留期默认值与 settings.ts 共用；清理使用解析后的运行时值。 */
const MAX_DAYS = 400;
const MAX_DETAIL_DAYS = 90;
/** Default for the transition log, which had no time-based pruning before. / 状态变化日志的默认保留期；它过去没有按时间清理。 */
const MAX_EVENT_DAYS = 90;

function dayKeyOffset(daysAgo: number, now = Date.now()): string {
  const d = new Date(now - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function syncDateBuckets(cursor: string | null, latest: string, limit = MAX_SYNC_DAYS): string[] {
  const first = cursor ? shiftDay(cursor, -OVERLAP_DAYS + 1) : shiftDay(latest, -limit + 1);
  const dates: string[] = [];
  for (let date = first; date <= latest && dates.length < limit; date = shiftDay(date, 1)) dates.push(date);
  return dates;
}

export function runSync(env: Env): Promise<SyncResult> {
  return withDBScope(env, async (scopedEnv) => {
    try {
      return await runSyncScoped(scopedEnv);
    } finally {
      const usage = getDB(scopedEnv).getUsage?.();
      if (usage) console.log(JSON.stringify({ event: 'sync_db_usage', ...usage }));
    }
  });
}

async function runSyncScoped(env: Env): Promise<SyncResult> {
  const db = getDB(env);
  const monitors = await db.query<{ id: string; type: string; active?: number }>(monitorSQL[db.type].listAll);
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const configured = Boolean(env.UPTIME && env.CF_ACCOUNT_ID && env.CF_API_TOKEN);
  let days = 0;

  try {
    const exactDays = await materializeEndedNativeDays(env, monitors);
    if (configured) {
      const latest = dayKeyOffset(1);
      let cursor = await readSyncCursor(env);
      const retentionFloor = shiftDay(latest, -89);
      if (!cursor) cursor = shiftDay(latest, -MAX_SYNC_DAYS);
      const minimumCursor = shiftDay(retentionFloor, 1);
      if (cursor < minimumCursor) cursor = minimumCursor;
      const buckets = syncDateBuckets(cursor, latest, MAX_SYNC_DAYS);
      days = buckets.length;
      const storedDays = await loadUptime(env, monitors.map((monitor) => monitor.id));
      for (const day of buckets) {
        attempted++;
        let rows: Awaited<ReturnType<typeof queryDaily>>;
        try {
          rows = await queryDaily(env, day);
        } catch (e) {
          failed++;
          console.error(JSON.stringify({ event: 'sync_query_failed', day, err: String(e) }));
          continue;
        }

        try {
          for (const m of monitors) {
            if (m.type === 'agent') continue;
            if (exactDays.has(`${m.id}:${day}`)) continue;
            const existing = storedDays.get(m.id)?.find((entry) => entry.d === day);
            if (existing?.exact || existing?.avg === null) continue;
            const agg = rows.get(m.id);
            if (!agg || agg.total <= 0) continue;
            const stat: DayStat = {
              d: day,
              t: Math.round(agg.total),
              u: Math.round(agg.up),
              w: Math.round(agg.warn),
              avg: Math.round(agg.avg * 100) / 100,
            };
            await upsertDay(env, m.id, stat);
            const previous = (storedDays.get(m.id) ?? []).filter((entry) => entry.d !== day);
            previous.push(stat);
            storedDays.set(m.id, previous);
          }
          succeeded++;
          if (day > cursor) {
            const nextExpected = shiftDay(cursor, 1);
            if (day === nextExpected) {
              cursor = day;
              await writeSyncCursor(env, cursor);
            }
          }
        } catch (e) {
          failed++;
          console.error(JSON.stringify({ event: 'sync_day_write_failed', day, err: String(e) }));
        }
      }
    }
  } finally {
    /*
      Housekeeping, with the windows read once.

      `readAll` is a single query and is cached for 15s, so reading the three
      retention values here costs one statement on a cold isolate and nothing on
      a warm one - and it keeps the defaults in one place (`settings.ts`) rather
      than having each prune function reach for a different constant.

      清理时只读取一次保留窗口。`readAll` 只执行一次查询并缓存 15 秒，
      因此在冷 isolate 中读取三个保留值只需一条语句，热 isolate 无需额外语句；
      默认值集中在 `settings.ts`，避免各清理函数分别引用不同常量。
    */
    const { values } = await readAll(env);
    const availabilityDays = values['retention.availabilityDays'] as number;
    const detailDays = values['retention.detailDays'] as number;
    const eventDays = values['retention.eventDays'] as number;

    const housekeeping = await Promise.allSettled([
      pruneHistory(env, availabilityDays),
      pruneMachineHistory(env, detailDays),
      pruneEvents(env, eventDays),
      pruneAgentAvailability(env, availabilityDays),
      pruneAgentProbeJobs(env, Math.floor(Date.now() / 1000)),
      // Commands are history once they finish; only terminal rows are removed,
      // so a bug here can never delete work that has not run.
      // 命令完成后成为历史；仅删除终态记录，避免此处错误删除尚未执行的工作。
      pruneCommands(env, Math.floor(Date.now() / 1000) - eventDays * 86400),
      /*
        Delivery history, on the transition log's window.

        `notification_deliveries` gained a row per push attempt and, until now,
        nothing ever removed one - `pruneDeliveries` existed and had no caller.
        That is unbounded growth at exactly the rate alerts fire, and the first
        symptom would be a write failing against the D1 storage limit rather
        than anything pointing at the log.

        `eventDays` rather than a window of its own: both tables answer "what
        happened, and when", the console reads them side by side, and one
        operator-facing setting is easier to reason about than two that can
        silently diverge. The read is the shared `values` snapshot above, so
        this costs no extra statement.

        投递历史使用状态变化日志的保留窗口。`notification_deliveries` 每次推送尝试新增一行，
        过去从未清理：`pruneDeliveries` 存在但没有调用方。它会随告警产生而无界增长，
        首个症状可能是 D1 达到存储上限导致写入失败，而非明显指向日志的问题。
        使用 `eventDays` 而非独立窗口，是因为两张表都回答“何时发生了什么”，控制台并排读取；
        一个面向管理员的设置比两个可能静默分歧的设置更容易理解。这里复用上方 `values`
        快照，不增加数据库语句。
      */
      pruneDeliveries(env, Math.floor(Date.now() / 1000), eventDays),
    ]);
    const failure = housekeeping.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  return {
    days,
    attempted,
    succeeded,
    failed,
    monitors: monitors.length,
    status: !configured ? 'disabled' : failed ? 'partial' : 'complete',
  };
}

async function materializeEndedNativeDays(
  env: Env,
  monitors: { id: string; active?: number }[],
): Promise<Set<string>> {
  const materialized = new Set<string>();
  const db = getDB(env);
  const row = await db.queryOne<{ json: string }>(liveStateSQL[db.type].read, ['all']);
  if (!row?.json) return materialized;
  let state: LiveState;
  try { state = JSON.parse(row.json) as LiveState; }
  catch { return materialized; }
  const completed = closeEndedAvailabilityDays(state, dayKeyOffset(0));
  if (completed.size === 0) return materialized;
  const existing = await loadUptime(env, monitors.map((monitor) => monitor.id));
  const activeById = new Map(monitors.map((monitor) => [monitor.id, monitor.active]));
  for (const [id, day] of completed) {
    if (activeById.get(id) !== 0) continue;
    const previous = existing.get(id)?.find((entry) => entry.d === day.d);
    const exact = previous && (previous.exact || previous.avg === null) && previous.t >= day.t
      ? previous
      : { ...day, avg: previous?.avg ?? day.avg };
    if (!previous || !sameDayStat(previous, exact)) {
      await upsertDay(env, id, exact);
    }
    materialized.add(`${id}:${day.d}`);
  }
  return materialized;
}

function sameDayStat(left: DayStat, right: DayStat): boolean {
  return left.d === right.d && left.t === right.t && left.u === right.u && left.w === right.w &&
    left.avg === right.avg && left.exact === right.exact;
}

async function readSyncCursor(env: Env): Promise<string | null> {
  const db = getDB(env);
  const row = await db.queryOne<{ json: string }>(liveStateSQL[db.type].read, ['sync']);
  try {
    const cursor = (JSON.parse(row?.json ?? '{}') as { cursor?: unknown }).cursor;
    return typeof cursor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cursor) ? cursor : null;
  } catch {
    return null;
  }
}

async function writeSyncCursor(env: Env, cursor: string): Promise<void> {
  const db = getDB(env);
  await db.execute(liveStateSQL[db.type].upsert, ['sync', JSON.stringify({ cursor }), Math.floor(Date.now() / 1000)]);
}

/**
 * Drop days older than the configured window.
 *
 * Only writes when something actually needs trimming, so the steady-state cost
 * is a read-only check. Without this guard every sync would rewrite every blob
 * every day for no reason.
 * 删除早于配置窗口的日期。只有确实需要裁剪时才写入，因此稳定状态只执行只读检查；
 * 没有此保护的话，每天每次同步都会无缘无故重写每个历史数据块。
 */
async function pruneHistory(env: Env, maxDays = MAX_DAYS): Promise<void> {
  const cutoff = dayKeyOffset(maxDays);
  const db = getDB(env);
  const rows = await db.query<{ monitor_id: string; days_json: string }>(
    monitorSQL[db.type].uptimeAllForPrune,
  );

  const now = Math.floor(Date.now() / 1000);
  const pending: { monitor_id: string; days: DayStat[] }[] = [];

  for (const row of rows) {
    let days: DayStat[];
    try {
      days = JSON.parse(row.days_json) as DayStat[];
    } catch {
      continue;
    }
    const kept = days.filter((d) => d.d >= cutoff);
    if (kept.length !== days.length) pending.push({ monitor_id: row.monitor_id, days: kept });
  }

  if (pending.length === 0) return;

  // Atomic on D1 via `batchAll`; on a BEGIN/COMMIT backend the transaction
  // scope carries the same guarantee. See `saveHeartbeats` for the same split.
  // D1 通过 `batchAll` 保证原子性；支持 BEGIN/COMMIT 的后端通过事务作用域提供同样保证。
  // `saveHeartbeats` 也采用相同区分。
  if (db instanceof D1Adapter) {
    await db.batchAll(
      pending.map((p) => ({
        sql: monitorSQL.d1.uptimeUpdateDays,
        params: [JSON.stringify(p.days), now, p.monitor_id],
      })),
    );
    return;
  }
  await db.transaction(async (tx) => {
    for (const p of pending) {
      await tx.execute(monitorSQL[db.type].uptimeUpdateDays, [
        JSON.stringify(p.days),
        now,
        p.monitor_id,
      ]);
    }
  });
}

/** Trim per-minute agent detail after the configured window. / 清理超出配置窗口的 Agent 分钟明细。 */
async function pruneMachineHistory(env: Env, maxDays = MAX_DETAIL_DAYS): Promise<void> {
  const db = getDB(env);
  const cutoff = Math.floor(Date.now() / 1000) - maxDays * 86400;
  try {
    await db.execute(agentLiveSQL[db.type].deleteOldHistory, [cutoff]);
  } catch {
    // Table may not exist on a deployment that has not applied 0012 yet; the
    // monitor DELETE cascade covers it, and tomorrow's sync will prune it.
    // 尚未应用 0012 的部署可能没有此表；监控 DELETE 级联会处理，明天的同步也会清理。
  }
}

/**
 * Trim the transition log.
 *
 * `events` grows one row per status flip and, before this, had no time-based
 * retention at all - only the cascade when a monitor was deleted. On a long-lived
 * deployment with stable monitors that is unbounded growth, and the first symptom
 * would be a write failing against the D1 storage limit rather than anything
 * pointing at the log.
 *
 * One bounded batch per sync (500 rows); a year of backlog therefore drains over
 * a few days rather than in one statement that could blow the statement budget.
 * 清理状态变化日志。每次状态切换都会向 `events` 写入一行；过去只有删除监控时
 * 才级联清理，没有按时间保留的机制。长期运行且监控稳定的部署会无界增长，
 * 首个症状可能是达到 D1 存储上限导致写入失败，而非明显指向日志的问题。
 * 每次同步只处理一个有界批次（500 行），因此一年的积压会在几天内清完，
 * 避免单条语句超过执行预算。
 */
async function pruneEvents(env: Env, maxDays = MAX_EVENT_DAYS): Promise<void> {
  const db = getDB(env);
  const cutoff = Math.floor(Date.now() / 1000) - maxDays * 86400;
  try {
    await db.execute(eventsSQL[db.type].pruneOld, [cutoff]);
  } catch {
    // Same tolerance as the other prunes: a missing table or a locked row must
    // not fail the sync that already did its real work.
    // 与其他清理一样容忍缺表或锁定行，不能让已经完成实际工作的同步因此失败。
  }
}

async function pruneAgentAvailability(env: Env, maxDays = MAX_DAYS): Promise<void> {
  const db = getDB(env);
  const cutoff = Math.floor(Date.now() / 1000) - maxDays * 86400;
  await db.execute(agentLiveSQL[db.type].deleteOldAvailability, [cutoff]);
}

export { MAX_DAYS, MAX_DETAIL_DAYS, MAX_SYNC_DAYS };
