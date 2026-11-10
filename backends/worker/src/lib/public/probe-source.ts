import { parseOptions, type AgentMachineOptions, type LiveEntry, type Monitor, type ProbeSource } from '../../types';
import { agentIsOnline, agentStaleAfterSec } from '../agent/liveness';
import { isActiveProbeType, requiresAgentProbe, requiredProbeCapabilities } from '../../../../../shared/probe-capabilities';

/** 状态页展示的探测来源、可用性和最近观测时间。 / Probe source, availability, and latest observation shown on the status page. */
export interface ProbeSourceState {
  source: 'worker' | 'agent';
  source_id?: string;
  source_name: string | null;
  source_available: boolean;
  source_pending: boolean;
  source_last_observed_at: number | null;
}

/** 合并探测来源的在线能力和结果新鲜度，区分等待首次结果与不可用。 / Combine probe-source liveness and result freshness, distinguishing an initial wait from unavailability. */
export function getProbeSourceState(
  monitor: Pick<Monitor, 'type' | 'options_json' | 'interval_sec' | 'timeout_ms'> & Partial<Pick<Monitor, 'check_ssl' | 'check_domain' | 'check_dns'>>,
  entry: LiveEntry | undefined,
  agents: Map<string, Record<string, unknown>>,
  now: number,
): ProbeSourceState {
  const selection = parseOptions<{ check_source?: ProbeSource }>(monitor.options_json).check_source;
  if (selection?.type !== 'agent') return {
    source: requiresAgentProbe(monitor.type) ? 'agent' : 'worker',
    source_name: null,
    source_available: requiresAgentProbe(monitor.type) ? false : isActiveProbeType(monitor.type)
      ? publicProbeAvailable(entry, monitor, now)
      : entry?.source_available !== false,
    source_pending: false,
    source_last_observed_at: null,
  };

  const agent = agents.get(selection.agent_id);
  let capabilities: unknown = [];
  try { capabilities = JSON.parse(String(agent?.probe_capabilities ?? '[]')); } catch {}
  const required = requiredProbeCapabilities(monitor.type, { ssl: Boolean(monitor.check_ssl), domain: Boolean(monitor.check_domain), dns: Boolean(monitor.check_dns) });
  const healthy = Boolean(agent && Number(agent.active) === 1 &&
    parseOptions<AgentMachineOptions>(String(agent.options_json)).probe_enabled !== false &&
    Array.isArray(capabilities) && required.every(capability => capabilities.includes(capability)) &&
    agentIsOnline(agent.reported_at as number | string | null, now,
      agentStaleAfterSec(agent.report_interval_secs as number | string | null)) === true);
  const hasReading = entry?.source_available === true;
  return {
    source: 'agent',
    source_id: selection.agent_id,
    source_name: String(agent?.name ?? '') || null,
    source_available: healthy && hasReading && publicProbeAvailable(entry, monitor, now),
    source_pending: healthy && !hasReading && !entry?.source_last_observed_at,
    source_last_observed_at: entry?.source_last_observed_at ?? null,
  };
}

/** 只在最近结果仍处于间隔与超时宽限范围内时显示来源可用。 / Mark the source available only while its latest result remains within the interval and timeout grace period. */
export function publicProbeAvailable(
  entry: Pick<LiveEntry, 'ts' | 'source_available'> | undefined,
  monitor: Pick<Monitor, 'interval_sec' | 'timeout_ms'>,
  now: number,
): boolean {
  if (!entry || entry.source_available === false || !Number.isFinite(entry.ts) || entry.ts <= 0) return false;

  const interval = Number.isFinite(monitor.interval_sec) && monitor.interval_sec > 0 ? monitor.interval_sec : 60;
  const timeout = Number.isFinite(monitor.timeout_ms) && monitor.timeout_ms > 0 ? monitor.timeout_ms / 1000 : 10;
  const extraGrace = Math.min(3600, Math.max(60, timeout));
  const grace = interval + extraGrace;
  return now - entry.ts <= grace;
}

export function staleProbeReading(monitor: Pick<Monitor, 'interval_sec' | 'timeout_ms'>, entry: LiveEntry | undefined, now: number): boolean {
  return !publicProbeAvailable(entry, monitor, now);
}
