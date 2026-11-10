/** Agent SQL by dialect. Static and dynamic upserts update separate column sets so either report can arrive first. / 按方言划分的 Agent SQL；静态和动态 upsert 更新不同列，因此两种上报可按任意顺序到达。 */

const d1 = {
  isActive: 'SELECT active FROM agents WHERE id = ?',
  /** Identity reports update updated_at but do not advance the metrics clock reported_at. / 身份上报更新 updated_at，但不推进指标时间 reported_at。 */
  upsertStatic: `INSERT INTO machine_live
       (agent_id, os, arch, kernel, cpu_model, cpu_cores,
        public_ip, public_ipv6, isp, region, virtualization, transport, version, report_interval_secs, probe_capabilities,
        updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       os             = excluded.os,
       arch           = excluded.arch,
       kernel         = excluded.kernel,
       cpu_model      = excluded.cpu_model,
       cpu_cores      = excluded.cpu_cores,
       public_ip      = excluded.public_ip,
       public_ipv6    = excluded.public_ipv6,
       isp            = excluded.isp,
       region         = excluded.region,
       virtualization = excluded.virtualization,
       transport      = excluded.transport,
       version        = excluded.version,
       report_interval_secs = excluded.report_interval_secs,
       probe_capabilities = excluded.probe_capabilities,
       updated_at     = excluded.updated_at`,

  /** Metric reports preserve identity fields and ignore snapshots older than reported_at. / 指标上报保留身份字段，并忽略早于 reported_at 的快照。 */
  upsertDynamic: `INSERT INTO machine_live
       (agent_id,
        cpu_usage, mem_used, mem_total, swap_used, swap_total,
        load_1, load_5, load_15,
        disk_used, disk_total,
        net_up_rate, net_down_rate, net_up_total, net_down_total,
        connections_tcp, connections_udp,
        process_count, uptime, message,
        interfaces_json, mounts_json,
        reported_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       cpu_usage        = excluded.cpu_usage,
       mem_used         = excluded.mem_used,
       mem_total        = excluded.mem_total,
       swap_used        = excluded.swap_used,
       swap_total       = excluded.swap_total,
       load_1           = excluded.load_1,
       load_5           = excluded.load_5,
       load_15          = excluded.load_15,
       disk_used        = excluded.disk_used,
       disk_total       = excluded.disk_total,
       net_up_rate      = excluded.net_up_rate,
       net_down_rate    = excluded.net_down_rate,
       net_up_total     = excluded.net_up_total,
       net_down_total   = excluded.net_down_total,
       connections_tcp  = excluded.connections_tcp,
       connections_udp  = excluded.connections_udp,
       process_count    = excluded.process_count,
       uptime           = excluded.uptime,
       message          = excluded.message,
       interfaces_json  = excluded.interfaces_json,
       mounts_json      = excluded.mounts_json,
       reported_at      = excluded.reported_at,
       updated_at       = excluded.updated_at
     WHERE machine_live.reported_at IS NULL OR excluded.reported_at >= machine_live.reported_at`,

  upsertFinalized: `INSERT INTO machine_history
       (agent_id, bucket_ts, cpu_avg, cpu_max, mem_pct_avg, mem_pct_max,
        load_1_avg, load_5_avg, sample_count, duration_sec, quality,
        net_up_bytes, net_down_bytes, network_duration_sec)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aggregate', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM agents WHERE id = ? AND active = 1)
     ON CONFLICT(agent_id, bucket_ts) DO NOTHING`,
  recordAvailability: `INSERT INTO agent_uptime_daily(monitor_id, day, total, up, warn, last_minute_ts)
     SELECT ?, date(?, 'unixepoch'), 1, CASE WHEN ? = 1 THEN 1 ELSE 0 END,
       CASE WHEN ? = 2 THEN 1 ELSE 0 END, ?
      WHERE EXISTS (SELECT 1 FROM monitors WHERE id = ? AND active = 1)
     ON CONFLICT(monitor_id, day) DO UPDATE SET
       total = agent_uptime_daily.total + 1,
       up = agent_uptime_daily.up + excluded.up,
       warn = agent_uptime_daily.warn + excluded.warn,
       last_minute_ts = excluded.last_minute_ts
     WHERE excluded.last_minute_ts > agent_uptime_daily.last_minute_ts`,
  dailyAvailability: `SELECT day AS d, total AS t, up AS u, warn AS w, NULL AS avg
      FROM agent_uptime_daily WHERE monitor_id = ? AND day = date(?, 'unixepoch')`,
  deleteOldAvailability: `DELETE FROM agent_uptime_daily WHERE day < date(?, 'unixepoch')`,

  /** One monitor's snapshot row, or NULL if the agent has never reported. / 单个监控的快照行；Agent 从未上报时为 NULL。 */
  getLive: 'SELECT ml.*, a.active AS agent_active FROM machine_live ml JOIN agents a ON a.id=ml.agent_id WHERE ml.agent_id = ?',

  /** Explicit cleanup used by the shared deletion flow in src/lib/monitor/writes.ts. / src/lib/monitor/writes.ts 的公共删除流程使用的显式清理。 */
  deleteLive: 'DELETE FROM machine_live WHERE agent_id = ?',

  /** Load all Agent snapshots and their active flags for the cron rollup. / 加载所有 Agent 快照及启用标记，供定时汇总使用。 */
  allLive: `SELECT ml.*, m.active AS agent_active
              FROM machine_live ml
              JOIN agents m ON m.id = ml.agent_id
             WHERE 1=1`,

  /** Delete minute history older than the cutoff supplied by the retention policy. / 删除早于保留策略截止时间的分钟历史。 */
  deleteOldHistory: 'DELETE FROM machine_history WHERE bucket_ts < ?',
} as const;

/** Finalized minute history queries. / 已完成的分钟历史查询。 */
const d1History = {

  /** Buckets since the supplied timestamp, oldest first; callers choose the query window. / 指定时间之后的时间桶，最早的排在前面；查询窗口由调用方选择。 */
  getRange: `SELECT agent_id, bucket_ts, cpu_avg, cpu_max, mem_pct_avg, mem_pct_max, load_1_avg, load_5_avg, sample_count, duration_sec, quality, net_up_bytes, net_down_bytes, network_duration_sec FROM machine_history
              WHERE agent_id = ? AND bucket_ts >= ? AND quality = 'aggregate'
              ORDER BY bucket_ts`,

  /** Explicit cleanup used by the shared monitor deletion flow. / 公共监控删除流程使用的显式清理。 */
  deleteHistory: 'DELETE FROM machine_history WHERE agent_id = ?',

  /** Latest bucket before the supplied timestamp, or null without an earlier observation. / 指定时间之前最近的时间桶；无更早观测时为 null。 */

  /** Count stored minute buckets per UTC day; this is observation density, not uptime. / 按 UTC 日期统计已存储的分钟桶；这是观测密度，不是可用率。 */
  dailyAvailability: `SELECT (bucket_ts / 86400) AS day, COUNT(*) AS buckets
                      FROM machine_history
                      WHERE agent_id = ? AND bucket_ts >= ? AND quality = 'aggregate'
                      GROUP BY day
                      ORDER BY day`,
} as const;

type AgentLiveSQL = {
  [K in keyof typeof d1]: string;
};
type AgentHistorySQL = {
  [K in keyof typeof d1History]: string;
};

// Postgres dialect. Same statements, `$n` positionals; `EXCLUDED` capitalised
// by convention. The two upserts' ON CONFLICT shape is identical across
// engines because both implement the SQL-standard form.
// Postgres 方言：语句相同，使用 `$n` 位置占位符；按惯例大写 `EXCLUDED`。
// 两种数据库均实现 SQL 标准的 ON CONFLICT，因此两个 upsert 的结构相同。
const postgresLive: AgentLiveSQL = {
  isActive: 'SELECT active FROM agents WHERE id = $1',
  upsertStatic: `INSERT INTO machine_live
       (agent_id, os, arch, kernel, cpu_model, cpu_cores,
        public_ip, public_ipv6, isp, region, virtualization, transport, version, report_interval_secs,
        probe_capabilities, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT(agent_id) DO UPDATE SET
       os             = EXCLUDED.os,
       arch           = EXCLUDED.arch,
       kernel         = EXCLUDED.kernel,
       cpu_model      = EXCLUDED.cpu_model,
       cpu_cores      = EXCLUDED.cpu_cores,
       public_ip      = EXCLUDED.public_ip,
       public_ipv6    = EXCLUDED.public_ipv6,
       isp            = EXCLUDED.isp,
       region         = EXCLUDED.region,
       virtualization = EXCLUDED.virtualization,
       transport      = EXCLUDED.transport,
       version        = EXCLUDED.version,
       report_interval_secs = EXCLUDED.report_interval_secs,
       probe_capabilities = EXCLUDED.probe_capabilities,
       updated_at     = EXCLUDED.updated_at`,

  upsertDynamic: `INSERT INTO machine_live
       (agent_id,
        cpu_usage, mem_used, mem_total, swap_used, swap_total,
        load_1, load_5, load_15,
        disk_used, disk_total,
        net_up_rate, net_down_rate, net_up_total, net_down_total,
        connections_tcp, connections_udp,
        process_count, uptime, message,
        interfaces_json, mounts_json,
        reported_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
     ON CONFLICT(agent_id) DO UPDATE SET
       cpu_usage        = EXCLUDED.cpu_usage,
       mem_used         = EXCLUDED.mem_used,
       mem_total        = EXCLUDED.mem_total,
       swap_used        = EXCLUDED.swap_used,
       swap_total       = EXCLUDED.swap_total,
       load_1           = EXCLUDED.load_1,
       load_5           = EXCLUDED.load_5,
       load_15          = EXCLUDED.load_15,
       disk_used        = EXCLUDED.disk_used,
       disk_total       = EXCLUDED.disk_total,
       net_up_rate      = EXCLUDED.net_up_rate,
       net_down_rate    = EXCLUDED.net_down_rate,
       net_up_total     = EXCLUDED.net_up_total,
       net_down_total   = EXCLUDED.net_down_total,
       connections_tcp  = EXCLUDED.connections_tcp,
       connections_udp  = EXCLUDED.connections_udp,
       process_count    = EXCLUDED.process_count,
       uptime           = EXCLUDED.uptime,
       message          = EXCLUDED.message,
       interfaces_json  = EXCLUDED.interfaces_json,
       mounts_json      = EXCLUDED.mounts_json,
       reported_at      = EXCLUDED.reported_at,
       updated_at       = EXCLUDED.updated_at
     WHERE machine_live.reported_at IS NULL OR EXCLUDED.reported_at >= machine_live.reported_at`,
  upsertFinalized: `INSERT INTO machine_history
       (agent_id, bucket_ts, cpu_avg, cpu_max, mem_pct_avg, mem_pct_max,
        load_1_avg, load_5_avg, sample_count, duration_sec, quality,
        net_up_bytes, net_down_bytes, network_duration_sec)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'aggregate', $11, $12, $13
      WHERE EXISTS (SELECT 1 FROM agents WHERE id = $14 AND active = 1)
     ON CONFLICT(agent_id, bucket_ts) DO NOTHING`,
  recordAvailability: `INSERT INTO agent_uptime_daily(monitor_id, day, total, up, warn, last_minute_ts)
     SELECT $1, to_char(to_timestamp($2) AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 1,
       CASE WHEN $3 = 1 THEN 1 ELSE 0 END, CASE WHEN $3 = 2 THEN 1 ELSE 0 END, $2
      WHERE EXISTS (SELECT 1 FROM monitors WHERE id = $4 AND active = 1)
     ON CONFLICT(monitor_id, day) DO UPDATE SET
       total = agent_uptime_daily.total + 1,
       up = agent_uptime_daily.up + EXCLUDED.up,
       warn = agent_uptime_daily.warn + EXCLUDED.warn,
       last_minute_ts = EXCLUDED.last_minute_ts
     WHERE EXCLUDED.last_minute_ts > agent_uptime_daily.last_minute_ts`,
  dailyAvailability: `SELECT day AS d, total AS t, up AS u, warn AS w, NULL AS avg
      FROM agent_uptime_daily WHERE monitor_id = $1
       AND day = to_char(to_timestamp($2) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
  deleteOldAvailability: `DELETE FROM agent_uptime_daily WHERE day < to_char(to_timestamp($1) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,

  getLive: 'SELECT ml.*, a.active AS agent_active FROM machine_live ml JOIN agents a ON a.id=ml.agent_id WHERE ml.agent_id = $1',
  deleteLive: 'DELETE FROM machine_live WHERE agent_id = $1',
  allLive: `SELECT ml.*, m.active AS agent_active
              FROM machine_live ml
              JOIN agents m ON m.id = ml.agent_id
             WHERE 1=1`,
  deleteOldHistory: 'DELETE FROM machine_history WHERE bucket_ts < $1',
};
const postgresHistory: AgentHistorySQL = {

  getRange: `SELECT agent_id, bucket_ts, cpu_avg, cpu_max, mem_pct_avg, mem_pct_max, load_1_avg, load_5_avg, sample_count, duration_sec, quality, net_up_bytes, net_down_bytes, network_duration_sec FROM machine_history
              WHERE agent_id = $1 AND bucket_ts >= $2 AND quality = 'aggregate'
              ORDER BY bucket_ts`,

  deleteHistory: 'DELETE FROM machine_history WHERE agent_id = $1',


  dailyAvailability: `SELECT (bucket_ts / 86400) AS day, COUNT(*) AS buckets
                      FROM machine_history
                      WHERE agent_id = $1 AND bucket_ts >= $2 AND quality = 'aggregate'
                      GROUP BY day
                      ORDER BY day`,
};

/** Agent 当前快照和分钟可用性写入的双数据库语句。 / D1 and Postgres statements for writing Agent snapshots and per-minute availability. */
export const agentLiveSQL: Record<'d1' | 'postgres', AgentLiveSQL> = {
  d1,
  postgres: postgresLive,
};

/** Agent 历史指标读取和清理的双数据库语句。 / D1 and Postgres statements for reading and pruning Agent metric history. */
export const agentHistorySQL: Record<'d1' | 'postgres', AgentHistorySQL> = {
  d1: d1History,
  postgres: postgresHistory,
};

/** Convenience union for call sites that need both maps. / 为同时需要两张映射表的调用方提供的组合。 */
export const agentSQL = { live: agentLiveSQL, history: agentHistorySQL } as const;
