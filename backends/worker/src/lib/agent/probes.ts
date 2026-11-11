import { findAgentByToken } from './registry';
import { isActiveProbeType, requiresAgentProbe, requiredProbeCapabilities, type ActiveProbeType, type ProbeAddonSelection } from '../../../../../shared/probe-capabilities';
import { parseProbeAddons, probeAddonRequest, reuseAgentSsl, type ProbeAddonRequest, type ProbeAddonResults } from './probe-addons';
import { loadLiveFresh } from '../monitor/store';
import type { Context } from 'hono';
import type { AddonReading, Agent, AgentMachineOptions, Env, Monitor, ProbeSource, Status } from '../../types';
import { parseOptions } from '../../types';
import { getDB } from '../db/factory';
import { pollCommands, submitCommandResult } from './commands';
import { agentIsOnline, agentStaleAfterSec } from './liveness';

const MAX_JOBS_PER_POLL = 4;
const MAX_ATTEMPTS = 3;
const LEASE_UPLOAD_SEC = 30;
const POLL_GRACE_SEC = 90;
const RESULT_TTL_SEC = 86_400;

export interface ProbeJob {
  addons: ProbeAddonRequest;
  run_id: string;
  monitor_id: string;
  target: string;
  type: ActiveProbeType;
  method: string;
  options: Record<string, unknown>;
  expected_status: string;
  keyword: string | null;
  timeout_ms: number;
  lease_expires_at: number;
  lease_token: string;
}

export interface ProbeObservation {
  addons: ProbeAddonResults;
  status: Status;
  latencyMs: number;
  statusCode: number;
  message: string;
  observedAt: number;
  runId: string;
}

export async function handleAgentProbePoll(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header('cache-control', 'private, no-store');
  const agent = await findAgentByToken(c.env, c.req.param('token') ?? '');
  if (!agent) return c.json({ error: 'invalid token' }, 401);
  const now = Math.floor(Date.now() / 1000);
  const jobs = await pollAgentProbeJobs(c.env, agent, now);
  const commands = await pollCommands(c.env, agent, now);
  return c.json({ jobs, commands });
}

/**
 * An agent reporting what it did with a command.
 *
 * Public in the same sense the probe-result route is: the credential is the token
 * in the path, which the agent already holds. The agent can only name commands
 * the server issued *to it* - `submitCommandResult` checks ownership and returns
 * `not_found` otherwise, so this is not a way to reach another host's queue.
 * Agent 上报命令执行结果。与探测结果路由一样，此公共端点使用 Agent 已持有的路径令牌；
 * Agent 只能提交服务器发给它的命令。`submitCommandResult` 检查所有权，其他情况返回
 * `not_found`，因此不能通过此端点访问其他主机的队列。
 */
export async function handleAgentCommandResult(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header('cache-control', 'private, no-store');
  const agent = await findAgentByToken(c.env, c.req.param('token') ?? '');
  if (!agent) return c.json({ error: 'invalid token' }, 401);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return c.json({ error: 'invalid' }, 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid' }, 400);
  }

  const outcome = await submitCommandResult(c.env, agent, body, Math.floor(Date.now() / 1000));
  /*
    The status codes carry meaning the agent acts on, and they mirror the probe
    result route exactly so the agent's existing `invalidated_lease` helper -
    which stops retrying on 409 `stale` / 404 `not_found` - works unchanged.
    状态码供 Agent 决定后续操作，且与探测结果路由一致；现有 `invalidated_lease`
    可在 409 `stale` / 404 `not_found` 时停止重试，无需修改。
  */
  if (outcome === 'invalid') return c.json({ error: 'invalid' }, 400);
  if (outcome === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (outcome === 'stale') return c.json({ error: 'stale' }, 409);
  // `duplicate` is a success: the agent retried an upload whose reply it never
  // saw, and answering with a failure would make it retry forever.
  // `duplicate` 视为成功：Agent 重传了未收到响应的上传，若返回失败会导致无限重试。
  return c.json({ ok: true, duplicate: outcome === 'duplicate' });
}

export async function handleAgentProbeResult(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header('cache-control', 'private, no-store');
  const agent = await findAgentByToken(c.env, c.req.param('token') ?? '');
  if (!agent) return c.json({ error: 'invalid token' }, 401);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return c.json({ error: 'invalid result' }, 400);
  const outcome = await submitAgentProbeResult(c.env, agent, body as Record<string, unknown>, Math.floor(Date.now() / 1000));
  if (outcome === 'accepted' || outcome === 'duplicate') return c.json({ ok: true, duplicate: outcome === 'duplicate' });
  if (outcome === 'invalid') return c.json({ error: outcome }, 400);
  if (outcome === 'not_found') return c.json({ error: outcome }, 404);
  return c.json({ error: outcome }, 409);
}

export async function handleProbeSources(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header('cache-control', 'private, no-store');
  const db = getDB(c.env);
  const rows = await db.query<Record<string, unknown>>(db.type === 'postgres'
    ? "SELECT m.id, m.name, m.active, m.options_json, ml.version, ml.probe_capabilities, ml.reported_at, ml.report_interval_secs FROM agents m LEFT JOIN machine_live ml ON ml.agent_id=m.id ORDER BY m.created_at"
    : "SELECT m.id, m.name, m.active, m.options_json, ml.version, ml.probe_capabilities, ml.reported_at, ml.report_interval_secs FROM agents m LEFT JOIN machine_live ml ON ml.agent_id=m.id ORDER BY m.created_at");
  const now = Math.floor(Date.now() / 1000);
  return c.json({ agents: rows.map((row) => {
    let capabilities: string[] = [];
    try {
      const value: unknown = JSON.parse(String(row.probe_capabilities ?? '[]'));
      if (Array.isArray(value)) capabilities = value.filter((entry): entry is string => typeof entry === 'string');
    } catch { /* empty until a valid capability report arrives / 收到有效能力上报之前保持为空 */ }
    const online = agentIsOnline(toFiniteNumber(row.reported_at), now, agentStaleAfterSec(toFiniteNumber(row.report_interval_secs))) === true;
    /*
      `probe_enabled` travels with the list rather than being inferred by the
      console from the absence of a monitor pointing at this agent: an agent
      that is enabled but unused and one that is disabled look identical from
      the monitor side, and only the flag tells them apart.
      列表显式返回 `probe_enabled`，而不是让控制台根据是否有监控指向此 Agent 推断：
      已启用但未使用与已禁用的 Agent 从监控侧看相同，只有该标记能区分二者。
    */
    const probeEnabled = parseOptions<AgentMachineOptions>(String(row.options_json ?? '{}')).probe_enabled !== false;
    /*
      `installed` is "has this machine ever reported", not "is it online now".

      The monitor form offers this list as places to run a check from, and a
      row that has never reported is a name someone typed - the installer has
      not run yet, so there is nothing there to run anything. Online-ness is a
      separate axis and stays on its own field.
      `installed` 表示该机器是否曾上报，而非当前是否在线。监控表单用此列表选择探测来源；
      从未上报的条目只是一个填写过的名称，安装器尚未运行，无法执行探测。
      在线状态是独立维度，保存在单独字段中。
    */
    const installed = toFiniteNumber(row.reported_at) !== null;
    return { id: String(row.id), name: String(row.name), active: Number(row.active) === 1, version: row.version ?? null, capabilities, online, probe_enabled: probeEnabled, installed };
  }) });
}

export function monitorProbeSource(monitor: Monitor): ProbeSource {
  const options = parseOptions<{ check_source?: ProbeSource }>(monitor.options_json);
  return options.check_source?.type === 'agent' && typeof options.check_source.agent_id === 'string'
    ? options.check_source
    : requiresAgentProbe(monitor.type) ? { type: 'agent', agent_id: '' } : { type: 'worker' };
}

export async function supportsProbeAgent(env: Env, agentId: string, type: ActiveProbeType, addons: ProbeAddonSelection = {}): Promise<boolean> {
  const db = getDB(env);
  const live = await db.queryOne<{ version: string | null; probe_capabilities: string | null }>(
    db.type === 'postgres'
      ? "SELECT ml.version, ml.probe_capabilities FROM machine_live ml JOIN agents m ON m.id = ml.agent_id WHERE ml.agent_id = $1 AND m.active = 1"
      : "SELECT ml.version, ml.probe_capabilities FROM machine_live ml JOIN agents m ON m.id = ml.agent_id WHERE ml.agent_id = ? AND m.active = 1",
    [agentId],
  );
  if (!live) return false;
  try {
    const capabilities: unknown = JSON.parse(live.probe_capabilities ?? '[]');
    return Array.isArray(capabilities) && requiredProbeCapabilities(type, addons).every(capability => capabilities.includes(capability));
  } catch {
    return false;
  }
}

type ProbeAgentState = {
  id: string;
  options_json: string;
  version: string | null;
  probe_capabilities: string | null;
  reported_at: number | string | null;
  report_interval_secs: number | string | null;
};

export async function loadProbeAgentStates(env: Env): Promise<Map<string, ProbeAgentState>> {
  const rows = await getDB(env).query<ProbeAgentState>(
    "SELECT m.id, m.options_json, ml.version, ml.probe_capabilities, ml.reported_at, ml.report_interval_secs FROM agents m LEFT JOIN machine_live ml ON ml.agent_id=m.id WHERE m.active=1",
  );
  return new Map(rows.map((row) => [row.id, row]));
}

export function probeAgentAvailable(states: Map<string, ProbeAgentState>, source: ProbeSource, type: ActiveProbeType, now: number, addons: ProbeAddonSelection = {}): boolean {
  if (source.type !== 'agent') return false;
  const agent = states.get(source.agent_id);
  if (!agent || parseOptions<AgentMachineOptions>(agent.options_json).probe_enabled === false) return false;
  try {
    const capabilities: unknown = JSON.parse(agent.probe_capabilities ?? '[]');
    return Array.isArray(capabilities) && requiredProbeCapabilities(type, addons).every(capability => capabilities.includes(capability)) &&
      agentIsOnline(agent.reported_at, now, agentStaleAfterSec(agent.report_interval_secs)) === true;
  } catch {
    return false;
  }
}

export async function scheduleAgentProbeJobs(env: Env, monitors: Monitor[], now: number, states?: Map<string, ProbeAgentState>): Promise<void> {
  const db = getDB(env);
  const agents = states ?? await loadProbeAgentStates(env);
  const writes: { sql: string; params: unknown[] }[] = [];
  for (const monitor of monitors) {
    if (!monitor.active || !isActiveProbeType(monitor.type)) continue;
    const source = monitorProbeSource(monitor);
    if (source.type !== 'agent' || !probeAgentAvailable(agents, source, monitor.type, now, { ssl: Boolean(monitor.check_ssl), domain: Boolean(monitor.check_domain), dns: Boolean(monitor.check_dns) })) continue;
    // 同一监控和时间槽只调度一次；版本用于识别配置变更后的旧结果。
    // Schedule each monitor and time slot once; the version identifies results from older configurations.
    const scheduledAt = Math.floor(now / monitor.interval_sec) * monitor.interval_sec;
    const version = await sourceVersion(monitor, source);
    const runId = `${monitor.id}:${scheduledAt}:${version}`;
    const sql = db.type === 'postgres'
      ? `INSERT INTO agent_probe_jobs (run_id, monitor_id, agent_id, target, probe_type, method, options_json, expected_status, keyword, timeout_ms, interval_sec, scheduled_at, source_version,check_ssl,check_domain,check_dns,warn_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (monitor_id, scheduled_at) DO NOTHING`
      : `INSERT OR IGNORE INTO agent_probe_jobs (run_id, monitor_id, agent_id, target, probe_type, method, options_json, expected_status, keyword, timeout_ms, interval_sec, scheduled_at, source_version,check_ssl,check_domain,check_dns,warn_days)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    writes.push({ sql, params: [runId, monitor.id, source.agent_id, monitor.target, monitor.type, monitor.method, monitor.options_json, monitor.expected_status, monitor.keyword, monitor.timeout_ms, monitor.interval_sec, scheduledAt, version,monitor.check_ssl,monitor.check_domain,monitor.check_dns,monitor.warn_days] });
  }
  if (writes.length) await db.commit(writes);
}

export async function pollAgentProbeJobs(env: Env, agent: Agent, now: number): Promise<ProbeJob[]> {
  if (!agent.active || parseOptions<AgentMachineOptions>(agent.options_json).probe_enabled === false) return [];
  const db = getDB(env);
  const live = await loadLiveFresh(env);
  await db.execute(db.type === 'postgres'
    ? "UPDATE agent_probe_jobs SET state='expired' WHERE agent_id=$1 AND state='pending' AND scheduled_at + interval_sec + $2 < $3"
    : "UPDATE agent_probe_jobs SET state='expired' WHERE agent_id=? AND state='pending' AND scheduled_at + interval_sec + ? < ?", db.type === 'postgres' ? [agent.id, POLL_GRACE_SEC, now] : [agent.id, POLL_GRACE_SEC, now]);
  const rows = await db.query<Record<string, unknown>>(
    db.type === 'postgres'
      ? `SELECT run_id, monitor_id, probe_type, source_version, timeout_ms FROM agent_probe_jobs WHERE agent_id = $1 AND scheduled_at <= $2 AND scheduled_at + interval_sec + $3 >= $2 AND attempts < $4 AND
           (state = 'pending' OR (state = 'leased' AND lease_until <= $2)) ORDER BY scheduled_at LIMIT $5`
      : `SELECT run_id, monitor_id, probe_type, source_version, timeout_ms FROM agent_probe_jobs WHERE agent_id = ? AND scheduled_at <= ? AND scheduled_at + interval_sec + ? >= ? AND attempts < ? AND
           (state = 'pending' OR (state = 'leased' AND lease_until <= ?)) ORDER BY scheduled_at LIMIT ?`,
    db.type === 'postgres'
      ? [agent.id, now, POLL_GRACE_SEC, MAX_ATTEMPTS, MAX_JOBS_PER_POLL]
      : [agent.id, now, POLL_GRACE_SEC, now, MAX_ATTEMPTS, now, MAX_JOBS_PER_POLL],
  );
  const jobs: ProbeJob[] = [];
  for (const row of rows) {
    const runId = String(row.run_id);
    const snapshot = await db.queryOne<Monitor>(db.type === 'postgres'
      ? 'SELECT * FROM monitors WHERE id = $1 AND active = 1'
      : 'SELECT * FROM monitors WHERE id = ? AND active = 1', [row.monitor_id]);
    if (!snapshot || snapshot.type !== row.probe_type) continue;
    const currentSource = monitorProbeSource(snapshot);
    if (currentSource.type !== 'agent' || currentSource.agent_id !== agent.id ||
        await sourceVersion(snapshot, currentSource) !== row.source_version) {
      await db.execute(db.type === 'postgres'
        ? "UPDATE agent_probe_jobs SET state='expired' WHERE run_id=$1 AND state IN ('pending','leased')"
        : "UPDATE agent_probe_jobs SET state='expired' WHERE run_id=? AND state IN ('pending','leased')", [runId]);
      continue;
    }
    const leaseToken = randomToken();
    const leaseUntil = now + Math.ceil(Number(row.timeout_ms) / 1000) + LEASE_UPLOAD_SEC;
    const addons = probeAddonRequest(snapshot, agent.id, live[snapshot.id]?.ssl, now);
    // 条件更新同时竞争租约并复核配置，防止并发轮询领取同一任务。
    // The conditional update claims the lease and rechecks configuration, preventing duplicate concurrent claims.
    const claim = await db.execute(
      db.type === 'postgres'
      ? `UPDATE agent_probe_jobs SET state = 'leased', lease_token = $1, lease_until = $2, attempts = attempts + 1, requested_addons_json=$6
           WHERE run_id = $3 AND attempts < $4 AND (state = 'pending' OR (state = 'leased' AND lease_until <= $5))
             AND EXISTS (SELECT 1 FROM monitors m WHERE m.id=agent_probe_jobs.monitor_id AND m.active=1 AND m.type=agent_probe_jobs.probe_type AND m.target=agent_probe_jobs.target AND m.method=agent_probe_jobs.method AND m.options_json=agent_probe_jobs.options_json AND m.expected_status=agent_probe_jobs.expected_status AND m.timeout_ms=agent_probe_jobs.timeout_ms AND m.interval_sec=agent_probe_jobs.interval_sec AND m.check_ssl=agent_probe_jobs.check_ssl AND m.check_domain=agent_probe_jobs.check_domain AND m.check_dns=agent_probe_jobs.check_dns AND m.warn_days=agent_probe_jobs.warn_days AND COALESCE(m.keyword,'')=COALESCE(agent_probe_jobs.keyword,''))`
        : `UPDATE agent_probe_jobs SET state = 'leased', lease_token = ?, lease_until = ?, attempts = attempts + 1, requested_addons_json=?
           WHERE run_id = ? AND attempts < ? AND (state = 'pending' OR (state = 'leased' AND lease_until <= ?))
             AND EXISTS (SELECT 1 FROM monitors m WHERE m.id=agent_probe_jobs.monitor_id AND m.active=1 AND m.type=agent_probe_jobs.probe_type AND m.target=agent_probe_jobs.target AND m.method=agent_probe_jobs.method AND m.options_json=agent_probe_jobs.options_json AND m.expected_status=agent_probe_jobs.expected_status AND m.timeout_ms=agent_probe_jobs.timeout_ms AND m.interval_sec=agent_probe_jobs.interval_sec AND m.check_ssl=agent_probe_jobs.check_ssl AND m.check_domain=agent_probe_jobs.check_domain AND m.check_dns=agent_probe_jobs.check_dns AND m.warn_days=agent_probe_jobs.warn_days AND COALESCE(m.keyword,'')=COALESCE(agent_probe_jobs.keyword,''))`,
      db.type === 'postgres' ? [leaseToken, leaseUntil, runId, MAX_ATTEMPTS, now, JSON.stringify(addons)] : [leaseToken, leaseUntil, JSON.stringify(addons), runId, MAX_ATTEMPTS, now],
    );
    if (!claim.rowsAffected) continue;
    const job = await db.queryOne<Record<string, unknown>>(
      db.type === 'postgres' ? 'SELECT * FROM agent_probe_jobs WHERE run_id = $1 AND agent_id = $2' : 'SELECT * FROM agent_probe_jobs WHERE run_id = ? AND agent_id = ?',
      [runId, agent.id],
    );
    if (!job) continue;
    const options = parseOptions<Record<string, unknown>>(String(job.options_json));
    delete options.check_source;
    jobs.push({
      addons,
      run_id: runId,
      monitor_id: String(job.monitor_id),
      target: String(job.target),
      type: job.probe_type as ActiveProbeType,
      method: String(job.method),
      options,
      expected_status: String(job.expected_status),
      keyword: job.keyword == null ? null : String(job.keyword),
      timeout_ms: Number(job.timeout_ms),
      lease_expires_at: leaseUntil * 1000,
      lease_token: leaseToken,
    });
  }
  return jobs;
}

export async function submitAgentProbeResult(
  env: Env,
  agent: Agent,
  input: Record<string, unknown>,
  now: number,
): Promise<'accepted' | 'duplicate' | 'invalid' | 'stale' | 'not_found'> {
  if (!agent.active || parseOptions<AgentMachineOptions>(agent.options_json).probe_enabled === false) return 'stale';
  if (typeof input.run_id !== 'string' || typeof input.lease_token !== 'string' ||
      (input.status !== 0 && input.status !== 1 && input.status !== 2) || !finiteRange(input.latency_ms, 0, 3_600_000) ||
      !Number.isInteger(input.observed_at) || !finiteRange(input.status_code, 0, 999) ||
      typeof input.message !== 'string' || input.message.length > 512) return 'invalid';
  const db = getDB(env);
  const job = await db.queryOne<Record<string, unknown>>(
    db.type === 'postgres' ? 'SELECT * FROM agent_probe_jobs WHERE run_id = $1 AND agent_id = $2' : 'SELECT * FROM agent_probe_jobs WHERE run_id = ? AND agent_id = ?',
    [input.run_id, agent.id],
  );
  if (!job) return 'not_found';
  // 重传已完成租约按成功处理；过期或被重新领取的租约不能提交。
  // Treat a completed lease retry as success; reject expired or reassigned leases.
  if (job.state === 'completed' && job.lease_token === input.lease_token) return 'duplicate';
  if (job.state !== 'leased' || job.lease_token !== input.lease_token || Number(job.lease_until) < now) return 'stale';
  const monitor = await db.queryOne<Monitor>(
    db.type === 'postgres' ? 'SELECT * FROM monitors WHERE id = $1 AND active = 1' : 'SELECT * FROM monitors WHERE id = ? AND active = 1',
    [job.monitor_id],
  );
  if (!monitor || monitor.type !== job.probe_type || monitor.target !== job.target) return 'stale';
  const source = monitorProbeSource(monitor);
  if (source.type !== 'agent' || source.agent_id !== agent.id || await sourceVersion(monitor, source) !== job.source_version) return 'stale';
  const observedAt = Number(input.observed_at);
  if (observedAt < Number(job.scheduled_at) - 30 || observedAt > now + 15 || observedAt < now - Math.ceil(Number(job.timeout_ms) / 1000) - 120) return 'invalid';
  const addons = parseProbeAddons(input.addons, JSON.parse(String(job.requested_addons_json)), agent.id, Number(job.scheduled_at), now);
  if (!addons) return 'invalid';
  const result = await db.execute(
    db.type === 'postgres'
      ? `UPDATE agent_probe_jobs SET state='completed', observed_at=$1, status=$2, status_code=$3, latency_ms=$4, message=$5, completed_at=$6, addons_json=$10
         WHERE run_id=$7 AND agent_id=$8 AND state='leased' AND lease_token=$9 AND lease_until >= $6
           AND EXISTS (SELECT 1 FROM monitors m WHERE m.id=agent_probe_jobs.monitor_id AND m.active=1 AND m.type=agent_probe_jobs.probe_type AND m.target=agent_probe_jobs.target AND m.method=agent_probe_jobs.method AND m.options_json=agent_probe_jobs.options_json AND m.expected_status=agent_probe_jobs.expected_status AND m.timeout_ms=agent_probe_jobs.timeout_ms AND m.interval_sec=agent_probe_jobs.interval_sec AND m.check_ssl=agent_probe_jobs.check_ssl AND m.check_domain=agent_probe_jobs.check_domain AND m.check_dns=agent_probe_jobs.check_dns AND m.warn_days=agent_probe_jobs.warn_days AND COALESCE(m.keyword,'')=COALESCE(agent_probe_jobs.keyword,''))`
      : `UPDATE agent_probe_jobs SET state='completed', observed_at=?, status=?, status_code=?, latency_ms=?, message=?, completed_at=?, addons_json=?
         WHERE run_id=? AND agent_id=? AND state='leased' AND lease_token=? AND lease_until >= ?
           AND EXISTS (SELECT 1 FROM monitors m WHERE m.id=agent_probe_jobs.monitor_id AND m.active=1 AND m.type=agent_probe_jobs.probe_type AND m.target=agent_probe_jobs.target AND m.method=agent_probe_jobs.method AND m.options_json=agent_probe_jobs.options_json AND m.expected_status=agent_probe_jobs.expected_status AND m.timeout_ms=agent_probe_jobs.timeout_ms AND m.interval_sec=agent_probe_jobs.interval_sec AND m.check_ssl=agent_probe_jobs.check_ssl AND m.check_domain=agent_probe_jobs.check_domain AND m.check_dns=agent_probe_jobs.check_dns AND m.warn_days=agent_probe_jobs.warn_days AND COALESCE(m.keyword,'')=COALESCE(agent_probe_jobs.keyword,''))`,
    db.type === 'postgres'
      ? [observedAt, input.status, input.status_code, input.latency_ms, input.message, now, input.run_id, agent.id, input.lease_token, JSON.stringify(addons)]
      : [observedAt, input.status, input.status_code, input.latency_ms, input.message, now, JSON.stringify(addons), input.run_id, agent.id, input.lease_token, now],
  );
  return result.rowsAffected ? 'accepted' : 'stale';
}

export async function latestAgentProbeObservation(env: Env, monitor: Monitor, after: number, now: number, previousSsl?: AddonReading): Promise<ProbeObservation | null> {
  const source = monitorProbeSource(monitor);
  if (source.type !== 'agent') return null;
  const version = await sourceVersion(monitor, source);
  const db = getDB(env);
  const row = await db.queryOne<Record<string, unknown>>(
    db.type === 'postgres'
      ? "SELECT run_id, observed_at, status, status_code, latency_ms, message, addons_json FROM agent_probe_jobs WHERE monitor_id=$1 AND agent_id=$2 AND source_version=$3 AND state='completed' AND observed_at>$4 AND observed_at >= $5 ORDER BY observed_at DESC LIMIT 1"
      : "SELECT run_id, observed_at, status, status_code, latency_ms, message, addons_json FROM agent_probe_jobs WHERE monitor_id=? AND agent_id=? AND source_version=? AND state='completed' AND observed_at>? AND observed_at >= ? ORDER BY observed_at DESC LIMIT 1",
    [monitor.id, source.agent_id, version, after, now - monitor.interval_sec],
  );
  if (!row) return null;
  const addons = JSON.parse(String(row.addons_json ?? '{}')) as ProbeAddonResults;
  const savedSsl = reuseAgentSsl(monitor, source.agent_id, previousSsl, now);
  if (!addons.ssl && savedSsl) addons.ssl = savedSsl;
  return {
    addons,
    runId: String(row.run_id), observedAt: Number(row.observed_at), status: Number(row.status) as Status,
    statusCode: Number(row.status_code), latencyMs: Number(row.latency_ms), message: String(row.message ?? ''),
  };
}

export async function pruneAgentProbeJobs(env: Env, now: number): Promise<void> {
  const db = getDB(env);
  await db.execute(db.type === 'postgres'
    ? `DELETE FROM agent_probe_jobs WHERE
         (state='expired' AND scheduled_at < $1 - 3600) OR
         (state IN ('pending','leased') AND scheduled_at + interval_sec + $2 < $1) OR
         (state='completed' AND consumed_at IS NOT NULL AND completed_at < $1 - 86400) OR
         (state='completed' AND consumed_at IS NULL AND completed_at < $1 - $3) OR
         NOT EXISTS (SELECT 1 FROM monitors m WHERE m.id=agent_probe_jobs.monitor_id AND m.active=1)`
    : `DELETE FROM agent_probe_jobs WHERE
         (state='expired' AND scheduled_at < ? - 3600) OR
         (state IN ('pending','leased') AND scheduled_at + interval_sec + ? < ?) OR
         (state='completed' AND consumed_at IS NOT NULL AND completed_at < ? - 86400) OR
         (state='completed' AND consumed_at IS NULL AND completed_at < ? - ?) OR
         NOT EXISTS (SELECT 1 FROM monitors m WHERE m.id=agent_probe_jobs.monitor_id AND m.active=1)`,
    db.type === 'postgres'
      ? [now, POLL_GRACE_SEC, RESULT_TTL_SEC]
      : [now, POLL_GRACE_SEC, now, now, now, RESULT_TTL_SEC]);
}

/** Machine probe rotation is an administrator setting. / 机器探测开关由管理员设置。 */
export async function agentProbeEnabled(env: Env, agentId: string): Promise<boolean> {
  const db = getDB(env);
  const row = await db.queryOne<{ options_json: string | null }>(
    db.type === 'postgres'
      ? "SELECT options_json FROM agents WHERE id = $1 AND active = 1"
      : "SELECT options_json FROM agents WHERE id = ? AND active = 1",
    [agentId],
  );
  /*
    An unknown agent reads as enabled, not disabled.

    The switch is an operator decision about an agent that exists; "no such
    row" is a different answer, and the caller already has `supportsProbeAgent`
    to refuse an agent that is missing, paused, or too old. Returning `false`
    here would make every such case report `agent_probe_disabled`, which tells
    the operator to flip a switch that is not the problem.
    未知 Agent 在这里按启用处理。开关只表示管理员对已存在 Agent 的选择；
    调用方已有 `supportsProbeAgent` 拒绝缺失、暂停或版本过旧的 Agent。
    此处返回 `false` 会把这些情况都报为 `agent_probe_disabled`，误导管理员修改开关。
  */
  if (!row) return true;
  return parseOptions<AgentMachineOptions>(row.options_json).probe_enabled !== false;
}

export async function agentProbeSourceAvailable(env: Env, source: ProbeSource, type: ActiveProbeType, now: number): Promise<boolean> {
  if (source.type !== 'agent' || !(await agentProbeEnabled(env, source.agent_id))) return false;
  if (!(await supportsProbeAgent(env, source.agent_id, type))) return false;
  const db = getDB(env);
  const row = await db.queryOne<{ reported_at: number | string | null; report_interval_secs: number | string | null }>(
    db.type === 'postgres' ? 'SELECT reported_at, report_interval_secs FROM machine_live WHERE agent_id=$1' : 'SELECT reported_at, report_interval_secs FROM machine_live WHERE agent_id=?',
    [source.agent_id],
  );
  const threshold = agentStaleAfterSec(row?.report_interval_secs);
  return agentIsOnline(row?.reported_at, now, threshold) === true;
}

async function sourceVersion(monitor: Monitor, source: ProbeSource): Promise<string> {
  const input = [monitor.type, monitor.target, monitor.method, monitor.expected_status, monitor.keyword ?? '', monitor.timeout_ms, monitor.interval_sec, monitor.options_json, monitor.check_ssl, monitor.check_domain, monitor.check_dns, monitor.warn_days, source.type, source.type === 'agent' ? source.agent_id : 'worker'].join('\u001f');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

function finiteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((part) => part.toString(16).padStart(2, '0')).join('');
}
