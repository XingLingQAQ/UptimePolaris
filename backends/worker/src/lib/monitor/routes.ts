import { udpPacketOptions } from '../../../../../shared/udp-probe';
import { Hono } from 'hono';
import { parseOptions, type Env, type Monitor, type MonitorType, type ProbeSource } from '../../types';
import { findAgent } from '../agent/registry';
import { ACTIVE_PROBE_TYPES, isActiveProbeType, requiresAgentProbe, type ProbeAddonSelection } from '../../../../../shared/probe-capabilities';
import { agentIsOnline, agentStaleAfterSec } from '../agent/liveness';
import { agentProbeEnabled, agentProbeSourceAvailable, supportsProbeAgent } from '../agent/probes';
import { parseExpected } from '../check/http';
import { isIpAddress, runCheck } from '../check/run';
import { addonFlag, addonTarget, isHostname } from '../check/target';
import { parseHostPort } from '../check/tcp';
import { hasNonCanonicalHttpIPv4 } from '../../../../../shared/monitor-hostname';
import { getDB } from '../db/factory';
import { agentSQL } from '../db/sql/agent';
import { monitorSQL } from '../db/sql/monitors';
import { groupExists } from '../group/groups';
import { existingTagIds, loadMonitorTags, setMonitorTags } from '../group/tags';
import { runMonitorCheck } from '../jobs/tick';
import { invalidateMonitorDetail, visibilityRevisionWrite } from '../public/cache';
import { readAll } from '../settings/store';
import { clampInteger } from '../util';
import { invalidateConfig, lastD1Meta, loadAllMonitors, logMeta } from './store';
import { deleteMonitor } from './writes';

// Mounted behind the management gate in api.ts.
// 在 api.ts 的管理鉴权之后挂载。
/** 监控的管理、即时检查及配置验证接口。 / Management, immediate check, and configuration validation endpoints for monitors. */
export const monitorRoutes = new Hono<{ Bindings: Env }>();

const TYPES: MonitorType[] = [...ACTIVE_PROBE_TYPES, 'push', 'agent'];

const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as const;

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

monitorRoutes.post('/api/monitors/visibility', async (c) => {
  let body: { ids?: unknown; is_public?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_request' }, 400); }
  if (!body || !Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 500 ||
      body.ids.some(id => typeof id !== 'string' || id.length === 0 || id.length > 128 || id.trim() !== id)) return c.json({ error: 'invalid_ids' }, 400);
  if (typeof body.is_public !== 'boolean') return c.json({ error: 'visibility_invalid' }, 400);
  const ids = [...new Set(body.ids as string[])];
  const db = getDB(c.env);
  const now = Math.floor(Date.now() / 1000);
  const writes: { sql: string; params: unknown[] }[] = [];
  for (let start = 0; start < ids.length; start += 80) {
    const chunk = ids.slice(start, start + 80);
    const refs = chunk.map((_, index) => db.type === 'postgres' ? `$${index + 1}` : '?').join(',');
    const existing = await db.query<{ id: string }>(`SELECT id FROM monitors WHERE id IN (${refs})`, chunk);
    if (existing.length !== chunk.length) return c.json({ error: 'not_found' }, 404);
    const placeholders = chunk.map((_, index) => db.type === 'postgres' ? `$${index + 3}` : '?').join(',');
    writes.push({ sql: db.type === 'postgres'
      ? `UPDATE monitors SET is_public=$1, updated_at=$2 WHERE id IN (${placeholders})`
      : `UPDATE monitors SET is_public=?, updated_at=? WHERE id IN (${placeholders})`, params: [body.is_public ? 1 : 0, now, ...chunk] });
  }
  const changes = await db.commit([...writes, visibilityRevisionWrite(now, db.type === 'postgres')]);
  invalidateConfig();
  return c.json({ ok: true, updated: changes.slice(0, writes.length).reduce((sum, count) => sum + count, 0), is_public: body.is_public });
});

monitorRoutes.get('/api/monitors', async (c) => {

  const monitors = await loadAllMonitors(c.env);

  const tags = await loadMonitorTags(c.env, monitors.map((m) => m.id));
  const db = getDB(c.env);
  const agentLives = await db.query<Record<string, unknown>>(agentSQL.live[db.type].allLive);
  const liveById = new Map(agentLives.map((row) => [String(row.agent_id), row]));
  const now = Math.floor(Date.now() / 1000);

  return c.json({
    monitors: monitors.map((m) => {
      if (m.type !== 'agent') return { ...m, tags: tags.get(m.id) ?? [] };
      const live = liveById.get(m.agent_id ?? '');
      const staleAfterSec = agentStaleAfterSec(typeof live?.report_interval_secs === 'number' ? live.report_interval_secs : null);
      return {
        ...m,
        tags: tags.get(m.id) ?? [],
        online: agentIsOnline(typeof live?.reported_at === 'number' ? live.reported_at : null, now, staleAfterSec),
        staleAfterSec,
      };
    }),
  });
});

monitorRoutes.post('/api/monitors', async (c) => {
  const body = await readObjectBody<MonitorBody>(c);
  if (!body) return c.json({ error: 'invalid_request' }, 400);
  if (body.is_public !== undefined && typeof body.is_public !== 'boolean') return c.json({ error: 'visibility_invalid' }, 400);
  const err = validate(body);
  if (err) return c.json({ error: err }, 400);

  const badRef = await checkRefs(c.env, body);
  if (badRef) return c.json({ error: badRef }, 400);

  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();

  const target = normalizeTarget(body.type!, body.target ?? '');

  const options = normalizeOptions(body.type!, body.options_json).json ?? '{}';
  const sourceError = await validateProbeSource(c.env, body.type!, options, { ssl: Boolean(body.check_ssl), domain: Boolean(body.check_domain), dns: Boolean(body.check_dns) });
  if (sourceError) return c.json({ error: sourceError }, 400);

  const pushToken = body.type === 'push' ? randomToken() : null;

  const agentId = bindingId(body.type!, body.agent_id, options);
  if (body.type === 'agent' && (!agentId || !await findAgent(c.env, agentId))) return c.json({ error: 'agent_required' }, 400);

  const db = getDB(c.env);

  const defaults = (await readAll(c.env)).values;
  const defaultIntervalSec = defaults['monitor.defaultIntervalSec'] as number;
  const defaultTimeoutMs = defaults['monitor.defaultTimeoutMs'] as number;
  await db.commit([{ sql: monitorSQL[db.type].insert, params: [
    id,

    nonEmptyString(body.name)!,
    body.type!,
    target,
    httpMethod(body.method) ?? 'GET',
    expectedStatusSpec(body.expected_status) ?? '200-299',
    keywordSpec(body.keyword ?? null),
    clampInteger(body.interval_sec ?? defaultIntervalSec, 60, 86400),
    clampInteger(body.timeout_ms ?? defaultTimeoutMs, 1000, 60000),
    clampInteger(body.warn_days ?? 14, 1, 365),
    addonFlag(body.type!, body.check_ssl),
    addonFlag(body.type!, body.check_domain),
    addonFlag(body.type!, body.check_dns),
    options,
    pushToken,
    agentId,
    body.is_public === false ? 0 : 1,

    body.group_id ?? null,
    now,
    now,
  ] }, visibilityRevisionWrite(now, db.type === 'postgres')]);

  if (body.tag_ids !== undefined) {
    await setMonitorTags(c.env, id, body.tag_ids);
  }

  invalidateConfig();
  logMeta('insert_monitor', lastD1Meta(db));

  return c.json({
    id,
    ...(pushToken ? { push_token: pushToken } : {}),
  }, 201);
});

monitorRoutes.put('/api/monitors/:id', async (c) => {
  const id = c.req.param('id');

  const body = await readObjectBody<MonitorBody>(c);
  if (!body) return c.json({ error: 'invalid_request' }, 400);
  if (body.is_public !== undefined && typeof body.is_public !== 'boolean') return c.json({ error: 'visibility_invalid' }, 400);

  const storedDb = getDB(c.env);
  const stored = await storedDb.queryOne<StoredMonitor>(
    monitorSQL[storedDb.type].storedForUpdate,
    [id],
  );
  if (!stored) return c.json({ error: 'not_found' }, 404);

  const err = validateUpdate(stored, body);
  if (err) return c.json({ error: err }, 400);

  const badRef = await checkRefs(c.env, body);
  if (badRef) return c.json({ error: badRef }, 400);

  const now = Math.floor(Date.now() / 1000);

  const type = body.type ?? stored.type;

  const target = type === 'push' || type === 'agent'
    ? ''
    : normalizeTarget(type, body.target ?? stored.target);

  const options = normalizeOptions(
    type,
    body.options_json === undefined ? stored.options_json : body.options_json,
  ).json ?? '{}';
  let oldSource: { type?: string; agent_id?: string } | undefined;
  try { oldSource = (JSON.parse(stored.options_json) as { check_source?: { type?: string; agent_id?: string } }).check_source; } catch { oldSource = undefined; }
  let nextSource: { type?: string; agent_id?: string } | undefined;
  try { nextSource = (JSON.parse(options) as { check_source?: { type?: string; agent_id?: string } }).check_source; } catch { nextSource = undefined; }
  const preserveUnavailableSource = oldSource?.type === 'agent' && oldSource.agent_id === nextSource?.agent_id && type === stored.type;
  const checks = { ssl: Boolean(body.check_ssl ?? stored.check_ssl), domain: Boolean(body.check_domain ?? stored.check_domain), dns: Boolean(body.check_dns ?? stored.check_dns) };
  const preserveChecks = Boolean(stored.check_ssl) === checks.ssl && Boolean(stored.check_domain) === checks.domain && Boolean(stored.check_dns) === checks.dns;
  const sourceError = await validateProbeSource(c.env, type, options, checks, preserveUnavailableSource && preserveChecks);
  if (sourceError) return c.json({ error: sourceError }, 400);

  const pushToken =
    type === 'push' ? (stored.push_token ?? randomToken()) : stored.push_token;

  const agentId = bindingId(type, body.agent_id === undefined ? stored.agent_id : body.agent_id, options);
  if (type === 'agent' && (!agentId || !await findAgent(c.env, agentId))) return c.json({ error: 'agent_required' }, 400);

  const flags = {
    ssl: addonFlag(type, body.check_ssl ?? stored.check_ssl),
    domain: addonFlag(type, body.check_domain ?? stored.check_domain),
    dns: addonFlag(type, body.check_dns ?? stored.check_dns),
  };

  const updateDb = getDB(c.env);
  const updateResults = await updateDb.commit([{ sql: monitorSQL[updateDb.type].update, params: [

    nonEmptyString(body.name),
    type,
    target,

    httpMethod(body.method),
    expectedStatusSpec(body.expected_status),
    keywordSpec(body.keyword ?? null),
    body.interval_sec ?? null,
    body.timeout_ms ?? null,
    body.warn_days ?? null,
    flags.ssl,
    flags.domain,
    flags.dns,
    options,
    pushToken,
    agentId,
    body.is_public === undefined ? null : body.is_public ? 1 : 0,

    body.active === undefined ? null : body.active ? 1 : 0,
    now,
    id,
  ] }, visibilityRevisionWrite(now, updateDb.type === 'postgres')]);

  if (updateResults[0] === 0) return c.json({ error: 'not_found' }, 404);

  if (body.group_id !== undefined) {
    const groupDb = getDB(c.env);
    await groupDb.execute(monitorSQL[groupDb.type].setGroup, [body.group_id ?? null, now, id]);
  }

  if (body.tag_ids !== undefined) {
    await setMonitorTags(c.env, id, body.tag_ids);
  }

  invalidateConfig();

  try {
    const cacheDb = getDB(c.env);
    const row = await cacheDb.queryOne<{ num_id: number }>(
      cacheDb.type === 'postgres' ? 'SELECT num_id FROM monitors WHERE id = $1' : 'SELECT num_id FROM monitors WHERE id = ?',
      [id],
    );
    await invalidateMonitorDetail(caches.default, new URL(c.req.url).origin, { uuid: id, numId: row?.num_id ?? null });
  } catch {}

  return c.json({
    ok: true,
    ...(type === 'push' ? { push_token: pushToken } : {}),
  });
});

monitorRoutes.delete('/api/monitors/:id', async (c) => {
  const id = c.req.param('id');
  const deleted = await deleteMonitor(c.env, id);
  if (!deleted) return c.json({ error: 'not_found' }, 404);
  await invalidateMonitorDetail(caches.default, new URL(c.req.url).origin, { uuid: id, numId: deleted.numId });
  return c.json({ ok: true });
});

monitorRoutes.post('/api/monitors/:id/check', async (c) => {
  const id = c.req.param('id');
  const db = getDB(c.env);
  const monitor = await db.queryOne<Monitor>(monitorSQL[db.type].byId, [id]);
  if (!monitor) return c.json({ error: 'not_found' }, 404);

  if (!monitor.active) {
    return c.json({
      error: 'monitor_paused',
      message: 'this monitor is paused; resume it before checking',
    }, 409);
  }

  const outcome = await runMonitorCheck(c.env, monitor);
  if (outcome.status === 'superseded') {
    return c.json({ error: 'monitor_changed', message: 'the monitor changed while this check was running' }, 409);
  }
  if (outcome.status === 'refused') {

    const code = outcome.reason === 'push'
      ? 'push_not_probeable'
      : outcome.reason === 'agent'
        ? 'agent_not_probeable'
        : 'agent_source_not_probeable';
    return c.json({ error: code }, 409);
  }
  if (outcome.status === 'budget_exhausted') {
    return c.json({
      error: 'budget_exhausted',
      message: 'the Worker request budget ran out before this check could run',
    }, 503);
  }

  try {
    await invalidateMonitorDetail(caches.default, new URL(c.req.url).origin, { uuid: id, numId: monitor.num_id });
  } catch {}

  return c.json({
    ok: true,
    monitor_id: monitor.id,

    status: outcome.entry.st,
    latencyMs: outcome.heartbeat?.ms ?? outcome.entry.v ?? 0,
    statusCode: outcome.entry.code,
    message: outcome.entry.msg,
    checked_at: outcome.entry.ts,

    primary: outcome.result,

    event: outcome.event,

    notified: outcome.notified,

    maintenance: outcome.maintenance,
  });
});

monitorRoutes.post('/api/monitors/check', async (c) => {
  const body = await readObjectBody<MonitorBody>(c);
  if (!body) return c.json({ error: 'invalid_request' }, 400);
  const err = validate(body);
  if (err) return c.json({ error: err }, 400);

  const testOptions = normalizeOptions(body.type!, body.options_json).json ?? '{}';
  if (requiresAgentProbe(body.type!)) {
    const sourceError = await validateProbeSource(c.env, body.type!, testOptions);
    if (sourceError) return c.json({ error: sourceError }, 400);
  }
  let checkSource: { type?: string; agent_id?: string } | undefined;
  try { checkSource = (JSON.parse(testOptions) as { check_source?: { type?: string; agent_id?: string } }).check_source; } catch { return c.json({ error: 'options_json_invalid' }, 400); }
  if (checkSource?.type === 'agent') {
    const supported = typeof checkSource.agent_id === 'string' && isActiveProbeType(body.type!) && await supportsProbeAgent(c.env, checkSource.agent_id, body.type!);
    return c.json({ status: 2, latencyMs: 0, statusCode: 0, message: supported ? 'agent probe result not available yet' : 'agent source unavailable' });
  }

  const result = await runCheck({
    id: 'test',
    num_id: 0, // never persisted; this endpoint only runs the check and discards it / 不会持久化；此端点仅执行检查后丢弃
    name: body.name ?? 'test',
    type: body.type!,
    target: normalizeTarget(body.type!, body.target ?? ''),
    method: body.method ?? 'GET',
    expected_status: body.expected_status ?? '200-299',
    keyword: body.keyword ?? null,
    interval_sec: 60,
    timeout_ms: clampInteger(body.timeout_ms ?? 10000, 1000, 60000),
    warn_days: body.warn_days ?? 14,
    check_ssl: addonFlag(body.type!, body.check_ssl),
    check_domain: addonFlag(body.type!, body.check_domain),
    check_dns: addonFlag(body.type!, body.check_dns),

    options_json: normalizeOptions(body.type!, body.options_json).json ?? '{}',

    push_token: null,

    agent_id: bindingId(body.type!, body.agent_id, normalizeOptions(body.type!, body.options_json).json ?? '{}'),
    is_public: 0,

    group_id: null,
    active: 1,
    created_at: 0,
    updated_at: 0,
  });

  invalidateConfig(); 
  return c.json(result);
});

interface StoredMonitor {
  type: MonitorType;
  target: string;
  check_ssl: number;
  check_domain: number;
  check_dns: number;
  options_json: string;
  push_token: string | null;
  agent_id: string | null;
  is_public: number;
}

interface MonitorBody extends Partial<Omit<Monitor, 'group_id' | 'is_public'>> {
  is_public?: boolean;
  group_id?: string | null;
  tag_ids?: string[];
}

function bindingId(type: MonitorType, selected: unknown, json: string): string | null {
  if (type === 'agent') return typeof selected === 'string' && selected ? selected : null;
  const source = parseOptions<{ check_source?: ProbeSource }>(json).check_source;
  return source?.type === 'agent' ? source.agent_id : null;
}

async function checkRefs(env: Env, body: MonitorBody): Promise<string | null> {
  if (body.group_id !== undefined && body.group_id !== null) {
    if (typeof body.group_id !== 'string') return 'group_not_found';

    const groupId = body.group_id.trim();

    body.group_id = groupId === '' ? null : groupId;

    if (body.group_id !== null && !(await groupExists(env, body.group_id))) {
      return 'group_not_found';
    }
  }

  if (body.tag_ids !== undefined) {
    if (!Array.isArray(body.tag_ids)) return 'tag_not_found';

    const ids = body.tag_ids.filter((t): t is string => typeof t === 'string');
    if (ids.length !== body.tag_ids.length) return 'tag_not_found';

    const known = await existingTagIds(env, ids);
    for (const id of ids) {
      if (!known.has(id)) return 'tag_not_found';
    }
  }

  return null;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function httpMethod(v: unknown): string | null {
  const value = nonEmptyString(v);
  if (value === null) return null;
  const upper = value.toUpperCase();
  return (HTTP_METHODS as readonly string[]).includes(upper) ? upper : null;
}

function expectedStatusSpec(v: unknown): string | null {
  const spec = nonEmptyString(v);
  if (spec === null) return null;
  const expected = parseExpected(spec);
  const usable = spec.split(',').some((part) => {
    const text = part.trim();
    const range = text.match(/^(\d{3})\s*-\s*(\d{3})$/);
    const low = range ? Number(range[1]) : /^\d{3}$/.test(text) ? Number(text) : NaN;
    const high = range ? Number(range[2]) : low;

    if (!(low >= 100 && low <= 599 && high >= low && high <= 599)) return false;
    return expected(low);
  });
  return usable ? spec : null;
}

function keywordSpec(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.length <= 256 ? v : null;
}

function transportFieldError(b: {
  method?: unknown;
  expected_status?: unknown;
  keyword?: unknown;
}): string | null {
  if (b.method !== undefined && b.method !== null && httpMethod(b.method) === null) {
    return 'method_invalid';
  }
  if (
    b.expected_status !== undefined &&
    b.expected_status !== null &&
    expectedStatusSpec(b.expected_status) === null
  ) {
    return 'expected_status_invalid';
  }
  if (b.keyword !== undefined && b.keyword !== null && keywordSpec(b.keyword) === null) {
    return 'keyword_invalid';
  }
  return null;
}

async function readObjectBody<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T | null> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as T;
}

function normalizeTarget(type: MonitorType, target: string): string {
  const t = target.trim();
  if (type === 'http') return /^https?:\/\//i.test(t) ? t : `https://${t}`;
  if (type === 'tcp') return t.replace(/^tcp:\/\//i, '');
  if (type === 'udp') return t.replace(/^udp:\/\//i, '');
  if (type === 'icmp') return t.replace(/^\[|\]$/g, '');
  return t;
}

function validateTarget(type: MonitorType, target: string): string | null {
  try {
    if (type === 'http') {
      const normalized = normalizeTarget('http', target);
      if (hasNonCanonicalHttpIPv4(normalized)) return 'hostname_invalid';
      const url = new URL(normalized);

      if (!isHostname(url.hostname.replace(/^\[|\]$/g, ''))) return 'hostname_invalid';
    } else if (type === 'tcp' || type === 'udp') {
      if (type === 'udp' && /^[a-z][\w+.-]*:\/\//i.test(target) && !/^udp:\/\//i.test(target)) return 'target_invalid';
      const { host } = parseHostPort(normalizeTarget(type, target));
      if (!isHostname(host)) return 'hostname_invalid';
    } else if (type === 'icmp') {
      if (!isHostname(normalizeTarget(type, target))) return 'hostname_invalid';
    } else if (type === 'push' || type === 'agent') {
      // No target to check. A push monitor is pinged from outside and an
      // agent monitor's daemon connects to us; either way there is nothing
      // here for a check to connect to, and the empty string the form sends
      // is the correct value, not a missing one.
      // 无需检查目标：Push 监控由外部发送心跳，Agent 监控由守护进程连接本服务；
      // 此处没有可连接的目标，表单提交的空字符串是正确值，并非缺失值。
    } else {
      return 'type_invalid';
    }
  } catch {
    return 'target_invalid';
  }
  return null;
}

type OptionsResult = { json: string; error?: undefined } | { json?: undefined; error: string };

// 来源变更时检查 Agent 能力；调用方决定未改变来源是否可保留。
// Check Agent capabilities on source changes; callers decide when an unchanged source can be retained.
async function validateProbeSource(env: Env, type: MonitorType, json: string, addons: ProbeAddonSelection = {}, allowUnavailableAgent = false): Promise<string | null> {
  let source: unknown;
  try { source = (JSON.parse(json) as Record<string, unknown>).check_source; } catch { return 'options_json_invalid'; }
  if (source === undefined) return requiresAgentProbe(type) ? 'agent_source_required' : null;
  if (typeof source === 'object' && source !== null && !Array.isArray(source) &&
      (source as Record<string, unknown>).type === 'worker' && Object.keys(source).length === 1) return requiresAgentProbe(type) ? 'agent_source_required' : null;
  if (!isActiveProbeType(type) || typeof source !== 'object' || source === null || Array.isArray(source)) return 'check_source_invalid';
  const value = source as Record<string, unknown>;
  if (value.type !== 'agent' || typeof value.agent_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.agent_id) ||
      Object.keys(value).some((key) => key !== 'type' && key !== 'agent_id')) return 'check_source_invalid';

  if (allowUnavailableAgent) return null;
  if (!(await agentProbeEnabled(env, value.agent_id))) return 'agent_probe_disabled';
  if (!await supportsProbeAgent(env, value.agent_id, type, addons)) return 'agent_probe_capability_required';
  if (requiresAgentProbe(type) && !await agentProbeSourceAvailable(env, { type: 'agent', agent_id: value.agent_id }, type, Math.floor(Date.now()/1000))) return 'agent_offline';
  return null;
}

function normalizeOptions(type: MonitorType, input: unknown): OptionsResult {

  let parsed: unknown = input === undefined || input === null || input === '' ? {} : input;

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {

      return { error: 'options_json_invalid' };
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'options_json_invalid' };
  }

  const opts = parsed as Record<string, unknown>;
  if (type === 'udp') {
    if (Object.keys(opts).some(key => !['check_source', 'send', 'expect', 'encoding'].includes(key))) return { error: 'udp_options_invalid' };
    if (!udpPacketOptions(opts)) return { error: 'udp_options_invalid' };
    Object.assign(opts, { send: opts.send ?? 'ping', expect: opts.expect ?? '', encoding: opts.encoding ?? 'text' });
  }
  if (type === 'icmp' && Object.keys(opts).some(key => key !== 'check_source')) return { error: 'options_json_invalid' };

  if (type === 'agent' && Object.keys(opts).some((key) => key !== 'alerts')) return { error: 'agent_options_invalid' };
  if (type === 'agent' && opts.alerts !== undefined) {
    if (typeof opts.alerts !== 'object' || opts.alerts === null || Array.isArray(opts.alerts)) return { error: 'agent_alerts_invalid' };
    const rules = opts.alerts as Record<string, unknown>;
    const allowed = ['cpu', 'memory', 'disk', 'load'];
    if (Object.keys(rules).some((key) => !allowed.includes(key))) return { error: 'agent_alerts_invalid' };
    for (const [ruleName, value] of Object.entries(rules)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'agent_threshold_invalid' };
      const rule = value as Record<string, unknown>;
      const maxThreshold = ruleName === 'load' ? 10000 : 100;
      if (typeof rule.enabled !== 'boolean' || typeof rule.threshold !== 'number' || !Number.isFinite(rule.threshold) || rule.threshold <= 0 ||
          rule.threshold > maxThreshold ||
          typeof rule.duration_sec !== 'number' || !Number.isInteger(rule.duration_sec) || rule.duration_sec < 1 || rule.duration_sec > 86400 ||
          typeof rule.recovery_pct !== 'number' || !Number.isFinite(rule.recovery_pct) || rule.recovery_pct <= 0 || rule.recovery_pct >= 100 ||
          Object.keys(rule).some((key) => !['enabled', 'threshold', 'duration_sec', 'recovery_pct'].includes(key))) return { error: 'agent_threshold_invalid' };
    }
  }

  if (opts.dns !== undefined) {
    if (typeof opts.dns !== 'object' || opts.dns === null || Array.isArray(opts.dns)) {
      return { error: 'dns_options_invalid' };
    }
    const dns = opts.dns as Record<string, unknown>;
    const rt = dns.recordType;
    if (rt !== undefined) {
      if (typeof rt !== 'string' || !(DNS_RECORD_TYPES as readonly string[]).includes(rt)) {
        return { error: 'dns_record_type_required' };
      }
    }
  }

  return { json: JSON.stringify(parsed) };
}

function validate(b: MonitorBody): string | null {

  const name = nonEmptyString(b.name);
  if (name === null) return 'name_required';
  if (!b.type || !TYPES.includes(b.type)) return 'type_invalid';
  if (b.interval_sec !== undefined && (!Number.isInteger(b.interval_sec) || b.interval_sec < 60 || b.interval_sec > 86400)) return 'interval_sec_invalid';
  if (b.timeout_ms !== undefined && (!Number.isInteger(b.timeout_ms) || b.timeout_ms < 1000 || b.timeout_ms > 60000)) return 'timeout_ms_invalid';

  const transport = transportFieldError(b);
  if (transport) return transport;

  if (b.type !== 'push' && b.type !== 'agent' && nonEmptyString(b.target) === null) return 'target_required';

  const bad = validateTarget(b.type, b.target ?? '');
  if (bad) return bad;

  const opts = normalizeOptions(b.type, b.options_json);
  if (opts.error) return opts.error;

  return validateAddonHost(b, b.type, b.target ?? '');
}

function validateUpdate(
  stored: StoredMonitor,
  b: MonitorBody,
): string | null {

  if (b.name !== undefined && nonEmptyString(b.name) === null) return 'name_required';
  if (b.interval_sec !== undefined && (!Number.isInteger(b.interval_sec) || b.interval_sec < 60 || b.interval_sec > 86400)) return 'interval_sec_invalid';
  if (b.timeout_ms !== undefined && (!Number.isInteger(b.timeout_ms) || b.timeout_ms < 1000 || b.timeout_ms > 60000)) return 'timeout_ms_invalid';
  if (b.type !== undefined && !TYPES.includes(b.type)) {
    return 'type_invalid';
  }

  const transport = transportFieldError(b);
  if (transport) return transport;

  const type = b.type ?? stored.type;
  const target = b.target ?? stored.target;

  if (type !== 'push' && type !== 'agent' && b.target !== undefined && nonEmptyString(b.target) === null) {
    return 'target_required';
  }

  const bad = validateTarget(type, target);
  if (bad) return type !== stored.type ? 'invalid_target_for_type' : bad;

  const opts = normalizeOptions(
    type,
    b.options_json === undefined ? stored.options_json : b.options_json,
  );
  if (opts.error) return opts.error;

  return validateAddonHost(
    {
      check_ssl: b.check_ssl ?? stored.check_ssl,
      check_domain: b.check_domain ?? stored.check_domain,
      check_dns: b.check_dns ?? stored.check_dns,
    },
    type,
    target,
  );
}

function validateAddonHost(
  flags: { check_ssl?: unknown; check_domain?: unknown; check_dns?: unknown },
  type: MonitorType,
  target: string,
): string | null {

  const wantSsl = Boolean(addonFlag(type, flags.check_ssl));
  const wantDomain = Boolean(addonFlag(type, flags.check_domain));
  const wantDns = Boolean(addonFlag(type, flags.check_dns));
  if (!wantSsl && !wantDomain && !wantDns) return null;

  const resolved = addonTarget(type, normalizeTarget(type, target));
  if (!resolved) return 'addon_needs_hostname';

  if (isIpAddress(resolved.host)) return 'addon_needs_domain';

  if (wantDomain && !resolved.domain) return 'addon_needs_hostname';
  return null;
}
