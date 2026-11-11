import { isActiveProbeType } from '../../../../../shared/probe-capabilities';
/**
 * Public status surface: anonymous, edge-cached, always redacted.
 *
 * Redaction is not optional here (admin routes return the same fields
 * unredacted), and the cache key must include `pageId` or one theme's HTML is
 * served under another theme's asset paths. `live_state` is read, never
 * written: a public page load must not race another visitor on the shared row.
 * 公开接口必须脱敏并按 pageId 缓存；只读 live_state。
 */
export const publicRoutes = new Hono<{ Bindings: Env }>();

import { Hono } from 'hono';
import type { Env, Monitor } from '../../types';
import { agentIsOnline, agentStaleAfterSec } from '../agent/liveness';
import { brandIconSvg } from '../brand';
import { getDB } from '../db/factory';
import { agentSQL } from '../db/sql/agent';
import { heartbeatSQL } from '../db/sql/heartbeat';
import { monitorSQL } from '../db/sql/monitors';
import { loadGroups } from '../group/groups';
import { loadMonitorTags } from '../group/tags';
import { isPrivateHost } from '../http/private-host';
import { overallAvailability } from '../monitor/daily-stats';
import { fetchSiteIcon } from '../monitor/icon';
import { loadHeartbeats, loadLive, loadUptime } from '../monitor/store';
import { iconEtag, readSiteIcon } from '../settings/site-icon';
import type { MaintenanceWindow } from '../settings/store';
import { readAll, readSetting, readSiteMetadata } from '../settings/store';
import { pageTheme } from '../theme/registry';
import { pageMonitors, requestPage } from '../presentation/context';
import { publicServers } from '../presentation/servers';
import { buildMaintenanceNotices, maintenanceState, publicMaintenance } from './maintenance';
import { buildPublicConfig, buildPublicMonitorPayload, publicGroupName } from './payload';
import { getProbeSourceState, staleProbeReading } from './probe-source';
import { publicAgentLive, publicMessage, publicTarget } from './redaction';

publicRoutes.get('/api/public/status', async (c) => {
  const monitors = await pageMonitors(c.env, c.req.raw);
  const live = await loadLive(c.env);
  const history = await loadUptime(c.env, monitors.map((m) => m.id));
  const heartbeats = await loadHeartbeats(c.env, monitors.map((m) => m.id));

  /** Load labels for the full page rather than per monitor. / 一次加载整个页面的标签，而非逐监控加载。 */
  const groups = new Map((await loadGroups(c.env)).map((g) => [g.id, g]));
  const tags = await loadMonitorTags(c.env, monitors.map((m) => m.id));
  const db = getDB(c.env);
  const sourceRows = await db.query<Record<string, unknown>>(db.type === 'postgres'
    ? "SELECT m.id, m.name, m.active, m.options_json, ml.version, ml.probe_capabilities, ml.reported_at, ml.report_interval_secs FROM agents m LEFT JOIN machine_live ml ON ml.agent_id=m.id WHERE 1=1"
    : "SELECT m.id, m.name, m.active, m.options_json, ml.version, ml.probe_capabilities, ml.reported_at, ml.report_interval_secs FROM agents m LEFT JOIN machine_live ml ON ml.agent_id=m.id WHERE 1=1");
  const sourceById = new Map(sourceRows.map((row) => [String(row.id), row]));

  const now = Math.floor(Date.now() / 1000);
  return c.json({
    now,
    monitors: monitors.map((m) => {
      const days = history.get(m.id) ?? [];

      const source = getProbeSourceState(m, live[m.id], sourceById, now);
      const sourceAvailable = source.source_available !== false;
      const unavailable = !sourceAvailable;

      /** Unknown or absent group references render as ungrouped; the UI supplies the localized label. / 未知或缺失的分组引用显示为未分组；界面提供本地化标签。 */
      const group = m.group_id ? groups.get(m.group_id) : undefined;

      return {
        id: m.id,
        num_id: m.num_id,
        name: m.name,
        type: m.type,
        target: publicTarget(m.target, m.type),
        st: unavailable ? null : live[m.id]?.st ?? 0,
        msg: unavailable ? 'source unavailable' : publicMessage(m.type, live[m.id]?.st, live[m.id]?.msg ?? ''),
        v: unavailable || m.type === 'push' ? null : live[m.id]?.v ?? 0,
        source: source.source,
        source_pending: source.source_pending,
        source_last_observed_at: source.source_last_observed_at,
        source_available: sourceAvailable,
        ...(!unavailable && days.length ? { uptime: Math.round(overallAvailability(days) * 10000) / 100 } : { uptime: null }),
        days: days.slice(-90),
        /** Raw ring observations with this project's status codes (0/1/2/4). / 环形缓冲区中的原始观测值，使用本项目状态码（0/1/2/4）。 */
        ring: (heartbeats.get(m.id) ?? []).map((point, index, points) => m.type === 'push' || unavailable && index === points.length - 1 ? { ...point, ms: null } : point),
        group_id: m.group_id,
        group: publicGroupName(group),
        // `group: null` marks ungrouped; the frontend localises the heading. / `group: null` 表示未分组；标题由前端本地化。
        is_ungrouped: !group,
        // The same tag shape as `/api/public/monitors`:
        // one tag representation across every read path, so a renderer has one
        // thing to understand.
        // 与 `/api/public/monitors` 使用相同标签结构；所有读取路径共用一种表示，方便渲染器处理。
        tags: tags.get(m.id) ?? [],
      };
    }),
  });
});

/** Response-time series for one monitor, used by the detail chart. / 单个监控的响应时间序列，供详情图表使用。 */
publicRoutes.get('/api/public/status/detail', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id required' }, 400);
  const db = getDB(c.env);
  const visible = await db.queryOne(`SELECT id FROM monitors WHERE id=${db.type === 'postgres' ? '$1' : '?'} AND is_public=1`, [id]);
  if (!visible) return c.json({ error: 'not_found' }, 404);
  const history = await loadUptime(c.env, [id]);
  return c.json({ id, days: history.get(id) ?? [] });
});

/** POST records the latest Push heartbeat. Cron computes transitions and history on its next tick. / POST 记录最新 Push 心跳；定时任务在下次 tick 计算状态变化和历史。 */
publicRoutes.on(['GET', 'POST'], '/api/public/push/:token', async (c) => {
  /** Refuse GET before token lookup so link previews cannot record heartbeats. / 查找令牌前拒绝 GET，避免链接预览记录心跳。 */
  if (c.req.method !== 'POST') {
    c.header('allow', 'POST');
    return c.json({
      error: 'method_not_allowed',
      hint: 'send this heartbeat with POST; GET is refetched by link previews and crawlers and must not record a push',
    }, 405);
  }

  const token = c.req.param('token');

  // Fixed answer for bad tokens; distinguishing cases would be a credential oracle. / 无效 Token 统一返回，区分情况会变成凭据探测。
  const db = getDB(c.env);
  const row = await db.queryOne<{ id: string }>(monitorSQL[db.type].idByPushToken, [token]);
  if (!row) return c.json({ error: 'unknown_token' }, 404);

  /** Push status normalization: 0 DOWN, 2 WARN, every other value UP. / Push 状态规范化：0 为 DOWN，2 为 WARN，其余值为 UP。 */
  const rawStatus = c.req.query('status');
  const status = rawStatus === '0' ? 0 : rawStatus === '2' ? 2 : 1;

  // Bound the stored script status line.
  // 限制存储的脚本状态行长度。
  const msg = (c.req.query('msg') ?? '').slice(0, 200);

  const pingRaw = Number(c.req.query('ping') ?? 0);
  const ping = Number.isFinite(pingRaw) && pingRaw > 0 ? Math.round(pingRaw) : 0;

  const now = Math.floor(Date.now() / 1000);
  await db.execute(heartbeatSQL[db.type].pushUpsert, [row.id, now, status, msg, ping]);

  return c.json({ ok: true });
});

/** Public Agent details omit credentials; history is bounded to at most 1440 minutes. / 公共 Agent 详情不含凭据；历史最多保留 1440 分钟。 */
publicRoutes.get('/api/public/agent/detail/:numId', async (c) => {
  const numId = Number.parseInt(c.req.param('numId'), 10);
  if (!Number.isFinite(numId)) return c.json({ error: 'not_found' }, 404);

  const minutesRaw = Number.parseInt(c.req.query('minutes') ?? '60', 10);
  const minutes = Number.isFinite(minutesRaw)
    ? Math.max(1, Math.min(1440, minutesRaw))
    : 60;

  const db = getDB(c.env);
  const monitor = await db.queryOne<{
    id: string;
    name: string;
    type: string;
    target: string;
    group_id: string | null;
    active: number;
    agent_id: string | null;
  }>(monitorSQL[db.type].agentByNumId, [numId]);
  if (!monitor) return c.json({ error: 'not_found' }, 404);

  const live = await db.queryOne<Record<string, unknown>>(
    agentSQL.live[db.type].getLive,
    [monitor.agent_id],
  );

  const now = Math.floor(Date.now() / 1000);
  const staleAfterSec = agentStaleAfterSec(live?.report_interval_secs as number | string | null);
  const online = live && Number(live.agent_active) === 0 ? false : agentIsOnline(
    live?.reported_at as number | string | null,
    now,
    staleAfterSec,
  );
  const sinceTs = now - minutes * 60;
  const buckets = await db.query<Record<string, unknown>>(
    agentSQL.history[db.type].getRange,
    [monitor.agent_id, sinceTs],
  );

  /** Use monitor_uptime for the same daily availability shown in the admin overview. / 使用 monitor_uptime，确保每日可用率与管理总览一致。 */
  const uptimeByMonitor = await loadUptime(c.env, [monitor.id]);
  const availability = uptimeByMonitor.get(monitor.id) ?? [];

  /** Recent per-check history shared with the monitor detail rail. / 与监控详情状态条共用的近期逐次检查历史。 */
  const ringRows = await loadHeartbeats(c.env, [monitor.id]);

  return c.json({
    now,
    monitor: {
      id: monitor.id,
      num_id: numId,
      name: monitor.name,
      type: 'agent' as const,
      active: monitor.active,
    },
    live: live ? Object.fromEntries(Object.entries(publicAgentLive(live)).filter(([key]) => key !== 'interfaces_json' && key !== 'mounts_json')) : null,
    online,
    staleAfterSec,
    buckets: buckets.map(({ agent_id: _agentId, ...bucket }) => bucket),
    availability,
    ring: ringRows.get(monitor.id) ?? [],
  });
});

/** Public UI payloads follow the shapes defined in lib/ui-api.ts; cache policy is applied by middleware. / 公共界面数据遵循 lib/ui-api.ts 定义的结构；缓存策略由中间件应用。 */
const UI_CACHE = 'public, max-age=0, s-maxage=15';

publicRoutes.get('/api/public/maintenance', async (c) => c.json(
  await publicMaintenance(c.env), 200, { 'cache-control': 'no-store' },
));

publicRoutes.get('/api/public/config', async (c) => {
  const fresh = c.req.query('fresh');
  if (fresh !== undefined && fresh !== '1') return c.json({ error: 'invalid_request' }, 400);
  const pageId = c.req.query('pageId') ?? 'default';
  /** Resolve settings and maintenance notices here; keep buildPublicConfig independent of the database. / 在此解析设置和维护通知，使 buildPublicConfig 不依赖数据库。 */
  const settings = await readAll(c.env);
  const maintenanceOptions = {
    enabled: settings.values['maintenance.enabled'] === true,
    title: settings.values['maintenance.title'] as string,
    description: settings.values['maintenance.description'] as string,
    announcement: { title: settings.values['maintenance.announcementTitle'] as string, description: settings.values['maintenance.announcementDescription'] as string },
  };
  const maintenanceList = buildMaintenanceNotices(
    (settings.values['maintenance.scheduleEnabled'] ? settings.values['alerts.maintenanceWindows'] : []) as MaintenanceWindow[],
    // Epoch seconds, the unit the converter and the rest of the Worker use.
    // Unix 秒数，与转换器和 Worker 其他部分使用的单位一致。
    Math.floor(Date.now() / 1000),
    maintenanceOptions.announcement,
  );
  const context = await requestPage(c.env, c.req.raw);
  const page = context.page;
  const site = await readSiteMetadata(c.env);
  const body = buildPublicConfig(pageId, {
    title: page.title || site.title,
    description: page.description || site.description,
    icon: page.logo || site.icon,
  }, maintenanceList);
  const selected = context.enabled && context.configured ? await pageTheme(c.env, context.kind, page) : null;
  const visibleIds = new Set((context.kind === 'agent'
    ? await publicServers(c.env, c.req.raw)
    : await pageMonitors(c.env, c.req.raw)).map(item => item.id));
  const themeSettings = selected ? Object.fromEntries(selected.definition.options.map(option => {
    const value = page.themeOptions[option.key] ?? option.default ?? null;
    return [option.key, (option.type === 'agent' || option.type === 'monitor') && !visibleIds.has(String(value)) ? null : value];
  })) : null;
  return c.json({ ...body, maintenance: maintenanceState(settings.values['maintenance.scheduleEnabled'] ? settings.values['alerts.maintenanceWindows'] as MaintenanceWindow[] : [], new Date(), maintenanceOptions), config: { ...body.config, theme: page.colorMode, footerText: page.footer, showCertificateExpiry: page.showExpiry },
    presentation: { kind: context.kind, enabled: context.enabled, configured: context.configured,
      layout: page.layout, density: page.density, columns: page.columns, width: page.width,
      accent: page.accent, colorMode: page.colorMode, showHistory: page.showHistory, showLatency: page.showLatency,
      showAvailability: page.showAvailability, showExpiry: page.showExpiry, showCountry: page.showCountry, locale: page.locale },
    theme: selected ? { short: selected.theme.short, name: selected.definition.name, version: selected.version.version } : null,
    theme_settings: themeSettings,
    theme_content_html: selected ? page.contentHtml ?? '' : null,
  }, 200, { 'cache-control': fresh === '1' || context.preview ? 'private, no-store' : UI_CACHE });
});

publicRoutes.get('/api/public/monitors', async (c) => {
  const payload = await buildPublicMonitorPayload(c.env, c.req.raw);
  return c.json(payload, 200, { 'cache-control': UI_CACHE });
});

/** Serve the uploaded icon with an ETag, or generate the default mark using the requested size and container. / 使用 ETag 返回上传图标，或按请求的尺寸和容器生成默认图标。 */
publicRoutes.get('/api/public/icon', async (c) => {
  const uploaded = await readSiteIcon(c.env);
  if (uploaded) {
    const etag = iconEtag(uploaded);
    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch && ifNoneMatch === etag) {
      return c.body(null, 304, { etag, 'cache-control': 'public, max-age=60, must-revalidate' });
    }
    return c.body(uploaded.bytes, 200, {
      'content-type': uploaded.contentType,
      // Browser-only short TTL with revalidation; no edge hold after icon replacement. / 仅浏览器短缓存并重新验证；替换图标后不保留边缘缓存。
      'cache-control': 'public, max-age=60, must-revalidate',
      etag,
      'x-content-type-options': 'nosniff',
      // Serve uploads with a deny-all CSP as a second line behind type sniffing. / 上传内容使用拒绝所有能力的 CSP，作为类型嗅探之外的第二层。
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
  }

  const container = c.req.query('container') === '1';
  // Inline use wants the crop; a favicon or launcher icon wants the padding.
  // `container` implies padding, so it overrides.
  // 内联使用需要裁剪，favicon 或启动器图标需要留白；`container` 蕴含留白，因此优先。
  const tight = c.req.query('tight') === '1' && !container;
  const sizeParam = Number(c.req.query('size'));
  const size = Number.isInteger(sizeParam) && sizeParam >= 8 && sizeParam <= 1024 ? sizeParam : undefined;

  const svg = brandIconSvg({ container, size, tight });

  return c.body(svg, 200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    /** Versioned URLs let browsers pick up revised generated artwork. / 带版本的 URL 使浏览器获取更新后的生成图像。 */
    'cache-control': 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400',
  });
});

/** Proxy monitor favicons only when site.syncMonitorIcons is enabled. / 仅在启用 site.syncMonitorIcons 时代理监控网站图标。 */
publicRoutes.get('/api/public/monitor-icon', async (c) => {
  const id = c.req.query('id');
  const monitor = (await pageMonitors(c.env, c.req.raw)).find(m => m.type === 'http' && m.num_id === Number(id));
  if (!monitor) return c.json({ error: 'not_found' }, 404);
  let parsed: URL;
  try {
    parsed = new URL(monitor.target);
  } catch {
    return c.json({ error: 'invalid_target' }, 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return c.json({ error: 'invalid_target' }, 400);
  /** Reject private literal hosts; fetchSiteIcon also checks redirect destinations. Hostname resolution is not checked here. / 拒绝私有字面主机；fetchSiteIcon 还会检查重定向目标。此处不检查主机名解析结果。 */
  if (isPrivateHost(parsed.hostname)) return c.json({ error: 'not_found' }, 404);

  if (!(await readSetting(c.env, 'site.syncMonitorIcons'))) return c.json({ error: 'not_found' }, 404);

  const icon = await fetchSiteIcon(new URL(`${parsed.protocol}//${parsed.host}/`));
  if (!icon) return c.json({ error: 'not_found' }, 404);
  return c.body(icon.bytes, 200, {
    'content-type': icon.contentType,
    // A favicon changes about never; a day in the browser and a week at the
    // edge keeps origin traffic to roughly one fetch per site per week.
    // favicon 极少变化；浏览器缓存一天、边缘缓存一周，使每站点源站流量约为每周一次请求。
    'cache-control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
    'x-content-type-options': 'nosniff',
  });
});

publicRoutes.get('/api/public/health', (c) => c.json({ ok: true, ts: Date.now() }));

/** Monitor detail keyed by public num_id: live reading, recent checks and up to 90 daily rollups. / 按公共 num_id 查询监控详情：实时观测、近期检查和最多 90 天的汇总。 */
publicRoutes.get('/api/public/monitors/:numId', async (c) => {
  const numId = Number.parseInt(c.req.param('numId'), 10);
  if (!Number.isFinite(numId)) return c.json({ error: 'not found' }, 404);

  const db = getDB(c.env);
  const row = await db.queryOne<Pick<Monitor, 'id' | 'name' | 'type' | 'target' | 'group_id' | 'active' | 'interval_sec' | 'timeout_ms'>>(
    monitorSQL[db.type].publicDetail,
    [numId],
  );
  if (!row) return c.json({ error: 'not found' }, 404);

  const live = await loadLive(c.env);
  const history = await loadUptime(c.env, [row.id]);
  const days = history.get(row.id) ?? [];
  const ring = await loadHeartbeats(c.env, [row.id]);
  const now = Math.floor(Date.now() / 1000);
  const sourceAvailable = isActiveProbeType(row.type)
    ? !staleProbeReading(row, live[row.id], now)
    : live[row.id]?.source_available !== false;

  return c.json({
    id: numId,
    uuid: row.id,
    name: row.name,
    type: row.type,
    target: publicTarget(row.target, row.type),
    group_id: row.group_id,
    active: row.active,
    st: sourceAvailable ? live[row.id]?.st ?? 0 : null,
    msg: sourceAvailable ? publicMessage(row.type, live[row.id]?.st, live[row.id]?.msg ?? '') : 'source unavailable',
    v: sourceAvailable ? live[row.id]?.v ?? 0 : null,
    source_available: sourceAvailable,
    uptime: !sourceAvailable || !days.length ? null : Math.round(overallAvailability(days) * 10000) / 100,
    days: days.slice(-90),
    ring: ring.get(row.id) ?? [],
  });
});
