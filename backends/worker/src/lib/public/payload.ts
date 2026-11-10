import { PENDING, DOWN as STATUS_DOWN, UP as STATUS_UP, type AddonReading, type Env, type LiveState, type Monitor, type MonitorTag } from '../../types';
import { PROJECT_NAME } from '../../../../../shared/project';
import { isActiveProbeType } from '../../../../../shared/probe-capabilities';
import { agentIsOnline, agentStaleAfterSec } from '../agent/liveness';
import { getDB } from '../db/factory';
import { agentLiveSQL } from '../db/sql/agent';
import { loadGroupsForUi } from '../group/groups';
import { loadMonitorTags } from '../group/tags';
import { rollingAvailability } from '../monitor/availability';
import { loadHeartbeats, loadLive, loadPushHeartbeats } from '../monitor/store';
import { pageMonitors } from '../presentation/context';
import type { PublicMaintenanceNotice } from './maintenance';
import { getProbeSourceState } from './probe-source';
import { publicTarget } from './redaction';

/** Local constants use the same status encoding as types.ts. / 本地常量使用与 types.ts 相同的状态编码。 */
const DOWN = 0;
const WARN = 2;

/** Include the UTC suffix so clients do not parse heartbeat timestamps as local time. / 添加 UTC 后缀，避免客户端将心跳时间戳解析为本地时间。 */
export function toIsoTimestamp(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}
/** Unconfigured site metadata; routes supply values resolved from settings. / 未配置时的站点元数据；路由提供从设置解析出的值。 */
export const SITE = {
  title: PROJECT_NAME,
  description: '服务可用性监控',
  icon: '/api/public/icon',
} as const;

/** The three site fields, resolved from settings (or `SITE` when unconfigured). / 三个站点字段，从设置解析；未配置时使用 `SITE`。 */
export interface SiteMetaInput {
  title: string;
  description: string;
  icon: string;
}

/** Public configuration uses the supplied site metadata. / 公共配置使用传入的站点元数据。 */
export function buildPublicConfig(
  pageId: string,
  site: SiteMetaInput = SITE,
  maintenanceList: PublicMaintenanceNotice[] = [],
) {
  const siteMeta = {
    title: site.title,
    description: site.description,
    icon: site.icon,
    iconCandidates: [site.icon],
  };

  return {
    // --- SPA bootstrap shape ---
    // --- SPA 初始化结构 / SPA bootstrap shape ---
    pageId,
    pageIds: [pageId],
    defaultPageId: pageId,
    siteMeta,
    pages: [{ id: pageId, siteMeta }],
    isPlaceholder: false,
    isEditThisPage: false,
    isShowStarButton: false,

    // Status-page configuration.
    // 状态页配置。
    config: {
      slug: pageId,
      title: site.title,
      description: site.description,
      icon: site.icon,
      theme: 'system',
      published: true,
      /** The public monitor payload supplies tags for the UI to render. / 公共监控数据提供标签，供界面渲染。 */
      showTags: true,
      customCSS: '',
      footerText: '',
      showPoweredBy: false,
      googleAnalyticsId: null,
      showCertificateExpiry: true,
    },
    publicGroupList: [],
    maintenanceList,
    incidents: [],
    success: true,
    status: 'ok' as const,
    pageTabs: [],
    matrixStatus: 'ok' as const,
    timestamp: Date.now(),
  };
}

/**
 * Build the monitor + heartbeat payload for /api/public/monitors.
 *
 * `heartbeats` comes from the in-D1 ring buffer rather than Analytics Engine:
 * AE has no local emulation and costs a read query per call, while the ring
 * buffer is already being written every minute by the check loop.
 * 为 /api/public/monitors 构建监控和心跳数据。`heartbeats` 来自 D1 内的环形缓冲区，
 * 而非 Analytics Engine：AE 没有本地模拟，每次调用消耗一次读取查询；检查循环已每分钟
 * 写入环形缓冲区。
 */
export async function buildPublicMonitorPayload(
  env: Env,
  pageId: string,
  request: Request,
): Promise<{
  success: true;
  monitorGroups: unknown[];
  data: { heartbeatList: Record<string, unknown[]>; uptimeList: Record<string, number | null>; uptimeCoverage: Record<string, number> };
  timestamp: number;
}> {
  const monitors = await pageMonitors(env, request);
  const live = await loadLive(env);
  const heartbeats = await loadHeartbeats(env, monitors.map((m) => m.id));
  const pushHeartbeats = monitors.some((m) => m.type === 'push') ? await loadPushHeartbeats(env) : new Map();
  const db = getDB(env);
  const agentLives = await db.query<Record<string, unknown>>(agentLiveSQL[db.type].allLive);
  const agentById = new Map(agentLives.map((row) => [String(row.agent_id), row]));
  const agentRows = await db.query<Record<string, unknown>>(db.type === 'postgres'
    ? "SELECT id, name, active, options_json FROM agents WHERE 1=1"
    : "SELECT id, name, active, options_json FROM agents WHERE 1=1");
  const agentSources = new Map(agentRows.map((row) => [String(row.id), { ...row, ...agentById.get(String(row.id)) }]));
  const now = Math.floor(Date.now() / 1000);

  // Both are one query for the whole page, and both are read here rather than
  // per monitor inside the loop below - the status page polls this endpoint
  // every 60 seconds, so a per-monitor query would be N round trips per poll.
  // 两项数据都为整个页面各查询一次，而非在下方循环中逐监控读取；状态页每 60 秒轮询
  // 此端点，逐监控查询会导致每次轮询产生 N 次往返。
  const groups = await loadGroupsForUi(env);
  const tags = await loadMonitorTags(env, monitors.map((m) => m.id));

  const heartbeatList: Record<string, unknown[]> = {};
  const uptimeList: Record<string, number | null> = {};
  const uptimeCoverage: Record<string, number> = {};

  const monitorList = monitors.map((m) => {
    let entry = live[m.id];
    const source = getProbeSourceState(m, entry, agentSources, now);
    const agentSource = source.source === 'agent';
    const sourceAvailable = source.source_available;
    const sourcePending = source.source_pending;
    const sourceLastObservedAt = source.source_last_observed_at;
    if (m.type === 'agent') {
      const report = agentById.get(m.agent_id ?? '');
      const reportedAt = toFiniteNumber(report?.reported_at);
      const staleAfterSec = agentStaleAfterSec(toFiniteNumber(report?.report_interval_secs));
      const online = agentIsOnline(reportedAt, now, staleAfterSec);
      if (online === null) {
        entry = { st: PENDING, ts: 0, v: 0, code: 0, msg: 'waiting for first agent report', fails: 0 };
      } else if (online) {
        const evaluated = live[m.id];
        entry = evaluated?.st === WARN
          ? { ...evaluated, ts: reportedAt ?? 0, v: toFiniteNumber(report?.cpu_usage) }
          : { st: STATUS_UP, ts: reportedAt ?? 0, v: toFiniteNumber(report?.cpu_usage), code: 0, msg: String(report?.message ?? ''), fails: 0 };
      } else {
        entry = { st: STATUS_DOWN, ts: reportedAt ?? 0, v: null, code: 0, msg: 'agent is offline', fails: 0 };
      }
    }
    const series = heartbeats.get(m.id) ?? [];

    // Current live state takes precedence over the latest ring entry.
    // 当前实时状态优先于最新环形记录。
    heartbeatList[String(m.num_id)] = series.map((hb, i) => {
      const raw = i === series.length - 1 && !sourceAvailable
        ? PENDING
        : i === series.length - 1 && entry && hb.t >= Math.floor(now / 60) * 60
          ? entry.st
          : hb.up;
      return {
        status: raw,
        time: toIsoTimestamp(hb.t),
        msg: '',
        ping: m.type === 'push' || (i === series.length - 1 && !sourceAvailable) || (m.type === 'agent' && hb.up === STATUS_DOWN) ? null : hb.ms,
      };
    });

    // Availability is a 0..1 ratio; the UI scales it for display.
    // 可用率为 0..1 的比例，界面负责缩放显示。
    const availability = rollingAvailability(live[m.id], now);
    uptimeList[`${m.num_id}_24`] = availability.ratio;
    uptimeCoverage[`${m.num_id}_24`] = availability.coverage;

    // Attached here rather than inside `toUiMonitor` so that function stays pure
    // and testable without a database - the same reason it takes `entry` as an
    // argument instead of reading live_state itself.
    // 在此附加标签而非放进 `toUiMonitor`，使该函数保持纯净且无需数据库即可测试；
    // 它通过参数接收 `entry` 而非自行读取 live_state 也是同一原因。
    return {
      ...toUiMonitor(m, entry),
      ...(m.type === 'push' ? { pushLastReceivedAt: pushHeartbeats.get(m.id)?.ts ?? null, intervalSec: m.interval_sec } : {}),
      ...(agentSource ? {
        source: 'agent',
        sourceAvailable,
        sourcePending,
        sourceLastObservedAt,
      } : isActiveProbeType(m.type) ? { source: 'worker', sourceAvailable } : {}),
      tags: tags.get(m.id) ?? [],
    };
  });

  // Unknown group IDs stay visible in the ungrouped bucket.
  // 未知分组 ID 的监控仍显示在未分组中。
  const byGroup = new Map<string, typeof monitorList>();
  const ungrouped: typeof monitorList = [];

  const known = new Map(groups.map((g) => [g.id, g]));
  for (const [i, m] of monitors.entries()) {
    const card = monitorList[i]!;
    const groupId = m.group_id;
    if (!groupId || !known.has(groupId)) {
      ungrouped.push(card);
      continue;
    }
    const list = byGroup.get(groupId) ?? [];
    list.push(card);
    byGroup.set(groupId, list);
  }

  const groupList: unknown[] = groups
    .filter((g) => (byGroup.get(g.id)?.length ?? 0) > 0)
    .map((g) => ({
      id: g.num_id,
      name: g.name,
      weight: g.weight,
      monitorList: byGroup.get(g.id),
    }));

  /**
   * The bucket that holds monitors in no group.
   *
   * The UI localizes the label when `name` is null and `isUngrouped` is true.
   * 保存未分组监控的类别。`name` 为 null 且 `isUngrouped` 为 true 时，界面本地化标签。
   */
  groupList.push({
    id: 0,
    name: null,
    isUngrouped: true,
    weight: Number.MAX_SAFE_INTEGER,
    monitorList: ungrouped,
  });

  return {
    success: true,
    monitorGroups: groupList,
    data: { heartbeatList, uptimeList, uptimeCoverage },
    timestamp: Date.now(),
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Null leaves the ungrouped label to the client locale. / Null 让客户端按自身语言显示未分组标签。 */

export function publicGroupName(group: { name: string } | undefined): string | null {
  return group ? group.name : null;
}

/** Separate certificate and domain expiry badges; days is null without a readable date. / 证书和域名到期徽标分别展示；无可读取日期时 days 为 null。 */
export interface ExpiryBadge {
  kind: 'ssl' | 'domain';
  /** Days remaining, or null when the add-on could not read a date. / 剩余天数；附加检查无法读取日期时为 null。 */
  days: number | null;
  /** 1 up, 2 warn, 0 down - the add-on's own status, not the monitor's. / 1 正常、2 警告、0 故障；这是附加检查自身状态，而非监控状态。 */
  status: 0 | 1 | 2;
  /** The add-on's message, for a tooltip. / 附加检查消息，供提示使用。 */
  message: string;
}

/** Only enabled add-ons with completed observations produce badges; expired dates retain negative day counts. / 仅启用且已有完成观测的附加检查产生徽标；已过期日期保留负天数。 */
function addonExpiryBadges(
  m: Monitor,
  entry: LiveState[string] | undefined,
): ExpiryBadge[] {
  if (!entry || entry.ts <= 0) return [];

  const readings: Array<[ExpiryBadge['kind'], boolean, AddonReading | undefined]> = [
    ['ssl', Boolean(m.check_ssl), entry.ssl],
    ['domain', Boolean(m.check_domain), entry.domain],
  ];

  const out: ExpiryBadge[] = [];
  for (const [kind, enabled, reading] of readings) {
    // The flag decides which add-ons exist: a reading left in live_state by a
    // flag that has since been switched off is stale, and its badge would
    // outlive the check that produced it until the next tick overwrites it.
    // 标记决定哪些附加检查存在：关闭后仍留在 live_state 中的观测已过期；
    // 若继续显示，其徽标会比对应检查多存续一段时间，直到下次 tick 覆盖它。
    if (!enabled || !reading) continue;
    /** Add-ons have no retry state. / 附加检查没有重试状态。 */
    out.push({
      kind,
      days: reading.days,
      status: reading.st as 0 | 1 | 2,
      message: reading.msg,
    });
  }
  return out;
}

/** Pure public monitor projection; the caller supplies joined tags. / 纯公共监控数据投影；关联标签由调用方提供。 */
export function toUiMonitor(
  m: Monitor,
  entry: LiveState[string] | undefined,
  tags: MonitorTag[] = [],
) {
  const dns = m.check_dns && entry && entry.ts > 0 ? entry.dns : undefined;

  return {
    id: m.num_id,
    name: m.name,
    sendUrl: 0,
    type: m.type,
    url: publicTarget(m.target, m.type),
    expiryBadges: addonExpiryBadges(m, entry),
    /** DNS has no expiry day count and is exposed separately. / DNS 没有到期天数，单独公开。 */
    dns,

    tags,
  };
}
