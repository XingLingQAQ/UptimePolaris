

import { pgPlaceholders } from './dialect';

const d1 = {
  /** Active monitors, in creation order, for the tick and the status page. / 按创建顺序返回启用的监控，供 tick 和状态页使用。 */
  listActive: 'SELECT * FROM monitors WHERE active = 1 ORDER BY created_at',
  /** Every monitor, including paused - the admin panel's list. / 所有监控（含已暂停），供管理面板列表使用。 */
  listAll: 'SELECT * FROM monitors ORDER BY created_at',
  /** What `PUT /api/monitors/:id` reads before applying a type change. / `PUT /api/monitors/:id` 更改类型前读取的数据。 */
  storedForUpdate:
    'SELECT type, target, check_ssl, check_domain, check_dns, options_json, push_token, agent_id, is_public FROM monitors WHERE id = ?',
  /** One monitor by id including paused rows, so manual check can distinguish 404 from 409. / 按 ID 取监控（含暂停），让手动检查区分 404 和 409。 */
  byId: 'SELECT * FROM monitors WHERE id = ?',
  /** Public detail by `num_id`, the id the status page uses. / 按 `num_id` 取公开详情，这是状态页使用的 ID。 */
  publicDetail:
    'SELECT id, name, type, target, group_id, active, interval_sec, timeout_ms FROM monitors WHERE num_id = ? AND is_public = 1',
  /** Public agent detail by numeric id; `type = 'agent'` guards against other types. / 按数字 ID 取 Agent 公开详情；`type = 'agent'` 防止类型不符。 */
  agentByNumId:
    "SELECT id, name, type, target, group_id, active, agent_id FROM monitors WHERE num_id = ? AND type = 'agent' AND is_public = 1",
  /** Resolve a push token to its monitor. Public push endpoint. / 将 Push 令牌解析为监控，供公共 Push 端点使用。 */
  idByPushToken: 'SELECT id FROM monitors WHERE push_token = ?',
  insert: `INSERT INTO monitors (id,num_id,name,type,target,method,expected_status,keyword,interval_sec,timeout_ms,warn_days,check_ssl,check_domain,check_dns,options_json,push_token,agent_id,is_public,group_id,active,created_at,updated_at) VALUES (?,(SELECT COALESCE(MAX(num_id),0)+1 FROM monitors),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
  update: `UPDATE monitors SET
       name = COALESCE(?, name), type = ?, target = ?,
       method = COALESCE(?, method), expected_status = COALESCE(?, expected_status),
       keyword = COALESCE(?, keyword), interval_sec = COALESCE(?, interval_sec),
       timeout_ms = COALESCE(?, timeout_ms), warn_days = COALESCE(?, warn_days),
       check_ssl = ?, check_domain = ?, check_dns = ?,
       options_json = ?, push_token = ?, agent_id = ?, is_public = COALESCE(?, is_public),
       active = COALESCE(?, active),
       updated_at = ?
     WHERE id = ?`,
  setGroup: 'UPDATE monitors SET group_id = ?, updated_at = ? WHERE id = ?',
  delete: 'DELETE FROM monitors WHERE id = ?',
  /** Cascade DELETEs issued on monitor removal. / 删除监控时执行的级联 DELETE。 */
  deleteUptime: 'DELETE FROM monitor_uptime WHERE monitor_id = ?',
  deleteEvents: 'DELETE FROM events WHERE monitor_id = ?',
  deleteHeartbeatRing: 'DELETE FROM heartbeat_ring WHERE id = ?',
  deletePushHeartbeats: 'DELETE FROM push_heartbeats WHERE monitor_id = ?',
  deleteMonitorTags: 'DELETE FROM monitor_tags WHERE monitor_id = ?',
  deleteAgentAvailability: 'DELETE FROM agent_uptime_daily WHERE monitor_id = ?',
  deleteAgentProbeJobs: 'DELETE FROM agent_probe_jobs WHERE monitor_id = ?',
  deletePendingNotifications: "DELETE FROM pending_notifications WHERE json_extract(payload_json, '$.event.monitorId') = ?",
  removeLiveEntry: "UPDATE live_state SET json = json_remove(json, ?) WHERE id = 'all'",

  /** `monitor_uptime` reads / writes. / `monitor_uptime` 读写。 */
  uptimeForIds: (placeholders: string) =>
    `SELECT monitor_id, days_json FROM monitor_uptime WHERE monitor_id IN (${placeholders})`,
  uptimeDaysForOne: 'SELECT days_json FROM monitor_uptime WHERE monitor_id = ?',
  uptimeUpsert: `INSERT INTO monitor_uptime (monitor_id, days_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(monitor_id) DO UPDATE SET
       days_json = excluded.days_json, updated_at = excluded.updated_at`,
  uptimeAllForPrune: 'SELECT monitor_id, days_json FROM monitor_uptime',
  uptimeUpdateDays:
    'UPDATE monitor_uptime SET days_json = ?, updated_at = ? WHERE monitor_id = ?',
} as const;

type MonitorSQL = {
  [K in keyof typeof d1]: (typeof d1)[K] extends string ? string : (typeof d1)[K];
};

/** Postgres dialect: same statements with `$n`, `EXCLUDED`, and the same `num_id` subquery. / Postgres 方言：相同语句，使用 `$n`、`EXCLUDED` 和同样的 `num_id` 子查询。 */
const postgres: MonitorSQL = {
  listActive: 'SELECT * FROM monitors WHERE active = 1 ORDER BY created_at',
  listAll: 'SELECT * FROM monitors ORDER BY created_at',
  storedForUpdate:
    'SELECT type, target, check_ssl, check_domain, check_dns, options_json, push_token, agent_id, is_public FROM monitors WHERE id = $1',
  byId: 'SELECT * FROM monitors WHERE id = $1',
  publicDetail:
    'SELECT id, name, type, target, group_id, active, interval_sec, timeout_ms FROM monitors WHERE num_id = $1 AND is_public = 1',
  agentByNumId:
    "SELECT id, name, type, target, group_id, active, agent_id FROM monitors WHERE num_id = $1 AND type = 'agent' AND is_public = 1",
  idByPushToken: 'SELECT id FROM monitors WHERE push_token = $1',
  insert: `INSERT INTO monitors (id,num_id,name,type,target,method,expected_status,keyword,interval_sec,timeout_ms,warn_days,check_ssl,check_domain,check_dns,options_json,push_token,agent_id,is_public,group_id,active,created_at,updated_at)
    VALUES ($1,(SELECT COALESCE(MAX(num_id),0)+1 FROM monitors),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,1,$19,$20)`,
  update: `UPDATE monitors SET name=COALESCE($1,name), type=$2, target=$3,
    method=COALESCE($4,method), expected_status=COALESCE($5,expected_status), keyword=COALESCE($6,keyword),
    interval_sec=COALESCE($7,interval_sec), timeout_ms=COALESCE($8,timeout_ms), warn_days=COALESCE($9,warn_days),
    check_ssl=$10, check_domain=$11, check_dns=$12, options_json=$13, push_token=$14, agent_id=$15,
    is_public=COALESCE($16,is_public), active=COALESCE($17,active), updated_at=$18 WHERE id=$19`,
  setGroup: 'UPDATE monitors SET group_id = $1, updated_at = $2 WHERE id = $3',
  delete: 'DELETE FROM monitors WHERE id = $1',
  deleteUptime: 'DELETE FROM monitor_uptime WHERE monitor_id = $1',
  deleteEvents: 'DELETE FROM events WHERE monitor_id = $1',
  deleteHeartbeatRing: 'DELETE FROM heartbeat_ring WHERE id = $1',
  deletePushHeartbeats: 'DELETE FROM push_heartbeats WHERE monitor_id = $1',
  deleteMonitorTags: 'DELETE FROM monitor_tags WHERE monitor_id = $1',
  deleteAgentAvailability: 'DELETE FROM agent_uptime_daily WHERE monitor_id = $1',
  deleteAgentProbeJobs: 'DELETE FROM agent_probe_jobs WHERE monitor_id = $1',
  deletePendingNotifications: "DELETE FROM pending_notifications WHERE payload_json::jsonb #>> '{event,monitorId}' = $1",
  removeLiveEntry: "UPDATE live_state SET json = (json::jsonb - $1)::text WHERE id = 'all'",

  uptimeForIds: (placeholders: string) =>
    `SELECT monitor_id, days_json FROM monitor_uptime WHERE monitor_id IN (${pgPlaceholders(placeholders)})`,
  uptimeDaysForOne: 'SELECT days_json FROM monitor_uptime WHERE monitor_id = $1',
  uptimeUpsert: `INSERT INTO monitor_uptime (monitor_id, days_json, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(monitor_id) DO UPDATE SET
       days_json = EXCLUDED.days_json, updated_at = EXCLUDED.updated_at`,
  uptimeAllForPrune: 'SELECT monitor_id, days_json FROM monitor_uptime',
  uptimeUpdateDays:
    'UPDATE monitor_uptime SET days_json = $1, updated_at = $2 WHERE monitor_id = $3',
};

/** 监控配置及其关联数据的双数据库语句。 / D1 and Postgres statements for monitor configuration and related data. */
export const monitorSQL: Record<'d1' | 'postgres', MonitorSQL> = {
  d1,
  postgres,
  // later override entries here if its transaction scope needs different SQL.
  // 如事务作用域需要不同的 SQL，之后可在此覆盖对应条目。
};
